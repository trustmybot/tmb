// The gate every candidate passes before it is measured (trustmybot/tmb#338): in a two-file
// project, the typed call `c = make_cart(); c.total()` must resolve to `Cart.total`. A second
// call, `d = make_cart_inferred(); d.total()`, has no return type written, and shows whether the
// tool works out a return type itself.
//
//   bun tests/benchmark/candidates/python/minimal.ts <scratch> <candidate>...
//
// <scratch> holds tools/ (a venv), npm/ (node_modules) and envs/empty (a venv). The project is
// written to <scratch>/mini.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { askDefinitions } from "./lsp.ts";
import { LSP_CANDIDATES, type LspCandidate, serverSpec } from "./servers.ts";

export const CART = `class Cart:
    def __init__(self) -> None:
        self.items: list[int] = []

    def total(self) -> int:
        return sum(self.items)


def make_cart() -> Cart:
    return Cart()


def make_cart_inferred():
    return Cart()
`;

export const MAIN = `from cart import make_cart, make_cart_inferred


def checkout() -> int:
    c = make_cart()
    return c.total()


def checkout_inferred():
    d = make_cart_inferred()
    return d.total()
`;

/** Where each question's name is written, 0-based, and the declaration it must reach. */
export const QUESTIONS = [
  { what: "typed: c.total()", file: "main.py", line: 5, character: MAIN.split("\n")[5]!.indexOf("total") },
  { what: "inferred: d.total()", file: "main.py", line: 10, character: MAIN.split("\n")[10]!.indexOf("total") },
];
/** `def total` in cart.py, 0-based. */
export const WANT = { file: "cart.py", line: 4 };

export function writeProject(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "cart.py"), CART);
  writeFileSync(path.join(dir, "main.py"), MAIN);
}

if (import.meta.main) {
  const [scratch, ...names] = process.argv.slice(2);
  if (scratch === undefined) throw new Error("usage: minimal.ts <scratch> <candidate>...");
  const dir = path.join(scratch, "mini");
  writeProject(dir);
  const places = { tools: path.join(scratch, "tools"), npm: path.join(scratch, "npm"), env: path.join(scratch, "envs", "empty") };
  for (const name of names.length > 0 ? names : LSP_CANDIDATES) {
    try {
      const { answers, timing, server } = await askDefinitions(serverSpec(name as LspCandidate, places), dir, QUESTIONS);
      answers.forEach((a, i) => {
        const q = QUESTIONS[i]!;
        const got = "error" in a ? `error: ${a.error}` : a.decls.map((d) => `${path.relative(dir, d.file)}:${d.line}:${d.character}`).join(", ") || "no answer";
        const ok = !("error" in a) && a.decls.length === 1 && path.relative(dir, a.decls[0]!.file) === WANT.file && a.decls[0]!.line === WANT.line;
        console.log(`${name}\t${q.what}\t${ok ? "PASS" : "FAIL"}\t${got}`);
      });
      console.log(`${name}\tserver ${JSON.stringify(server)}\tstart ${timing.startMs} ms, answers ${timing.answerMs} ms`);
    } catch (error) {
      console.log(`${name}\tcannot run: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
