// The Rust Target for emit-portable. Renders the same language-agnostic ParserIR as
// tsTarget/goTarget into a self-contained Rust program (no external crates — the char-class
// lexer is regex-free, so it compiles with rustc alone, no Cargo/network). Its CST JSON is
// checked byte-for-byte against the interpreter, so `emitPortableParser(grammar, rustTarget)`
// is a real, verified Rust parser derived from the same grammar definition.
import type { ParserIR, RdRule, PrattRule, Step, CharRange, Target } from './emit-portable.ts';

const J = (v: unknown) => JSON.stringify(v);
const rsStr = (s: string) => J(s);   // Rust and JSON string literals coincide for our ASCII vocab
const rangeCond = (v: string, rs: CharRange[]) =>
  rs.map(([lo, hi]) => (lo === hi ? `${v} == ${lo}` : `(${lo}..=${hi}).contains(&${v})`)).join(' || ');

function lexer(ir: ParserIR): string {
  const cases = ir.tokens.map((t) => `        if ${rangeCond('c', t.first)} {
            let mut e = pos + 1;
            while e < n { let cc = b[e] as u32; if !(${rangeCond('cc', t.cont)}) { break } e += 1; }
            toks.push(Tok { kind: ${rsStr(t.name)}.to_string(), text: src[pos..e].to_string(), off: pos, end: e }); pos = e; continue;
        }`).join('\n');
  const punctChecks = ir.puncts.map((p) =>
    `        if src[pos..].starts_with(${rsStr(p)}) { toks.push(Tok { kind: String::new(), text: ${rsStr(p)}.to_string(), off: pos, end: pos + ${p.length} }); pos += ${p.length}; continue; }`).join('\n');
  return `fn lex(src: &str) -> Vec<Tok> {
    let b = src.as_bytes();
    let n = b.len();
    let mut toks: Vec<Tok> = Vec::new();
    let mut pos = 0usize;
    while pos < n {
        let c = b[pos] as u32;
        if c == 32 || c == 9 || c == 10 || c == 13 { pos += 1; continue; }
${cases}
${punctChecks}
        panic!("lex error at {}", pos);
    }
    toks
}`;
}

function rdRule(r: RdRule): string {
  const alt = (steps: Step[]) => {
    const conds = steps.map(stepCond).join(' && ');
    return `        { let mut kids: Vec<Cst> = Vec::new(); if ${conds} { return Some(self.branch(${rsStr(r.name)}, kids, save)); } self.pos = save; }`;
  };
  return `    fn parse_${r.name}(&mut self) -> Option<Cst> {
        let save = self.pos;
${r.alts.map(alt).join('\n')}
        None
    }`;
}
function stepCond(s: Step): string {
  switch (s.t) {
    case 'lit': return `self.match_lit(${rsStr(s.value)}, ${rsStr(s.ttype)}, &mut kids)`;
    case 'tok': return `self.match_tok(${rsStr(s.name)}, &mut kids)`;
    case 'rule': return `self.call_rule(Parser::parse_${s.name}, &mut kids)`;
    case 'star': return `self.star(|p, k| ${starInner(s.step)}, &mut kids)`;
  }
}
function starInner(s: Step): string {
  switch (s.t) {
    case 'lit': return `p.match_lit(${rsStr(s.value)}, ${rsStr(s.ttype)}, k)`;
    case 'tok': return `p.match_tok(${rsStr(s.name)}, k)`;
    case 'rule': return `p.call_rule(Parser::parse_${s.name}, k)`;
    case 'star': throw new Error('portable: nested star unsupported');
  }
}

function prattRule(r: PrattRule): string {
  const binArms = r.binary.map((b) => `${rsStr(b.op)} => Some((${b.lbp}, ${b.rbp}))`).join(', ');
  const preArms = r.prefix.map((p) => `${rsStr(p.op)} => Some(${p.rbp})`).join(', ');
  const atomArm = r.atomToks.map(rsStr).join(' | ');
  const g = r.group;
  return `    fn parse_${r.name}(&mut self) -> Option<Cst> { self.${r.name}_bp(0) }
    fn ${r.name}_bin(op: &str) -> Option<(i64, i64)> { match op { ${binArms}${binArms ? ', ' : ''}_ => None } }
    fn ${r.name}_pre(op: &str) -> Option<i64> { match op { ${preArms}${preArms ? ', ' : ''}_ => None } }
    fn ${r.name}_atom(kind: &str) -> bool { matches!(kind, ${atomArm || '""'}) }
    fn ${r.name}_bp(&mut self, min_bp: i64) -> Option<Cst> {
        let mut left = self.${r.name}_nud()?;
        loop {
            let t = match self.peek() { Some(t) => t, None => break };
            let (lbp, rbp) = match Parser::${r.name}_bin(&t.text) { Some(x) => x, None => break };
            if lbp <= min_bp { break; }
            let led_save = self.pos;
            self.pos += 1;
            let op_leaf = Cst::leaf("$operator", t.off, t.end);
            let rhs = match self.${r.name}_bp(rbp) { Some(r) => r, None => { self.pos = led_save; break; } };
            let (off, end) = (left.offset, rhs.end);
            left = Cst::node(${rsStr(r.name)}, vec![left, op_leaf, rhs], off, end);
        }
        Some(left)
    }
    fn ${r.name}_nud(&mut self) -> Option<Cst> {
        let t = self.peek()?;
        if Parser::${r.name}_atom(&t.kind) {
            self.pos += 1;
            return Some(Cst::node(${rsStr(r.name)}, vec![Cst::leaf(&t.kind, t.off, t.end)], t.off, t.end));
        }
${g ? `        if t.text == ${rsStr(g.open)} {
            let save = self.pos; self.pos += 1;
            let inner = self.${r.name}_bp(0);
            let c = self.peek();
            match (inner, c) {
                (Some(inner), Some(c)) if c.text == ${rsStr(g.close)} => {
                    self.pos += 1;
                    let (off, end) = (t.off, c.end);
                    return Some(Cst::node(${rsStr(r.name)}, vec![Cst::leaf("$punct", t.off, t.end), inner, Cst::leaf("$punct", c.off, c.end)], off, end));
                }
                _ => { self.pos = save; return None; }
            }
        }` : ''}
        if let Some(pbp) = Parser::${r.name}_pre(&t.text) {
            let save = self.pos; self.pos += 1;
            let op_leaf = Cst::leaf("$operator", t.off, t.end);
            match self.${r.name}_bp(pbp) {
                Some(operand) => { let (off, end) = (t.off, operand.end); return Some(Cst::node(${rsStr(r.name)}, vec![op_leaf, operand], off, end)); }
                None => { self.pos = save; return None; }
            }
        }
        None
    }`;
}

export const rustTarget: Target = {
  name: 'rust',
  ext: 'rs',
  render(ir: ParserIR): string {
    const ruleFns = ir.rules.map((r) => (r.kind === 'pratt' ? prattRule(r) : rdRule(r))).join('\n\n');
    return `// GENERATED by emit-portable.ts (rustTarget) — parser for grammar "${ir.grammarName}".
#![allow(non_snake_case)]
use std::io::Read;

#[derive(Clone)]
struct Tok { kind: String, text: String, off: usize, end: usize }

struct Cst { rule: String, children: Vec<Cst>, is_leaf: bool, token_type: String, offset: usize, end: usize }
impl Cst {
    fn leaf(tt: &str, off: usize, end: usize) -> Cst { Cst { rule: String::new(), children: Vec::new(), is_leaf: true, token_type: tt.to_string(), offset: off, end } }
    fn node(rule: &str, children: Vec<Cst>, offset: usize, end: usize) -> Cst { Cst { rule: rule.to_string(), children, is_leaf: false, token_type: String::new(), offset, end } }
}

${lexer(ir)}

struct Parser { toks: Vec<Tok>, pos: usize }
impl Parser {
    fn peek(&self) -> Option<Tok> { if self.pos < self.toks.len() { Some(self.toks[self.pos].clone()) } else { None } }
    fn branch(&self, rule: &str, kids: Vec<Cst>, save: usize) -> Cst {
        let offset = if !kids.is_empty() { kids[0].offset } else if save < self.toks.len() { self.toks[save].off } else if !self.toks.is_empty() { self.toks[self.toks.len() - 1].end } else { 0 };
        let end = if !kids.is_empty() { kids[kids.len() - 1].end } else { offset };
        Cst::node(rule, kids, offset, end)
    }
    fn match_lit(&mut self, value: &str, ttype: &str, kids: &mut Vec<Cst>) -> bool {
        match self.peek() { Some(t) if t.text == value => { kids.push(Cst::leaf(ttype, t.off, t.end)); self.pos += 1; true } _ => false }
    }
    fn match_tok(&mut self, name: &str, kids: &mut Vec<Cst>) -> bool {
        match self.peek() { Some(t) if t.kind == name => { kids.push(Cst::leaf(name, t.off, t.end)); self.pos += 1; true } _ => false }
    }
    fn call_rule(&mut self, f: fn(&mut Parser) -> Option<Cst>, kids: &mut Vec<Cst>) -> bool {
        match f(self) { Some(n) => { kids.push(n); true } None => false }
    }
    fn star(&mut self, once: fn(&mut Parser, &mut Vec<Cst>) -> bool, kids: &mut Vec<Cst>) -> bool {
        loop { let sp = self.pos; let before = kids.len(); if !once(self, kids) { self.pos = sp; kids.truncate(before); break; } }
        true
    }

${ruleFns}
}

fn write_json(c: &Cst, out: &mut String) {
    if c.is_leaf {
        out.push_str(&format!("{{\\"tokenType\\":\\"{}\\",\\"offset\\":{},\\"end\\":{}}}", c.token_type, c.offset, c.end));
        return;
    }
    out.push_str(&format!("{{\\"rule\\":\\"{}\\",\\"children\\":[", c.rule));
    for (i, k) in c.children.iter().enumerate() { if i > 0 { out.push(','); } write_json(k, out); }
    out.push_str(&format!("],\\"offset\\":{},\\"end\\":{}}}", c.offset, c.end));
}

fn main() {
    let mut src = String::new();
    std::io::stdin().read_to_string(&mut src).unwrap();
    let toks = lex(&src);
    let n = toks.len();
    let mut p = Parser { toks, pos: 0 };
    match p.parse_${ir.entry}() {
        Some(root) if p.pos == n => { let mut out = String::new(); write_json(&root, &mut out); print!("{}", out); }
        _ => { eprintln!("parse error (pos {}/{})", p.pos, n); std::process::exit(1); }
    }
}
`;
  },
};
