// The command table: every command once, in the order the help lists them. The entry runs a call
// by the table, and the help reads it.
import type { Command } from "./command.ts";
import { ConfigCommand } from "./commands/config.ts";
import { DashboardCommand } from "./commands/dashboard.ts";
import { DoctorCommand } from "./commands/doctor/index.ts";
import { FeatureCommand } from "./commands/feature.ts";
import { FeedbackCommand } from "./commands/feedback.ts";
import { GraphCommand } from "./commands/graph.ts";
import { type CommandList, HelpCommand } from "./commands/help.ts";
import { HistoryCommand } from "./commands/history.ts";
import { HookCommand } from "./commands/hook.ts";
import { IndexCommand } from "./commands/index-code.ts";
import { InitCommand } from "./commands/init.ts";
import { IssueCommand } from "./commands/issue.ts";
import { McpCommand } from "./commands/mcp.ts";
import { MigrateCommand } from "./commands/migrate.ts";
import { NoteCommand } from "./commands/note.ts";
import { OnboardCommand } from "./commands/onboard.ts";
import { PrePushCommand } from "./commands/pre-push.ts";
import { PurgeCommand, RemoveCommand } from "./commands/remove.ts";
import { RoleCommand } from "./commands/role.ts";
import { SearchCommand } from "./commands/search.ts";
import { TaskCommand } from "./commands/task.ts";
import { ToolsCommand } from "./commands/tools.ts";
import { UpdateCommand } from "./commands/update.ts";
import type { Runtime } from "./runtime.ts";

export class CommandTable implements CommandList {
  readonly commands: readonly Command[];
  /** The help, which reads this table. */
  readonly help: HelpCommand;
  private readonly byName: ReadonlyMap<string, Command>;

  constructor(runtime: Runtime) {
    this.help = new HelpCommand(runtime, this);
    this.commands = [
      // Project
      new InitCommand(runtime),
      new OnboardCommand(runtime),
      new ConfigCommand(runtime),
      new RemoveCommand(runtime),
      new PurgeCommand(runtime),
      new RoleCommand(runtime),
      new MigrateCommand(runtime),
      // Work
      new IssueCommand(runtime),
      new NoteCommand(runtime),
      new FeatureCommand(runtime),
      new TaskCommand(runtime),
      new SearchCommand(runtime),
      new HistoryCommand(runtime),
      // Code
      new GraphCommand(runtime),
      new IndexCommand(runtime),
      new ToolsCommand(runtime),
      // Program
      new DashboardCommand(runtime),
      new UpdateCommand(runtime),
      new DoctorCommand(runtime),
      new FeedbackCommand(runtime),
      this.help,
      // Called by a host or git
      new McpCommand(runtime),
      new HookCommand(runtime),
      new PrePushCommand(runtime),
    ];
    this.byName = new Map(this.commands.map((command) => [command.name, command]));
  }

  get(name: string): Command | undefined {
    return this.byName.get(name);
  }
}
