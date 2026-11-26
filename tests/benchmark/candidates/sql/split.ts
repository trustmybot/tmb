// Research harness for trustmybot/tmb#339: a .sql file split into statements, so one statement a
// parser cannot read does not lose the rest of the file. The rule is SQLite's sqlite3_complete():
// a statement ends at a semicolon outside a quoted name, a string and a comment, except inside a
// CREATE TRIGGER, which ends at the semicolon after its END.
export function splitStatements(text: string): Array<{ sql: string; line: number }> {
  const out: Array<{ sql: string; line: number }> = [];
  let start = 0;
  let i = 0;
  const close: Record<string, string> = { "'": "'", '"': '"', "`": "`", "[": "]" };
  const push = (end: number): void => {
    const sql = text.slice(start, end).trim();
    if (sql.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, "").trim()) out.push({ sql, line: text.slice(0, start).split("\n").length });
    start = end;
  };
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === "-" && text[i + 1] === "-") {
      const nl = text.indexOf("\n", i);
      i = nl < 0 ? text.length : nl + 1;
    } else if (ch === "/" && text[i + 1] === "*") {
      const e = text.indexOf("*/", i + 2);
      i = e < 0 ? text.length : e + 2;
    } else if (ch in close) {
      const e = text.indexOf(close[ch]!, i + 1);
      i = e < 0 ? text.length : e + 1;
    } else if (ch === ";") {
      const stmt = text.slice(start, i + 1).replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, " ");
      const trigger = /^\s*CREATE\s+(TEMP\s+|TEMPORARY\s+)?TRIGGER\b/i.test(stmt);
      if (!trigger || /\bEND\s*;$/i.test(stmt.trim())) push(i + 1);
      i++;
    } else i++;
  }
  push(text.length);
  return out;
}
