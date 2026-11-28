// `tmb feature`: start, update, list, brief, waive, open and drop feature branches.
import { endReadyLine, type FeatureBrief, type FeatureDropResult, type FeaturePrResult, type FeatureSummary, type FeatureUpdateResult, markLine, markRequiredLine, type WaiveResult } from "../../engine/index.ts";
import { only, parseWithJson } from "../arguments.ts";
import { listed, UsageError } from "../command.ts";
import { JSON_NOTE, RecordCommand, type RecordRequest, reviewLines } from "./record.ts";

export class FeatureCommand extends RecordCommand {
  readonly name = "feature";
  readonly summary = "Start and review feature branches";
  readonly listing = listed("Work");
  override readonly actions = ["start", "update", "list", "brief", "waive", "pr", "drop"] as const;

  usage(): string {
    return `  tmb feature start <name> [--repo <name>]
                            Cut a feature branch from the base branch and record it; in a
                            workspace of several repos, --repo names the repo it is cut in
  tmb feature update <name> Bring the base branch into the feature branch with a merge commit,
                            fetched from origin first; a conflict changes nothing and names the files
  tmb feature list          List the feature branches with their base, state and tasks
  tmb feature brief <name>  Show a feature branch's tip, its task groups, reviews and waivers
  tmb feature waive <name> --reason <text>
                            Waive the review of the feature branch at its tip (the Human only, on a terminal)
  tmb feature pr <name> --title <text> [--body <text>]
                            Open the feature branch's pull request into the base branch, once
                            the reviewer passed its tip or the Human waived the review
  tmb feature drop <name> --reason <text>
                            End an open, closed or ready feature branch without a merge, with
                            why; its branch is kept. Refused while its pull request is open
${JSON_NOTE}`;
  }

  protected parse(args: readonly string[]): RecordRequest {
    const [action, ...rest] = args;
    switch (action) {
      case "start": {
        const { values, positionals } = parseWithJson(rest, { repo: { type: "string" } });
        const format = (feature: FeatureSummary) =>
          `Started feature branch ${feature.name}${feature.repo ? ` in ${feature.repo}` : ""} from ${feature.baseBranch} at ${feature.baseCommit}.`;
        const input = { name: only(positionals, "feature branch name"), ...(values.repo === undefined ? {} : { repo: values.repo }) };
        return { operation: "feature_start", input, json: values.json === true, format };
      }
      case "update": {
        const { values, positionals } = parseWithJson(rest, {});
        return { operation: "feature_update", input: { feature: only(positionals, "feature branch name") }, json: values.json === true, format: formatUpdate };
      }
      case "list": {
        const { values, positionals } = parseWithJson(rest, {});
        if (positionals.length > 0) throw new UsageError(`feature list takes no arguments, got ${positionals.join(" ")}`);
        const format = (features: FeatureSummary[]) => (features.length === 0 ? "No feature branches." : features.map(featureLine).join("\n"));
        return { operation: "feature_list", input: {}, json: values.json === true, format };
      }
      case "brief": {
        const { values, positionals } = parseWithJson(rest, {});
        const format = (brief: FeatureBrief) => featureBriefLines(brief).join("\n");
        return { operation: "feature_brief", input: { feature: only(positionals, "feature branch name") }, json: values.json === true, format };
      }
      case "drop": {
        const { values, positionals } = parseWithJson(rest, { reason: { type: "string" } });
        if (values.reason === undefined) throw new UsageError("feature drop needs --reason <text>: why the feature branch is dropped");
        const format = (dropped: FeatureDropResult) =>
          [`Dropped feature branch ${dropped.feature.name}: ${dropped.feature.dropReason}`, ...(dropped.keptBranch === null ? [] : [`Kept: ${dropped.keptBranch}`])].join("\n");
        return { operation: "feature_drop", input: { feature: only(positionals, "feature branch name"), reason: values.reason }, json: values.json === true, format };
      }
      case "waive": {
        const { values, positionals } = parseWithJson(rest, { reason: { type: "string" } });
        if (values.reason === undefined) throw new UsageError("feature waive needs --reason <text>: why the review is waived");
        const format = (waiver: WaiveResult) =>
          [`Waived the review of ${waiver.feature} at ${waiver.commit}; its pull request may open now.`, markLine(waiver.mark)].filter((line) => line !== null).join("\n");
        return { operation: "feature_waive", input: { feature: only(positionals, "feature branch name"), reason: values.reason }, json: values.json === true, format };
      }
      case "pr": {
        const { values, positionals } = parseWithJson(rest, { title: { type: "string" }, body: { type: "string" } });
        if (values.title === undefined) throw new UsageError("feature pr needs --title <text>");
        const input = { feature: only(positionals, "feature branch name"), title: values.title, ...(values.body === undefined ? {} : { body: values.body }) };
        return { operation: "feature_pr", input, json: values.json === true, format: formatPr };
      }
      default:
        throw this.actionError(action);
    }
  }
}

function formatUpdate(update: FeatureUpdateResult): string {
  if (update.how === "none") return `${update.feature} already holds ${update.baseBranch} at ${update.base}; nothing changed.`;
  const how = update.how === "merged" ? `merged into it at ${update.to}` : `fast-forwarded to it`;
  const push = update.push === null ? "" : ` Backup push: ${update.push.result} (${update.push.detail}).`;
  return `Brought ${update.baseBranch} at ${update.base} into ${update.feature}: ${how}.${push}`;
}

function formatPr(pr: FeaturePrResult): string {
  return [
    pr.localMerge === null
      ? `Opened the pull request of ${pr.feature} into ${pr.base} at ${pr.tip} (${pr.coveredBy}): ${pr.url}`
      : `${pr.feature} is ready at ${pr.tip} (${pr.coveredBy}). The repository has no remote, so nothing was pushed and no pull request opened. Merge it locally, in ${pr.localMerge.dir}:\n  ${pr.localMerge.command}\n${pr.localMerge.otherwise}`,
    markRequiredLine(pr.base, pr.markRequired),
  ]
    .filter((line) => line !== null)
    .join("\n");
}

function featureLine(feature: FeatureSummary): string {
  const tasks = feature.tasks.length === 0 ? "no tasks" : `tasks: ${feature.tasks.join(", ")}`;
  const repo = feature.repo ? ` in ${feature.repo}` : "";
  const ended = feature.dropReason === null ? "" : `\n  dropped: ${feature.dropReason}`;
  const ready = feature.state === "ready" ? `\n  ${endReadyLine("feature", feature.name)}` : "";
  return `${feature.name}  ${feature.state.padEnd(6)}${repo}  from ${feature.baseBranch} at ${feature.baseCommit}\n  ${tasks}${ready}${ended}`;
}

function featureBriefLines(brief: FeatureBrief): string[] {
  const cover = brief.coveredBy === null ? "not yet: the reviewer has not passed this tip and no waiver holds it" : `yes, by a ${brief.coveredBy}`;
  return [
    `Feature branch ${brief.name}  ${brief.state}  into ${brief.baseBranch}`,
    `Tip: ${brief.tip}  (review the diff from ${brief.mergeBase})`,
    `Holds the base: ${brief.base === null ? "unknown: git cannot read the base branch" : brief.holdsBase ? `yes, ${brief.baseBranch} at ${brief.base}` : `no, ${brief.baseBranch} is at ${brief.base}; bring it in with feature_update before the review`}`,
    `Covered at the tip: ${cover}`,
    ...(brief.prUrl === null ? [] : [`Pull request: ${brief.prUrl}`]),
    "Task groups:",
    ...(brief.groups.length === 0 ? ["  (none)"] : brief.groups.map((group) => `  ${group.task}  ${group.from.slice(0, 12)}..${group.to.slice(0, 12)}  ${group.title}`)),
    "Reviews:",
    ...reviewLines(brief.reviews),
    "Waivers:",
    ...(brief.waivers.length === 0 ? ["  (none)"] : brief.waivers.map((waiver) => `  at ${waiver.commit.slice(0, 12)}  ${waiver.at}  ${waiver.reason}`)),
  ];
}
