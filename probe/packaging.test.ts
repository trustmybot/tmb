import { describe, expect, setDefaultTimeout, test } from "bun:test";
import path from "node:path";
import { ECHO_TOOL, checkFts, checkServe, handleRequest, parseSymbols } from "./packaging.ts";

// Every test file sets this: bun's 5s fails slow tests on a busy machine (tests/README.md).
setDefaultTimeout(30_000);

describe("packaging probe", () => {
  test("FTS5 MATCH finds the one matching row", () => {
    expect(checkFts()).toContain("gamma");
  });

  test("parses a function, a class and an exported const from TypeScript", async () => {
    expect(await parseSymbols()).toEqual(["greet", "Greeter", "answer"]);
  });

  test("serve answers initialize and echoes a tools/call over stdio", async () => {
    const script = path.join(import.meta.dir, "packaging.ts");
    expect(await checkServe(process.execPath, [script, "serve"])).toContain("hello from the probe");
  }, 20_000);

  test("serve lists the echo tool and rejects unknown tools and methods", () => {
    expect(handleRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" })).toMatchObject({
      result: { tools: [{ name: ECHO_TOOL }] },
    });
    expect(
      handleRequest({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "nope", arguments: { text: "x" } } }),
    ).toMatchObject({ error: { code: -32602 } });
    expect(handleRequest({ jsonrpc: "2.0", id: 3, method: "nope" })).toMatchObject({ error: { code: -32601 } });
    expect(handleRequest({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
  });
});
