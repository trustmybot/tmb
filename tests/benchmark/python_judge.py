"""The benchmark's second judge of Python's links (trustmybot/tmb#427): Jedi, a tool that is not pyright.

pyright is way B's source and the reference for Python's links, so it cannot judge way B's links
(CODE_GRAPH.md, Benchmark detail). Jedi resolves a name by its own inference, and this script asks it
what an editor asks with "go to definition": `Script.goto` with imports followed, the declarations of
the name written at a place.

Reads {"jedi": folder, "root": folder, "files": {path: text}, "asked": [[path, line, character], ...]}
as JSON on stdin, where `jedi` is the folder that holds Jedi and its parser, parso, `root` is the
repo's working tree at the commit, `files` are the repo's Python files at the commit, by path from
`root`, and each asked place is a line from 0 and a character in UTF-16 units, as a language server
counts them. Writes, for each place in order, null when Jedi names no declaration, else the list of
declarations: [path, line, character, end character], the path absolute, or "" for a declaration
with no file (a built-in compiled into Python), the line from 0, and the characters in UTF-16 units
where the declared name starts and ends.

Jedi is set up as the reference sets pyright up:
- It reads no installed package. Run with `python3 -I -S`, the interpreter's path holds the standard
  library alone, and Jedi reads that path in this process (InterpreterEnvironment), so a call into a
  package has no answer.
- It looks for a `src` layout: a folder `src` at the top of the repo is on the path, as pyright's
  `autoSearchPaths` puts it there.
- It answers on proof only. Jedi's guesses are off: the type of an unannotated parameter taken from
  the calls of its function (`dynamic_params`) and a list's items taken from later appends
  (`dynamic_array_additions`). What remains is what the code declares or assigns.
- It runs no code of the repo: Jedi reads it as text.
- A declaration is where the declared name is written. A place Jedi names whose text there is not
  the name is no declaration, and is left out of the answer: Jedi can name such a place, as for a
  class method of an `Enum`, which it places in the built-ins at a line that holds another name.
"""

import json
import os
import sys

# The interpreter's own path, the standard library, before Jedi's folder is added.
STANDARD_LIBRARY = list(sys.path)
SRC_LAYOUT = "src"


def utf16(text):
    return len(text.encode("utf-16-le")) // 2


def code_points(line, character):
    """The column in code points, as Jedi counts it, of a character in UTF-16 units of a line."""
    col = 0
    units = 0
    while units < character and col < len(line):
        units += utf16(line[col])
        col += 1
    return col


def main():
    request = json.load(sys.stdin)
    sys.path.insert(0, request["jedi"])
    import jedi

    settings = jedi.settings
    settings.dynamic_params = False
    settings.dynamic_params_for_other_modules = False
    settings.dynamic_array_additions = False
    # Jedi's cache goes to the temporary files, never to the person's own cache folder.
    settings.cache_directory = os.path.join(request["cache"], "jedi")

    root = request["root"]
    src = os.path.join(root, SRC_LAYOUT)
    project = jedi.Project(root, sys_path=([src] if os.path.isdir(src) else []) + STANDARD_LIBRARY, smart_sys_path=True)
    environment = jedi.InterpreterEnvironment()
    files = request["files"]
    scripts = {}
    lines = {}
    declared_lines = {}

    def declared_line(path, line):
        if path not in declared_lines:
            try:
                with open(path, encoding="utf-8") as f:
                    declared_lines[path] = f.read().splitlines(True)
            except (OSError, UnicodeDecodeError):
                declared_lines[path] = None
        text = declared_lines[path]
        return text[line] if text is not None and line < len(text) else None

    out = []
    for path, line, character in request["asked"]:
        if path not in scripts:
            scripts[path] = jedi.Script(files[path], path=os.path.join(root, path), project=project, environment=environment)
            lines[path] = files[path].splitlines(True)
        text = lines[path][line] if line < len(lines[path]) else ""
        try:
            names = scripts[path].goto(line + 1, code_points(text, character), follow_imports=True)
        except Exception:  # noqa: BLE001 - Jedi failing at a place is no answer there
            out.append(None)
            continue
        decls = []
        for name in names:
            if name.module_path is None or name.line is None:
                decls.append(["", -1, -1, -1])
                continue
            file = str(name.module_path)
            source = declared_line(file, name.line - 1)
            if source is not None and not source.startswith(name.name, name.column):
                continue
            start = utf16(source[: name.column]) if source is not None else name.column
            decls.append([file, name.line - 1, start, start + utf16(name.name)])
        out.append(decls or None)
    json.dump({"version": jedi.__version__, "answers": out}, sys.stdout)


main()
