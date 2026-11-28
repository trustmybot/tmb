// `tmb migrate`: copy a tmb plugin project's records into the record init made for this project.
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { findPluginDb, type MigrationResult, migratePluginProject, migratePluginWorkspace } from "../../adapters/index.ts";
import { openProjectStore, projectDbPath, projectRootOf, repoOf, runGit, runningName, type Store, workspaceRepos } from "../../engine/index.ts";
import { noArguments } from "../arguments.ts";
import { listed, ParsedCommand } from "../command.ts";
import type { Runtime } from "../runtime.ts";

type MigrateOptions = { readonly from: string | undefined; readonly repo: string | undefined; readonly into: string | undefined; readonly json: boolean };

export class MigrateCommand extends ParsedCommand<MigrateOptions> {
  readonly name = "migrate";
  readonly summary = "Copy a plugin project's records";
  readonly listing = listed("Project");

  constructor(private readonly runtime: Runtime) {
    super();
  }

  usage(): string {
    return `  tmb migrate [--from <plugin db>] [--repo <name> [--into <repo>]] [--json]
                            Copy a tmb plugin project's records into the new record ${runningName()} init
                            made for this project; run ${runningName()} init first. In a workspace, each
                            plugin repo goes to the repo of the same name, or --into's. The
                            plugin's database is left untouched`;
  }

  protected parse(args: readonly string[]): MigrateOptions {
    const { values, positionals } = parseArgs({
      args: [...args],
      options: { from: { type: "string" }, repo: { type: "string" }, into: { type: "string" }, json: { type: "boolean" } },
      allowPositionals: true,
      strict: true,
    });
    noArguments(this.name, positionals);
    return { from: values.from, repo: values.repo, into: values.into, json: values.json === true };
  }

  protected execute(options: MigrateOptions): number {
    const cwd = this.runtime.cwd();
    const projectDir = projectRootOf(cwd);
    const from = options.from === undefined ? findPluginDb(projectDir) : path.resolve(options.from);
    if (from === null) throw new Error(`no plugin database in ${projectDir} or a folder above it; name one with --from`);
    // The records go only into a record init made for this project; migrate never creates one (trustmybot/tmb#161).
    const recordPath = projectDbPath(projectDir);
    if (!existsSync(recordPath)) {
      throw new Error(`there is no tmb record in ${cwd} or a folder above it; run ${runningName()} init here first, then ${runningName()} migrate`);
    }
    const opened = openProjectStore(projectDir, { create: false });
    if (!opened.ok) throw opened.error;
    try {
      refuseRecordOfAnotherProject(opened.store, projectDir, cwd);
      // A workspace takes each plugin repo into its one record (trustmybot/tmb#193); a single-repo project, one repo.
      const repos = workspaceRepos(opened.store);
      if (repos === null && options.into !== undefined) throw new Error("--into names a workspace repo, and this project is a single repo");
      const migration =
        repos === null
          ? { results: [migratePluginProject(opened.store, { pluginDbPath: from, projectDir, repo: options.repo })], leftOut: [] }
          : migratePluginWorkspace(opened.store, repos, { pluginDbPath: from, repo: options.repo, into: options.into });
      if (options.json) {
        this.runtime.out(JSON.stringify(repos === null ? migration.results[0] : migration));
      } else {
        for (const result of migration.results) for (const line of migrationLines(result, recordPath)) this.runtime.out(line);
        for (const left of migration.leftOut) this.runtime.out(`Not copied: the plugin's repo ${left.repo}: ${left.reason}.`);
        this.runtime.out("The plugin's database is unchanged.");
      }
    } finally {
      opened.store.close();
    }
    return 0;
  }
}

function migrationLines(result: MigrationResult, recordPath: string): string[] {
  const { counts } = result;
  const repo = result.repo === null ? "" : result.into === null || result.into === result.repo ? ` (repo ${result.repo})` : ` (repo ${result.repo}, into ${result.into})`;
  const lines = [
    `Copied from ${result.from}${repo} into ${recordPath}:`,
    `  ${counts.issues} issues, ${counts.discussions} notes and decisions, ${counts.tasks} tasks, ` +
      `${counts.reviews} reviews, ${counts.checkRuns} check runs, ${counts.runs} agent runs.`,
  ];
  if (counts.openTasks > 0) {
    lines.push(`${counts.openTasks} of the tasks are still open, as the plugin left them. While a task is open, a running session stays on the tmb build it started with.`);
  }
  const left = Object.entries(result.leftBehind).sort(([a], [b]) => a.localeCompare(b));
  if (left.length > 0) lines.push(`Left behind, as tmb has no such kind: ${left.map(([kind, count]) => `${count} ${kind}`).join(", ")}.`);
  return lines;
}

/**
 * The nearest record wins, so a repo with no record of its own would find one in a folder above
 * it. migrate copies only into the record of the project it runs in: the repo's own, or the
 * workspace's that registers this repo. Any other record above is refused, and named.
 */
function refuseRecordOfAnotherProject(store: Store, projectDir: string, cwd: string): void {
  const top = runGit(cwd, ["rev-parse", "--show-toplevel"]);
  if (!top.ok) return;
  const repoTop = realpathSync(top.stdout);
  const relative = path.relative(realpathSync(projectDir), repoTop);
  // The record is in the repo itself, or below the repo's top level: it is this project's.
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return;
  if (workspaceRepos(store) !== null && repoOf(store, projectDir, cwd) !== null) return;
  throw new Error(
    `the nearest tmb record, ${projectDbPath(projectDir)}, belongs to a folder above this repo and does not serve it; ` +
      `run ${runningName()} init in ${repoTop} first, then ${runningName()} migrate there`,
  );
}
