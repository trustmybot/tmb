import { describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  actionUsage,
  asksHelp,
  colourOn,
  detailHelpText,
  OTHER_NAMES,
  Paint,
  shortHelpText,
  similarCommands,
  typingDistance,
  unknownCommandText,
  usageErrorText,
} from "../../../src/cli/help.ts";

// Every test file sets this: bun's 5s fails slow tests on a busy machine (tests/README.md).
setDefaultTimeout(30_000);

const ESC = "\u001b[";
const COMMANDS = ["init", "onboard", "config", "remove", "migrate", "issue", "note", "feature", "task", "search", "history", "graph", "index", "tools", "dashboard", "update", "help"];

describe("typingDistance", () => {
  test("counts an added, dropped or changed letter as one", () => {
    expect(typingDistance("init", "init")).toBe(0);
    expect(typingDistance("int", "init")).toBe(1);
    expect(typingDistance("initt", "init")).toBe(1);
    expect(typingDistance("inot", "init")).toBe(1);
  });

  test("counts a swap of two neighbouring letters as one", () => {
    expect(typingDistance("inti", "init")).toBe(1);
    expect(typingDistance("clsoe", "close")).toBe(1);
    expect(typingDistance("isuse", "issue")).toBe(1);
  });

  test("adds up several mistakes", () => {
    expect(typingDistance("upgrade", "update")).toBe(3);
    expect(typingDistance("", "init")).toBe(4);
  });
});

describe("similarCommands", () => {
  test("names a command at most two typing mistakes away", () => {
    expect(similarCommands("inti", COMMANDS)).toEqual(["init"]);
    expect(similarCommands("ssearch", COMMANDS)).toEqual(["search"]);
    expect(similarCommands("isseu", COMMANDS)).toEqual(["issue"]);
  });

  test("names a command that starts with what was typed", () => {
    expect(similarCommands("dashb", COMMANDS)).toEqual(["dashboard"]);
    expect(similarCommands("hist", COMMANDS)).toEqual(["history"]);
  });

  test("names every match, sorted", () => {
    expect(similarCommands("h", COMMANDS)).toEqual(["help", "history"]);
  });

  test("names none when none is close", () => {
    expect(similarCommands("deploy", COMMANDS)).toEqual([]);
    expect(similarCommands("", COMMANDS)).toEqual([]);
  });

  test("never names a command it was not given, such as a hidden one", () => {
    expect(similarCommands("hok", COMMANDS)).toEqual([]);
    expect(similarCommands("hok", [...COMMANDS, "hook"])).toEqual(["hook"]);
  });

  test("upgrade is three mistakes from update, so only the table of other names brings the tip", () => {
    expect(similarCommands("upgrade", COMMANDS)).toEqual([]);
    expect(similarCommands("upgrade", COMMANDS, OTHER_NAMES)).toEqual(["update"]);
    expect(similarCommands("upgrade", ["init"], OTHER_NAMES)).toEqual([]);
  });

  test("an inherited property is not another name", () => {
    expect(similarCommands("constructor", COMMANDS, OTHER_NAMES)).toEqual([]);
  });
});

describe("colourOn", () => {
  const tty = { isTTY: true };
  const pipe = { isTTY: false };

  test("colours a terminal and not a pipe or a file", () => {
    expect(colourOn(tty, {})).toBe(true);
    expect(colourOn(pipe, {})).toBe(false);
    expect(colourOn({}, {})).toBe(false);
  });

  test("NO_COLOR set and not empty turns it off", () => {
    expect(colourOn(tty, { NO_COLOR: "1" })).toBe(false);
    expect(colourOn(tty, { NO_COLOR: "" })).toBe(true);
  });

  test("TERM=dumb turns it off", () => {
    expect(colourOn(tty, { TERM: "dumb" })).toBe(false);
  });

  test("FORCE_COLOR turns it on, even on a pipe", () => {
    expect(colourOn(pipe, { FORCE_COLOR: "1" })).toBe(true);
    expect(colourOn(pipe, { FORCE_COLOR: "" })).toBe(true);
    expect(colourOn(tty, { FORCE_COLOR: "0" })).toBe(false);
    expect(colourOn(pipe, { FORCE_COLOR: "1", TERM: "dumb" })).toBe(true);
  });

  test("NO_COLOR beats FORCE_COLOR", () => {
    expect(colourOn(tty, { NO_COLOR: "1", FORCE_COLOR: "1" })).toBe(false);
  });
});

describe("the texts", () => {
  const plain = new Paint(false);
  const coloured = new Paint(true);

  test("a typo names the closest command and one usage line", () => {
    expect(unknownCommandText("tmb", "inti", COMMANDS, plain)).toBe(
      "error: unrecognized command 'inti'\n\n  tip: a similar command exists: 'init'\n\nUsage: tmb <COMMAND>\n\nFor more information, try 'tmb --help'.\n",
    );
  });

  test("several matches are all named", () => {
    expect(unknownCommandText("tmb", "h", COMMANDS, plain)).toContain("  tip: some similar commands exist: 'help', 'history'\n");
  });

  test("no match, no tip", () => {
    expect(unknownCommandText("tmb", "deploy", COMMANDS, plain)).toBe("error: unrecognized command 'deploy'\n\nUsage: tmb <COMMAND>\n\nFor more information, try 'tmb --help'.\n");
  });

  test("one level down names that command", () => {
    const text = unknownCommandText("tmb task", "clsoe", ["start", "list", "brief", "close", "waive", "pr"], plain);
    expect(text).toContain("tip: a similar command exists: 'close'");
    expect(text).toContain("Usage: tmb task <COMMAND>");
    expect(text).toContain("try 'tmb task --help'");
  });

  test("a usage error says where to read more", () => {
    expect(usageErrorText("tmb issue", "missing title", plain)).toBe("error: missing title\n\nFor more information, try 'tmb issue --help'.\n");
  });

  test("plain text holds no colour codes, coloured text does", () => {
    expect(unknownCommandText("tmb", "inti", COMMANDS, plain)).not.toContain(ESC);
    const text = unknownCommandText("tmb", "inti", COMMANDS, coloured);
    expect(text).toContain(`${ESC}1m${ESC}31merror:`);
    expect(text).toContain(`${ESC}32mtip:`);
    expect(text).toContain(`${ESC}1m${ESC}36minit`);
  });

  test("the short help groups the commands with summaries in one column", () => {
    const text = shortHelpText(
      [
        { heading: "Project", commands: [{ name: "init", summary: "Prepare this project for tmb" }] },
        { heading: "Program", commands: [{ name: "dashboard", summary: "Open the dashboard" }] },
      ],
      plain,
    );
    expect(text).toBe(
      "Usage: tmb <COMMAND>\n\nProject:\n  init        Prepare this project for tmb\n\nProgram:\n  dashboard   Open the dashboard\n\nUse `tmb help <command>` for details.\n",
    );
    const painted = shortHelpText([{ heading: "Project", commands: [{ name: "init", summary: "x" }] }], coloured);
    expect(painted).toContain(`${ESC}1m${ESC}32mProject:`);
    expect(painted).toContain(`${ESC}36m<COMMAND>`);
  });

  const USAGE = `  tmb task start <issue-id> --kind code|docs
                 --criterion <text>...
                            Start a task
  tmb task close <id>       Close a task
  tmb task closed-list      Not the close action
  Add --json for JSON output.`;

  test("an action's help keeps its entries and the shared notes", () => {
    expect(actionUsage(USAGE, "task", "close")).toBe("  tmb task close <id>       Close a task\n  Add --json for JSON output.");
    expect(actionUsage(USAGE, "task", "start")).toBe(
      "  tmb task start <issue-id> --kind code|docs\n                 --criterion <text>...\n                            Start a task\n  Add --json for JSON output.",
    );
    expect(actionUsage(USAGE, "task")).toBe(USAGE);
  });

  test("a command's detail is its usage under Usage:", () => {
    expect(detailHelpText("  tmb task close <id>       Close a task", plain)).toBe("Usage:\n  tmb task close <id>       Close a task\n");
    const painted = detailHelpText("  tmb task close <id>       Close a task", coloured);
    expect(painted).toContain(`${ESC}1m${ESC}36mtmb task close`);
    expect(painted).toContain(`${ESC}36m<id>`);
  });

  test("asksHelp reads --help and -h before --", () => {
    expect(asksHelp(["--help"])).toBe(true);
    expect(asksHelp(["close", "-h"])).toBe(true);
    expect(asksHelp(["close", "1"])).toBe(false);
    expect(asksHelp(["--", "--help"])).toBe(false);
  });
});
