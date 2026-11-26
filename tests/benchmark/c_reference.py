"""The benchmark's reference for C and C++ (trustmybot/tmb#355): the compiler's own answer, through
libclang, clang's C API, for every translation unit of the repo's compile database.

Usage: python3 -I c_reference.py <libclang library> <folder of the `clang` Python package, or "installed"> <repo root> <compile_commands.json>

It parses each file the database compiles, with the database's command for it, and writes one JSON
document:

  {"version": "clang version …",
   "units": [{"file", "errors", "first"}],          each unit the database names, its errors
   "functions": {path: ["start-end", …]},           each function in a file of the repo
   "calls": [{"file", "line", "col", "name", "owner", "construction", "targets": [{"file", "start", "end"}]}]}

A function, by CODE_GRAPH.md's "Kinds of symbol" and C11 6.9.1, C++ [dcl.fct.def.general] and
[expr.prim.lambda]: a function, a method, a constructor, a destructor, a conversion and a function
template that is defined, a deleted or defaulted one included ([dcl.fct.def.delete],
[dcl.fct.def.default]); a pure virtual method, which is a node though it has no body; and a lambda.
Its lines are its extent, from its first token, a template's `template` included, to its last.

A call (CODE_GRAPH.md, "The three states of a call") is a call expression whose callee's name is
written where the compiler puts it, and a `new T(…)`, at the name of T. An implicit construction,
conversion or operator is no call written in the file, nor is a cast, nor a call with neither a
name nor a declaration, as `(*f)(x)` or one a macro's body makes. `line` and `col` are where the
name is spelled, the column in UTF-8 bytes; a call written in a macro's body is spelled there, and
is counted once. `owner` is the innermost function around the call, "start-end", or "" outside
every function.

A call's targets are the nodes of the repo the compiler binds it to: every definition of the
declaration it names, across units, by clang's USR, which carries the file for an entity with
internal linkage; a pure virtual method's own declaration; and, for a construction, the class's
definition too, as the page's example links `new Cart` to `Cart`. A call with no target in the repo
reaches outside it, or a function the repo declares and never defines.
"""

import ctypes
import json
import os
import shlex
import sys

LIBCLANG, CINDEX_DIR, ROOT, CDB = sys.argv[1:5]
if CINDEX_DIR != "installed":
    sys.path.insert(0, CINDEX_DIR)
from clang import cindex  # noqa: E402

cindex.Config.set_library_file(LIBCLANG)
K = cindex.CursorKind
ROOT = os.path.realpath(ROOT) + os.sep

FUNCTION_KINDS = {K.FUNCTION_DECL, K.CXX_METHOD, K.CONSTRUCTOR, K.DESTRUCTOR, K.CONVERSION_FUNCTION, K.FUNCTION_TEMPLATE}
NAME_KINDS = {K.DECL_REF_EXPR, K.MEMBER_REF_EXPR, K.OVERLOADED_DECL_REF}
# KeepGoing: a unit with an error is still parsed to its end, as an editor's clangd does.
PARSE_OPTIONS = 0x200

lib = cindex.conf.lib
lib.clang_getSpellingLocation.argtypes = [cindex.SourceLocation, ctypes.POINTER(cindex.c_object_p), ctypes.POINTER(ctypes.c_uint), ctypes.POINTER(ctypes.c_uint), ctypes.POINTER(ctypes.c_uint)]
lib.clang_getSpellingLocation.restype = None
lib.clang_getClangVersion.restype = cindex._CXString
lib.clang_getClangVersion.errcheck = cindex._CXString.from_result


def spelling(loc):
    """Where a location's characters are written: file, line, byte column (1-based)."""
    f = cindex.c_object_p()
    line, col, off = ctypes.c_uint(), ctypes.c_uint(), ctypes.c_uint()
    lib.clang_getSpellingLocation(loc, ctypes.byref(f), ctypes.byref(line), ctypes.byref(col), ctypes.byref(off))
    if not f:
        return None
    return os.path.realpath(cindex.File(f).name), line.value, col.value


def rel(path):
    return path[len(ROOT):] if path is not None and path.startswith(ROOT) else None


def extent(cursor):
    """A cursor's place in the repo: relative file and lines; None outside it."""
    e = cursor.extent
    if e.start.file is None:
        return None
    r = rel(os.path.realpath(e.start.file.name))
    return None if r is None else {"file": r, "start": e.start.line, "end": e.end.line}


line_cache = {}


def token_at(path, line, col):
    """The name written at a place, read from the file the compiler read."""
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


def is_function(c):
    if c.kind == K.LAMBDA_EXPR:
        return True
    if c.kind not in FUNCTION_KINDS:
        return False
    return c.is_definition() or (c.kind == K.CXX_METHOD and c.is_pure_virtual_method())


def units_of(cdb):
    """Each file the database compiles, once, with its command's arguments less the output and the file."""
    units = []
    seen = set()
    for e in json.load(open(cdb)):
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
    return units


def main():
    index = cindex.Index.create()
    functions = {}
    defs = {}
    calls = {}
    report = []
    for u in units_of(CDB):
        cwd = os.getcwd()
        os.chdir(u["directory"])
        try:
            tu = index.parse(u["file"], args=u["args"], options=PARSE_OPTIONS)
        except cindex.TranslationUnitLoadError as err:
            report.append({"file": rel(u["file"]) or u["file"], "errors": 1, "first": [str(err)]})
            continue
        finally:
            os.chdir(cwd)
        errors = [d.spelling for d in tu.diagnostics if d.severity >= cindex.Diagnostic.Error]
        report.append({"file": rel(u["file"]) or u["file"], "errors": len(errors), "first": errors[:3]})

        def visit(cursor, owner):
            for c in cursor.get_children():
                f = c.location.file
                if f is None or rel(os.path.realpath(f.name)) is None:
                    continue
                own = owner
                if is_function(c):
                    ext = extent(c)
                    if ext is not None:
                        span = f"{ext['start']}-{ext['end']}"
                        functions.setdefault(ext["file"], set()).add(span)
                        own = (ext["file"], span)
                        if c.kind != K.LAMBDA_EXPR and c.is_definition() and c.get_usr():
                            defs.setdefault(c.get_usr(), {})[(ext["file"], ext["start"], ext["end"])] = ext
                if c.kind == K.CALL_EXPR:
                    record_call(c, own)
                elif c.kind == K.CXX_NEW_EXPR:
                    record_new(c, own)
                visit(c, own)

        def record(at, name, own, ref):
            key = (rel(at[0]), at[1], at[2])
            entry = calls.get(key)
            if entry is None:
                owner = own[1] if own is not None and own[0] == key[0] else ""
                entry = calls[key] = {"file": key[0], "line": at[1], "col": at[2], "name": name, "owner": owner, "construction": False, "refs": []}
            if ref is None:
                return
            entry["construction"] = entry["construction"] or ref.kind == K.CONSTRUCTOR
            r = {"usr": ref.get_usr(), "pure": None, "class": None}
            if ref.kind == K.CXX_METHOD and ref.is_pure_virtual_method():
                r["pure"] = extent(ref)
            if ref.kind == K.CONSTRUCTOR:
                cls = ref.semantic_parent
                cls_def = cls.get_definition() if cls is not None else None
                r["class"] = extent(cls_def) if cls_def is not None else None
            d = ref.get_definition()
            r["def"] = extent(d) if d is not None else None
            if r not in entry["refs"]:
                entry["refs"].append(r)

        def record_call(c, own):
            ref = c.referenced
            name_cursor = callee_name_cursor(c)
            if ref is not None and ref.kind == K.CONSTRUCTOR:
                at = spelling(c.location)
                want = ref.spelling
            elif name_cursor is not None:
                # An operator the code does not name, as `->` on a smart pointer, is not written as a
                # call; a call through an object's `operator()` is.
                if ref is not None and ref.spelling != name_cursor.spelling and ref.spelling != "operator()":
                    return
                at = spelling(name_cursor.location)
                want = name_cursor.spelling
            elif ref is not None:
                at = spelling(c.location)
                want = ref.spelling
            else:
                # Neither a name nor a declaration: a call through an expression, as `(*f)(x)`, or one a
                # macro's body makes, has no name written where the call is.
                return
            if at is None or rel(at[0]) is None:
                return
            token = token_at(at[0], at[1], at[2])
            if not token or token != want:
                return
            record(at, token, own, ref)

        def record_new(c, own):
            for t in c.get_children():
                if t.kind in (K.TYPE_REF, K.TEMPLATE_REF):
                    at = spelling(t.location)
                    if at is None or rel(at[0]) is None:
                        return
                    token = token_at(at[0], at[1], at[2])
                    ctor = next((x.referenced for x in c.get_children() if x.kind == K.CALL_EXPR and x.referenced is not None), None)
                    if token:
                        record(at, token, own, ctor)
                    return

        visit(tu.cursor, None)

    out_calls = []
    for entry in calls.values():
        targets = {}
        for r in entry.pop("refs"):
            for t in [r["def"], r["pure"], r["class"], *defs.get(r["usr"], {}).values()]:
                if t is not None:
                    targets[(t["file"], t["start"], t["end"])] = t
        entry["targets"] = list(targets.values())
        out_calls.append(entry)
    out = {
        "version": lib.clang_getClangVersion(),
        "units": report,
        "functions": {f: sorted(s) for f, s in functions.items()},
        "calls": out_calls,
    }
    json.dump(out, sys.stdout)


main()
