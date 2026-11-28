// `tmb init`, `tmb onboard` and `tmb remove` as separate processes, the way the Human runs them:
// init writes the roles' agent files and takes only the host and its role, onboard changes the
// settings as often as asked, and remove takes back what init added. Init's ideal case is flow
// 1.1's test and the first session's is flow 2.1's (tests/workflow).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readdirSync, readFileSync, statSync, writeFileSync, mkdtempSync } from "node:fs";
import path from "node:path";
import { tmbProcesses } from "../../lib/tmb-processes.ts";
import { installPinnedTools } from "../../lib/pinned-tools.ts";

// Every test file sets this: bun's 5s fails slow tests on a busy machine (tests/README.md).
setDefaultTimeout(30_000);

// A machine with tmb's pinned tools installed: init then names no missing tool.
beforeAll(installPinnedTools);

const { scratch, git, run, tmb, human, newProject, config, cleanup } = tmbProcesses("tmb-init-onboard-");

afterAll(cleanup);

/** Every file under `dir` but git's objects, logs and index, with its content; folders end in /. */
function snapshot(dir: string, base = dir): Record<string, string> {
  const files: Record<string, string> = {};
  for (const name of readdirSync(dir)) {
    const file = path.join(dir, name);
    const relative = path.relative(base, file);
    if (["objects", "logs", "index", "ORIG_HEAD"].includes(name) && relative.startsWith(".git")) continue;
    if (statSync(file).isDirectory()) {
      files[`${relative}/`] = "";
      Object.assign(files, snapshot(file, base));
    } else {
      files[relative] = readFileSync(file, "utf8");
    }
  }
  return files;
}

describe("tmb init", () => {
  test("the reviewer's agent file takes away exactly the three editing tools, and the worker's takes away none", () => {
    const project = newProject();
    expect(run(["init"], project).status).toBe(0);
    const frontmatter = (role: string) => readFileSync(path.join(project, ".claude", "agents", `${role}.md`), "utf8").split(/^---$/m)[1]!;
    const denied = (role: string) => {
      const line = /^disallowedTools: (.*)$/m.exec(frontmatter(role));
      return line ? (JSON.parse(line[1]!) as string).split(", ") : [];
    };
    expect(denied("reviewer")).toEqual(["Edit", "Write", "NotebookEdit"]);
    expect(denied("worker")).toEqual([]);
    for (const role of ["reviewer", "worker"]) expect(frontmatter(role)).not.toMatch(/^tools:/m);
  });

  test("in a folder with no repo, runs git init first, so its own files are ignored on the first run (trustmybot/tmb#180)", () => {
    const project = mkdtempSync(path.join(scratch, "bare-"));
    writeFileSync(path.join(project, "notes.md"), "# notes\n");
    expect(tmb(["init"], project)).toContain("so tmb ran git init in it");
    const status = git(project, "status", "--porcelain", "--untracked-files=all");
    expect(status).toContain("notes.md");
    expect(status).not.toContain(".tmb/");
    expect(status).not.toContain(".mcp.json");
    expect(status).not.toContain("settings.local.json");
  });

  test("takes only the host and its role", () => {
    for (const flag of ["--yes", "--base"]) {
      const result = run(["init", flag, ...(flag === "--base" ? ["main"] : [])], newProject());
      expect(result.status).toBe(2);
      expect(result.stderr).toContain(flag);
    }
  });
});

describe("tmb onboard", () => {
  test("refuses a project init has not prepared, and writes nothing", () => {
    const project = newProject();
    const before = snapshot(project);
    const result = run(["onboard", "--base", "main"], project);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("tmb is not set up in this project; run tmb init first");
    expect(snapshot(project)).toEqual(before);
  });

  test("changes a setting, and can be run again to change another", () => {
    const project = newProject();
    tmb(["init"], project);
    expect(tmb(["onboard", "--base", "release"], project)).toContain("Recorded 2 changes in the record's setting changes.");
    expect(config(project)).toMatchObject({ base_branch: "release", review_mode: null, checks: ["bun run test"] });
    expect(human(["onboard", "--review-mode", "truest", "--role", "reviewer", "--yes"], project)).toContain("Recorded 2 changes in the record's setting changes.");
    expect(config(project)).toEqual({ host: "claude-code", host_roles: { "claude-code": "reviewer" }, base_branch: "release", review_mode: "truest", checks: ["bun run test"], shared_folders: null, graph_links: null });
    expect(tmb(["onboard"], project)).toContain("No setting changed, so nothing was recorded.");
  }, 30_000);
});

describe("tmb remove", () => {
  test("undoes what init added, keeping the record and the .gitignore lines", () => {
    const project = newProject();
    const before = snapshot(project);
    tmb(["init"], project);
    expect(snapshot(project)).not.toEqual(before);
    human(["remove", path.basename(project)], project);
    const after = snapshot(project);
    // The record is the Human's data, and remove never edits .gitignore.
    for (const kept of Object.keys(after).filter((file) => file === ".gitignore" || file.startsWith(".tmb"))) delete after[kept];
    expect(after).toEqual(before);
  });
});

describe("tmb setup", () => {
  test("is gone: it is refused as an unknown command, and writes nothing", () => {
    const project = newProject();
    const before = snapshot(project);
    const result = run(["setup", "--yes"], project);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("setup");
    expect(snapshot(project)).toEqual(before);
  });
});
