// gotypes: the Go toolchain's own answer for a repo (trustmybot/tmb#346), as JSON on stdout.
//
// It plays two parts in the A/B of way B's tool for Go:
//   - the candidate "go/types", the type checker of the official Go toolchain, reached through
//     golang.org/x/tools/go/packages, which runs `go list` the way the go command builds;
//   - the reference the other candidates are scored against, since Go has no tool independent of
//     go/types (gopls and scip-go are built on it too).
//
// Usage: gotypes <repo dir> <file list> [package patterns...]
// The file list names the repo's .go files, one per line, relative to the repo, as git lists them
// at the pinned commit. Every one is parsed by go/parser for the functions the compiler finds,
// whatever its build constraints. Calls come only from the files the type checker loads under the
// default build configuration, test files included.
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"go/types"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"

	"golang.org/x/tools/go/packages"
)

// Fn is one declaration go/parser finds that the graph makes a node of, or that a call may name.
type Fn struct {
	File  string `json:"file"`
	Kind  string `json:"kind"` // func, method, funclit, ifacemethod, type, var, const
	Name  string `json:"name"`
	Start int    `json:"start"`
	End   int    `json:"end"`
	Body  bool   `json:"body"`
}

// Decl is where the type checker declares what a call names.
type Decl struct {
	File string `json:"file"` // relative to the repo when inside it, else absolute
	Line int    `json:"line"`
	Name string `json:"name"`
	// What the object is: func, method, ifacemethod, pkgvar, localvar, field, param, type.
	Kind   string `json:"kind"`
	InRepo bool   `json:"inRepo"`
}

// Call is one call expression of a loaded file.
type Call struct {
	File string `json:"file"`
	Off  int    `json:"off"` // byte offset where the called name is written, else where the call starts
	Line int    `json:"line"`
	Name string `json:"name"`
	// The line the owning named declaration starts on: a function, a method, or a package-level
	// var or const spec that binds one name. 0 for the file.
	Owner int    `json:"owner"`
	Kind  string `json:"kind"` // call, conversion, builtin
	// How the callee is written: name, pkgname (pkg.F), selector (x.f), other.
	Callee string `json:"callee"`
	Decl   *Decl  `json:"decl,omitempty"`
}

type Out struct {
	Go         string   `json:"go"`
	LoadMs     int64    `json:"loadMs"`
	Packages   int      `json:"packages"`
	Errors     []string `json:"errors"`
	Loaded     []string `json:"loaded"` // files the type checker loaded, relative
	Functions  []Fn     `json:"functions"`
	Calls      []Call   `json:"calls"`
	ParseFails []string `json:"parseFails"`
}

func main() {
	if len(os.Args) < 3 {
		fmt.Fprintln(os.Stderr, "usage: gotypes <repo dir> <file list> [patterns...]")
		os.Exit(2)
	}
	repo, err := filepath.Abs(os.Args[1])
	must(err)
	repo, err = filepath.EvalSymlinks(repo)
	must(err)
	files := readList(os.Args[2])
	patterns := os.Args[3:]
	if len(patterns) == 0 {
		patterns = []string{"./..."}
	}
	out := Out{Go: goVersion(), Errors: []string{}, Loaded: []string{}, Functions: []Fn{}, Calls: []Call{}, ParseFails: []string{}}

	// The functions the compiler's own parser finds, in every file.
	fset := token.NewFileSet()
	for _, rel := range files {
		f, err := parser.ParseFile(fset, filepath.Join(repo, rel), nil, parser.SkipObjectResolution)
		if err != nil {
			out.ParseFails = append(out.ParseFails, rel+": "+err.Error())
			if f == nil {
				continue
			}
		}
		out.Functions = append(out.Functions, functions(fset, rel, f)...)
	}

	// The calls, from the packages the type checker loads.
	t := time.Now()
	cfg := &packages.Config{
		Mode:  packages.NeedName | packages.NeedFiles | packages.NeedSyntax | packages.NeedTypes | packages.NeedTypesInfo | packages.NeedImports | packages.NeedDeps,
		Dir:   repo,
		Tests: true,
		Fset:  token.NewFileSet(),
	}
	pkgs, err := packages.Load(cfg, patterns...)
	must(err)
	out.LoadMs = time.Since(t).Milliseconds()
	out.Packages = len(pkgs)
	seen := map[string]bool{}
	callSeen := map[string]bool{}
	for _, p := range pkgs {
		for _, e := range p.Errors {
			out.Errors = append(out.Errors, e.Error())
		}
		for _, f := range p.Syntax {
			abs := cfg.Fset.File(f.FileStart).Name()
			rel, ok := relTo(repo, abs)
			if !ok || p.TypesInfo == nil {
				continue
			}
			if !seen[rel] {
				seen[rel] = true
				out.Loaded = append(out.Loaded, rel)
			}
			for _, c := range calls(cfg.Fset, repo, rel, f, p.TypesInfo) {
				key := fmt.Sprintf("%s:%d", c.File, c.Off)
				if callSeen[key] {
					continue
				}
				callSeen[key] = true
				out.Calls = append(out.Calls, c)
			}
		}
	}
	sort.Strings(out.Loaded)
	sort.Slice(out.Calls, func(i, j int) bool {
		if out.Calls[i].File != out.Calls[j].File {
			return out.Calls[i].File < out.Calls[j].File
		}
		return out.Calls[i].Off < out.Calls[j].Off
	})
	enc := json.NewEncoder(os.Stdout)
	must(enc.Encode(out))
}

func goVersion() string {
	return strings.TrimSpace(runtime.Version())
}

func readList(path string) []string {
	f, err := os.Open(path)
	must(err)
	defer f.Close()
	var out []string
	s := bufio.NewScanner(f)
	for s.Scan() {
		if l := strings.TrimSpace(s.Text()); l != "" {
			out = append(out, l)
		}
	}
	return out
}

func relTo(repo, abs string) (string, bool) {
	if r, err := filepath.EvalSymlinks(abs); err == nil {
		abs = r
	}
	rel, err := filepath.Rel(repo, abs)
	if err != nil || strings.HasPrefix(rel, "..") {
		return abs, false
	}
	return filepath.ToSlash(rel), true
}

// functions lists the declarations of one file the graph makes nodes of (Go spec: Function
// declarations, Method declarations, Function literals, Type declarations, Variable and Constant
// declarations at package level), plus the method specs of interface types.
func functions(fset *token.FileSet, rel string, f *ast.File) []Fn {
	var out []Fn
	line := func(p token.Pos) int { return fset.Position(p).Line }
	add := func(kind, name string, from, to token.Pos, body bool) {
		out = append(out, Fn{File: rel, Kind: kind, Name: name, Start: line(from), End: line(to), Body: body})
	}
	for _, d := range f.Decls {
		switch d := d.(type) {
		case *ast.FuncDecl:
			kind, name := "func", d.Name.Name
			if d.Recv != nil && len(d.Recv.List) > 0 {
				kind, name = "method", recvName(d.Recv.List[0].Type)+"."+d.Name.Name
			}
			add(kind, name, d.Pos(), d.End(), d.Body != nil)
		case *ast.GenDecl:
			for _, s := range d.Specs {
				switch s := s.(type) {
				case *ast.TypeSpec:
					add("type", s.Name.Name, s.Pos(), s.End(), false)
				case *ast.ValueSpec:
					kind := "var"
					if d.Tok == token.CONST {
						kind = "const"
					}
					for _, n := range s.Names {
						if n.Name != "_" {
							add(kind, n.Name, s.Pos(), s.End(), false)
						}
					}
				}
			}
		}
	}
	ast.Inspect(f, func(n ast.Node) bool {
		switch n := n.(type) {
		case *ast.FuncLit:
			add("funclit", "", n.Pos(), n.End(), true)
		case *ast.InterfaceType:
			for _, m := range n.Methods.List {
				if _, ok := m.Type.(*ast.FuncType); ok {
					for _, nm := range m.Names {
						add("ifacemethod", nm.Name, m.Pos(), m.End(), false)
					}
				}
			}
		}
		return true
	})
	return out
}

func recvName(e ast.Expr) string {
	for {
		switch t := e.(type) {
		case *ast.StarExpr:
			e = t.X
		case *ast.ParenExpr:
			e = t.X
		case *ast.IndexExpr:
			e = t.X
		case *ast.IndexListExpr:
			e = t.X
		case *ast.Ident:
			return t.Name
		default:
			return "?"
		}
	}
}

// calls lists every call expression of one file with the type checker's answer for its callee.
func calls(fset *token.FileSet, repo, rel string, f *ast.File, info *types.Info) []Call {
	var out []Call
	pos := func(p token.Pos) token.Position { return fset.Position(p) }
	// owner: the named declaration around each top-level node.
	for _, d := range f.Decls {
		owner := 0
		switch d := d.(type) {
		case *ast.FuncDecl:
			owner = pos(d.Pos()).Line
		case *ast.GenDecl:
			// handled per spec below
		}
		visit := func(root ast.Node, owner int) {
			ast.Inspect(root, func(n ast.Node) bool {
				call, ok := n.(*ast.CallExpr)
				if !ok {
					return true
				}
				out = append(out, oneCall(fset, repo, rel, call, owner, info))
				return true
			})
		}
		if g, ok := d.(*ast.GenDecl); ok && (g.Tok == token.VAR || g.Tok == token.CONST) {
			for _, s := range g.Specs {
				vs := s.(*ast.ValueSpec)
				o := 0
				if len(vs.Names) == 1 && vs.Names[0].Name != "_" {
					o = pos(vs.Pos()).Line
				}
				visit(vs, o)
			}
			continue
		}
		visit(d, owner)
	}
	return out
}

func oneCall(fset *token.FileSet, repo, rel string, call *ast.CallExpr, owner int, info *types.Info) Call {
	fun := ast.Unparen(call.Fun)
	// A generic function's instantiation, f[T](x), calls f.
	switch t := fun.(type) {
	case *ast.IndexExpr:
		fun = ast.Unparen(t.X)
	case *ast.IndexListExpr:
		fun = ast.Unparen(t.X)
	}
	var ident *ast.Ident
	callee := "other"
	switch t := fun.(type) {
	case *ast.Ident:
		ident, callee = t, "name"
	case *ast.SelectorExpr:
		ident, callee = t.Sel, "selector"
		if x, ok := ast.Unparen(t.X).(*ast.Ident); ok {
			if _, isPkg := info.Uses[x].(*types.PkgName); isPkg {
				callee = "pkgname"
			}
		}
	}
	at := call.Pos()
	name := ""
	if ident != nil {
		at, name = ident.Pos(), ident.Name
	}
	p := fset.Position(at)
	c := Call{File: rel, Off: p.Offset, Line: p.Line, Name: name, Owner: owner, Kind: "call", Callee: callee}
	if tv, ok := info.Types[call.Fun]; ok {
		if tv.IsType() {
			c.Kind = "conversion"
		} else if tv.IsBuiltin() {
			c.Kind = "builtin"
		}
	}
	if ident == nil {
		return c
	}
	obj := info.Uses[ident]
	if obj == nil {
		return c
	}
	if fn, ok := obj.(*types.Func); ok {
		obj = fn.Origin()
	} else if v, ok := obj.(*types.Var); ok {
		obj = v.Origin()
	}
	if obj.Pos() == token.NoPos {
		// A predeclared object of the universe: a built-in function or type.
		c.Decl = &Decl{File: "", Line: 0, Name: obj.Name(), Kind: "universe"}
		return c
	}
	dp := fset.Position(obj.Pos())
	file, in := relTo(repo, dp.Filename)
	c.Decl = &Decl{File: file, Line: dp.Line, Name: obj.Name(), Kind: objKind(obj), InRepo: in}
	return c
}

func objKind(obj types.Object) string {
	switch o := obj.(type) {
	case *types.Func:
		sig, _ := o.Type().(*types.Signature)
		if sig != nil && sig.Recv() != nil {
			if types.IsInterface(sig.Recv().Type()) {
				return "ifacemethod"
			}
			return "method"
		}
		return "func"
	case *types.Var:
		if o.IsField() {
			return "field"
		}
		if o.Parent() != nil && o.Pkg() != nil && o.Parent() == o.Pkg().Scope() {
			return "pkgvar"
		}
		return "localvar"
	case *types.TypeName:
		return "type"
	case *types.Const:
		return "const"
	}
	return "other"
}

func must(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
