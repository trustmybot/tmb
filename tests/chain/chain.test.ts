// The check after every step that tmb's printed commands name the program that ran (trustmybot/tmb#268).
import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { plainCommands } from "./chain.ts";
import { World } from "./world.ts";

setDefaultTimeout(30_000);

test("a printed plain `tmb <command>` is found; tmb-dev, a path and the product's name are not", () => {
  const world = new World(mkdtempSync(path.join(tmpdir(), "chain-plain-")));
  world.printed.push(
    { run: "tmb-dev doctor", text: "fix: run tmb-dev init in the project folder\nthe binary is ~/.local/bin/tmb --version\ntmb is not set up here" },
    { run: "git push", text: "remote: refused; run tmb feature waive F1 in your terminal" },
    { run: "tool task_start", text: "start with tmb --help" },
  );
  expect(plainCommands(world)).toEqual(["git push: remote: refused; run tmb feature waive F1 in your terminal", "tool task_start: start with tmb --help"]);
  expect(world.printed).toEqual([]);
  expect(plainCommands(world)).toEqual([]);
});
