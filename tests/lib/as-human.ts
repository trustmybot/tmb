// A step only the Human may take runs only on a terminal, once the Human types yes there
// (trustmybot/tmb#179). Tests take such a step as the Human through human-terminal.ts, which runs
// it on a pseudo-terminal and types the answers.
import { spawnSync } from "node:child_process";
import path from "node:path";

const HUMAN_TERMINAL = path.join(import.meta.dir, "human-terminal.ts");

export type HumanRun = { status: number | null; output: string };

/**
 * Runs `command args` on a terminal, typing each of `answers` (yes by default) at a question.
 * `output` is what the terminal showed: stdout and stderr together, the questions and the typed answers too.
 */
export function asHuman(
  command: string,
  args: string[],
  options: { cwd: string; env?: Record<string, string | undefined>; answers?: string[]; timeout?: number },
): HumanRun {
  const result = spawnSync(process.execPath, [HUMAN_TERMINAL, JSON.stringify(options.answers ?? ["yes"]), command, ...args], {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    timeout: options.timeout ?? 90_000,
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}
