import pkg from "../../package.json" with { type: "json" };

// Injected by scripts/build.ts with --define; absent when run from source.
declare const TMB_GIT_SHA: string | undefined;
declare const TMB_VERSION: string | undefined;

export const version: string = typeof TMB_VERSION === "string" ? TMB_VERSION : pkg.version;
export const gitSha: string = typeof TMB_GIT_SHA === "string" ? TMB_GIT_SHA : "source";

/** `<program> <version> (<sha>), on the <channel> channel`: the version is always the second word. */
export function versionLine(program: { name: string; channel: string | null } = { name: "tmb", channel: null }): string {
  const follows = program.channel === null ? "pinned: it never updates itself" : `on the ${program.channel} channel`;
  return `${program.name} ${version} (${gitSha}), ${follows}`;
}
