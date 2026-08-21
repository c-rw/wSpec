#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Install or upgrade wSpec into another local repository.

.DESCRIPTION
    Mirrors wSpec framework files from this repo into -Folder (defaults to the
    current directory): additions and updates are copied, and anything that no
    longer exists in this source is removed from the target's wSpec-owned
    directories. Project-authored files (config.yaml, principles.md, changes/,
    specs/, archive/) are seeded only if missing and are never touched by the
    mirror. `.claude/settings.json` and anything else under `.claude/` that
    isn't a wSpec-owned `wspec-*.md` command/agent is left completely alone.

    -Upgrade refreshes framework files only; never touches config, principles,
    changes/, specs/, or archive/.

    -DryRun previews every add/update/remove without touching the filesystem,
    running npm, or changing git config.

    Git hooks are configured by default when the target is a git repository.
    Use -NoHooks to skip or remove hook configuration.

.EXAMPLE
    ./install.ps1

.EXAMPLE
    ./install.ps1 -Folder D:\Development\projects\private\eBayAI

.EXAMPLE
    ./install.ps1 -Folder D:\Development\projects\private\eBayAI -Upgrade

.EXAMPLE
    ./install.ps1 -Folder D:\Development\projects\private\eBayAI -Upgrade -DryRun
#>
[CmdletBinding()]
param(
    [string]$Folder = '.',
    [switch]$Upgrade,
    [switch]$Force,
    [switch]$Hooks,
    [switch]$NoHooks,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$src = $PSScriptRoot
if (-not (Test-Path $Folder)) { New-Item -ItemType Directory -Path $Folder | Out-Null }
$dst = (Resolve-Path $Folder).Path
$script:DryRun = [bool]$DryRun

function Step($m)    { Write-Host "==> $m" -ForegroundColor Cyan }
function Ok($m)      { Write-Host "    ok:   $m" -ForegroundColor Green }
function Skip($m)    { Write-Host "    skip: $m" -ForegroundColor DarkGray }
function Removed($m) { Write-Host "    del:  $m" -ForegroundColor Yellow }

if ($Hooks -and $NoHooks) {
    throw 'Use only one of -Hooks or -NoHooks.'
}

$configureHooks = -not $NoHooks

function Test-GitWorkTree {
    param([string]$Path)
    try {
        $out = & git -C $Path rev-parse --is-inside-work-tree 2>$null
        return ($LASTEXITCODE -eq 0 -and (($out | Select-Object -First 1).Trim() -eq 'true'))
    } catch {
        return $false
    }
}

function Test-CommandAvailable {
    param([Parameter(Mandatory = $true)][string]$Name)
    return $null -ne (Get-Command $Name -ErrorAction SilentlyContinue)
}

function Invoke-RequiredCommand {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $true)][string[]]$ArgumentList,
        [Parameter(Mandatory = $true)][string]$WorkingDirectory,
        [Parameter(Mandatory = $true)][string]$FailureMessage
    )

    Push-Location -LiteralPath $WorkingDirectory
    try {
        & $FilePath @ArgumentList
        if ($LASTEXITCODE -ne 0) {
            throw $FailureMessage
        }
    } finally {
        Pop-Location
    }
}

# --- Filesystem primitives -------------------------------------------------
# Every mutating filesystem operation below routes through these three so
# -DryRun and a real run share one code path: the wrapper is the only place
# that branches on $script:DryRun.

function New-FsDir {
    param([string]$Path)
    if (Test-Path -LiteralPath $Path -PathType Leaf) {
        # A stale file from an older layout occupies a path the current
        # source needs as a directory. Clear it so the mirror can proceed.
        if ($script:DryRun) { return }
        Remove-Item -LiteralPath $Path -Force
    }
    if ($script:DryRun) { return }
    New-Item -ItemType Directory -Path $Path -Force | Out-Null
}

function Copy-FsItem {
    param([string]$Source, [string]$Destination, [string]$Label)
    if ($script:DryRun) { Ok "$Label (dry-run)"; return }
    Copy-Item -LiteralPath $Source -Destination $Destination -Force
    Ok $Label
}

function Remove-FsItem {
    param([string]$Path, [string]$Label)
    if ($script:DryRun) { Removed "$Label (dry-run)"; return }
    Remove-Item -LiteralPath $Path -Force
    Removed $Label
}

# --- Tree copy / mirror ------------------------------------------------------

function Copy-Tree {
    param(
        [string]$From,
        [string]$To,
        [switch]$Overwrite,
        [switch]$Mirror,
        [string[]]$ExcludeDirectories = @()
    )

    if (-not (Test-Path $From)) { return }

    $excludeLookup = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($name in $ExcludeDirectories) {
        if ($name) {
            [void]$excludeLookup.Add($name)
        }
    }

    $sourceRoot = (Resolve-Path -LiteralPath $From).Path
    New-FsDir $To

    function Copy-TreeInternal {
        param([string]$CurrentSource)

        foreach ($entry in Get-ChildItem -LiteralPath $CurrentSource -Force) {
            if ($entry.PSIsContainer) {
                if ($excludeLookup.Contains($entry.Name)) {
                    Skip $entry.FullName.Substring($sourceRoot.Length).TrimStart('\','/')
                    continue
                }
                Copy-TreeInternal -CurrentSource $entry.FullName
                continue
            }

            $rel = $entry.FullName.Substring($sourceRoot.Length).TrimStart('\','/')
            $out = Join-Path $To $rel
            New-FsDir (Split-Path $out -Parent)
            if ((Test-Path -LiteralPath $out) -and -not $Overwrite) { Skip $rel; continue }
            Copy-FsItem -Source $entry.FullName -Destination $out -Label $rel
        }
    }

    Copy-TreeInternal -CurrentSource $sourceRoot

    if ($Mirror) {
        Invoke-MirrorDeletePass -SourceRoot $sourceRoot -DestRoot $To -ExcludeLookup $excludeLookup
    }
}

function Invoke-MirrorDeletePass {
    param(
        [string]$SourceRoot,
        [string]$DestRoot,
        [System.Collections.Generic.HashSet[string]]$ExcludeLookup
    )

    if (-not (Test-Path -LiteralPath $DestRoot)) { return }
    $destRootResolved = (Resolve-Path -LiteralPath $DestRoot).Path

    # Collect first so deleting mid-enumeration can't skip or double-visit entries.
    $destFiles = @(Get-ChildItem -LiteralPath $destRootResolved -Recurse -File -Force)
    foreach ($file in $destFiles) {
        $rel = $file.FullName.Substring($destRootResolved.Length).TrimStart('\','/')
        $topSegment = ($rel -split '[\\/]')[0]
        if ($ExcludeLookup.Contains($topSegment)) { continue }

        $srcCandidate = Join-Path $SourceRoot $rel
        if (Test-Path -LiteralPath $srcCandidate -PathType Leaf) { continue }

        Remove-FsItem -Path $file.FullName -Label $rel
    }

    # Prune now-empty directories, deepest first, skipping excluded roots.
    if ($script:DryRun) { return }
    $destDirs = @(Get-ChildItem -LiteralPath $destRootResolved -Recurse -Directory -Force |
        Sort-Object { $_.FullName.Length } -Descending)
    foreach ($dir in $destDirs) {
        $rel = $dir.FullName.Substring($destRootResolved.Length).TrimStart('\','/')
        $topSegment = ($rel -split '[\\/]')[0]
        if ($ExcludeLookup.Contains($topSegment)) { continue }

        $remaining = Get-ChildItem -LiteralPath $dir.FullName -Force
        if ($remaining.Count -eq 0) {
            Remove-Item -LiteralPath $dir.FullName -Force -ErrorAction SilentlyContinue
        }
    }
}

# Flat, glob-scoped mirror for directories that are only *partially*
# wSpec-owned (namely .claude/commands and .claude/agents): only files
# matching -Pattern are added/updated/removed; everything else in -DstDir
# (a target's own settings.json, custom commands, etc.) is never touched.
function Mirror-OwnedFiles {
    param(
        [string]$SrcDir,
        [string]$DstDir,
        [string]$Pattern
    )

    if (-not (Test-Path -LiteralPath $SrcDir)) { return }
    New-FsDir $DstDir

    foreach ($srcFile in Get-ChildItem -LiteralPath $SrcDir -Filter $Pattern -File -Force) {
        $out = Join-Path $DstDir $srcFile.Name
        Copy-FsItem -Source $srcFile.FullName -Destination $out -Label $srcFile.Name
    }

    if (Test-Path -LiteralPath $DstDir) {
        foreach ($dstFile in Get-ChildItem -LiteralPath $DstDir -Filter $Pattern -File -Force) {
            $srcCandidate = Join-Path $SrcDir $dstFile.Name
            if (-not (Test-Path -LiteralPath $srcCandidate -PathType Leaf)) {
                Remove-FsItem -Path $dstFile.FullName -Label $dstFile.Name
            }
        }
    }
}

Step "Source: $src"
Step "Target: $dst"
Step ("Mode:   " + $(if ($Upgrade) { 'upgrade' } else { 'init' }) + $(if ($script:DryRun) { ' (dry-run)' } else { '' }))

Step 'Claude Code customizations'
Mirror-OwnedFiles (Join-Path $src '.claude\commands') (Join-Path $dst '.claude\commands') 'wspec-*.md'
Mirror-OwnedFiles (Join-Path $src '.claude\agents')   (Join-Path $dst '.claude\agents')   'wspec-*.md'
$settingsExample = Join-Path $src '.claude\settings.example.json'
if (Test-Path -LiteralPath $settingsExample) {
    New-FsDir (Join-Path $dst '.claude')
    Copy-FsItem -Source $settingsExample -Destination (Join-Path $dst '.claude\settings.example.json') -Label '.claude/settings.example.json'
}

Step 'Workflow wrapper commands'
foreach ($wrapper in 'wspec-propose','wspec-research','wspec-principles','wspec-implement','wspec-finalize','wspec-propose.cmd','wspec-research.cmd','wspec-principles.cmd','wspec-implement.cmd','wspec-finalize.cmd') {
    Copy-FsItem -Source (Join-Path $src $wrapper) -Destination (Join-Path $dst $wrapper) -Label $wrapper
}

if ($IsLinux -or $IsMacOS) {
    foreach ($wrapper in 'wspec-propose','wspec-research','wspec-principles','wspec-implement','wspec-finalize') {
        $wrapperPath = Join-Path $dst $wrapper
        if (-not $script:DryRun -and (Test-Path -LiteralPath $wrapperPath)) {
            & chmod +x -- $wrapperPath 2>$null
        }
    }
    Ok 'set executable bit on workflow wrappers'
}

Step 'wspec/ framework files'
Copy-Tree (Join-Path $src 'wspec\templates') (Join-Path $dst 'wspec\templates') -Overwrite -Mirror
Copy-Tree (Join-Path $src 'wspec\scripts')   (Join-Path $dst 'wspec\scripts')   -Overwrite -Mirror
Copy-Tree (Join-Path $src 'wspec\mcp')       (Join-Path $dst 'wspec\mcp')       -Overwrite -Mirror -ExcludeDirectories @('node_modules','dist')
Copy-Tree (Join-Path $src 'wspec\schemas')   (Join-Path $dst 'wspec\schemas')   -Overwrite -Mirror
Copy-FsItem -Source (Join-Path $src 'wspec\README.md') -Destination (Join-Path $dst 'wspec\README.md') -Label 'wspec/README.md'

Step 'Remove obsolete files'
# Only for orphans that live outside every mirrored directory above (e.g. a
# file that used to sit directly under wspec/). Anything under
# wspec/templates, wspec/scripts, wspec/mcp, or wspec/schemas is already
# handled automatically by the mirror passes — do not duplicate entries here.
foreach ($obsolete in @('wspec\constitution.md')) {
    $obsoletePath = Join-Path $dst $obsolete
    if (Test-Path -LiteralPath $obsoletePath) {
        Remove-FsItem -Path $obsoletePath -Label $obsolete
    }
}

Step 'MCP setup (mandatory)'
$mcpDir = Join-Path $dst 'wspec\mcp'
if (-not (Test-CommandAvailable 'node')) {
    throw 'Node.js is required for wSpec install. Install Node.js, then rerun install.ps1.'
}
if (-not (Test-CommandAvailable 'npm')) {
    throw 'npm is required for wSpec install. Install npm (bundled with Node.js), then rerun install.ps1.'
}

if ($script:DryRun) {
    # The directory-existence and build-artifact checks below assume the mirror pass above
    # actually ran; under -DryRun nothing was written, so skip straight past them.
    Skip 'npm install / npm run build (dry-run)'
} else {
    if (-not (Test-Path -LiteralPath $mcpDir)) {
        throw "Missing required MCP directory: $mcpDir"
    }

    Invoke-RequiredCommand -FilePath 'npm' -ArgumentList @('install') -WorkingDirectory $mcpDir -FailureMessage 'Failed to install MCP dependencies (npm install). Fix the error above and rerun install.ps1.'
    Invoke-RequiredCommand -FilePath 'npm' -ArgumentList @('run', 'build') -WorkingDirectory $mcpDir -FailureMessage 'Failed to build MCP CLI (npm run build). Fix the error above and rerun install.ps1.'

    $mcpCli = Join-Path $mcpDir 'dist\cli.js'
    if (-not (Test-Path -LiteralPath $mcpCli)) {
        throw "MCP build completed without required artifact: $mcpCli"
    }
    Ok 'installed and built wspec/mcp'
}

Step 'Git hooks'
if (-not (Test-GitWorkTree $dst)) {
    Skip 'target is not a git repository; skipping hook configuration'
} elseif ($configureHooks) {
    if ($script:DryRun) {
        Skip 'configure core.hooksPath -> wspec/scripts/hooks (dry-run)'
    } else {
        & git -C $dst config core.hooksPath wspec/scripts/hooks
        if ($LASTEXITCODE -ne 0) { throw 'Failed to set core.hooksPath.' }
        Ok 'configured core.hooksPath -> wspec/scripts/hooks'

        if ($IsLinux -or $IsMacOS) {
            foreach ($hook in 'prepare-commit-msg','commit-msg','pre-commit','pre-push') {
                $hookPath = Join-Path $dst ("wspec/scripts/hooks/$hook")
                if (Test-Path -LiteralPath $hookPath) {
                    & chmod +x -- $hookPath 2>$null
                }
            }
            Ok 'set executable bit on hook shims'
        }
    }
} else {
    if ($script:DryRun) {
        Skip 'unset core.hooksPath (dry-run)'
    } else {
        & git -C $dst config --unset core.hooksPath 2>$null
        if ($LASTEXITCODE -eq 0) {
            Ok 'unset core.hooksPath'
        } elseif ($LASTEXITCODE -eq 5) {
            Skip 'core.hooksPath already unset'
        } else {
            throw 'Failed to unset core.hooksPath.'
        }
    }
}

Step 'Update .gitignore'
$gitignorePath = Join-Path $dst '.gitignore'
$wspecIgnoreEntries = @('wspec/state.json', 'wspec/state.json.lock', 'wspec/.state.*.tmp', 'wspec/usage-cursor.json')
$existingGitignore = if (Test-Path $gitignorePath) { Get-Content $gitignorePath -Raw } else { '' }
$entriesToAdd = $wspecIgnoreEntries | Where-Object { $existingGitignore -notmatch [regex]::Escape($_) }
if ($entriesToAdd.Count -gt 0) {
    $entryWord = if ($entriesToAdd.Count -eq 1) { 'entry' } else { 'entries' }
    if ($script:DryRun) {
        Ok "would add $($entriesToAdd.Count) $entryWord to .gitignore (dry-run)"
    } else {
        $newBlock = "`n# wSpec generated files`n" + ($entriesToAdd -join "`n") + "`n"
        Add-Content $gitignorePath $newBlock -NoNewline
        Ok "added $($entriesToAdd.Count) $entryWord to .gitignore"
    }
} else {
    Skip '.gitignore (wSpec entries already present)'
}

Step 'Merge Claude Code settings'
$mergeScript = Join-Path $dst 'wspec\scripts\merge-settings.cjs'
if (Test-Path -LiteralPath $mergeScript) {
    if ($script:DryRun) {
        Skip '.claude/settings.json merge (dry-run)'
    } else {
        $settingsTarget = Join-Path $dst '.claude\settings.json'
        & node $mergeScript $settingsTarget
        if ($LASTEXITCODE -eq 0) {
            Ok '.claude/settings.json'
        } else {
            Skip '.claude/settings.json (merge script failed — check errors above)'
        }
    }
} else {
    Skip 'Claude Code settings (merge script not found)'
}

if (-not $Upgrade) {
    Step 'Seed project files'
    foreach ($f in 'wspec\config.yaml','wspec\principles.md') {
        $out = Join-Path $dst $f
        if ((Test-Path $out) -and -not $Force) { Skip $f; continue }
        New-FsDir (Split-Path $out -Parent)
        Copy-FsItem -Source (Join-Path $src $f) -Destination $out -Label $f
    }

    Step 'Empty change folders'
    foreach ($d in 'wspec\changes','wspec\specs','wspec\archive') {
        $out = Join-Path $dst $d
        New-FsDir $out
        $keep = Join-Path $out '.gitkeep'
        if ((-not (Test-Path $keep)) -and -not $script:DryRun) {
            New-Item -ItemType File -Path $keep | Out-Null
        }
        Ok $d
    }
}

Write-Host ""
$modeLabel = $(if ($Upgrade) { 'upgrade' } else { 'install' }) + $(if ($script:DryRun) { ' dry-run' } else { '' })
Write-Host ("wSpec $modeLabel complete -> $dst") -ForegroundColor Green
if ($script:DryRun) {
    Write-Host "No files were changed. Re-run without -DryRun to apply." -ForegroundColor Yellow
} elseif (Test-GitWorkTree $dst) {
    Write-Host "Target is a git repository — review with 'git status' / 'git diff' before committing." -ForegroundColor DarkGray
}
