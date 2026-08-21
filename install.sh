#!/usr/bin/env bash
set -euo pipefail

# Install or upgrade wSpec into another local repository.
#
# Mirrors wSpec framework files from this repo into --folder (defaults to the
# current directory): additions and updates are copied, and anything that no
# longer exists in this source is removed from the target's wSpec-owned
# directories. Project-authored files (config.yaml, principles.md, changes/,
# specs/, archive/) are seeded only if missing and are never touched by the
# mirror. .claude/settings.json and anything else under .claude/ that isn't a
# wSpec-owned wspec-*.md command/agent is left completely alone.
#
# --upgrade refreshes framework files only; never touches config, principles,
# changes/, specs/, or archive/.
#
# --dry-run previews every add/update/remove without touching the filesystem,
# running npm, or changing git config.

FOLDER="."
UPGRADE=0
FORCE=0
HOOKS=0
NO_HOOKS=0
DRY_RUN=0

usage() {
	cat <<'EOF'
Install or upgrade wSpec into another local repository.

Usage:
	./install.sh [--folder <path>] [--upgrade] [--force] [--hooks] [--no-hooks] [--dry-run]

Options:
	--folder <path>  Target folder (default: current directory)
	--upgrade        Refresh framework files only
	--force          Overwrite seeded project files during init
	--hooks          Explicitly enable hooks (default behavior)
	--no-hooks       Disable hooks (unset core.hooksPath)
	--dry-run        Preview adds/updates/removals; touch nothing
	--help           Show this help
EOF
}

while [[ $# -gt 0 ]]; do
	case "$1" in
		--folder)
			FOLDER="$2"
			shift 2
			;;
		--upgrade)
			UPGRADE=1
			shift
			;;
		--force)
			FORCE=1
			shift
			;;
		--hooks)
			HOOKS=1
			shift
			;;
		--no-hooks)
			NO_HOOKS=1
			shift
			;;
		--dry-run)
			DRY_RUN=1
			shift
			;;
		--help|-h)
			usage
			exit 0
			;;
		*)
			echo "Unknown argument: $1" >&2
			usage >&2
			exit 1
			;;
	esac
done

if [[ $HOOKS -eq 1 && $NO_HOOKS -eq 1 ]]; then
	echo "Use only one of --hooks or --no-hooks." >&2
	exit 1
fi

configure_hooks=1
if [[ $NO_HOOKS -eq 1 ]]; then
	configure_hooks=0
fi

step() { printf '==> %s\n' "$1"; }
ok() { printf '    ok:   %s\n' "$1"; }
skip() { printf '    skip: %s\n' "$1"; }
removed() { printf '    del:  %s\n' "$1"; }

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
src="$script_dir"

mkdir -p "$FOLDER"
dst="$(CDPATH= cd -- "$FOLDER" && pwd)"

# --- Filesystem primitives -------------------------------------------------
# Every mutating filesystem operation below routes through these three so
# --dry-run and a real run share one code path: the wrapper is the only place
# that branches on $DRY_RUN.

fs_mkdir() {
	local path="$1"
	if [[ -f "$path" ]]; then
		# A stale file from an older layout occupies a path the current
		# source needs as a directory. Clear it so the mirror can proceed.
		if [[ $DRY_RUN -eq 1 ]]; then
			return 0
		fi
		rm -f "$path"
	fi
	if [[ $DRY_RUN -eq 1 ]]; then
		return 0
	fi
	mkdir -p "$path"
}

fs_cp() {
	local src_file="$1" dst_file="$2" label="$3"
	if [[ $DRY_RUN -eq 1 ]]; then
		ok "$label (dry-run)"
		return 0
	fi
	cp -f "$src_file" "$dst_file"
	ok "$label"
}

fs_rm() {
	local path="$1" label="$2"
	if [[ $DRY_RUN -eq 1 ]]; then
		removed "$label (dry-run)"
		return 0
	fi
	rm -f "$path"
	removed "$label"
}

copy_tree() {
	local from="$1"
	local to="$2"
	local overwrite="$3"
	shift 3
	local excludes=("$@")

	if [[ ! -d "$from" ]]; then
		return 0
	fi

	fs_mkdir "$to"

	while IFS= read -r -d '' entry; do
		local rel
		rel="${entry#$from/}"

		local excluded=0
		for ex in "${excludes[@]}"; do
			if [[ -n "$ex" && "$rel" == "$ex"/* ]]; then
				excluded=1
				break
			fi
		done
		if [[ $excluded -eq 1 ]]; then
			continue
		fi

		local out="$to/$rel"
		if [[ -d "$entry" ]]; then
			# Match an excluded directory by its own name too (not just paths
			# beneath it), so e.g. node_modules/ itself is skipped rather than
			# silently mkdir'd as an empty placeholder.
			local base dirExcluded=0
			base="$(basename -- "$entry")"
			for ex in "${excludes[@]}"; do
				if [[ -n "$ex" && "$base" == "$ex" ]]; then
					dirExcluded=1
					break
				fi
			done
			if [[ $dirExcluded -eq 1 ]]; then
				skip "$rel"
				continue
			fi
			fs_mkdir "$out"
			continue
		fi

		fs_mkdir "$(dirname -- "$out")"
		if [[ -f "$out" && "$overwrite" != "1" ]]; then
			skip "$rel"
			continue
		fi

		fs_cp "$entry" "$out" "$rel"
	done < <(find "$from" -mindepth 1 -print0)
}

# Full mirror for a directory that is 100% wSpec-owned: copies additions and
# updates (via copy_tree, always overwriting), then deletes any destination
# file with no counterpart in source, then prunes directories left empty by
# those deletions. $excludes (e.g. node_modules, dist) are skipped on BOTH
# the copy pass and the delete pass -- critical, since an unexcluded delete
# pass would wipe a target's built MCP output or installed dependencies.
mirror_tree() {
	local from="$1"
	local to="$2"
	shift 2
	local excludes=("$@")

	copy_tree "$from" "$to" 1 "${excludes[@]}"

	if [[ ! -d "$to" ]]; then
		# Nothing to mirror-delete (e.g. --dry-run never actually created $to). Not an error.
		return 0
	fi

	while IFS= read -r -d '' destfile; do
		local rel="${destfile#$to/}"
		local top="${rel%%/*}"
		local excluded=0
		for ex in "${excludes[@]}"; do
			if [[ -n "$ex" && "$top" == "$ex" ]]; then
				excluded=1
				break
			fi
		done
		if [[ $excluded -eq 1 ]]; then
			continue
		fi
		if [[ ! -f "$from/$rel" ]]; then
			fs_rm "$destfile" "$rel"
		fi
	done < <(find "$to" -mindepth 1 -type f -print0)

	if [[ $DRY_RUN -eq 1 ]]; then
		return 0
	fi

	# -depth visits a directory's contents before the directory itself, i.e.
	# deepest-first -- exactly the order pruning now-empty directories needs.
	while IFS= read -r -d '' destdir; do
		local rel="${destdir#$to/}"
		local top="${rel%%/*}"
		local excluded=0
		for ex in "${excludes[@]}"; do
			if [[ -n "$ex" && "$top" == "$ex" ]]; then
				excluded=1
				break
			fi
		done
		if [[ $excluded -eq 1 ]]; then
			continue
		fi
		rmdir "$destdir" 2>/dev/null || true
	done < <(find "$to" -mindepth 1 -depth -type d -print0)
}

# Flat, glob-scoped mirror for directories that are only *partially*
# wSpec-owned (namely .claude/commands and .claude/agents): only files
# matching $pattern are added/updated/removed; everything else in $dstdir (a
# target's own settings.json, custom commands, etc.) is never touched.
mirror_owned_files() {
	local srcdir="$1"
	local dstdir="$2"
	local pattern="$3"

	if [[ ! -d "$srcdir" ]]; then
		return 0
	fi
	fs_mkdir "$dstdir"

	shopt -s nullglob
	for s in "$srcdir"/$pattern; do
		[[ -f "$s" ]] || continue
		fs_cp "$s" "$dstdir/$(basename -- "$s")" "$(basename -- "$s")"
	done

	if [[ -d "$dstdir" ]]; then
		for d in "$dstdir"/$pattern; do
			[[ -f "$d" ]] || continue
			local name
			name="$(basename -- "$d")"
			if [[ ! -f "$srcdir/$name" ]]; then
				fs_rm "$d" "$name"
			fi
		done
	fi
	shopt -u nullglob
}

test_git_work_tree() {
	git -C "$1" rev-parse --is-inside-work-tree >/dev/null 2>&1
}

invoke_required_command() {
	local command="$1"
	local working_dir="$2"
	local failure_message="$3"
	shift 3

	(
		cd "$working_dir"
		"$command" "$@"
	) || {
		echo "$failure_message" >&2
		exit 1
	}
}

step "Source: $src"
step "Target: $dst"
mode_suffix=""
[[ $DRY_RUN -eq 1 ]] && mode_suffix=" (dry-run)"
if [[ $UPGRADE -eq 1 ]]; then
	step "Mode:   upgrade$mode_suffix"
else
	step "Mode:   init$mode_suffix"
fi

step 'Claude Code customizations'
mirror_owned_files "$src/.claude/commands" "$dst/.claude/commands" 'wspec-*.md'
mirror_owned_files "$src/.claude/agents" "$dst/.claude/agents" 'wspec-*.md'
if [[ -f "$src/.claude/settings.example.json" ]]; then
	fs_mkdir "$dst/.claude"
	fs_cp "$src/.claude/settings.example.json" "$dst/.claude/settings.example.json" '.claude/settings.example.json'
fi

step 'Workflow wrapper commands'
for wrapper in wspec-propose wspec-research wspec-principles wspec-implement wspec-finalize wspec-propose.cmd wspec-research.cmd wspec-principles.cmd wspec-implement.cmd wspec-finalize.cmd; do
	fs_cp "$src/$wrapper" "$dst/$wrapper" "$wrapper"
done

if [[ $DRY_RUN -eq 0 ]]; then
	for wrapper in wspec-propose wspec-research wspec-principles wspec-implement wspec-finalize; do
		chmod +x "$dst/$wrapper"
	done
	ok 'set executable bit on workflow wrappers'
else
	skip 'set executable bit on workflow wrappers (dry-run)'
fi

step 'wspec/ framework files'
mirror_tree "$src/wspec/templates" "$dst/wspec/templates"
mirror_tree "$src/wspec/scripts" "$dst/wspec/scripts"
mirror_tree "$src/wspec/mcp" "$dst/wspec/mcp" node_modules dist
mirror_tree "$src/wspec/schemas" "$dst/wspec/schemas"
fs_cp "$src/wspec/README.md" "$dst/wspec/README.md" 'wspec/README.md'

step 'Remove obsolete files'
# Only for orphans that live outside every mirrored directory above (e.g. a
# file that used to sit directly under wspec/). Anything under
# wspec/templates, wspec/scripts, wspec/mcp, or wspec/schemas is already
# handled automatically by the mirror passes -- do not duplicate entries here.
for obsolete in wspec/constitution.md; do
	if [[ -f "$dst/$obsolete" ]]; then
		fs_rm "$dst/$obsolete" "$obsolete"
	fi
done

step 'MCP setup (mandatory)'
mcp_dir="$dst/wspec/mcp"
if ! command -v node >/dev/null 2>&1; then
	echo 'Node.js is required for wSpec install. Install Node.js, then rerun install.sh.' >&2
	exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
	echo 'npm is required for wSpec install. Install npm (bundled with Node.js), then rerun install.sh.' >&2
	exit 1
fi

if [[ $DRY_RUN -eq 1 ]]; then
	# The directory-existence and build-artifact checks below assume the mirror pass above
	# actually ran; under --dry-run nothing was written, so skip straight past them.
	skip 'npm install / npm run build (dry-run)'
else
	if [[ ! -d "$mcp_dir" ]]; then
		echo "Missing required MCP directory: $mcp_dir" >&2
		exit 1
	fi

	invoke_required_command npm "$mcp_dir" 'Failed to install MCP dependencies (npm install). Fix the error above and rerun install.sh.' install
	invoke_required_command npm "$mcp_dir" 'Failed to build MCP CLI (npm run build). Fix the error above and rerun install.sh.' run build

	mcp_cli="$mcp_dir/dist/cli.js"
	if [[ ! -f "$mcp_cli" ]]; then
		echo "MCP build completed without required artifact: $mcp_cli" >&2
		exit 1
	fi
	ok 'installed and built wspec/mcp'
fi

step 'Git hooks'
if ! test_git_work_tree "$dst"; then
	skip 'target is not a git repository; skipping hook configuration'
elif [[ $configure_hooks -eq 1 ]]; then
	if [[ $DRY_RUN -eq 1 ]]; then
		skip 'configure core.hooksPath -> wspec/scripts/hooks (dry-run)'
	else
		git -C "$dst" config core.hooksPath wspec/scripts/hooks
		ok 'configured core.hooksPath -> wspec/scripts/hooks'

		for hook in prepare-commit-msg commit-msg pre-commit pre-push; do
			hook_path="$dst/wspec/scripts/hooks/$hook"
			if [[ -f "$hook_path" ]]; then
				chmod +x "$hook_path"
			fi
		done
		ok 'set executable bit on hook shims'
	fi
else
	if [[ $DRY_RUN -eq 1 ]]; then
		skip 'unset core.hooksPath (dry-run)'
	else
		if git -C "$dst" config --unset core.hooksPath 2>/dev/null; then
			ok 'unset core.hooksPath'
		else
			skip 'core.hooksPath already unset'
		fi
	fi
fi

step 'Update .gitignore'
gitignore_path="$dst/.gitignore"
wspec_ignore_entries=('wspec/state.json' 'wspec/state.json.lock' 'wspec/.state.*.tmp')
existing_gitignore=""
if [[ -f "$gitignore_path" ]]; then
	existing_gitignore="$(<"$gitignore_path")"
fi
entries_to_add=()
for entry in "${wspec_ignore_entries[@]}"; do
	if [[ "$existing_gitignore" != *"$entry"* ]]; then
		entries_to_add+=("$entry")
	fi
done
if [[ ${#entries_to_add[@]} -gt 0 ]]; then
	if [[ $DRY_RUN -eq 1 ]]; then
		ok "would add ${#entries_to_add[@]} entries to .gitignore (dry-run)"
	else
		{
			printf '\n# wSpec generated files\n'
			printf '%s\n' "${entries_to_add[@]}"
		} >>"$gitignore_path"
		ok "added ${#entries_to_add[@]} entries to .gitignore"
	fi
else
	skip '.gitignore (wSpec entries already present)'
fi

step 'Merge Claude Code settings'
merge_script="$dst/wspec/scripts/merge-settings.cjs"
if [[ -f "$merge_script" ]]; then
	if [[ $DRY_RUN -eq 1 ]]; then
		skip '.claude/settings.json merge (dry-run)'
	else
		settings_target="$dst/.claude/settings.json"
		if node "$merge_script" "$settings_target"; then
			ok '.claude/settings.json'
		else
			skip '.claude/settings.json (merge script failed — check errors above)'
		fi
	fi
else
	skip 'Claude Code settings (merge script not found)'
fi

if [[ $UPGRADE -eq 0 ]]; then
	step 'Seed project files'
	for f in wspec/config.yaml wspec/principles.md; do
		out="$dst/$f"
		if [[ -f "$out" && $FORCE -eq 0 ]]; then
			skip "$f"
			continue
		fi
		fs_mkdir "$(dirname -- "$out")"
		fs_cp "$src/$f" "$out" "$f"
	done

	step 'Empty change folders'
	for d in wspec/changes wspec/specs wspec/archive; do
		out="$dst/$d"
		fs_mkdir "$out"
		keep="$out/.gitkeep"
		if [[ ! -f "$keep" && $DRY_RUN -eq 0 ]]; then
			: >"$keep"
		fi
		ok "$d"
	done
fi

printf '\n'
mode_label="install"
[[ $UPGRADE -eq 1 ]] && mode_label="upgrade"
if [[ $DRY_RUN -eq 1 ]]; then
	printf 'wSpec %s dry-run complete -> %s\n' "$mode_label" "$dst"
	printf 'No files were changed. Re-run without --dry-run to apply.\n'
else
	printf 'wSpec %s complete -> %s\n' "$mode_label" "$dst"
	if test_git_work_tree "$dst"; then
		printf "Target is a git repository - review with 'git status' / 'git diff' before committing.\n"
	fi
fi
