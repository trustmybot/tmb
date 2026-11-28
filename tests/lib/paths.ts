// The repo's fixed places, for every test: each test reaches the repo through these, so a test
// that moves to another folder still finds the same files.
import path from "node:path";

/** The root of the tmb repo. */
export const REPO_ROOT = path.resolve(import.meta.dir, "../..");
/** The source folder, one folder per component. */
export const SRC = path.join(REPO_ROOT, "src");
/** The command line's entry, which tests run from source as the tmb program. */
export const CLI_ENTRY = path.join(SRC, "cli", "index.ts");
/** tmb from source: bun running the command line's entry. */
export const TMB_COMMAND: readonly string[] = [process.execPath, CLI_ENTRY];
