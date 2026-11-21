// Serves a folder laid out as tmb's public release repo, on this machine only:
//   bun tests/chain/release-server.ts <release-dir>
// Prints its address on the first line, then serves until it is stopped. It runs in a process of
// its own, so tmb's update can reach it while the chain waits on a command.
import { existsSync, statSync } from "node:fs";
import path from "node:path";

const root = path.resolve(process.argv[2] ?? ".");
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(request) {
    const pathname = decodeURIComponent(new URL(request.url).pathname);
    // The public API lists the releases; the chain's dev channel needs only an empty list.
    if (pathname === "/api/releases") return Response.json([]);
    const file = path.join(root, pathname);
    if (!file.startsWith(root + path.sep) || !existsSync(file) || !statSync(file).isFile()) return new Response("not found", { status: 404 });
    return new Response(Bun.file(file));
  },
});
console.log(`http://127.0.0.1:${server.port}`);
