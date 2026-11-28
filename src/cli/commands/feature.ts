// `tmb feature`: list and brief feature branches, and waive a review. The planner starts, updates,
// opens and drops them, with its tools.
import { endReadyLine, type FeatureBrief, type FeatureDropResult, type FeaturePrResult, type FeatureSummary, type FeatureUpdateResult, markLine, markRequiredLine, type WaiveResult } from "../../engine/index.ts";
import { only, parseWithJson } from "../arguments.ts";
import { listed, UsageError } from "../command.ts";
import { JSON_NOTE, RecordCommand, type RecordRequest, reviewLines, who } from "./record.ts";

export class FeatureCommand extends RecordCommand {
  readonly name = "feature";
  readonly summary = "List feature branches and waive a review";
  readonly listing = listed("Work");
  override readonly actions = ["list", "brief", "waive"] as const;

  usage(): string {
    return `  tmb feature list          List the feature branches with their base, state and tasks
  tmb feature brief <name>  Show a feature branch's tip, its task groups, reviews and waivers
  tmb feature waive <name> --reason <text>
                            Waive the review of the feature branch at its tip (the Human only, on a terminal)
${JSON_NOTE}`;
  }

  protected parse(args: readonly string[]): RecordRequest {
    const [action, ...rest] = args;
    switch (action) {
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
      case "waive": {
        const { values, positionals } = parseWithJson(rest, { reason: { type: "string" } });
        if (values.reason === undefined) throw new UsageError("feature waive needs --reason <text>: why the review is waived");
        const format = (waiver: WaiveResult) =>
          [`Waived the review of ${waiver.feature} at ${waiver.commit}; its pull request may open now.`, markLine(waiver.mark)].filter((line) => line !== null).join("\n");
        return { operation: "feature_waive", input: { feature: only(positionals, "feature branch name"), reason: values.reason }, json: values.json === true, format };
      }
      default:
        throw this.actionError(action);
    }
  }
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
    ...(brief.waivers.length === 0 ? ["  (none)"] : brief.waivers.map((waiver) => `  at ${waiver.commit.slice(0, 12)}  ${waiver.at}  by ${who(waiver.by)}  ${waiver.reason}`)),
  ];
}
