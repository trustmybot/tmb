# TypeScript, TSX and JavaScript

The code graph's rules for `.ts`, `.mts`, `.cts`, `.tsx`, `.js`, `.mjs`, `.cjs` and `.jsx` files. One set of rules ([rules.ts](rules.ts)) serves all three grammars ([index.ts](index.ts)).

## What counts as a function

Every node that has a body, the same set the TypeScript compiler calls function-like:

- a function declaration or expression, and a generator of either kind;
- an arrow function;
- a method of a class or of an object literal, with constructors, getters and setters.

A signature with no body (an overload, an abstract method, a declaration in a `.d.ts`) is not a function.

A function with no name of its own is still one node. It is named by where it is used, such as "callback of `map`", and its owner is the nearest named symbol around it.

## A repair of one parser misreading

tree-sitter-typescript 0.23 reads a `<` that starts a line as type arguments of the type on the line before. A generic call signature on its own line in an interface then breaks the parse to the end of the file, and every function after it is lost (trustmybot/tmb#247). [repair.ts](repair.ts) writes a `;` over the space before each such `<`, so every line and column stays where it was, and keeps the repaired tree only when it has fewer errors. It runs for TypeScript and TSX only. It goes when the parser is fixed upstream.

## How a call's name is looked up

As the language looks it up (trustmybot/tmb#246): the function's own names and parameters, the functions and blocks around it, then the file and its imports. The first place that has the name decides. A parameter or a variable there is no function of the repo, so the call is not linked. A function declared there is linked.

A name imported as `import { a as b }` is looked up by `a` in the file that import names, never through another import of an `a`. That holds for a class under its new name too: as the object of a call (`b.m()`), as a parent (`extends b`) and as a declared type (trustmybot/tmb#287). A bare or imported name never links a class's method of that name (trustmybot/tmb#242).

A call on `this` is looked up in its class and the class's parents only, never among the file's names or imports. The first class that has the name decides: a field with no function value, a signature with no body, a constructor's parameter property, or a name the class's own methods assign on `this` and its body does not declare, stops the lookup, so the call is not linked (trustmybot/tmb#287). Outside a named class, a call on `this` is not linked.

Each class is its own symbol, so two classes of one name in one file stay two. A name that names both, such as a call on `this` in either, is not linked.

## Where a call goes

Every call or construction written in a function is in one of three states (trustmybot/tmb#252): linked to a definition of the repo, outside the repo, or not known. A call is what the grammar writes as one: a call, a `new`, a tagged template, `import(…)`, `super(…)`. `import("m")` in a type, as in `let d: import("m").T`, runs nothing and is no call. A call whose callee is no name, such as `f()()`, is named by its callee's text and is not known.

A call is outside the repo only on the same proof a link needs. Its name, or the name it is called on in `x.f()`, is looked up as above and ends at either:

- an import of a module that names no file of the repo and none of its own code, the same answer that makes the import no miss; or
- a global value of the compiler's default library, with no declaration of that name anywhere in the file and none at the top of any file of the repo, since a script's top-level names are globals too. On `x.f()`, the library must declare a callable `f` on `x`.

[globals.ts](globals.ts) holds those globals. [globals.gen.ts](globals.gen.ts) writes it from the TypeScript compiler, a development dependency; run it after the compiler is upgraded. A test fails when the two differ. A method called on any other value, a parameter say, is not known: the graph does not guess a receiver's type.

## Its tests

[functions.test.ts](functions.test.ts) checks the rules on fixtures and on tmb's own repo. [coverage.ts](coverage.ts) compares them against the TypeScript compiler, a second and independent parser: every function the compiler finds must be one node of the graph, and the graph must hold no other.

[links.test.ts](links.test.ts) checks the links (trustmybot/tmb#242): every cross-file `calls` and `instantiates` link the graph makes with resolution `exact` must name a declaration the TypeScript compiler gives for that name on that line, by file and overlapping lines. [links.ts](links.ts) builds the graph as tmb does and the compiler's program over the same commit. A link the graph did not make is no failure; a link the compiler cannot answer for is counted, not judged. A link where the compiler names only a declaration outside the repo is wrong, since every link of the graph is into the repo (trustmybot/tmb#287). The same test checks the call states: each function's linked, outside and not known calls add up to the calls and constructions the compiler finds written in it, and no call put outside the repo is one the compiler finds declared in it. A call in a class body outside its methods, such as a field's initial value, counts for the class. Both tests run on tmb's own repo and on hono pinned ([tests/lib/pinned-repo.ts](../../../../../tests/lib/pinned-repo.ts)).
