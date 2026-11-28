// `tmb onboard`: asks the questions the workflow needs and stores the answers; it can be run again
// at any time.
import {
  addToForeignHook,
  DEFAULT_HOST_ROLE,
  detectBaseBranch,
  detectChecks,
  foreignHooks,
  handCallLine,
  HOST_ROLES,
  type HostRole,
  type IssueSync,
  MARK_CONTEXT,
  openProjectStore,
  repoDirOf,
  type RepoPolicies,
  requiredMarkOn,
  requireMarkHowTo,
  type ReviewMode,
  runningName,
  type Settings,
  tiedProgram,
  validateHostRole,
  validateRepoName,
  workingRepos,
} from "../../../engine/index.ts";
import type { HostAdapter } from "../../../adapters/index.ts";
import type { Ask } from "../../terminal.ts";
import { hostName, noReviewModeLine, notInitialised, reviewModeMissing } from "./lines.ts";
import { type Answered, DEFAULT_PROGRAM_NAME, FALLBACK_BASE_BRANCH, repoModeFlag, SetupError, validatedFlags } from "./options.ts";
import { askChecks, askIssueSync, askModePerRepo, askRepoReviewMode, askReviewMode, askSharedFolders, askText, askValid } from "./questions.ts";
import { SetupRun } from "./run.ts";

/** What onboard stored, for the lines that close the run. */
type Onboarded = {
  readonly recorded: number;
  readonly base: string | null;
  readonly role: HostRole;
  readonly reviewMode: ReviewMode | null;
  readonly repos?: RepoPolicies;
};

/** The host onboarding answers for, by id and name. */
type Host = { readonly id: string; readonly name: string };

export class OnboardRun extends SetupRun {
  async run(): Promise<void> {
    const { projectDir } = this;
    const onboarded = await this.onboard();
    this.printSettings(onboarded.recorded);
    if (onboarded.repos === undefined) this.sayNoBase(onboarded.base);
    if (reviewModeMissing(onboarded.reviewMode, onboarded.repos)) this.out(noReviewModeLine());
    if (onboarded.repos === undefined) this.sayMarkRule(projectDir, onboarded.base);
    else for (const name of workingRepos(onboarded.repos)) this.sayMarkRule(repoDirOf(projectDir, name), onboarded.repos[name]!.base_branch ?? null);
    await this.offerPushGate(onboarded.repos ?? null);
  }

  /** The prompt questions are asked with; null when each takes its default. */
  private ask(): Ask | null {
    return this.flags.yes === true ? null : this.options.ask;
  }

  /** Asks each question, offering the stored value, and stores the answers. Needs a project init has prepared. */
  private async onboard(): Promise<Onboarded> {
    const { projectDir, flags, out } = this;
    const answered = validatedFlags(flags);
    const stored = this.storedSettings();
    if (stored === null || stored.host === null) throw new SetupError(notInitialised());
    const hostId = flags.host ?? stored.host;
    const name = hostName(this.options.adapters, hostId);
    if (hostId !== stored.host && stored.host_roles?.[hostId] === undefined) {
      throw new SetupError(`${name} is not set up in this project; run ${runningName()} init --host ${hostId} first`);
    }
    const ask = this.ask();
    if (!ask) {
      out(
        `${flags.yes === true ? "--yes was given" : "There is no terminal to ask on"}, so each question takes its default, except the review mode, which is yours to choose, and issue sync, which stays as it is; ` +
          "--role, --base, --review-mode, --issue-sync, --check and --shared-folder set them.",
      );
    }

    const host = { id: hostId, name };
    if (stored.repos !== null) return this.onboardWorkspace(stored, stored.repos, host, answered, ask);
    if (flags.repo !== undefined || flags.exempt === true) throw new SetupError("this project is one repo, so --repo and --exempt are not taken; --base and --check set its settings");

    const role = await this.role(stored, host, answered, ask);
    const baseFallback = stored.base_branch ?? detectBaseBranch(projectDir);
    const base = answered.base_branch ?? (ask ? await askText(ask, "Base branch, the branch pull requests merge into", baseFallback) : baseFallback);
    // The review mode is the Human's choice: with no one to ask and no --review-mode, it stays as it is, set or not.
    const reviewMode = answered.review_mode ?? (ask ? await askReviewMode(ask, stored.review_mode, out) : stored.review_mode);
    const checksFallback = stored.checks ?? detectChecks(projectDir);
    const checks =
      answered.checks ?? (ask ? await askChecks(ask, checksFallback, stored.checks === null ? "Detected" : "Stored", out) : checksFallback);
    // tmb detects no shared folders: with no one to ask and no --shared-folder, they stay as they are; none given for none set records nothing.
    const askedFolders = answered.shared_folders ?? (ask ? await askSharedFolders(ask, stored.shared_folders ?? [], "Stored", out) : undefined);
    const sharedFolders = stored.shared_folders === null && askedFolders?.length === 0 ? undefined : askedFolders;
    const issueSync = await this.issueSync(stored, answered, ask);

    const hostRoles = { ...(stored.host_roles ?? {}), [hostId]: role };
    const recorded = this.storeAnswers({ host_roles: hostRoles, base_branch: base ?? undefined, review_mode: reviewMode ?? undefined, checks, shared_folders: sharedFolders, issue_sync: issueSync }, "onboard");
    if (sharedFolders !== undefined) this.shareFolders(this.hostAdapters(stored), sharedFolders);
    // A new base branch has its own code graph; init indexed the old one.
    if (base !== null && base !== stored.base_branch) await this.indexCodeGraph();
    return { recorded, base, role, reviewMode };
  }

  /** The adapters of the hosts set up in the project. */
  private hostAdapters(stored: Settings): HostAdapter[] {
    const ids = new Set([...Object.keys(stored.host_roles ?? {}), ...(stored.host === null ? [] : [stored.host])]);
    return this.options.adapters.filter((adapter) => ids.has(adapter.id));
  }

  /** How much of the remote's issues the record copies in: --issue-sync, else asked last, else as it is. */
  private async issueSync(stored: Settings, answered: Answered, ask: Ask | null): Promise<IssueSync | undefined> {
    return answered.issue_sync ?? (ask ? ((await askIssueSync(ask, stored.issue_sync, this.out)) ?? undefined) : undefined);
  }

  /** The role of the host's main agent: --role, else asked, else the stored one or the default. */
  private async role(stored: Settings, host: Host, answered: Answered, ask: Ask | null): Promise<HostRole> {
    const fallback = stored.host_roles?.[host.id] ?? DEFAULT_HOST_ROLE;
    return answered.role ?? (ask ? await askValid(ask, `Role of ${host.name}'s main agent, one of: ${HOST_ROLES.join(", ")}`, fallback, validateHostRole, this.out) : fallback);
  }

  /**
   * onboard in a workspace: the role and review mode as in a single-repo project, then each repo's
   * base branch and checks. Flags set the repo --repo names, or the only repo tmb works in; on a
   * terminal with no --repo, each repo tmb works in is asked in turn.
   */
  private async onboardWorkspace(stored: Settings, before: RepoPolicies, host: Host, answered: Answered, ask: Ask | null): Promise<Onboarded> {
    const { projectDir, flags, out } = this;
    const working = workingRepos(before);
    const repoMode = flags.repo !== undefined && flags.reviewMode !== undefined ? repoModeFlag(flags.reviewMode) : null;
    let targets: string[];
    if (flags.repo !== undefined) {
      const repo = validateRepoName(flags.repo);
      if (before[repo] === undefined) throw new SetupError(`no repo ${JSON.stringify(flags.repo)} in this workspace; its repos are ${Object.keys(before).join(", ") || "none"}, and ${runningName()} init finds new ones`);
      if (before[repo]!.git === false) throw new SetupError(`the folder ${repo} is not a repo, so it takes no policy; once it is a repo, ${runningName()} init records it as one`);
      targets = [repo];
    } else if (answered.base_branch !== undefined || answered.checks !== undefined || answered.shared_folders !== undefined || flags.exempt === true) {
      if (working.length !== 1) throw new SetupError(`this workspace has ${working.length} repos tmb works in (${working.join(", ") || "none"}); name the one --base, --check, --shared-folder or --exempt sets with --repo`);
      targets = working;
    } else {
      targets = ask === null ? [] : working;
    }

    const role = await this.role(stored, host, answered, ask);
    const reviewMode = answered.review_mode ?? (ask ? await askReviewMode(ask, stored.review_mode, out) : stored.review_mode);
    // The workspace's mode is asked once; a mode per repo is offered once, then asked only of the repos (trustmybot/tmb#216).
    const perRepo = repoMode === null && ask !== null && targets.length > 0 && working.length > 1 ? await askModePerRepo(ask, before, working) : null;

    const repos: RepoPolicies = { ...before };
    for (const repo of targets) {
      const dir = repoDirOf(projectDir, repo);
      const policy = before[repo]!;
      if (flags.exempt === true) {
        repos[repo] = { ...policy, exempt: true };
        continue;
      }
      const baseFallback = policy.base_branch ?? detectBaseBranch(dir) ?? FALLBACK_BASE_BRANCH;
      const base = answered.base_branch ?? (ask ? await askText(ask, `Base branch of ${repo}, the branch its pull requests merge into`, baseFallback) : baseFallback);
      const checksFallback = policy.checks ?? detectChecks(dir);
      const checks = answered.checks ?? (ask ? await askChecks(ask, checksFallback, `${repo}'s ${policy.checks === undefined ? "detected" : "stored"} checks`, out) : checksFallback);
      const sharedFolders = answered.shared_folders ?? (ask ? await askSharedFolders(ask, policy.shared_folders ?? [], `${repo}'s stored shared folders`, out) : policy.shared_folders);
      const ownMode =
        repoMode !== null
          ? repoMode.mode
          : perRepo === true && ask !== null
            ? await askRepoReviewMode(ask, repo, policy.review_mode, out)
            : perRepo === false
              ? undefined
              : policy.review_mode;
      repos[repo] = {
        base_branch: base ?? baseFallback,
        checks,
        ...(sharedFolders === undefined || sharedFolders.length === 0 ? {} : { shared_folders: sharedFolders }),
        ...(ownMode === undefined ? {} : { review_mode: ownMode }),
      };
    }

    const issueSync = await this.issueSync(stored, answered, ask);
    const hostRoles = { ...(stored.host_roles ?? {}), [host.id]: role };
    const recorded = this.storeAnswers({ host_roles: hostRoles, review_mode: reviewMode ?? undefined, repos, issue_sync: issueSync }, "onboard");
    // A repo with a new base branch, or newly worked in, has its own code graph to index.
    for (const repo of workingRepos(repos)) {
      if (repos[repo]!.base_branch !== before[repo]?.base_branch || before[repo]?.exempt === true) {
        await this.indexCodeGraph(this.repoOfPolicy(repo, repos[repo]!));
      }
    }
    return { recorded, base: null, role, reviewMode, repos };
  }

  private sayNoBase(base: string | null): void {
    if (base === null) this.out(`No base branch is set: this folder is not a git work tree. Run ${runningName()} onboard --base <branch> to set one.`);
  }

  /**
   * A pre-push hook that is another tool's, as husky and lefthook write, leaves the push gate off
   * (trustmybot/tmb#184). tmb adds its one line to it only with the Human's yes: --add-push-gate,
   * or a yes on the terminal; --yes does not give it. With neither, it says the gate is off.
   */
  private async offerPushGate(repos: RepoPolicies | null): Promise<void> {
    const { projectDir, flags, out } = this;
    const hooks = foreignHooks(projectDir, repos);
    if (hooks.length === 0) return;
    const program = this.tiedProgramName() ?? this.options.program?.name ?? DEFAULT_PROGRAM_NAME;
    const ask = this.ask();
    for (const hook of hooks) {
      // A hook in another language is left alone: tmb says how to call the gate from it.
      if (hook.program !== null) {
        out(handCallLine(hook, program, projectDir));
        continue;
      }
      let yes = flags.addPushGate === true;
      if (!yes && ask !== null) {
        const answer = await ask(`git's pre-push hook ${hook.file} is another tool's, so the push gate is off in ${hook.dir}. Add tmb's one line to it? [y/N]: `);
        yes = /^y(es)?$/i.test(answer?.trim() ?? "");
      }
      out(yes ? addToForeignHook(hook, program, projectDir) : `The push gate stays off in ${hook.dir}: its pre-push hook ${hook.file} is another tool's. \`${program} onboard --add-push-gate\` adds tmb's one line to it.`);
    }
  }

  /** The program the project is tied to, by name, as the line tmb adds to another tool's hook calls it. */
  private tiedProgramName(): string | null {
    const opened = openProjectStore(this.projectDir, { create: false });
    if (!opened.ok) return null;
    try {
      return tiedProgram(opened.store)?.program ?? null;
    } finally {
      opened.store.close();
    }
  }

  /** Whether the base branch's protection requires tmb's mark on GitHub, and how to turn it on; nothing when origin is no GitHub repository. */
  private sayMarkRule(repoDir: string, base: string | null): void {
    const { out } = this;
    if (base === null) return;
    const answer = requiredMarkOn(repoDir, base);
    if (answer === null) return;
    if ("unknown" in answer) {
      out(`tmb could not tell whether branch protection on ${base} requires ${MARK_CONTEXT}: ${answer.unknown}`);
      return;
    }
    if (answer.required) {
      out(`Branch protection on ${base} requires ${MARK_CONTEXT}, the mark tmb sets on GitHub on each commit it reviewed.`);
      return;
    }
    out(`${requireMarkHowTo(base)} GitHub offers this rule on a private repository only on its paid plans.`);
  }
}
