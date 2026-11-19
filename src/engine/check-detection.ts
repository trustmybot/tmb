// Suggests the checks a project already runs, from the files its stack leaves behind.
// A suggestion only: the Human confirms or replaces it at setup.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/** package.json scripts offered as checks, in the order they are run. */
const PACKAGE_SCRIPTS = ["lint", "typecheck", "test"] as const;

/** Lockfiles and the tool that runs scripts for each, in order of precedence. */
const LOCKFILE_TOOLS: readonly [lockfile: string, tool: string][] = [
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
];

/** Marker files and the check each stack runs, in the order they are offered after package.json's. */
const STACK_CHECKS: readonly [markers: string[], check: string][] = [
  [["pyproject.toml", "setup.cfg"], "pytest"],
  [["Cargo.toml"], "cargo test"],
  [["go.mod"], "go test ./..."],
];

function scriptRunner(projectDir: string): string {
  return LOCKFILE_TOOLS.find(([lockfile]) => existsSync(path.join(projectDir, lockfile)))?.[1] ?? "npm";
}

/** The package.json scripts, or none when the file is missing or not a JSON object. */
function packageScripts(projectDir: string): Record<string, unknown> {
  const file = path.join(projectDir, "package.json");
  if (!existsSync(file)) return {};
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    // A package.json that does not parse suggests no scripts; setup still offers the rest.
    return {};
  }
  const scripts = (manifest as { scripts?: unknown } | null)?.scripts;
  return typeof scripts === "object" && scripts !== null ? (scripts as Record<string, unknown>) : {};
}

/** The checks the project's files suggest, in the order to run them; none found, an empty list. */
export function detectChecks(projectDir: string): string[] {
  const scripts = packageScripts(projectDir);
  const runner = scriptRunner(projectDir);
  const checks = PACKAGE_SCRIPTS.filter((name) => typeof scripts[name] === "string" && (scripts[name] as string).trim() !== "").map(
    (name) => `${runner} run ${name}`,
  );
  for (const [markers, check] of STACK_CHECKS) {
    if (markers.some((marker) => existsSync(path.join(projectDir, marker)))) checks.push(check);
  }
  return checks;
}
