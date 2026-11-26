# Python

The code graph's rules for `.py` files. They are read through tree-sitter's Python grammar ([index.ts](index.ts)).

## What it reads

- Classes, functions and methods, each with its docstring and its container.
- Module-level constants.
- Imports, with the alias each one binds. An import inside a function holds only inside that function.
- Calls. A name is looked up as Python looks it up: the function's own names and parameters, the functions around it, then the module and its imports. A name bound there to no function of the repo, such as a parameter or a variable, is not linked.
- A call through `self` or `cls` is a call of a method of the class or of one of its parents. A base class is linked as an instantiation.
- Every call is linked, outside the repo, or not known (trustmybot/tmb#252). It is outside only when its name, or the name it is called on in `x.f()`, is looked up as above and ends at:
  - an import of a module bound once at the top of the module, or in the function, that is not relative and that no file of the repo could be: no `a/b.py` and no folder `a/b/` anywhere in the repo for `a.b`, since Python finds a module in any folder on its search path; or
  - a name of Python's `builtins` module, past every class body around the call and a module that binds it nowhere and has no `from m import *`. On `x.f()`, the builtin must have a callable `f`.

  [builtins.ts](builtins.ts) holds the builtins. [builtins.gen.ts](builtins.gen.ts) writes it from the Python on PATH, and names that Python's version. A test fails when the two differ, and is skipped, saying why, without that Python. A base class is no call.

Every function as a node, with its fixtures and a coverage test of its own, comes with trustmybot/tmb#141.
