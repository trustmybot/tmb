// The chain's steps, their checks, and the two checks that run after every step.
import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { BASE, REMOTE_REPOS, type World } from "./world.ts";

export type Step = {
  n: number;
  name: string;
  /** True for a step a user would ask bro: a real session, which needs the model login. */
  model: boolean;
  /** The issues the step covers, as trustmybot/tmb#N. */
  covers: number[];
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

/** The two checks that run after every step, once tmb is set up in the project. */
export function afterStep(world: World, checks: Checks): void {
  if (!existsSync(path.join(world.project, ".tmb", "trajectory.db"))) return;
  const findings = doctor(world);
  const failed = findings.filter((finding) => finding.status === "fail");
  checks.ok("tmb doctor reports no failure", failed.length === 0, showFindings(failed));
  const holes = recordHoles(world);
  checks.ok("the record is whole", holes.length === 0, holes.join("\n"));
}

type TaskRow = { id: string; state: string; commit_sha: string | null; repo: string | null; title: string };

/**
 * What keeps the record from being whole: a closed task with no run that ended and kept its
 * tokens, or no check that ran; and any change to a remote's branch that no push the gate
 * allowed made. The review of a closed task is checked once the session steps make one.
 */
export function recordHoles(world: World): string[] {
  const holes: string[] = [];
  const db = new Database(path.join(world.project, ".tmb", "trajectory.db"), { readonly: true });
  try {
    const tasks = db.query("SELECT id, state, commit_sha, repo, title FROM tasks WHERE state = 'closed'").all() as TaskRow[];
    for (const task of tasks) {
      const runs = db.query("SELECT ended_at, cost FROM runs WHERE task_id = ?").all(task.id) as { ended_at: string | null; cost: string | null }[];
      if (!runs.some((run) => run.ended_at !== null && run.cost !== null)) holes.push(`closed task ${task.id} (${task.title}) has no run that ended with its tokens`);
      const ran = db.query("SELECT count(*) AS n FROM check_runs WHERE task_id = ? AND result IS NOT NULL").get(task.id) as { n: number };
      if (ran.n === 0) holes.push(`closed task ${task.id} (${task.title}) has no check that ran`);
    }
    holes.push(...unallowedPushes(world, db));
  } finally {
    db.close();
  }
  return holes;
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
