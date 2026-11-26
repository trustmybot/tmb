"""The Python A/B test's question to mypy (trustmybot/tmb#338): where is the name each call calls
declared? mypy's own answer is its daemon's `inspect --show definition`, asked over the daemon's
socket so each question costs no new process.

Reads {"root", "env", "status", "files": [...], "flags": [...], "questions": [[file, line0,
utf16_character], ...]} as JSON on stdin, runs `dmypy run` on the files, and writes {"version",
"check": {"ms", "out"}, "answers": [{"decls": [...]} or {"error": ...}]}. A declaration is
{"file", "line0", "column", "name"}.

Run with the tools venv's Python and `-I`.
"""

import json
import os
import re
import subprocess
import sys
import time

from mypy.dmypy import client
from mypy.version import __version__

NOWHERE = re.compile(r":-1:-?\d+:[^,\s]+$")
DEFINITION = re.compile(r"^(?!Cannot )(.+?):(\d+):(\d+):([^,\s]+)$", re.M)


def codepoints(line_text, utf16):
    return len(line_text.encode("utf-16-le")[: utf16 * 2].decode("utf-16-le", errors="ignore"))


def main():
    q = json.load(sys.stdin)
    root = q["root"]
    dmypy = os.path.join(os.path.dirname(sys.executable), "dmypy")
    status = q["status"]
    subprocess.run([dmypy, "--status-file", status, "stop"], cwd=root, capture_output=True)
    t = time.time()
    run = subprocess.run(
        [dmypy, "--status-file", status, "run", "--export-types", "--", "--python-executable", q["env"], *q["flags"], *q["files"]],
        cwd=root,
        capture_output=True,
        text=True,
    )
    check = {"ms": round((time.time() - t) * 1000), "out": (run.stdout + run.stderr)[-2000:]}
    answers = []
    texts = {}
    try:
        for file, line0, character in q["questions"]:
            if file not in texts:
                with open(os.path.join(root, file), encoding="utf-8") as f:
                    texts[file] = f.read().split("\n")
            column = codepoints(texts[file][line0], character) + 1
            try:
                os.chdir(root)
                r = client.request(
                    status,
                    "inspect",
                    show="definition",
                    location="%s:%d:%d" % (file, line0 + 1, column),
                    verbosity=0,
                    limit=0,
                    include_span=False,
                    include_kind=False,
                    include_object_attrs=False,
                    union_attrs=False,
                    force_reload=False,
                )
            except Exception as e:
                answers.append({"error": "%s: %s" % (type(e).__name__, e)})
                continue
            # The daemon answers for each expression that starts at the location, a call and its
            # name, say; a line is a definition, or "Cannot find definition" for an expression
            # with none, which is no declaration rather than a failure.
            out = r.get("out", "") or ""
            said = (out + "\n" + (r.get("err", "") or "")).strip()
            # A definition at line -1 is a name mypy has no place for (from a module it could
            # not find): no declaration, as "Cannot find definition" is.
            other = [x for x in said.split("\n") if x.strip() and not DEFINITION.match(x) and not x.startswith("Cannot find definition") and not NOWHERE.search(x)]
            if "error" in r or (r.get("status", 1) != 0 and not DEFINITION.search(out) and other):
                answers.append({"error": (r.get("error") or said).strip()[:300]})
                continue
            # Several expressions can start where the name is written, as the call
            # `f(x).name` and the name `f` in `f(x).name == y`; the daemon answers each, so
            # when it gives more than one definition only those of the name asked about are
            # the answer. One definition is kept whatever its name: an import under a new name.
            found = list(DEFINITION.finditer(out))
            asked = re.match(r"[^\W\d]\w*", texts[file][line0][column - 1 :])
            if len(found) > 1 and asked is not None:
                found = [m for m in found if m.group(4) == asked.group(0)]
            decls = []
            for m in found:
                path = m.group(1).strip()
                decls.append({"file": path if os.path.isabs(path) else os.path.join(root, path), "line0": int(m.group(2)) - 1, "column": int(m.group(3)) - 1, "name": m.group(4)})
            answers.append({"decls": decls})
    finally:
        subprocess.run([dmypy, "--status-file", status, "stop"], cwd=root, capture_output=True)
    json.dump({"version": __version__, "check": check, "answers": answers}, sys.stdout)


main()
