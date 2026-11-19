// Codex reads a project's .codex/ only once the Human trusts the project, and runs a project
// hook only once the Human trusts that hook. tmb never trusts for them; it says what is left.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { isObject } from "../common/json-file.ts";

function codexHome(): string {
  const home = process.env.CODEX_HOME;
  return home && home.trim() !== "" ? home : path.join(homedir(), ".codex");
}

/** Whether the Human's Codex config marks the project trusted. False when it cannot tell. */
export function isProjectTrusted(projectDir: string): boolean {
  const file = path.join(codexHome(), "config.toml");
  if (!existsSync(file)) return false;
  try {
    const projects = (Bun.TOML.parse(readFileSync(file, "utf8")) as Record<string, unknown>).projects;
    if (!isObject(projects)) return false;
    const keys = new Set([projectDir, path.resolve(projectDir)]);
    try {
      keys.add(realpathSync(projectDir));
    } catch {
      // A folder that cannot be resolved keeps the paths given.
    }
    return [...keys].some((key) => {
      const entry = projects[key];
      return isObject(entry) && entry.trust_level === "trusted";
    });
  } catch {
    return false;
  }
}

export function pendingSteps(projectDir: string): string[] {
  const steps: string[] = [];
  if (!isProjectTrusted(projectDir)) {
    steps.push("Trust this project in Codex: start codex here and accept its prompt to trust the folder. Codex reads .codex/ only in a project you trust.");
  }
  steps.push(
    "Review and trust tmb's hooks: run /hooks in Codex. Codex runs a project hook only after you trust it, and asks again whenever tmb init changes one.",
  );
  return steps;
}
