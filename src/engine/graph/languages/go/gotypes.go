// The Go helper tmb carries for way B (trustmybot/tmb#352): Go's own type checker, go/types, answers
// for every call of a repo's Go files. It uses only Go's standard library and the user's own `go`:
// `go list` names each package's files and imports under the default build configuration, and
// go/types checks them from source, the dependencies too. It runs no code of the repo and
// downloads nothing: the caller sets GOPROXY=off, so a module not already on disk is not found,
// and what depends on it is not known.
//
// Usage: go run gotypes.go <repo dir>. It writes JSON on stdout:
//
//	{"go": "go1.27.4", "modules": [dir, ...], "errors": n, "firstErrors": [...],
//	 "loaded": [file, ...],
//	 "calls": [{"file", "pos", "off", "line", "name", "callee", "kind", "answer"}]}
//
// A call is every ast.CallExpr of a loaded file of the repo, a conversion included ("Calls",
// "Conversions"). Its pos is where the name it calls is written, in UTF-16 units of the file's
// text, else where the call starts; off is the same place in bytes. Its answer is one of:
//
//	{"repo": {"file", "line", "name", "what"}}  the declaration, in a file of the repo
//	{"outside": what}                           a declaration outside the repo, or predeclared
//	{"notKnown": why}                           no answer
//
// An answer is no answer while the type checker reports an error inside the call, or when the
// declaration's package could not be checked without errors.
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"go/types"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"unicode/utf8"
)

// How many errors are kept in full, for a reader.
const keptErrors = 20

// One package as `go list -json` names it.
type listed struct {
	ImportPath string
	Dir        string
	Name       string
	GoFiles    []string
	Imports    []string
	ImportMap  map[string]string
	ForTest    string
	Standard   bool
	Module     *struct {
		Dir       string
		Main      bool
		GoVersion string
	}
	Error *struct{ Err string }
}

type declared struct {
	File string `json:"file"`
	Line int    `json:"line"`
	Name string `json:"name"`
	What string `json:"what"`
}

type answer struct {
	Repo     *declared `json:"repo,omitempty"`
	Outside  string    `json:"outside,omitempty"`
	NotKnown string    `json:"notKnown,omitempty"`
}

type call struct {
	File string `json:"file"`
	Pos  int    `json:"pos"`
	Off  int    `json:"off"`
	Line int    `json:"line"`
	Name string `json:"name"`
	// How the callee is written: a name (f), through a package's name (pkg.F), a selector (x.f), or other.
	Callee string `json:"callee"`
	Kind   string `json:"kind"`
	Answer answer `json:"answer"`
}

type output struct {
	Go          string   `json:"go"`
	Modules     []string `json:"modules"`
	Errors      int      `json:"errors"`
	FirstErrors []string `json:"firstErrors"`
	Loaded      []string `json:"loaded"`
	Calls       []call   `json:"calls"`
}

// A checked package: its types, its syntax and info when it is the repo's, and whether checking it
// or what it imports reported an error.
type checked struct {
	pkg   *types.Package
	files []*ast.File
	info  *types.Info
	errs  []types.Error
	// Whether a file of it is missing or cannot be parsed, so a declaration may be missing.
	incomplete bool
	// Whether checking it, or anything it imports, reported an error.
	broken bool
}

type run struct {
	root       string
	fset       *token.FileSet
	out        *output
	byID       map[string]*listed
	done       map[string]*checked
	incomplete map[*types.Package]bool
	seen       map[string]bool
}

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "usage: go run gotypes.go <repo dir>")
		os.Exit(2)
	}
	root, err := filepath.Abs(os.Args[1])
	if err == nil {
		root, err = filepath.EvalSymlinks(root)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	out := &output{Go: runtime.Version(), Modules: []string{}, FirstErrors: []string{}, Loaded: []string{}, Calls: []call{}}
	r := &run{root: root, fset: token.NewFileSet(), out: out, incomplete: map[*types.Package]bool{}, seen: map[string]bool{}}
	for _, dir := range moduleDirs(root) {
		rel, _ := filepath.Rel(root, dir)
		out.Modules = append(out.Modules, filepath.ToSlash(rel))
		r.module(dir)
	}
	sort.Strings(out.Loaded)
	sort.Slice(out.Calls, func(i, j int) bool {
		if out.Calls[i].File != out.Calls[j].File {
			return out.Calls[i].File < out.Calls[j].File
		}
		return out.Calls[i].Off < out.Calls[j].Off
	})
	if err := json.NewEncoder(os.Stdout).Encode(out); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

// The repo's modules: the root, when a go.work there makes one workspace of them; else each folder
// holding a go.mod ("Workspaces", "Modules" in the go command's documentation).
func moduleDirs(root string) []string {
	if _, err := os.Stat(filepath.Join(root, "go.work")); err == nil {
		return []string{root}
	}
	var dirs []string
	filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
		if err == nil && !d.IsDir() && d.Name() == "go.mod" {
			dirs = append(dirs, filepath.Dir(p))
		}
		return nil
	})
	sort.Strings(dirs)
	return dirs
}

func (r *run) error(msg string) {
	r.out.Errors++
	if len(r.out.FirstErrors) < keptErrors {
		r.out.FirstErrors = append(r.out.FirstErrors, msg)
	}
}

// Checks one module, or the workspace, as `go list` lays it out, and answers the calls of its files.
func (r *run) module(dir string) {
	cmd := exec.Command("go", "list", "-e", "-json", "-deps", "-test", "./...")
	cmd.Dir = dir
	// The workspace is the repo's own go.work, or none: never one found above the repo.
	work := filepath.Join(dir, "go.work")
	if _, err := os.Stat(work); err != nil {
		work = "off"
	}
	cmd.Env = append(os.Environ(), "GOWORK="+work)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	text, err := cmd.Output()
	if err != nil && len(text) == 0 {
		r.error(fmt.Sprintf("go list in %s: %s", dir, strings.TrimSpace(stderr.String())))
		return
	}
	r.byID = map[string]*listed{}
	r.done = map[string]*checked{}
	var order []*listed
	dec := json.NewDecoder(bytes.NewReader(text))
	for {
		p := &listed{}
		if err := dec.Decode(p); err == io.EOF {
			break
		} else if err != nil {
			r.error(fmt.Sprintf("go list in %s: %v", dir, err))
			return
		}
		r.byID[p.ImportPath] = p
		order = append(order, p)
	}
	// Each file of the repo is answered once: in its package, else in the package its tests make.
	for _, p := range order {
		if !r.ownPackage(p) {
			continue
		}
		c := r.check(p.ImportPath)
		for _, f := range c.files {
			abs := r.fset.File(f.FileStart).Name()
			rel, ok := r.rel(abs)
			if !ok || r.seen[rel] {
				continue
			}
			r.seen[rel] = true
			r.out.Loaded = append(r.out.Loaded, rel)
			r.calls(rel, abs, f, c)
		}
	}
}

// A package of the repo's own modules, not the program `go test` writes to run a package's tests.
func (r *run) ownPackage(p *listed) bool {
	if p.Module == nil || !p.Module.Main || p.Standard {
		return false
	}
	return !(p.Name == "main" && p.ForTest == "" && strings.HasSuffix(p.ImportPath, ".test"))
}

func (r *run) rel(abs string) (string, bool) {
	rel, err := filepath.Rel(r.root, abs)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", false
	}
	return filepath.ToSlash(rel), true
}

// Checks a package and what it imports, from source. A dependency's function bodies are not read:
// only its declarations can be named from the repo.
func (r *run) check(id string) *checked {
	if c, ok := r.done[id]; ok {
		return c
	}
	c := &checked{}
	r.done[id] = c
	p := r.byID[id]
	if p == nil {
		c.broken, c.incomplete = true, true
		return c
	}
	if p.Error != nil {
		c.broken, c.incomplete = true, true
		r.error(fmt.Sprintf("%s: %s", p.ImportPath, p.Error.Err))
	}
	own := r.ownPackage(p)
	mode := parser.SkipObjectResolution
	if own {
		mode |= parser.ParseComments
	}
	for _, name := range p.GoFiles {
		file := name
		if !filepath.IsAbs(file) {
			file = filepath.Join(p.Dir, name)
		}
		f, err := parser.ParseFile(r.fset, file, nil, mode)
		if err != nil {
			c.broken, c.incomplete = true, true
			r.error(err.Error())
		}
		if f != nil {
			c.files = append(c.files, f)
		}
	}
	conf := types.Config{
		IgnoreFuncBodies: !own,
		Importer: importerFunc(func(path string) (*types.Package, error) {
			if path == "unsafe" {
				return types.Unsafe, nil
			}
			dep := path
			if mapped, ok := p.ImportMap[path]; ok {
				dep = mapped
			}
			d := r.check(dep)
			if d.broken {
				c.broken = true
			}
			if d.pkg == nil {
				return nil, fmt.Errorf("package %s not found", path)
			}
			return d.pkg, nil
		}),
		Error: func(err error) {
			if te, ok := err.(types.Error); ok {
				c.errs = append(c.errs, te)
			}
			c.broken = true
			r.error(err.Error())
		},
		Sizes: types.SizesFor("gc", runtime.GOARCH),
	}
	if p.Module != nil && p.Module.GoVersion != "" {
		conf.GoVersion = "go" + p.Module.GoVersion
	}
	if own {
		c.info = &types.Info{Uses: map[*ast.Ident]types.Object{}, Types: map[ast.Expr]types.TypeAndValue{}, Selections: map[*ast.SelectorExpr]*types.Selection{}}
	}
	path := p.ImportPath
	if i := strings.Index(path, " ["); i >= 0 {
		path = path[:i]
	}
	c.pkg, _ = conf.Check(path, r.fset, c.files, c.info)
	if c.incomplete && c.pkg != nil {
		r.incomplete[c.pkg] = true
	}
	return c
}

type importerFunc func(path string) (*types.Package, error)

func (f importerFunc) Import(path string) (*types.Package, error) { return f(path) }

// A generic function's instantiation, f[T], is f ("Instantiations").
func unindex(fun ast.Expr) ast.Expr {
	fun = ast.Unparen(fun)
	switch t := fun.(type) {
	case *ast.IndexExpr:
		return t.X
	case *ast.IndexListExpr:
		return t.X
	}
	return fun
}

// Whether a file imports a package with `.`, which declares its names in the file's block ("Import declarations").
func dotImports(f *ast.File) bool {
	for _, spec := range f.Imports {
		if spec.Name != nil && spec.Name.Name == "." {
			return true
		}
	}
	return false
}

// The name a call's callee is written with: `f`, the `f` of `x.f`, through parentheses and a
// generic function's type arguments ("Calls", "Instantiations"); nil when it is no name.
func calleeName(fun ast.Expr) *ast.Ident {
	switch t := ast.Unparen(unindex(fun)).(type) {
	case *ast.Ident:
		return t
	case *ast.SelectorExpr:
		return t.Sel
	}
	return nil
}

// Every call of one file, with its answer.
func (r *run) calls(rel, abs string, f *ast.File, c *checked) {
	src, err := os.ReadFile(abs)
	if err != nil {
		return
	}
	var found []call
	ast.Inspect(f, func(n ast.Node) bool {
		ce, ok := n.(*ast.CallExpr)
		if !ok {
			return true
		}
		ident := calleeName(ce.Fun)
		at, name, callee := ce.Pos(), "", "other"
		if ident != nil {
			at, name, callee = ident.Pos(), ident.Name, "name"
		}
		if sel, ok := ast.Unparen(unindex(ce.Fun)).(*ast.SelectorExpr); ok {
			callee = "selector"
			if x, ok := ast.Unparen(sel.X).(*ast.Ident); ok {
				if _, isPkg := c.info.Uses[x].(*types.PkgName); isPkg {
					callee = "pkgname"
				}
			}
		}
		kind := "call"
		if tv, ok := c.info.Types[ce.Fun]; ok {
			if tv.IsType() {
				kind = "conversion"
			} else if tv.IsBuiltin() {
				kind = "builtin"
			}
		}
		p := r.fset.Position(at)
		found = append(found, call{File: rel, Off: p.Offset, Line: p.Line, Name: name, Callee: callee, Kind: kind, Answer: r.answer(ce, ident, f, c)})
		return true
	})
	sort.Slice(found, func(i, j int) bool { return found[i].Off < found[j].Off })
	// The position in UTF-16 units, as the graph counts it.
	units, done := 0, 0
	for i := range found {
		for done < found[i].Off && done < len(src) {
			ru, size := utf8.DecodeRune(src[done:])
			done += size
			if ru >= 0x10000 {
				units += 2
			} else {
				units++
			}
		}
		found[i].Pos = units
	}
	r.out.Calls = append(r.out.Calls, found...)
}

// The type checker's answer for one call.
func (r *run) answer(ce *ast.CallExpr, ident *ast.Ident, f *ast.File, c *checked) answer {
	if c.incomplete {
		return answer{NotKnown: "a file of the call's package is missing or cannot be parsed"}
	}
	for _, e := range c.errs {
		if e.Pos >= ce.Pos() && e.Pos < ce.End() {
			return answer{NotKnown: "the type checker reports an error in the call"}
		}
	}
	if ident == nil {
		return answer{NotKnown: "the callee is no name"}
	}
	obj := c.info.Uses[ident]
	if obj == nil {
		return answer{NotKnown: "the type checker names no declaration"}
	}
	switch o := obj.(type) {
	case *types.Func:
		obj = o.Origin()
	case *types.Var:
		obj = o.Origin()
	}
	if obj.Pkg() == nil {
		// A name a failed dot import would have declared is found in the universe instead.
		if c.broken && dotImports(f) {
			return answer{NotKnown: "a predeclared name, in a file with a dot import, in a package with errors"}
		}
		return answer{Outside: "predeclared"}
	}
	if r.incomplete[obj.Pkg()] {
		return answer{NotKnown: "a file of the declaration's package is missing or cannot be parsed"}
	}
	// A promoted method or field is found through embedded fields; one whose type has an error
	// might have held the name at a shallower depth ("Selectors").
	if sel, ok := ast.Unparen(unindex(ce.Fun)).(*ast.SelectorExpr); ok && c.broken {
		if s := c.info.Selections[sel]; s != nil && len(s.Index()) > 1 {
			return answer{NotKnown: "a promoted method, in a package with errors"}
		}
	}
	at := r.fset.Position(obj.Pos())
	rel, in := r.rel(at.Filename)
	if !in {
		return answer{Outside: what(obj)}
	}
	return answer{Repo: &declared{File: rel, Line: at.Line, Name: obj.Name(), What: what(obj)}}
}

// What a declaration is: func, method, interface method, type, package-level var or const, or a
// name no package-level declaration binds (a local, a parameter, a field).
func what(obj types.Object) string {
	atPackage := obj.Parent() != nil && obj.Pkg() != nil && obj.Parent() == obj.Pkg().Scope()
	switch o := obj.(type) {
	case *types.Func:
		sig, _ := o.Type().(*types.Signature)
		if sig != nil && sig.Recv() != nil {
			if types.IsInterface(sig.Recv().Type()) {
				return "interface method"
			}
			return "method"
		}
		return "func"
	case *types.TypeName:
		if atPackage {
			return "type"
		}
	case *types.Var:
		if atPackage {
			return "var"
		}
		if o.IsField() {
			return "field"
		}
	case *types.Const:
		if atPackage {
			return "const"
		}
	}
	return "local"
}
