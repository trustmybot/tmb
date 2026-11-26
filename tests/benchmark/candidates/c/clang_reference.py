"""The compiler's own answer for a C or C++ repo, through libclang (clang's C API).

Research harness for trustmybot/tmb#346; nothing in src/ uses it. For every translation unit of
the compile database (or every source file, with no database) it writes, as one JSON document:

- functions: each function definition the compiler parses in a file of the repo, as file and
  lines: a function, a method, a constructor, a destructor, a conversion, a function template and
  a lambda (C11 6.9.1; C++ [dcl.fct.def.general], [expr.prim.lambda]);
- calls: each call written in a function of the repo, at the place its callee's name is spelled,
  with the declaration the compiler binds the name to, that declaration's USR, and the definition
  the compiler sees in the same translation unit;
- defs: each definition's USR, so a declaration in one unit joins its definition in another. A USR
  is clang's own name for an entity across translation units; it carries the file for an entity
  with internal linkage, so the join is the language's linkage rule as the compiler states it.

Usage: python3 -I clang_reference.py <libclang.dylib> <cindex dir> <repo root> <compile_commands.json or "none"> <c|cpp> <out.json>
"""

import ctypes
import json
import os
import shlex
import sys

LIBCLANG, CINDEX_DIR, ROOT, CDB, LANG, OUT = sys.argv[1:7]
sys.path.insert(0, CINDEX_DIR)
from clang import cindex  # noqa: E402

cindex.Config.set_library_file(LIBCLANG)
K = cindex.CursorKind
ROOT = os.path.realpath(ROOT) + os.sep

# Each kind of cursor that is a function when it is a definition.
FUNCTION_KINDS = {K.FUNCTION_DECL, K.CXX_METHOD, K.CONSTRUCTOR, K.DESTRUCTOR, K.CONVERSION_FUNCTION, K.FUNCTION_TEMPLATE}
# The cursors that can name a call's callee.
NAME_KINDS = {K.DECL_REF_EXPR, K.MEMBER_REF_EXPR, K.OVERLOADED_DECL_REF}
SOURCE_ENDINGS = {"c": (".c",), "cpp": (".cc", ".cpp", ".cxx", ".c++")}[LANG]
# KeepGoing: a unit with an error is still parsed to its end, as an editor's clangd does.
PARSE_OPTIONS = 0x200 | cindex.TranslationUnit.PARSE_DETAILED_PROCESSING_RECORD

lib = cindex.conf.lib
lib.clang_getSpellingLocation.argtypes = [cindex.SourceLocation, ctypes.POINTER(cindex.c_object_p), ctypes.POINTER(ctypes.c_uint), ctypes.POINTER(ctypes.c_uint), ctypes.POINTER(ctypes.c_uint)]
lib.clang_getSpellingLocation.restype = None
lib.clang_Cursor_isDynamicCall.argtypes = [cindex.Cursor]
lib.clang_Cursor_isDynamicCall.restype = ctypes.c_int


def spelling(loc):
    """Where a location's characters are written: file, line, byte column (1-based)."""
    f = cindex.c_object_p()
    line, col, off = ctypes.c_uint(), ctypes.c_uint(), ctypes.c_uint()
    lib.clang_getSpellingLocation(loc, ctypes.byref(f), ctypes.byref(line), ctypes.byref(col), ctypes.byref(off))
    if not f:
        return None
    name = cindex.File(f).name
    return os.path.realpath(name), line.value, col.value


def rel(path):
    return path[len(ROOT):] if path is not None and path.startswith(ROOT) else None


def expansion_file(cursor):
    f = cursor.location.file
    return os.path.realpath(f.name) if f is not None else None


def extent(cursor):
    e = cursor.extent
    if e.start.file is None:
        return None
    return {"file": os.path.realpath(e.start.file.name), "start": e.start.line, "end": e.end.line}


def place(ext):
    """A declaration's place: in the repo as a relative path, or outside it."""
    if ext is None:
        return None
    r = rel(ext["file"])
    return {"file": r, "start": ext["start"], "end": ext["end"]} if r is not None else {"outside": ext["file"]}


line_cache = {}


def token_at(path, line, col):
    """The identifier written at a place, read from the file the compiler read."""
    if path not in line_cache:
        try:
            with open(path, "rb") as fh:
                line_cache[path] = fh.read().split(b"\n")
        except OSError:
            line_cache[path] = []
    lines = line_cache[path]
    if line - 1 >= len(lines):
        return ""
    text = lines[line - 1][col - 1 :]
    n = 0
    while n < len(text) and (chr(text[n]).isalnum() or text[n] in b"_~"):
        n += 1
    return text[:n].decode("utf-8", "replace")


def callee_name_cursor(call):
    """The cursor naming the callee: the first name reference under the call, outside its arguments."""
    stack = list(call.get_children())[:1]
    while stack:
        c = stack.pop(0)
        if c.kind in NAME_KINDS:
            return c
        if c.kind in (K.UNEXPOSED_EXPR, K.PAREN_EXPR):
            stack = list(c.get_children())[:1] + stack
    return None


def main():
    if CDB == "none":
        units = []
        for d, _, files in os.walk(ROOT):
            if os.sep + ".git" in d:
                continue
            for f in sorted(files):
                if f.endswith(SOURCE_ENDINGS):
                    units.append({"file": os.path.join(d, f), "args": [], "directory": d})
    else:
        units = []
        seen = set()
        for e in json.load(open(CDB)):
            argv = e.get("arguments") or shlex.split(e["command"])
            path = os.path.realpath(os.path.join(e["directory"], e["file"]))
            if path in seen:
                continue
            seen.add(path)
            args = []
            skip = False
            for a in argv[1:]:
                if skip:
                    skip = False
                    continue
                if a in ("-o", "-MF", "-MT", "-MQ"):
                    skip = True
                    continue
                if a == "-c" or os.path.realpath(os.path.join(e["directory"], a)) == path:
                    continue
                args.append(a)
            units.append({"file": path, "args": args, "directory": e["directory"]})

    index = cindex.Index.create()
    functions = {}
    defs = {}
    calls = {}
    report = []
    for u in units:
        cwd = os.getcwd()
        os.chdir(u["directory"])
        try:
            tu = index.parse(u["file"], args=u["args"], options=PARSE_OPTIONS)
        except cindex.TranslationUnitLoadError as err:
            report.append({"file": rel(u["file"]), "error": str(err)})
            os.chdir(cwd)
            continue
        os.chdir(cwd)
        errors = [d.spelling for d in tu.diagnostics if d.severity >= cindex.Diagnostic.Error]
        report.append({"file": rel(u["file"]), "errors": len(errors), "first": errors[:3]})

        def visit(cursor, owner):
            for c in cursor.get_children():
                f = expansion_file(c)
                if f is None or rel(f) is None:
                    continue
                own = owner
                if (c.kind in FUNCTION_KINDS and c.is_definition()) or c.kind == K.LAMBDA_EXPR:
                    ext = extent(c)
                    if ext is not None and rel(ext["file"]) is not None:
                        key = f"{rel(ext['file'])}:{ext['start']}-{ext['end']}"
                        functions[key] = {"file": rel(ext["file"]), "start": ext["start"], "end": ext["end"], "name": c.spelling, "kind": c.kind.name}
                        own = key
                        if c.kind != K.LAMBDA_EXPR:
                            usr = c.get_usr()
                            if usr:
                                defs.setdefault(usr, {})[key] = {"file": rel(ext["file"]), "start": ext["start"], "end": ext["end"], "name": c.spelling}
                if c.kind == K.CALL_EXPR and own is not None:
                    record_call(c, own)
                elif c.kind == K.CXX_NEW_EXPR and own is not None:
                    record_new(c, own)
                visit(c, own)

        def record(where, name, own, ref, dynamic):
            key = f"{where[0]}:{where[1]}:{where[2]}"
            entry = calls.setdefault(key, {"file": where[0], "line": where[1], "col": where[2], "name": name, "owners": [], "decls": [], "dynamic": False})
            if own not in entry["owners"]:
                entry["owners"].append(own)
            entry["dynamic"] = entry["dynamic"] or dynamic
            if ref is None:
                return
            d = ref.get_definition()
            decl = {"usr": ref.get_usr(), "kind": ref.kind.name, "name": ref.spelling, "decl": place(extent(ref)), "def": place(extent(d)) if d is not None else None}
            if decl not in entry["decls"]:
                entry["decls"].append(decl)

        def record_call(c, own):
            ref = c.referenced
            name_cursor = callee_name_cursor(c)
            if ref is not None and ref.kind == K.CONSTRUCTOR:
                at = spelling(c.location)
                want = ref.spelling
            elif name_cursor is not None:
                # An operator the code does not name, as `->` on a smart pointer, is not written as a
                # call; a call through an object's `operator()`, as `twice()`, is.
                if ref is not None and ref.spelling != name_cursor.spelling and ref.spelling != "operator()":
                    return
                at = spelling(name_cursor.location)
                want = name_cursor.spelling
            else:
                at = spelling(c.location)
                want = ref.spelling if ref is not None else None
            if at is None or rel(at[0]) is None:
                return
            # A call is written when its callee's name is spelled where the compiler puts it; an
            # implicit construction, conversion or operator is not written as a call.
            token = token_at(at[0], at[1], at[2])
            if not token or (want is not None and token != want):
                return
            record((rel(at[0]), at[1], at[2]), token, own, ref, bool(lib.clang_Cursor_isDynamicCall(c)))

        def record_new(c, own):
            # `new T(...)`: the call is the constructor's, named where T is written.
            for t in c.get_children():
                if t.kind == K.TYPE_REF or t.kind == K.TEMPLATE_REF:
                    at = spelling(t.location)
                    if at is None or rel(at[0]) is None:
                        return
                    token = token_at(at[0], at[1], at[2])
                    ctor = next((x.referenced for x in c.get_children() if x.kind == K.CALL_EXPR and x.referenced is not None), None)
                    record((rel(at[0]), at[1], at[2]), token, own, ctor, False)
                    return

        visit(tu.cursor, None)

    out = {"units": report, "functions": list(functions.values()), "defs": {k: list(v.values()) for k, v in defs.items()}, "calls": list(calls.values())}
    with open(OUT, "w") as fh:
        json.dump(out, fh)
    errs = sum(1 for r in report if r.get("errors") or r.get("error"))
    print(f"units {len(report)} (with errors {errs}) functions {len(functions)} calls {len(calls)} defs {len(defs)}")


main()
