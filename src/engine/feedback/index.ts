// The feedback program (trustmybot/tmb#122): a bug report about tmb itself, drafted by the
// Human with `tmb feedback` or by the planner when tmb breaks, shown whole, and sent only after
// the Human's yes to that draft. Nothing is ever sent by itself.
//   Two routes: with GitHub's CLI signed in, tmb files the issue on the tmb repo from the user's
//   account; otherwise it opens the repo's bug form filled in, and the user submits it there.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir, platform, release } from "node:os";
import path from "node:path";
import { type Channel, channelOf, type Program } from "../../program.ts";
import { type Actor, type Store } from "../store/index.ts";
import { type BugForm, FEEDBACK_REPO, type FeedbackRepo, fetchBugForm, type KnownField, readBugForm } from "./form.ts";
import { type CleanPaths, formLink, issueBody, type ReportFacts, type ReportInput, reportTitle, reportValues } from "./report.ts";
import { feedbackStatus, type FeedbackStatus } from "./setting.ts";

export * from "./form.ts";
export * from "./report.ts";
export * from "./setting.ts";

/** The GitHub calls a report needs, through the user's own `gh`. */
export type FeedbackGithub = {
  /** Whether `gh` is installed and signed in to github.com. */
  signedIn(): boolean;
  /** Files the issue and returns its link; throws with GitHub's answer when it cannot. */
  createIssue(repo: FeedbackRepo, title: string, body: string): string;
};

/** Everything the feedback program needs from the program that runs it; tests give their own. */
export type FeedbackEnv = {
  /** The program's machine-wide state folder, where the setting and the drafts are kept. */
  stateDir: string;
  program: Program;
  version: string;
  /** What `tmb --version` prints. */
  versionLine: string;
  /** The environment, for the two off switches. */
  env: Record<string, string | undefined>;
  /** The home folder, which a report names `~`. */
  home: string;
  /** Each host with its version, as `<host> 2.1.0`. */
  hosts: () => string[];
  /** The OS, its release and its architecture. */
  os: () => string;
  github: FeedbackGithub;
  /** The bug form's text on the repo's default branch. */
  fetchForm: () => Promise<string>;
  /** Opens a link in the browser; false when there is none to open it in. */
  openUrl: (url: string) => boolean;
  repo: FeedbackRepo;
  now: () => Date;
};

export function channelFor(env: Pick<FeedbackEnv, "program" | "version">): Channel {
  return env.program.channel ?? channelOf(env.version);
}

export function statusOf(env: FeedbackEnv): FeedbackStatus {
  return feedbackStatus(env.stateDir, channelFor(env), env.env);
}

const GH_TIMEOUT_MS = 30_000;

/** The real GitHub calls, through `gh`, which holds the login. */
export const GH_FEEDBACK_GITHUB: FeedbackGithub = {
  signedIn() {
    const result = spawnSync("gh", ["auth", "status", "--hostname", "github.com"], {
      encoding: "utf8",
      timeout: GH_TIMEOUT_MS,
      env: { ...process.env, GH_PROMPT_DISABLED: "1" },
    });
    return result.error === undefined && result.status === 0;
  },
  createIssue(repo, title, body) {
    const result = spawnSync(
      "gh",
      ["api", "--hostname", "github.com", "--method", "POST", `repos/${repo.owner}/${repo.name}/issues`, "-f", `title=${title}`, "-f", `body=${body}`],
      { encoding: "utf8", timeout: GH_TIMEOUT_MS, env: { ...process.env, GH_PROMPT_DISABLED: "1" } },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${result.stderr ?? ""} ${result.stdout ?? ""}`.replace(/\s+/g, " ").trim() || `gh exited ${result.status}`);
    const url = (JSON.parse(result.stdout) as { html_url?: unknown }).html_url;
    if (typeof url !== "string") throw new Error("GitHub's answer named no issue link");
    return url;
  },
};

/** Opens a link with the system's opener; false on a machine with no browser to open it in. */
export function openInBrowser(url: string, os: string = process.platform, env: NodeJS.ProcessEnv = process.env): boolean {
  const command =
    os === "darwin"
      ? ["open", url]
      : os === "win32"
        ? ["rundll32", "url.dll,FileProtocolHandler", url]
        : env.DISPLAY || env.WAYLAND_DISPLAY
          ? ["xdg-open", url]
          : null;
  if (command === null) return false;
  const result = spawnSync(command[0]!, command.slice(1), { stdio: "ignore", timeout: 10_000 });
  return result.error === undefined && result.status === 0;
}

/** A repo named in TMB_FEEDBACK_REPO as owner/name, to try the routes on a fork; the tmb repo otherwise. */
export function feedbackRepoFrom(env: Record<string, string | undefined>): FeedbackRepo {
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(env.TMB_FEEDBACK_REPO?.trim() ?? "");
  return match ? { owner: match[1]!, name: match[2]! } : FEEDBACK_REPO;
}

/** The feedback environment of the program that runs. */
export function feedbackEnv(options: { stateDir: string; program: Program; version: string; versionLine: string; hosts?: () => string[] }): FeedbackEnv {
  const repo = feedbackRepoFrom(process.env);
  return {
    stateDir: options.stateDir,
    program: options.program,
    version: options.version,
    versionLine: options.versionLine,
    env: process.env,
    home: process.env.HOME || process.env.USERPROFILE || homedir(),
    hosts: options.hosts ?? (() => []),
    os: () => `${platform()} ${release()} (${process.arch})`,
    github: GH_FEEDBACK_GITHUB,
    fetchForm: () => fetchBugForm(repo),
    openUrl: (url) => openInBrowser(url),
    repo,
    now: () => new Date(),
  };
}

// --- drafts ---------------------------------------------------------------------------

/** A drafted report, kept as it was shown, so what is sent is exactly what the Human read. */
export type Draft = {
  id: string;
  createdAt: string;
  title: string;
  /** The issue body for the CLI route, in the form's headings: the report as the Human reads it. */
  body: string;
  /** The values tmb filled in, cleaned, for the form link: only the fields the form has. */
  values: Partial<Record<KnownField, string>>;
  form: { file: string; source: BugForm["source"]; fallbackReason: string | null };
  /** Set once the report is out: the issue's link, or the form that was opened. */
  sent: { at: string; route: "issue"; url: string } | { at: string; route: "form"; url: string } | null;
};

const ID_PATTERN = /^\d{8}-\d{6}-[0-9a-f]{6}$/;

function draftsDir(stateDir: string): string {
  return path.join(stateDir, "feedback");
}

/** The file that holds a draft's report, for the Human to read and, for a long one, to attach. */
export function draftReportFile(stateDir: string, id: string): string {
  return path.join(draftsDir(stateDir), `${id}.md`);
}

function draftFile(stateDir: string, id: string): string {
  return path.join(draftsDir(stateDir), `${id}.json`);
}

function newDraftId(now: Date): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  return `${stamp}-${randomBytes(3).toString("hex")}`;
}

function writeAtomic(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, text);
  renameSync(temp, file);
}

function saveDraft(stateDir: string, draft: Draft): void {
  writeAtomic(draftFile(stateDir, draft.id), JSON.stringify(draft, null, 2) + "\n");
}

export function readDraft(stateDir: string, id: string): Draft | null {
  if (!ID_PATTERN.test(id)) return null;
  try {
    return JSON.parse(readFileSync(draftFile(stateDir, id), "utf8")) as Draft;
  } catch {
    return null;
  }
}

/** The kinds of the newest events in the record, oldest first; never their content. */
export const RECENT_EVENT_KINDS = 10;

/** What the report says about where tmb ran. */
export function reportFacts(env: FeedbackEnv, store: Store | null): ReportFacts {
  let hosts: string[] = [];
  try {
    hosts = env.hosts();
  } catch {
    // A host that cannot say its version is left out; the report says what is known.
  }
  return { versionLine: env.versionLine, os: env.os(), hosts, eventKinds: store === null ? [] : store.recentEventKinds(RECENT_EVENT_KINDS) };
}

/**
 * Drafts a report: reads the form, fills in what tmb knows, cleans it, and keeps it as a file
 * the Human can read. Sends nothing.
 */
export async function draftReport(env: FeedbackEnv, input: ReportInput, context: { store: Store | null; projectDir: string | null }): Promise<Draft & { file: string }> {
  // What the record says is read before the form's download, while the caller's record is surely open.
  const facts = reportFacts(env, context.store);
  const form = await readBugForm(env.fetchForm);
  const paths: CleanPaths = { home: env.home, project: context.projectDir };
  const all = reportValues(input, facts, paths);
  // A field the form no longer has is not sent.
  const values = Object.fromEntries(form.fields.filter((field) => Object.hasOwn(all, field.id)).map((field) => [field.id, all[field.id as KnownField]]));
  const now = env.now();
  const draft: Draft = {
    id: newDraftId(now),
    createdAt: now.toISOString(),
    title: reportTitle(form, all),
    body: issueBody(form, values),
    values,
    form: { file: form.file, source: form.source, fallbackReason: form.fallbackReason },
    sent: null,
  };
  saveDraft(env.stateDir, draft);
  const file = draftReportFile(env.stateDir, draft.id);
  writeAtomic(file, `# ${draft.title}\n\n${draft.body}`);
  return { ...draft, file };
}

/** The draft as the Human reads it before saying yes or no. */
export function draftText(draft: Draft): string {
  return `Title: ${draft.title}\n\n${draft.body.trimEnd()}`;
}

/** Where a report goes, and how it gets there. */
export function routeLine(env: FeedbackEnv): { route: "issue" | "form"; line: string } {
  const repo = `${env.repo.owner}/${env.repo.name}`;
  return env.github.signedIn()
    ? { route: "issue", line: `It becomes a public issue on ${repo}, filed from your GitHub account by the GitHub CLI.` }
    : { route: "form", line: `It opens ${repo}'s bug form on GitHub, filled in; it becomes a public issue when you submit it there.` };
}

export type SendResult =
  | { route: "issue"; url: string }
  | { route: "form"; url: string; opened: boolean; shortened: boolean; file: string };

/**
 * Sends a draft the Human said yes to: files the issue when `gh` is signed in, else opens the
 * filled-in form. Keeps it in the record when there is one. For an opened form tmb cannot know
 * whether the user pressed submit, so the record says opened, not sent.
 */
export function sendDraft(env: FeedbackEnv, draft: Draft, record: { store: Store; actor: Actor } | null): SendResult {
  if (draft.sent !== null) throw new Error(`report ${draft.id} was already ${draft.sent.route === "issue" ? `filed: ${draft.sent.url}` : "opened as a form"}`);
  const at = env.now().toISOString();
  let result: SendResult;
  if (env.github.signedIn()) {
    const url = env.github.createIssue(env.repo, draft.title, draft.body);
    result = { route: "issue", url };
    draft.sent = { at, route: "issue", url };
  } else {
    const file = draftReportFile(env.stateDir, draft.id);
    const shownFile = file.startsWith(env.home) ? `~${file.slice(env.home.replace(/[\\/]+$/, "").length)}` : file;
    const link = formLink(env.repo, draft.form.file, draft.title, draft.values, shownFile);
    const opened = env.openUrl(link.url);
    result = { route: "form", url: link.url, opened, shortened: link.shortened, file };
    draft.sent = { at, route: "form", url: link.url };
  }
  saveDraft(env.stateDir, draft);
  if (record !== null) {
    // A filed report keeps its link; for an opened form tmb cannot know whether it was sent (trustmybot/tmb#408).
    record.store.recordFeedbackReport(record.actor, {
      route: result.route,
      url: result.route === "issue" ? result.url : null,
      detail: result.route === "issue" ? { title: draft.title } : { title: draft.title, opened: result.opened },
    });
  }
  return result;
}

// --- the last error -------------------------------------------------------------------

/** The last error a tmb command gave on this machine, kept so `tmb feedback` can report it. */
export type LastError = { at: string; command: string; message: string; stack: string | null };

/** A last error older than this is not put in a report: it is likely not what the person means. */
export const LAST_ERROR_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function lastErrorFile(stateDir: string): string {
  return path.join(draftsDir(stateDir), "last-error.json");
}

/** Keeps the error a command failed with; best effort, as it must never hide the error itself. */
export function keepLastError(stateDir: string, error: LastError): void {
  try {
    writeAtomic(lastErrorFile(stateDir), JSON.stringify(error, null, 2) + "\n");
  } catch {
    // A state folder that cannot be written loses only this note.
  }
}

/** The last error, when it is recent; null otherwise. */
export function recentLastError(stateDir: string, now: Date): LastError | null {
  try {
    const error = JSON.parse(readFileSync(lastErrorFile(stateDir), "utf8")) as LastError;
    const age = now.getTime() - Date.parse(error.at);
    return Number.isFinite(age) && age >= 0 && age <= LAST_ERROR_MAX_AGE_MS ? error : null;
  } catch {
    return null;
  }
}
