// The command line's help, typo tips and colour, run as the Human runs tmb: a separate process
// whose output is piped, so it is not a terminal.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CLI } from "../../lib/tmb-processes.ts";

// Every test file sets this: bun's 5s fails slow tests on a busy machine (tests/README.md).
setDefaultTimeout(30_000);

const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), "tmb-cli-help-")));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const ESC = "\u001b[";

function run(args: string[], extraEnv: Record<string, string> = {}) {
  const env: Record<string, string> = { ...(process.env as Record<string, string>), ...extraEnv };
  if (!("NO_COLOR" in extraEnv)) delete env.NO_COLOR;
  if (!("FORCE_COLOR" in extraEnv)) delete env.FORCE_COLOR;
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd: scratch, env, encoding: "utf8", timeout: 30_000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("tmb help", () => {
  test("--help and help print the short grouped help on stdout and exit 0", () => {
    for (const args of [["--help"], ["-h"], ["help"]]) {
      const result = run(args);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toStartWith("Usage: tmb <COMMAND>\n");
      for (const heading of ["Project:", "Work:", "Code:", "Program:"]) expect(result.stdout).toContain(`\n${heading}\n`);
      expect(result.stdout).toContain("\n  update      Look for a newer build\n");
      expect(result.stdout).toContain("Use `tmb help <command>` for details.");
      expect(result.stdout.split("\n").length).toBeLessThan(40);
    }
  });

  test("bare tmb prints the short help on stderr and exits 2", () => {
    const result = run([]);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toStartWith("Usage: tmb <COMMAND>\n");
  });

  test("the commands only a host or git calls are hidden, and listed last with --all", () => {
    const short = run(["--help"]).stdout;
    for (const hidden of ["mcp", "hook", "pre-push"]) expect(short).not.toContain(`  ${hidden} `);
    expect(short).not.toContain("Called by a host or git:");
    const all = run(["help", "--all"]).stdout;
    expect(all).toContain("\nCalled by a host or git:\n  mcp ");
    expect(all.indexOf("Called by a host or git:")).toBeGreaterThan(all.indexOf("Program:"));
    expect(run(["--help", "--all"]).stdout).toBe(all);
  });

  test("every command answers --help with its own detail", () => {
    for (const command of ["init", "onboard", "config", "remove", "purge", "migrate", "issue", "note", "feature", "task", "search", "history", "graph", "index", "tools", "dashboard", "update", "help", "mcp", "hook", "pre-push"]) {
      const result = run([command, "--help"]);
      expect(result.status).toBe(0);
      expect(result.stdout).toStartWith(`Usage:\n  tmb ${command}`);
      expect(run(["help", command]).stdout).toBe(result.stdout);
    }
  });

  test("a sub-command answers --help with its own lines only", () => {
    const result = run(["task", "close", "--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("  tmb task close <id>");
    expect(result.stdout).not.toContain("tmb task start");
    expect(run(["help", "task", "close"]).stdout).toBe(result.stdout);
  });
});

describe("an unknown command", () => {
  test("prints the tip and one usage line on stderr, and exits 2", () => {
    const result = run(["inti"]);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("error: unrecognized command 'inti'\n\n  tip: a similar command exists: 'init'\n\nUsage: tmb <COMMAND>\n\nFor more information, try 'tmb --help'.\n");
  });

  test("tmb upgrade is not a command, and its tip names update", () => {
    const result = run(["upgrade"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("error: unrecognized command 'upgrade'");
    expect(result.stderr).toContain("tip: a similar command exists: 'update'");
  });

  test("a hidden command is never suggested", () => {
    expect(run(["hok"]).stderr).not.toContain("tip:");
  });

  test("one level down, the tip names that command's action", () => {
    const result = run(["task", "clsoe"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("tip: a similar command exists: 'close'");
    expect(result.stderr).toContain("Usage: tmb task <COMMAND>");
    expect(run(["help", "task", "clsoe"]).status).toBe(2);
  });

  test("help for an unknown command is the same typo", () => {
    const result = run(["help", "inti"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("tip: a similar command exists: 'init'");
  });

  test("a flag a command does not take is a usage error with exit 2", () => {
    const result = run(["init", "--bogus"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toStartWith("error: ");
    expect(result.stderr).toContain("For more information, try 'tmb init --help'.");
  });
});

describe("colour", () => {
  test("piped output holds no colour codes", () => {
    expect(run(["--help"]).stdout).not.toContain(ESC);
    expect(run(["inti"]).stderr).not.toContain(ESC);
  });

  test("FORCE_COLOR colours a pipe", () => {
    expect(run(["--help"], { FORCE_COLOR: "1" }).stdout).toContain(ESC);
    expect(run(["inti"], { FORCE_COLOR: "1" }).stderr).toContain(`${ESC}1m${ESC}31merror:`);
  });

  test("NO_COLOR holds no colour codes, even with FORCE_COLOR", () => {
    expect(run(["--help"], { NO_COLOR: "1" }).stdout).not.toContain(ESC);
    expect(run(["--help"], { NO_COLOR: "1", FORCE_COLOR: "1" }).stdout).not.toContain(ESC);
    expect(run(["inti"], { NO_COLOR: "1", FORCE_COLOR: "1" }).stderr).not.toContain(ESC);
  });
});
