import fs from "node:fs";
import path from "node:path";

const MAX_EVIDENCE_PER_PATTERN = 5;

const EXCLUDED_DIRS = new Set([
  "wspec",
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "bin",
  "obj",
  ".venv",
  "venv",
  "__pycache__"
]);

function walkFiles(root: string): string[] {
  const files: string[] = [];

  function visit(dir: string) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name)) continue;
        visit(full);
        continue;
      }

      if (!entry.isFile()) continue;

      const rel = path.relative(root, full).replace(/\\/g, "/");
      if (!rel || rel.startsWith("wspec/")) continue;
      files.push(rel);
    }
  }

  visit(root);
  return files;
}

function wildcardToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

function matchPattern(filePath: string, pattern: string): boolean {
  const base = path.basename(filePath);

  if (pattern.includes("*")) {
    return wildcardToRegex(pattern).test(base);
  }

  if (pattern.includes(".")) {
    return base.toLowerCase() === pattern.toLowerCase();
  }

  return filePath.toLowerCase().includes(`/${pattern.toLowerCase()}/`) || base.toLowerCase() === pattern.toLowerCase();
}

function findPatternHits(files: string[], pattern: string): { hits: string[]; truncated: boolean } {
  const matches = files.filter((file) => matchPattern(file, pattern));
  return {
    hits: matches.slice(0, MAX_EVIDENCE_PER_PATTERN),
    truncated: matches.length > MAX_EVIDENCE_PER_PATTERN
  };
}

function testAny(files: string[], patterns: string[]): { hits: string[]; pattern?: string; truncated: boolean } {
  for (const pattern of patterns) {
    const { hits, truncated } = findPatternHits(files, pattern);
    if (hits.length > 0) {
      return { hits, pattern, truncated };
    }
  }
  return { hits: [], truncated: false };
}

function collectPatternHits(files: string[], patterns: string[]): { hits: string[]; truncated: boolean } {
  const seen = new Set<string>();
  let truncated = false;

  for (const pattern of patterns) {
    const result = findPatternHits(files, pattern);
    if (result.truncated) {
      truncated = true;
    }
    for (const hit of result.hits) {
      seen.add(hit);
    }
  }

  return {
    hits: Array.from(seen),
    truncated
  };
}

type Confidence = "high" | "medium" | "low";
type CategoryType = "platform" | "tooling" | "structural" | "operational";

type ScanTopic = {
  topic: string;
  evidence: string[];
  confidence: Confidence;
  category_type?: CategoryType;
  detected_signals?: {
    primary: string;
    alternates?: string[];
  };
  anomalies?: string[];
  truncated?: boolean;
};

type ScanGap = {
  category: string;
  reason: "low-confidence" | "partial-evidence";
  impact: string;
  suggestion: string;
};

function readJson<T = unknown>(repoRoot: string, relPath: string): T | undefined {
  const fullPath = path.join(repoRoot, relPath);
  if (!fs.existsSync(fullPath)) {
    return undefined;
  }

  try {
    const raw = fs.readFileSync(fullPath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

export function repoScan(repoRoot: string) {
  const files = walkFiles(repoRoot);

  const topics: ScanTopic[] = [];
  const gaps: ScanGap[] = [];

  const langEvidence: string[] = [];
  const langDetected: string[] = [];
  let langTruncated = false;
  const langSignals = [
    { name: "Node.js/TypeScript", files: ["package.json", "tsconfig.json"] },
    { name: "Python", files: ["pyproject.toml", "setup.py", "requirements.txt"] },
    { name: "Go", files: ["go.mod"] },
    { name: "Rust", files: ["Cargo.toml"] },
    { name: ".NET", files: ["*.csproj", "*.fsproj", "*.sln"] },
    { name: "Java/Kotlin", files: ["pom.xml", "build.gradle", "build.gradle.kts"] },
    { name: "PowerShell", files: ["*.ps1", "*.psm1"] }
  ];

  for (const signal of langSignals) {
    const { hits, truncated } = testAny(files, signal.files);
    if (hits.length > 0) {
      langEvidence.push(`${signal.name}: ${hits.join(", ")}`);
      langDetected.push(signal.name);
      if (truncated) {
        langTruncated = true;
      }
    }
  }

  if (langDetected.length === 0) {
    gaps.push({
      category: "language_runtime",
      reason: "low-confidence",
      impact: "Cannot infer primary runtime stack from common manifests.",
      suggestion: "Inspect representative source roots and build scripts to identify primary runtime(s)."
    });
  }

  topics.push({
    topic: "language_runtime",
    evidence: langEvidence,
    confidence: langEvidence.length > 0 ? "high" : "low",
    category_type: "platform",
    detected_signals:
      langDetected.length > 0
        ? {
            primary: langDetected[0],
            alternates: langDetected.slice(1)
          }
        : undefined,
    truncated: langTruncated
  });

  const ciHits = files.filter((f) => /\.ya?ml$/i.test(f) && /\.github\/workflows|azure-pipelines|\.gitlab-ci|circleci/i.test(f));
  if (ciHits.length === 0) {
    gaps.push({
      category: "ci_workflows",
      reason: "low-confidence",
      impact: "Automated test and release gates are unclear.",
      suggestion: "Inspect branch policies and project docs to determine CI/CD enforcement."
    });
  }

  topics.push({
    topic: "ci_workflows",
    evidence: ciHits,
    confidence: ciHits.length > 0 ? "high" : "low",
    category_type: "tooling"
  });

  const lintPatterns = [".eslintrc*", ".prettierrc*", "ruff.toml", ".flake8", ".editorconfig", "PSScriptAnalyzerSettings.psd1"];
  const lintSignals = collectPatternHits(files, lintPatterns);
  const lintHits = lintSignals.hits;

  topics.push({
    topic: "lint_format",
    evidence: lintHits,
    confidence: lintHits.length > 0 ? "high" : "medium",
    category_type: "tooling",
    truncated: lintSignals.truncated
  });

  const testPatterns = ["jest.config*", "vitest.config*", "pytest.ini", "*.Tests.csproj", "*test*.go"];
  const testSignals = collectPatternHits(files, testPatterns);
  const testHits = testSignals.hits;

  if (testHits.length === 0) {
    gaps.push({
      category: "testing",
      reason: "low-confidence",
      impact: "Validation strategy and baseline test framework are unknown.",
      suggestion: "Inspect scripts and representative test directories to identify test gates."
    });
  }

  topics.push({
    topic: "testing",
    evidence: testHits,
    confidence: testHits.length > 0 ? "high" : "low",
    category_type: "tooling",
    truncated: testSignals.truncated
  });

  const infraPatterns = ["Dockerfile", "docker-compose*", "*.bicep", "*.tf", "helm", "k8s", "kubernetes"];
  const infraSignals = collectPatternHits(files, infraPatterns);
  const infraHits = infraSignals.hits;

  topics.push({
    topic: "infra_deployment",
    evidence: infraHits,
    confidence: infraHits.length > 0 ? "medium" : "low",
    category_type: "operational",
    truncated: infraSignals.truncated
  });

  const docPatterns = ["README.md", "CONTRIBUTING.md", "ADR*.md", "docs"];
  const docSignals = collectPatternHits(files, docPatterns);
  const docHits = docSignals.hits;

  topics.push({
    topic: "documentation",
    evidence: docHits,
    confidence: docHits.length > 0 ? "medium" : "low",
    category_type: "structural",
    truncated: docSignals.truncated
  });

  const dependencyManifestPatterns = [
    "package.json",
    "requirements.txt",
    "pyproject.toml",
    "Pipfile",
    "go.mod",
    "Cargo.toml",
    "pom.xml",
    "build.gradle",
    "build.gradle.kts"
  ];
  const dependencyLockPatterns = [
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "poetry.lock",
    "Pipfile.lock",
    "go.sum",
    "Cargo.lock"
  ];
  const dependencyManifestSignals = collectPatternHits(files, dependencyManifestPatterns);
  const dependencyLockSignals = collectPatternHits(files, dependencyLockPatterns);
  const dependencyEvidence = Array.from(new Set([...dependencyLockSignals.hits, ...dependencyManifestSignals.hits]));
  const dependencyAnomalies: string[] = [];

  let dependencyConfidence: Confidence = "low";
  if (dependencyLockSignals.hits.length > 0) {
    dependencyConfidence = "high";
  } else if (dependencyManifestSignals.hits.length > 0) {
    dependencyConfidence = "medium";
    dependencyAnomalies.push("Dependency manifests found without lockfiles; reproducibility may be weaker.");
    gaps.push({
      category: "dependencies",
      reason: "partial-evidence",
      impact: "Dependency policy is visible, but lock strategy is incomplete.",
      suggestion: "Confirm lockfile policy and update principles for pinning/reproducibility expectations."
    });
  } else {
    gaps.push({
      category: "dependencies",
      reason: "low-confidence",
      impact: "Dependency management strategy could not be detected.",
      suggestion: "Inspect build and package configuration to establish dependency policy."
    });
  }

  topics.push({
    topic: "dependencies",
    evidence: dependencyEvidence,
    confidence: dependencyConfidence,
    category_type: "tooling",
    anomalies: dependencyAnomalies.length > 0 ? dependencyAnomalies : undefined,
    truncated: dependencyManifestSignals.truncated || dependencyLockSignals.truncated
  });

  const envPatterns = [".env", ".env.*", ".env.example", "appsettings.json", "application.yml", "application.yaml", "config", "settings"];
  const envSignals = collectPatternHits(files, envPatterns);

  if (envSignals.hits.length === 0) {
    gaps.push({
      category: "environment_config",
      reason: "low-confidence",
      impact: "Environment and runtime configuration strategy is unclear.",
      suggestion: "Inspect deployment docs and startup scripts for env/config conventions."
    });
  }

  topics.push({
    topic: "environment_config",
    evidence: envSignals.hits,
    confidence: envSignals.hits.length > 0 ? "medium" : "low",
    category_type: "operational",
    truncated: envSignals.truncated
  });

  const securityPatterns = [
    "SECURITY.md",
    "dependabot.yml",
    "dependabot.yaml",
    ".snyk",
    "gitleaks.toml",
    "codeql",
    "trivy",
    "bandit.yaml"
  ];
  const securitySignals = collectPatternHits(files, securityPatterns);

  if (securitySignals.hits.length === 0) {
    gaps.push({
      category: "security",
      reason: "low-confidence",
      impact: "Security automation and policy evidence is sparse.",
      suggestion: "Inspect CI workflows and docs for security scanning, dependency audits, and disclosure policy."
    });
  }

  topics.push({
    topic: "security",
    evidence: securitySignals.hits,
    confidence: securitySignals.hits.length > 0 ? "medium" : "low",
    category_type: "operational",
    truncated: securitySignals.truncated
  });

  const typePatterns = ["tsconfig.json", "tsconfig.base.json", "pyrightconfig.json", "mypy.ini", "pyproject.toml"];
  const typeSignals = collectPatternHits(files, typePatterns);
  const typeAnomalies: string[] = [];
  let typeHints: string[] = [];

  const tsconfig = readJson<{ compilerOptions?: { strict?: boolean } }>(repoRoot, "tsconfig.json");
  if (tsconfig?.compilerOptions?.strict === true) {
    typeHints = ["TypeScript strict mode enabled (tsconfig.compilerOptions.strict=true)"];
  } else if (tsconfig?.compilerOptions) {
    typeAnomalies.push("TypeScript config detected without strict=true.");
    typeHints = ["TypeScript config present; strict mode not explicitly enabled"];
  }

  if (typeSignals.hits.length === 0) {
    gaps.push({
      category: "type_checking",
      reason: "low-confidence",
      impact: "Static type checking posture is unknown.",
      suggestion: "Inspect build/test scripts for type check commands and strictness settings."
    });
  }

  topics.push({
    topic: "type_checking",
    evidence: typeHints.length > 0 ? [...typeSignals.hits, ...typeHints] : typeSignals.hits,
    confidence: typeSignals.hits.length > 0 ? (typeAnomalies.length > 0 ? "medium" : "high") : "low",
    category_type: "tooling",
    anomalies: typeAnomalies.length > 0 ? typeAnomalies : undefined,
    truncated: typeSignals.truncated
  });

  const highConfidenceTopics = topics.filter((topic) => topic.confidence === "high").length;
  const primaryPlatform = langDetected[0] ?? "unknown";

  const summary = {
    platform: primaryPlatform,
    quality_gates_detected: topics
      .filter((topic) => topic.topic === "testing" || topic.topic === "lint_format" || topic.topic === "type_checking")
      .filter((topic) => topic.evidence.length > 0)
      .map((topic) => topic.topic),
    deployment_target: infraHits.length > 0 ? "infrastructure-config-present" : "unspecified",
    principles_readiness: highConfidenceTopics >= 4 ? "high" : highConfidenceTopics >= 2 ? "medium" : "low"
  };

  return {
    schema_version: "2.0",
    root: repoRoot,
    scanned_at: new Date().toISOString(),
    topics,
    gaps,
    summary,
    note: "Evidence paths are first 5 matches per pattern; dispatch the wspec-scan-gapfiller subagent for deeper inspection of low-confidence or partial-evidence topics."
  };
}
