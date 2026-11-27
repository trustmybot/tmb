"""The benchmark's second judge of Python's links (trustmybot/tmb#427): Jedi, a tool that is not pyright.

pyright is way B's source and the reference for Python's links, so it cannot judge way B's links
(CODE_GRAPH.md, Benchmark detail). Jedi resolves a name by its own inference, and this script asks it
what an editor asks with "go to definition": `Script.goto` with imports followed, the declarations of
the name written at a place.

Reads {"jedi": folder, "root": folder, "files": {path: text}, "asked": [[path, line, character], ...]}
as JSON on stdin, where `jedi` is the folder that holds Jedi and its parser, parso, `root` is the
repo's working tree at the commit, `files` are the repo's Python files at the commit, by path from
`root`, and each asked place is a line from 0 and a character in UTF-16 units, as a language server
counts them. Writes, for each place in order, null when Jedi names no declaration, NOT_WRITTEN when
every place it names is not where the name is written, else the list of declarations: [path, line,
character, end character, same variable], the path absolute, or "" for a declaration with no file
(a built-in compiled into Python), the line from 0, the characters in UTF-16 units where the declared
name starts and ends, and 1 for a declaration the judge adds as a binding of the same variable as
one Jedi names, else 0.

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
  class method of an `Enum`, which it places in the built-ins at a line that holds another name. A
  place where Jedi names only such places is NOT_WRITTEN, counted apart and not judged.
- The bindings of one name in one scope are one variable (the language reference, "Naming and
  binding"), and Jedi names only the binding that reaches the place asked, as
  `f = staticmethod(f)` after `def f` in a class body. So for a declaration in the repo the answer
  also holds each other binding Jedi finds of that variable whose scope is the same: the same
  function, class or file, where a binding in a block that declares the name `global` is in the
  file's scope. A binding of the same name in another scope, a class's own attribute or a local of
  a function, is another variable and is never added. Each added binding is marked, so the
  benchmark shows how many links only such a binding agrees with.
"""

import ast
import json
import os
import sys

# The interpreter's own path, the standard library, before Jedi's folder is added.
STANDARD_LIBRARY = list(sys.path)
SRC_LAYOUT = "src"
# Every place in a declaration's file Jedi names only places that are not the name.
NOT_WRITTEN = "not where the name is written"
FUNCTIONS = (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)
COMPREHENSIONS = (ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp)
SCOPES = FUNCTIONS + (ast.ClassDef,) + COMPREHENSIONS
FILE_SCOPE = "file"


def scopes_of(text):
    """Each scope of a file's text but the file's own: its key, where the names it binds start and
    end as (line from 1, column in UTF-8 bytes), and the names it declares `global`."""
    tree = ast.parse(text)
    out = []
    for node in ast.walk(tree):
        if not isinstance(node, SCOPES):
            continue
        if isinstance(node, ast.ClassDef):
            starts = [node.body[0]]
        elif isinstance(node, FUNCTIONS):
            a = node.args
            params = a.posonlyargs + a.args + a.kwonlyargs + [p for p in (a.vararg, a.kwarg) if p is not None]
            starts = params + (node.body if isinstance(node.body, list) else [node.body])
        else:
            starts = [node]
        start = min((n.lineno, n.col_offset) for n in starts)
        declared_global = set()
        if not isinstance(node, COMPREHENSIONS):
            pending = list(node.body) if isinstance(node.body, list) else [node.body]
            while pending:
                n = pending.pop()
                if isinstance(n, ast.Global):
                    declared_global.update(n.names)
                elif not isinstance(n, SCOPES):
                    pending.extend(ast.iter_child_nodes(n))
        out.append(((node.lineno, node.col_offset), start, (node.end_lineno, node.end_col_offset), declared_global))
    return out


def scope_of(scopes, line, byte_column, name):
    """The scope a binding of `name` at a place binds in: the innermost scope that holds the place,
    or the file's when that scope declares the name `global` or none holds it."""
    inner = None
    for key, start, end, declared_global in scopes:
        if start <= (line, byte_column) < end and (inner is None or inner[1] <= start):
            inner = (key, start, declared_global)
    if inner is None or name in inner[2]:
        return FILE_SCOPE
    return inner[0]


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

    bound = {}
    file_scopes = {}

    def scopes_in(path):
        if path not in file_scopes:
            try:
                with open(path, encoding="utf-8") as f:
                    file_scopes[path] = scopes_of(f.read())
            except (OSError, UnicodeDecodeError, SyntaxError, ValueError):
                file_scopes[path] = None
        return file_scopes[path]

    def bindings(path, line, column, name):
        """The other bindings, as (line from 1, column in code points), of the variable declared at a
        place: those Jedi finds of that name, in the file, whose scope is the place's."""
        key = (path, line, column)
        if key not in bound:
            scopes = scopes_in(path)
            found = []
            if scopes is not None:
                try:
                    with open(path, encoding="utf-8") as f:
                        script = jedi.Script(f.read(), path=path, project=project, environment=environment)
                    found = [(r.line, r.column) for r in script.get_references(line, column, scope="file") if r.is_definition() and r.line is not None and r.name == name]
                except Exception:  # noqa: BLE001 - no bindings found: the declaration Jedi named stands alone
                    found = []

            def scope(at):
                text = declared_line(path, at[0] - 1)
                return None if text is None else scope_of(scopes, at[0], len(text[: at[1]].encode("utf-8")), name)

            own = scope((line, column)) if scopes is not None else None
            bound[key] = [b for b in found if b != (line, column) and own is not None and scope(b) == own]
        return bound[key]

    def declared_line(path, line):
        if path not in declared_lines:
            try:
                with open(path, encoding="utf-8") as f:
                    declared_lines[path] = f.read().splitlines(True)
            except (OSError, UnicodeDecodeError):
                declared_lines[path] = None
        text = declared_lines[path]
        return text[line] if text is not None and line < len(text) else None

    root_prefix = os.path.join(os.path.realpath(root), "")

    def in_repo(path):
        return os.path.realpath(path).startswith(root_prefix)

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
        not_written = 0

        def add(file, line_1, column, text, name, same_variable):
            start = utf16(text[:column]) if text is not None else column
            decl = [file, line_1 - 1, start, start + utf16(name)]
            for d in decls:
                if d[:4] == decl:
                    d[4] = min(d[4], same_variable)
                    return
            decls.append(decl + [same_variable])

        for name in names:
            if name.module_path is None or name.line is None:
                decls.append(["", -1, -1, -1, 0])
                continue
            file = str(name.module_path)
            source = declared_line(file, name.line - 1)
            if source is not None and not source.startswith(name.name, name.column):
                not_written += 1
                continue
            add(file, name.line, name.column, source, name.name, 0)
            if source is None or not in_repo(file):
                continue
            for line_1, column in bindings(file, name.line, name.column, name.name):
                text = declared_line(file, line_1 - 1)
                if text is not None and text.startswith(name.name, column):
                    add(file, line_1, column, text, name.name, 1)
        out.append(decls if decls else NOT_WRITTEN if not_written > 0 else None)
    json.dump({"version": jedi.__version__, "answers": out}, sys.stdout)


main()
