// Research harness for trustmybot/tmb#339: the start-up cost of each candidate, in a fresh process.
//   bun tests/benchmark/candidates/sql/startup.ts [runs]
// Each run spawns a new bun that loads one candidate and reads one statement: the time to the first
// answer (import, wasm start, first parse) and the time of a second statement after it.
import { spawnSync } from "node:child_process";
import { CANDIDATES, dialectFor } from "./candidates.ts";

const SQL = "SELECT o.id FROM orders o JOIN users u ON u.id = o.user_id";
const arg = process.argv[2];
if (arg?.startsWith("--one=")) {
  const c = CANDIDATES.find((x) => x.name === arg.slice(6))!;
  const t0 = performance.now();
  await c.run(SQL, dialectFor(c, "sqlite"));
  const t1 = performance.now();
  await c.run("UPDATE orders SET paid = 1 WHERE id = ?", dialectFor(c, "sqlite"));
  const t2 = performance.now();
  console.log(JSON.stringify({ first: t1 - t0, second: t2 - t1, rss: process.memoryUsage().rss }));
} else {
  const runs = Number(arg ?? "5");
  console.log("| Candidate | First answer, median ms | Second statement, median ms | RSS after, MB |");
  console.log("|---|---|---|---|");
  for (const c of CANDIDATES) {
    if (c.name.startsWith("today")) continue;
    const xs = Array.from({ length: runs }, () => {
      const r = spawnSync(process.execPath, [import.meta.path, `--one=${c.name}`], { encoding: "utf8", env: process.env });
      return JSON.parse(r.stdout.trim().split("\n").pop()!) as { first: number; second: number; rss: number };
    });
    const med = (f: (x: (typeof xs)[0]) => number) => xs.map(f).sort((a, b) => a - b)[Math.floor(runs / 2)]!;
    console.log(`| ${c.name} | ${med((x) => x.first).toFixed(1)} | ${med((x) => x.second).toFixed(2)} | ${(med((x) => x.rss) / 2 ** 20).toFixed(0)} |`);
  }
}
