import { describe, expect, test } from "bun:test";
import { statements, toolCalls } from "../src/engine/commands.ts";

describe("statements", () => {
  test("splits at separators and removes quotes", () => {
    expect(statements(`a 'b c' "d e"; f && g | h`).map((s) => s.words)).toEqual([["a", "b c", "d e"], ["f"], ["g"], ["h"]]);
  });

  test("marks expansions and reads command substitutions as statements too", () => {
    const found = statements("echo $(git push) `gh pr create` '$x'");
    expect(found.map((s) => s.words[0])).toEqual(["git", "gh", "echo"]);
    expect(found.at(-1)!.expanded).toEqual([false, true, true, false]);
  });

  test("drops comments", () => {
    expect(statements("ls # git push").map((s) => s.words)).toEqual([["ls"]]);
  });
});

describe("toolCalls", () => {
  test("finds git past assignments, prefixes and global options", () => {
    expect(toolCalls("FOO=1 sudo -E git -C /x -c a=b push --no-verify")).toEqual([
      { tool: "git", subcommand: "push", args: ["--no-verify"], config: ["a=b"] },
    ]);
  });

  test("reads gh's two-word subcommand", () => {
    expect(toolCalls("/usr/bin/gh pr create --fill")).toEqual([{ tool: "gh", subcommand: "pr create", args: ["--fill"], config: [] }]);
  });

  test("looks inside sh -c and eval", () => {
    expect(toolCalls(`bash -c "git push"; eval 'gh pr merge 1'`).map((c) => c.subcommand)).toEqual(["push", "pr merge"]);
  });

  test("a subcommand that is not plain text is null", () => {
    expect(toolCalls("git $SUB").map((c) => c.subcommand)).toEqual([null]);
    expect(toolCalls("$GIT push").map((c) => c.subcommand)).toEqual([]);
    expect(toolCalls("$(which git) push").map((c) => c.subcommand)).toContain(null);
  });

  test("other commands are not tool calls", () => {
    expect(toolCalls("bun test && echo git")).toEqual([]);
  });
});
