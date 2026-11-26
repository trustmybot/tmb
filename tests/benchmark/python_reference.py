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

Run with `python3 -I`, so nothing from the current folder is imported.
"""

import ast
import json
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


def span(node, start):
    return "%d-%d" % (start, node.end_lineno)


def measure(tree):
    functions = []
    calls = {}

    groups = {}

    def group_of(node, chain):
        scope = chain[-1][0]
        if id(scope) not in groups:
            groups[id(scope)] = unfollowed(scope, chain)
        return groups[id(scope)].get(id(node))

    def first_line(node):
        return min([d.lineno for d in node.decorator_list] + [node.lineno])

    def visit(node, owner, chain):
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
        for child in ast.iter_child_nodes(node):
            visit(child, owner, chain)

    visit(tree, "", [(tree, bindings(tree))])
    return {"functions": sorted(functions), "calls": calls}


def main():
    files = json.load(sys.stdin)["files"]
    out = {}
    for path, text in files.items():
        try:
            tree = ast.parse(text, filename=path)
        except (SyntaxError, ValueError) as e:
            out[path] = {"error": "%s: %s" % (type(e).__name__, e)}
            continue
        out[path] = measure(tree)
    json.dump({"version": "%d.%d.%d" % sys.version_info[:3], "files": out}, sys.stdout)


main()
