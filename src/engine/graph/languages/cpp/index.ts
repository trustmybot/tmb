// C++, read through tree-sitter (trustmybot/tmb#355): its namespaces, classes, structures, unions and
// enumerations, their member functions, the functions of its namespaces, its lambdas, its variables
// of the global namespace, and the calls each function makes. The rules are in ../c/family.ts, which
// C shares; each names the section of the C++ standard (ISO/IEC 14882:2020) it reads, by its stable
// name. Way A links only what those rules prove inside one file; the rest is the tool's.
import cppWasm from 'tree-sitter-cpp/tree-sitter-cpp.wasm' with { type: 'file' };
import type { Node } from 'web-tree-sitter';
import type { LanguageModule } from '../contract.ts';
import { syntaxTree } from '../kit.ts';
import { extractFamily, parseFamily } from '../c/family.ts';

// Linguist's heuristic for a `.h` file that is C++ (heuristics.yml, commit cfd7a0113aa1, named
// pattern `cpp`): any one of these in its text. Each `^` and `$` is a line's start and end, as in
// Linguist's Ruby.
const CPP_HEADER_PATTERNS: readonly RegExp[] = [
  /^\s*#\s*include <(cstdint|string|vector|map|list|array|bitset|queue|stack|forward_list|unordered_map|unordered_set|(i|o|io)stream)>/m,
  /^\s*template\s*</m,
  /^[ \t]*(try|constexpr)/m,
  /^[ \t]*catch\s*\(/m,
  /^[ \t]*(class|(using[ \t]+)?namespace)\s+\w+/m,
  /^[ \t]*(private|public|protected):$/m,
  /__has_cpp_attribute|__cplusplus >/m,
  /std::\w+/m,
];

/** The class specifiers the grammar reads as one with a name and no body. */
const CLASS_KEYS: ReadonlySet<string> = new Set(['class_specifier', 'struct_specifier', 'union_specifier']);

// A class head names one class ([class.pre] p1): `class M N {` or `class M N : B {` has a word too
// many before the class's name, as a macro that expands to an attribute or to nothing writes it (an
// export macro). The grammar reads it as a function `N` of type `class M`, in a class's body a
// member `N`, which a function cannot be: its declarator declares no function. Each such word is blanked, keeping every line and
// column, and the file parsed again.
function classHeadMacros(root: Node): [number, number][] {
  const words: [number, number][] = [];
  const walk = (n: Node): void => {
    if (n.type === 'function_definition') {
      const type = n.childForFieldName('type');
      const declarator = n.childForFieldName('declarator');
      const name = type && CLASS_KEYS.has(type.type) && !type.childForFieldName('body') ? type.childForFieldName('name') : null;
      if (name?.type === 'type_identifier' && (declarator?.type === 'identifier' || declarator?.type === 'field_identifier')) words.push([name.startIndex, name.endIndex]);
    }
    for (const c of n.namedChildren) if (c) walk(c);
  };
  walk(root);
  return words;
}

export const cpp: LanguageModule = {
  name: 'cpp',
  // Linguist's endings for C++ (languages.yml, commit cfd7a0113aa1). It shares `.h` with C.
  extensions: ['cpp', 'c++', 'cc', 'cp', 'cppm', 'cxx', 'h', 'h++', 'hh', 'hpp', 'hxx', 'inl', 'ino', 'ipp', 'ixx', 're', 'tcc', 'tpp', 'txx'],
  claims: (text) => CPP_HEADER_PATTERNS.some((p) => p.test(text)),
  grammar: cppWasm,
  comment: 'slash',
  parse: parseFamily('cpp', classHeadMacros),
  extract: (file, out) => extractFamily('cpp', syntaxTree(file), file.src, out, file.module),
};
