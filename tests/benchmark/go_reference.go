// The benchmark's reference for Go's functions and calls (trustmybot/tmb#352): Go's own parser,
// go/parser, from the standard library, so it runs with any `go` and downloads nothing.
//
// It reads {"files": {path: text}} as JSON on stdin and writes, for each file, the functions
// go/parser finds and how many calls each holds:
//
//	{"version": "go1.27.4", "files": {path: {"functions": ["start-end", ...], "calls": {"start-end" or "": n}}
//	                                  or {"error": "why go/parser cannot parse it"}}}
//
// A function, by the Go spec (https://go.dev/ref/spec) and CODE_GRAPH.md's "Kinds of symbol":
//   - a FunctionDecl or a MethodDecl, from `func` to its last line;
//   - a FunctionLit, `func() {}`, an unnamed function;
//   - a method spec of an interface type that a package-level type declaration names: a method
//     declared in a type, with no body;
//   - a FunctionLit that is the one value of a package-level declaration of one name is that
//     name's one callable node, which starts where the declaration starts ("A symbol's lines are
//     its whole declaration"): at `var` for a lone declaration, else at the name.
//
// A call is an ast.CallExpr, a conversion included, which Go writes the same way ("Calls",
// "Conversions"). It belongs to the innermost function around it; outside every function, to the
// file (""), whatever package-level declaration holds it.
package main

import (
	"encoding/json"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"runtime"
	"sort"
)

type fileAnswer struct {
	Functions []string       `json:"functions"`
	Calls     map[string]int `json:"calls"`
	Error     string         `json:"error,omitempty"`
}

func measure(fset *token.FileSet, f *ast.File) fileAnswer {
	functions := []string{}
	calls := map[string]int{}
	span := func(from, to token.Pos) string {
		return fmt.Sprintf("%d-%d", fset.Position(from).Line, fset.Position(to-1).Line)
	}
	// The FunctionLits that are a package-level name's one value, and where that declaration starts.
	starts := map[*ast.FuncLit]token.Pos{}
	for _, d := range f.Decls {
		g, ok := d.(*ast.GenDecl)
		if !ok {
			continue
		}
		for _, s := range g.Specs {
			switch s := s.(type) {
			case *ast.ValueSpec:
				if len(s.Names) != 1 || len(s.Values) != 1 || s.Names[0].Name == "_" {
					continue
				}
				if lit, ok := s.Values[0].(*ast.FuncLit); ok {
					start := s.Pos()
					if !g.Lparen.IsValid() {
						start = g.Pos()
					}
					starts[lit] = start
				}
			case *ast.TypeSpec:
				if it, ok := s.Type.(*ast.InterfaceType); ok {
					for _, m := range it.Methods.List {
						if _, ok := m.Type.(*ast.FuncType); ok && len(m.Names) > 0 {
							functions = append(functions, span(m.Pos(), m.End()))
						}
					}
				}
			}
		}
	}
	var visit func(n ast.Node, owner string)
	visit = func(n ast.Node, owner string) {
		ast.Inspect(n, func(c ast.Node) bool {
			switch c := c.(type) {
			case *ast.FuncDecl:
				if c == n {
					return true
				}
				key := span(c.Pos(), c.End())
				functions = append(functions, key)
				visit(c, key)
				return false
			case *ast.FuncLit:
				if c == n {
					return true
				}
				from := c.Pos()
				if start, ok := starts[c]; ok {
					from = start
				}
				key := span(from, c.End())
				functions = append(functions, key)
				visit(c, key)
				return false
			case *ast.CallExpr:
				calls[owner]++
			}
			return true
		})
	}
	visit(f, "")
	sort.Strings(functions)
	return fileAnswer{Functions: functions, Calls: calls}
}

func main() {
	var in struct {
		Files map[string]string `json:"files"`
	}
	if err := json.NewDecoder(os.Stdin).Decode(&in); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	out := map[string]fileAnswer{}
	for path, text := range in.Files {
		fset := token.NewFileSet()
		f, err := parser.ParseFile(fset, path, text, parser.SkipObjectResolution)
		if err != nil {
			out[path] = fileAnswer{Error: err.Error()}
			continue
		}
		out[path] = measure(fset, f)
	}
	if err := json.NewEncoder(os.Stdout).Encode(map[string]any{"version": runtime.Version(), "files": out}); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
