// What each fixture's calls must reach, written from the Java Language Specification before any
// candidate ran (trustmybot/tmb#346). A call is `file:line:name`; its answer is the node it links
// to as `name@line` (the node's first line), "outside", or "not known".
export const EXPECTED: Record<string, Record<string, string>> = {
  minimal: {
    // The page's example: `var c = makeCart(); c.total()`, where the type of `c` is not written.
    "MixedCase/shop/Main.java:9:makeCart": "makeCart@4",
    "MixedCase/shop/Main.java:10:total": "total@15",
    "MixedCase/shop/Main.java:10:println": "outside",
    // Cart writes no constructor; the default one (JLS 8.8.9) has no node and is placed at its class.
    "MixedCase/shop/Main.java:5:Cart": "Cart@7",
    "MixedCase/shop/Main.java:5:add": "add@10",
    // After an emoji and a non-ASCII letter on the same line: positions count UTF-16 units.
    "MixedCase/shop/Main.java:5:Item": "Item@7",
    "MixedCase/shop/Cart.java:8:ArrayList": "outside",
    "MixedCase/shop/Cart.java:11:add": "outside",
    "MixedCase/shop/Cart.java:16:stream": "outside",
    "MixedCase/shop/Cart.java:16:mapToInt": "outside",
    // In a lambda whose parameter type is inferred (JLS 15.27.3).
    "MixedCase/shop/Cart.java:16:price": "price@12",
    "MixedCase/shop/Cart.java:16:sum": "outside",
  },
  edges: {
    // An enum's values() is declared implicitly (JLS 8.9.3): no node, so not known. ordinal() is java.lang.Enum's.
    "pkg/Shapes.java:10:values": "not known",
    "pkg/Shapes.java:10:ordinal": "outside",
    "pkg/Shapes.java:16:IllegalArgumentException": "outside",
    // A record's accessors are declared implicitly (JLS 8.10.3): no node, so not known.
    "pkg/Shapes.java:20:x": "not known",
    "pkg/Shapes.java:20:y": "not known",
    // this(...) and super(...) (JLS 8.8.7.1).
    "pkg/Shapes.java:39:this": "Square@42",
    "pkg/Shapes.java:43:super": "Base@25",
    // An anonymous class runs its superclass's constructor (JLS 15.9.5.1).
    "pkg/Shapes.java:52:Base": "Base@25",
    "pkg/Shapes.java:60:make": "make@51",
    // The record's compact canonical constructor (JLS 8.10.4), inside a lambda.
    "pkg/Shapes.java:61:Point": "Point@15",
    "pkg/Shapes.java:61:sum": "sum@19",
    // A qualified inner class creation (JLS 15.9.2) of a class with a default constructor.
    "pkg/Shapes.java:62:Inner": "Inner@31",
    // A method of the static type, abstract here (JLS 15.12.3).
    "pkg/Shapes.java:63:area": "area@28",
    "pkg/Shapes.java:63:get": "outside",
    "pkg/Shapes.java:63:v": "v@32",
    "pkg/Shapes.java:63:next": "next@9",
    "pkg/Shapes.java:63:ordinal": "outside",
  },
};
