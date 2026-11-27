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

## Way B: Go's type checker

[tool.ts](tool.ts) runs the helper [gotypes.go](gotypes.go) with the user's own `go`. The helper uses only Go's standard library. `go list` lays out the repo's packages and their tests under the default build configuration. `go/types` then checks them from source.

The helper is built once, the first time a Go repo is indexed, and every later graph build runs it:
- It is built with the user's `go`, the one the find order finds, and its `go list` runs that same `go`: a helper built by an older Go gives wrong answers.
- It is kept in tmb's tools folder under its name and key: `<state>/tools/gotypes/<key>/gotypes`. The key is a sha256 of the helper's source, the build's `go.mod` and recipe, the exact `go env GOVERSION`, and the machine's `GOHOSTOS`/`GOHOSTARCH`. A new key builds a new helper; once it is built, the helpers of other keys are removed.
- It is built in a folder of its own, under a `go.mod` that says `go 1.22`, so the source compiles at the language level of the lowest Go tmb supports. It is built to a temporary name and moved into place, so two builds at once each leave a whole program.
- The build takes none of the user's Go settings: every variable `go env` reports is left out, with its settings file (`GOENV=off`), and it builds with `GOPROXY=off`, `GOTOOLCHAIN=local`, `GOWORK=off`, `CGO_ENABLED=0`, `GOFLAGS=` and `-trimpath -buildvcs=false`. It uses the user's Go build cache. It downloads nothing, so the setting that turns installs off does not stop it.
- A failed build means the built-in rules for Go, and the layer's note names the error.
- `tmb tools` lists the helper beside Go: where it is kept, and whether it is built yet.
- The repo's files are taken from the commit and written to a scratch folder, with the module settings files (`go.mod`, `go.sum`, `go.work`, `go.work.sum`, `vendor/modules.txt`) of each folder that holds Go code.
- It runs no code of the repo and downloads nothing: `GOPROXY=off`, `GOTOOLCHAIN=local`, `CGO_ENABLED=0`. A module is read from the module cache on disk, if it is there. A call into a module that is not there is not known.
- A call is linked when the declaration `go/types` names is in the repo, is a function, method, interface method, type, `var` or `const`, and is one node: the innermost node of that name in that file whose lines hold the declaration.
- It is outside when the declaration is outside the repo: a predeclared name, the standard library or a module on disk.
- It is not known in every other case: a local, a parameter or a field, an error the type checker reports inside the call, a package it could not load whole, or a file the build leaves out.
- A package `go/types` cannot check at all is an error, and the built-in rules make the links, with a note naming it: a module `go list` cannot lay out, as one that needs a newer Go; a package `go/types` gives none for; an error `Check` returns without reporting it to `Config.Error`, which stopped it before it checked; or a file that needs a newer Go than `go/types` knows (its `TooNew` code). An ordinary type error is not this case: the calls it touches are not known, and counted.
- The helper needs Go 1.22 or later (`ast.Unparen`). If it fails, the built-in rules make the links, and the layer's note says why.
- Without `go` on PATH, way B for Go does not run. The built-in rules make the links, and the layer's note names what is missing.
- The layer records what it was built with: `go version`; the helper's key, its source's sha256 and the `go env GOVERSION` that built it; and, for each module version the repo's `go.sum` files list, whether the module cache holds it. A read that finds any of them changed rebuilds the layer (trustmybot/tmb#325).

The coverage test compares the functions and calls with Go's own parser, `go/parser`, through [go_reference.go](../../../../../tests/benchmark/go_reference.go).
