"""The Python A/B test's question to Jedi (trustmybot/tmb#338): where is the name each call calls
declared? Jedi's own answer, `Script.goto(follow_imports=True)`, is returned as it gives it.

Reads {"root": dir, "env": python, "questions": [[file, line0, utf16_character], ...]} as JSON on
stdin and writes {"version": ..., "answers": [{"decls": [...]} or {"error": ...}]}. A declaration
is {"file", "line0", "character", "name"}, or {"builtin": true, "name"} for one Jedi finds in a
compiled module, which has no file.

Run with the tools venv's Python and `-I`.
"""

import json
import sys

import jedi


def codepoints(line_text, utf16):
    """The code-point column of a UTF-16 column, as Jedi counts columns."""
    return len(line_text.encode("utf-16-le")[: utf16 * 2].decode("utf-16-le", errors="ignore"))


def main():
    q = json.load(sys.stdin)
    project = jedi.Project(q["root"], environment_path=q["env"])
    scripts = {}
    answers = []
    for file, line0, character in q["questions"]:
        try:
            if file not in scripts:
                path = q["root"] + "/" + file
                with open(path, encoding="utf-8") as f:
                    code = f.read()
                scripts.clear()
                scripts[file] = (jedi.Script(code, path=path, project=project), code.split("\n"))
            script, lines = scripts[file]
            text = lines[line0]
            names = script.goto(line0 + 1, codepoints(text, character), follow_imports=True)
            decls = []
            for n in names:
                if n.module_path is None or n.line is None:
                    decls.append({"builtin": bool(n.in_builtin_module()), "name": n.name})
                    continue
                decls.append({"file": str(n.module_path), "line0": n.line - 1, "column": n.column, "name": n.name})
            answers.append({"decls": decls})
        except Exception as e:  # an error is an answer of its own: not known
            answers.append({"error": "%s: %s" % (type(e).__name__, e)})
    json.dump({"version": jedi.__version__, "answers": answers}, sys.stdout)


main()
