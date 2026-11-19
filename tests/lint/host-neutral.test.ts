// The engine never names a host: only a host's adapter folder and the adapter registry may.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "../..");
const SCANNED = ["src", "roles"];
const ALLOWED = ["src/adapters/claude-code/", "src/adapters/index.ts"];
const HOST_NAME = /claude[ -]?code|\.claude\b|CLAUDE_/i;

function filesUnder(dir: string): string[] {
  return readdirSync(path.join(ROOT, dir), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(ROOT, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"));
}

/** `file:line: text` for each line that names the host. */
function hostMentions(file: string): string[] {
  return readFileSync(path.join(ROOT, file), "utf8")
    .split("\n")
    .flatMap((line, i) => (HOST_NAME.test(line) ? [`${file}:${i + 1}: ${line.trim()}`] : []));
}

const scanned = SCANNED.flatMap(filesUnder);
const isAllowed = (file: string) => ALLOWED.some((allowed) => (allowed.endsWith("/") ? file.startsWith(allowed) : file === allowed));

describe("host-neutral boundary", () => {
  test("no file under src/ or roles/ outside the adapter and the registry names Claude Code", () => {
    const mentions = scanned.filter((file) => !isAllowed(file)).flatMap(hostMentions);
    expect(mentions).toEqual([]);
  });

  test("the scan sees the files it guards and catches a mention", () => {
    expect(scanned).toContain("src/cli.ts");
    expect(scanned).toContain("roles/planner.md");
    expect(scanned.filter((file) => file.startsWith("src/adapters/claude-code/")).flatMap(hostMentions).length).toBeGreaterThan(0);
  });
});
