// `tmb tools`: list each language's tool and whose copy the code graph would use, or install one.
import { installTool, type InstallOptions, languageNamed, machinePlaces, missingTools, openProjectStore, runningName, toolLine, type ToolRow, toolRows, workingRepos, workspaceRepos } from "../../engine/index.ts";
import { parseWithJson } from "../arguments.ts";
import { indexedLanguages, projectLanguages } from "../code-languages.ts";
import { listed, type Output, ParsedCommand, UsageError } from "../command.ts";
import { writeUsageError } from "../usage-error.ts";
import type { ProjectContext } from "./config.ts";
import { cannotOpenLine } from "./record.ts";

/** A list of whose copy each tool is, or an install of the tool one language, or every indexed one, misses. */
type ToolsOptions = { readonly kind: "list"; readonly json: boolean } | { readonly kind: "install"; readonly language: string | undefined };

export class ToolsCommand extends ParsedCommand<ToolsOptions> {
  readonly name = "tools";
  readonly summary = "List or install each language's tool";
  readonly listing = listed("Code");

  constructor(
    private readonly context: ProjectContext,
    private readonly installOptions?: InstallOptions,
  ) {
    super();
  }

  usage(): string {
    return `  tmb tools [--json]        List each language of the indexed code with its tool and whose
                            copy the code graph would use now: a copy the setting names, the
                            user's own, tmb's, or that it is missing; in a workspace, each
                            repo's. Installs nothing
  tmb tools install [language]
                            Install the tool the language misses, or each one the indexed
                            code's languages miss, into tmb's tools folder, once per machine:
                            its pinned release, from the tool's own release page, checked
                            against the checksum tmb carries. tmb installs a tool, never a
                            language`;
  }

  protected parse(args: readonly string[]): ToolsOptions {
    if (args[0] === "install") {
      const { positionals } = parseWithJson(args.slice(1), {});
      if (positionals.length > 1) throw new UsageError(`tools install takes at most one language, got ${positionals.join(" ")}`);
      return { kind: "install", language: positionals[0] };
    }
    const { values, positionals } = parseWithJson(args, {});
    if (positionals.length > 0) throw new UsageError(`tools takes no arguments but install, got ${positionals.join(" ")}`);
    return { kind: "list", json: values.json === true };
  }

  protected execute(options: ToolsOptions): Promise<number> | number {
    return options.kind === "install" ? this.installTools(options.language) : this.list(options.json);
  }

  private list(json: boolean): number {
    const projectDir = this.context.cwd();
    const { output } = this.context;
    const opened = openProjectStore(projectDir, { create: false });
    if (!opened.ok) {
      output.err(cannotOpenLine(projectDir, opened.error));
      return 1;
    }
    let graphs: (string | null)[];
    try {
      const repos = workspaceRepos(opened.store);
      graphs = repos === null ? [null] : workingRepos(repos);
    } finally {
      opened.store.close();
    }
    const all: { repo: string | null; tools: ToolRow[] | null }[] = graphs.map((repo) => {
      const languages = indexedLanguages(projectDir, repo);
      return { repo, tools: languages === null ? null : toolRows(languages) };
    });
    if (json) {
      output.out(JSON.stringify(graphs.length === 1 && graphs[0] === null ? all[0]!.tools : all, null, 2));
      return 0;
    }
    for (const { repo, tools } of all) {
      const head = repo === null ? "" : `${repo}: `;
      if (tools === null) output.out(`${head}not indexed yet; \`${runningName()} index\` indexes it`);
      else if (tools.length === 0) output.out(`${head}no language tmb reads`);
      else for (const row of tools) output.out(`${head}${toolLine(row)}`);
    }
    return 0;
  }

  /**
   * Installs the tool the language misses, or each one the indexed code's languages miss. A tool
   * the find order finds a copy of is not installed again; a language's own command never is.
   */
  private async installTools(named: string | undefined): Promise<number> {
    const program = runningName();
    const { output } = this.context;
    let languages: string[];
    if (named !== undefined) {
      const language = languageNamed(named);
      if (language === null) throw new UsageError(`${named} is not a language tmb reads`);
      const tool = language.tool;
      if (tool === undefined) {
        output.out(`${named} has no language tool: the built-in rules make its links, and there is nothing to install`);
        return 0;
      }
      if ("program" in tool.copy && !tool.copy.tmbInstalls) {
        output.err(`tmb: ${named}: ${tool.copy.what} is the user's own: tmb installs a tool, never a language`);
        return 1;
      }
      languages = [named];
    } else {
      const indexed = projectLanguages(this.context.cwd());
      if (indexed === null) {
        output.err(`tmb: no indexed code here to read the languages of; run \`${program} index\`, or name a language: \`${program} tools install <language>\``);
        return 1;
      }
      languages = indexed;
    }
    const install = this.installOptions ?? { places: machinePlaces() };
    const { offers, notes } = missingTools(languages, install.places);
    for (const note of notes) output.out(note);
    if (offers.length === 0) {
      if (notes.length === 0) output.out(`Nothing to install: the find order finds a copy of the tool of ${languages.join(", ")}; \`${program} tools\` lists whose`);
      return notes.length === 0 ? 0 : 1;
    }
    let failed = notes.length > 0;
    for (const offer of offers) {
      const result = await installTool(offer.copy, install);
      if ("installed" in result) output.out(`Installed ${offer.tool} for ${offer.languages.join(", ")} at ${result.installed}`);
      else {
        output.err(`tmb: ${offer.tool} was not installed: ${result.failed}`);
        failed = true;
      }
    }
    return failed ? 1 : 0;
  }
}

/** Runs `tmb tools` in `projectDir`, a usage error written as the command line writes it; resolves to the exit code. */
export async function runToolsCommand(args: string[], projectDir: string, output: Output, install?: InstallOptions): Promise<number> {
  const command = new ToolsCommand({ output, cwd: () => projectDir }, install);
  try {
    return await command.run(args);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    writeUsageError(command, error, output);
    return 2;
  }
}
