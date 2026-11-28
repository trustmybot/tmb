// A fixture language for the registry's test (trustmybot/tmb#157): it claims Linguist's Janet
// (`.janet` files, a language no real module reads, trustmybot/tmb#154) and reads it by toy
// patterns. Each `fn NAME` line opens a function and each `call NAME` line inside it calls one.
import type { LanguageModule } from "../../../../../../src/engine/graph/languages/contract.ts";
import { md5 } from "../../../../../../src/engine/graph/languages/kit.ts";

export const toy: LanguageModule = {
  name: "toy",
  linguist: ["Janet"],
  endings: [".janet"],
  comment: "hash",
  extract(file, out) {
    let current: number | null = null;
    file.src.split("\n").forEach((line, i) => {
      const def = /^fn\s+(\w+)/.exec(line);
      if (def) {
        current = out.symbol({
          kind: "function",
          qualified_name: def[1]!,
          signature: line.trim(),
          doc: "",
          start_line: i + 1,
          end_line: i + 1,
          body_hash: md5(line),
          exported: 1,
          parent: file.module,
        });
        return;
      }
      const call = /^\s+call\s+(\w+)/.exec(line);
      if (call && current !== null) out.edge(current, "calls", call[1]!, i + 1);
    });
  },
};
