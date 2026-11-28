// `tmb pre-push`: git's pre-push hook. Exit 1 refuses the push, and git shows what tmb wrote on stderr.
import path from "node:path";
import { judgePush, NO_RECORD, projectRootOf, pushActorFrom, repoTopOf } from "../../engine/index.ts";
import { HIDDEN, ParsedCommand } from "../command.ts";
import type { Runtime } from "../runtime.ts";

/** The project's folder the hook names, if it names one, and the remote git pushes to. */
type PrePushOptions = { readonly project: string | null; readonly remote: string };

const PROJECT_FLAG = "--project";

export class PrePushCommand extends ParsedCommand<PrePushOptions> {
  readonly name = "pre-push";
  readonly summary = "Judge a push for git's pre-push hook";
  readonly listing = HIDDEN;

  constructor(private readonly runtime: Runtime) {
    super();
  }

  usage(): string {
    return `  tmb pre-push [--project <path>] <remote> [<url>]
                            Judge a push (git's pre-push hook runs this; reads its ref lines on stdin)`;
  }

  // The hook init writes names the project's folder: git runs it at the repo's top, which is not
  // the project's folder when the project is below it (trustmybot/tmb#178). A hook an older tmb
  // wrote names none, and the record is then the nearest one above the folder git runs it in.
  protected parse(args: readonly string[]): PrePushOptions {
    let rest = args;
    let project: string | null = null;
    if (rest[0] === PROJECT_FLAG) {
      project = rest[1] ?? null;
      if (project === null) throw new Error("pre-push --project needs the project's folder");
      rest = rest.slice(2);
    }
    const remote = rest[0];
    if (remote === undefined) throw new Error("pre-push needs the remote's name, as git passes it");
    return { project, remote };
  }

  protected async execute({ project, remote }: PrePushOptions): Promise<number> {
    // A push from a task worktree runs the hook there; the record is in the project that holds it.
    // In a workspace, the folder git runs the hook in names the repo whose base branch is judged.
    // The hook names the project from the repo's top; a task worktree's repo is the one it was cut from.
    const cwd = this.runtime.cwd();
    const named = project === null ? null : path.resolve(repoTopOf(cwd) ?? cwd, project);
    const decision = judgePush(named ?? projectRootOf(cwd), remote, await this.runtime.ports.readStdin(), cwd, pushActorFrom(this.runtime.env));
    if (decision.decision === "deny") {
      this.runtime.err(decision.reason ?? `tmb refused the push to ${remote}`);
      return 1;
    }
    // No record: the push goes, and the hook says why in one line rather than pass in silence.
    if (decision.reason?.startsWith(NO_RECORD)) this.runtime.err(decision.reason);
    return 0;
  }
}
