# C++

The code graph's rules for C++ files. They are read through tree-sitter's C++ grammar ([index.ts](index.ts)); the rules are in [../c/family.ts](../c/family.ts), which C shares ([../c/README.md](../c/README.md)). Each rule names the section of the C++ standard, ISO/IEC 14882:2020, it reads, by its stable name.

## Which files

- `.cc`, `.cpp`, `.cxx`, `.hpp`, `.hh`, `.inl`, `.ipp`, `.tpp` and Linguist's other C++ endings are C++. A `.h` file is C++ when its text has a construct only C++ has, by Linguist's heuristic; else it is C.

## What it reads

- A named namespace is a type node, named through the namespaces around it: `a::b` is `a.b` ([namespace.def]). An unnamed namespace adds no name, and its members are not exported ([namespace.unnamed]). `extern "C"` adds nothing.
- A class, structure or union with a body is a class node; an enumeration is a type node. Each is named through the namespaces and classes around it. A class declared in a function is named by its own name and held by that function.
- A class head has one class name ([class.pre]): `class M N {`, with an export macro `M`, is the class `N`, in a namespace and in a class's body alike.
- A member function, constructor, destructor and conversion defined in a class is a method node named through the class: `Cart.total`, `Cart.Cart`, `Cart.~Cart`. A member defined outside its class, `Cart::total`, is named `Cart.total` and held by the class when the file defines it, else by the file. A function a qualified name defines in a namespace the file declares is that namespace's function.
- A pure virtual function is a method node, though it has no body ([class.abstract]); so are a deleted and a defaulted function ([dcl.fct.def.delete], [dcl.fct.def.default]). Any other member function with only a declaration is no node.
- A function of a namespace is a function node named through it. A friend function defined in a class is named by its own name ([class.friend]). A template's lines start at its `template` head.
- A function whose head a macro's parentheses wrap, `M(static int f(int n)) { … }`, is the function `f`; a word after a function's declarator and before its body, `int f(int n) M(x) { … }`, as an annotation macro writes it, is no function of its own. Each macro is blanked before parsing, every line and column kept.
- A lambda is an unnamed function, inside the node around it.
- A variable of the global namespace or an unnamed one is a data node. A variable of a named namespace is a member of that namespace, a type: a field, no node. Data members, parameters and locals are no nodes.
- Calls are call expressions, at the name they call (`f` in `f(x)`, `ns::f(x)`, `f<T>(x)` and `o.f(x)`), and `new T(…)`, at the name of `T`. A cast, named or functional to a built-in type, is no call.
- Every call is linked or not known. No call is linked by its name alone, only by these rules:
  - In a member function, `f(…)` or `this->f(…)` links to the class's member `f` when the class declares one member function of that name, no other member of that name and no using-declaration of it ([class.member.lookup], [basic.lookup.unqual]). The target is the member's node in the class, or its one definition outside it.
  - In a member function, a construction by the class's own name or by a member class's name links to that class ([class.pre] p2, the injected class name), as the page's "A construction links to the class" says.
  - Outside a class, `f()` with no arguments, which has no argument-dependent lookup ([basic.lookup.argdep]), links when the file declares `f` in the call's namespace before the call and defines one `f` there, with nothing else of that name, compiled wherever the call is.
  - A name a block declares or a `#define` defines is not known, and so is a call written in the arguments of a macro the file defines.
  - Every other call is not known: an overload, a call through a value, a call with arguments outside a class, a function another file defines. Way B, clangd with the project's compile database, gives these.

The benchmark compares the functions, calls and links with clang's own answer, through libclang and the project's compile database ([c_reference.py](../../../../../tests/benchmark/c_reference.py)).
