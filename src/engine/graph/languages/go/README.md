# Go

The code graph's rules for `.go` files. They are read through tree-sitter's Go grammar ([index.ts](index.ts)). Each rule names the part of the [Go spec](https://go.dev/ref/spec) it reads.

## What it reads

- Functions, methods and types, each with its doc comment, its signature and whether it is exported (an upper-case first letter).
- A method is the node `T.M`, named by its receiver's base type: `T` in `(r *T)` and `(r T[K])`. Its container is the type when the same file declares it, else the file.
- An interface type at package level holds its methods: each method spec is a method node `I.M` with no body.
- A package-level `var` that binds one name to one function literal, `var f = func() {}`, is the function `f`. It starts at `var` for a lone declaration, else at its name. Every other package-level `var` and `const` name is file-level data. `_` declares nothing.
- A function literal anywhere else is an unnamed function, inside the function around it.
- Calls, conversions included, since Go writes `T(x)` as a call. A call's position is at the name it calls: `f`, the `f` of `x.f`, or the `F` of `pkg.F`. A call is in the innermost function around it. Outside every function it is in the package-level declaration that binds one name, else in the file.
- Every call is linked, outside the repo, or not known:
  - A plain name is linked to the function or the file-level data of that name the same file declares at package level. It is not linked when the package-level declaration around the call binds the name itself, since Go looks a name up there first: a receiver, a parameter, a result, a type parameter, or a name a `var`, `const`, `type`, `:=`, `range`, type switch or `select` case declares.
  - A predeclared function or type, such as `len` or `int`, is outside the repo, unless a file of the repo declares the name at package level. [builtins.ts](builtins.ts) holds them. [builtins.gen.ts](builtins.gen.ts) writes it from the universe scope of the Go on PATH, and names that Go's release. A test fails when the two differ, and is skipped, saying why, without that Go.
  - Every other call is not known: a call of a name another file of the package declares, of an import, or of a method or field through a value, or a conversion to a type of the repo. Way B, Go's own type checker, gives these.

The coverage test compares the functions and calls with Go's own parser, `go/parser`, through [go_reference.go](../../../../../tests/benchmark/go_reference.go).
