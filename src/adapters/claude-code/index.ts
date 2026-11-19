import path from "node:path";
import type { HostAdapter } from "../host-adapter.ts";
import { answerHook } from "./hook.ts";
import { install, remove } from "./settings.ts";

function shown(projectDir: string, file: string): string {
  return path.relative(projectDir, file) || file;
}

export const adapter: HostAdapter = {
  name: "Claude Code",

  setup(projectDir, executablePath) {
    const result = install(projectDir, executablePath);
    const file = shown(projectDir, result.settingsFile);
    const lines = [
      result.settingsChanged
        ? `Added the SessionStart hook to ${file}.`
        : `${file} already has the SessionStart hook; nothing to add.`,
    ];
    if (result.gitignoreChanged) lines.push(`Added .claude/settings.local.json to .gitignore.`);
    return lines;
  },

  remove(projectDir) {
    const result = remove(projectDir);
    const file = shown(projectDir, result.settingsFile);
    if (!result.settingsChanged) return [`No tmb hook found in ${file}; nothing to remove.`];
    return [result.fileDeleted ? `Removed the SessionStart hook and the now-empty ${file}.` : `Removed the SessionStart hook from ${file}.`];
  },

  answerHook,
};
