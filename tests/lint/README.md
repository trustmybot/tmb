# Lint tests

Static checks on code and docs. They run on every pull request ([all layers](../README.md)).

| Test | What it proves |
|---|---|
| `bun run typecheck` | The engine type-checks, and the dashboard's pages type-check under their own [tsconfig](../../src/dashboard/web/tsconfig.json). |
| [`.dependency-cruiser.json`](../../.dependency-cruiser.json), `bun run lint:boundaries` | `src/` holds one folder per component: engine, cli, dashboard, adapters, syncer. The engine imports none of the others; dashboard, adapters and syncer import only the engine; nothing imports the cli; another component is reached only through its `index.ts`. Checked by dependency-cruiser. |
| [links.test.ts](links.test.ts), `bun run lint:links` | Every relative link in a tracked markdown file reaches a file that exists, and an anchor matches a heading. |
| [test-timeout.test.ts](test-timeout.test.ts) | Every `bun test` file sets its timeout ([why](../README.md#rules-for-every-test)). |
| [host-neutral.test.ts](host-neutral.test.ts) | The engine names no host; only the adapters do. |
| [role-size.test.ts](role-size.test.ts) | Every role file in `roles/` is at most 8,000 characters, below the 10,000 a host shows of a hook's text. |
