// `tmb index`: index the base branch into the code graph now.
import { HandlerError, indexProject, notReadSummary, openProjectStore, repoOfRow, runningName, workingRepos, workspaceRepos } from "../../engine/index.ts";
import { parseWithJson } from "../arguments.ts";
import { listed, ParsedCommand, UsageError } from "../command.ts";
import type { ProjectContext } from "./config.ts";
import { cannotOpenLine } from "./record.ts";

type IndexOptions = { readonly rebuild: boolean; readonly json: boolean };
type IndexStats = Awaited<ReturnType<typeof indexProject>>;

export class IndexCommand extends ParsedCommand<IndexOptions> {
  readonly name = "index";
  readonly summary = "Index the base branch now";
  readonly listing = listed("Code");

  constructor(private readonly context: ProjectContext) {
    super();
  }

  usage(): string {
    return `  tmb index [--rebuild]     Index the base branch into the code graph now, or in a workspace
                            each repo's; reads keep it current on their own. --rebuild
                            reparses every file`;
  }

  protected parse(args: readonly string[]): IndexOptions {
    const { values, positionals } = parseWithJson(args, { rebuild: { type: "boolean" } });
    if (positionals.length > 0) throw new UsageError(`index takes no arguments, got ${positionals.join(" ")}`);
    return { rebuild: values.rebuild === true, json: values.json === true };
  }

  protected async execute({ rebuild, json }: IndexOptions): Promise<number> {
    const projectDir = this.context.cwd();
    const { output } = this.context;
    const opened = openProjectStore(projectDir, { create: false });
    if (!opened.ok) {
      output.err(cannotOpenLine(projectDir, opened.error));
      return 1;
    }
    try {
      const repos = workspaceRepos(opened.store);
      if (repos !== null) {
        // Each repo is indexed on its own; one that cannot be indexed yet says why, and the run goes on.
        const all: unknown[] = [];
        let failed = false;
        for (const name of workingRepos(repos)) {
          try {
            const stats = await indexProject(projectDir, opened.store, { rebuild, repo: repoOfRow(opened.store, projectDir, { repo: name }) });
            all.push(stats);
            if (!json) output.out(statsLine(stats));
          } catch (error) {
            if (!(error instanceof HandlerError)) throw error;
            failed = true;
            all.push({ repo: name, error: error.message });
            if (!json) output.err(`tmb index: ${name}: ${error.message}`);
          }
        }
        if (json) output.out(JSON.stringify(all, null, 2));
        else if (all.length === 0) output.out(`This workspace has no repo tmb works in; \`${runningName()} init\` finds its repos.`);
        return failed ? 1 : 0;
      }
      const stats = await indexProject(projectDir, opened.store, { rebuild });
      output.out(json ? JSON.stringify(stats, null, 2) : statsLine(stats));
      return 0;
    } catch (error) {
      if (!(error instanceof HandlerError)) throw error;
      output.err(`tmb index: ${error.message}`);
      return 1;
    } finally {
      opened.store.close();
    }
  }
}

function statsLine(stats: IndexStats): string {
  const notRead = notReadSummary(stats.notRead);
  return `Indexed ${stats.repo ? `${stats.repo} from ` : ""}${stats.baseBranch} at ${stats.commit.slice(0, 12)}: ${stats.files} files, ${stats.symbols} symbols, ${stats.functions} functions, ${stats.edges} references (${stats.unresolved} unresolved), ${stats.unresolvedImports} ${stats.unresolvedImports === 1 ? "import" : "imports"} of the repo's own code not linked to a file; parsed ${stats.parsed}, reused ${stats.reused}; ${stats.notParsed} ${stats.notParsed === 1 ? "file" : "files"} not parsed${notRead === "" ? "" : `; ${notRead}`}.`;
}
