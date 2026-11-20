// Where Codex reads a project's config, and where tmb notes which of those files it created.
import path from "node:path";
import { PROJECT_DIR_NAME } from "../../engine/index.ts";

export const HOST_ID = "codex";
export const SERVER_KEY = "tmb";
export const CODEX_DIR = ".codex";

export const configTomlPath = (projectDir: string) => path.join(projectDir, CODEX_DIR, "config.toml");
export const hooksJsonPath = (projectDir: string) => path.join(projectDir, CODEX_DIR, "hooks.json");
export const agentsDir = (projectDir: string) => path.join(projectDir, CODEX_DIR, "agents");

/** The file that records init created `file`, so remove deletes it only when it was tmb's. */
/** Where init keeps the Human's hooks.json as it was, so remove can give it back byte for byte. */
export function originalHooksPath(projectDir: string): string {
  return path.join(projectDir, PROJECT_DIR_NAME, "codex-original-hooks.json");
}

export function createdMarkerPath(projectDir: string, file: "config" | "hooks"): string {
  return path.join(projectDir, PROJECT_DIR_NAME, `codex-created-${file}.json`);
}
