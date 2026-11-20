// The project's checks: its record, its wiring, its settings, its unfinished work, its closed
// tasks' checkouts, its code graph, GitHub's CLI and the other records around it
// (trustmybot/tmb#160). Each reads only; a fix runs only after the Human's yes.
import { Database } from "bun:sqlite";
import { existsSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { sessionEntries } from "../builds.ts";
import { detectBaseBranch } from "../engine/base-branch.ts";
import { EXTRACTOR_VERSION } from "../engine/graph/build.ts";
import { BASE_LAYER, graphDbPath } from "../engine/graph/db.ts";
import { baseCommit } from "../engine/graph/git-source.ts";
import { keptCheckouts, removeTaskCheckout } from "../engine/handlers/fold.ts";
import { emptySettings } from "../engine/handlers/settings.ts";
import { tiedProgram } from "../engine/program-tie.ts";
import { PROJECT_DIR_NAME, projectDbPath, projectRootOf } from "../engine/project.ts";
import { addToForeignHook, FOREIGN_GAP, foreignHooks, pushGateGaps } from "../engine/push-gate.ts";
import { repoDirOf, workingRepos } from "../engine/repos.ts";
import { readSettings, type Settings } from "../engine/settings.ts";
import { SCHEMA_VERSION, SHAPE_WRITER_KEY, Store, type Task } from "../engine/store/index.ts";
import type { DoctorEnv, Finding } from "./types.ts";

const finding = (check: string, rest: Omit<Finding, "check" | "scope">): Finding => ({ check, scope: "project", ...rest });

function oneLine(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim();
}

function holdsRecord(dir: string): boolean {
  return statSync(projectDbPath(dir), { throwIfNoEntry: false })?.isFile() ?? false;
}

/** What the record check learned, for the checks that read the record next. */
type RecordState = { store: Store; settings: Settings } | { store: null; why: string };

function stamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\..*$/, "");
}

/** Moves the record and its WAL files aside under `suffix`; returns where the record went. */
function moveAside(dbPath: string, suffix: string): string {
  const aside = `${dbPath}.${suffix}`;
  renameSync(dbPath, aside);
  for (const extra of ["-wal", "-shm"]) if (existsSync(`${dbPath}${extra}`)) renameSync(`${dbPath}${extra}`, `${aside}${extra}`);
  return aside;
}

/**
 * Repairs a record SQLite can still open: copies every page it can read into a new file, checks
 * the copy, then puts it in place and keeps the old file beside it. Returns what it did.
 */
export function repairRecord(dbPath: string, now: Date): string {
  const recovered = `${dbPath}.recovered-${stamp(now)}`;
  rmSync(recovered, { force: true });
  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      db.run(`VACUUM INTO '${recovered.replace(/'/g, "''")}'`);
    } finally {
      db.close();
    }
    const copy = new Database(recovered, { readonly: true });
    try {
      const check = (copy.query("PRAGMA quick_check").get() as { quick_check: string }).quick_check;
      if (check !== "ok") throw new Error(`the copy fails SQLite's check too: ${check}`);
    } finally {
      copy.close();
    }
  } catch (error) {
    rmSync(recovered, { force: true });
    return `Could not repair the record: ${oneLine(error)}. It is unchanged. Move it away to keep it, then \`tmb init\` makes a new one.`;
  }
  const aside = moveAside(dbPath, `broken-${stamp(now)}`);
  renameSync(recovered, dbPath);
  return `Repaired the record: what SQLite could read is in ${dbPath}, and the damaged file is kept as ${aside}.`;
}

function recordCheck(env: DoctorEnv, projectDir: string): { finding: Finding; state: RecordState } {
  const dbPath = projectDbPath(projectDir);
  const name = env.program.name;
  const broken = (summary: string, fix: Finding["fix"]): { finding: Finding; state: RecordState } => ({
    finding: finding("record", { status: "fail", summary, fix }),
    state: { store: null, why: "the record cannot be read" },
  });
  const moveFix = {
    say: `move it away to keep it, then \`${name} init\` makes a new record`,
    ask: `Move the record aside, so \`${name} init\` can make a new one?`,
    apply: () => `Moved the record to ${moveAside(dbPath, `broken-${stamp(env.now())}`)}. Run \`${name} init\` to make a new one.`,
  };
  let db: Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch (error) {
    return broken(`${dbPath} cannot be opened: ${oneLine(error)}`, moveFix);
  }
  let version: number;
  try {
    version = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
    const tables = (db.query("SELECT count(*) AS n FROM sqlite_master").get() as { n: number }).n;
    if (version === 0 && tables > 0) {
      db.close();
      return broken(`${dbPath} is a SQLite database but not a tmb record`, { say: "move it away; tmb did not write it, so tmb leaves it alone" });
    }
  } catch (error) {
    db.close();
    return broken(`${dbPath} is not a readable SQLite database: ${oneLine(error)}`, moveFix);
  }
  let writer: { program: string; version: string } | null = null;
  try {
    const row = db.query("SELECT value FROM meta WHERE key = ?").get(SHAPE_WRITER_KEY) as { value: string } | null;
    const parsed = row ? (JSON.parse(row.value) as Partial<{ program: string; version: string }>) : null;
    if (typeof parsed?.program === "string" && typeof parsed.version === "string") writer = { program: parsed.program, version: parsed.version };
  } catch {
    // An older shape keeps no writer.
  }
  const by = writer === null ? "" : `, written by ${writer.program} ${writer.version}`;
  if (version > SCHEMA_VERSION) {
    db.close();
    const use = writer !== null && writer.program !== name ? `run \`${writer.program}\` in this project, or ` : "";
    return {
      finding: finding("record", {
        status: "fail",
        summary: `the record has shape ${version}${by}; ${name} ${env.version} reads up to shape ${SCHEMA_VERSION}`,
        fix: { say: `${use}update this program: \`${name} update\`` },
      }),
      state: { store: null, why: `a newer tmb reshaped the record` },
    };
  }
  let check: string;
  try {
    check = (db.query("PRAGMA quick_check").get() as { quick_check: string }).quick_check;
  } catch (error) {
    check = oneLine(error);
  }
  if (check !== "ok") {
    db.close();
    return broken(`the record is damaged: ${check}`, {
      say: `repair it with \`${name} doctor --fix\``,
      ask: "Repair the record? tmb copies what SQLite can read into a new file and keeps the damaged one beside it.",
      apply: () => repairRecord(dbPath, env.now()),
    });
  }
  if (version < SCHEMA_VERSION) {
    db.close();
    return {
      finding: finding("record", { status: "ok", summary: `readable, shape ${version}${by}; the next tmb command upgrades it to shape ${SCHEMA_VERSION}` }),
      state: { store: null, why: `the record has an older shape, which the next tmb command upgrades` },
    };
  }
  const store = new Store(db);
  try {
    return { finding: finding("record", { status: "ok", summary: `readable, shape ${version}${by}` }), state: { store, settings: readSettings(store) } };
  } catch (error) {
    store.close();
    return broken(`the record's settings cannot be read: ${oneLine(error)}`, undefined);
  }
}

/** The command the project's wiring should run: the tied program's when another program is tied, else this one's. */
function wiredCommand(env: DoctorEnv, store: Store): readonly string[] {
  const tie = tiedProgram(store);
  return tie !== null && tie.program !== env.program.name ? tie.command : env.tmbCommand;
}

function hostFilesChecks(env: DoctorEnv, projectDir: string, state: { store: Store; settings: Settings }): Finding[] {
  const { settings } = state;
  const command = wiredCommand(env, state.store);
  const init = `${env.program.name} init`;
  const ids = [...new Set([...Object.keys(settings.host_roles ?? {}), ...(settings.host === null ? [] : [settings.host])])];
  const findings: Finding[] = [];
  if (ids.length === 0) findings.push(finding("host files", { status: "warn", summary: "no host is set up in this project", fix: { say: `\`${init}\`` } }));
  for (const id of ids) {
    const adapter = env.adapters.find((candidate) => candidate.id === id);
    if (adapter === undefined) {
      findings.push(finding("host files", { status: "warn", summary: `the record names the host ${id}, which this tmb does not know` }));
      continue;
    }
    if (adapter.wiringGaps === undefined) {
      findings.push(finding("host files", { status: "ok", summary: `${adapter.name}: this tmb cannot check its files` }));
      continue;
    }
    const gaps = adapter.wiringGaps(projectDir, command);
    findings.push(
      gaps.length === 0
        ? finding("host files", { status: "ok", summary: `${adapter.name}'s files match what this tmb wires` })
        : finding("host files", { status: "warn", summary: `${adapter.name}'s files differ from what this tmb wires`, details: gaps, fix: { say: `\`${init} --host ${id}\`` } }),
    );
  }
  // A hook that is another tool's takes tmb's one line, with the Human's yes; any other gap is init's to mend (trustmybot/tmb#184).
  const foreign = foreignHooks(projectDir, settings.repos);
  const gate = pushGateGaps(projectDir, settings.repos, command).filter((gap) => !foreign.some((hook) => gap.startsWith(`${FOREIGN_GAP} ${hook.file} `)));
  if (foreign.length > 0) {
    const program = tiedProgram(state.store)?.program ?? env.program.name;
    findings.push(
      finding("host files", {
        status: "warn",
        summary: "the push gate is off where git's pre-push hook is another tool's",
        details: foreign.map((hook) => `${hook.dir}: its hook ${hook.file} is not tmb's and does not run the push gate`),
        fix: {
          say: `\`${env.program.name} onboard --add-push-gate\`, which adds tmb's one line to each such hook`,
          ask: `Add tmb's one line to ${foreign.map((hook) => hook.file).join(", ")}, so every push there asks tmb first?`,
          apply: () => foreign.map((hook) => addToForeignHook(hook, program, projectDir)).join(" "),
        },
      }),
    );
  }
  findings.push(
    gate.length === 0
      ? finding("host files", { status: "ok", summary: foreign.length === 0 ? "git's pre-push hook runs the push gate" : "every pre-push hook tmb wrote runs the push gate" })
      : finding("host files", { status: "warn", summary: "git's pre-push hook does not run the push gate everywhere it should", details: gate, fix: { say: `\`${init}\`` } }),
  );
  return findings;
}

function programTieCheck(env: DoctorEnv, projectDir: string, store: Store): Finding[] {
  const tie = tiedProgram(store);
  const findings: Finding[] = [];
  if (tie === null) {
    findings.push(finding("program tie", { status: "warn", summary: "the record names no program this project is tied to", fix: { say: `\`${env.program.name} init\`` } }));
  } else if (tie.program !== env.program.name) {
    findings.push(finding("program tie", {
      status: "warn",
      summary: `this project is tied to ${tie.program} ${tie.version}, not to ${env.program.name}; its hooks and tools run ${tie.program}`,
      fix: { say: `run \`${tie.program} doctor\` here, or \`${env.program.name} init\` to move the project to ${env.program.name}` },
    }));
  } else {
    findings.push(finding("program tie", { status: "ok", summary: `tied to ${tie.program} ${tie.version}` }));
  }
  const root = path.resolve(projectDir);
  const pinned = sessionEntries(env.stateDir).filter((entry) => path.resolve(entry.project) === root && entry.build !== null && entry.build !== env.version && env.isRunning(entry.pid));
  for (const entry of pinned) {
    findings.push(finding("program tie", { status: "ok", summary: `a running session (process ${entry.pid}) keeps this project on ${env.program.name} ${entry.build} until it restarts` }));
  }
  return findings;
}

const SETTING_LABELS: Record<string, string> = { base_branch: "base branch", checks: "checks", review_mode: "review mode" };

function settingsCheck(env: DoctorEnv, settings: Settings): Finding[] {
  const empty = emptySettings(settings);
  const onboard = { say: `\`${env.program.name} onboard\`` };
  const findings: Finding[] = [];
  const others = empty.filter((name) => name !== "review_mode");
  if (others.length > 0) findings.push(finding("settings", { status: "warn", summary: `not set yet: ${others.map((name) => SETTING_LABELS[name] ?? name).join(", ")}`, fix: onboard }));
  if (empty.includes("review_mode")) findings.push(finding("settings", { status: "warn", summary: "the review mode is not chosen, so no task starts", fix: onboard }));
  if (findings.length === 0) findings.push(finding("settings", { status: "ok", summary: "every setting is set, the review mode included" }));
  return findings;
}

/** Runs, check runs and open tasks with a start and no end: what may be stuck. */
export function unfinishedWork(store: Store): string[] {
  const withRuns = store.tasksWithRuns();
  const lines = [
    ...store.unendedRuns().map((run) => `run ${run.id} (${run.role}${run.taskId === null ? "" : `, task ${run.taskId}`}) started ${run.startedAt} and has no end`),
    ...store.unendedCheckRuns().map((check) => `check run ${check.id} (task ${check.taskId}) started ${check.startedAt} and has no end`),
    ...store.listTasks("open").filter((task) => !withRuns.has(task.id)).map((task) => `task ${task.id} "${task.title}" is open and no agent run is on it`),
  ];
  return lines;
}

function unfinishedCheck(store: Store): Finding {
  const lines = unfinishedWork(store);
  if (lines.length === 0) return finding("unfinished work", { status: "ok", summary: "every run has an end, and every open task has a run" });
  return finding("unfinished work", {
    status: "warn",
    summary: `${lines.length} run${lines.length === 1 ? " or task has" : "s or tasks have"} a start and no end: still running, or stuck`,
    details: lines,
    fix: { say: "shown only: the planner decides whether to resume, close or leave each" },
  });
}

function checkoutChecks(env: DoctorEnv, projectDir: string, store: Store): Finding[] {
  const byRepo = new Map<string | null, Task[]>();
  for (const task of [...store.listTasks("closed"), ...store.listTasks("dropped")]) byRepo.set(task.repo, [...(byRepo.get(task.repo) ?? []), task]);
  const findings: Finding[] = [];
  for (const [repo, tasks] of byRepo) {
    const repoDir = repoDirOf(projectDir, repo);
    for (const kept of keptCheckouts(repoDir, tasks)) {
      const what = [kept.listed ? `the worktree ${kept.worktree}` : null, kept.branch === null ? null : `the branch ${kept.branch}`].filter((part) => part !== null).join(" and ");
      findings.push(finding("closed tasks", {
        status: "warn",
        summary: `task ${kept.task.id} is ${kept.task.state} and ${what} ${kept.listed && kept.branch !== null ? "are" : "is"} still on disk`,
        fix: {
          say: `remove ${kept.listed && kept.branch !== null ? "them" : "it"} with \`${env.program.name} doctor --fix\`; tmb keeps a worktree with work nobody committed`,
          ask: `Remove ${what} of ${kept.task.state} task ${kept.task.id}?`,
          apply: () => {
            const cleanup = removeTaskCheckout(repoDir, kept.worktree, kept.branch);
            const done = cleanup.problems.length === 0 ? `Removed ${what}.` : `Kept: ${cleanup.problems.join("; ")}.`;
            return [done, ...cleanup.dropped].join(" ");
          },
        },
      }));
    }
  }
  if (findings.length === 0) findings.push(finding("closed tasks", { status: "ok", summary: "no closed or dropped task left a worktree or a branch on disk" }));
  return findings;
}

function graphChecks(env: DoctorEnv, projectDir: string, settings: Settings): Finding[] {
  const index = { say: `\`${env.program.name} index\`` };
  const repos: { name: string | null; dir: string; base: string | null }[] =
    settings.repos === null
      ? [{ name: null, dir: projectDir, base: settings.base_branch ?? detectBaseBranch(projectDir) }]
      : workingRepos(settings.repos).map((name) => ({ name, dir: repoDirOf(projectDir, name), base: settings.repos![name]!.base_branch ?? null }));
  return repos.map(({ name, dir, base }) => {
    const label = name === null ? "the code graph" : `the code graph of ${name}`;
    if (base === null) return finding("code graph", { status: "ok", summary: `${label}: no base branch to build from` });
    const file = graphDbPath(projectDir, name);
    if (!existsSync(file)) return finding("code graph", { status: "warn", summary: `${label} is not indexed yet`, fix: index });
    const db = new Database(file, { readonly: true });
    try {
      const layer = db.query("SELECT commit_sha, extractor, files FROM layers WHERE layer = ?").get(BASE_LAYER) as { commit_sha: string; extractor: number; files: number } | null;
      if (layer === null) return finding("code graph", { status: "warn", summary: `${label} is not indexed yet`, fix: index });
      const head = baseCommit(dir, base);
      const unparsed = (db.query("SELECT path FROM files WHERE layer = ? AND parse_error IS NOT NULL ORDER BY path").all(BASE_LAYER) as { path: string }[]).map((row) => row.path);
      const problems: string[] = [];
      if (head !== null && head !== layer.commit_sha) problems.push(`behind ${base}: indexed at ${layer.commit_sha.slice(0, 12)}, ${base} is at ${head.slice(0, 12)}`);
      if (layer.extractor < EXTRACTOR_VERSION) problems.push("built by an older indexer");
      if (unparsed.length > 0) problems.push(`${unparsed.length} file${unparsed.length === 1 ? "" : "s"} not parsed`);
      if (problems.length === 0) return finding("code graph", { status: "ok", summary: `${label} is current with ${base}: ${layer.files} files` });
      return finding("code graph", { status: "warn", summary: `${label}: ${problems.join("; ")}`, details: unparsed.slice(0, 20), fix: index });
    } finally {
      db.close();
    }
  });
}

function ghCheck(env: DoctorEnv): Finding {
  const gh = env.gh();
  if (!gh.installed) return finding("gh", { status: "warn", summary: "GitHub's CLI, gh, is not installed: tmb needs it for pull requests and to file feedback", fix: { say: "install it from https://cli.github.com, then `gh auth login`" } });
  if (!gh.signedIn) return finding("gh", { status: "warn", summary: "gh is installed and not signed in to github.com", fix: { say: "`gh auth login`" } });
  return finding("gh", { status: "ok", summary: "gh is installed and signed in to github.com" });
}

const SKIPPED_DIRS = new Set(["node_modules", ".git", PROJECT_DIR_NAME]);
const BELOW_DEPTH = 3;

/** Every other record above the project or below it, to a few levels down. */
export function otherRecords(projectDir: string): { above: string[]; below: string[] } {
  const above: string[] = [];
  for (let dir = path.dirname(projectDir); ; dir = path.dirname(dir)) {
    if (holdsRecord(dir)) above.push(dir);
    if (path.dirname(dir) === dir) break;
  }
  const below: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > BELOW_DEPTH) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || SKIPPED_DIRS.has(entry.name)) continue;
      const child = path.join(dir, entry.name);
      if (holdsRecord(child)) below.push(child);
      walk(child, depth + 1);
    }
  };
  walk(projectDir, 1);
  return { above, below };
}

function otherRecordsCheck(projectDir: string): Finding {
  const { above, below } = otherRecords(projectDir);
  if (above.length + below.length === 0) return finding("other records", { status: "ok", summary: "no other tmb record above or below this project" });
  return finding("other records", {
    status: "warn",
    summary: `${above.length + below.length} other tmb record${above.length + below.length === 1 ? "" : "s"} near this project: a session started in one of those folders uses that record, not this one`,
    details: [...above.map((dir) => `above: ${dir}`), ...below.map((dir) => `below: ${dir}`)],
    fix: { say: "shown only: remove a record you no longer use, or start sessions in the folder whose record you mean" },
  });
}

/** Runs one check; a check that throws becomes a failure that looks like tmb's own bug. */
export function guarded(check: string, scope: Finding["scope"], run: () => Finding | Finding[]): Finding[] {
  try {
    const result = run();
    return Array.isArray(result) ? result : [result];
  } catch (error) {
    return [{ check, scope, status: "fail", summary: `the check itself failed: ${oneLine(error)}`, bug: true, fix: { say: "this looks like tmb's own bug: `tmb feedback` drafts a report" } }];
  }
}

/** The project's checks, in the order they print; `skip` names checks to leave out. */
export function projectFindings(env: DoctorEnv, skip: ReadonlySet<string> = new Set()): Finding[] {
  const start = path.resolve(env.cwd);
  const projectDir = projectRootOf(start);
  if (!holdsRecord(projectDir)) {
    return [finding("record", { status: "ok", summary: `no tmb record in ${start} or above it: the project's checks are skipped`, fix: { say: `\`${env.program.name} init\` sets one up` } })];
  }
  const findings: Finding[] = [];
  const add = (check: string, run: () => Finding | Finding[]) => {
    if (!skip.has(check)) findings.push(...guarded(check, "project", run));
  };
  let state: RecordState = { store: null, why: "the record check failed" };
  findings.push(
    ...guarded("record", "project", () => {
      const result = recordCheck(env, projectDir);
      state = result.state;
      return result.finding;
    }),
  );
  try {
    const current = state as RecordState;
    if (current.store !== null) {
      const { store, settings } = current;
      add("host files", () => hostFilesChecks(env, projectDir, { store, settings }));
      add("program tie", () => programTieCheck(env, projectDir, store));
      add("settings", () => settingsCheck(env, settings));
      add("unfinished work", () => unfinishedCheck(store));
      add("closed tasks", () => checkoutChecks(env, projectDir, store));
      add("code graph", () => graphChecks(env, projectDir, settings));
    } else {
      findings.push(finding("record checks", { status: "ok", summary: `the checks that read the record are skipped: ${current.why}` }));
    }
  } finally {
    (state as RecordState).store?.close();
  }
  add("gh", () => ghCheck(env));
  add("other records", () => otherRecordsCheck(projectDir));
  return findings;
}
