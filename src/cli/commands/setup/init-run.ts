// `tmb init`: picks the host, has its adapter wire tmb into the project, adds git's push hook and
// indexes the code graph. It asks nothing and never waits for input, on a terminal or not
// (trustmybot/tmb#162, trustmybot/tmb#414): it leaves the settings empty, the review mode for the
// Human to choose and the others for the planner to fill at the first session start, and names the
// languages whose tool is missing.
import { type HostAdapter, SUPPORTED_HOST_IDS } from "../../../adapters/index.ts";
import {
  DEFAULT_HOST_ROLE,
  detectBaseBranch,
  detectBaseBranchWithEvidence,
  detectChecks,
  emptySettings,
  firstRunAtInit,
  giveTasksTheirRepos,
  type HostRole,
  inGitWorkTree,
  installPushGates,
  installsOff,
  machinePlaces,
  missingTools,
  openProjectStore,
  otherProjectInRepo,
  repoDirOf,
  sharedFoldersOf,
  type RepoPolicies,
  repoPolicyLine,
  runGit,
  runningName,
  type Scan,
  scanWorkspace,
  tieProgram,
  version as packageVersion,
  workingRepos,
} from "../../../engine/index.ts";
import { HUMAN } from "../../command.ts";
import { projectLanguages } from "../../code-languages.ts";
import { howEmptySettingsFill, howReviewModeIsChosen, listed, reviewModeMissing, supportedHosts } from "./lines.ts";
import { DEFAULT_PROGRAM_NAME, FALLBACK_BASE_BRANCH, SetupError, validatedFlags } from "./options.ts";
import { NO_SETTINGS, SetupRun } from "./run.ts";

/** What init did, for the lines that close the run. */
type Initialised = {
  readonly adapter: HostAdapter;
  readonly role: HostRole;
  readonly recorded: number;
  /** Said first and last when the host is not supported in this release. */
  readonly warning: string | null;
};

export class InitRun extends SetupRun {
  async run(): Promise<void> {
    const { out } = this;
    const init = await this.wire();
    this.printSettings(init.recorded);
    this.sayReady(init.adapter, init.role);
    const onboard = this.code(`${this.programName()} onboard`);
    const settings = this.storedSettings() ?? NO_SETTINGS;
    // The review mode is the Human's to choose; the planner applies only the others.
    const empty = emptySettings(settings)
      .filter((name) => name !== "review_mode")
      .map((name) => name.replace("_", " "));
    if (empty.length === 0) {
      out(`To change the settings, run ${onboard}.`);
    } else {
      out(`The settings are still empty: ${listed(empty)}; ${howEmptySettingsFill(init.role)}. To set them yourself, run ${onboard}.`);
    }
    if (reviewModeMissing(settings.review_mode, settings.repos)) out(howReviewModeIsChosen(init.role, onboard));
    this.nameMissingTools();
    // The feedback program's notice, once per program on this machine, only on a terminal; its question is the planner's.
    if (this.options.feedback !== undefined) firstRunAtInit(this.options.feedback, out);
    // Said again last, so it is not lost above init's other lines.
    if (init.warning) out(init.warning);
  }

  /**
   * Wires one host into the project in its role. Asks nothing and sets none of the project's
   * settings: those are the planner's at the first session start, or the Human's with onboard.
   */
  private async wire(): Promise<Initialised> {
    const { projectDir, options, out } = this;
    const answered = validatedFlags({ role: this.flags.role });
    const stored = this.storedSettings() ?? NO_SETTINGS;

    const adapter = this.chooseHost(stored.host);
    const supported = options.supportedHostIds ?? SUPPORTED_HOST_IDS;
    const warning = supported.includes(adapter.id)
      ? null
      : `Warning: ${adapter.name} is not supported yet in this release: tmb sets it up so you can try it, but nothing guarantees it works.`;
    if (warning) out(warning);

    // One repo holds one tmb project for now: a second project in it would share the first one's push hook (trustmybot/tmb#178).
    const other = inGitWorkTree(projectDir) ? otherProjectInRepo(projectDir, projectDir) : null;
    if (other !== null) {
      throw new Error(
        `this repo already holds the tmb project in ${other}, whose push gate is the repo's pre-push hook; one repo holds one tmb project for now, so ${runningName()} init stops here. Work in ${other}, or run \`${runningName()} remove\` there first`,
      );
    }
    // A folder that is not a git work tree and holds repos, or held them at an earlier init, is a workspace.
    // One that holds none, and never did, gets git init: it is then a project of one repo. git init runs
    // before anything is written, so the host's registrations find a work tree and add their .gitignore lines.
    const scan = inGitWorkTree(projectDir) ? null : scanWorkspace(projectDir);
    const workspace = scan !== null && (stored.repos !== null || scan.repos.length > 0);
    if (scan !== null && !workspace) this.initGit();
    // The wiring: the host's registrations, which create the record, then the workspace's repos, then git's push hooks.
    for (const line of adapter.setup(projectDir, options.tmbCommand)) out(line);
    this.shareFolders([adapter], sharedFoldersOf(stored, null));
    const repos = workspace && scan !== null ? this.registerRepos(stored.repos, scan) : null;
    if (repos !== null) this.giveOldTasksRepos(repos);
    for (const line of installPushGates(projectDir, repos, options.tmbCommand)) out(line);
    this.tieToProgram(options.program ?? { name: DEFAULT_PROGRAM_NAME, version: packageVersion });

    // The role is the host's main agent's: kept from an earlier init of this host unless --role names another.
    const role = answered.role ?? stored.host_roles?.[adapter.id] ?? DEFAULT_HOST_ROLE;
    const hostRoles = { ...(stored.host_roles ?? {}), [adapter.id]: role };
    const recorded = this.storeAnswers({ host: adapter.id, host_roles: hostRoles }, "init");
    if (repos !== null) {
      for (const name of workingRepos(repos)) await this.indexCodeGraph(this.repoOfPolicy(name, repos[name]!));
    } else if ((stored.base_branch ?? detectBaseBranch(projectDir)) !== null) {
      // With no base branch set, the graph is built from the one tmb detects.
      await this.indexCodeGraph();
    }
    return { adapter, role, recorded, warning };
  }

  /** The host init wires: the one --host names, else the one installed, else the stored one, else the first. Never asks. */
  private chooseHost(storedHost: string | null): HostAdapter {
    const { out, flags } = this;
    const { adapters } = this.options;
    if (flags.host !== undefined) {
      const named = adapters.find((adapter) => adapter.id === flags.host);
      if (!named) throw new SetupError(`unknown host '${flags.host}'; tmb supports ${supportedHosts(adapters)}`);
      if (!named.detect().installed) throw new SetupError(`${named.name} is not installed; install it, then run ${runningName()} init again`);
      out(`Setting tmb up for ${named.name}, as --host asked.`);
      return named;
    }

    const installed = adapters.filter((adapter) => adapter.detect().installed);
    if (installed.length === 0) {
      throw new SetupError(`no supported host is installed; tmb supports ${supportedHosts(adapters)}. Install one, then run ${runningName()} init again.`);
    }
    if (installed.length === 1) {
      out(`Found ${installed[0]!.name}, the one supported host installed; setting tmb up for it.`);
      return installed[0]!;
    }
    const chosen = installed.find((adapter) => adapter.id === storedHost) ?? installed[0]!;
    out(`Several hosts are installed (${listed(installed.map((adapter) => adapter.name))}); taking ${chosen.name}. Pass --host to choose.`);
    return chosen;
  }

  /** Ties the project to the program running init, and says so when it moved from another. */
  private tieToProgram(program: { name: string; version: string }): void {
    const { out } = this;
    const command = this.options.tmbCommand;
    const opened = openProjectStore(this.projectDir, { create: false });
    if (!opened.ok) throw new SetupError(`cannot tie the project to ${program.name}: ${opened.error.message}`);
    try {
      const { from } = tieProgram(opened.store, HUMAN, { program: program.name, version: program.version, command: [...command] });
      if (from !== null && from.program !== program.name) out(`Moved this project from ${from.program} ${from.version} to ${program.name} ${program.version}.`);
      // Another version of the same program, run the same way, is recorded (trustmybot/tmb#128) but not worth a line.
      const rewired = from === null || from.program !== program.name || JSON.stringify(from.command) !== JSON.stringify([...command]);
      if (rewired) out(`This project runs ${program.name}: its hooks and tool server call ${command.join(" ")}.`);
    } finally {
      opened.store.close();
    }
  }

  /**
   * A workspace's repos, found again: each repo the scan finds is registered, with the base branch
   * its own git points at; a repo already registered keeps its policy, and one that is gone is
   * dropped. Says each change and the evidence for each new base branch. Stores and returns them.
   */
  private registerRepos(stored: RepoPolicies | null, scan: Scan): RepoPolicies {
    const { projectDir, out } = this;
    const before = stored ?? {};
    const found = scan.repos;
    const repos: RepoPolicies = {};
    out(`This folder is not a git work tree, so it is a workspace: its repos share one record.`);
    for (const name of found) {
      const kept = before[name];
      if (kept !== undefined && kept.git !== false) {
        repos[name] = kept;
        out(`  ${repoPolicyLine(name, kept)}`);
        continue;
      }
      const detected = detectBaseBranchWithEvidence(repoDirOf(projectDir, name));
      // A scanned repo is a git work tree, so a base branch is always found; the fallback keeps the type honest.
      const base = detected?.branch ?? FALLBACK_BASE_BRANCH;
      repos[name] = { base_branch: base, checks: detectChecks(repoDirOf(projectDir, name)) };
      out(`  Added repo ${name}: base branch ${base}, from ${detected?.from ?? "the fallback"}.`);
    }
    // A folder that is no repo is recorded and left alone: no hook, no task, no graph.
    for (const name of scan.folders) {
      repos[name] = { git: false };
      out(before[name]?.git === false ? `  ${repoPolicyLine(name, repos[name]!)}` : `  Recorded folder ${name}: it is not a repo, so tmb does no work in it.`);
    }
    for (const name of Object.keys(before)) {
      if (repos[name] !== undefined) continue;
      out(before[name]!.git === false ? `  Dropped folder ${name}: it is no longer in this folder.` : `  Dropped repo ${name}: it is no longer a repo in this folder.`);
    }
    if (found.length === 0) out(`  No repo found: tmb looks for git repos up to two folders down. Clone one here and run ${runningName()} init again.`);
    this.storeAnswers({ repos }, "init");
    return repos;
  }

  /**
   * Gives each task made before the project became a workspace the repo the evidence names, and says
   * each; its runs and checks follow it. A task the evidence leaves open is named for the Human (trustmybot/tmb#257).
   */
  private giveOldTasksRepos(repos: RepoPolicies): void {
    const { projectDir, out } = this;
    const opened = openProjectStore(projectDir, { create: false });
    if (!opened.ok) return;
    try {
      const { given, left } = giveTasksTheirRepos(opened.store, HUMAN, projectDir, repos);
      if (given.length + left.length === 0) return;
      out(`  Tasks made before this was a workspace: ${given.length} given their repo, ${left.length} left with none.`);
      for (const gave of given) out(`  Gave task ${gave.task} its repo ${gave.repo}: ${gave.from}.`);
      if (left.length > 0) {
        out(`  ${left.length === 1 ? "1 task names" : `${left.length} tasks name`} no repo: nothing shows one repo ${left.length === 1 ? "it was" : "each was"} cut in (${left.map((task) => task.id).join(", ")}). \`tmb doctor\` lists ${left.length === 1 ? "it" : "them"}.`);
      }
    } finally {
      opened.store.close();
    }
  }

  /**
   * Makes a folder that holds no repo into one, so the project is a single repo. Only called when the
   * folder is in no git work tree, holds no repo below it and the record registers none: init never
   * runs git init over repos it found.
   */
  private initGit(): void {
    const result = runGit(this.projectDir, ["init", "--quiet"]);
    // Without git, init goes on as it always has: the project works, with the push gate off.
    if (!result.ok) {
      this.out(`This folder holds no git repo, and git init could not run in it (${result.stderr || result.stdout || "no output"}); tmb goes on without git.`);
      return;
    }
    this.out("This folder held no git repo, so tmb ran git init in it: it is a project of one repo.");
  }

  /**
   * The steps the Human must take before the host runs tmb, then what to do next: start the host
   * here and, for the planner, greet bro.
   */
  private sayReady(adapter: HostAdapter, role: HostRole): void {
    const { out, code } = this;
    const steps = adapter.pendingSteps?.(this.projectDir) ?? [];
    if (steps.length > 0) {
      out(`Before ${adapter.name} runs tmb in this project, you need to:`);
      for (const step of steps) out(`  - ${step}`);
    }
    out(`tmb is set up for ${adapter.name}. Next:`);
    if (role === "planner") {
      out(`  1. Run ${code(adapter.command)} in this folder.`);
      out(`  2. Send ${code("@bro")}.`);
    } else {
      out(`  1. Run ${code(adapter.command)} in this folder; it starts as the ${role}.`);
    }
  }

  /**
   * The tools the repo's languages miss (CODE_GRAPH.md, "Where a language's tool comes from"): init
   * names them and the command that installs them, whose run is the yes. It asks nothing and
   * downloads nothing (2_ONBOARD.md). With installs off, it says so. A language's own command is
   * never offered: it is named, as tmb installs no language.
   */
  private nameMissingTools(): void {
    const { out } = this;
    const places = this.options.tools?.places ?? machinePlaces();
    const languages = projectLanguages(this.projectDir);
    if (languages === null) return;
    const { offers, notes } = missingTools(languages, places);
    for (const note of notes) out(note);
    if (offers.length === 0) return;
    const named = offers.map((offer) => `${offer.tool} (for ${offer.languages.join(", ")})`);
    if (installsOff(places.stateDir)) {
      out(`The code graph misses ${listed(named)}, and installs are off on this machine: the built-in rules make those languages' links.`);
      return;
    }
    const command = this.code(`${this.programName()} tools install`);
    out(`The code graph misses ${listed(named)}: the built-in rules make those languages' links until ${command} installs ${offers.length === 1 ? "it" : "them"}.`);
  }
}
