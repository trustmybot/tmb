// The review of a whole feature branch in agile mode. The reviewer judges the branch at its tip
// and records a pass or a fail on that exact commit; the Human may waive the review instead, also
// on that commit. Only then does the engine push the branch and open its one pull request into
// the base branch. The push gate reads the same coverage, so a commit no pass or waiver covers
// never reaches the base branch by a push either.
import { runningName } from "../program.ts";
import { spawnSync } from "node:child_process";
import { runGit } from "../git.ts";
import { endHostReviewerRun, ensureHostReviewerRun, FINISHED, isReviewerHost, openRunsOf } from "../host-runs.ts";
import type { Actor, Feature, Review, Store } from "../store/index.ts";
import { CLOSED_UNMERGED, endReadyLine, type LocalMerge, localMergeCommand, OPEN, type OperationContext, PR_OPEN, READY, requireRole } from "./common.ts";
import { HandlerError } from "./errors.ts";
import { featureDir, featureTip, knownBase } from "./features.ts";
import { hasOrigin, isAncestor, pushFeature } from "./fold.ts";
import { markRequiredOn, type MarkResult, markReviewed, trySendPendingMarks } from "./marks.ts";
import { truestCoveredCommits } from "./truest.ts";
import { type InputSchema, NOT_BLANK, validateInput } from "./input.ts";

export const VERDICTS = ["pass", "fail"] as const;
export type Verdict = (typeof VERDICTS)[number];

/** The state of a feature branch once the engine has opened its pull request. */
export { PR_OPEN };
/** What an audit entry of a Human waiver is about. */

const PR_TIMEOUT_MS = 120_000;

export type Finding = { text: string; blocking: boolean };

export type ReviewSummary = {
  id: string;
  verdict: string;
  commit: string | null;
  findings: Finding[];
  by: Actor;
  at: string;
};

export type Waiver = { id: string; feature: string; commit: string; reason: string; at: string };

/** One task's commits on the feature branch, the group a reviewer judges it in. */
export type ReviewGroup = { task: string; title: string; kind: string | null; from: string; to: string };

export type FeatureBrief = {
  name: string;
  state: string;
  /** The repo it was cut in, by its name in the workspace; null in a single-repo project. */
  repo: string | null;
  baseBranch: string;
  baseCommit: string;
  /** Where the feature branch leaves the base branch: the diff to review is from here to the tip. */
  mergeBase: string;
  tip: string;
  /** The base branch's commit as tmb last fetched it (the local one when that is ahead), and whether the tip holds it; feature_update brings it in. */
  base: string | null;
  holdsBase: boolean;
  /** Each closed task's commits on the branch, in the order they landed. */
  groups: ReviewGroup[];
  reviews: ReviewSummary[];
  waivers: Waiver[];
  /** Whether a pass or a waiver covers the tip, so the pull request may open. */
  covered: boolean;
  coveredBy: "review" | "waiver" | null;
  prUrl: string | null;
  /** The line a reviewer's start prompt carries. */
  reviewLine: string;
};

export type ReviewRecordResult = { review: ReviewSummary; feature: string; covered: boolean; next: string; mark: MarkResult };
/** A waiver as feature_waive records it, with what became of its mark on GitHub. */
export type WaiveResult = Waiver & { mark: MarkResult };
export type FeaturePrResult = {
  feature: string;
  /** The pull request's address; null in a repo with no remote, where none opens. */
  url: string | null;
  /** Set in a repo with no remote: the branch is ready, and the Human merges it locally with these commands, in `dir`. */
  localMerge: LocalMerge | null;
  base: string;
  tip: string;
  coveredBy: "review" | "waiver";
  push: string;
  /** Whether the base branch's protection requires the mark; null when not known or origin is no GitHub repository. */
  markRequired: boolean | null;
};

/** The line that names a feature branch to the reviewer. */
export function reviewLine(name: string): string {
  return `feature=${name}`;
}

function requireFeature(store: Store, name: string): Feature {
  const feature = store.findFeature(name);
  if (!feature) {
    const names = store.listFeatures().map((each) => each.name);
    throw new HandlerError("not_found", `no feature branch ${name} in the record${names.length === 0 ? "" : `; it holds ${names.join(", ")}`}`);
  }
  return feature;
}

/** A feature branch that takes work: open, or with its pull request open, where fix tasks land (trustmybot/tmb#168). */
function requireOpenFeature(store: Store, name: string, doing: string): Feature {
  const feature = requireFeature(store, name);
  if (feature.state !== OPEN && feature.state !== PR_OPEN && feature.state !== READY) throw new HandlerError("refused", `the feature branch ${name} is ${feature.state}, so ${doing}`);
  return feature;
}

function findingsOf(review: Review): Finding[] {
  return review.findings.filter((item): item is Finding => typeof item === "object" && item !== null && typeof (item as Finding).text === "string");
}

export function summaryOf(review: Review): ReviewSummary {
  return { id: review.id, verdict: review.verdict, commit: review.commitSha, findings: findingsOf(review), by: review.createdBy, at: review.createdAt };
}

/** Every Human waiver of a feature branch's review, oldest first, with the feature branch id it names. */
function allWaivers(store: Store): (Waiver & { featureId: string })[] {
  const names = new Map(store.listFeatures().map((feature) => [feature.id, feature.name]));
  return store
    .listWaivers()
    .filter((waiver) => waiver.featureId !== null)
    .map((waiver) => ({
      id: waiver.id,
      featureId: waiver.featureId!,
      feature: names.get(waiver.featureId!) ?? waiver.featureId!,
      commit: waiver.commitSha,
      reason: waiver.reason,
      at: waiver.createdAt,
    }));
}

/**
 * Whether the record lets `commit` of a feature branch through: the newest review on that exact
 * commit is a pass, or the Human waived the review on it. A waiver is the Human's call, so a
 * fail does not undo it.
 */
function coverageAt(reviews: readonly Review[], waivers: readonly { commit: string }[], commit: string): "review" | "waiver" | null {
  if (waivers.some((waiver) => waiver.commit === commit)) return "waiver";
  const newest = reviews.filter((review) => review.commitSha === commit).at(-1);
  return newest?.verdict === "pass" ? "review" : null;
}

/** Every commit the record lets through the push gate: each feature branch commit a pass or a waiver covers, and each truest task commit one covers. */
export function coveredCommits(store: Store): string[] {
  const waivers = allWaivers(store);
  const commits = new Set([...waivers.map((waiver) => waiver.commit), ...truestCoveredCommits(store)]);
  const byFeature = new Map<string, Review[]>();
  for (const review of store.listReviews()) {
    if (review.featureId === null || review.commitSha === null) continue;
    byFeature.set(review.featureId, [...(byFeature.get(review.featureId) ?? []), review]);
  }
  for (const reviews of byFeature.values()) {
    for (const commit of new Set(reviews.map((review) => review.commitSha!))) {
      if (coverageAt(reviews, [], commit) === "review") commits.add(commit);
    }
  }
  return [...commits];
}

/**
 * Each closed task's commits on the branch, in the order they landed: along the branch's own line
 * of commits from where it leaves the base branch. A merge of the base branch starts the next
 * group after it, so no group shows the base's changes as the task's.
 */
function groupsOf(store: Store, projectDir: string, feature: Feature, mergeBase: string, tip: string): ReviewGroup[] {
  const listed = runGit(projectDir, ["rev-list", "--reverse", "--first-parent", "--parents", `${mergeBase}..${tip}`]);
  const lines = listed.ok ? listed.stdout.split("\n").filter((line) => line !== "").map((line) => line.split(" ")) : [];
  const tasks = new Map(
    store
      .listFeatureTasks(feature.id)
      .filter((task) => task.commitSha !== null)
      .map((task) => [task.commitSha!, task]),
  );
  let from = lines[0]?.[1] ?? mergeBase;
  const groups: ReviewGroup[] = [];
  for (const [sha, ...parents] of lines) {
    const task = tasks.get(sha!);
    if (task !== undefined) {
      groups.push({ task: task.id, title: task.title, kind: task.kind, from, to: sha! });
      from = sha!;
    } else if (parents.length > 1) {
      // A merge of the base branch: what came in with it is the base's, not the next task's.
      from = sha!;
    }
  }
  return groups;
}

/**
 * Where the branch leaves the base branch on origin, so a commit made on the local base branch
 * and never pushed is part of the diff the reviewer sees; the local base branch when there is no origin copy.
 */
function mergeBaseOf(projectDir: string, feature: Feature, tip: string): string {
  const remoteBase = `refs/remotes/origin/${feature.baseBranch}`;
  const onOrigin = runGit(projectDir, ["rev-parse", "--verify", "--quiet", remoteBase]).ok;
  const merged = runGit(projectDir, ["merge-base", onOrigin ? remoteBase : feature.baseBranch, tip]);
  return merged.ok ? merged.stdout : feature.baseCommit;
}

/** The brief of a feature branch; `projectDir` is the project's folder, and git runs in the feature's repo. */
export function featureBriefOf(store: Store, projectDir: string, feature: Feature): FeatureBrief {
  const dir = featureDir(store, projectDir, feature);
  const tip = featureTip(dir, feature);
  const reviews = store.listFeatureReviews(feature.id);
  const waivers = allWaivers(store).filter((waiver) => waiver.featureId === feature.id);
  const mergeBase = mergeBaseOf(dir, feature, tip);
  let base: string | null = null;
  try {
    base = knownBase(dir, feature.baseBranch, `the feature branch ${feature.name}`);
  } catch {
    // A base branch git cannot read leaves the brief without it.
  }
  const coveredBy = coverageAt(reviews, waivers, tip);
  return {
    name: feature.name,
    state: feature.state,
    repo: feature.repo,
    baseBranch: feature.baseBranch,
    baseCommit: feature.baseCommit,
    mergeBase,
    tip,
    base,
    holdsBase: base !== null && isAncestor(dir, base, tip),
    groups: groupsOf(store, dir, feature, mergeBase, tip),
    reviews: reviews.map(summaryOf),
    waivers: waivers.map(({ featureId: _, ...waiver }) => waiver),
    covered: coveredBy !== null,
    coveredBy,
    prUrl: feature.prUrl,
    reviewLine: reviewLine(feature.name),
  };
}

const FEATURE_FIELD = { type: "string", description: "The feature branch's name, as feature_list shows it.", pattern: NOT_BLANK } as const;

// --- feature_brief ------------------------------------------------------------------------

export const featureBriefSchema: InputSchema = {
  type: "object",
  properties: { feature: FEATURE_FIELD },
  required: ["feature"],
  additionalProperties: false,
};

export function featureBrief(store: Store, actor: Actor, input: unknown, context: OperationContext): FeatureBrief {
  const { feature } = validateInput<{ feature: string }>("feature_brief", featureBriefSchema, input);
  const brief = featureBriefOf(store, context.projectDir, requireFeature(store, feature));
  // A reviewer host that already gave a verdict in this session reviews again in a new run.
  if (actor.kind === "agent" && actor.role === "reviewer") ensureHostReviewerRun(store, actor.host);
  return brief;
}

// --- review_record ------------------------------------------------------------------------

const FINDING_ITEM = { type: "string", pattern: NOT_BLANK } as const;

export const reviewRecordSchema: InputSchema = {
  type: "object",
  properties: {
    feature: FEATURE_FIELD,
    commit: {
      type: "string",
      description: "The commit you reviewed the branch at: the tip feature_brief showed. A review counts only for that commit.",
      pattern: "^[0-9a-fA-F]{7,64}$",
    },
    verdict: { type: "string", description: "pass when no finding blocks, fail when one does.", enum: VERDICTS },
    blocking: {
      type: "array",
      description: "Each blocking finding: file and line, the concrete failure scenario, and the task it belongs to. A fail names at least one; a pass names none.",
      items: FINDING_ITEM,
    },
    notes: {
      type: "array",
      description: "Each finding that does not block, or that was already on the base, in the same form.",
      items: FINDING_ITEM,
    },
  },
  required: ["feature", "commit", "verdict"],
  additionalProperties: false,
};

type ReviewRecordInput = { feature: string; commit: string; verdict: Verdict; blocking?: string[]; notes?: string[] };

export function reviewRecord(store: Store, actor: Actor, input: unknown, context: OperationContext): ReviewRecordResult {
  const given = validateInput<ReviewRecordInput>("review_record", reviewRecordSchema, input);
  if (actor.kind === "human") {
    throw new HandlerError("refused", `only the reviewer records a review; the Human waives one instead, with \`${runningName()} feature waive <name> --reason <text>\``);
  }
  requireRole(actor, "review_record", ["reviewer"]);
  // Only the host whose reviewer is running records a verdict: another host's open run is not this one's.
  if (openRunsOf(store, actor.host).length === 0) {
    throw new HandlerError(
      "refused",
      "no reviewer run is open: a review is recorded only by a reviewer the host started as a subagent, or by a host set up as the reviewer after it read the branch's feature_brief, and tmb records that start",
    );
  }
  const blocking = given.blocking ?? [];
  const notes = given.notes ?? [];
  if (given.verdict === "pass" && blocking.length > 0) throw new HandlerError("invalid_input", "a pass names no blocking finding; with one, the verdict is fail");
  if (given.verdict === "fail" && blocking.length === 0) throw new HandlerError("invalid_input", "a fail names at least one blocking finding");

  const feature = requireOpenFeature(store, given.feature, "it takes no review");
  const dir = featureDir(store, context.projectDir, feature);
  const tip = featureTip(dir, feature);
  const resolved = runGit(dir, ["rev-parse", "--verify", "--quiet", `${given.commit}^{commit}`]);
  if (!resolved.ok || resolved.stdout !== tip) {
    throw new HandlerError(
      "refused",
      `the feature branch ${feature.name} is at ${tip}, not at the commit reviewed (${given.commit}); read feature_brief again and review the branch at its tip`,
    );
  }

  const findings: Finding[] = [...blocking.map((text) => ({ text, blocking: true })), ...notes.map((text) => ({ text, blocking: false }))];
  // The review names the run that wrote it, and that run its feature branch, since a branch review's start prompt may not name it (trustmybot/tmb#135).
  const run = openRunsOf(store, actor.host)[0]!;
  const id = store.transaction(() => {
    const written = store.appendReview(actor, { target: { kind: "branch", ref: feature.name }, verdict: given.verdict, findings, featureId: feature.id, commitSha: tip, runId: run.id });
    if (run.featureId === null && run.taskId === null) store.setRunFeature(actor, run.id, feature.id);
    return written;
  });
  const review = summaryOf(store.listFeatureReviews(feature.id).find((each) => each.id === id)!);
  if (isReviewerHost(store, actor.host)) endHostReviewerRun(store, actor.host, FINISHED);
  const mark = markReviewed(store, actor, dir, { featureId: feature.id }, tip, given.verdict, blocking.length);
  const covered = given.verdict === "pass";
  const next = covered
    ? hasOrigin(dir)
      ? `the pull request may open: the planner calls feature_pr for ${feature.name}`
      : `the repository has no remote, so no pull request opens: the planner calls feature_pr for ${feature.name}, which records it ready for the Human to merge locally`
    : `the planner reworks each blocking finding as a task on ${feature.name}, then starts the reviewer again`;
  return { review, feature: feature.name, covered, next, mark };
}

// --- feature_waive ------------------------------------------------------------------------

export const featureWaiveSchema: InputSchema = {
  type: "object",
  properties: {
    feature: FEATURE_FIELD,
    reason: { type: "string", description: "Why the review is waived, kept in the record.", pattern: NOT_BLANK },
  },
  required: ["feature", "reason"],
  additionalProperties: false,
};

export function featureWaive(store: Store, actor: Actor, input: unknown, context: OperationContext): WaiveResult {
  const given = validateInput<{ feature: string; reason: string }>("feature_waive", featureWaiveSchema, input);
  if (actor.kind !== "human") throw new HandlerError("refused", `only the Human waives a review, from the command line; the ${actor.kind === "agent" ? actor.role : "tmb"} cannot`);
  const feature = requireOpenFeature(store, given.feature, "there is no review to waive");
  const dir = featureDir(store, context.projectDir, feature);
  const commit = featureTip(dir, feature);
  const reason = given.reason.trim();
  const id = store.recordWaiver(actor, { featureId: feature.id, commitSha: commit, reason, detail: { feature: feature.name } });
  const waiver = store.getWaiver(id)!;
  const mark = markReviewed(store, actor, dir, { featureId: feature.id }, commit, "waiver", reason);
  return { id, feature: feature.name, commit, reason, at: waiver.createdAt, mark };
}

// --- feature_pr ---------------------------------------------------------------------------

export const featurePrSchema: InputSchema = {
  type: "object",
  properties: {
    feature: FEATURE_FIELD,
    title: { type: "string", description: "The pull request's title.", pattern: NOT_BLANK },
    body: { type: "string", description: "The pull request's description; tmb adds how the review went." },
  },
  required: ["feature", "title"],
  additionalProperties: false,
};

/** Opens the pull request with the GitHub command line; returns its address or what went wrong. */
export function openPullRequest(projectDir: string, args: readonly string[]): { ok: true; url: string } | { ok: false; why: string } {
  const result = spawnSync("gh", ["pr", "create", ...args], {
    cwd: projectDir,
    encoding: "utf8",
    timeout: PR_TIMEOUT_MS,
    env: { ...process.env, GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0" },
  });
  if (result.error) return { ok: false, why: result.error.message };
  const said = `${result.stderr ?? ""}\n${result.stdout ?? ""}`.replace(/\s+/g, " ").trim();
  if (result.status !== 0) return { ok: false, why: said === "" ? `gh exited ${result.status}` : said };
  const url = (result.stdout ?? "").split("\n").map((line) => line.trim()).filter((line) => /^https?:\/\//.test(line)).at(-1);
  return url === undefined ? { ok: false, why: `gh printed no pull request address: ${said}` } : { ok: true, url };
}

/** The address of the open pull request from `branch`, when one is already open; null when none is or gh cannot say. */
export function existingPullRequest(projectDir: string, branch: string): string | null {
  const result = spawnSync("gh", ["pr", "list", "--head", branch, "--state", "open", "--json", "url", "--jq", ".[0].url"], {
    cwd: projectDir,
    encoding: "utf8",
    timeout: PR_TIMEOUT_MS,
    env: { ...process.env, GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0" },
  });
  if (result.error || result.status !== 0) return null;
  const url = (result.stdout ?? "").trim();
  return /^https?:\/\/\S+$/.test(url) ? url : null;
}

export function featurePr(store: Store, actor: Actor, input: unknown, context: OperationContext): FeaturePrResult {
  const given = validateInput<{ feature: string; title: string; body?: string }>("feature_pr", featurePrSchema, input);
  requireRole(actor, "feature_pr", ["planner"]);
  // A branch whose pull request closed without a merge takes a new one (trustmybot/tmb#152); a merged one is final.
  const feature = requireFeature(store, given.feature);
  // A ready branch (no remote) may ask again: for the merge command, or for a pull request once a remote was added.
  if (feature.state !== OPEN && feature.state !== CLOSED_UNMERGED && feature.state !== PR_OPEN && feature.state !== READY) {
    throw new HandlerError("refused", `the feature branch ${feature.name} is ${feature.state}, so its pull request does not open again`);
  }
  const brief = featureBriefOf(store, context.projectDir, feature);
  if (brief.coveredBy === null) {
    const newest = brief.reviews.at(-1);
    const why =
      newest === undefined
        ? "no reviewer has reviewed it"
        : newest.commit !== brief.tip
          ? `its newest review was at ${newest.commit}, and the branch has moved since`
          : `its newest review at the tip is a ${newest.verdict}`;
    throw new HandlerError(
      "refused",
      `the pull request of ${feature.name} opens only after the reviewer passes the branch at its tip ${brief.tip}, or the Human waives the review: ${why}. Start the reviewer with the ${reviewLine(feature.name)} line in its prompt, or ask the Human to run \`${runningName()} feature waive ${feature.name} --reason <text>\`.`,
    );
  }

  const dir = featureDir(store, context.projectDir, feature);
  if (!hasOrigin(dir)) {
    // No remote (trustmybot/tmb#183): nothing is pushed and no pull request opens; the Human merges locally.
    store.updateFeature(actor, feature.id, { state: READY });
    const localMerge = { dir, command: localMergeCommand(feature.baseBranch, feature.name), otherwise: endReadyLine("feature", feature.name) };
    return { feature: feature.name, url: null, localMerge, base: feature.baseBranch, tip: brief.tip, coveredBy: brief.coveredBy, push: "skipped: the repository has no remote named origin", markRequired: null };
  }
  const push = pushFeature(dir, feature.name, actor);
  if (push.result !== "pushed") throw new HandlerError("refused", `the pull request of ${feature.name} needs the branch on origin, and the push did not happen: ${push.detail}`);
  // The push puts the reviewed commit on GitHub, so a mark GitHub refused before can be sent now.
  trySendPendingMarks(store, actor, dir);
  const how =
    brief.coveredBy === "review"
      ? `Reviewed by the tmb reviewer: pass at ${brief.tip}.`
      : `Review waived by the Human at ${brief.tip}: ${brief.waivers.filter((waiver) => waiver.commit === brief.tip).at(-1)?.reason ?? ""}`;
  const markRequired = markRequiredOn(dir, feature.baseBranch);
  // Its pull request is open: the push of the reviewed tip is what updates it (trustmybot/tmb#168).
  if (feature.state === PR_OPEN && feature.prUrl !== null) {
    return { feature: feature.name, url: feature.prUrl, localMerge: null, base: feature.baseBranch, tip: brief.tip, coveredBy: brief.coveredBy, push: push.detail, markRequired };
  }
  const body = [given.body?.trim() ?? "", how].filter((part) => part !== "").join("\n\n");
  let opened = openPullRequest(dir, ["--base", feature.baseBranch, "--head", feature.name, "--title", given.title, "--body", body]);
  if (!opened.ok) {
    // A pull request already open from the branch (an earlier feature_pr, or one the Human reopened) is the branch's: record it, open no second one.
    const existing = existingPullRequest(dir, feature.name);
    if (existing !== null) opened = { ok: true, url: existing };
  }
  if (!opened.ok) throw new HandlerError("refused", `${feature.name} was pushed to origin, but its pull request did not open: ${opened.why}`);
  store.updateFeature(actor, feature.id, { state: PR_OPEN, prUrl: opened.url });
  return { feature: feature.name, url: opened.url, localMerge: null, base: feature.baseBranch, tip: brief.tip, coveredBy: brief.coveredBy, push: push.detail, markRequired };
}

