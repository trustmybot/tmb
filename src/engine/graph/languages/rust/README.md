# Rust

The code graph's rules for `.rs` files. They are read through tree-sitter's Rust grammar ([index.ts](index.ts)). Each rule names the page of [the Rust Reference](https://doc.rust-lang.org/reference/) it reads.

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
  - Every other call is not known: a method call, an associated function by its type's path, a path through another module, a name a `use` brings, a prelude function. Way B, rust-analyzer, gives these. Way A finds no call outside the repo.

The coverage test compares the functions and calls with Rust's own parser, rust-analyzer's (`rust-analyzer parse`), through [rust.ts](../../../../../tests/benchmark/rust.ts).
