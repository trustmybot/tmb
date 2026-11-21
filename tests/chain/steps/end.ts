// Step 17: the end check. Reads the whole record once the chain has run: every agent run ended
// and kept its measures, no task is left open, and each feature branch ended where it should.
// Uses no model, so it runs on every pull request too, where it finds no session's work.
import type { Step } from "../chain.ts";
import { features, runs, show, tasks } from "../record.ts";

type Cost = { model?: string; inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; toolCalls?: number };

export const endCheck: Step = {
  n: 17,
  name: "The end check: every run ended and kept its measures; no work is left open",
  model: false,
  covers: [150, 256],
  run(world, checks) {
    const all = runs(world);
    const open = all.filter((run) => run.ended_at === null);
    checks.ok("no agent run is left open (trustmybot/tmb#150)", open.length === 0, show(open));
    const agents = all.filter((run) => run.role === "worker" || run.role === "reviewer");
    const badEnd = agents.filter((run) => run.outcome !== "finished" && run.outcome !== "stopped");
    checks.ok("every worker and reviewer run ended finished or stopped (trustmybot/tmb#150)", badEnd.length === 0, show(badEnd));
    const noCost = agents.filter((run) => run.cost === null);
    checks.ok("every worker and reviewer run kept its tokens per model (trustmybot/tmb#150)", noCost.length === 0, show(noCost));
    const costs = agents.map((run) => (run.cost ? (JSON.parse(run.cost) as Cost[]) : []));
    checks.known(256, "every agent run keeps its number of tool calls, as the plugin's record did", agents.length > 0 && costs.every((cost) => cost.some((each) => typeof each.toolCalls === "number")), `${agents.length} worker and reviewer run(s)`);
    checks.known(256, "the planner's session is kept as a run too", all.some((run) => run.role === "planner"), `roles kept: ${[...new Set(all.map((run) => run.role))].join(", ") || "none"}`);

    // Per role, on average, for the comparison with the plugin's numbers in trustmybot/tmb#256.
    for (const role of ["worker", "reviewer"]) {
      const mine = agents.map((run, at) => ({ run, cost: costs[at]! })).filter((each) => each.run.role === role);
      if (mine.length === 0) continue;
      const avg = (key: keyof Cost) => Math.round(mine.reduce((sum, each) => sum + each.cost.reduce((total, part) => total + Number(part[key] ?? 0), 0), 0) / mine.length);
      const seconds = Math.round(mine.reduce((sum, each) => sum + (Date.parse(each.run.ended_at ?? each.run.started_at) - Date.parse(each.run.started_at)) / 1000, 0) / mine.length);
      console.log(`   ${role}: ${mine.length} run(s); per run on average ${avg("outputTokens")} output, ${avg("cacheReadTokens")} cache read, ${avg("cacheWriteTokens")} cache write, ${seconds}s`);
    }

    const allTasks = tasks(world);
    const stillOpen = allTasks.filter((task) => task.state === "open");
    checks.ok("no task is left open", stillOpen.length === 0, show(stillOpen));
    const allFeatures = features(world);
    if (allFeatures.length === 0) {
      console.log("   no session step ran, so there is no feature branch to check");
      return;
    }
    const byRepo = (repo: string) => allFeatures.filter((feature) => feature.repo === repo);
    checks.ok("api's feature branch ended merged, by its pull request", byRepo("api").length > 0 && byRepo("api").every((feature) => feature.state === "merged" && feature.pr_url !== null), show(byRepo("api")));
    checks.ok("notes' feature branch ended merged, by the Human's local merge", byRepo("notes").length > 0 && byRepo("notes").every((feature) => feature.state === "merged" && feature.pr_url === null), show(byRepo("notes")));
    const tools = allTasks.filter((task) => task.repo === "tools" && task.state !== "dropped");
    checks.ok("tools' task waits on its pull request", tools.length > 0 && tools.every((task) => task.pr_url !== null), show(tools));
  },
};
