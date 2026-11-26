// The language servers of the Python A/B test (trustmybot/tmb#338), each started from the scratch
// folder its tools were installed in, never from the repo or a global install. `tools` is a venv
// holding the Python-side tools, `npm` a folder holding the npm-side ones, and `env` the Python
// environment the repo is read with: an empty venv (no dependencies) or one with the repo's
// dependencies installed.
import path from "node:path";
import type { ServerSpec } from "./lsp.ts";

export type Places = { tools: string; npm: string; env: string };

/** The environment that points a tool at a Python environment, the way a shell's activated venv does. */
const activated = (env: string): Record<string, string> => ({
  VIRTUAL_ENV: env,
  PATH: `${path.join(env, "bin")}:${process.env.PATH ?? ""}`,
});

export const LSP_CANDIDATES = ["pyright", "basedpyright", "pyrefly", "ty", "zuban"] as const;
export type LspCandidate = (typeof LSP_CANDIDATES)[number];

export function serverSpec(name: LspCandidate, p: Places): ServerSpec {
  const python = path.join(p.env, "bin", "python");
  const bin = (tool: string) => path.join(p.tools, "bin", tool);
  switch (name) {
    case "pyright":
      return {
        name,
        command: "node",
        args: [path.join(p.npm, "node_modules", "pyright", "langserver.index.js"), "--stdio"],
        env: activated(p.env),
        settings: { python: { pythonPath: python }, "python.analysis": { diagnosticMode: "openFilesOnly" } },
      };
    case "basedpyright":
      return {
        name,
        command: bin("basedpyright-langserver"),
        args: ["--stdio"],
        env: activated(p.env),
        settings: { python: { pythonPath: python }, "basedpyright.analysis": { diagnosticMode: "openFilesOnly" } },
      };
    case "pyrefly":
      return { name, command: bin("pyrefly"), args: ["lsp"], env: activated(p.env), settings: { python: { pythonPath: python } } };
    case "ty":
      return { name, command: bin("ty"), args: ["server"], env: activated(p.env) };
    case "zuban":
      return { name, command: bin("zuban"), args: ["server"], env: activated(p.env) };
  }
}
