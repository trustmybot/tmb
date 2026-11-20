// A stand-in for GitHub: a fake `gh` on PATH backed by a JSON file, enough for tmb's mark on a
// reviewed commit. It keeps the commit statuses tmb sets, but only on a commit the bare origin
// has (any other gets 422, as on GitHub), answers whether a branch's protection requires a
// status check, and opens a pull request. A project is pointed at it by giving its
// origin a GitHub address that git rewrites to the bare repository, so pushes still go there.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export type Status = { state: string; context: string; description: string };
type State = { statuses: Record<string, Status[]>; protection: Record<string, string[]>; origins: string[] };

export const GITHUB_URL = "https://github.com/example/project.git";
export const PR_URL = "https://github.com/example/project/pull/1";

// The fake gh's program: `gh api` reads and writes the state file, `gh pr` opens a pull request.
const PROGRAM = `
const { appendFileSync, existsSync, readFileSync, writeFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const [statePath, downPath, logPath, ...args] = process.argv.slice(2);
appendFileSync(logPath, args.join(" ") + "\\n");
const fail = (said) => { process.stderr.write(said + "\\n"); process.exit(1); };
if (args[0] === "pr" && args[1] === "create") { console.log(${JSON.stringify(PR_URL)}); process.exit(0); }
if (args[0] === "pr" && args[1] === "list") process.exit(0);
if (args[0] !== "api") fail("unknown command " + args.join(" "));
if (existsSync(downPath)) fail("HTTP 502: Bad Gateway");
let method = "GET", endpoint = null; const fields = {};
for (let i = 1; i < args.length; i++) {
  if (args[i] === "--hostname") i++;
  else if (args[i] === "--method") method = args[++i];
  else if (args[i] === "-f") { const field = args[++i]; const at = field.indexOf("="); fields[field.slice(0, at)] = field.slice(at + 1); }
  else endpoint = args[i];
}
const state = JSON.parse(readFileSync(statePath, "utf8"));
const status = /^repos\\/example\\/project\\/statuses\\/([0-9a-f]{40})$/.exec(endpoint);
if (method === "POST" && status) {
  // GitHub keeps a status only on a commit it has: one pushed to origin.
  const has = state.origins.some((bare) => spawnSync("git", ["-C", bare, "cat-file", "-e", status[1] + "^{commit}"]).status === 0);
  if (!has) fail("HTTP 422: No commit found for SHA: " + status[1]);
  (state.statuses[status[1]] ??= []).push({ state: fields.state, context: fields.context, description: fields.description });
  writeFileSync(statePath, JSON.stringify(state));
  console.log(JSON.stringify({ state: fields.state, context: fields.context }));
  process.exit(0);
}
const rule = /^repos\\/example\\/project\\/branches\\/(.+)\\/protection\\/required_status_checks$/.exec(endpoint);
if (method === "GET" && rule) {
  const contexts = state.protection[decodeURIComponent(rule[1])];
  if (contexts === undefined) fail("gh: Branch not protected (HTTP 404: Not Found)");
  console.log(JSON.stringify({ strict: false, contexts }));
  process.exit(0);
}
fail("HTTP 404: Not Found (" + method + " " + endpoint + ")");
`;

/** Puts the stand-in's `gh` first on `env.PATH`; returns what a test reads and sets on it. */
export function githubStandIn(scratch: string, env: Record<string, string>, git: (cwd: string, ...args: string[]) => string) {
  const folder = path.join(scratch, "github-stand-in");
  const bin = path.join(folder, "bin");
  mkdirSync(bin, { recursive: true });
  const statePath = path.join(folder, "state.json");
  const downPath = path.join(folder, "down");
  const logPath = path.join(folder, "gh.log");
  const programPath = path.join(folder, "gh.cjs");
  writeFileSync(statePath, JSON.stringify({ statuses: {}, protection: {}, origins: [] } satisfies State));
  writeFileSync(logPath, "");
  writeFileSync(programPath, PROGRAM);
  writeFileSync(path.join(bin, "gh"), `#!/bin/sh\nexec '${process.execPath}' '${programPath}' '${statePath}' '${downPath}' '${logPath}' "$@"\n`, { mode: 0o755 });
  env.PATH = `${bin}${path.delimiter}${env.PATH}`;

  const read = (): State => JSON.parse(readFileSync(statePath, "utf8")) as State;
  return {
    /** The statuses set on `sha`, oldest first. */
    statuses(sha: string): Status[] {
      return read().statuses[sha] ?? [];
    },
    /** Sets the status checks `branch`'s protection requires; null for no such rule. */
    protect(branch: string, contexts: string[] | null): void {
      const state = read();
      if (contexts === null) delete state.protection[branch];
      else state.protection[branch] = contexts;
      writeFileSync(statePath, JSON.stringify(state));
    },
    /** Takes GitHub out of reach (every `gh api` call fails) or brings it back. */
    down(isDown: boolean): void {
      if (isDown) writeFileSync(downPath, "");
      else if (existsSync(downPath)) rmSync(downPath);
    },
    log(): string {
      return readFileSync(logPath, "utf8");
    },
    /** Gives the project's origin the stand-in's GitHub address; git still pushes to and fetches from the bare repository. */
    point(project: string): void {
      const bare = git(project, "config", "--get", "remote.origin.url");
      git(project, "config", `url.${bare}.insteadOf`, GITHUB_URL);
      git(project, "config", "remote.origin.url", GITHUB_URL);
      const state = read();
      state.origins.push(bare);
      writeFileSync(statePath, JSON.stringify(state));
    },
  };
}
