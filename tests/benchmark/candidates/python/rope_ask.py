"""The Python A/B test's question to rope (trustmybot/tmb#338): where is the name each call calls
declared? rope's own answer is `rope.contrib.codeassist.get_definition_location`, which gives a
file and a line, or none.

Reads {"root", "env_site": [folders], "questions": [[file, line0, utf16_character], ...]} as JSON
on stdin and writes {"version", "answers": [{"decls": [...]} or {"error": ...}]}. A declaration is
{"file", "line0", "name"}: the location is rope's own answer, as `get_definition_location` gives it
(the same steps, so the name it found can be read too); the name is the function's or class's own
for a def or class, after following imports, and null for any other name (a parameter, a local),
whose line is then read from the file.

rope finds modules on the Python path of the interpreter it runs in plus `python_path`: the target
environment's site-packages are added there. Run with the tools venv's Python and `-I`.
"""

import json
import os
import sys

import rope
import rope.base.project
from rope.base import pynames
from rope.contrib import fixsyntax


def codepoints(line_text, utf16):
    return len(line_text.encode("utf-16-le")[: utf16 * 2].decode("utf-16-le", errors="ignore"))


def own_name(pyname):
    """The name a def or class declares, following imports; "=" for an assignment, whose name is
    read from its line; else None."""
    seen = 0
    while isinstance(pyname, pynames.ImportedName) and seen < 20:
        pyname = pyname._get_imported_pyname()
        seen += 1
    if isinstance(pyname, pynames.DefinedName):
        return pyname.get_object().get_name()
    if isinstance(pyname, pynames.AssignedName) and not isinstance(pyname, pynames.ParameterName):
        return "="
    return None


def main():
    q = json.load(sys.stdin)
    root = q["root"]
    project = rope.base.project.Project(root, ropefolder=None, python_path=q["env_site"])
    answers = []
    cache = {}
    for file, line0, character in q["questions"]:
        try:
            if file not in cache:
                cache.clear()
                resource = project.get_resource(file)
                code = resource.read()
                lines = code.split("\n")
                starts = [0]
                for line in lines:
                    starts.append(starts[-1] + len(line) + 1)
                cache[file] = (resource, code, lines, starts)
            resource, code, lines, starts = cache[file]
            offset = starts[line0] + codepoints(lines[line0], character)
            # The steps of rope.contrib.codeassist.get_definition_location, keeping the name.
            pyname = fixsyntax.FixSyntax(project, code, resource, 1).pyname_at(offset)
            module, line = pyname.get_definition_location() if pyname is not None else (None, None)
            if module is None or line is None:
                answers.append({"decls": []})
                continue
            found = module.get_module().get_resource()
            path = found.real_path if found is not None and hasattr(found, "real_path") else os.path.join(root, found.path if found is not None else file)
            answers.append({"decls": [{"file": path, "line0": line - 1, "name": own_name(pyname)}]})
        except Exception as e:
            answers.append({"error": "%s: %s" % (type(e).__name__, e)})
    project.close()
    json.dump({"version": rope.VERSION, "answers": answers}, sys.stdout)


main()
