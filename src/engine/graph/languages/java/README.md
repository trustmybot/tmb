# Java

The code graph's rules for `.java` files. They are read through tree-sitter's Java grammar ([index.ts](index.ts)). Each rule names the section of the [Java Language Specification, Java SE 21](https://docs.oracle.com/javase/specs/jls/se21/html/) it reads.

## What it reads

- Classes, enums and records are class nodes; interfaces and annotation interfaces are interface nodes. Each has its Javadoc comment, its signature and whether it is exported: `public`, or a member of an interface that is not `private`.
- A member type is named through the type it is declared in, `Outer.Inner`, and held by it. A local class, declared in a block, is named by its own name and held by the node around it.
- Methods, constructors, compact constructors and annotation interface elements are method nodes, named through their type: `T.m`, and `T.T` for a constructor. Overloads are one node each. An interface's method with no body is a node.
- A method of an anonymous class, an enum constant's body included, belongs to a type with no name. No type node holds it, so it is named by its own name and held by the node around it.
- A lambda is an unnamed function, inside the node around it.
- Fields, enum constants, record components, parameters and locals are no nodes.
- Calls are method invocations, class instance creations and the explicit constructor invocations `this(…)` and `super(…)`. A call's position is at the name it calls: the method's name, the created class's simple name, or `this` or `super`. A call is in the innermost method, constructor or lambda around it. In a field's value or an initializer it is in the type; in an anonymous class body, outside its methods, in the node around it. An enum constant's arguments make no call of their own, and a method reference calls nothing.
- Every call is linked, outside the repo, or not known. No call is linked by its name alone, only by these rules:
  - A simple method name `m()` names a method of the innermost type around it of which `m` is a member (15.12.1). The rules walk out from the innermost type. They stop, not known, at a type that names a supertype or at an anonymous class, since what those inherit is not in the file. A type's members are what it declares and what its kind's built-in supertype gives it: `Object` for a class and an interface, `Enum` for an enum, `Record` for a record. The call is linked when the type declares one method of that name and the built-in supertype has none (15.12.2 chooses among several by the arguments' types). It is outside when only the built-in supertype has the name. `this.m()` looks in the type of `this` only.
  - An enum's `values` and `valueOf` (8.9.3), and a record's accessors and its `equals`, `hashCode` and `toString` when it does not declare them (8.10.3), are declared by the language and have no declaration to link: not known.
  - `new C()` with a simple name links to the type `C` names (6.5.5.1): a member type of a type around the call, from the innermost out, then a top-level type of the file. A single-type import of `C` is not known; a public type of `java.lang`, which every file imports on demand (7.3), is outside, unless a file of the repo declares the name at its top level. A name a local class or a type parameter of the file declares is not known, and so is an anonymous class or a creation through an outer object.
  - `this(…)` links to the class itself. `super(…)` links to the superclass the file declares, by the same lookup from the scope around the class. In a class that names no superclass it is outside, `Object`'s (8.1.4).
  - `T.m()`, where `T` is a simple name that no variable of the file has and no static import names, is outside when `T` is a type of `java.lang` (6.5.2).
  - Every other call is not known: a call through a value, a call of a method another file declares or a type inherits, an overload, a static import. Way B, javac, gives these.
- [builtins.ts](builtins.ts) holds the public types of `java.lang` and, for each kind of type, the members its built-in supertype gives it. [builtins.gen.ts](builtins.gen.ts) writes it from the JDK on PATH, by reflection, and names that Java's release. A test fails when the two differ, and is skipped, saying why, without that Java.

The coverage test compares the functions and calls with Java's own parser, javac's, through [java_reference.java](../../../../../tests/benchmark/java_reference.java).
