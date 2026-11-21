# TypeScript, TSX and JavaScript

The code graph's rules for `.ts`, `.mts`, `.cts`, `.tsx`, `.js`, `.mjs`, `.cjs` and `.jsx` files. One set of rules ([rules.ts](rules.ts)) serves all three grammars ([index.ts](index.ts)).

## What counts as a function

Every node that has a body, the same set the TypeScript compiler calls function-like:

- a function declaration or expression, and a generator of either kind;
- an arrow function;
- a method of a class or of an object literal, with constructors, getters and setters.

A signature with no body (an overload, an abstract method, a declaration in a `.d.ts`) is not a function.

A function with no name of its own is still one node. It is named by where it is used, such as "callback of `map`", and its owner is the nearest named symbol around it.

## How a call's name is looked up

As the language looks it up (trustmybot/tmb#246): the function's own names and parameters, the functions and blocks around it, then the file and its imports. The first place that has the name decides. A parameter or a variable there is no function of the repo, so the call is not linked. A function declared there is linked.

A call on `this` is looked up in its class and the class's parents only, never among the file's names or imports. A field with no function value, or an abstract method, is not linked. Outside a named class, a call on `this` is not linked.

## Its tests

[functions.test.ts](functions.test.ts) checks the rules on fixtures and on tmb's own repo. [coverage.ts](coverage.ts) compares them against the TypeScript compiler, a second and independent parser: every function the compiler finds must be one node of the graph, and the graph must hold no other.
