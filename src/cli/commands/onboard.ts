// `tmb onboard`: set the project's settings.
import { parseArgs } from "node:util";
import { noArguments } from "../arguments.ts";
import { listed } from "../command.ts";
import { INIT_OPTIONS, PrepareCommand } from "./prepare.ts";
import { runOnboard, type SetupFlags } from "./setup.ts";

const ONBOARD_OPTIONS = {
  ...INIT_OPTIONS,
  base: { type: "string" },
  "review-mode": { type: "string" },
  "issue-sync": { type: "string" },
  check: { type: "string", multiple: true },
  "shared-folder": { type: "string", multiple: true },
  repo: { type: "string" },
  exempt: { type: "boolean" },
  "add-push-gate": { type: "boolean" },
  yes: { type: "boolean", short: "y" },
} as const;

export class OnboardCommand extends PrepareCommand {
  readonly name = "onboard";
  readonly summary = "Set the project's settings";
  readonly listing = listed("Project");

  usage(): string {
    return `  tmb onboard [--host <id>] [--role planner|reviewer] [--base <branch>] [--review-mode <mode>]
              [--issue-sync open|all|off] [--check <command>]... [--shared-folder <folder>]...
              [--repo <name> [--exempt]]
              [--add-push-gate] [--yes]
                            Set the project's settings: a host's role, the base branch, the
                            review mode, how much of the GitHub repo's issues tmb copies in
                            (--issue-sync: open, all or off), the checks and the shared folders
                            every task worktree links from the main folder. In a workspace of several repos, --repo
                            names the repo --base, --check, --shared-folder and --review-mode set (--review-mode
                            workspace makes it follow the workspace's), and --exempt makes tmb do
                            no work in it. --add-push-gate adds tmb's one line to a pre-push hook
                            that is another tool's. Asks on a terminal, else keeps the stored
                            values; run it again at any time`;
  }

  protected parse(args: readonly string[]): SetupFlags {
    const { values, positionals } = parseArgs({ args: [...args], options: ONBOARD_OPTIONS, allowPositionals: true, strict: true });
    noArguments(this.name, positionals);
    return {
      host: values.host,
      role: values.role,
      base: values.base,
      reviewMode: values["review-mode"],
      issueSync: values["issue-sync"],
      checks: values.check,
      sharedFolders: values["shared-folder"],
      yes: values.yes,
      repo: values.repo,
      exempt: values.exempt,
      addPushGate: values["add-push-gate"],
    };
  }

  /** Asks only when a person is at both ends. */
  protected async execute(flags: SetupFlags): Promise<number> {
    const terminal = this.runtime.terminal();
    try {
      await runOnboard(this.setupOptions(flags, terminal?.ask ?? null, undefined));
    } finally {
      terminal?.close();
    }
    return 0;
  }
}
