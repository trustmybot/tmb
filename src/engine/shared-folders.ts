// A task worktree is handed over ready: the folders the project shares, its dependency folders,
// are linked from the repo's main folder rather than installed again per task (trustmybot/tmb#286).
// The links are kept out of git's view, so a worktree with them still reads as clean.
import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type Git, SYSTEM_GIT } from "./git.ts";

/** The line in git's exclude file that hides one shared folder, file, folder or link alike, at the repo's top. */
export function excludeLine(folder: string): string {
  return `/${folder.replace(/[\\*?[]/g, (char) => `\\${char}`)}`;
}

export class SharedFolders {
  constructor(private readonly git: Git = SYSTEM_GIT) {}

  /**
   * Hides the shared folders from git status in every worktree of the repo at `repoDir`: a link
   * named like a folder is not matched by an ignore rule that ends in a slash, so it would read as a
   * new file and keep the worktree from being clean. Adds a line to the repository's own exclude
   * file only for a folder it lacks. Returns whether it wrote.
   */
  hide(repoDir: string, folders: readonly string[]): boolean {
    if (folders.length === 0) return false;
    const common = this.git.run(repoDir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    if (!common.ok) return false;
    const file = path.join(common.stdout, "info", "exclude");
    const text = existsSync(file) ? readFileSync(file, "utf8") : "";
    const present = new Set(text.split(/\r?\n/).map((line) => line.trim()));
    const missing = folders.map(excludeLine).filter((line) => !present.has(line));
    if (missing.length === 0) return false;
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${text}${text === "" || text.endsWith("\n") ? "" : "\n"}${missing.join("\n")}\n`);
    return true;
  }

  /**
   * Links each shared folder of the main folder `mainDir` into the worktree `worktreeDir`, and hides
   * the links from git status. A folder the main folder lacks, or the worktree already has, is left
   * alone. Returns the folders it could not link because the main folder lacks them.
   */
  link(mainDir: string, worktreeDir: string, folders: readonly string[]): string[] {
    this.hide(mainDir, folders);
    const missing: string[] = [];
    for (const folder of folders) {
      const source = path.join(mainDir, ...folder.split("/"));
      const target = path.join(worktreeDir, ...folder.split("/"));
      if (!existsSync(source)) {
        missing.push(folder);
        continue;
      }
      if (lstatSync(target, { throwIfNoEntry: false }) !== undefined) continue;
      mkdirSync(path.dirname(target), { recursive: true });
      symlinkSync(source, target, process.platform === "win32" ? "junction" : "dir");
    }
    return missing;
  }
}
