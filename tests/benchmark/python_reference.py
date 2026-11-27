"""The benchmark's reference for Python (trustmybot/tmb#244): Python's own parser, `ast`.

Reads {"files": {path: text}} as JSON on stdin and writes, for each file, the functions `ast`
finds and how many calls each holds:

    {"version": "3.12", "files": {path: {"functions": ["start-end", ...], "calls": {"start-end" or "": n}}
                                  or {"error": "why ast cannot parse it"}}}

A function is a `def`, an `async def` or a `lambda`. Its lines start at its first decorator, as a
TypeScript function's start at its decorators, and end where `ast` ends it. An `@overload` stub is
no function: the one definition that runs is. A stub is a `def` one of whose decorators is
`typing.overload` or `typing_extensions.overload`, looked up as Python looks up the decorator where
the `def` is written: a name an import of `overload` from either binds, or `overload` of a name
bound to either module. A call in a stub's body belongs to the code around the stub. Stubs that no
`def` of their name follows in their scope are one function together, a function with only a
declaration: from the first one's first decorator to the last one's end, holding their calls.

A call is an `ast.Call`. It belongs to the function whose body runs it, by Python's own rule: a
function's decorators, default values and annotations are evaluated where the function is defined,
so they belong to the code around it. A call in a class body belongs to the file (""), as a
TypeScript reference puts a call in a class body outside its methods, and so does a call outside
every function.

For the links (trustmybot/tmb#399), each file also gives the places a type checker is asked about
and what is declared where it may answer:

    "sites": [[offset, line, character, [name, ...], shape], ...]
    "declarations": {"line:character": [name, kind, line of the node], ...}

A site is a call whose callee is a name, alone or after a dot: where that name is written, as an
offset in the file's text and as a line and a character, both counted in UTF-16 units as a language
server counts them; the names the call may be recorded by, its own and, for a name an import under a
new name binds, the name it imports; and how the callee is written (SHAPES). A call whose callee is
no name, such as `f()()` or `h[k]()`, is no site: no name is written for it.

A declaration is a name that declares a node of the graph, by "Kinds of symbol" in CODE_GRAPH.md,
where the name is written: every `def`, `async def` and `class`; every name bound outside every
function and class (file-level data, each name an unpacking binds included); and a name bound by an
assignment whose value is a `lambda`, a function written as a name's value. Its kind is "class",
"function" or "data". An `@overload` stub is no node: its line is the line of the `def` that runs,
the last `def` of its name in its scope, or for stubs no `def` follows, its own, since they are one
node together. Any other name, a parameter, a local or an import, declares no node.

Run with `python3 -I`, so nothing from the current folder is imported.
"""

import ast
import json
import re
import sys

FUNCTIONS = (ast.FunctionDef, ast.AsyncFunctionDef)
SCOPES = FUNCTIONS + (ast.ClassDef, ast.Lambda, ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp)

OVERLOAD = "overload"
OVERLOAD_MODULES = ("typing", "typing_extensions")
OTHER = ("other",)
# A pattern that binds a name: these are Python 3.10's, so absent from an older `ast`.
NAMED_PATTERNS = tuple(getattr(ast, n) for n in ("MatchAs", "MatchStar") if hasattr(ast, n))
MAPPING_PATTERN = getattr(ast, "MatchMapping", ())


def bindings(scope):
    """How the statements of one scope bind each name: ("module", m), ("import", m, name) or OTHER.
    A name bound more than once is OTHER, unless each time by the same import."""
    found = {}
    own_not = set()

    def add(name, how):
        found.setdefault(name, []).append(how)

    if isinstance(scope, FUNCTIONS):
        a = scope.args
        for arg in a.posonlyargs + a.args + a.kwonlyargs + [a.vararg, a.kwarg]:
            if arg is not None:
                add(arg.arg, OTHER)

    def bind(node):
        if isinstance(node, SCOPES):
            if isinstance(node, FUNCTIONS + (ast.ClassDef,)):
                add(node.name, OTHER)
            return
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.asname:
                    add(alias.asname, ("module", alias.name))
                else:
                    first = alias.name.split(".")[0]
                    add(first, ("module", first))
            return
        if isinstance(node, ast.ImportFrom):
            module = "." * node.level + (node.module or "")
            for alias in node.names:
                if alias.name != "*":
                    add(alias.asname or alias.name, ("import", module, alias.name))
            return
        if isinstance(node, (ast.Global, ast.Nonlocal)):
            own_not.update(node.names)
        elif isinstance(node, ast.Name) and isinstance(node.ctx, (ast.Store, ast.Del)):
            add(node.id, OTHER)
        elif isinstance(node, (ast.ExceptHandler,) + NAMED_PATTERNS) and node.name:
            add(node.name, OTHER)
        elif isinstance(node, MAPPING_PATTERN) and node.rest:
            add(node.rest, OTHER)
        for child in ast.iter_child_nodes(node):
            bind(child)

    if not isinstance(scope, ast.Lambda):
        for statement in scope.body:
            bind(statement)
    out = {}
    for name, all_ in found.items():
        if name not in own_not:
            out[name] = all_[0] if all(b == all_[0] for b in all_) else OTHER
    return out


def lookup(chain, name):
    """How the scopes around a `def` bind a name, innermost first: a class body counts only when
    the `def` is directly in it."""
    for i in range(len(chain) - 1, -1, -1):
        scope, names = chain[i]
        if isinstance(scope, ast.ClassDef) and i != len(chain) - 1:
            continue
        if name in names:
            return names[name]
    return None


def is_stub(node, chain):
    for decorator in node.decorator_list:
        if isinstance(decorator, ast.Name):
            b = lookup(chain, decorator.id)
            if b is not None and b[0] == "import" and b[2] == OVERLOAD and b[1] in OVERLOAD_MODULES:
                return True
        elif isinstance(decorator, ast.Attribute) and decorator.attr == OVERLOAD and isinstance(decorator.value, ast.Name):
            b = lookup(chain, decorator.value.id)
            if b is not None and b[0] == "module" and b[1] in OVERLOAD_MODULES:
                return True
    return False


def unfollowed(scope, chain):
    """The stubs of a scope that no `def` of their name follows there: by id, all such stubs of
    their name, in order. `chain` holds the scopes around the scope's statements, itself last."""
    by_name = {}

    def walk(nodes):
        for node in nodes:
            if isinstance(node, FUNCTIONS):
                by_name.setdefault(node.name, []).append(node)
            elif not isinstance(node, SCOPES):
                walk(ast.iter_child_nodes(node))

    walk(scope.body)
    groups = {}
    for defs in by_name.values():
        runs = len(defs) - 1
        while runs >= 0 and is_stub(defs[runs], chain):
            runs -= 1
        group = defs[runs + 1:]
        for d in group:
            groups[id(d)] = group
    return groups


# How a call's callee is written: a name; a method on the first parameter of the method it is
# written in (`self`, `cls`); a method on `super()`; a method on another name; or a method on any
# other expression.
SHAPES = ("name", "self", "parent", "attribute", "chain")

# The line breaks Python's tokenizer counts lines by.
LINE_BREAK = re.compile(r"\r\n|\r|\n")
# What a `def` or a `class` statement writes before its name, from where `ast` starts it.
DEF_NAME = re.compile(r"(?:async\s+)?(?:def|class)\s+")


def utf16(text):
    return len(text.encode("utf-16-le")) // 2


class Places:
    """A file's lines, to turn `ast`'s places (a line from 1 and a UTF-8 byte column) into UTF-16 ones."""

    def __init__(self, text):
        self.lines = []
        self.starts = []
        at = 0
        last = 0
        for m in LINE_BREAK.finditer(text):
            self.lines.append(text[last:m.start()])
            self.starts.append(at)
            at += utf16(text[last:m.end()])
            last = m.end()
        self.lines.append(text[last:])
        self.starts.append(at)

    def character(self, line, col):
        return utf16(self.lines[line - 1].encode("utf-8")[:col].decode("utf-8", "replace"))

    def offset(self, line, character):
        return self.starts[line - 1] + character


def span(node, start):
    return "%d-%d" % (start, node.end_lineno)


def measure(tree, places):
    functions = []
    calls = {}
    sites = []
    declarations = {}

    def declare(line, col, name, kind, target):
        declarations["%d:%d" % (line - 1, places.character(line, col))] = [name, kind, target]

    def def_name(node):
        """Where a `def`'s or a `class`'s name is written: line and byte column."""
        line = places.lines[node.lineno - 1].encode("utf-8")
        m = DEF_NAME.match(line[node.col_offset:].decode("utf-8", "replace"))
        if m is None:
            return None
        return node.lineno, node.col_offset + len(m.group(0).encode("utf-8"))

    def runs(node, chain):
        """The line of the node a `def` is: its own, or for a stub, the `def` that runs."""
        if not is_stub(node, chain) or group_of(node, chain) is not None:
            return node.lineno
        scope = chain[-1][0]
        last = node.lineno
        for child in iter_scope(scope):
            if isinstance(child, FUNCTIONS) and child.name == node.name and not is_stub(child, chain):
                last = child.lineno
        return last

    def iter_scope(scope):
        out = []

        def walk(nodes):
            for n in nodes:
                out.append(n)
                if not isinstance(n, SCOPES):
                    walk(ast.iter_child_nodes(n))

        walk(scope.body)
        return out

    def bound_names(target):
        for n in ast.walk(target):
            if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Store):
                yield n

    def declare_bindings(node, file_level):
        """The names an assignment, a loop, a `with` or `:=` binds: file-level data at file level,
        and anywhere a name whose value is a `lambda`."""
        if isinstance(node, (ast.Assign, ast.AnnAssign, ast.AugAssign, ast.NamedExpr)):
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            value = getattr(node, "value", None)
            for t in targets:
                for n in bound_names(t):
                    if isinstance(value, ast.Lambda) and n is t:
                        declare(n.lineno, n.col_offset, n.id, "function", n.lineno)
                    elif file_level:
                        declare(n.lineno, n.col_offset, n.id, "data", n.lineno)
        elif file_level and isinstance(node, (ast.For, ast.AsyncFor)):
            for n in bound_names(node.target):
                declare(n.lineno, n.col_offset, n.id, "data", n.lineno)
        elif file_level and isinstance(node, (ast.With, ast.AsyncWith)):
            for item in node.items:
                if item.optional_vars is not None:
                    for n in bound_names(item.optional_vars):
                        declare(n.lineno, n.col_offset, n.id, "data", n.lineno)

    def site(node, chain):
        callee = node.func
        if isinstance(callee, ast.Name):
            name, line, col, shape = callee.id, callee.lineno, callee.col_offset, "name"
        elif isinstance(callee, ast.Attribute):
            name = callee.attr
            line, col = callee.end_lineno, callee.end_col_offset - len(callee.attr.encode("utf-8"))
            receiver = callee.value
            scope = chain[-1][0]
            first = None
            if isinstance(scope, FUNCTIONS) and len(chain) > 1 and isinstance(chain[-2][0], ast.ClassDef):
                params = scope.args.posonlyargs + scope.args.args
                first = params[0].arg if params else None
            if isinstance(receiver, ast.Name) and first is not None and receiver.id == first:
                shape = "self"
            elif isinstance(receiver, ast.Call) and isinstance(receiver.func, ast.Name) and receiver.func.id == "super":
                shape = "parent"
            elif isinstance(receiver, ast.Name):
                shape = "attribute"
            else:
                shape = "chain"
        else:
            return
        names = [name]
        if shape == "name":
            b = lookup(chain, name)
            if b is not None and b[0] == "import" and b[2] != name:
                names.append(b[2])
        character = places.character(line, col)
        sites.append([places.offset(line, character), line, character, names, shape])

    groups = {}

    def group_of(node, chain):
        scope = chain[-1][0]
        if id(scope) not in groups:
            groups[id(scope)] = unfollowed(scope, chain)
        return groups[id(scope)].get(id(node))

    def first_line(node):
        return min([d.lineno for d in node.decorator_list] + [node.lineno])

    def visit(node, owner, chain):
        declare_bindings(node, len(chain) == 1)
        if isinstance(node, FUNCTIONS + (ast.ClassDef,)):
            at = def_name(node)
            if at is not None:
                kind = "class" if isinstance(node, ast.ClassDef) else "function"
                declare(at[0], at[1], node.name, kind, node.lineno if kind == "class" else runs(node, chain))
        if isinstance(node, FUNCTIONS):
            inner = chain + [(node, bindings(node))]
            group = group_of(node, chain) if is_stub(node, chain) else None
            if group is not None:
                key = "%d-%d" % (first_line(group[0]), group[-1].end_lineno)
                if node is group[0]:
                    functions.append(key)
            elif is_stub(node, chain):
                key = owner
            else:
                key = span(node, first_line(node))
                functions.append(key)
            for child in node.decorator_list:
                visit(child, owner, chain)
            visit(node.args, owner, chain)
            if node.returns is not None:
                visit(node.returns, owner, chain)
            for child in node.body:
                visit(child, key, inner)
            return
        if isinstance(node, ast.Lambda):
            key = span(node, node.lineno)
            functions.append(key)
            visit(node.args, owner, chain)
            visit(node.body, key, chain)
            return
        if isinstance(node, ast.ClassDef):
            for child in node.decorator_list + node.bases + node.keywords:
                visit(child, owner, chain)
            inner = chain + [(node, bindings(node))]
            for child in node.body:
                visit(child, "", inner)
            return
        if isinstance(node, ast.Call):
            calls[owner] = calls.get(owner, 0) + 1
            site(node, chain)
        for child in ast.iter_child_nodes(node):
            visit(child, owner, chain)

    visit(tree, "", [(tree, bindings(tree))])
    return {"functions": sorted(functions), "calls": calls, "sites": sites, "declarations": declarations}


def main():
    files = json.load(sys.stdin)["files"]
    out = {}
    for path, text in files.items():
        try:
            tree = ast.parse(text, filename=path)
        except (SyntaxError, ValueError) as e:
            out[path] = {"error": "%s: %s" % (type(e).__name__, e)}
            continue
        out[path] = measure(tree, Places(text))
    json.dump({"version": "%d.%d.%d" % sys.version_info[:3], "files": out}, sys.stdout)


main()
