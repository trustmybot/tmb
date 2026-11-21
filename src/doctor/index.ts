// `tmb doctor`: checks the machine and the project, prints one line per check with its fix, and
// with `--fix` does each fix the Human says yes to (trustmybot/tmb#160). Doctor itself only reads.
import { parseArgs } from "node:util";
import { Database } from "bun:sqlite";
import { projectDbPath, projectRootOf } from "../engine/project.ts";
import { SCHEMA_VERSION, Store } from "../engine/store/index.ts";
import { runningName } from "../program.ts";
import { MACHINE_CHECKS } from "./machine.ts";
import { guarded, projectFindings, unfinishedWork } from "./project.ts";
import { type DoctorEnv, type Finding, SLOW_CHECKS, type Status } from "./types.ts";

export { type DoctorEnv, type Finding, SLOW_CHECKS } from "./types.ts";

export const DOCTOR_USAGE = `  tmb doctor [--json] [--fix]
                            Check this machine and this project: the program and its old
                            builds, its update, the state folder, the record, the host files,
                            the settings, unfinished work, closed tasks' checkouts, the code
                            graph and gh. Prints one line per check with its fix, and exits 1
                            when a check failed. Changes nothing. --json prints the same as
                            data. --fix asks about each fix in turn and does only what you say
                            yes to; with no terminal it changes nothing`;

/** Every check's findings, the machine's first; `skip` names checks to leave out. */
export function runChecks(env: DoctorEnv, skip: ReadonlySet<string> = new Set()): Finding[] {
  const machine = MACHINE_CHECKS.filter((check) => !skip.has(check.name)).flatMap((check) => guarded(check.name, "machine", () => check.run(env)));
  return [...machine, ...projectFindings(env, skip)];
}

/** 1 when a check failed; a warning alone leaves 0. */
export function exitCode(findings: readonly Finding[]): number {
  return findings.some((finding) => finding.status === "fail") ? 1 : 0;
}

const MARKS: Record<Status, string> = { ok: "✓", warn: "!", fail: "✗" };

/** The findings as the Human reads them: a heading per scope, one line per finding, its details and its fix under it. */
export function formatFindings(findings: readonly Finding[], program: string = runningName()): string {
  const lines: string[] = [];
  for (const scope of ["machine", "project"] as const) {
    const ofScope = findings.filter((finding) => finding.scope === scope);
    if (ofScope.length === 0) continue;
    if (lines.length > 0) lines.push("");
    lines.push(scope === "machine" ? "This machine" : "This project");
    for (const finding of ofScope) {
      lines.push(`  ${MARKS[finding.status]} ${finding.check}: ${finding.summary}`);
      for (const detail of finding.details ?? []) lines.push(`      ${detail}`);
      if (finding.fix !== undefined && finding.status !== "ok") lines.push(`      fix: ${finding.fix.say}`);
    }
  }
  const warnings = findings.filter((finding) => finding.status === "warn").length;
  const failures = findings.filter((finding) => finding.status === "fail").length;
  lines.push("");
  lines.push(
    warnings + failures === 0
      ? "Everything is fine."
      : `${count(failures, "failure")} and ${count(warnings, "warning")}.${findings.some((finding) => finding.fix?.apply !== undefined && finding.status !== "ok") ? ` \`${program} doctor --fix\` asks about each fix it can do.` : ""}`,
  );
  return lines.join("\n");
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** The findings as data: everything but the fix's function. */
export function findingsJson(findings: readonly Finding[]): string {
  return JSON.stringify(
    findings.map(({ fix, ...rest }) => ({ ...rest, ...(fix === undefined ? {} : { fix: fix.say, fixable: fix.apply !== undefined }) })),
    null,
    2,
  );
}

export type Ask = (prompt: string) => Promise<string | null>;

/** Asks about each fix doctor can do, in turn, and does each one the Human says yes to. Returns how many it did. */
export async function applyFixes(findings: readonly Finding[], ask: Ask, out: (text: string) => void): Promise<number> {
  let done = 0;
  for (const finding of findings) {
    const fix = finding.fix;
    if (finding.status === "ok" || fix?.apply === undefined) continue;
    const answer = await ask(`${fix.ask ?? `Fix ${finding.check}: ${fix.say}?`} [y/N] `);
    if (answer === null) {
      out("No answer: stopped asking. Nothing more was changed.");
      break;
    }
    if (!/^y(es)?$/i.test(answer.trim())) {
      out("  Left as it is.");
      continue;
    }
    try {
      out(`  ${fix.apply()}`);
      done++;
    } catch (error) {
      out(`  The fix failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return done;
}

export type DoctorIo = {
  out: (text: string) => void;
  err: (text: string) => void;
  /** Null when no one can answer: `--fix` then changes nothing. */
  ask: Ask | null;
  /** Called once for each finding that looks like tmb's own bug, to keep it for `tmb feedback`. */
  keepBug?: (finding: Finding) => void;
};

export async function runDoctorCommand(args: string[], env: DoctorEnv, io: DoctorIo): Promise<number> {
  const { values } = parseArgs({ args, options: { json: { type: "boolean" }, fix: { type: "boolean" } }, allowPositionals: false, strict: true });
  const findings = runChecks(env);
  for (const finding of findings.filter((candidate) => candidate.bug === true)) io.keepBug?.(finding);
  io.out(values.json === true ? findingsJson(findings) : formatFindings(findings, env.program.name));
  if (values.fix !== true) return exitCode(findings);
  const fixable = findings.filter((finding) => finding.status !== "ok" && finding.fix?.apply !== undefined);
  if (fixable.length === 0) {
    io.err("Nothing here doctor can fix by itself.");
    return exitCode(findings);
  }
  if (io.ask === null) {
    io.err(`No terminal to ask on: nothing was changed. Run \`${env.program.name} doctor --fix\` in a terminal to choose each fix.`);
    return exitCode(findings);
  }
  io.err("");
  const done = await applyFixes(fixable, io.ask, io.err);
  io.err(`${done === 1 ? "1 fix" : `${done} fixes`} done. Run \`${env.program.name} doctor\` again to see where things stand.`);
  return exitCode(runChecks(env));
}

/**
 * The line a planner's session start shows: how many findings the quick checks give, and the runs
 * and tasks with a start and no end; null when there is nothing to say. Never throws.
 */
export function sessionStartLine(env: DoctorEnv): string | null {
  try {
    const findings = runChecks(env, new Set([...SLOW_CHECKS, "unfinished work"])).filter((finding) => finding.status !== "ok");
    const unfinished = unfinishedCount(env);
    const parts: string[] = [];
    if (findings.length > 0) parts.push(`${count(findings.length, "finding")} on this machine or project`);
    if (unfinished > 0) parts.push(`${unfinished} run${unfinished === 1 ? " or task has" : "s or tasks have"} a start and no end`);
    if (parts.length === 0) return null;
    return `${parts.join("; ")}: \`${env.program.name} doctor\` shows ${parts.length === 1 && findings.length === 0 ? "them" : "each"} with its fix.`;
  } catch {
    return null;
  }
}

function unfinishedCount(env: DoctorEnv): number {
  const projectDir = projectRootOf(env.cwd);
  let db: Database;
  try {
    db = new Database(projectDbPath(projectDir), { readonly: true });
  } catch {
    return 0;
  }
  try {
    const version = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
    if (version !== SCHEMA_VERSION) return 0;
    return unfinishedWork(new Store(db)).length;
  } catch {
    return 0;
  } finally {
    db.close();
  }
}
