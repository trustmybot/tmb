# Python

The code graph's rules for `.py` files. They are read through tree-sitter's Python grammar ([index.ts](index.ts)).

## What it reads

- Classes, functions and methods, each with its docstring and its container.
- Module-level constants.
- Imports, with the alias each one binds.
- Calls. A call through `self` or `cls` is a call of the class's own method, and a base class is linked as an instantiation.

Every function as a node, with its fixtures and a coverage test of its own, comes with trustmybot/tmb#141.
