"""The benchmark's reference for Python (trustmybot/tmb#244): Python's own parser, `ast`.

Reads {"files": {path: text}} as JSON on stdin and writes, for each file, the functions `ast`
finds and how many calls each holds:

    {"version": "3.12", "files": {path: {"functions": ["start-end", ...], "calls": {"start-end" or "": n}}
                                  or {"error": "why ast cannot parse it"}}}

A function is a `def`, an `async def` or a `lambda`. Its lines start at its first decorator, as a
TypeScript function's start at its decorators, and end where `ast` ends it.

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


def span(node, start):
    return "%d-%d" % (start, node.end_lineno)


def measure(tree):
    functions = []
    calls = {}

    def visit(node, owner):
        if isinstance(node, FUNCTIONS):
            start = min([d.lineno for d in node.decorator_list] + [node.lineno])
            key = span(node, start)
            functions.append(key)
            for child in node.decorator_list:
                visit(child, owner)
            visit(node.args, owner)
            if node.returns is not None:
                visit(node.returns, owner)
            for child in node.body:
                visit(child, key)
            return
        if isinstance(node, ast.Lambda):
            key = span(node, node.lineno)
            functions.append(key)
            visit(node.args, owner)
            visit(node.body, key)
            return
        if isinstance(node, ast.ClassDef):
            for child in node.decorator_list + node.bases + node.keywords:
                visit(child, owner)
            for child in node.body:
                visit(child, "")
            return
        if isinstance(node, ast.Call):
            calls[owner] = calls.get(owner, 0) + 1
        for child in ast.iter_child_nodes(node):
            visit(child, owner)

    visit(tree, "")
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
