//! A rustc driver that asks the compiler itself, after type checking, two things about each crate
//! it compiles:
//!
//! - every callable and type the crate declares (`def` lines): the compiler's own list of
//!   functions, for "functions found";
//! - every call written in the crate's bodies (`call` lines), with the declaration the compiler
//!   resolved it to: for a path call, the path's resolution; for a method call, the
//!   type-dependent definition the type checker recorded; and, where the receiver's type is known,
//!   the implementation `Instance::try_resolve` picks.
//!
//! Used as cargo's RUSTC_WORKSPACE_WRAPPER, so only the workspace's own crates are analysed. Each
//! crate's answers go to `$RUSTC_CALLS_OUT/<crate>-<pid>.jsonl`. It does not change the build.
#![feature(rustc_private)]

extern crate rustc_driver;
extern crate rustc_hir;
extern crate rustc_interface;
extern crate rustc_middle;
extern crate rustc_span;

use std::fmt::Write as _;
use std::io::Write as _;

use rustc_driver::{Callbacks, Compilation};
use rustc_hir::def::{CtorKind, DefKind, Res};
use rustc_hir::def_id::{DefId, LocalDefId};
use rustc_hir::intravisit::{self, Visitor};
use rustc_hir::{Expr, ExprKind, QPath};
use rustc_interface::interface::Compiler;
use rustc_middle::ty::{self, Instance, TyCtxt, TypeckResults};
use rustc_span::{FileName, Span};

struct Calls;

impl Callbacks for Calls {
    fn after_analysis<'tcx>(&mut self, _compiler: &Compiler, tcx: TyCtxt<'tcx>) -> Compilation {
        if let Ok(dir) = std::env::var("RUSTC_CALLS_OUT") {
            let mut out = String::new();
            defs(tcx, &mut out);
            calls(tcx, &mut out);
            let crate_name = tcx.crate_name(rustc_span::def_id::LOCAL_CRATE);
            let path = format!("{dir}/{crate_name}-{}.jsonl", std::process::id());
            std::fs::File::create(&path).and_then(|mut f| f.write_all(out.as_bytes())).expect("write answers");
        }
        Compilation::Continue
    }
}

fn json(s: &str) -> String {
    let mut out = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if (c as u32) < 0x20 => write!(out, "\\u{:04x}", c as u32).unwrap(),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Where a span is: its file as the compiler names it, its first and last lines (1-based), and
/// the byte column of its start on its first line.
fn place(tcx: TyCtxt<'_>, span: Span) -> String {
    let sm = tcx.sess.source_map();
    let lo = sm.lookup_char_pos(span.lo());
    let hi = sm.lookup_char_pos(span.hi());
    let file = match &lo.file.name {
        FileName::Real(real) => real.local_path().map(|p| p.display().to_string()).unwrap_or_else(|| format!("{real:?}")),
        other => format!("{other:?}"),
    };
    let line_start = lo.file.lines()[lo.line - 1];
    let col = (span.lo() - lo.file.start_pos).0 - line_start.0;
    format!("{{\"file\":{},\"line\":{},\"end\":{},\"col\":{}}}", json(&file), lo.line, hi.line, col)
}

fn kind_name(kind: DefKind) -> &'static str {
    match kind {
        DefKind::Fn => "fn",
        DefKind::AssocFn => "assoc_fn",
        DefKind::Closure => "closure",
        DefKind::Struct => "struct",
        DefKind::Enum => "enum",
        DefKind::Union => "union",
        DefKind::Trait => "trait",
        DefKind::Ctor(_, CtorKind::Fn) => "ctor_fn",
        DefKind::Ctor(_, CtorKind::Const) => "ctor_const",
        DefKind::Variant => "variant",
        DefKind::Const | DefKind::AssocConst => "const",
        DefKind::Static { .. } => "static",
        DefKind::ForeignTy | DefKind::TyAlias => "type_alias",
        _ => "other",
    }
}

/// The declaration a definition is written at: its name's place, else the whole definition's.
fn decl(tcx: TyCtxt<'_>, def_id: DefId) -> String {
    let span = tcx.def_ident_span(def_id).unwrap_or_else(|| tcx.def_span(def_id));
    let krate = tcx.crate_name(def_id.krate);
    format!(
        "{{\"at\":{},\"kind\":{},\"path\":{},\"crate\":{}}}",
        place(tcx, span),
        json(kind_name(tcx.def_kind(def_id))),
        json(&tcx.def_path_str(def_id)),
        json(krate.as_str())
    )
}

fn defs(tcx: TyCtxt<'_>, out: &mut String) {
    for def_id in tcx.iter_local_def_id() {
        let kind = tcx.def_kind(def_id);
        if !matches!(kind, DefKind::Fn | DefKind::AssocFn | DefKind::Closure | DefKind::Struct | DefKind::Enum | DefKind::Union | DefKind::Trait) {
            continue;
        }
        let hir_id = tcx.local_def_id_to_hir_id(def_id);
        let whole = tcx.hir_span_with_body(hir_id);
        let ident = tcx.def_ident_span(def_id.to_def_id()).unwrap_or(whole);
        let has_body = tcx.hir_maybe_body_owned_by(def_id).is_some();
        writeln!(
            out,
            "{{\"t\":\"def\",\"kind\":{},\"path\":{},\"whole\":{},\"ident\":{},\"macro\":{},\"body\":{}}}",
            json(kind_name(kind)),
            json(&tcx.def_path_str(def_id.to_def_id())),
            place(tcx, whole),
            place(tcx, ident),
            whole.from_expansion() || ident.from_expansion(),
            has_body
        )
        .unwrap();
    }
}

struct Walk<'a, 'tcx> {
    tcx: TyCtxt<'tcx>,
    owner: LocalDefId,
    results: &'tcx TypeckResults<'tcx>,
    out: &'a mut String,
}

impl<'a, 'tcx> Walk<'a, 'tcx> {
    fn emit(&mut self, args_of: rustc_hir::HirId, call_span: Span, name_span: Span, name: &str, how: &str, res: Option<DefId>, local: bool) {
        let tcx = self.tcx;
        let mut line = format!(
            "{{\"t\":\"call\",\"how\":{},\"name\":{},\"at\":{},\"written\":{},\"owner\":{}",
            json(how),
            json(name),
            place(tcx, name_span),
            // Written in the source: neither the call nor its name comes from a macro's expansion
            // (a derive's output reuses the source's names, inside a call it made up).
            !name_span.from_expansion() && !call_span.from_expansion(),
            json(&tcx.def_path_str(self.owner.to_def_id()))
        );
        if local {
            line.push_str(",\"local\":true");
        }
        if let Some(def_id) = res {
            write!(line, ",\"decl\":{}", decl(tcx, def_id)).unwrap();
            // The implementation the call reaches, where the receiver's type picks one.
            if matches!(tcx.def_kind(def_id), DefKind::AssocFn) {
                let args = self.results.node_args(args_of);
                let env = ty::TypingEnv::post_analysis_no_rigid_aliases(tcx, self.owner.to_def_id());
                // The generic arguments the type checker recorded must fit the method; else no implementation is asked for.
                let fits = args.len() == tcx.generics_of(def_id).count();
                if fits && let Ok(Some(instance)) = Instance::try_resolve(tcx, env, def_id, args) {
                    let target = instance.def_id();
                    if target != def_id {
                        write!(line, ",\"impl\":{}", decl(tcx, target)).unwrap();
                    }
                }
            }
        }
        line.push('}');
        self.out.push_str(&line);
        self.out.push('\n');
    }
}

impl<'a, 'tcx> Visitor<'tcx> for Walk<'a, 'tcx> {
    fn visit_expr(&mut self, expr: &'tcx Expr<'tcx>) {
        match expr.kind {
            ExprKind::Call(callee, _) => {
                if let ExprKind::Path(ref qpath) = callee.kind {
                    let name_span = match qpath {
                        QPath::Resolved(_, path) => path.segments.last().map(|s| s.ident.span).unwrap_or(callee.span),
                        QPath::TypeRelative(_, seg) => seg.ident.span,
                    };
                    let name = match qpath {
                        QPath::Resolved(_, path) => path.segments.last().map(|s| s.ident.to_string()).unwrap_or_default(),
                        QPath::TypeRelative(_, seg) => seg.ident.to_string(),
                    };
                    match self.results.qpath_res(qpath, callee.hir_id) {
                        Res::Def(_, def_id) => self.emit(callee.hir_id, expr.span, name_span, &name, "path", Some(def_id), false),
                        Res::Local(_) => self.emit(callee.hir_id, expr.span, name_span, &name, "path", None, true),
                        _ => self.emit(callee.hir_id, expr.span, name_span, &name, "path", None, false),
                    }
                } else {
                    self.emit(callee.hir_id, expr.span, callee.span, "", "expr", None, false);
                }
            }
            ExprKind::MethodCall(segment, ..) => {
                let res = self.results.type_dependent_def_id(expr.hir_id);
                self.emit(expr.hir_id, expr.span, segment.ident.span, &segment.ident.to_string(), "method", res, false);
            }
            _ => {}
        }
        intravisit::walk_expr(self, expr);
    }
}

fn calls(tcx: TyCtxt<'_>, out: &mut String) {
    for owner in tcx.hir_body_owners() {
        let body = tcx.hir_body_owned_by(owner);
        let results = tcx.typeck(owner);
        if results.tainted_by_errors.is_some() {
            continue;
        }
        let mut walk = Walk { tcx, owner, results, out };
        walk.visit_body(body);
    }
}

fn main() -> std::process::ExitCode {
    // As RUSTC_WORKSPACE_WRAPPER, cargo runs `<this> <rustc> <args...>`.
    let args: Vec<String> = std::env::args().skip(1).collect();
    rustc_driver::catch_with_exit_code(|| rustc_driver::compiler_entrypoint(&args, &mut Calls))
}
