// Builds the SQL parser tmb carries (CODE_GRAPH.md, "Data sources"): the crate in
// src/engine/graph/languages/sql/parser, which wraps sqlparser-rs at the version its Cargo.lock
// pins, compiled to WebAssembly by the Rust toolchain rust-toolchain.toml pins.
//   bun scripts/build-sql-parser.ts           writes src/engine/graph/languages/sql/sql-tables.wasm
//   bun scripts/build-sql-parser.ts --check   builds and fails when the carried file differs
// It needs rustup on PATH (RUSTUP_HOME and CARGO_HOME as the caller sets them); rustup installs
// the pinned toolchain and its wasm32-unknown-unknown target on first use. The build is
// reproducible: paths are remapped out of the output, and the build runs in a fresh folder.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const crate = path.join(root, "src", "engine", "graph", "languages", "sql", "parser");
const carried = path.join(root, "src", "engine", "graph", "languages", "sql", "sql-tables.wasm");
const TARGET = "wasm32-unknown-unknown";
const check = process.argv.includes("--check");

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const cargoHome = process.env.CARGO_HOME ?? path.join(process.env.HOME ?? "", ".cargo");
const targetDir = mkdtempSync(path.join(tmpdir(), "tmb-sql-parser-"));
try {
  const result = spawnSync("cargo", ["build", "--release", "--locked", "--target", TARGET, "--target-dir", targetDir], {
    cwd: crate,
    stdio: "inherit",
    env: {
      ...process.env,
      // No path of this machine is left in the output.
      RUSTFLAGS: [`--remap-path-prefix=${crate}=/sql-tables`, `--remap-path-prefix=${cargoHome}=/cargo`, `--remap-path-prefix=${targetDir}=/target`].join(" "),
      SOURCE_DATE_EPOCH: "0",
    },
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
  const built = readFileSync(path.join(targetDir, TARGET, "release", "sql_tables.wasm"));
  if (check) {
    const same = existsSync(carried) && sha256(readFileSync(carried)) === sha256(built);
    console.log(`${same ? "same as" : "differs from"} the carried file: ${sha256(built)}`);
    process.exit(same ? 0 : 1);
  }
  writeFileSync(carried, built);
  console.log(`${path.relative(root, carried)}: ${built.length} bytes, sha256 ${sha256(built)}`);
} finally {
  rmSync(targetDir, { recursive: true, force: true });
}
