// The chained test's world: one work folder holding an empty HOME, the demo app's project, its
// bare remotes, the release tmb installs from and the logs. Every command of the chain runs
// through here, with the same environment: the empty HOME, a PATH of only what the chain needs,
// and tmb's release repo served from this machine, so GitHub is never reached.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { asHuman, type HumanRun } from "../lib/as-human.ts";
import { Github } from "./github.ts";

export type Result = { status: number; stdout: string; stderr: string; output: string };

/** The repos of the demo app, and which of them have a remote. */
export const REPOS = ["api", "tools", "notes"] as const;
export type RepoName = (typeof REPOS)[number];
export const REMOTE_REPOS: readonly RepoName[] = ["api", "tools"];
export const BASE = "main";

/** The name the dev channel installs tmb under. */
export const PROGRAM = "tmb-dev";

/** The tools the chain's PATH holds besides the system's own folders, linked into one folder. */
const TOOLS = ["bun", "claude", "git", "python3", "curl", "sqlite3"];
const SYSTEM_PATH = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];

export class World {
  readonly home: string;
  readonly tmp: string;
  readonly project: string;
  readonly remotes: string;
  readonly bin: string;
  readonly logs: string;
  /** Set once the release server is up: tmb's release repo on this machine. */
  releasesUrl = "";
  /** tmb's release repo on disk, the newer build the update step publishes, and its asset name. */
  release = { dir: "", next: "", asset: "" };
  /** What tmb printed since the last after-step check, by the command that printed it (trustmybot/tmb#268). */
  printed: { run: string; text: string }[] = [];

  constructor(readonly work: string) {
    this.home = path.join(work, "home");
    this.tmp = path.join(work, "tmp");
    this.project = path.join(work, "todo");
    this.remotes = path.join(work, "remotes");
    this.bin = path.join(work, "bin");
    this.logs = path.join(work, "logs");
  }

  /** Makes the folders and links the tools; the HOME starts empty but for git's identity. */
  prepare(): void {
    for (const dir of [this.home, this.tmp, this.remotes, this.bin, this.logs]) mkdirSync(dir, { recursive: true });
    for (const tool of TOOLS) {
      const found = Bun.which(tool, { PATH: process.env.PATH ?? "" });
      const link = path.join(this.bin, tool);
      if (found && !existsSync(link) && !SYSTEM_PATH.includes(path.dirname(found))) symlinkSync(found, link);
    }
    // A person who uses git has told it who they are; tmb's commits use that identity.
    // GitHub's stand-in: a fake gh, with its pull requests kept beside the bare remotes.
    new Github(this).install();
    const gitconfig = path.join(this.home, ".gitconfig");
    if (!existsSync(gitconfig)) writeFileSync(gitconfig, "[user]\n\tname = Demo Human\n\temail = human@example.com\n[init]\n\tdefaultBranch = main\n");
  }

  /** The repo's folder in the project. */
  repo(name: RepoName): string {
    return path.join(this.project, name);
  }

  /** The repo's bare remote. */
  remote(name: RepoName): string {
    return path.join(this.remotes, `${name}.git`);
  }

  /** Where the installer puts tmb. */
  get installed(): string {
    return path.join(this.home, ".local", "bin", PROGRAM);
  }

  /** The environment of every command; `installedOnPath` false is a shell opened before the install. */
  env(extra: Record<string, string | undefined> = {}, installedOnPath = true): Record<string, string> {
    const keep = ["LANG", "LC_ALL", "TERM", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "TMB_CHAIN_MODEL"];
    const env: Record<string, string> = {};
    for (const name of keep) if (process.env[name]) env[name] = process.env[name]!;
    Object.assign(env, {
      HOME: this.home,
      TMPDIR: this.tmp,
      SHELL: "/bin/sh",
      USER: "human",
      PATH: [...(installedOnPath ? [path.dirname(this.installed)] : []), this.bin, ...SYSTEM_PATH].join(path.delimiter),
      TMB_RELEASES_URL: this.releasesUrl,
      TMB_RELEASES_API: `${this.releasesUrl}/api`,
      // The feedback program asks its question at the first run; a person would answer it once.
      TMB_NO_FEEDBACK: "1",
    });
    for (const [name, value] of Object.entries(extra)) {
      if (value === undefined) delete env[name];
      else env[name] = value;
    }
    return env;
  }

  /** Runs a command to its end with the chain's environment. */
  run(command: string, args: string[], options: { cwd?: string; input?: string; env?: Record<string, string | undefined>; installedOnPath?: boolean; timeout?: number } = {}): Result {
    const result = spawnSync(command, args, {
      cwd: options.cwd ?? this.project,
      env: this.env(options.env, options.installedOnPath ?? true),
      input: options.input ?? "",
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      timeout: options.timeout ?? 300_000,
    });
    const stdout = result.stdout ?? "";
    const stderr = result.error ? `${result.stderr ?? ""}${result.error.message}\n` : (result.stderr ?? "");
    // tmb's own output, and a push's, which carries the push gate's words.
    if (command === PROGRAM || (command === "git" && args.includes("push"))) this.printed.push({ run: `${command} ${args.join(" ")}`, text: stdout + stderr });
    return { status: result.status ?? -1, stdout, stderr, output: stdout + stderr };
  }

  /** Runs the installed tmb, as a command the Human types with no terminal. */
  tmb(args: string[], options: { cwd?: string; env?: Record<string, string | undefined>; input?: string } = {}): Result {
    return this.run(PROGRAM, args, options);
  }

  /** Runs `tmb <args> --json` and parses what it prints; throws with its output when it is not JSON. */
  tmbJson<T = unknown>(args: string[], options: { cwd?: string } = {}): T {
    const result = this.tmb([...args, "--json"], options);
    try {
      return JSON.parse(result.stdout) as T;
    } catch {
      throw new Error(`${PROGRAM} ${args.join(" ")} --json printed no JSON (exit ${result.status}): ${result.output}`);
    }
  }

  /** Runs a step only the Human may take, on a terminal, typing each answer (yes by default). */
  human(args: string[], options: { cwd?: string; answers?: string[] } = {}): HumanRun {
    const result = asHuman(PROGRAM, args, { cwd: options.cwd ?? this.project, env: this.env(), answers: options.answers });
    this.printed.push({ run: `${PROGRAM} ${args.join(" ")}`, text: result.output });
    return result;
  }

  /** git in `cwd`; returns its trimmed stdout and throws with its output on an error. */
  git(cwd: string, ...args: string[]): string {
    const result = this.run("git", args, { cwd });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")} in ${cwd}: ${result.output.trim()}`);
    return result.stdout.trim();
  }

  /** Saves `text` to a log file named for the step; returns its path. */
  log(name: string, text: string): string {
    const file = path.join(this.logs, name);
    writeFileSync(file, text);
    return file;
  }

  read(file: string): string {
    return readFileSync(file, "utf8");
  }
}
