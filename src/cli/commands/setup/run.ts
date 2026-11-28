// What init and onboard share: the project they work on, where they write, and their way into the
// project's record.
import { chooseReviewMode, HandlerError, indexProject, notReadSummary, openProjectStore, readSettings, type Repo, repoDirOf, type RepoPolicy, type ReviewModeChooser, runningName, SETTING_NAMES, settingLines, type Settings, type SettingValues, writeRepos, writeSetting } from "../../../engine/index.ts";
import { HUMAN } from "../../command.ts";
import { Paint } from "../../help.ts";
import { type SetupFlags, SetupError, type SetupOptions } from "./options.ts";

export const NO_SETTINGS: Settings = { host: null, host_roles: null, base_branch: null, review_mode: null, checks: null, graph_links: null, repos: null };

export abstract class SetupRun {
  protected readonly projectDir: string;
  protected readonly flags: SetupFlags;
  protected readonly out: (line: string) => void;

  constructor(protected readonly options: SetupOptions) {
    this.projectDir = options.projectDir;
    this.flags = options.flags;
    this.out = options.out;
  }

  /** Throws SetupError or SettingError, before writing anything when it can. */
  abstract run(): Promise<void>;

  /** The name of the program running setup, as the commands it names are written. */
  protected programName(): string {
    return this.options.program?.name ?? runningName();
  }

  /** A command to run or text to send, painted when the output may be coloured. */
  protected readonly code = (text: string): string => `\`${new Paint(this.options.colour === true).command(text)}\``;

  /** The settings stored so far; null when the project has no record yet. */
  protected storedSettings(): Settings | null {
    const opened = openProjectStore(this.projectDir, { create: false });
    if (!opened.ok) {
      if (opened.error.failure === "missing") return null;
      throw new SetupError(`cannot read the record: ${opened.error.message}`);
    }
    try {
      return readSettings(opened.store);
    } finally {
      opened.store.close();
    }
  }

  /** Records each answer that differs from the stored one; returns how many it recorded. `via` is the command the Human answered in. */
  protected storeAnswers(answers: Partial<SettingValues>, via: ReviewModeChooser): number {
    const opened = openProjectStore(this.projectDir, { create: false });
    if (!opened.ok) throw new SetupError(`cannot store the settings: ${opened.error.message}`);
    try {
      let recorded = 0;
      for (const name of SETTING_NAMES) {
        const value = answers[name];
        if (value === undefined) continue;
        const wrote =
          name === "review_mode"
            ? chooseReviewMode(opened.store, HUMAN, value, via)
            : name === "repos"
              ? writeRepos(opened.store, HUMAN, value, via)
              : writeSetting(opened.store, HUMAN, name, value);
        if (wrote) recorded++;
      }
      return recorded;
    } finally {
      opened.store.close();
    }
  }

  /** Prints the settings in force and how many changes this run recorded. */
  protected printSettings(recorded: number): void {
    const { out } = this;
    out("Settings in the record:");
    for (const line of settingLines(this.storedSettings() ?? NO_SETTINGS)) out(`  ${line}`);
    out(recorded === 0 ? "No setting changed, so nothing was recorded." : `Recorded ${recorded} change${recorded === 1 ? "" : "s"} in the record's setting changes.`);
  }

  /**
   * Indexes the base branch into the code graph, or one workspace repo's; a project or repo that
   * cannot be indexed yet is told why, and the run goes on.
   */
  protected async indexCodeGraph(repo?: Repo): Promise<void> {
    const { projectDir, out } = this;
    const opened = openProjectStore(projectDir, { create: false });
    if (!opened.ok) throw new SetupError(`cannot index the code graph: ${opened.error.message}`);
    const of = repo?.name ? ` of ${repo.name}` : "";
    try {
      const stats = await indexProject(projectDir, opened.store, { rebuild: false, repo });
      const what = repo?.name ? `of ${repo.name} from ${stats.baseBranch}` : `of ${stats.baseBranch}`;
      out(`Indexed the code graph ${what} at ${stats.commit.slice(0, 12)}: ${stats.files} files, ${stats.symbols} symbols, ${stats.functions} functions; ${stats.notParsed} ${stats.notParsed === 1 ? "file" : "files"} not parsed${notReadSummary(stats.notRead) === "" ? "" : `; ${notReadSummary(stats.notRead)}`}.`);
    } catch (error) {
      // The settings are stored by now, and every lookup indexes the graph itself, so a failed index never fails the run.
      const message = error instanceof Error ? error.message : String(error);
      out(
        error instanceof HandlerError
          ? `The code graph${of} is not indexed yet: ${message}. Lookups index it once the base branch has a commit.`
          : `The code graph${of} could not be indexed now (${message}); the first lookup indexes it.`,
      );
    } finally {
      opened.store.close();
    }
  }

  /** A workspace repo as the code graph indexes it. */
  protected repoOfPolicy(name: string, policy: RepoPolicy): Repo {
    return { name, dir: repoDirOf(this.projectDir, name), baseBranch: policy.base_branch ?? null, checks: policy.checks ?? [] };
  }
}
