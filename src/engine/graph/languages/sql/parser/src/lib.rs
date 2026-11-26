//! The tables an SQL text reads and writes, statement by statement, as sqlparser-rs parses it
//! (CODE_GRAPH.md, "Data sources"). tmb's SQL module calls this through WebAssembly; it returns
//! only names, never what is inside a table.
//!
//! - A text is split into statements at each `;` outside a trigger's body (a trigger's body ends
//!   at `END ;`, as SQLite's sqlite3_complete reads it), by the general dialect's tokenizer.
//! - Each statement is parsed by the general dialect, then by every other dialect the crate has.
//!   Its tables count when every dialect that parses it names the same ones; else it is unread.
//! - A name is its last part. A name holding the hole marker, which a caller puts where code
//!   interpolates a value, is not stated: the link goes to the store alone.

use std::collections::BTreeSet;
use std::ops::ControlFlow;

use sqlparser::ast::{
    CopyIntoSnowflakeKind, CopySource, CopyTarget, FromTable, ObjectName, ObjectNamePart, ObjectType, Query, Statement,
    TableFactor, TableObject, TableWithJoins, Visit, Visitor,
};
use sqlparser::dialect::{Dialect, GenericDialect};
use sqlparser::keywords::Keyword;
use sqlparser::parser::Parser;
use sqlparser::tokenizer::{Token, TokenWithSpan, Tokenizer};

/// URL schemes that name an object store's bucket as their host, as DuckDB's httpfs and Azure
/// extensions read them: `s3://bucket/key`.
const OBJECT_STORAGE_SCHEMES: &[&str] = &["s3", "s3a", "s3n", "gs", "gcs", "r2", "az", "azure", "abfs", "abfss", "wasb", "wasbs"];

#[derive(Clone, PartialEq, Eq, PartialOrd, Ord)]
enum To {
    Table(String),
    /// The store alone: the statement does not state the table's name.
    Store,
    Bucket(Option<String>),
}

#[derive(Clone, PartialEq, Eq, PartialOrd, Ord)]
struct Ref {
    write: bool,
    to: To,
}

#[derive(Clone, PartialEq, Eq, PartialOrd, Ord)]
struct Trigger {
    name: String,
    on: Option<To>,
    refs: BTreeSet<Ref>,
}

#[derive(Clone, PartialEq, Eq, Default)]
struct Tables {
    refs: BTreeSet<Ref>,
    /// What the statement defines: (kind, name).
    defines: BTreeSet<(String, String)>,
    triggers: Vec<Trigger>,
}

struct Names<'a> {
    hole: &'a str,
}

impl Names<'_> {
    fn last(&self, name: &ObjectName) -> Option<To> {
        match name.0.last()? {
            ObjectNamePart::Identifier(ident) => {
                let value = ident.value.to_lowercase();
                if !self.hole.is_empty() && value.contains(self.hole) {
                    Some(To::Store)
                } else {
                    Some(To::Table(value))
                }
            }
            _ => None,
        }
    }

    fn own(&self, name: &ObjectName) -> Option<String> {
        match name.0.last()? {
            ObjectNamePart::Identifier(ident) => Some(ident.value.clone()),
            _ => None,
        }
    }

    fn bucket(&self, url: &str) -> Option<To> {
        let (scheme, rest) = url.split_once("://")?;
        if !OBJECT_STORAGE_SCHEMES.contains(&scheme.to_lowercase().as_str()) {
            return None;
        }
        let host = rest.split('/').next().unwrap_or("");
        if host.is_empty() || (!self.hole.is_empty() && host.to_lowercase().contains(self.hole)) {
            Some(To::Bucket(None))
        } else {
            Some(To::Bucket(Some(host.to_string())))
        }
    }
}

/// Every table a part of a statement reads: each table in a FROM, a JOIN or a subquery that no
/// WITH around it names, and that is not one the statement writes.
struct Reads<'a, 'n> {
    names: &'n Names<'a>,
    skip: Vec<*const TableFactor>,
    ctes: Vec<Vec<String>>,
    out: BTreeSet<Ref>,
}

impl Visitor for Reads<'_, '_> {
    type Break = ();

    fn pre_visit_query(&mut self, query: &Query) -> ControlFlow<()> {
        let names = query.with.as_ref().map(|w| w.cte_tables.iter().map(|c| c.alias.name.value.to_lowercase()).collect()).unwrap_or_default();
        self.ctes.push(names);
        ControlFlow::Continue(())
    }

    fn post_visit_query(&mut self, _query: &Query) -> ControlFlow<()> {
        self.ctes.pop();
        ControlFlow::Continue(())
    }

    fn pre_visit_table_factor(&mut self, factor: &TableFactor) -> ControlFlow<()> {
        if self.skip.contains(&(factor as *const TableFactor)) {
            return ControlFlow::Continue(());
        }
        if let TableFactor::Table { name, args: None, .. } = factor {
            if name.0.len() == 1 {
                if let Some(To::Table(n)) = self.names.last(name) {
                    if self.ctes.iter().any(|scope| scope.contains(&n)) {
                        return ControlFlow::Continue(());
                    }
                }
            }
            if let Some(to) = self.names.last(name) {
                self.out.insert(Ref { write: false, to });
            }
        }
        ControlFlow::Continue(())
    }
}

fn table_of(factor: &TableFactor) -> Option<&ObjectName> {
    match factor {
        TableFactor::Table { name, args: None, .. } => Some(name),
        _ => None,
    }
}

fn alias_of(factor: &TableFactor) -> Option<String> {
    match factor {
        TableFactor::Table { alias: Some(alias), .. } => Some(alias.name.value.to_lowercase()),
        _ => None,
    }
}

fn factors(tables: &[TableWithJoins]) -> Vec<&TableFactor> {
    let mut out = Vec::new();
    for t in tables {
        out.push(&t.relation);
        for j in &t.joins {
            out.push(&j.relation);
        }
    }
    out
}

/// The tables one statement reads and writes; None for a statement that touches no table.
fn tables_of(statement: &Statement, names: &Names) -> Option<Tables> {
    let mut tables = Tables::default();
    let mut skip: Vec<*const TableFactor> = Vec::new();
    match statement {
        Statement::Query(_) => {}
        Statement::Insert(insert) => {
            if let TableObject::TableName(name) = &insert.table {
                write(&mut tables, names.last(name));
            }
        }
        Statement::Update(update) => {
            if let Some(name) = table_of(&update.table.relation) {
                write(&mut tables, names.last(name));
                skip.push(&update.table.relation);
            }
        }
        Statement::Delete(delete) => {
            let from = match &delete.from {
                FromTable::WithFromKeyword(t) | FromTable::WithoutKeyword(t) => t,
            };
            if delete.tables.is_empty() {
                for t in from {
                    if let Some(name) = table_of(&t.relation) {
                        write(&mut tables, names.last(name));
                        skip.push(&t.relation);
                    }
                }
            } else {
                let all = factors(from);
                for target in &delete.tables {
                    let wanted = names.last(target);
                    // A target names a table of the FROM by its alias, else by its name.
                    let by_alias = all.iter().find(|f| target.0.len() == 1 && alias_of(f).map(To::Table) == wanted);
                    let named = by_alias.or_else(|| all.iter().find(|f| table_of(f).and_then(|n| names.last(n)) == wanted));
                    match named {
                        Some(f) => {
                            write(&mut tables, table_of(f).and_then(|n| names.last(n)));
                            skip.push(*f);
                        }
                        None => write(&mut tables, wanted),
                    }
                }
            }
        }
        Statement::Merge(merge) => {
            if let Some(name) = table_of(&merge.table) {
                write(&mut tables, names.last(name));
                skip.push(&merge.table);
            }
        }
        Statement::CreateTable(create) => {
            write(&mut tables, names.last(&create.name));
            define(&mut tables, "table", names.last(&create.name));
        }
        Statement::CreateView(create) => {
            write(&mut tables, names.last(&create.name));
            define(&mut tables, "view", names.last(&create.name));
        }
        Statement::CreateVirtualTable { name, .. } => {
            write(&mut tables, names.last(name));
            define(&mut tables, "virtual table", names.last(name));
        }
        Statement::CreateIndex(index) => write(&mut tables, names.last(&index.table_name)),
        Statement::AlterTable(alter) => write(&mut tables, names.last(&alter.name)),
        Statement::AlterView(alter) => write(&mut tables, names.last(&alter.name)),
        Statement::Drop { object_type, names: dropped, table, .. } => {
            if matches!(object_type, ObjectType::Table | ObjectType::View | ObjectType::MaterializedView) {
                for name in dropped {
                    write(&mut tables, names.last(name));
                }
            }
            if let Some(name) = table {
                write(&mut tables, names.last(name));
            }
        }
        Statement::Truncate(truncate) => {
            for target in &truncate.table_names {
                write(&mut tables, names.last(&target.name));
            }
        }
        Statement::RenameTable(renames) => {
            for rename in renames {
                write(&mut tables, names.last(&rename.old_name));
                write(&mut tables, names.last(&rename.new_name));
            }
        }
        Statement::Copy { source, to, target, .. } => {
            if let CopySource::Table { table_name, .. } = source {
                if let Some(t) = names.last(table_name) {
                    tables.refs.insert(Ref { write: !*to, to: t });
                }
            }
            if let CopyTarget::File { filename } = target {
                if let Some(b) = names.bucket(filename) {
                    tables.refs.insert(Ref { write: *to, to: b });
                }
            }
        }
        Statement::CopyIntoSnowflake { kind, into, from_obj, stage_params, .. } => {
            let url = stage_params.url.as_deref().and_then(|u| names.bucket(u));
            match kind {
                CopyIntoSnowflakeKind::Table => {
                    write(&mut tables, names.last(into));
                    if let Some(b) = url {
                        tables.refs.insert(Ref { write: false, to: b });
                    }
                }
                CopyIntoSnowflakeKind::Location => {
                    if let Some(b) = url {
                        tables.refs.insert(Ref { write: true, to: b });
                    }
                    if let Some(t) = from_obj.as_ref().and_then(|n| names.last(n)) {
                        tables.refs.insert(Ref { write: false, to: t });
                    }
                }
            }
        }
        Statement::CreateTrigger(trigger) => {
            let mut body = BTreeSet::new();
            if let Some(statements) = &trigger.statements {
                for s in statements.statements() {
                    if let Some(inner) = tables_of(s, names) {
                        body.extend(inner.refs);
                    }
                }
            }
            if let Some(condition) = &trigger.condition {
                body.extend(reads(names, condition, Vec::new()));
            }
            tables.triggers.push(Trigger { name: names.own(&trigger.name).unwrap_or_default(), on: names.last(&trigger.table_name), refs: body });
            return Some(tables);
        }
        _ => return None,
    }
    tables.refs.extend(reads(names, statement, skip));
    Some(tables)
}

fn write(tables: &mut Tables, to: Option<To>) {
    if let Some(to) = to {
        tables.refs.insert(Ref { write: true, to });
    }
}

fn define(tables: &mut Tables, kind: &str, name: Option<To>) {
    if let Some(To::Table(n)) = name {
        tables.defines.insert((kind.to_string(), n));
    }
}

fn reads<V: Visit>(names: &Names, node: &V, skip: Vec<*const TableFactor>) -> BTreeSet<Ref> {
    let mut visitor = Reads { names, skip, ctes: Vec::new(), out: BTreeSet::new() };
    let _ = node.visit(&mut visitor);
    visitor.out
}

/// The dialects tried on a statement: the general one first, then every other the crate has.
fn dialects() -> Vec<Box<dyn Dialect>> {
    sqlparser::test_utils::all_dialects().dialects
}

/// One statement's tables when every dialect that parses it agrees; None when none parses it or
/// two disagree.
fn agreed(text: &str, names: &Names, dialects: &[Box<dyn Dialect>]) -> Option<Tables> {
    let mut answer: Option<Tables> = None;
    for dialect in dialects {
        let Ok(statements) = Parser::parse_sql(dialect.as_ref(), text) else { continue };
        if statements.len() != 1 {
            continue;
        }
        let tables = tables_of(&statements[0], names).unwrap_or_default();
        match &answer {
            None => answer = Some(tables),
            Some(known) if *known == tables => {}
            Some(_) => return None,
        }
    }
    answer
}

struct Piece {
    start: usize,
    end: usize,
    line: u64,
    end_line: u64,
}

fn word(token: &Token) -> Option<Keyword> {
    match token {
        Token::Word(w) if w.quote_style.is_none() => Some(w.keyword),
        _ => None,
    }
}

/// Byte offsets of each line's start.
fn line_starts(text: &str) -> Vec<usize> {
    let mut starts = vec![0];
    for (i, b) in text.bytes().enumerate() {
        if b == b'\n' {
            starts.push(i + 1);
        }
    }
    starts
}

fn offset(text: &str, starts: &[usize], line: u64, column: u64) -> usize {
    let Some(&start) = starts.get((line as usize).saturating_sub(1)) else { return text.len() };
    text[start..].char_indices().nth((column as usize).saturating_sub(1)).map(|(i, _)| start + i).unwrap_or(text.len())
}

/// The text's statements, split at each `;` that ends one.
fn split(text: &str) -> Vec<Piece> {
    let dialect = GenericDialect {};
    let tokens: Vec<TokenWithSpan> = match Tokenizer::new(&dialect, text).tokenize_with_location() {
        Ok(tokens) => tokens,
        Err(_) => {
            let line = text.lines().position(|l| !l.trim().is_empty()).unwrap_or(0) as u64 + 1;
            return vec![Piece { start: 0, end: text.len(), line, end_line: text.lines().count().max(1) as u64 }];
        }
    };
    let starts = line_starts(text);
    let mut pieces = Vec::new();
    let mut current: Option<Piece> = None;
    let mut words: Vec<Keyword> = Vec::new();
    let mut trigger = false;
    let mut body = false;
    let mut cases = 0usize;
    let mut last: Option<Keyword> = None;
    for t in &tokens {
        if matches!(t.token, Token::Whitespace(_) | Token::EOF) {
            continue;
        }
        let at = offset(text, &starts, t.span.start.line, t.span.start.column);
        let to = offset(text, &starts, t.span.end.line, t.span.end.column);
        if t.token == Token::SemiColon {
            let ends = !trigger || !body || (last == Some(Keyword::END) && cases == 0);
            if ends {
                if let Some(mut piece) = current.take() {
                    piece.end = to;
                    piece.end_line = t.span.end.line;
                    pieces.push(piece);
                }
                words.clear();
                trigger = false;
                body = false;
                cases = 0;
                last = None;
                continue;
            }
        }
        let piece = current.get_or_insert(Piece { start: at, end: to, line: t.span.start.line, end_line: t.span.end.line });
        piece.end = to;
        piece.end_line = t.span.end.line;
        let kw = word(&t.token);
        if let Some(k) = kw {
            if words.len() < 5 {
                words.push(k);
                if words[0] == Keyword::CREATE && k == Keyword::TRIGGER {
                    trigger = true;
                }
            }
            if trigger {
                match k {
                    Keyword::BEGIN => body = true,
                    Keyword::CASE if body => cases += 1,
                    Keyword::END if body && cases > 0 && last != Some(Keyword::END) => {
                        cases -= 1;
                        last = Some(Keyword::NoKeyword);
                        continue;
                    }
                    _ => {}
                }
            }
        }
        last = kw;
    }
    if let Some(piece) = current.take() {
        pieces.push(piece);
    }
    pieces
}

fn json_string(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

fn json_to(out: &mut String, to: &To) {
    match to {
        To::Table(n) => {
            out.push_str("{\"to\":\"table\",\"name\":");
            json_string(out, n);
            out.push('}');
        }
        To::Store => out.push_str("{\"to\":\"store\"}"),
        To::Bucket(None) => out.push_str("{\"to\":\"bucket\"}"),
        To::Bucket(Some(n)) => {
            out.push_str("{\"to\":\"bucket\",\"name\":");
            json_string(out, n);
            out.push('}');
        }
    }
}

fn json_refs(out: &mut String, refs: &BTreeSet<Ref>) {
    out.push('[');
    for (i, r) in refs.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str(if r.write { "{\"op\":\"write\",\"at\":" } else { "{\"op\":\"read\",\"at\":" });
        json_to(out, &r.to);
        out.push('}');
    }
    out.push(']');
}

/// The statements of `text` as JSON: each one's first and last line, whether it was read, and its
/// tables.
pub fn analyze(text: &str, hole: &str) -> String {
    let names = Names { hole };
    let dialects = dialects();
    let mut out = String::from("[");
    let mut first = true;
    for piece in split(text) {
        let tables = agreed(&text[piece.start..piece.end], &names, &dialects);
        if !first {
            out.push(',');
        }
        first = false;
        out.push_str(&format!("{{\"line\":{},\"end\":{},\"read\":{}", piece.line, piece.end_line, tables.is_some()));
        if let Some(t) = tables {
            out.push_str(",\"refs\":");
            json_refs(&mut out, &t.refs);
            out.push_str(",\"defines\":[");
            for (i, (kind, name)) in t.defines.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str("{\"kind\":");
                json_string(&mut out, kind);
                out.push_str(",\"name\":");
                json_string(&mut out, name);
                out.push('}');
            }
            out.push_str("],\"triggers\":[");
            for (i, trigger) in t.triggers.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str("{\"name\":");
                json_string(&mut out, &trigger.name);
                out.push_str(",\"on\":");
                match &trigger.on {
                    Some(on) => json_to(&mut out, on),
                    None => out.push_str("null"),
                }
                out.push_str(",\"refs\":");
                json_refs(&mut out, &trigger.refs);
                out.push('}');
            }
            out.push(']');
        }
        out.push('}');
    }
    out.push(']');
    out
}

// The WebAssembly interface: the caller writes the text and the hole marker into memory it got
// from `block_alloc`, calls `analyze_json`, and reads the answer at the pointer it returns: a 4-byte
// little-endian length, then that many bytes of UTF-8 JSON. It frees each block with `block_free`.

#[unsafe(no_mangle)]
pub extern "C" fn block_alloc(len: usize) -> *mut u8 {
    let mut block = Vec::<u8>::with_capacity(len.max(1));
    let ptr = block.as_mut_ptr();
    std::mem::forget(block);
    ptr
}

/// # Safety
/// `ptr` and `len` are a block `block_alloc` returned, or one `analyze_json` returned with its length.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn block_free(ptr: *mut u8, len: usize) {
    unsafe { drop(Vec::from_raw_parts(ptr, 0, len.max(1))) };
}

/// # Safety
/// Each pointer and length is a block `block_alloc` returned, holding UTF-8.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn analyze_json(text: *const u8, text_len: usize, hole: *const u8, hole_len: usize) -> *mut u8 {
    let text = unsafe { std::str::from_utf8(std::slice::from_raw_parts(text, text_len)).unwrap_or("") };
    let hole = unsafe { std::str::from_utf8(std::slice::from_raw_parts(hole, hole_len)).unwrap_or("") };
    let answer = analyze(text, &hole.to_lowercase());
    let mut block = Vec::with_capacity(answer.len() + 4);
    block.extend_from_slice(&(answer.len() as u32).to_le_bytes());
    block.extend_from_slice(answer.as_bytes());
    let mut block = block.into_boxed_slice();
    let ptr = block.as_mut_ptr();
    std::mem::forget(block);
    ptr
}
