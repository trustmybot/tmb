# Python

The code graph's rules for `.py` files. They are read through tree-sitter's Python grammar ([index.ts](index.ts)).

## What it reads

- Classes, functions and methods, each with its docstring and its container.
- Module-level constants.
- Imports, with the alias each one binds. An import inside a function holds only inside that function.
- Calls. A name is looked up as Python looks it up: the function's own names and parameters, the functions around it, then the module and its imports. A name bound there to no function of the repo, such as a parameter or a variable, is not linked.
- A class body binds names too, its imports included, for the statements directly in it. They are not seen inside its methods, lambdas and comprehensions, since a class body is no scope around them; a comprehension's first iterable is evaluated in the class body (trustmybot/tmb#287).
- A name imported as `from m import a as b` is looked up by `a` in `m`, as a call, as the object of a call and as a base.
- A call through `self` or `cls` is a call of a method of the class or of one of its parents. The first class that has the name decides: an attribute of the class body, an annotation with no value, or a name its methods assign on `self` or `cls`, stops the lookup, so the call is not linked. A base class is linked as an instantiation.
- Each class, function and method is its own symbol, so two of one name in a module, such as one under `if` and one under `else`, stay two. A name that names both is not linked.

Every function as a node, with its fixtures and a coverage test of its own, comes with trustmybot/tmb#141.
