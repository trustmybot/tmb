# Research harness for trustmybot/tmb#339: sqlglot's answer, one JSON line in and out per unit.
# Each table is read from sqlglot's tree; its role comes from the statement field it sits in.
# A CTE's name is no table. Run with -I.
import json
import sys

import sqlglot
from sqlglot import exp


def role(table, stmt):
    node, parent = table, table.parent
    while parent is not None:
        if isinstance(parent, exp.Schema):
            node, parent = parent, parent.parent
            continue
        key = node.arg_key
        if isinstance(parent, (exp.Insert, exp.Update, exp.Delete, exp.Merge, exp.Copy)) and key == "this":
            return "write"
        if isinstance(parent, exp.Delete) and key == "tables":
            return "write"
        if isinstance(parent, exp.TruncateTable) and key == "expressions":
            return "write"
        if isinstance(parent, (exp.Drop, exp.Alter)) and key in ("this", "tables"):
            return "write"
        if isinstance(parent, exp.Create) and key == "this":
            kind = (parent.args.get("kind") or "").upper()
            if kind in ("TABLE", "VIEW"):
                return "define"
            return None
        if isinstance(parent, exp.Index) and key == "table":
            return "write"
        if isinstance(parent, (exp.Query, exp.Subquery, exp.Join, exp.From)):
            return "read"
        node, parent = parent, parent.parent
    return "read"


def tables(sql, dialect):
    refs, qualified = [], []
    for stmt in sqlglot.parse(sql, read=dialect):
        if stmt is None:
            continue
        if isinstance(stmt, exp.Command):
            raise ValueError("unparsed command: " + stmt.sql()[:60])
        ctes = {c.alias_or_name.lower() for c in stmt.find_all(exp.CTE)}
        aliases = {t.alias.lower(): t for t in stmt.find_all(exp.Table) if t.alias}
        for t in stmt.find_all(exp.Table):
            if not t.name:
                continue
            # A foreign key's REFERENCES links two tables inside the store: no link.
            if t.find_ancestor(exp.Reference, exp.ForeignKey) is not None:
                continue
            r = role(t, stmt)
            if r is None:
                continue
            target = t
            if r == "write" and not t.db and t.name.lower() in aliases and aliases[t.name.lower()] is not t:
                target = aliases[t.name.lower()]
            if r == "read" and not target.db and target.name.lower() in ctes:
                continue
            refs.append(r + ":" + target.name)
            parts = [p for p in (target.catalog, target.db, target.name) if p]
            if len(parts) > 1:
                qualified.append(".".join(parts))
    return refs, qualified


for line in sys.stdin:
    item = json.loads(line)
    try:
        refs, qualified = tables(item["sql"], item["dialect"])
        out = {"ok": True, "refs": refs, "qualified": qualified}
    except Exception as e:  # noqa: BLE001 - a parse failure is an answer
        out = {"ok": False, "refs": [], "error": str(e)[:200]}
    print(json.dumps(out), flush=True)
