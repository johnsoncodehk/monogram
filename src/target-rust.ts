// The Rust Target for emit-portable. Renders the same language-agnostic ParserIR as
// tsTarget/goTarget into a self-contained Rust program (no external crates — the lexer is
// regex-free, so it compiles with rustc alone, no Cargo/network). Its CST JSON is checked
// byte-for-byte against the interpreter, so `emitPortableParser(grammar, rustTarget)` is a
// real, verified Rust parser derived from the same grammar definition.
//
// Rust ownership note: a CST node is OWNED (moved), unlike the TS/Go pointer trees. In the
// Pratt LED loop `left` can only be moved into a child vec once the continuation is known to
// match — so a mixfix LED matches its steps into a SEPARATE kids vec first, then (on success)
// moves `left` to the front and reassigns; on failure `left` is untouched and the loop
// returns it. Sub-sequence combinators (star/opt/sep) take non-capturing fn pointers
// `fn(&mut Parser, &mut Vec<Cst>) -> bool`, threading the parser + kids as params (so nothing
// is captured, sidestepping the borrow checker).
import type { ParserIR, RdRule, PrattRule, Step, Bracket, CharRange, LexTok, Target } from './emit-portable.ts';

const J = (v: unknown) => JSON.stringify(v);
const rangeCond = (v: string, rs: CharRange[]) =>
  '(' + rs.map(([lo, hi]) => (lo === hi ? `${v} == ${lo}` : `(${lo}..=${hi}).contains(&${v})`)).join(' || ') + ')';

function scanTok(t: LexTok): string {
  const push = t.skip ? '' : `toks.push(Tok { kind: ${J((t as { name: string }).name)}, text: &src[pos..e], off: pos, end: e }); `;
  if (t.kind === 'run') return `        if ${rangeCond('c', t.first)} {
            let mut e = pos + 1;
            while e < n { let cc = b[e] as u32; if !${rangeCond('cc', t.cont)} { break } e += 1; }
            ${push}pos = e; continue;
        }`;
  if (t.kind === 'string') return `        if c == ${t.delim.charCodeAt(0)} {
            let mut e = pos + 1;
            while e < n { let ch = b[e] as u32; if ch == 92 { e += 2; continue } if ch == ${t.delim.charCodeAt(0)} { e += 1; break } e += 1; }
            ${push}pos = e; continue;
        }`;
  if (t.kind === 'line') return `        if src[pos..].starts_with(${J(t.prefix)}) {
            let mut e = pos + ${t.prefix.length};
            while e < n && b[e] != 10 { e += 1; }
            ${push}pos = e; continue;
        }`;
  return `        if src[pos..].starts_with(${J(t.open)}) {
            let mut e = pos + ${t.open.length};
            while e < n && !src[e..].starts_with(${J(t.close)}) { e += 1; }
            if e < n { e += ${t.close.length}; }
            ${push}pos = e; continue;
        }`;
}

function lexer(ir: ParserIR): string {
  const toks = ir.tokens.map(scanTok).join('\n');
  const puncts = ir.puncts.map((p) =>
    `        if src[pos..].starts_with(${J(p)}) { toks.push(Tok { kind: "", text: &src[pos..pos + ${p.length}], off: pos, end: pos + ${p.length} }); pos += ${p.length}; continue; }`).join('\n');
  return `fn lex<'a>(src: &'a str) -> Vec<Tok<'a>> {
    let b = src.as_bytes();
    let n = b.len();
    let mut toks: Vec<Tok> = Vec::new();
    let mut pos = 0usize;
    while pos < n {
        let c = b[pos] as u32;
        if c == 32 || c == 9 || c == 10 || c == 13 { pos += 1; continue; }
${toks}
${puncts}
        panic!("lex error at {}", pos);
    }
    toks
}`;
}

// Top-level step: uses `self` and `&mut kids`.
function stepCond(s: Step): string {
  switch (s.t) {
    case 'lit': return `self.match_lit(${J(s.value)}, ${J(s.ttype)}, &mut kids)`;
    case 'tok': return `self.match_tok(${J(s.name)}, &mut kids)`;
    case 'rule': return `self.call_rule(Parser::parse_${s.name}, &mut kids)`;
    case 'star': return `self.star(|p, k| ${stepCondP(s.step)}, &mut kids)`;
    case 'opt': return `self.opt(|p, k| ${s.steps.map(stepCondP).join(' && ')}, &mut kids)`;
    case 'sep': return `self.sep_by(|p, k| ${stepCondP(s.elem)}, ${J(s.delim)}, &mut kids)`;
    case 'altlit': return `self.alt_lit(&[${s.opts.map((o) => `(${J(o.value)}, ${J(o.ttype)})`).join(', ')}], &mut kids)`;
  }
}
// Inside a closure: uses `p` and `k`.
function stepCondP(s: Step): string {
  switch (s.t) {
    case 'lit': return `p.match_lit(${J(s.value)}, ${J(s.ttype)}, k)`;
    case 'tok': return `p.match_tok(${J(s.name)}, k)`;
    case 'rule': return `p.call_rule(Parser::parse_${s.name}, k)`;
    case 'star': return `p.star(|p, k| ${stepCondP(s.step)}, k)`;
    case 'opt': return `p.opt(|p, k| ${s.steps.map(stepCondP).join(' && ')}, k)`;
    case 'sep': return `p.sep_by(|p, k| ${stepCondP(s.elem)}, ${J(s.delim)}, k)`;
    case 'altlit': return `p.alt_lit(&[${s.opts.map((o) => `(${J(o.value)}, ${J(o.ttype)})`).join(', ')}], k)`;
  }
}

function rdRule(r: RdRule): string {
  const alt = (steps: Step[]) =>
    `        { let mut kids: Vec<Cst> = Vec::new(); if ${steps.map(stepCond).join(' && ')} { return Some(self.branch(${J(r.name)}, kids, save)); } self.pos = save; }`;
  return `    fn parse_${r.name}(&mut self) -> Option<Cst> {
        let save = self.pos;
${r.alts.map(alt).join('\n')}
        None
    }`;
}

function prattRule(r: PrattRule): string {
  const binArms = r.binary.map((b) => `${J(b.op)} => Some((${b.lbp}, ${b.rbp}))`).join(', ');
  const preArms = r.prefix.map((p) => `${J(p.op)} => Some(${p.rbp})`).join(', ');
  const atomArm = r.nudToks.map(J).join(' | ');
  const bracketNud = (b: Bracket) => `        if t.text == ${J(b.first)} {
            let save = self.pos; let mut kids: Vec<Cst> = Vec::new();
            if ${b.steps.map(stepCond).join(' && ')} { return Some(node(${J(r.name)}, kids)); }
            self.pos = save; return None;
        }`;
  const ledArm = (b: Bracket) => `            if t.text == ${J(b.first)} {
                let led_save = self.pos; let mut kids: Vec<Cst> = Vec::new();
                if ${b.steps.map(stepCond).join(' && ')} {
                    let mut full = vec![left]; full.append(&mut kids);
                    left = node(${J(r.name)}, full); continue;
                }
                self.pos = led_save; break;
            }`;
  return `    fn parse_${r.name}(&mut self) -> Option<Cst> { self.${r.name}_bp(0) }
    fn ${r.name}_bin(op: &str) -> Option<(i64, i64)> { match op { ${binArms}${binArms ? ', ' : ''}_ => None } }
    fn ${r.name}_pre(op: &str) -> Option<i64> { match op { ${preArms}${preArms ? ', ' : ''}_ => None } }
    fn ${r.name}_atom(kind: &str) -> bool { matches!(kind, ${atomArm || '""'}) }
    fn ${r.name}_bp(&mut self, min_bp: i64) -> Option<Cst> {
        let mut left = self.${r.name}_nud()?;
        loop {
            let t = match self.peek() { Some(t) => t, None => break };
${r.leds.map(ledArm).join('\n')}
            let (lbp, rbp) = match Parser::${r.name}_bin(t.text) { Some(x) => x, None => break };
            if lbp <= min_bp { break; }
            let led_save = self.pos;
            self.pos += 1;
            let op_leaf = Cst::leaf("$operator", t.off, t.end);
            let rhs = match self.${r.name}_bp(rbp) { Some(r) => r, None => { self.pos = led_save; break; } };
            left = node(${J(r.name)}, vec![left, op_leaf, rhs]);
        }
        Some(left)
    }
    fn ${r.name}_nud(&mut self) -> Option<Cst> {
        let t = self.peek()?;
        if Parser::${r.name}_atom(t.kind) {
            self.pos += 1;
            return Some(Cst::node(${J(r.name)}, vec![Cst::leaf(t.kind, t.off, t.end)], t.off, t.end));
        }
${r.nudBrackets.map(bracketNud).join('\n')}
        if let Some(pbp) = Parser::${r.name}_pre(t.text) {
            let save = self.pos; self.pos += 1;
            let op_leaf = Cst::leaf("$operator", t.off, t.end);
            match self.${r.name}_bp(pbp) {
                Some(operand) => { let (o, e) = (t.off, operand.end); return Some(Cst::node(${J(r.name)}, vec![op_leaf, operand], o, e)); }
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

// Zero-alloc tokens: kind is a known grammar name (&'static str), text is a slice of the
// source. Tok is Copy, so peek() copies pointers — no per-peek heap work.
#[derive(Clone, Copy)]
struct Tok<'a> { kind: &'static str, text: &'a str, off: usize, end: usize }

// CST nodes hold only &'static str labels (rule names / token-type tags are all literals)
// + usize spans — no per-node String allocation.
struct Cst { rule: &'static str, children: Vec<Cst>, is_leaf: bool, token_type: &'static str, offset: usize, end: usize }
impl Cst {
    fn leaf(tt: &'static str, off: usize, end: usize) -> Cst { Cst { rule: "", children: Vec::new(), is_leaf: true, token_type: tt, offset: off, end } }
    fn node(rule: &'static str, children: Vec<Cst>, offset: usize, end: usize) -> Cst { Cst { rule, children, is_leaf: false, token_type: "", offset, end } }
}
// offset/end inferred from first/last child (children non-empty).
fn node(rule: &'static str, kids: Vec<Cst>) -> Cst { let o = kids[0].offset; let e = kids[kids.len() - 1].end; Cst::node(rule, kids, o, e) }

${lexer(ir)}

struct Parser<'a> { toks: Vec<Tok<'a>>, pos: usize }
impl<'a> Parser<'a> {
    fn peek(&self) -> Option<Tok<'a>> { if self.pos < self.toks.len() { Some(self.toks[self.pos]) } else { None } }
    fn branch(&self, rule: &'static str, kids: Vec<Cst>, save: usize) -> Cst {
        let offset = if !kids.is_empty() { kids[0].offset } else if save < self.toks.len() { self.toks[save].off } else { 0 };
        let end = if !kids.is_empty() { kids[kids.len() - 1].end } else { offset };
        Cst::node(rule, kids, offset, end)
    }
    fn match_lit(&mut self, value: &str, ttype: &'static str, kids: &mut Vec<Cst>) -> bool {
        match self.peek() { Some(t) if t.text == value => { kids.push(Cst::leaf(ttype, t.off, t.end)); self.pos += 1; true } _ => false }
    }
    fn match_tok(&mut self, name: &'static str, kids: &mut Vec<Cst>) -> bool {
        match self.peek() { Some(t) if t.kind == name => { kids.push(Cst::leaf(name, t.off, t.end)); self.pos += 1; true } _ => false }
    }
    fn call_rule(&mut self, f: fn(&mut Parser<'a>) -> Option<Cst>, kids: &mut Vec<Cst>) -> bool {
        match f(self) { Some(n) => { kids.push(n); true } None => false }
    }
    fn star(&mut self, once: fn(&mut Parser<'a>, &mut Vec<Cst>) -> bool, kids: &mut Vec<Cst>) -> bool {
        loop { let sp = self.pos; let before = kids.len(); if !once(self, kids) { self.pos = sp; kids.truncate(before); break; } }
        true
    }
    fn opt(&mut self, body: fn(&mut Parser<'a>, &mut Vec<Cst>) -> bool, kids: &mut Vec<Cst>) -> bool {
        let sp = self.pos; let before = kids.len(); if !body(self, kids) { self.pos = sp; kids.truncate(before); } true
    }
    fn sep_by(&mut self, elem: fn(&mut Parser<'a>, &mut Vec<Cst>) -> bool, delim: &str, kids: &mut Vec<Cst>) -> bool {
        if !elem(self, kids) { return false; }
        loop { let sp = self.pos; let before = kids.len(); if self.match_lit(delim, "$punct", kids) && elem(self, kids) { continue; } self.pos = sp; kids.truncate(before); break; }
        true
    }
    fn alt_lit(&mut self, opts: &[(&str, &'static str)], kids: &mut Vec<Cst>) -> bool {
        for (v, tt) in opts { if self.match_lit(v, tt, kids) { return true; } }
        false
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
    // Self-bench: a numeric arg N times the lex+parse loop and prints ms/iteration.
    if let Some(iters) = std::env::args().nth(1).and_then(|a| a.parse::<u64>().ok()) {
        // black_box on the input + result so the optimizer can't elide the lex/parse.
        for _ in 0..3 { let toks = lex(std::hint::black_box(&src)); let mut p = Parser { toks, pos: 0 }; std::hint::black_box(p.parse_${ir.entry}()); }
        let t = std::time::Instant::now();
        for _ in 0..iters { let toks = lex(std::hint::black_box(&src)); let mut p = Parser { toks, pos: 0 }; std::hint::black_box(p.parse_${ir.entry}()); }
        println!("{:.4}", t.elapsed().as_secs_f64() * 1000.0 / iters as f64);
        return;
    }
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
