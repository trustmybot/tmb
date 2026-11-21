# Python

The code graph's rules for `.py` files. They are read through tree-sitter's Python grammar ([index.ts](index.ts)).

## What it reads

- Classes, functions and methods, each with its docstring and its container.
- Module-level constants.
- Imports, with the alias each one binds. An import inside a function holds only inside that function.
- Calls. A name is looked up as Python looks it up: the function's own names and parameters, the functions around it, then the module and its imports. A name bound there to no function of the repo, such as a parameter or a variable, is not linked.
- A call through `self` or `cls` is a call of a method of the class or of one of its parents. A base class is linked as an instantiation.

Every function as a node, with its fixtures and a coverage test of its own, comes with trustmybot/tmb#141.
