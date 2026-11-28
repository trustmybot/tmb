// git as the tests run it: in a folder, as the test author, failing loudly.
import { spawnSync } from "node:child_process";
import { TEST_AUTHOR } from "./values.ts";

/** Runs git in `cwd` as the test author and returns its trimmed output; throws with git's error when it fails. */
export function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-c", `user.name=${TEST_AUTHOR.name}`, "-c", `user.email=${TEST_AUTHOR.email}`, ...args], { cwd, encoding: "utf8", timeout: 10_000 });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}
