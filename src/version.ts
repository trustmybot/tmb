import pkg from "../package.json" with { type: "json" };

// Injected by scripts/build.ts with --define; absent when run from source.
declare const TMB_GIT_SHA: string | undefined;
declare const TMB_VERSION: string | undefined;

export const version: string = typeof TMB_VERSION === "string" ? TMB_VERSION : pkg.version;
export const gitSha: string = typeof TMB_GIT_SHA === "string" ? TMB_GIT_SHA : "source";

export function versionLine(): string {
  return `tmb ${version} (${gitSha})`;
}
