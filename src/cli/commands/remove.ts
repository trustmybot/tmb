// `tmb remove <project-name>`: undo what init added, for one host or for every host and the push gate.
// `tmb purge <project-name>`: what `tmb remove` does for every host, then delete the project's record for good.
// Both run inside the project and name its home folder, so neither acts on a project by mistake.
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { adapterById, HOST_ADAPTERS } from "../../adapters/index.ts";
import { PROJECT_DIR_NAME, projectDbPath, projectRootOf, removePushGates } from "../../engine/index.ts";
import { listed, ParsedCommand, UsageError } from "../command.ts";
import type { Runtime } from "../runtime.ts";

/** True for a folder's bare name, as `backend`: not `.`, `..` or a path. */
export function isFolderName(given: string): boolean {
  return given !== "" && given !== "." && given !== ".." && !/[\\/]/.test(given);
}

/** The project `cwd` is in, or null outside any: the nearest folder at or above it holding a record. */
function projectAt(cwd: string): string | null {
  const root = projectRootOf(cwd);
  return existsSync(projectDbPath(root)) ? root : null;
}

/**
 * The home folder of the project `cwd` is in, when `name` is that folder's name; remove and purge
 * name it, so neither acts on a project the Human did not mean.
 */
export function projectHome(cwd: string, name: string): { ok: true; dir: string } | { ok: false; reason: string } {
  const home = projectAt(cwd);
  if (home === null) return { ok: false, reason: `${path.resolve(cwd)} is in no tmb project: no record (${PROJECT_DIR_NAME}/) is in it or a folder above it. Run it inside the project.` };
  if (path.basename(home) !== name) return { ok: false, reason: `the project here is ${home}, whose home folder is named ${path.basename(home)}, not ${name}; nothing was done.` };
  return { ok: true, dir: home };
}

/** The project folder's name as parsed: exactly one bare name, else a usage error naming the project found. */
function folderName(command: string, cwd: string, positionals: readonly string[]): string {
  const given = positionals.length === 1 ? positionals[0]! : undefined;
  if (given !== undefined && isFolderName(given)) return given;
  const home = projectAt(cwd);
  const found = home === null ? "no tmb project is here or above" : `the project here is ${home}: run tmb ${command} ${path.basename(home)}`;
  throw new UsageError(`${command} takes the name of the project's home folder, not a path (${found})`);
}

/** The project's home folder, and the host whose wiring goes, or every host's and then the push gate, which serves them all. */
type RemoveOptions = { readonly folder: string; readonly host: string | undefined };

export class RemoveCommand extends ParsedCommand<RemoveOptions> {
  readonly name = "remove";
  readonly summary = "Undo what init added in a project";
  readonly listing = listed("Project");

  constructor(private readonly runtime: Runtime) {
    super();
  }

  usage(): string {
    return `  tmb remove <project-name> [--host <id>]
                            Undo what init added in the project you are in, named by its
                            home folder's name, for one host, or for every host and the push
                            gate when none is named; the record is kept`;
  }

  protected parse(args: readonly string[]): RemoveOptions {
    const { values, positionals } = parseArgs({ args: [...args], options: { host: { type: "string" } }, allowPositionals: true, strict: true });
    return { folder: folderName(this.name, this.runtime.cwd(), positionals), host: values.host };
  }

  protected execute({ folder, host }: RemoveOptions): number {
    const home = projectHome(this.runtime.cwd(), folder);
    if (!home.ok) {
      this.runtime.err(`tmb remove: ${home.reason}`);
      return 1;
    }
    return removeWiring(this.runtime, home.dir, host);
  }
}

/** Removes what init added in `dir`, for `host` or for every host and the push gate; 0 when nothing failed. */
function removeWiring(runtime: Runtime, dir: string, host: string | undefined): number {
  const adapters = host === undefined ? HOST_ADAPTERS : [adapterById(host)];
  // One host's broken config must not leave the others, or the push gate, wired.
  const failures: string[] = [];
  const lines = adapters.flatMap((adapter) => {
    try {
      return adapter.remove(dir);
    } catch (error) {
      failures.push(`tmb could not remove ${adapter.name} (${adapter.id}): ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  });
  if (host === undefined) lines.push(...removePushGates(dir));
  // Each adapter says the record is kept; say it once.
  for (const line of new Set(lines)) runtime.out(line);
  for (const failure of failures) runtime.err(failure);
  return failures.length === 0 ? 0 : 1;
}

/** `tmb purge`: removes tmb from every host and git's push hook, then deletes the record folder; nothing brings it back. */
export class PurgeCommand extends ParsedCommand<string> {
  readonly name = "purge";
  readonly summary = "Undo what init added and delete the record for good";
  readonly listing = listed("Project");

  constructor(private readonly runtime: Runtime) {
    super();
  }

  usage(): string {
    return `  tmb purge <project-name>  Do what remove does for every host in the project you are in,
                            named by its home folder's name, then delete its record (.tmb/)
                            for good: its trajectory cannot be recovered`;
  }

  protected parse(args: readonly string[]): string {
    const { positionals } = parseArgs({ args: [...args], options: {}, allowPositionals: true, strict: true });
    return folderName(this.name, this.runtime.cwd(), positionals);
  }

  protected execute(folder: string): number {
    const home = projectHome(this.runtime.cwd(), folder);
    if (!home.ok) {
      this.runtime.err(`tmb purge: ${home.reason}`);
      return 1;
    }
    if (removeWiring(this.runtime, home.dir, undefined) !== 0) {
      this.runtime.err("tmb purge: the record was kept, since removing tmb's wiring failed; fix that and run purge again");
      return 1;
    }
    const record = path.join(home.dir, PROJECT_DIR_NAME);
    rmSync(record, { recursive: true, force: true });
    this.runtime.out(`Deleted the record ${record}; its trajectory cannot be recovered.`);
    return 0;
  }
}
