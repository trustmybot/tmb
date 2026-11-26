# C

The code graph's rules for C files. They are read through tree-sitter's C grammar ([index.ts](index.ts)); the rules are in [family.ts](family.ts), which C++ shares ([../cpp/README.md](../cpp/README.md)). Each rule names the section of the C standard, ISO/IEC 9899:2011 ("C11"), it reads.

## Which files

- `.c`, `.cats` and `.idc` files are C. A `.h` file is C++ when its text has a construct only C++ has, by Linguist's heuristic (`#include <vector>`, `template <`, `namespace x`, `std::` and the like); else it is C. A header written for both languages is read as C unless it has one of them.

## What it reads

- Each function definition is a function node, named by the name its declarator declares (6.9.1, 6.7.6), with its comment above and its signature. A prototype, which has no body, is no node. A `static` function is not exported; the others are.
- A function whose head a macro's parentheses wrap, `M(static int f(int n)) { … }`, is the function `f`: a body at file level can only be a function's. The macro's name and parentheses are blanked before parsing, so every line and column stays where it is.
- A structure, union or enumeration with a body is a type node, named by its tag, else by the typedef name it is given (6.7.2.1, 6.7.2.2, 6.7.8). A tag is in the file's scope wherever it is written (6.2.1 p4).
- A variable at file level is a data node: `const`. A declaration that is no definition is none: a prototype and an `extern` declaration with no initializer (6.9.2). Fields, enumerators, parameters and locals are no nodes.
- Calls are call expressions, at the name they call: `f` in `f(x)`, and the field's name in `o.f(x)` and `p->f(x)`. A call is in the function around it; in a variable's initializer it is that variable's, or the file's when the declaration declares several. A call through an expression, as `(*f)(x)`, has no name and is no call; nor are a `sizeof` and a cast.
- Every call is linked or not known. No call is linked by its name alone, only by this rule:
  - `f(…)` by a plain name links to the file's one definition of `f` (6.2.1, 6.2.3: one namespace of ordinary identifiers in a file's scope, and no overloading), when no block around the call declares `f`, the file has no other declaration of `f` that is not a function's, no `#define` of `f`, and the definition is compiled wherever the call is: in the same conditional groups of `#if`, `#ifdef` and `#else`.
  - A call written in the arguments of a macro the file defines is not known: the macro decides what its input becomes (6.10.3).
  - Every other call is not known: a function another file defines, a call through a field or a pointer, a macro, a function a macro writes the head of. Way B, clangd with the project's compile database, gives these ([Way B: clangd](#way-b-clangd)).

## Way B: clangd

C and C++ share one tool, the user's own `clangd` ([clangd.ts](clangd.ts)). It reads the repo as the project's compile database says, and a file's language is what the database's command for it says, not its ending.

- The database is `compile_commands.json` at the repo's root, else in `build/`. With none, or a partial one, way B does not run, and the layer's note says why. A partial database is one with an entry clangd cannot read, or with an entry whose file is not on disk.
- The database's own files are asked first, each with its command; then the headers they include, which clangd reads with the command of a file that includes them. Any other file, such as another platform's source, gets no command from the database, so its calls are not known, and the note counts those files.
- Each call is asked at the name it calls, by clangd's syntax tree alone (`textDocument/symbolInfo`), never by a search of the text. Inside a macro, clangd's answer is the only one: a name it does not answer is not known.
- A call links to the node of the definition clangd names, else of its declaration: of its name, in its file, the innermost over its line. A construction links to the class. A call clangd answers with a declaration outside the repo, the system's headers, is outside. A function the repo declares and never defines, a call through a field, and a call with an error clangd reports at it are not known.
- clangd runs with no background index, so it writes nothing into the repo, and without `--query-driver`, so it runs no compiler.

The benchmark compares the functions, calls and links with clang's own answer, through libclang and the project's compile database ([c_reference.py](../../../../../tests/benchmark/c_reference.py)).
