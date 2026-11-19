// Two hosts open on one project at once: each runs its own tool server process on the same
// record, and both write at the same time. Every write lands, each names the host that made
// it, and the database stays whole.
import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { openProjectStore, projectDbPath } from "../../src/engine/index.ts";
import { CLI, callJson, tmbProcesses } from "./tmb-processes.ts";

const t = tmbProcesses("tmb-two-hosts-");
afterAll(() => t.cleanup());

const WRITES_PER_HOST = 25;

async function connectAs(project: string, host: string): Promise<Client> {
  const client = new Client({ name: `two-hosts-${host}`, version: "0.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp", "--host", host, "--project", project], env: t.env, stderr: "pipe" }));
  return client;
}

describe("two hosts on one record", () => {
  test("write at the same time through their own tool servers without losing or mixing up a record", async () => {
    const project = t.setUpProject("true");
    const hosts = ["host-a", "host-b"];
    const clients = await Promise.all(hosts.map((host) => connectAs(project, host)));
    try {
      const created = await Promise.all(
        clients.map((client, i) =>
          Promise.all(
            Array.from({ length: WRITES_PER_HOST }, (_, n) =>
              callJson<{ id: string }>(client, "issue_create", { title: `${hosts[i]} issue ${n}`, role: i === 0 ? "planner" : "reviewer" }),
            ),
          ),
        ),
      );

      const opened = openProjectStore(project, { create: false });
      if (!opened.ok) throw opened.error;
      try {
        hosts.forEach((host, i) => {
          for (const { id } of created[i]!) {
            const issue = opened.store.getIssue(id)!;
            expect(issue.title).toStartWith(`${host} issue `);
            expect(issue.createdBy).toEqual({ kind: "agent", role: i === 0 ? "planner" : "reviewer", host });
          }
        });
        expect(opened.store.listIssues()).toHaveLength(hosts.length * WRITES_PER_HOST);
        expect(new Set(created.flat().map(({ id }) => id)).size).toBe(hosts.length * WRITES_PER_HOST);
      } finally {
        opened.store.close();
      }

      const db = new Database(projectDbPath(project), { readonly: true });
      try {
        expect(db.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      } finally {
        db.close();
      }
    } finally {
      await Promise.all(clients.map((client) => client.close()));
    }
  }, 60_000);
});
