// `tmb dashboard`: serve the record as a local web page.
import { parseArgs } from "node:util";
import { DEFAULT_PORT, startDashboard } from "../../dashboard/index.ts";
import { projectRootOf } from "../../engine/index.ts";
import { remoteIssueWriter } from "../../syncer/index.ts";
import { noArguments } from "../arguments.ts";
import { listed, ParsedCommand } from "../command.ts";
import type { Runtime } from "../runtime.ts";

/** The highest port a dashboard may serve on. */
const MAX_PORT = 65535;

type DashboardOptions = { readonly port: number; readonly project: string | undefined };

export class DashboardCommand extends ParsedCommand<DashboardOptions> {
  readonly name = "dashboard";
  readonly summary = "Open the dashboard";
  readonly listing = listed("Program");

  constructor(private readonly runtime: Runtime) {
    super();
  }

  usage(): string {
    return `  tmb dashboard [--port <n>] [--project <dir>]
                            Serve the record as a local web page, on port ${DEFAULT_PORT}
                            unless named; 0 picks a free one`;
  }

  protected parse(args: readonly string[]): DashboardOptions {
    const { values, positionals } = parseArgs({
      args: [...args],
      options: { port: { type: "string" }, project: { type: "string" } },
      allowPositionals: true,
      strict: true,
    });
    noArguments(this.name, positionals);
    const port = values.port === undefined ? DEFAULT_PORT : Number(values.port);
    if (!Number.isInteger(port) || port < 0 || port > MAX_PORT) throw new Error(`--port must be a whole number from 0 to ${MAX_PORT}, got ${values.port}`);
    return { port, project: values.project };
  }

  protected async execute({ port, project }: DashboardOptions): Promise<number> {
    const projectDir = projectRootOf(project ?? this.runtime.cwd());
    // The Human's change to a mirrored issue is written to its remote first, through the syncer.
    const dashboard = startDashboard({ projectDir, port, remoteIssues: remoteIssueWriter(projectDir) });
    this.runtime.out(`tmb dashboard for ${projectDir}: ${dashboard.url}`);
    this.runtime.out("Press Ctrl+C to stop.");
    await this.runtime.untilStopped();
    await dashboard.stop();
    return 0;
  }
}
