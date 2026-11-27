// The chain's steps, their checks, and the checks that run after every step.
import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { RECORD_BUGS, type RunRow, strandedRuns } from "./record.ts";
import { BASE, PROGRAM, REMOTE_REPOS, type World } from "./world.ts";

export type Step = {
  n: number;
  name: string;
  /** True for a step a user would ask bro: a real session, which needs the model login. */
  model: boolean;
  /** The issues the step covers, as trustmybot/tmb#N. */
  covers: number[];
  /** A session step's token budget, all its runs together: a step over it is reported, not failed. */
  budget?: number;
  run(world: World, checks: Checks): Promise<void> | void;
};

/** Thrown by a check that the rest of its step cannot go on without. */
export class StepStopped extends Error {}

/**
 * A step's checks. Each prints one line: PASS, FAIL, or KNOWN for a check that fails because of
 * a tmb bug already filed, which does not fail the step. A known check that passes again is
 * printed as FIXED, so its mark is taken out.
 */
export class Checks {
  failures = 0;
  fixed = 0;

  constructor(readonly label: string) {}

  /** Passes when `ok`; `detail` says what was seen when it does not. */
  ok(name: string, ok: boolean, detail = ""): boolean {
    console.log(`${ok ? "PASS" : "FAIL"} ${this.label}: ${name}`);
    if (!ok) {
      this.failures++;
      if (detail) for (const line of detail.trimEnd().split("\n")) console.log(`  | ${line}`);
    }
    return ok;
  }

  /** As `ok`, and the step stops here when it fails. */
  must(name: string, ok: boolean, detail = ""): void {
    if (!this.ok(name, ok, detail)) throw new StepStopped(name);
  }

  /** A check that fails today because of the filed bug trustmybot/tmb#`issue`. */
  known(issue: number, name: string, ok: boolean, detail = ""): void {
    const bug = `trustmybot/tmb#${issue}`;
    if (ok) {
      this.fixed++;
      console.log(`FIXED ${this.label}: ${name} (${bug} is fixed: take this check's known mark out)`);
      return;
    }
    console.log(`KNOWN ${this.label}: ${name} (fails until ${bug} is fixed)`);
    if (detail) for (const line of detail.trimEnd().split("\n").slice(0, 6)) console.log(`  | ${line}`);
  }
}

// ---------------------------------------------------------------------------------------------
// After every step

export type Finding = { check: string; scope: string; status: string; summary: string; fix?: string; details?: string[] };

/** `tmb doctor --json` on the project. */
export function doctor(world: World): Finding[] {
  return world.tmbJson<Finding[]>(["doctor"]);
}

/** One line per finding, for a check's detail. */
export function showFindings(findings: Finding[]): string {
  return findings
    .flatMap((finding) => [`${finding.status} ${finding.check}: ${finding.summary}${finding.fix ? ` (fix: ${finding.fix})` : ""}`, ...(finding.details ?? []).map((detail) => `    ${detail}`)])
    .join("\n");
}

/**
 * A printed command of plain tmb: `tmb`, not part of a longer name or a path, then a command or a
 * flag. The same pattern as test/program-name.test.ts.
 */
const COMMANDS = ["init", "onboard", "config", "remove", "migrate", "issue", "note", "feature", "task", "search", "history", "graph", "index", "tools", "dashboard", "update", "feedback", "doctor", "help", "mcp", "hook", "pre-push"];
const PLAIN = new RegExp(`(?<![\\w./-])tmb (?:(?:${COMMANDS.join("|")})\\b|--)`);

/** The lines tmb printed since the last call that tell their reader to run plain tmb. */
export function plainCommands(world: World): string[] {
  const printed = world.printed.splice(0, world.printed.length);
  return printed.flatMap(({ run, text }) => text.split(/\r?\n/).filter((line) => PLAIN.test(line)).map((line) => `${run}: ${line.trim()}`));
}

/**
 * The checks that run after every step: every command tmb printed names the program that runs
 * (the chain runs it as tmb-dev), then, once tmb is set up in the project, doctor and the record.
 */
export function afterStep(world: World, checks: Checks): void {
  const plain = plainCommands(world);
  checks.ok(`every command tmb printed names ${PROGRAM}, the program that ran (trustmybot/tmb#268)`, plain.length === 0, plain.join("\n"));
  if (!existsSync(path.join(world.project, ".tmb", "trajectory.db"))) return;
  const findings = doctor(world);
  const failed = findings.filter((finding) => finding.status === "fail");
  checks.ok("tmb doctor reports no failure", failed.length === 0, showFindings(failed));
  const { holes, stranded } = recordHoles(world);
  checks.ok("the record is whole", holes.length === 0, holes.join("\n"));
  if (stranded.length > 0) checks.known(RECORD_BUGS.strandedStart, "the record is whole: each closed task's worker run ended with its tokens", false, stranded.join("\n"));
}

type TaskRow = { id: string; state: string; commit_sha: string | null; repo: string | null; title: string; kind: string | null; feature_id: string | null; review_mode: string | null };

/** Feature states past the review: the branch was passed, so its tasks must be covered. */
const REVIEWED_STATES = ["pr_open", "ready", "merged"];

/**
 * What keeps the record from being whole:
 * - a closed code task with no run that ended and kept its tokens (a docs task is written by the
 *   planner itself, whose runs the record does not keep yet: trustmybot/tmb#254);
 * - a closed task with no check that ran, in a repo that has checks;
 * - a closed task with no review: in truest mode its own pass, in agile mode a pass of its feature
 *   branch once that branch is past its review;
 * - any change to a remote's branch that no push the gate allowed made.
 */
export function recordHoles(world: World): { holes: string[]; stranded: string[] } {
  const holes: string[] = [];
  // A closed task whose worker runs trustmybot/tmb#285 left open: kept apart, as a known hole.
  const stranded: string[] = [];
  const config = world.tmbJson<{ repos: Record<string, { checks?: string[] }> | null }>(["config"]);
  const db = new Database(path.join(world.project, ".tmb", "trajectory.db"), { readonly: true });
  try {
    const tasks = db.query("SELECT id, state, commit_sha, repo, title, kind, feature_id, review_mode FROM tasks WHERE state = 'closed'").all() as TaskRow[];
    for (const task of tasks) {
      const name = `closed task ${task.id} (${task.title})`;
      const runs = db.query("SELECT * FROM runs WHERE task_id = ?").all(task.id) as RunRow[];
      if (task.kind !== "docs" && !runs.some((run) => run.ended_at !== null && run.cost !== null)) (strandedRuns(runs).length > 0 ? stranded : holes).push(`${name} has no run that ended with its tokens`);
      const hasChecks = (config.repos?.[task.repo ?? "."]?.checks ?? ["?"]).length > 0;
      const ran = db.query("SELECT count(*) AS n FROM check_runs WHERE task_id = ? AND result IS NOT NULL").get(task.id) as { n: number };
      if (hasChecks && ran.n === 0) holes.push(`${name} has no check that ran`);
      if (task.feature_id === null) {
        const passed = db.query("SELECT count(*) AS n FROM reviews WHERE target_kind = 'commit' AND target = ? AND verdict = 'pass'").get(task.id) as { n: number };
        if (passed.n === 0) holes.push(`${name} has no review that passed it`);
      } else {
        const feature = db.query("SELECT name, state FROM features WHERE id = ?").get(task.feature_id) as { name: string; state: string } | null;
        if (feature && REVIEWED_STATES.includes(feature.state)) {
          const passed = db.query("SELECT count(*) AS n FROM reviews WHERE feature_id = ? AND verdict = 'pass'").get(task.feature_id) as { n: number };
          if (passed.n === 0) holes.push(`${name} is on ${feature.name}, which is ${feature.state} with no review that passed it`);
        }
      }
    }
    holes.push(...unallowedPushes(world, db));
  } finally {
    db.close();
  }
  return { holes, stranded };
}

type PushEvent = { repo?: string; refs?: { localSha: string; remoteRef: string }[] | string };

/**
 * Each change to a remote's branch since the demo app was built, as the bare repo logged it,
 * matched against the push gate's record: a push it allowed, of that commit to that branch.
 * A change the stand-in for GitHub made, a pull request merged on the site, is not a push.
 */
function unallowedPushes(world: World, db: Database): string[] {
  const allowed = new Set<string>();
  const rows = db.query("SELECT event FROM guard_decisions WHERE decision = 'allow'").all() as { event: string }[];
  for (const row of rows) {
    let event: PushEvent & { type?: string };
    try {
      event = JSON.parse(row.event);
    } catch {
      continue;
    }
    if (event.type !== "before-push" || !Array.isArray(event.refs)) continue;
    for (const ref of event.refs) allowed.add(`${event.repo ?? "."} ${ref.remoteRef} ${ref.localSha}`);
  }
  const holes: string[] = [];
  for (const repo of REMOTE_REPOS) {
    const logs = path.join(world.remote(repo), "logs", "refs", "heads");
    for (const file of listFiles(logs)) {
      const branch = path.relative(logs, file).split(path.sep).join("/");
      for (const line of readFileSync(file, "utf8").split("\n")) {
        if (line.trim() === "") continue;
        const [entry, message = ""] = line.split("\t");
        const newSha = entry!.split(" ")[1]!;
        if (/^0+$/.test(newSha) || message.startsWith("github:")) continue;
        if (!allowed.has(`${repo} refs/heads/${branch} ${newSha}`)) holes.push(`${repo}: ${branch} on origin moved to ${newSha.slice(0, 12)} by a push the gate did not allow (${message || "no message"})`);
      }
    }
  }
  return holes;
}

function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return [...new Bun.Glob("**/*").scanSync({ cwd: dir, onlyFiles: true })].map((file) => path.join(dir, file));
}

/** The commit a remote's base branch is at. */
export function remoteBase(world: World, repo: string): string {
  return world.git(path.join(world.remotes, `${repo}.git`), "rev-parse", BASE);
}
