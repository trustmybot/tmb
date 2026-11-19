// Runs a task's checks: each command in the platform shell, in the task's worktree, with a
// time limit. Every command gets a result, including the ones that never ran, so nothing
// is skipped silently.
import { spawn } from "node:child_process";

export const CHECK_TIMEOUT_MS = 10 * 60 * 1000;
/** How much of a command's combined output is kept: the end, where the failure usually is. */
export const OUTPUT_TAIL_MAX = 2000;

export type CheckStatus = "passed" | "failed" | "not_run";

export type CheckCommandResult = {
  command: string;
  status: CheckStatus;
  /** Null when the command never ran, or was stopped by a signal or the time limit. */
  exitCode: number | null;
  startedAt: string | null;
  endedAt: string | null;
  outputTail: string;
  /** Why it failed without an exit code, or why it did not run. */
  reason?: string;
};

const IS_WINDOWS = process.platform === "win32";

function keepTail(text: string): string {
  return text.length <= OUTPUT_TAIL_MAX ? text : text.slice(-OUTPUT_TAIL_MAX);
}

/** Stops the command and everything it started: on POSIX the command leads its own process group. */
function stop(pid: number | undefined, kill: () => void): void {
  try {
    if (!IS_WINDOWS && pid !== undefined) process.kill(-pid, "SIGKILL");
    else kill();
  } catch {
    // The process already ended.
  }
}

/** Runs one command in `cwd` through the platform shell; never rejects. */
export function runCheck(command: string, cwd: string, timeoutMs: number = CHECK_TIMEOUT_MS): Promise<CheckCommandResult> {
  return new Promise((resolve) => {
    const startedAt = new Date().toISOString();
    let tail = "";
    let timedOut = false;
    let settled = false;
    const finish = (result: Omit<CheckCommandResult, "command" | "startedAt" | "endedAt" | "outputTail">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ command, ...result, startedAt: result.status === "not_run" ? null : startedAt, endedAt: new Date().toISOString(), outputTail: tail });
    };

    const child = spawn(command, { cwd, shell: true, detached: !IS_WINDOWS, stdio: ["ignore", "pipe", "pipe"] });
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding("utf8");
      stream.on("data", (chunk: string) => {
        tail = keepTail(tail + chunk);
      });
    }
    const timer = setTimeout(() => {
      timedOut = true;
      stop(child.pid, () => child.kill("SIGKILL"));
      // A process that escaped the group may still hold the pipes open; stop waiting on them.
      child.stdout.destroy();
      child.stderr.destroy();
    }, timeoutMs);

    child.on("error", (error) => finish({ status: "not_run", exitCode: null, reason: `could not start: ${error.message}` }));
    child.on("close", (code, signal) => {
      if (timedOut) finish({ status: "failed", exitCode: null, reason: `stopped after the ${Math.round(timeoutMs / 1000)} s time limit` });
      else if (code === 0) finish({ status: "passed", exitCode: 0 });
      else if (code !== null) finish({ status: "failed", exitCode: code });
      else finish({ status: "failed", exitCode: null, reason: `ended by signal ${signal ?? "unknown"}` });
    });
  });
}

/**
 * Runs the commands in order and stops at the first that does not pass; each command after
 * it is recorded as not run, with the reason.
 */
export async function runChecks(commands: readonly string[], cwd: string, timeoutMs: number = CHECK_TIMEOUT_MS): Promise<CheckCommandResult[]> {
  const results: CheckCommandResult[] = [];
  for (const command of commands) {
    const blocker = results.find((result) => result.status !== "passed");
    if (blocker) {
      results.push({
        command,
        status: "not_run",
        exitCode: null,
        startedAt: null,
        endedAt: null,
        outputTail: "",
        reason: `not run: \`${blocker.command}\` did not pass`,
      });
      continue;
    }
    results.push(await runCheck(command, cwd, timeoutMs));
  }
  return results;
}

/** One verdict for a check run: passed only when every command passed. */
export function overallResult(results: readonly CheckCommandResult[]): CheckStatus {
  if (results.length > 0 && results.every((result) => result.status === "passed")) return "passed";
  return results.some((result) => result.status === "failed") ? "failed" : "not_run";
}
