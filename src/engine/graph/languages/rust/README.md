# Rust

The code graph's rules for the files GitHub Linguist's list and rules call Rust (trustmybot/tmb#154): `.rs` files that Linguist's heuristics tell from RenderScript, and `.rs.in` files. They are read through tree-sitter's Rust grammar ([index.ts](index.ts)). Each rule names the page of [the Rust Reference](https://doc.rust-lang.org/reference/) it reads.

## What it reads

- Structs, enums, unions and type aliases are type nodes; a trait is an interface node. A module written with a body, `mod m { … }`, is a type node too: a type-like container whose items are named through it, `m.f`, and held by it. `mod m;` names another file and is no node.
- A function item is a function node. A function in a function's body is local to its block: named by its own name and held by the function around it.
- An implementation is no node. Its functions are method nodes of the type it is for, `T.f`, an implementation of a trait for a type included. They are held by that type's node when the scope the implementation is written in declares the type; otherwise they are held by the file and named by the type's last path segment.
- A trait's functions are method nodes named through the trait, `Tr.f`, the ones with no body included.
- A function of an `extern` block is a declaration whose code is elsewhere: no node.
- A closure is an unnamed function, inside the node around it.
- A `const` or a `static` at a file's top level is file-level data, a const node. One in a module, an implementation or a trait is a field, which is not yet a node; one in a block is a local.
- Fields, enum variants, `use` declarations, `macro_rules!` macros and derives are no nodes.
- A node starts at its first outer attribute or doc comment, across plain comments and blank lines. Its doc is the comments right above it, attributes skipped. It is exported when it is `pub`; a trait's function follows its trait.
- Calls are call expressions and method calls. A call's position is at the name it calls: the last segment of a path, or a method's name. A call is in the innermost function or closure around it. In a file-level constant's value it is in the constant; in an associated constant's value, in the type. A macro's input is tokens to the parser: the calls in it are not found.
- Every call is linked, outside the repo, or not known. No call is linked by its name alone, only by these rules:
  - A bare name `f(…)` is looked up in the items of each block around it, innermost first, then the items of its module, the file's or the `mod` body's (names/scopes.html). A module does not see its parent's items. The first scope that declares the name decides: one function there is linked; a tuple struct is its type, whose name is its constructor (items/structs.html); a file-level constant or static is its node. Two items of the name there, as `cfg` writes them, a `use`, an extern function or any other item is not known.
  - A scope with a glob import or a macro invoked where an item goes may hold a name it does not write out: a name it does not declare is not known there.
  - A local variable of the name anywhere in the function around the call, a parameter included, hides the items: not known.
  - `E::V(…)`, where `E` is an enum the scope declares and `V` a variant of it with fields in parentheses, links to the enum (items/enumerations.html). `Self(…)` and `Self::V(…)` in an implementation do the same for the type the implementation is for, when the file declares it in the same scope.
  - Every other call is not known: a method call, an associated function by its type's path, a path through another module, a name a `use` brings, a prelude function. [Way B](#way-b-rust-analyzer) gives these. Way A finds no call outside the repo.

## Way B: rust-analyzer

[tool.ts](tool.ts) runs the user's own `rust-analyzer`. Its `scip` command gives, for each name in the repo's code, the symbol the name refers to and where it is defined; [scip.ts](scip.ts) reads that index. Its `diagnostics` command gives the errors.
- The repo's `.rs` files are taken from the commit and written to a scratch folder, with each `Cargo.toml` and `Cargo.lock`. Each Cargo workspace is indexed from its root: a folder with a `Cargo.toml` and none above it.
- It runs no code of the repo and downloads nothing.
  - Cargo runs offline (`CARGO_NET_OFFLINE`), and rustup installs no toolchain (`RUSTUP_AUTO_INSTALL=0`).
  - No proc macro is expanded.
  - No build script is compiled or run. `scip` asks Cargo for the build scripts' output even when they are turned off, so the command it runs for that output is replaced by `rust-analyzer --version`.
  - A crate is read from Cargo's home on disk, if it is there. A call into a crate that is not there is not known.
- A call is linked when the symbol at its name is defined in the repo, at one place, and that place is one node: in the same file, of the same name, its lines holding the definition; when two hold it, the one that starts on its line.
  - A variant is its enum's, so `E::V(…)` links to the enum (items/enumerations.html).
  - A tuple struct's name is its symbol, so `S(…)` links to the struct.
- It is outside when the symbol belongs to no package of the repo: the standard library, or a crate on disk.
- It is not known in every other case:
  - a local, a closure included;
  - an error rust-analyzer reports inside the call;
  - a symbol defined at two places, such as one function written twice under `cfg`;
  - a symbol of the repo with no definition, such as a derived method;
  - a file rust-analyzer does not load: one `cfg` leaves out, or one in no Cargo workspace;
  - `Self(…)`, which rust-analyzer answers with the implementation, not the type.
- The layer records what it was built with: `rust-analyzer --version`, and, of each crate a Cargo.lock resolves from a registry, whether Cargo has unpacked it under `$CARGO_HOME/registry/src` (The Cargo Book, "Cargo Home"). A read that finds either changed rebuilds the layer (trustmybot/tmb#325).
- Without `rust-analyzer` on PATH, way B for Rust does not run. The built-in rules make the links, and the layer's note names what is missing.

The coverage test compares the functions and calls with Rust's own parser, rust-analyzer's (`rust-analyzer parse`), through [rust.ts](../../../../../tests/benchmark/rust.ts).
