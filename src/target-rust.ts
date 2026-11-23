// The Rust Target for emit-portable. Renders the same language-agnostic ParserIR as
// tsTarget/goTarget into a self-contained Rust program (no external crates — the lexer is
// regex-free, so it compiles with rustc alone, no Cargo/network). Its CST JSON is checked
// against the interpreter on accept/reject parity, so `emitParser(grammar, rustTarget)` is a
// real, verified Rust parser derived from the same grammar definition.
//
// ARENA allocation (mirrors goTarget / tsgo / oxc): nodes live in a flat `nodes: Vec<Node>`,
// their children in a flat `kids: Vec<i32>`, and in-progress children accumulate on a
// `scratch: Vec<i32>` stack. A node is an `i32` index, never a heap pointer. Backtracking
// truncates the three vecs to saved lengths; they keep capacity across parses, so a warmed
// parser allocates ~nothing per parse. Rule fns return `i32` (-1 = fail); sub-sequence
// combinators take non-capturing `fn(&mut Parser) -> bool` pointers. Arena lives in
// `Parser.b` (CstBuilder by default); rule fns return `Option<Spanned<B::H>>`.
import { type ParserIR, type RdRule, type PrattRule, type RuleIR, type NudRef, type Step, type Alt, type Bracket, type LexTok, type TplCfg, type NewlineCfg, type FirstSig, type Guard, type LeadTest, type Dispatch, type LexFirstBytes, type LexIdPlan, type ArenaIdPlan, type ReusePlan, type ReusePlanA, type ReusePlanB } from './emit-portable.ts';
import { blockBody, elementTokens, regionKids, portableIR, sepDelimLid, buildLexDispatchPlan, lexTokFirstBytes, punctFirstBytes, buildLexIdPlan, buildLidPrefilter, buildLidTables, lidWordByte, buildArenaIdPlan, lidOf, lidDeltaTable, ctxWordLids, kidOf, lidFlagTable, kidFlagTable, ttIdOf, ruleIdOf, TT_SKIP_PUNCT, isFirstGuardable, groupByPreserveOrder, tokenSetBits, prattOpTables, stepExpr as walkExpr, stepStmts as walkStmts, ruleShell, prattShell, entryShell, dispatchWalk, gtCompLit, type PortableFacts, type StepLowering, type DispatchLowering, type PrattLowering, type CommitLowering } from './emit-portable.ts';
import type { CstGrammar } from './types.ts';
import { defineTarget, type SharedAlgorithms } from './define-target.ts';
import { ATOM, COMPARISON, findAnyName, stopBytes, isList, isNum, isOpt, isRec, isRecList, recName, type BinOp, type ListTy, type Lowering, type MetaInt, type MkMeta, type R, type TokInt } from './algo-ir.ts';
import { uniIdentPlan, uniLookup } from './uni-ident.ts';
import { type TextUnits, firstUnit, unitLen } from './text-units.ts';
import type {
  ShapeSpec, ShapeIR, ShapeIRRule, RuleShape, NodeShape, ChoiceShape, FieldDecl,
  FieldBind, TokenLeafPolicy, CustomShape, ParentFold, StreamType, PrattShape, RuleShapeAtom,
} from './shape-schema.ts';
import { validateShapeOrThrow } from './shape-validate.ts';

export type { ShapeSpec, ShapeIR } from './shape-schema.ts';

const J = (v: unknown) => JSON.stringify(v);
// Rust strings are indexed by UTF-8 byte: every offset and length printed here is in bytes.
const UNITS: TextUnits = 'utf8';
const tlen = (text: string): number => unitLen(text, UNITS);

/** `starts_with` on a single byte collapses to a direct byte compare (no slice/bounds). */
const startByteEq = (posExpr: string, s: string): string =>
  tlen(s) === 1 ? `b[${posExpr}] == ${firstUnit(s, UNITS)}` : `src[${posExpr}..].starts_with(${J(s)})`;

// Boolean expr testing whether the buffered token t starts branch i (FIRST set membership).
// null FirstSig → 'false' (never matched here; predictive alts have all-non-null FIRSTs).
const firstCond = (f: FirstSig, t: string, ids: LexIdPlan) => f
  ? `(${f.lits.map((l) => `${t}.lid == ${lidOf(ids, l)}`).join(' || ') || 'false'} || ${f.toks.map((k) => `${t}.kid == ${kidOf(ids, k)}`).join(' || ') || 'false'})`
  : 'false';
/** Non-null FirstSig small enough to pre-filter before a backtracking attempt. */
const isGuardable = (f: FirstSig, nAlts?: number): f is NonNullable<FirstSig> =>
  isFirstGuardable(f, nAlts);
// A longest-match candidate's Guard (emit-portable.ts) over the buffered token t, as conditions;
// keyed: the candidate is reached through its Dispatch key, which already tested the first token.
const guardCond = (g: Guard, t: string, keyed: boolean, recv = 'self'): string[] =>
  g === null ? [] : [...(keyed || g.first === null ? [] : [`in_token_set(${g.first.id}, &${t})`]), ...(g.second !== null ? [`${recv}.second_in(${g.second.id})`] : []), ...g.lead.map((l) => leadRs(l, t, recv))];
// A guard's lead test (emit-portable.ts LeadTest) on the buffered token t.
const leadRs = (l: LeadTest, t: string, recv: string): string => {
  const inS = l.ctx ? `(in_token_set(${l.set}, &${t}) || (${recv}.ctx != 0 && in_ctx_words(${recv}.ctx, &${t})))` : `in_token_set(${l.set}, &${t})`;
  return l.is ? inS : `!${inS}`;
};
// `if <conds> <body>` as one statement (just the body when there is no condition).
const ifRs = (conds: string[], body: string) => (conds.length ? `        if ${conds.join(' && ')} ${body}` : `        ${body}`);
// A candidate list's Dispatch over the buffered token t: arm(i, keyed) is candidate i's statement.
// opt: t is an Option<Tok> (none left: no key matches), bound as `t` inside a keyed section.
const dispatchRsL = (t: string, opt: boolean): DispatchLowering => ({
  sw: (by, cases) => `        match ${opt ? 't' : t}.${by} {\n${cases.map((c) => `        ${c.key} => {\n${c.arms.join('\n')}\n        }`).join('\n')}\n        _ => {}\n        }`,
  nil: (sw) => `        if let Some(t) = ${t} {\n${sw}\n        }`,
});
const dispatchRs = (d: Dispatch, t: string, ids: LexIdPlan, arm: (i: number, keyed: boolean) => string, opt = false): string =>
  dispatchWalk(d, ids, arm, dispatchRsL(t, opt), opt);
// A match arm's keys (numeric ids), a run of three or more consecutive ones as one range pattern
// (Rust syntax; the same arm).
const keysRs = (keys: string[]): string => {
  const ks = keys.map(Number).sort((a, b) => a - b), out: string[] = [];
  for (let i = 0; i < ks.length;) {
    let j = i;
    while (j + 1 < ks.length && ks[j + 1] === ks[j]! + 1) j++;
    if (j - i >= 2) out.push(`${ks[i]}..=${ks[j]}`); else for (let k = i; k <= j; k++) out.push(String(ks[k]));
    i = j + 1;
  }
  return out.join(' | ');
};
// A Commit's switch (emit-portable.ts commitWalk) over the buffered token t.
const commitSwRs: CommitLowering = {
  sw: (by, cases, dflt) => `        match t.${by} {\n${cases.map((c) => `        ${keysRs(c.keys)} => {${c.stmt ? `\n${c.stmt}\n        ` : ''}}`).join('\n')}\n        _ => {${dflt ? `\n${dflt}\n        ` : ''}}\n        }`,
  ifAll: ifRs,
  notAll: (conds) => `!(${conds.join(' && ')})`,
  pickDecl: '        let mut _c = 0u8;',
  pick: (n) => `{ _c = ${n}; }`,
  picked: (cases) => `        match _c {\n${cases.map((c) => `        ${c.n} => ${c.stmt}`).join('\n')}\n        _ => {}\n        }`,
};
// A committed candidate's statement: `body` when conds hold, then `fail` (unless body always returns).
// With no condition the body's block is the statement's own (blockBody).
const commitRs = (conds: string[], body: string, fail: string, returns = false) =>
  `{ ${conds.length ? `if ${conds.join(' && ')} ${body.startsWith('{') ? body : `{ ${body} }`}` : blockBody(body) ?? body}${conds.length || !returns ? ` ${fail}` : ''} }`;
// Whether candidate i, just ended at pos, beats the best so far: it ends past it, or — a Dispatch
// `ranked` candidate — ties it and was declared earlier. `bi` (the best one's index) is kept only
// in a list that has ranked candidates.
const beatsRs = (d: Dispatch, pos: string, i: number) => d.ranked.includes(i) ? `(${pos} > best_pos || ${pos} == best_pos && ${i} < bi)` : `${pos} > best_pos`;
const markRs = (d: Dispatch, i: number) => (d.ranked.length ? ` bi = ${i};` : '');
const biRs = (d: Dispatch) => (d.ranked.length ? ' let mut bi: i32 = -1;' : '');
// ── The two frames of a construct that may have to undo what it tried ──
// Every one is printed by one of these, so what a frame costs in the output is decided here.
// The checkpoint (position, scratch length, builder checkpoint) taken over the parser `p`, and the
// undo back to it.
const ckptRs = (p: string) => `let m = ${p}.mark();`;
const undoRs = (p: string) => `${p}.reset(m);`;
// BRANCH frame: one branch of an ordered choice (`alt`), over `p`: it returns true from the
// choice when the branch matched, and undoes it when it did not (recognized, `r`: the position only).
// A branch that fails clean (Step.clean) has nothing to undo: no frame.
const branchRs = (cond: string, r = false, clean = false) => clean ? `{ if ${cond} { return true; } }` : r
  ? `{ let sp = p.pos; if ${cond} { return true; } p.back(sp); }`
  : `{ ${ckptRs('p')} if ${cond} { return true; } ${undoRs('p')} }`;
// CANDIDATE frame: one candidate of a longest-match list (an rd rule's alternatives, a Pratt
// rule's NUD arms) of rule `rid`, tried from `save`: when it matched and beats the best so far,
// its node is finished as the best, `more` records its index / form, and `ck` moves past the node;
// else what it built is dropped; either way the position goes back to `save` for the next
// candidate. Printed as the `cand!` macro (CAND_MACRO_RS), which expands to exactly that frame.
const lostRs = `self.scratch.truncate(sb); self.b.restore(ck);`;
const candRs = (d: Dispatch, i: number, cond: string, rid: number, more: string) =>
  `{ cand!(self, sb, ck, save, best, best_pos, ${rid}, ${cond} && ${beatsRs(d, 'self.pos', i)}, {${more}}); }`;
// The candidate frame as a macro, not a method: a helper over the list's state was measured to
// cost instructions (+2 to +9%: LLVM does not treat the call as it treats the frame in place),
// and a macro expands to the frame in place. The list's locals are passed by name (hygiene).
const CAND_MACRO_RS = `/// A longest-match candidate (target-rust.ts candRs): if \`$c\` (it matched and beats the best so far),
/// node \`$rid\` is finished as the best and the checkpoint moves past it, else what it built is dropped;
/// then the position goes back to the list's start.
macro_rules! cand {
    ($p:ident, $sb:ident, $ck:ident, $save:ident, $best:ident, $best_pos:ident, $rid:expr, $c:expr, $more:block) => {
        if $c { $best = Some($p.finish($rid, $sb, $p.off_at($save), $save)); $best_pos = $p.pos; $more $ck = $p.b.checkpoint(); } else { $p.scratch.truncate($sb); $p.b.restore($ck); } $p.back($save);
    };
}
/// A committed candidate (emit-portable.ts Commit; target-rust.ts commitBodyRs): \`$c\` from here;
/// matched (\`undo_ne\`: and past its start), node \`$rid\` is returned after \`$set\` (a NUD's form, tail
/// and capped flag), else what it did is undone to the checkpoint (\`clean\`: a clean failure left
/// nothing to undo, so none is taken) and the statement after the macro runs.
#[allow(unused_macros)]
macro_rules! commit {
    ($p:ident, $rid:expr, $c:expr, $m:ident, nud $t:tt $cp:tt) => { commit!($p, $rid, $c, $m, { $p.form = 0; $p.tail = $t; $p.capped = $cp; }) };
    ($p:ident, $rid:expr, $c:expr, undo, { $($set:tt)* }) => {{ let m = $p.mark(); if $c { let n = $p.finish($rid, m.sb, $p.off_at(m.pos), m.pos); $($set)* return Some(n); } $p.reset(m); }};
    ($p:ident, $rid:expr, $c:expr, undo_ne, { $($set:tt)* }) => {{ let m = $p.mark(); if $c && $p.pos > m.pos { let n = $p.finish($rid, m.sb, $p.off_at(m.pos), m.pos); $($set)* return Some(n); } $p.reset(m); }};
    ($p:ident, $rid:expr, $c:expr, clean, { $($set:tt)* }) => {{ let save = $p.pos; let sb = $p.scratch.len(); if $c { let n = $p.finish($rid, sb, $p.off_at(save), save); $($set)* return Some(n); } }};
}`;
// A committed candidate's body in the building form: the \`commit!\` macro (as \`cand!\`: expanded in place);
// \`set\`: the statements after its node is made (\`nud <tail> <capped>\`: a NUD arm's state, spelled by the macro).
const commitBodyRs = (rid: number, cond: string, undo: boolean, nullable: boolean, set = '{}') => `commit!(self, ${rid}, ${cond}, ${nullable ? 'undo_ne' : undo ? 'undo' : 'clean'}, ${set});`;
// The typed-AST layer's form of a Guard over the token t: its parser keeps no lookahead mark, so
// the second token is read directly. null: no guard.
const astGuardRs = (g: Guard, t: string): string | null =>
  g === null || g.first === null ? null : [`in_token_set(${g.first.id}, &${t})`, ...(g.second !== null ? [`self.toks.get(self.pos + 1).map_or(false, |t2| in_token_set(${g.second.id}, t2))`] : [])].join(' && ');

// '>'-led composite operators (LexIdPlan.gtComps): the lexer scans every '>' alone. gt_op reads the
// operator at toks[i]: a lone '>' extends over each adjacent single-character punct token after it
// while the text stays a composite (gt_step: prefix lid × next character lid → composite lid). A
// punct token (kid 0) is the text of its lid, and gt_step names only one-character lids, so no
// length (which is in bytes here, not characters) is compared.
function gtRuntimeRust(ids: LexIdPlan): string {
  const arms = ids.gtComps.map((c) => {
    const a = lidOf(ids, c.slice(0, -1)), b = lidOf(ids, c.slice(-1)), r = lidOf(ids, c);
    if (a === 0 || b === 0 || r === 0) throw new Error(`rustTarget: composite ${J(c)} needs lids for its prefix and last character`);
    return `(${a}, ${b}) => ${r}, `;
  }).join('');
  return `const GT_LID: u16 = ${ids.gtComps.length > 0 ? lidOf(ids, '>') : 'u16::MAX'};
/// The first word lid (LexIdPlan.kwLid): a literal from here on is a \`$keyword\` leaf, one before it a \`$punct\` (no leaf).
const LID_KW: u16 = ${ids.kwLid};
#[inline(always)] fn gt_step(a: u16, b: u16) -> u16 { match (a, b) { ${arms}_ => 0 } }
#[inline]
fn gt_op(toks: &[Tok], i: usize) -> (u16, usize, u32) {
    let t = toks[i];
    let (mut lid, mut n, mut end) = (t.lid, 1usize, t.end);
    if lid != GT_LID { return (lid, n, end); }
    let mut j = i + 1;
    while j < toks.len() {
        let u = toks[j];
        if u.kid != 0 || u.off != end { break; }
        let c = gt_step(lid, u.lid);
        if c == 0 { break; }
        lid = c; n += 1; end = u.end; j += 1;
    }
    (lid, n, end)
}`;
}

/** Emit kid/lid lookup tables into generated lexer source (length-bucketed lid_of match). */
function renderIdTablesRust(ids: LexIdPlan): string {
  const kidsLit = ids.kids.map(J).join(', ');
  const lidsLit = ids.lids.map(J).join(', ');
  const kidArms = ids.kids.map((k, i) => `${J(k)} => ${i}`).join(', ');
  const tables = buildLidTables(ids, UNITS);
  const lenArmsOf = (byLen: [number, { text: string; id: number }[]][]) =>
    byLen.map(([len, ents]) => {
      const arms = ents.map((e) => `${rsByteStr(e.text)} => ${e.id}`).join(', ');
      return `        ${len} => match text { ${arms}, _ => 0 },`;
    }).join('\n');
  const kwArms = lenArmsOf(tables.word);
  const puArms = lenArmsOf(tables.rest);
  const pf = buildLidPrefilter(ids, UNITS);
  const bitsLit = [...pf.firstByLenBits].join(', ');
  // The byte pattern of lidWordByte, from the function itself (ranges of consecutive bytes).
  const wordBytes: string[] = [];
  for (let b = 0; b < 256; b++) {
    if (!lidWordByte(b) || lidWordByte(b - 1)) continue;
    let e = b;
    while (e < 255 && lidWordByte(e + 1)) e++;
    wordBytes.push(e === b ? `${b}` : `${b}..=${e}`);
  }
  return `${gtRuntimeRust(ids)}
const KIND_STR: &[&str] = &[${kidsLit}];
const _LIDS: &[&str] = &[${lidsLit}];
const _LID_MAX_LEN: usize = ${pf.maxLen};
const _LID_FIRST_BITS: &[u8] = &[${bitsLit}];
#[inline(always)] fn tok_kind(t: &Tok) -> &'static str { KIND_STR[t.kid as usize] }
#[inline(always)] fn tok_text<'a>(src: &'a str, t: &Tok) -> &'a str { &src[t.off as usize..t.end as usize] }
#[inline(always)] fn mk_tok(off: usize, end: usize, nl: bool, kid: u16, lid: u16) -> Tok { Tok { off: off as u32, end: end as u32, kid, lid, nl } }
fn kid_of(kind: &str) -> u16 { match kind { ${kidArms}, _ => 0 } }
/// O(1) length×first-byte prefilter: false when no literal has the text's key (its bits hold every
/// literal's key).
#[inline(always)]
fn lid_key_is_literal(text: &[u8]) -> bool {
    let n = text.len();
    if n == 0 || n > _LID_MAX_LEN { return false; }
    let b0 = text[0] as usize;
    (_LID_FIRST_BITS[n * 32 + (b0 >> 3)] & (1u8 << (b0 & 7))) != 0
}
/// The prefilter, then the match table of the text's first-byte class: a word is compared with
/// word literals only. Over the text's bytes: a literal is compared byte for byte, so the lexer
/// passes its token's bytes without the char boundary checks a \`&str\` slice makes.
#[inline(always)]
fn lid_of(text: &[u8]) -> u16 {
    if !lid_key_is_literal(text) { return 0; }
    if matches!(text[0], ${wordBytes.join(' | ')}) { lid_of_kw(text, text.len()) } else { lid_of_punct(text, text.len()) }
}
/// lid_of for a token whose kind can equal word literals only (the generator proved it from the
/// kind's shape, tokenLiterals): the word table, without the first-byte routing.
#[inline(always)]
fn lid_of_word(text: &[u8]) -> u16 {
    if !lid_key_is_literal(text) { return 0; }
    lid_of_kw(text, text.len())
}
#[inline(never)]
fn lid_of_kw(text: &[u8], n: usize) -> u16 {
    match n {
${kwArms || '        // no keyword lids'}
        _ => 0,
    }
}
#[inline(never)]
fn lid_of_punct(text: &[u8], n: usize) -> u16 {
    match n {
${puArms || '        // no punct lids'}
        _ => 0,
    }
}
`;
}

/** Emit TT_NAMES / RULE_NAMES from ArenaIdPlan (slim arena leaf + rule ids). */
function renderArenaIdTablesRust(ar: ArenaIdPlan): string {
  return `const TT_NAMES: &[&str] = &[${ar.ttNames.map(J).join(', ')}];
const RULE_NAMES: &[&str] = &[${ar.ruleNames.map(J).join(', ')}];
`;
}


// Whether a skipped token's bytes hold a line terminator (LF, CR, U+2028, U+2029), read as bytes:
// eight per round test for LF, CR and E2 (the lead byte of U+2028 / U+2029: E2 80 A8 / A9); the
// lowest flagged byte of a round is the first candidate (a zero-byte mask is exact at its lowest
// bit), which is then checked whole, and the search goes on after it.
const RS_HAS_LINE_TERM = `#[inline(never)]
fn _lx_has_line_term(b: &[u8]) -> bool {
    const L: u64 = 0x0101_0101_0101_0101;
    let z = |v: u64| v.wrapping_sub(L) & !v & (L << 7);
    let mut i = 0;
    loop {
        let c = match b.get(i..i + 8) {
            Some(w) => {
                let v = u64::from_le_bytes([w[0], w[1], w[2], w[3], w[4], w[5], w[6], w[7]]);
                let m = z(v ^ (L * 10)) | z(v ^ (L * 13)) | z(v ^ (L * 0xE2));
                if m == 0 { i += 8; continue; }
                i += (m.trailing_zeros() >> 3) as usize;
                b[i]
            }
            None => match b.get(i) { Some(&c) => c, None => return false },
        };
        match c {
            10 | 13 => return true,
            0xE2 if b.get(i + 1) == Some(&0x80) && matches!(b.get(i + 2), Some(&(0xA8 | 0xA9))) => return true,
            _ => i += 1,
        }
    }
}
`;

// The relex family steps `lex_from` one token at a time; out of line, every step rebuilds and
// returns the whole lexer state through memory.
const LEX_FROM_ATTR = '#[inline(always)]\n';

// The literal id of a token whose text is `bytes`, given the literals its kind can be
// (shared.tokenLiterals): 0 when it can be none, the word table alone when it can be words only.
function lidCall(lits: string[], bytes: string): string {
  if (lits.length === 0) return '0';
  return lits.every((l) => lidWordByte(firstUnit(l, UNITS))) ? `lid_of_word(${bytes})` : `lid_of(${bytes})`;
}

// One token at a dispatch site: the shared scanner says where it ends; the lexer records it.
// A lexer error (relex-family.ts LexErr): recorded in the lexer's error (`at`: a local `err`, or
// the element scan's field, which its loop head reads: a local there would be carried around every
// iteration, +1.2% lex instructions on the TSX inputs, profile run 45113125143), and the step ends
// the lex: pos is the end of input, so the loop exits (with a type-parameter signature undecided,
// its head rewinds it).
const rsFail = (at: string, kind: string, off: string, end: string): string => `${at} = Some(LexErr { kind: ${kind}, off: ${off}, end: ${end} }); pos = n; continue;`;
const RS_LEX_ERR = `/// A lexer error (relex-family.ts LexErr): its kind, offset and end; lex_error spells its message.
#[derive(Clone, Copy)]
struct LexErr { kind: isize, off: isize, end: isize }
/// The lexer error of a template span (-1 unterminated, -2 - q an invalid escape at q).
#[cold] #[inline(never)] fn _lex_tpl_err(q: isize, n: usize) -> LexErr {
    if q == -1 { LexErr { kind: 2, off: n as isize, end: 0 } } else { LexErr { kind: 3, off: -2 - q, end: 0 } }
}
/// Input the lexer cannot tokenize: where, and the message.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LexError { pub off: usize, pub msg: String }
impl std::fmt::Display for LexError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { f.write_str(&self.msg) }
}
impl std::error::Error for LexError {}
/// The LexError of the lexer's error e in src.
#[cold] #[inline(never)] fn lex_error(src: &str, e: LexErr) -> LexError {
    let off = e.off as usize;
    let msg = match e.kind {
        0 => format!("Unexpected character at offset {}: '{}'", off, _char_at(src, off).map(|(ch, _)| ch).unwrap_or(src.as_bytes()[off] as char)),
        1 => format!("Invalid identifier escape at offset {}: '{}'", off, &src[off..e.end as usize]),
        2 => format!("Unterminated template literal at offset {}", off),
        _ => format!("Invalid escape sequence in template at offset {}", off),
    };
    LexError { off, msg }
}
/// The tokens of src; a lexer error panics with its message.
fn lex(src: &str) -> Vec<Tok> {
    match lex_all(src) { (toks, None) => toks, (_, Some(e)) => panic!("{}", lex_error(src, e).msg) }
}
`;
const RS_LEX_FN = `fn lex_all<'a>(src: &'a str) -> (Vec<Tok>, Option<LexErr>) {
    let mut toks = Vec::new();
    let err = lex_into(src, &mut toks, &mut LexStacks::default());
    (toks, err)
}
`;
const rsUnexpected = (at: string): string => `        ${rsFail(at, '0', 'pos as isize', 'pos as isize')}`;

function scanTok(ir: ParserIR, t: LexTok, shared: SharedAlgorithms, stateful: boolean, ids: LexIdPlan, rxTok: string | undefined, identLike: Set<string>, errAt: string): string {
  const name = t.name;
  const nlVar = stateful ? 'st.pending_nl' : 'pending_nl';
  const kid = kidOf(ids, name);
  const lid = lidCall(shared.tokenLiterals(ir, t, ids.lids.slice(1)), '&b[pos..e]');
  const push = t.skip
    ? `if _lx_has_line_term(&b[pos..e]) { ${nlVar} = true; } `
    : stateful
      ? `st.emit(pos, e, ${kid}, ${lid}); `
      : `toks.push(mk_tok(pos, e, pending_nl, ${kid}, ${lid})); pending_nl = false; `;
  // Identifier(-prefixed) token: fold a trailing non-ASCII ID_Continue run into the match
  // (caf|é → café), mirroring the interpreter's uniIdentContReY extension (emit-lexer.ts).
  const ext = identLike.has(name) ? 'let e = if e < b.len() && b[e] >= 0x80 { _lx_ext(b, e) } else { e }; ' : '';
  // An identifier whose escapes spell no IdentifierName is the lexer error -2 - e (lex-family.ts).
  const escErr = identLike.has(name) ? ` if e < -1 { ${rsFail(errAt, '1', 'pos as isize', '-2 - e')} }` : '';
  const scan = `{ let e = ${shared.scanner(name)}(src, pos as isize); if e >= 0 { let e = e as usize; ${ext}${push}pos = e; continue; }${escErr} }`;
  return rxTok !== undefined && name === rxTok ? `        if !st.prev_is_value() ${scan}` : `        ${scan}`;
}

/** A Rust byte-string literal of text's UTF-8 bytes (printable ASCII as is, the rest escaped). */
function rsByteStr(text: string): string {
  let out = 'b"';
  for (const byte of Buffer.from(text, 'utf8')) {
    out += byte >= 0x20 && byte < 0x7f && byte !== 0x22 && byte !== 0x5c ? String.fromCharCode(byte) : `\\x${byte.toString(16).padStart(2, '0')}`;
  }
  return out + '"';
}

function rustByteLit(b: number): string {
  if ((b >= 97 && b <= 122) || (b >= 65 && b <= 90) || (b >= 48 && b <= 57)) return `b'${String.fromCharCode(b)}'`;
  if ([33, 35, 36, 37, 38, 42, 43, 44, 45, 46, 47, 58, 59, 61, 63, 64, 94, 95].includes(b)) return `b'${String.fromCharCode(b)}'`;
  return String(b);
}

function rustMatchLabels(bytes: number[]): string {
  const sorted = [...bytes].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const lo = sorted[i];
    let hi = lo;
    while (i + 1 < sorted.length && sorted[i + 1] === hi + 1) hi = sorted[++i];
    if (lo === hi) {
      parts.push(rustByteLit(lo));
    } else {
      const ls = rustByteLit(lo), hs = rustByteLit(hi);
      parts.push(ls.startsWith('b') && hs.startsWith('b') ? `${ls}..=${hs}` : `${lo}..=${hi}`);
    }
  }
  return parts.join(' | ');
}

function buildLexCandidates(
  ir: ParserIR, shared: SharedAlgorithms, stateful: boolean, ids: LexIdPlan, rxTok: string | undefined,
  punctLine: (p: string) => string, errAt: string,
): { codes: string[]; firsts: (LexFirstBytes | null)[] } {
  const identLike = new Set(ir.identLike);
  const codes: string[] = [];
  const firsts: (LexFirstBytes | null)[] = [];
  for (const t of shared.scannedTokens(ir)) {
    codes.push(scanTok(ir, t, shared, stateful, ids, rxTok, identLike, errAt));
    firsts.push(lexTokFirstBytes(t));
  }
  for (const p of ir.puncts) {
    codes.push(punctLine(p));
    firsts.push(punctFirstBytes(p));
  }
  return { codes, firsts };
}

/** Shared first-byte dispatch for all lexFrom variants in this target. */
// `armHead`: code that runs first in the arm of one ASCII byte (and nowhere else), for a test that
// only that byte can pass.
function renderLexByteDispatchRust(codes: string[], firsts: (LexFirstBytes | null)[], indent: string, specialAsciiArms: string, nonAsciiWsCheck: string, armHead: { byte: number; code: string } | null = null, moreHeads: Map<number, string> = new Map()): string {
  const { arms, fallbackIndices } = buildLexDispatchPlan(firsts);
  const fallback = fallbackIndices.map((i) => codes[i]).join('\n');
  let matchArms = specialAsciiArms;
  // A byte no candidate starts with gets an arm of its own for the head code.
  if (armHead && !arms.some((a) => a.bytes.includes(armHead.byte))) matchArms += `${indent}        ${rustMatchLabels([armHead.byte])} => {\n${armHead.code}${indent}        }\n`;
  for (const [byte, code] of moreHeads) if (!arms.some((a) => a.bytes.includes(byte))) matchArms += `${indent}        ${rustMatchLabels([byte])} => {\n${code}${indent}        }\n`;
  for (const arm of arms) {
    matchArms += `${indent}        ${rustMatchLabels(arm.bytes)} => {\n`;
    if (armHead && arm.bytes.includes(armHead.byte)) matchArms += armHead.code;
    for (const b of arm.bytes) matchArms += moreHeads.get(b) ?? '';
    matchArms += arm.indices.map((i) => codes[i]).join('\n') + '\n';
    matchArms += `${indent}        }\n`;
  }
  return `${indent}        if c >= 128 {
${nonAsciiWsCheck}${fallback}
${indent}        } else {
${indent}        match b[pos] {
${matchArms}${indent}        _ => {}
${indent}        }
${indent}        }`;
}

// The lexer of a grammar with an element region (ElementPlan): the frame stack is the template
// stack, and the frame decisions are the shared family's (lex-family.ts elementFns); what is here
// is their placement in the dispatch loop, the token push, and the type-parameter signature's
// speculation (lexed as code to its verdict, then rewound: docs/REGIONS.md). A lexer error while a
// signature is undecided is its verdict (the head was an element): the loop head rewinds.
function elementLexerRust(ir: ParserIR, ids: LexIdPlan, shared: SharedAlgorithms, p: {
  head: string; scans: string; tplFn: string; lexCodes: string[]; lexFirsts: (LexFirstBytes | null)[]; specialArms: string; nonAscii: string;
  tplCloseTest: string; tplOpenPreCheck: string; closeByte: number | null; uniIdentOrPanic: string; pavHot: string; lexStacks: string; takeStk: (f: string) => string;
}): string {
  const el = ir.elements!, rx = ir.regexCtx, tpl = ir.tpl, sig = el.signature, raw = el.rawText.length > 0;
  const operand = el.entry === 'operand';
  if (operand && !rx) throw new Error('portable: an operand element entry needs the regex context (prevIsValue)');
  const L = tlen(el.tagOpen);
  const consts = `const _LID_EL_OPEN: u16 = ${lidOf(ids, el.tagOpen)};
const _LID_EL_CLOSE: u16 = ${lidOf(ids, el.tagClose)};
const _LID_HOLE_OPEN: u16 = ${lidOf(ids, el.holeOpen)};
const _LID_HOLE_CLOSE: u16 = ${lidOf(ids, el.holeClose)};
const _LID_EQ: u16 = ${lidOf(ids, '=')};
${sig ? `${rsBoolArr('_EL_THEN', lidFlagTable(ids, sig.then))}
` : ''}`;
  const rxFields = rx ? 'base: usize, prev0: (bool, u16, u16), bp0: (bool, u16), kid1: u16, lid1: u16, lid2: u16, paren_head: Vec<bool>, last_close: bool, last_bang: bool, ' : '';
  const specFields = sig ? 'spec_tok: usize, spec_on: bool, spec_base: usize, spec_closed_at: usize, spec_closed: bool, spec_done: bool, spec_then: bool, spec_off: usize, spec_end: usize, spec_at: usize, spec_has_at: bool, spec_keep: bool, sv: (usize, bool, u16, u16, u16, bool, isize), sv_paren: Vec<bool>, sv_stack: Vec<i64>, ' : '';
  const inl = '    #[inline(always)]\n';
  const braces = [
    tpl ? `if f & 3 == 0 { if lid == _LID_BRACE_OPEN { *self.template_stack.last_mut().unwrap() = f + 4; } else if lid == _LID_INTERP_CLOSE { *self.template_stack.last_mut().unwrap() = f - 4; } }` : '',
    `if f & 3 == 1 { if lid == _LID_HOLE_OPEN { *self.template_stack.last_mut().unwrap() = f + 4; } else if lid == _LID_HOLE_CLOSE { *self.template_stack.last_mut().unwrap() = f - 4; } }`,
  ].filter(Boolean).join(' else ');
  const methods = `${rx ? `${inl}    fn prev(&self) -> (bool, u16, u16) {
        let n = self.acc.len();
        (n > self.base || self.prev0.0, self.kid1, self.lid1)
    }
${inl}    fn prev2(&self) -> (bool, u16) {
        let n = self.acc.len();
        (n > self.base + 1 || (n == self.base + 1 && self.prev0.0) || (n == self.base && self.bp0.0), self.lid2)
    }
${inl}    fn prev_is_value(&self) -> bool {
        // in a tag nothing is a regex; the token that ended an element is a value
        if let Some(&f) = self.template_stack.last() { if f & 3 == 2 && f & 12 != 0 { return true; } }
        if self.el_ended { return true; }
        let (has_prev, prev_kid, prev_lid) = self.prev();
        if !has_prev { return false; }
        if ${rsFlag('_PAV', 'prev_lid')} { return self.last_bang; }
        let is_expr_kw = prev_kid == _KID_IDENT && ${rsFlag('_RXT', 'prev_lid')} && { let (has_prev2, bp_lid) = self.prev2(); !(has_prev2 && ${rsFlag('_MEM', 'bp_lid')}) };
        let is_paren_head = prev_lid == _LID_RPAREN && self.last_close;
        !is_expr_kw && !is_paren_head && (${rsFlag('_DIVK', 'prev_kid')} || ${rsFlag('_DIVT', 'prev_lid')})
    }
` : ''}${inl}    fn emit(&mut self, off: usize, end: usize, kid: u16, lid: u16) {
${rx ? `        if lid == _LID_LPAREN { let (has_prev2, bp_lid) = self.prev2(); let (_, prev_kid, prev_lid) = self.prev(); let is_member = has_prev2 && ${rsFlag('_MEM', 'bp_lid')}; self.paren_head.push(!is_member && prev_kid == _KID_IDENT && ${rsFlag('_PHK', 'prev_lid')}); }
        else if lid == _LID_RPAREN { self.last_close = self.paren_head.pop().unwrap_or(false);${sig ? ' if self.spec_on && self.acc.len() > self.spec_tok + 3 && self.paren_head.len() == self.spec_base { self.spec_closed = true; self.spec_closed_at = self.acc.len(); }' : ''} }
        if ${p.pavHot} { self.last_bang = self.prev_is_value(); }
` : ''}${sig ? `        // the token after the signature group's closer decides it (a closer that leaves the bracket
        // stack at its base, even by popping an empty one, closes it again)
        if self.spec_closed && self.acc.len() > self.spec_closed_at { self.spec_closed = false; self.spec_done = true; self.spec_then = kid == 0 && ${rsFlag('_EL_THEN', 'lid')}; self.spec_off = off; self.spec_end = end; }
` : ''}        if let Some(&f) = self.template_stack.last() { ${braces} }
        self.acc.push(mk_tok(off, end, self.pending_nl, kid, lid)); self.pending_nl = false; self.el_ended = false;${rx ? ' self.lid2 = self.lid1; self.kid1 = kid; self.lid1 = lid;' : ''}
    }
${sig ? `    #[cold] #[inline(never)]
    fn spec_begin(&mut self, pos: usize) {
        self.sv = (pos, self.pending_nl, self.kid1, self.lid1, self.lid2, self.el_ended, self.tag_angle);
        self.sv_paren.clear(); self.sv_paren.extend_from_slice(&self.paren_head);
        self.sv_stack.clear(); self.sv_stack.extend_from_slice(&self.template_stack);
        self.spec_tok = self.acc.len(); self.spec_on = true; self.spec_base = self.paren_head.len(); self.spec_closed = false; self.spec_done = false;
        self.sv_bang = (self.last_close, self.last_bang);
    }
    #[cold] #[inline(never)]
    fn spec_rewind(&mut self, src: &str, n: usize) -> usize {
        let failed = self.err.is_some();
        let keep = self.spec_done && !failed && self.spec_then;
        let re = if self.spec_done && !failed { ${shared.elementFn('reach')}(src, self.spec_end as isize) } else { n as isize + 1 };
        if re > self.la_end { self.la_end = re; }
        if keep { self.spec_until = self.spec_off as isize; }
        self.spec_at = self.sv.0; self.spec_has_at = true; self.spec_keep = keep;
        self.acc.truncate(self.spec_tok);
        let (pos, nl, kid1, lid1, lid2, ended, angle) = self.sv;
        self.pending_nl = nl; self.kid1 = kid1; self.lid1 = lid1; self.lid2 = lid2; self.el_ended = ended; self.tag_angle = angle;
        self.last_close = self.sv_bang.0; self.last_bang = self.sv_bang.1;
        self.paren_head.clear(); self.paren_head.extend_from_slice(&self.sv_paren);
        self.template_stack.clear(); self.template_stack.extend_from_slice(&self.sv_stack);
        self.spec_on = false; self.spec_closed = false; self.spec_done = false; self.err = None;
        pos
    }
` : ''}`;
  const struct = `struct ElScan<'a> { acc: &'a mut Vec<Tok>, pending_nl: bool, err: Option<LexErr>, ${rxFields}template_stack: Vec<i64>, el_ended: bool, tag_angle: isize, la_end: isize, spec_until: isize, ${raw ? 'tag_at: Vec<i64>, ' : ''}${specFields}${sig ? 'sv_bang: (bool, bool), ' : ''}}
impl<'a> ElScan<'a> {
${methods}}
`;
  const enter = `            st.template_stack.push(6); st.emit(pos, pos + ${L}, 0, _LID_EL_OPEN);${raw ? ' st.tag_at.push(st.acc.len() as i64 - 1);' : ''} st.tag_angle = 0; pos += ${L}; continue;\n`;
  const at = (lit: string) => startByteEq('pos', lit);
  const entry = !operand ? `        if ${at(el.tagOpen)} {\n${enter}        }\n`
    : !(el.head || sig) ? `        if ${at(el.tagOpen)} && !st.prev_is_value() {\n${enter}        }\n`
    : `        if ${at(el.tagOpen)}${sig ? ' && !st.spec_on && pos as isize >= st.spec_until' : ''} && !st.prev_is_value() {
            let op;
            ${sig ? 'if st.spec_has_at && pos == st.spec_at { op = if st.spec_keep { 0 } else { 1 }; st.spec_has_at = false; } else ' : ''}{ let (o, re) = ${shared.elementFn('opens')}(src, pos as isize); op = o; if re > st.la_end { st.la_end = re; } }
            if op == 1 {
${enter}            }
${sig ? '            if op == 2 { st.spec_begin(pos); }\n' : ''}        }
`;
  const holeClose = `        if st.template_stack.last() == Some(&1) && ${at(el.holeClose)} {
            st.emit(pos, pos + ${tlen(el.holeClose)}, 0, _LID_HOLE_CLOSE); st.template_stack.pop(); pos += ${tlen(el.holeClose)}; continue;
        }
`;
  const heads = new Map<number, string>();
  let pre = '';
  const place = (lit: string, code: string) => { const u = Buffer.from(lit, 'utf8')[0]!; if (u >= 128 || [9, 10, 11, 12, 13, 32].includes(u)) pre += code; else heads.set(u, (heads.get(u) ?? '') + code); };
  place(el.tagOpen, entry);
  place(el.holeClose, holeClose);
  if (tpl) { if (p.closeByte !== null) place(tpl.interpClose, p.tplCloseTest); else pre += p.tplCloseTest; pre += p.tplOpenPreCheck; }
  const cascade = renderLexByteDispatchRust(p.lexCodes, p.lexFirsts, '        ', p.specialArms, p.nonAscii, null, heads);
  const frameStep = `        if let Some(&fr) = st.template_stack.last() { if fr & 3 == 2 {
            let after_eq = st.acc.last().map_or(false, |t| t.lid == _LID_EQ);
            let (fe, fk, fl, ft, fp, fa, fla) = ${shared.elementFn('frame')}(src, pos as isize, fr as isize, st.tag_angle, after_eq, st.la_end);
            st.la_end = fla;
            if fe >= 0 {
                st.emit(pos, fe as usize, fk as u16, fl as u16);
${raw ? `                // each element frame's current tag: the index of its tagOpen token (the name is the next)
                if fl as u16 == _LID_EL_OPEN { let at = st.acc.len() as i64 - 1; if fp == 6 { st.tag_at.push(at); } else if (fr >> 2) & 3 == 0 { *st.tag_at.last_mut().unwrap() = at; } }
` : ''}                if ft < 0 { st.template_stack.pop();${raw ? ' st.tag_at.pop();' : ''} st.el_ended = true; } else { *st.template_stack.last_mut().unwrap() = ft as i64; }
                if fp != 0 { st.template_stack.push(fp as i64); }
${raw ? `                // an open tag ended: a raw-text name gives its body to a raw frame (kind 3), lexed next
                if fl as u16 == _LID_EL_CLOSE && (fr >> 2) & 3 == 1 && st.tag_angle == 0 {
                    let i = (*st.tag_at.last().unwrap() + 1) as usize;
                    if i + 1 < st.acc.len() { let t = st.acc[i]; let (re, rk) = ${shared.elementFn('raw')}(src, t.off as isize, t.end as isize, fe); if rk != 0 && re > fe { st.template_stack.push(3); } }
                }
` : ''}                st.tag_angle = fa; pos = fe as usize; continue;
            }
        } }
${raw ? `        if st.template_stack.last() == Some(&3) {
            let t = st.acc[(*st.tag_at.last().unwrap() + 1) as usize];
            let (re, rk) = ${shared.elementFn('raw')}(src, t.off as isize, t.end as isize, pos as isize);
            st.emit(pos, re as usize, rk as u16, 0); st.template_stack.pop(); pos = re as usize; continue;
        }
` : ''}`;
  const loopBody = `${sig ? '        if st.spec_on && (st.spec_done || st.err.is_some() || pos >= n) { pos = st.spec_rewind(src, n); continue; }\n' : ''}        let c = b[pos] as u32;
${frameStep}${pre}${cascade}
${p.uniIdentOrPanic}`;
  const cond = sig ? '(pos < n || st.spec_on) && (limit == 0 || st.acc.len() - base < limit || st.spec_on)' : 'pos < n && (limit == 0 || st.acc.len() - base < limit)';
  const rxParams = rx ? 'prev_lid: u16, prev_kid: u16, bp_lid: u16, has_prev: bool, has_prev2: bool, paren_head: Vec<bool>, last_close: bool, last_bang: bool, ' : '';
  const rxTy = rx ? 'u16, u16, u16, bool, bool, Vec<bool>, bool, bool, ' : '';
  const rxInit = rx ? 'base, prev0: (has_prev, prev_kid, prev_lid), bp0: (has_prev2, bp_lid), kid1: prev_kid, lid1: prev_lid, lid2: bp_lid, paren_head, last_close, last_bang, ' : '';
  const specInit = sig ? 'spec_tok: 0, spec_on: false, spec_base: 0, spec_closed_at: 0, spec_closed: false, spec_done: false, spec_then: false, spec_off: 0, spec_end: 0, spec_at: 0, spec_has_at: false, spec_keep: false, sv: (0, false, 0, 0, 0, false, 0), sv_paren: Vec::new(), sv_stack: Vec::new(), sv_bang: (false, false), ' : '';
  const rxOut = rx ? 'let ((has_prev, prev_kid, prev_lid), (has_prev2, bp_lid)) = (st.prev(), st.prev2());\n    ' : '';
  const rxRet = rx ? 'prev_lid, prev_kid, bp_lid, has_prev, has_prev2, st.paren_head, st.last_close, st.last_bang, ' : '';
  return `${p.head}${consts}${p.lexStacks}${p.scans}${p.tplFn}${struct}${LEX_FROM_ATTR}fn lex_from<'a>(src: &'a str, mut pos: usize, pending_nl: bool, ${rxParams}template_stack: Vec<i64>, el_ended: bool, tag_angle: isize, la_end: isize, spec_until: isize, ${raw ? 'tag_at: Vec<i64>, ' : ''}acc: &mut Vec<Tok>, limit: usize) -> (usize, bool, ${rxTy}Vec<i64>, bool, isize, isize, isize${raw ? ', Vec<i64>' : ''}, Option<LexErr>) {
    let b = src.as_bytes();
    let n = b.len();
    let base = acc.len();
    let mut st = ElScan { acc, pending_nl, err: None, ${rxInit}template_stack, el_ended, tag_angle, la_end, spec_until, ${raw ? 'tag_at, ' : ''}${specInit}};
    while ${cond} {
${loopBody}
    }
    ${rxOut}(pos, st.pending_nl, ${rxRet}st.template_stack, st.el_ended, st.tag_angle, st.la_end, st.spec_until${raw ? ', st.tag_at' : ''}, st.err)
}
${RS_LEX_FN}/// Lexes src into toks, replacing what it held and keeping its capacity (a reused builder's buffer);
/// the lexer error, if any.
fn lex_into<'a>(src: &'a str, toks: &mut Vec<Tok>, stk: &mut LexStacks) -> Option<LexErr> {
    toks.clear();
    let r = lex_from(src, 0, false, ${rx ? `0, 0, 0, false, false, ${p.takeStk('paren_head')}, false, false, ` : ''}${p.takeStk('template_stack')}, false, 0, 0, 0, ${raw ? 'Vec::new(), ' : ''}toks, 0);
    ${rx ? 'stk.paren_head = r.7; ' : ''}stk.template_stack = r.${rx ? 10 : 2};
    r.${(rx ? 15 : 7) + (raw ? 1 : 0)}
}`;
}

// Newline mode: every line break outside flow delimiters is a NEWLINE token spanning the break.
function newlinePartsRs(nl: NewlineCfg, ids: LexIdPlan): { consts: string; fields: string; init: string; ws: string; hooks: string; wsFrom: string; hooksFrom: string } {
  // Byte-oriented: ASCII ws by lead byte; non-ASCII via UTF-8 decode (JS \\s set).
  // LS/PS excluded: they fall to the unexpected-character panic, matching the interpreter.
  const ws = (push: string) => `        if c == 32 || c == 9 || c == 11 || c == 12 { pos += 1; while pos < n && matches!(b[pos], 9 | 11 | 12 | 32) { pos += 1; } continue; }
        if c == 10 || c == 13 {
            let s = pos;
            pos += 1; if c == 13 && pos < n && b[pos] == 10 { pos += 1; }
            if st.flow_depth == 0 { st.${push}(s, pos, _KID_NLTOK, 0); }
            st.pending_nl = true;
            continue;
        }
        if c >= 0xC2 { if let Some((ch, w)) = _char_at(src, pos) { if _is_js_ws(ch) && ch != '\\u{2028}' && ch != '\\u{2029}' { pos += w; continue; } } }
`;
  return {
    consts: `const _KID_NLTOK: u16 = ${kidOf(ids, nl.token)};
static _FLOW_D: [i8; ${ids.lids.length}] = [${lidDeltaTable(ids, nl.flowOpen, nl.flowClose).join(', ')}];
`,
    fields: 'flow_depth: i64',
    init: 'flow_depth: 0',
    ws: ws('emit'),
    wsFrom: ws('push_tok'),
    hooks: `        if kid == 0 { let d = ${rsFlag('_FLOW_D', 'lid')}; if d != 0 { self.flow_depth = (self.flow_depth + d as i64).max(0); } }
`,
    hooksFrom: `        if kid == 0 { let d = ${rsFlag('_FLOW_D', 'lid')}; if d != 0 { flow_depth = (flow_depth + d as i64).max(0); } }
`,
  };
}

/** uni-ident.ts's identifier classes, its lookup, and the code point at a char boundary.
 *  Rust's std has `is_alphanumeric` but no ID_Start / ID_Continue query, hence the table. */
function rsUniIdentTables(): string {
  const p = uniIdentPlan();
  // In range by construction: every index the plan's lookup forms is inside its string.
  const l = uniLookup(p, (k) => `(unsafe { *_UNI_T.get_unchecked(${k} as usize) } as u32)`);
  return `static _UNI_T: &[u8; ${p.data.length}] = b"${p.data.replace(/\\/g, '\\\\')}";
// uni-ident.ts's class of cp: 0 neither, 1 IdentifierPart only, 2 IdentifierStart too.
#[inline(always)] fn _uni_class(cp: u32) -> u32 {
    if cp < ${p.flatLen} { return ${l.flat}; }
    if ${l.top} >= ${p.topLen} { return 0; }
    let mut i: u32;
${l.steps.map((e) => `    i = ${e};\n    if i < ${l.uniform} { return i; }\n`).join('')}    ${l.result}
}
// The code point starting at byte e of valid UTF-8, and its width; a byte inside a
// character (e is no boundary) is no code point (0x110000, in neither class).
#[inline(always)] fn _lx_cp(b: &[u8], e: usize) -> (u32, usize) {
    let c = b[e] as u32;
    if c < 0xC0 { return (if c < 0x80 { c } else { 0x110000 }, 1); }
    if c < 0xE0 { return ((c & 0x1F) << 6 | (b[e + 1] & 0x3F) as u32, 2); }
    if c < 0xF0 { return ((c & 0x0F) << 12 | ((b[e + 1] & 0x3F) as u32) << 6 | (b[e + 2] & 0x3F) as u32, 3); }
    ((c & 0x07) << 18 | ((b[e + 1] & 0x3F) as u32) << 12 | ((b[e + 2] & 0x3F) as u32) << 6 | (b[e + 3] & 0x3F) as u32, 4)
}
`;
}

/** Exact-size lid/kid flag tables as `static` (single .rodata copy; avoid const duplication). */
function rsBoolArr(name: string, flags: boolean[]): string {
  return `static ${name}: [bool; ${flags.length}] = [${flags.map((b) => (b ? 'true' : 'false')).join(', ')}];`;
}
/** Bounds-check-free flag load (table len == plan lids/kids len; ids always in range). */
const rsFlag = (table: string, idExpr: string) =>
  `(unsafe { *${table}.get_unchecked(${idExpr} as usize) })`;
/** Small lid-set membership as integer OR-chain (avoids every-token table load for tiny sets). */
function rsLidAny(ids: LexIdPlan, texts: readonly string[], idExpr: string): string {
  const ls = [...new Set(texts.map((t) => lidOf(ids, t)).filter((i) => i > 0))];
  if (ls.length === 0) return 'false';
  return ls.map((l) => `${idExpr} == ${l}`).join(' || ');
}

function lexer(ir: ParserIR, ids: LexIdPlan, shared: SharedAlgorithms): string {
  const scanFns = shared.lexScan(ir);
  const scans = scanFns ? scanFns + '\n' : '';
  const rx = ir.regexCtx;
  const tpl = ir.tpl;
  const nl = ir.newlineCfg;
  const nlRs = nl ? newlinePartsRs(nl, ids) : null;
  const rxOnly = !!(rx && !tpl && !nl);
  const tplOnly = !!(tpl && !rx && !nl);
  const rxTpl = !!(rx && tpl && !nl);
  const rxOrTpl = !!(rx || tpl) && !rxOnly && !tplOnly && !rxTpl;
  const el = ir.elements;
  const stateful = !!(rx || tpl || el);
  const newlineOnly = !!(nl && !rx && !tpl);
  const nlVar = stateful ? 'st.pending_nl' : 'pending_nl';
  const errAt = el ? 'st.err' : 'err';
  // Byte-class dispatch folds whitespace/newline/template-open into the match's jump table so
  // the hot loop does one load + one match, instead of a chain of pre-checks per byte. Newline-mode
  // grammars keep the flow-aware whitespace arms (flow_depth) and do NOT use the folded arms.
  const identKid0 = ir.identToken ? kidOf(ids, ir.identToken) : 0;
  const identTok0 = ir.tokens.find((t) => t.name === ir.identToken);
  const identLid0 = identTok0 ? lidCall(shared.tokenLiterals(ir, identTok0, ids.lids.slice(1)), '&b[pos..e]') : 'lid_of(&b[pos..e])';
  const nonAsciiColdCall = `        let (e, k) = _lex_non_ascii(src, pos);
        if k == 2 { ${stateful ? `st.emit(pos, e, ${identKid0}, ${identLid0});` : `toks.push(mk_tok(pos, e, pending_nl, ${identKid0}, ${identLid0})); pending_nl = false;`} } else if k == 1 { ${nlVar} = true; } else if k == 3 { ${rsFail(errAt, '0', 'pos as isize', 'pos as isize')} }
        pos = e; continue;
`;
  const nonAsciiWsCheck = nlRs ? '' : `        if c >= 0xC2 { if let Some((ch, w)) = _char_at(src, pos) { if _is_js_ws(ch) { if ch == '\\u{2028}' || ch == '\\u{2029}' { ${nlVar} = true; } pos += w; continue; } } }
`;
  // A whitespace run is consumed in one dispatch round: per byte only "is it still whitespace"
  // is asked; the round's own checks (the loop bound, the template `}` test, the byte match) run
  // once per run. A run after a line break also takes further breaks: the flag is already set.
  const wsNlArms = nlRs ? '' : `        9 | 11 | 12 | 32 => { pos += 1; while pos < n && matches!(b[pos], 9 | 11 | 12 | 32) { pos += 1; } continue; }
        10 | 13 => { ${nlVar} = true; pos += 1; while pos < n && matches!(b[pos], 9..=13 | 32) { pos += 1; } continue; }
`;
  const tplOpenByte = tpl && tlen(tpl.open) === 1 ? firstUnit(tpl.open, UNITS) : null;
  const tplLits = shared.templateLiterals(ir, ids.lids.slice(1));
  const tplOpenArm = tplOpenByte !== null ? `        ${tplOpenByte} => {
            let (interp, e) = _scan_tpl_span(src, pos + ${tlen(tpl!.open)}, ${rx ? '!st.prev_is_value()' : 'true'}); if e < 0 { ${errAt} = Some(_lex_tpl_err(e, n)); pos = n; continue; } let e = e as usize;
            if interp { st.emit(pos, e, ${kidOf(ids, "$templateHead")}, ${lidCall(tplLits.head, '&b[pos..e]')}); st.template_stack.push(0); } else { st.emit(pos, e, ${kidOf(ids, tpl!.token)}, ${lidCall(tplLits.whole, '&b[pos..e]')}); }
            pos = e; continue;
        }
` : '';
  const tplOpenPreCheck = tpl && tplOpenByte === null ? `        if ${startByteEq('pos', tpl.open)} {
            let (interp, e) = _scan_tpl_span(src, pos + ${tlen(tpl.open)}, ${rx ? '!st.prev_is_value()' : 'true'}); if e < 0 { ${errAt} = Some(_lex_tpl_err(e, n)); pos = n; continue; } let e = e as usize;
            if interp { st.emit(pos, e, ${kidOf(ids, "$templateHead")}, ${lidCall(tplLits.head, '&b[pos..e]')}); st.template_stack.push(0); } else { st.emit(pos, e, ${kidOf(ids, tpl.token)}, ${lidCall(tplLits.whole, '&b[pos..e]')}); }
            pos = e; continue;
        }
` : '';
  // The template `}` test can pass only at the closer's first byte: when that byte is ASCII it is
  // made in that byte's dispatch arm, before the arm's own candidates, not in every round.
  const closeFirst = tpl ? firstUnit(tpl.interpClose, UNITS) : -1;
  const specialBytes = [...(nlRs ? [] : [9, 10, 11, 12, 13, 32]), ...(tplOpenByte !== null ? [tplOpenByte] : [])];
  const closeByte = tpl && closeFirst < 128 && !specialBytes.includes(closeFirst) ? closeFirst : null;
  const tplCloseTest = tpl ? `        if !st.template_stack.is_empty() && ${startByteEq('pos', tpl.interpClose)} && *st.template_stack.last().unwrap() == 0 {
            st.template_stack.pop();
            let (interp, e) = _scan_tpl_span(src, pos + ${tlen(tpl.interpClose)}, false); if e < 0 { ${errAt} = Some(_lex_tpl_err(e, n)); pos = n; continue; } let e = e as usize;
            if interp { st.emit(pos, e, ${kidOf(ids, "$templateMiddle")}, ${lidCall(tplLits.middle, '&b[pos..e]')}); st.template_stack.push(0); } else { st.emit(pos, e, ${kidOf(ids, "$templateTail")}, ${lidCall(tplLits.tail, '&b[pos..e]')}); }
            pos = e; continue;
        }
` : '';
  const tplDispatch = tpl ? `${closeByte === null ? tplCloseTest : ''}${tplOpenPreCheck}` : '';
  const punctLine = (p: string) =>
    `        if ${startByteEq('pos', p)} { ${stateful ? `st.emit(pos, pos + ${tlen(p)}, 0, ${lidOf(ids, p)});` : `toks.push(mk_tok(pos, pos + ${tlen(p)}, pending_nl, 0, ${lidOf(ids, p)})); pending_nl = false;`} pos += ${tlen(p)}; continue; }`;
  const { codes: lexCodes, firsts: lexFirsts } = buildLexCandidates(ir, shared, stateful, ids, rx?.regexToken, punctLine, errAt);
  // Where no candidate can begin at a non-ASCII byte, the byte is whitespace, an identifier or an
  // error: one cold call decides, so the dispatch loop holds no Unicode code (register layout).
  const nonAsciiCold = !nlRs && !!ir.identToken && buildLexDispatchPlan(lexFirsts).fallbackIndices.length === 0;
  const cascade = renderLexByteDispatchRust(lexCodes, lexFirsts, '        ', `${wsNlArms}${tplOpenArm}`, nonAsciiCold ? nonAsciiColdCall : nonAsciiWsCheck,
    closeByte !== null ? { byte: closeByte, code: tplCloseTest } : null);
  // Struct fields / emit hooks / init are assembled per-feature so a grammar can have regex,
  // templates, or both share one LexState. Rx bookkeeping is fully integerized (lid/kid bit tables).
  const rxBitTables = rx ? `${rsBoolArr('_DIVT', lidFlagTable(ids, rx.divisionTexts))}
${rsBoolArr('_DIVK', kidFlagTable(ids, rx.divisionTypes))}
${rsBoolArr('_RXT', lidFlagTable(ids, rx.regexTexts))}
${rsBoolArr('_PHK', lidFlagTable(ids, rx.parenHeadKw))}
${rsBoolArr('_MEM', lidFlagTable(ids, rx.memberAccess))}
${rsBoolArr('_PAV', lidFlagTable(ids, rx.postfixAfterValue))}
const _KID_IDENT: u16 = ${kidOf(ids, rx.identToken)};
const _LID_LPAREN: u16 = ${lidOf(ids, '(')};
const _LID_RPAREN: u16 = ${lidOf(ids, ')')};
` : '';
  const tplLidConsts = tpl ? `const _LID_BRACE_OPEN: u16 = ${lidOf(ids, tpl.braceOpen)};
const _LID_INTERP_CLOSE: u16 = ${lidOf(ids, tpl.interpClose)};
` : '';
  const identName = ir.identToken;
  const identKid = identName ? kidOf(ids, identName) : 0;
  const uniClassRs = shared.uniClass();
  const identTok = ir.tokens.find((t) => t.name === identName);
  const identLid = identTok ? lidCall(shared.tokenLiterals(ir, identTok, ids.lids.slice(1)), '&b[pos..e]') : 'lid_of(&b[pos..e])';
  // Unicode ID_Start fallback (mirrors emit-lexer uniIdentReY) before unmatched-byte panic.
  const uniIdentEmit = stateful
    ? `st.emit(pos, e, ${identKid}, ${identLid});`
    : `toks.push(mk_tok(pos, e, pending_nl, ${identKid}, ${identLid})); pending_nl = false;`;
  const uniIdentOrPanic = identName && !nonAsciiCold
    ? `        if c >= 0x80 { if let Some(e) = _scan_uni_ident(b, pos) { ${uniIdentEmit} pos = e; continue; } }
${rsUnexpected(errAt)}`
    : rsUnexpected(errAt);
  // The source is a &str, so the character at a position is std's own decode of it: one boundary
  // check and the character's bytes, none past it. None where pos is no character boundary.
  const lexUtf8Helpers = `${shared.scannedTokens(ir).some((t) => t.skip) ? RS_HAS_LINE_TERM : ''}#[inline(always)] fn _char_at(s: &str, pos: usize) -> Option<(char, usize)> {
    let ch = s.get(pos..)?.chars().next()?;
    Some((ch, ch.len_utf8()))
}
#[inline(always)] fn _is_js_ws(ch: char) -> bool {
    matches!(ch, '\\u{00A0}' | '\\u{1680}' | '\\u{2028}' | '\\u{2029}' | '\\u{202F}' | '\\u{205F}' | '\\u{3000}' | '\\u{FEFF}')
        || { let u = ch as u32; (0x2000..=0x200A).contains(&u) }
}
${identName || ir.identLike.length ? `${rsUniIdentTables()}// Both out of line: inlined into the dispatch loop they cost every ASCII token (register layout).
#[inline(never)] fn _scan_uni_ident(b: &[u8], pos: usize) -> Option<usize> {
    let (cp, w) = _lx_cp(b, pos);
    if _uni_class(cp) != 2 { return None; }
    Some(_lx_ext(b, pos + w))
}
// Extend an identifier token that the ASCII pattern cut short at a non-ASCII
// ID_Continue char (caf|é → café), mirroring emit-lexer's uniIdentContReY extension.
// A non-ASCII byte no candidate begins with: (end, 0) whitespace, (end, 1) a line-terminating
// whitespace, (end, 2) an identifier; (pos, 3) the unexpected-character error.
#[cold] #[inline(never)] fn _lex_non_ascii(src: &str, pos: usize) -> (usize, u8) {
    if let Some((ch, w)) = _char_at(src, pos) { if _is_js_ws(ch) { return (pos + w, (ch == '\\u{2028}' || ch == '\\u{2029}') as u8); } }
    if let Some(e) = _scan_uni_ident(src.as_bytes(), pos) { return (e, 2); }
    (pos, 3)
}
#[inline(always)] fn ${uniClassRs}(cp: isize) -> isize { _uni_class(cp as u32) as isize }
#[inline(never)] fn _lx_ext(b: &[u8], mut e: usize) -> usize {
    while e < b.len() {
        let (cp, w) = _lx_cp(b, e);
        if _uni_class(cp) == 0 { break; }
        e += w;
    }
    e
}
` : ''}`;
  const rxConsts = `${RS_LEX_ERR}${lexUtf8Helpers}${rxBitTables}${tplLidConsts}${nlRs ? nlRs.consts : ''}`;
  const pavHot = rx ? rsLidAny(ids, rx.postfixAfterValue, 'lid') : 'false';
  // The span itself is the shared family's scanner; this reads which delimiter ended it.
  // (interp, end), or the span's lexer error: (false, q) with q < 0 (_lex_tpl_err).
  const tplFn = tpl ? `fn _scan_tpl_span(s: &str, p: usize, strict: bool) -> (bool, isize) {
    let q = ${shared.tplSpan()}(s, p as isize, strict);
    if q < 0 { return (false, q); }
    if s.as_bytes()[q as usize..].starts_with(${J(tpl.interpOpen)}.as_bytes()) { return (true, q + ${tlen(tpl.interpOpen)}); }
    (false, q + ${tlen(tpl.open)})
}
` : '';
  const fields = ['toks: Vec<Tok>', 'pending_nl: bool',
    rx ? 'base: usize, prev0: (bool, u16, u16), bp0: (bool, u16), kid1: u16, lid1: u16, lid2: u16, paren_head: Vec<bool>, last_close: bool, last_bang: bool' : '',
    tpl ? 'template_stack: Vec<i64>' : '',
    nlRs ? nlRs.fields : ''].filter(Boolean).join(', ');
  // Force-inline bookkeeping into the lex cascade. Under rustc -O (no LTO), leaving
  // emit/prev_is_value as outlined calls flips full-parse I-cache layout so lex gains
  // reverse into a parse regress; LTO / codegen-units=1 hide it — #[inline(always)] fixes -O.
  const inlAlways = '    #[inline(always)]\n';
  const prevIsValue = rx ? `${inlAlways}    /// The previous token: (present, kid, lid). The tokens are their own record: the last one this
    /// lex recorded, else the one before it began (prev0).
    fn prev(&self) -> (bool, u16, u16) {
        let n = self.toks.len();
        (n > self.base || self.prev0.0, self.kid1, self.lid1)
    }
${inlAlways}    /// The token before the previous one: (present, lid).
    fn prev2(&self) -> (bool, u16) {
        let n = self.toks.len();
        (n > self.base + 1 || (n == self.base + 1 && self.prev0.0) || (n == self.base && self.bp0.0), self.lid2)
    }
${inlAlways}    fn prev_is_value(&self) -> bool {
        let (has_prev, prev_kid, prev_lid) = self.prev();
        if !has_prev { return false; }
        if ${rsFlag('_PAV', 'prev_lid')} { return self.last_bang; }
        let is_expr_kw = prev_kid == _KID_IDENT && ${rsFlag('_RXT', 'prev_lid')} && { let (has_prev2, bp_lid) = self.prev2(); !(has_prev2 && ${rsFlag('_MEM', 'bp_lid')}) };
        let is_paren_head = prev_lid == _LID_RPAREN && self.last_close;
        !is_expr_kw && !is_paren_head && (${rsFlag('_DIVK', 'prev_kid')} || ${rsFlag('_DIVT', 'prev_lid')})
    }
` : '';
  const emitHooks = [
    rx ? `        if lid == _LID_LPAREN { let (has_prev2, bp_lid) = self.prev2(); let (_, prev_kid, prev_lid) = self.prev(); let is_member = has_prev2 && ${rsFlag('_MEM', 'bp_lid')}; self.paren_head.push(!is_member && prev_kid == _KID_IDENT && ${rsFlag('_PHK', 'prev_lid')}); }
        else if lid == _LID_RPAREN { self.last_close = self.paren_head.pop().unwrap_or(false); }
        if ${pavHot} { self.last_bang = self.prev_is_value(); }` : '',
    tpl ? `        if !self.template_stack.is_empty() { if lid == _LID_BRACE_OPEN { *self.template_stack.last_mut().unwrap() += 1; } else if lid == _LID_INTERP_CLOSE { *self.template_stack.last_mut().unwrap() -= 1; } }` : '',
    nlRs ? nlRs.hooks : '',
  ].filter(Boolean).join('\n');
  const emitTail = rx ? ` self.lid2 = self.lid1; self.kid1 = kid; self.lid1 = lid;` : '';
  const stateImpl = stateful ? `struct LexState { ${fields} }
impl LexState {
${prevIsValue}${inlAlways}    fn emit(&mut self, off: usize, end: usize, kid: u16, lid: u16) {
${emitHooks}
        self.toks.push(mk_tok(off, end, self.pending_nl, kid, lid)); self.pending_nl = false;${emitTail}
    }
}
` : '';
  const rxScanImpl = rxOnly ? `struct RxScan<'a> { acc: &'a mut Vec<Tok>, pending_nl: bool, base: usize, prev0: (bool, u16, u16), bp0: (bool, u16), kid1: u16, lid1: u16, lid2: u16, paren_head: Vec<bool>, last_close: bool, last_bang: bool }
impl<'a> RxScan<'a> {
${inlAlways}    /// The previous token: (present, kid, lid). The tokens are their own record: the last one this
    /// lex recorded, else the one before it began (prev0).
    fn prev(&self) -> (bool, u16, u16) {
        let n = self.acc.len();
        (n > self.base || self.prev0.0, self.kid1, self.lid1)
    }
${inlAlways}    /// The token before the previous one: (present, lid).
    fn prev2(&self) -> (bool, u16) {
        let n = self.acc.len();
        (n > self.base + 1 || (n == self.base + 1 && self.prev0.0) || (n == self.base && self.bp0.0), self.lid2)
    }
${inlAlways}    fn prev_is_value(&self) -> bool {
        let (has_prev, prev_kid, prev_lid) = self.prev();
        if !has_prev { return false; }
        if ${rsFlag('_PAV', 'prev_lid')} { return self.last_bang; }
        let is_expr_kw = prev_kid == _KID_IDENT && ${rsFlag('_RXT', 'prev_lid')} && { let (has_prev2, bp_lid) = self.prev2(); !(has_prev2 && ${rsFlag('_MEM', 'bp_lid')}) };
        let is_paren_head = prev_lid == _LID_RPAREN && self.last_close;
        !is_expr_kw && !is_paren_head && (${rsFlag('_DIVK', 'prev_kid')} || ${rsFlag('_DIVT', 'prev_lid')})
    }
${inlAlways}    fn emit(&mut self, off: usize, end: usize, kid: u16, lid: u16) {
        if lid == _LID_LPAREN { let (has_prev2, bp_lid) = self.prev2(); let (_, prev_kid, prev_lid) = self.prev(); let is_member = has_prev2 && ${rsFlag('_MEM', 'bp_lid')}; self.paren_head.push(!is_member && prev_kid == _KID_IDENT && ${rsFlag('_PHK', 'prev_lid')}); }
        else if lid == _LID_RPAREN { self.last_close = self.paren_head.pop().unwrap_or(false); }
        if ${pavHot} { self.last_bang = self.prev_is_value(); }
        self.acc.push(mk_tok(off, end, self.pending_nl, kid, lid)); self.pending_nl = false; self.lid2 = self.lid1; self.kid1 = kid; self.lid1 = lid;
    }
}
` : '';
  const tplScanImpl = tplOnly ? `struct TplScan<'a> { acc: &'a mut Vec<Tok>, pending_nl: bool, template_stack: Vec<i64> }
impl<'a> TplScan<'a> {
${inlAlways}    fn emit(&mut self, off: usize, end: usize, kid: u16, lid: u16) {
        if !self.template_stack.is_empty() { if lid == _LID_BRACE_OPEN { *self.template_stack.last_mut().unwrap() += 1; } else if lid == _LID_INTERP_CLOSE { *self.template_stack.last_mut().unwrap() -= 1; } }
        self.acc.push(mk_tok(off, end, self.pending_nl, kid, lid)); self.pending_nl = false;
    }
}
` : '';
  const rxTplScanImpl = rxTpl ? `struct RxTplScan<'a> { acc: &'a mut Vec<Tok>, pending_nl: bool, base: usize, prev0: (bool, u16, u16), bp0: (bool, u16), kid1: u16, lid1: u16, lid2: u16, paren_head: Vec<bool>, last_close: bool, last_bang: bool, template_stack: Vec<i64> }
impl<'a> RxTplScan<'a> {
${inlAlways}    /// The previous token: (present, kid, lid). The tokens are their own record: the last one this
    /// lex recorded, else the one before it began (prev0).
    fn prev(&self) -> (bool, u16, u16) {
        let n = self.acc.len();
        (n > self.base || self.prev0.0, self.kid1, self.lid1)
    }
${inlAlways}    /// The token before the previous one: (present, lid).
    fn prev2(&self) -> (bool, u16) {
        let n = self.acc.len();
        (n > self.base + 1 || (n == self.base + 1 && self.prev0.0) || (n == self.base && self.bp0.0), self.lid2)
    }
${inlAlways}    fn prev_is_value(&self) -> bool {
        let (has_prev, prev_kid, prev_lid) = self.prev();
        if !has_prev { return false; }
        if ${rsFlag('_PAV', 'prev_lid')} { return self.last_bang; }
        let is_expr_kw = prev_kid == _KID_IDENT && ${rsFlag('_RXT', 'prev_lid')} && { let (has_prev2, bp_lid) = self.prev2(); !(has_prev2 && ${rsFlag('_MEM', 'bp_lid')}) };
        let is_paren_head = prev_lid == _LID_RPAREN && self.last_close;
        !is_expr_kw && !is_paren_head && (${rsFlag('_DIVK', 'prev_kid')} || ${rsFlag('_DIVT', 'prev_lid')})
    }
${inlAlways}    fn emit(&mut self, off: usize, end: usize, kid: u16, lid: u16) {
        if lid == _LID_LPAREN { let (has_prev2, bp_lid) = self.prev2(); let (_, prev_kid, prev_lid) = self.prev(); let is_member = has_prev2 && ${rsFlag('_MEM', 'bp_lid')}; self.paren_head.push(!is_member && prev_kid == _KID_IDENT && ${rsFlag('_PHK', 'prev_lid')}); }
        else if lid == _LID_RPAREN { self.last_close = self.paren_head.pop().unwrap_or(false); }
        if ${pavHot} { self.last_bang = self.prev_is_value(); }
        if !self.template_stack.is_empty() { if lid == _LID_BRACE_OPEN { *self.template_stack.last_mut().unwrap() += 1; } else if lid == _LID_INTERP_CLOSE { *self.template_stack.last_mut().unwrap() -= 1; } }
        self.acc.push(mk_tok(off, end, self.pending_nl, kid, lid)); self.pending_nl = false; self.lid2 = self.lid1; self.kid1 = kid; self.lid1 = lid;
    }
}
` : '';
  // The lexer's bracket-head and template-depth stacks, bounded by nesting depth. lex_into takes
  // them from a LexStacks the caller keeps (a reused builder's Workspace), so a later lex reuses
  // their capacity instead of allocating them again; each lex starts them empty. They travel
  // through lex_from by value: kept in the scan's own struct, the hot emit path keeps them in
  // registers, which a by-reference field costs about 14 instructions per token (Callgrind, CI:
  // checker.ts lex 79.9M by value vs 84.7M by reference). A lexer error is returned, so they come
  // back after one too.
  const stkFields = [rx ? 'paren_head: Vec<bool>' : '', tpl || el ? 'template_stack: Vec<i64>' : ''].filter(Boolean);
  const lexStacks = `/// The lexer's transient stacks (bracket heads, template depths), kept across lexes by a reused builder.
#[derive(Default)]
struct LexStacks {${stkFields.length ? ` ${stkFields.join(', ')} ` : ''}}
`;
  const stkParam = stkFields.length ? 'stk' : '_stk';
  const takeStk = (f: string) => `{ let mut v = std::mem::take(&mut stk.${f}); v.clear(); v }`;
  const initFields = ['toks: Vec::new()', 'pending_nl: false',
    rx ? `base: 0, prev0: (false, 0, 0), bp0: (false, 0), kid1: 0, lid1: 0, lid2: 0, paren_head: ${takeStk('paren_head')}, last_close: false, last_bang: false` : '',
    tpl ? `template_stack: ${takeStk('template_stack')}` : '',
    nlRs ? nlRs.init : ''].filter(Boolean).join(', ');
  const open = stateful ? `    let mut st = LexState { ${initFields} };` : `    let mut toks: Vec<Tok> = Vec::new();\n    let mut pending_nl = false;`;
  const nlWs = nlRs ? nlRs.ws : '';
  const loopBody = `        let c = b[pos] as u32;
${nlWs}${tplDispatch}${cascade}
${uniIdentOrPanic}`;
  if (el) {
    return elementLexerRust(ir, ids, shared, {
      head: `${renderIdTablesRust(ids)}${rxConsts}`, scans, tplFn, lexCodes, lexFirsts, specialArms: `${wsNlArms}${tplOpenArm}`,
      nonAscii: nonAsciiCold ? nonAsciiColdCall : nonAsciiWsCheck, tplCloseTest, tplOpenPreCheck, closeByte, uniIdentOrPanic, pavHot, lexStacks, takeStk,
    });
  }
  if (rxOnly) {
    const rxLoopBody = `        let c = b[pos] as u32;
${nlWs}${cascade}
${uniIdentOrPanic}`;
    return `${renderIdTablesRust(ids)}${lexStacks}${scans}${rxConsts}${tplFn}${rxScanImpl}${LEX_FROM_ATTR}fn lex_from<'a>(src: &'a str, mut pos: usize, mut pending_nl: bool, prev_lid: u16, prev_kid: u16, bp_lid: u16, has_prev: bool, has_prev2: bool, mut paren_head: Vec<bool>, mut last_close: bool, mut last_bang: bool, acc: &mut Vec<Tok>, limit: usize) -> (usize, bool, u16, u16, u16, bool, bool, Vec<bool>, bool, bool, Option<LexErr>) {
    let b = src.as_bytes();
    let n = b.len();
    let base = acc.len();
    let mut err: Option<LexErr> = None;
    let mut st = RxScan { acc, pending_nl, base, prev0: (has_prev, prev_kid, prev_lid), bp0: (has_prev2, bp_lid), kid1: prev_kid, lid1: prev_lid, lid2: bp_lid, paren_head, last_close, last_bang };
    while pos < n && (limit == 0 || st.acc.len() - base < limit) {
${rxLoopBody}
    }
    let ((has_prev, prev_kid, prev_lid), (has_prev2, bp_lid)) = (st.prev(), st.prev2());
    (pos, st.pending_nl, prev_lid, prev_kid, bp_lid, has_prev, has_prev2, st.paren_head, st.last_close, st.last_bang, err)
}
${RS_LEX_FN}/// Lexes src into toks, replacing what it held and keeping its capacity (a reused builder's buffer);
/// the lexer error, if any.
fn lex_into<'a>(src: &'a str, toks: &mut Vec<Tok>, ${stkParam}: &mut LexStacks) -> Option<LexErr> {
    toks.clear();
    let r = lex_from(src, 0, false, 0, 0, 0, false, false, ${takeStk('paren_head')}, false, false, toks, 0);
    stk.paren_head = r.7;
    r.10
}`;
  }
  if (tplOnly) {
    return `${renderIdTablesRust(ids)}${lexStacks}${scans}${rxConsts}${tplFn}${tplScanImpl}${LEX_FROM_ATTR}fn lex_from<'a>(src: &'a str, mut pos: usize, mut pending_nl: bool, template_stack: Vec<i64>, acc: &mut Vec<Tok>, limit: usize) -> (usize, bool, Vec<i64>, Option<LexErr>) {
    let b = src.as_bytes();
    let n = b.len();
    let base = acc.len();
    let mut err: Option<LexErr> = None;
    let mut st = TplScan { acc, pending_nl, template_stack };
    while pos < n && (limit == 0 || st.acc.len() - base < limit) {
${loopBody}
    }
    (pos, st.pending_nl, st.template_stack, err)
}
${RS_LEX_FN}/// Lexes src into toks, replacing what it held and keeping its capacity (a reused builder's buffer);
/// the lexer error, if any.
fn lex_into<'a>(src: &'a str, toks: &mut Vec<Tok>, ${stkParam}: &mut LexStacks) -> Option<LexErr> {
    toks.clear();
    let r = lex_from(src, 0, false, ${takeStk('template_stack')}, toks, 0);
    stk.template_stack = r.2;
    r.3
}`;
  }
  if (rxTpl) {
    return `${renderIdTablesRust(ids)}${lexStacks}${scans}${rxConsts}${tplFn}${rxTplScanImpl}${LEX_FROM_ATTR}fn lex_from<'a>(src: &'a str, mut pos: usize, mut pending_nl: bool, prev_lid: u16, prev_kid: u16, bp_lid: u16, has_prev: bool, has_prev2: bool, mut paren_head: Vec<bool>, mut last_close: bool, mut last_bang: bool, template_stack: Vec<i64>, acc: &mut Vec<Tok>, limit: usize) -> (usize, bool, u16, u16, u16, bool, bool, Vec<bool>, bool, bool, Vec<i64>, Option<LexErr>) {
    let b = src.as_bytes();
    let n = b.len();
    let base = acc.len();
    let mut err: Option<LexErr> = None;
    let mut st = RxTplScan { acc, pending_nl, base, prev0: (has_prev, prev_kid, prev_lid), bp0: (has_prev2, bp_lid), kid1: prev_kid, lid1: prev_lid, lid2: bp_lid, paren_head, last_close, last_bang, template_stack };
    while pos < n && (limit == 0 || st.acc.len() - base < limit) {
${loopBody}
    }
    let ((has_prev, prev_kid, prev_lid), (has_prev2, bp_lid)) = (st.prev(), st.prev2());
    (pos, st.pending_nl, prev_lid, prev_kid, bp_lid, has_prev, has_prev2, st.paren_head, st.last_close, st.last_bang, st.template_stack, err)
}
${RS_LEX_FN}/// Lexes src into toks, replacing what it held and keeping its capacity (a reused builder's buffer);
/// the lexer error, if any.
fn lex_into<'a>(src: &'a str, toks: &mut Vec<Tok>, ${stkParam}: &mut LexStacks) -> Option<LexErr> {
    toks.clear();
    let r = lex_from(src, 0, false, 0, 0, 0, false, false, ${takeStk('paren_head')}, false, false, ${takeStk('template_stack')}, toks, 0);
    stk.paren_head = r.7; stk.template_stack = r.10;
    r.11
}`;
  }
  if (rxOrTpl) {
    return `${renderIdTablesRust(ids)}${lexStacks}${scans}${rxConsts}${tplFn}${stateImpl}${RS_LEX_FN}/// Lexes src into out, replacing what it held and keeping its capacity (a reused builder's buffer);
/// the lexer error, if any.
fn lex_into<'a>(src: &'a str, out: &mut Vec<Tok>, ${stkParam}: &mut LexStacks) -> Option<LexErr> {
    out.clear();
    let b = src.as_bytes();
    let n = b.len();
${open.replace('toks: Vec::new()', 'toks: std::mem::take(out)')}
    let mut pos = 0usize;
    let mut err: Option<LexErr> = None;
    while pos < n {
${loopBody}
    }
    *out = st.toks;${rx ? '\n    stk.paren_head = st.paren_head;' : ''}${tpl ? '\n    stk.template_stack = st.template_stack;' : ''}
    err
}`;
  }
  if (newlineOnly) {
    const rustNlScan = (s: string) => s
      .replace(/toks\.push\(mk_tok\(pos, ([^,]+), pending_nl, ([^,]+), (.+)\)\); ?/g, 'st.push_tok(pos, $1, $2, $3); ')
      .replace(/pending_nl/g, 'st.pending_nl');
    const nlUniIdentOrPanic = identName
      ? rustNlScan(uniIdentOrPanic)
      : rsUnexpected('err');
    const nlLoopBody = `        let c = b[pos] as u32;
${nlRs!.wsFrom}${rustNlScan(cascade)}
${nlUniIdentOrPanic}`;
    return `${renderIdTablesRust(ids)}${lexStacks}${scans}${rxConsts}${tplFn}struct NlScan<'a> { acc: &'a mut Vec<Tok>, pending_nl: bool, flow_depth: i64 }
impl<'a> NlScan<'a> {
    fn push_tok(&mut self, off: usize, end: usize, kid: u16, lid: u16) {
${nlRs!.hooksFrom.replace(/flow_depth/g, 'self.flow_depth')}
        self.acc.push(mk_tok(off, end, self.pending_nl, kid, lid)); self.pending_nl = false;
    }
}
${LEX_FROM_ATTR}fn lex_from<'a>(src: &'a str, mut pos: usize, pending_nl: bool, flow_depth: i64, acc: &mut Vec<Tok>, limit: usize) -> (usize, bool, i64, Option<LexErr>) {
    let b = src.as_bytes();
    let n = b.len();
    let base = acc.len();
    let mut err: Option<LexErr> = None;
    let mut st = NlScan { acc, pending_nl, flow_depth };
    while pos < n && (limit == 0 || st.acc.len() - base < limit) {
${nlLoopBody}
    }
    (pos, st.pending_nl, st.flow_depth, err)
}
${RS_LEX_FN}/// Lexes src into toks, replacing what it held and keeping its capacity (a reused builder's buffer);
/// the lexer error, if any.
fn lex_into<'a>(src: &'a str, toks: &mut Vec<Tok>, ${stkParam}: &mut LexStacks) -> Option<LexErr> {
    toks.clear();
    lex_from(src, 0, false, 0, toks, 0).3
}`;
  }
  return `${renderIdTablesRust(ids)}${lexStacks}${scans}${rxConsts}${tplFn}${LEX_FROM_ATTR}fn lex_from<'a>(src: &'a str, mut pos: usize, mut pending_nl: bool, acc: &mut Vec<Tok>, limit: usize) -> (usize, bool, Option<LexErr>) {
    let b = src.as_bytes();
    let n = b.len();
    let base = acc.len();
    let mut err: Option<LexErr> = None;
    while pos < n && (limit == 0 || acc.len() - base < limit) {
${loopBody.replace(/pending_nl/g, 'pending_nl').replace(/toks\.push/g, 'acc.push')}
    }
    (pos, pending_nl, err)
}
${RS_LEX_FN}/// Lexes src into toks, replacing what it held and keeping its capacity (a reused builder's buffer);
/// the lexer error, if any.
fn lex_into<'a>(src: &'a str, toks: &mut Vec<Tok>, ${stkParam}: &mut LexStacks) -> Option<LexErr> {
    toks.clear();
    lex_from(src, 0, false, toks, 0).2
}`;
}

// The step walk's Rust spelling (emit-portable.ts, StepLowering), over the receiver `recv`: `self`
// at a rule's top level (children accumulate on `self.scratch`), `p` inside a closure or a method
// that took `let p = self`; `r`: in recognize form (ParserIR.forms), advancing and building
// nothing. Rust: a body is a non-capturing closure `|p| …` (a `fn(&mut Parser<B>) -> bool`, so no
// environment is allocated), whose receiver is its own `p` (inner); a choice's statements are a
// closure called in place; a suppress / ctx body is a block expression.
function rsSteps(ids: LexIdPlan, recv: 'self' | 'p', r: boolean, guards = true): StepLowering {
  const R = r ? '_r' : '';
  const L: StepLowering = {
    inner: () => (recv === 'p' ? L : rsSteps(ids, 'p', r, guards)),
    shared: (id) => `${recv}.sub_${id}${R}()`,
    lit: (s) => (gtCompLit(ids, s) ? `${recv}.match_comp(${lidOf(ids, s.value)})` : `${recv}.match_lit${R}(${lidOf(ids, s.value)})`),
    tok: (name) => `${recv}.match_tok${R}(${kidOf(ids, name)})`,
    // Recognized, an interpolated template runs its building matcher and its node is dropped.
    template: (name, hole) => `(${recv}.match_tok${R}(${kidOf(ids, name)}) || ${r ? `${recv}.match_template(Parser::parse_${hole}).is_some()` : `${recv}.call_rule(|p| p.match_template(Parser::parse_${hole}))`})`,
    rule: (name) => (r ? `${recv}.rec_${name}()` : `${recv}.call_rule(Parser::parse_${name})`),
    // Recognized, a Pratt rule runs its building form and its node is dropped (ParserIR.forms).
    ruleBp: (name, bp) => (r ? `${recv}.${name}_bp(${bp}).is_some()` : `${recv}.call_rule(|p| p.${name}_bp(${bp}))`),
    // A body guard (emit-portable.ts annotateSteps): star tests it before each attempt inside an
    // out-of-line loop (`star_in`); opt / sep test it here and make their attempt out of line
    // (`opt_out` / `sep_by_out`). Both are `#[inline(never)]` and generic over the body, so each site
    // is one small function with its body inlined, and the function holding the step grows by a set
    // test and a call only. A measured codegen fact decides that spelling: with the attempt inline
    // (PR #169), or the guard inside a helper, LLVM allocated the registers of the large rule
    // functions differently (same executed branches, other spills: one identifier NUD 246 -> 256
    // instructions) and Rust parse instructions rose (dense-semi +4.96%; helpers: +0.3% to +4.5%).
    // Not inside Pratt arms (`guards` false, prattRule): Expr_nud, about 13k instructions, moved by
    // +9 to +13 per call wherever guarded code joined it (dense-plus +1.30% to +1.87%); without them
    // dense-plus is +0.43%. PR #184 has the variants and their profile runs. The guard only skips
    // attempts that cannot match, so leaving it out is sound.
    // A clean body (Step.clean) is attempted without a mark: the `_c` forms (no state to undo, so
    // star / opt have one form for building and recognizing).
    star: (body, g, c) => {
      const C = c ? '_c' : R;
      return g === null || !guards ? `${recv}.star${C}(|p| ${body})` : `${recv}.star_in${C}(${g}, |p| ${body})`;
    },
    opt: (body, g, c) => {
      const C = c ? '_c' : R;
      return g === null || !guards ? `${recv}.opt${C}(|p| ${body})` : `(!${recv}.ahead(${g}, true) || ${recv}.opt_out${C}(|p| ${body}))`;
    },
    sep: (elem, delim, g, c) => {
      const C = c ? `_c${R}` : R;
      return g === null || !guards ? `${recv}.sep_by${C}(|p| ${elem}, ${sepDelimLid(ids, delim)})` : `(!${recv}.ahead(${g}, true) || ${recv}.sep_by_out${C}(|p| ${elem}, ${sepDelimLid(ids, delim)}))`;
    },
    altlit: (values) => `${recv}.alt_lit${R}(&[${values.map((v) => lidOf(ids, v)).join(', ')}])`,
    look: (id, is) => `${is ? '' : '!'}${recv}.look_${id}()`,
    ahead: (set, is) => `${recv}.ahead(${set}, ${is})`,
    aheadCtx: (set, is) => (is ? `(${recv}.ahead(${set}, true) || ${recv}.ctx_word())` : `(${recv}.ahead(${set}, false) && !${recv}.ctx_word())`),
    sameLine: () => `matches!(${recv}.peek(), Some(t) if !t.nl)`,
    inPlace: (kind, stmts) => (kind === 'alt' ? `(|p: &mut Parser<'a, B>| -> bool { ${stmts} })(${recv})` : stmts),
    ret: (cond) => cond,
    suppress: (set, cond) => `{ ${recv}.suppress_next = ${set}; let _r = (${cond}); ${recv}.suppress_next = 0; _r }`,
    // The body is a boolean expression (no `?`, no return), so the context is put back on either outcome.
    ctx: (ctx, cond) => `{ let _c = ${recv}.ctx; ${recv}.ctx = ${ctx}; let _r = (${cond}); ${recv}.ctx = _c; _r }`,
    branch: (cond, clean) => branchRs(cond, r, clean),
    guarded: (first, branch) => `if let Some(t) = _ft { if ${firstCond(first, 't', ids)} ${branch} }`,
    choice: (peek, tries) => `${peek ? `let _ft = ${recv}.peek(); ` : ''}${tries.join(' ')} false`,
    // FIRST dispatch; restore pos/scratch/builder on arm half-failure (like a choice).
    predictive: (arms) => `let t = match ${recv}.peek() { Some(t) => t, None => return false };\n${arms.map((a, i) => `        ${i === 0 ? 'if' : 'else if'} ${firstCond(a.first, 't', ids)} ${a.branch}`).join('\n')}\n        false`,
  };
  return L;
}
const stepCond = (s: Step, ids: LexIdPlan, _ar: ArenaIdPlan): string => walkExpr(s, rsSteps(ids, 'self', false));
// Over `p`: a step inside a closure or a method that took `let p = self`. `r`: in recognize form.
const stepCondP = (s: Step, ids: LexIdPlan, _ar: ArenaIdPlan, r = false): string => walkExpr(s, rsSteps(ids, 'p', r));
// The step over `p` as the body of a function returning whether it matched.
const stepStmtsP = (s: Step, ids: LexIdPlan, _ar: ArenaIdPlan, r = false): string => walkStmts(s, rsSteps(ids, 'p', r));
// ParserIR.lookaheads, one method each, in recognize form (ParserIR.forms): whether the body
// matches here. It undoes the position, and the scratch list and the builder too when its body
// runs a Pratt rule's building form (Forms.lookBuilds).
function lookFns(ir: ParserIR, ids: LexIdPlan, ar: ArenaIdPlan): string {
  return ir.lookaheads.map((body, id) => {
    const builds = ir.forms.lookBuilds[id]!;
    return `    fn look_${id}(&mut self) -> bool { let p = self; ${builds ? ckptRs('p') : 'let sp = p.pos;'} let r = ${body.map((x) => stepCondP(x, ids, ar, true)).join(' && ')}; ${builds ? undoRs('p') : 'p.back(sp);'} r }\n`;
  }).join('');
}
// ParserIR.shared, one method per form it is printed in (ParserIR.forms): the step, run against
// the parser's scratch list and builder (recognized: neither). It undoes nothing: a failed step
// leaves what it advanced and appended for the construct around its site to undo, as the inlined
// step did. `#[inline]` is a hint only: a step printed at one site was a closure with one caller,
// which LLVM always inlines; a shared step has several callers, and the hint lets LLVM inline the
// small ones there (fewer instructions per parse than no hint, measured; `#[inline(always)]` is no
// better and inlines the large ones too).
function sharedFns(ir: ParserIR, ids: LexIdPlan, ar: ArenaIdPlan): string {
  return ir.shared.map((s, id) =>
    (ir.forms.buildShared[id] ? `    #[inline]\n    fn sub_${id}(&mut self) -> bool { let p = self; ${stepStmtsP(s, ids, ar)} }\n` : '') +
    (ir.forms.recognizeShared[id] ? `    #[inline]\n    fn sub_${id}_r(&mut self) -> bool { let p = self; ${stepStmtsP(s, ids, ar, true)} }\n` : '')).join('');
}

// The Rust spelling of an rd rule's shell (emit-portable.ts, ruleShell), common to its two forms;
// a guard reads the token bound by `if let Some(t)` (the buffered token is an Option).
const rsRuleBase = (ids: LexIdPlan, recv: string) => ({
  ind: '        ',
  ifThen: (test: string, then: string) => `if ${test} ${then}`,
  first: (f: FirstSig) => firstCond(f, 't', ids),
  armJoin: '\n',
  peekOpt: `        let _ft = ${recv}.peek();`,
  guard: (g: Guard, keyed: boolean, stmt: string) => {
    const c = guardCond(g, 't', keyed, recv);
    return c.length && !keyed ? `        if let Some(t) = _ft { if ${c.join(' && ')} ${stmt} }` : ifRs(c, stmt);
  },
  dispatch: dispatchRsL('_ft', true),
  // The commit switch runs before the frame, over `self` (the recognize form's frame takes `p`).
  commitPeek: '        let _ft = self.peek();',
  guardConds: (g: Guard) => guardCond(g, 't', false, 'self'),
  commitSw: commitSwRs,
});

// A rule in recognize form (ParserIR.forms): whether it matches here, advancing past it. An rd
// rule has rdRule's control flow building nothing: its longest match compares end positions only
// (a tie only chooses which node, and none is built). A Pratt rule runs its building form and
// drops the node (the lookahead around it undoes the builder: Forms.lookBuilds).
function ruleR(r: RuleIR, ids: LexIdPlan, ar: ArenaIdPlan): string {
  if (r.kind === 'pratt') return `    fn rec_${r.name}(&mut self) -> bool { self.parse_${r.name}().is_some() }`;
  return ruleShell(r, ids, {
    ...rsRuleBase(ids, 'p'),
    steps: rsSteps(ids, 'p', true),
    fn: (lines) => `    fn rec_${r.name}(&mut self) -> bool {\n${lines.join('\n')}\n    }`,
    accept: () => '{ return true; }',
    open: () => '        let p = self; let save = p.pos;',
    peekOrFail: '        let t = match p.peek() { Some(t) => t, None => return false };',
    fail: () => '        p.back(save);\n        false',
    openBest: () => '        let p = self; let save = p.pos; let mut best_pos = save;',
    cand: (_d, _i, cond) => `{ if ${cond} && p.pos > best_pos { best_pos = p.pos; } p.back(save); }`,
    closeBest: '        p.pos = best_pos;\n        best_pos > save',
    commitSteps: rsSteps(ids, 'self', true),
    commit: (_i, conds, cond, undo, nullable) => commitRs(conds, `{ ${undo ? 'let save = self.pos; ' : ''}if ${cond}${nullable ? ' && self.pos > save' : ''} { return true; }${undo ? ' self.back(save);' : ''} }`, 'return false;'),
    commitFail: '{ return false; }',
  });
}

// Longest match: the best node so far stays built: `ck` moves past it, so a later alternative
// that does not beat it is restored away and one that does leaves it unreferenced.
function rdRule(r: RdRule, ids: LexIdPlan, ar: ArenaIdPlan): string {
  const rid = ruleIdOf(ar, r.name);
  const sig = `    fn parse_${r.name}(&mut self) -> Option<Spanned<B::H>> {`;
  return ruleShell(r, ids, {
    ...rsRuleBase(ids, 'self'),
    steps: rsSteps(ids, 'self', false),
    fn: (lines) => `${sig}\n${lines.join('\n')}\n    }`,
    accept: () => `{ return Some(self.finish(${rid}, sb, self.off_at(save), save)); }`,
    open: (clean) => `        let save = self.pos; let sb = self.scratch.len();${clean ? '' : ' let ck = self.b.checkpoint();'}`,
    peekOrFail: '        let t = match self.peek() { Some(t) => t, None => return None };',
    fail: (clean) => (clean ? '        None' : '        self.back(save); self.scratch.truncate(sb); self.b.restore(ck);\n        None'),
    openBest: (d) => `        let save = self.pos; let sb = self.scratch.len(); let mut ck = self.b.checkpoint();\n        let mut best: Option<Spanned<B::H>> = None; let mut best_pos = save;${biRs(d)}`,
    cand: (d, i, cond) => candRs(d, i, cond, rid, markRs(d, i)),
    closeBest: '        self.pos = best_pos;\n        best',
    commit: (_i, conds, cond, undo, nullable) => commitRs(conds, commitBodyRs(rid, cond, undo, nullable), 'return None;'),
    commitFail: '{ return None; }',
  });
}

/** The entry rule with reuse recording (emit-portable entryShell): per-top-kid lookahead ext via
 *  parse_top_one (shape A), or an EntryMeta per segment (shape B). */
function rdEntryWithReuse(r: RdRule, plan: ReusePlan, ids: LexIdPlan, ar: ArenaIdPlan): string {
  const rid = ruleIdOf(ar, r.name);
  return entryShell(plan, ids, {
    topCall: (n) => `        return self.parse_${n}();`,
    topTry: (n) => `        { let sp = self.pos; if let Some(n) = self.parse_${n}() { return Some(n); } self.back(sp); }`,
    topFail: '        None',
    entryA: (topOne) => `    fn parse_top_one(&mut self) -> Option<Spanned<B::H>> {
${topOne}
    }
    #[inline(always)]
    fn push_entry_from_h(&mut self, h: B::H) {
        let look = self.look_end() as u32;
        let meta = self.b.entry_meta(h, look, &self.toks);
        self.entries.push(meta);
    }
    fn parse_top_entry(&mut self, sb: usize) -> Option<EntryMeta> {
        self.look_reset();
        let sp = self.pos;
        let fr = match self.parse_top_one() { Some(fr) if fr.present => fr, _ => { self.back(sp); return None; } };
        let look = self.look_end() as u32;
        let mut em = self.b.entry_meta(fr.h, look, &self.toks);
        em.kid_start = (self.scratch.len() - sb) as u32;
        self.scratch.push(fr.h);
        Some(em)
    }
    fn parse_${r.name}(&mut self) -> Option<Spanned<B::H>> {
        let save = self.pos; let sb = self.scratch.len();
        self.entries.clear();
        loop {
            let sp = self.pos;
            self.look_reset();
            match self.parse_top_one() {
                None => { self.back(sp); break; }
                Some(fr) => {
                    if fr.present {
                        // Engine-side side table (decision input). CstBuilder.entry_meta also stamps Node.ext.
                        self.push_entry_from_h(fr.h);
                        self.scratch.push(fr.h);
                    }
                }
            }
        }
        Some(self.finish(${rid}, sb, self.off_at(save), save))
    }`,
    headSeg: (rule) => `    fn parse_head_seg(&mut self, sb: usize) -> Option<EntryMeta> {
        self.look_reset();
        let before = self.scratch.len();
        self.opt(|p| p.call_rule(Parser::parse_${rule}));
        if self.scratch.len() == before { return None; }
        let n = self.scratch[before];
        let (tok_start, tok_end) = self.b.tok_range(n);
        let mut ext = tok_end;
        let look = self.look_end() as u32;
        if look > ext { ext = look; }
        let (off, end) = self.b.span_of(n, &self.toks);
        let kid_start = (before - sb) as u32;
        Some(EntryMeta { tok_start: tok_start as u32, tok_end: tok_end as u32, ext: ext as u32, off, end, kid_start, kid_count: 1 })
    }
`,
    headUse: `        if let Some(m) = self.parse_head_seg(sb) { local_e.push(m); }
`,
    loopSeg: (kid, rule) => `    fn parse_loop_seg(&mut self, sb: usize) -> Option<EntryMeta> {
        let sp = self.pos; let before = self.scratch.len(); let ck = self.b.checkpoint();
        self.look_reset();
        if !self.match_tok(${kid}) {
            self.back(sp); self.scratch.truncate(before); self.b.restore(ck);
            return None;
        }
        self.opt(|p| p.call_rule(Parser::parse_${rule}));
        let leaf = self.scratch[before];
        let (tok_start, mut tok_end) = self.b.tok_range(leaf);
        let count = self.scratch.len() - before;
        if count > 1 { tok_end = self.b.tok_range(self.scratch[before + 1]).1; }
        let mut ext = tok_end;
        let look = self.look_end() as u32;
        if look > ext { ext = look; }
        let (off, mut end) = self.b.span_of(leaf, &self.toks);
        if count > 1 { end = self.b.span_of(self.scratch[before + 1], &self.toks).1; }
        let kid_start = (before - sb) as u32;
        Some(EntryMeta { tok_start: tok_start as u32, tok_end: tok_end as u32, ext: ext as u32, off, end, kid_start, kid_count: count as u32 })
    }`,
    entryB: (headSeg, headUse, loopSeg) => `${headSeg}${loopSeg}
    fn parse_${r.name}(&mut self) -> Option<Spanned<B::H>> {
        let save = self.pos; let sb = self.scratch.len();
        let mut local_e = std::mem::take(&mut self.entries); local_e.clear();
${headUse}        loop {
            match self.parse_loop_seg(sb) {
                Some(meta) => local_e.push(meta),
                None => break,
            }
        }
        self.entries = local_e;
        Some(self.finish(${rid}, sb, self.off_at(save), save))
    }`,
  });
}
// A NUD that matched nothing: the state its frame leaves when no arm won (prattRule's nudClose).
const NUD_FAIL_RS = 'return self.nud_none();';
function prattRule(r: PrattRule, ir: ParserIR, ids: LexIdPlan, ar: ArenaIdPlan): string {
  const rid = ruleIdOf(ar, r.name);
  const d = r.nudDispatch;
  // The operator tables (emit-portable prattOpTables) as `match` functions: LLVM compiles a match
  // on the lid returning constants to a lookup table, no hashing.
  const ops = prattOpTables(r, ids);
  const binArms = ops.bin.map((b) => `${b.lid} => Some((${b.lbp}, ${b.rbp}, ${b.tgt}, ${b.noUnary}))`).join(', ');
  const preArms = ops.pre.map((p) => `${p.lid} => Some((${p.rbp}, ${p.tgt}, ${p.form}))`).join(', ');
  const postArms = ops.post.map((p) => `${p.lid} => Some((${p.lbp}, ${p.tgt}))`).join(', ');
  // `won` records the node just finished as the best so far and moves `ck` past it; `lost` drops
  // what the arm built. A sequence arm's frame is the `cand!` macro (candRs).
  const won = (i: number, form: string, tail: boolean, capped: boolean) =>
    `best_pos = self.pos;${markRs(d, i)} bf = ${form}; bt = ${tail}; bc = ${capped}; ck = self.b.checkpoint();`;
  const lost = lostRs;
  const fin = `self.finish(${rid}, sb, left.off as usize, left.tok_start as usize)`;
  const L: PrattLowering = {
    steps: rsSteps(ids, 'self', false, false),   // no body guards in Pratt arms (see rsSteps)
    ifAll: ifRs,
    kidIs: (k) => `t.kid == ${k}`,
    lidIs: (l) => `t.lid == ${l}`,
    capBelow: (bp) => `min_bp < ${bp}`,
    nudGuard: (g, keyed) => guardCond(g, 't', keyed),
    beats: (i, end) => beatsRs(d, end, i),
    leafEnd: 'save + 1',
    nudLeaf: (i) => `{ self.push_leaf(t.kid as u16, self.pos as u32, t.off, t.end); self.pos += 1; best = Some(self.finish(${rid}, sb, t.off as usize, save)); ${won(i, '0', false, false)} self.back(save); }`,
    nudTpl: (i, hole) => `        if t.kid == ${kidOf(ids, '$templateHead')} {
            match self.match_template(Self::parse_${hole}) {
                Some(n) if ${beatsRs(d, 'self.pos', i)} => { if n.present { self.scratch.push(n.h); } best = Some(self.finish(${rid}, sb, n.off as usize, n.tok_start as usize)); ${won(i, '0', false, false)} }
                _ => { ${lost} }
            }
            self.back(save);
        }`,
    nudSeq: (i, cond, tail, capped) => candRs(d, i, cond, rid, `${markRs(d, i)} bf = 0; bt = ${tail}; bc = ${capped};`),
    // An operand that parses but is not the target the operator requires fails the whole Pratt
    // call, whatever another arm matched.
    nudPrefix: (i) => `        if let Some((pbp, ptgt, pform)) = Self::${r.name}_pre(t.lid) {
            self.push_leaf(${ttIdOf(ar, '$operator')}, self.pos as u32, t.off, t.end); self.pos += 1;
            match self.${r.name}_bp(pbp) {
                Some(_) if ptgt && self.form != 0 => { self.back(save); ${lost} self.capped = false; return None; }
                Some(operand) if ${beatsRs(d, 'self.pos', i)} => { if operand.present { self.scratch.push(operand.h); } best = Some(self.finish(${rid}, sb, self.off_at(save), save)); ${won(i, 'pform', true, false)} }
                _ => { ${lost} }
            }
            self.back(save);
        }`,
    dispatch: dispatchRsL('t', false),
    // A committed arm (emit-portable.ts Commit) leaves what the frame's close would: its node, form,
    // tail and capped flag; failing, no node and the frame's empty state.
    commitLeaf: (_i, conds) => commitRs(conds, `{ let save = self.pos; let sb = self.scratch.len(); self.push_leaf(t.kid as u16, self.pos as u32, t.off, t.end); self.pos += 1; let n = self.finish(${rid}, sb, t.off as usize, save); self.form = 0; self.tail = false; return Some(n); }`, NUD_FAIL_RS, true),
    commitSeq: (_i, conds, cond, tail, capped, undo, nullable) => commitRs(conds, commitBodyRs(rid, cond, undo, nullable, `nud ${tail} ${capped}`), NUD_FAIL_RS),
    commitPrefix: (_i, conds) => commitRs(conds, `if let Some((pbp, ptgt, pform)) = Self::${r.name}_pre(t.lid) {
            let save = self.pos; let sb = self.scratch.len(); let ck = self.b.checkpoint();
            self.push_leaf(${ttIdOf(ar, '$operator')}, self.pos as u32, t.off, t.end); self.pos += 1;
            match self.${r.name}_bp(pbp) {
                Some(_) if ptgt && self.form != 0 => { self.back(save); self.scratch.truncate(sb); self.b.restore(ck); self.capped = false; return None; }
                Some(operand) => { if operand.present { self.scratch.push(operand.h); } let n = self.finish(${rid}, sb, self.off_at(save), save); self.form = pform; self.tail = true; self.capped = false; return Some(n); }
                None => { self.back(save); self.scratch.truncate(sb); self.b.restore(ck); }
            }
        }`, NUD_FAIL_RS),
    commitFail: NUD_FAIL_RS,
    nudEnd: '    }',
    commitSw: commitSwRs,
    led: {
      tailOpen: '!tail_closed',
      lbpAbove: (lbp) => `${lbp} > min_bp`,
      sameLine: '!t.nl',
      notLeftLeaf: (words) => `!self.nll_blocked(&[${words.map(J).join(', ')}], &left)`,
      notSuppressed: (set) => `self.suppress_cur != ${set}`,
      ifAll: (parts) => (parts.length ? `if ${parts.join(' && ')} ` : ''),
    },
    ledArm: (_i, cond, form, closes, exit, clean) => `{
                let led_save = self.pos; let sb = self.scratch.len();${clean ? '' : ' let ck = self.b.checkpoint();'}
                self.scratch.push(left.h);
                if ${cond} { left = ${fin}; form = ${form};${closes ? ' tail_closed = true;' : ''} continue; }
                self.back(led_save); self.scratch.truncate(sb);${clean ? '' : ' self.b.restore(ck);'}${exit ? ' break;' : ''}
            }`,
    ledSwitch: (cases) => `            match t.lid {
${cases.map((c) => `                ${c.key} => {\n${c.arms.map((a) => `                ${a}`).join('\n')}\n                }`).join('\n')}
                _ => {}
            }`,
    postfixToks: (kids) => `            match t.kid {
${kids.map((k) => `                ${k} => { if !tail_closed { let sb = self.scratch.len(); self.scratch.push(left.h); self.push_leaf(t.kid as u16, self.pos as u32, t.off, t.end); self.pos += 1; left = ${fin}; form = 0; continue; } }`).join('\n')}
                _ => {}
            }`,
    postfixTpl: (hole) => `
            if !tail_closed && t.kid == ${kidOf(ids, '$templateHead')} { if let Some(n) = self.match_template(Self::parse_${hole}) { let sb = self.scratch.len(); if left.present { self.scratch.push(left.h); } if n.present { self.scratch.push(n.h); } left = ${fin}; form = 0; continue; } }`,
    postfixOp: `            if let Some((plbp, ptgt)) = Self::${r.name}_post(t.lid) { if !tail_closed && plbp > min_bp${r.postfixSameLine ? ' && !t.nl' : ''} { if ptgt && form != 0 { return None; } let sb = self.scratch.len(); self.scratch.push(left.h); self.push_leaf(${ttIdOf(ar, '$operator')}, self.pos as u32, t.off, t.end); self.pos += 1; left = ${fin}; tail_closed = true; form = 1; continue; } }`,
    binary: `            let (op_lid, op_n, op_end) = self.op_read(t);
            let (lbp, rbp, tgt, no_unary) = match Self::${r.name}_bin(op_lid) { Some(x) => x, None => break };
            if lbp <= min_bp { break; }
            if tgt && form != 0 || no_unary && form == 2 { return None; }
            let led_save = self.pos;
            let sb = self.scratch.len(); self.scratch.push(left.h);
            self.push_leaf(${ttIdOf(ar, '$operator')}, self.pos as u32, t.off, op_end);
            self.pos += op_n;
            let rhs = match self.${r.name}_bp(rbp) { Some(r) => r, None => { self.back(led_save); self.scratch.truncate(sb); break; } };
            if rhs.present { self.scratch.push(rhs.h); }
            left = ${fin};
            form = 1; tail_closed = true;
        }`,
    entry: `    fn parse_${r.name}(&mut self) -> Option<Spanned<B::H>> {
        let prev = self.suppress_cur;
        self.suppress_cur = self.suppress_next;
        self.suppress_next = 0;
        let r = self.${r.name}_bp(0);
        self.suppress_cur = prev;
        r
    }
    fn ${r.name}_bin(op: u16) -> Option<(i64, i64, bool, bool)> { match op { ${binArms}${binArms ? ', ' : ''}_ => None } }
    fn ${r.name}_pre(op: u16) -> Option<(i64, bool, u8)> { match op { ${preArms}${preArms ? ', ' : ''}_ => None } }
    fn ${r.name}_post(op: u16) -> Option<(i64, bool)> { match op { ${postArms}${postArms ? ', ' : ''}_ => None } }`,
    // Rust's `loop` takes no label here: a led's `continue` / `break` are the innermost loop's.
    bpOpen: () => `    fn ${r.name}_bp(&mut self, min_bp: i64) -> Option<Spanned<B::H>> {
        let mut left = self.${r.name}_nud(min_bp)?;
        let mut form = self.form;
        if self.capped { return Some(left); }
        let mut tail_closed = self.tail;
        loop {
            let t = match self.peek() { Some(t) => t, None => break };`,
    bpClose: `        self.form = form;
        Some(left)
    }`,
    nudEnter: `    fn ${r.name}_nud(&mut self, min_bp: i64) -> Option<Spanned<B::H>> {
        self.capped = false;
        let t = self.peek()?;`,
    nudOpen: `        let save = self.pos; let sb = self.scratch.len(); let mut ck = self.b.checkpoint();
        let mut best: Option<Spanned<B::H>> = None; let mut best_pos = save;${biRs(d)}
        let (mut bf, mut bt, mut bc) = (0u8, false, false);`,
    nudClose: `        // A sub-parse may leave self.capped set: only a capped arm that won makes THIS node capped.
        self.capped = bc;
        self.form = bf;
        self.tail = bt;
        self.pos = best_pos;
        best
    }`,
  };
  return prattShell(r, ir, ids, L);
}


function docEditBlockRust(ir: ParserIR, shared: SharedAlgorithms): string {
  const topReuse = ir.reuse;
  const shapeA = topReuse?.kind === 'A';
  const shapeB = topReuse?.kind === 'B';
  const hasHeadB = !!(shapeB && topReuse.kind === 'B' && topReuse.hasHead);
  const entriesInit = topReuse ? ', entries: Vec::new()' : '';
  const reuseInit = entriesInit;
  const relexFamily = `\n// ---- relex family: generated from src/relex-family.ts (shared by the TS / Go / Rust targets) ----\n${shared.relexFamily(ir)}\n`;
  const reuseFamily = `\n// ---- reuse family: generated from src/reuse-family.ts (shared by the TS / Go / Rust targets) ----\n${shared.reuseFamily(ir)}\n`;
  const initToks = 'scan_meta(&text)';
  const reuseShared = topReuse ? `
fn count_live(nodes: &[Node], kids: &[i32], id: i32) -> usize {
    let mut n = 1usize;
    let nd = &nodes[id as usize];
    for i in 0..nd.kid_count {
        let cid = kids[nd.kid_start as usize + i as usize];
        if cid >= 0 { n += count_live(nodes, kids, cid); }
    }
    n
}
fn should_reclaim_arena(nodes: &[Node], kids: &[i32], root: i32, baseline: usize) -> bool {
    if root < 0 || baseline == 0 { return false; }
    let live = count_live(nodes, kids, root);
    let lim = baseline.max(live);
    nodes.len() > ARENA_COMPACT_K * lim
}
fn shift_subtree(nodes: &mut [Node], kids: &mut [i32], id: i32, byte_delta: isize, tok_delta: isize) {
    assert!(id >= 0);
    {
        let nd = &mut nodes[id as usize];
        nd.offset = (nd.offset as isize + byte_delta) as u32;
        nd.end = (nd.end as isize + byte_delta) as u32;
        nd.tok_start = (nd.tok_start as isize + tok_delta) as u32;
        nd.tok_end = (nd.tok_end as isize + tok_delta) as u32;
        nd.ext = (nd.ext as isize + tok_delta) as u32;
    }
    let (ks, kc) = { let nd = &nodes[id as usize]; (nd.kid_start, nd.kid_count) };
    for i in 0..kc {
        let slot = ks as usize + i as usize;
        let cid = kids[slot];
        if cid < 0 {
            let (ti, tt) = decode_leaf(cid);
            let nti = (ti as isize + tok_delta) as u32;
            kids[slot] = encode_leaf(nti, tt);
        } else {
            shift_subtree(nodes, kids, cid, byte_delta, tok_delta);
        }
    }
}
${shapeA ? `fn assert_entries_vs_nodes(entries: &[EntryMeta], nodes: &[Node], kids: &[i32], old_root: i32) {
    let old = &nodes[old_root as usize];
    assert_eq!(entries.len(), old.kid_count as usize, "entry count vs root kids");
    for i in 0..entries.len() {
        let kid = kids[old.kid_start as usize + i];
        assert!(kid >= 0, "entry {} expected rule node kid", i);
        let nd = &nodes[kid as usize];
        let e = &entries[i];
        assert_eq!(e.tok_start, nd.tok_start, "tok_start entry {}", i);
        assert_eq!(e.tok_end, nd.tok_end, "tok_end entry {}", i);
        assert_eq!(e.ext, nd.ext, "ext entry {}", i);
        assert_eq!(e.off, nd.offset, "off entry {}", i);
        assert_eq!(e.end, nd.end, "end entry {}", i);
    }
}
` : ''}` : '';
  const reuseFns = topReuse ? `${reuseShared}${shapeB ? `fn assert_entries_vs_kids(entries: &[EntryMeta], nodes: &[Node], kids: &[i32], old_root: i32) {
    let old = &nodes[old_root as usize];
    for i in 0..entries.len() {
        let e = &entries[i];
        // off/end vs rule-node kids only — leaf endpoints need the old tok stream, which
        // the edit Parser no longer holds (self.toks is the new stream).
        let first = kids[old.kid_start as usize + e.kid_start as usize];
        let last = kids[old.kid_start as usize + e.kid_start as usize + e.kid_count as usize - 1];
        if first >= 0 {
            assert_eq!(e.off, nodes[first as usize].offset, "off entry {}", i);
        }
        if last >= 0 {
            assert_eq!(e.end, nodes[last as usize].end, "end entry {}", i);
        }
    }
}
` : ''}impl<'a, B: Builder> Parser<'a, B> {
    fn finish_reuse(&mut self, rule_id: u16, prefix_kids: &[B::H], mid_kids: &[B::H], prefix_meta: &[EntryMeta], mid_meta: &[EntryMeta], suffix_meta: &[EntryMeta], old_root: B::H, adopt_from: usize, byte_delta: isize) -> (B::H, usize) {
        let adopted_segs = &suffix_meta[adopt_from..];
        let mut tok_delta = 0isize;
        if !adopted_segs.is_empty() {
            let s = suffix_meta[adopt_from].tok_start as usize;
            tok_delta = self.pos as isize - s as isize;
        }
        let mut adopted_kids: Vec<B::H> = Vec::new();
        for s in adopted_segs {
            for i in 0..s.kid_count as usize {
                let id = self.b.root_kid_at(old_root, s.kid_start as usize + i);
                adopted_kids.push(self.b.shift(id, byte_delta, tok_delta));
            }
        }
        let mut children: Vec<B::H> = Vec::with_capacity(prefix_kids.len() + mid_kids.len() + adopted_kids.len());
        children.extend_from_slice(prefix_kids);
        children.extend_from_slice(mid_kids);
        children.extend_from_slice(&adopted_kids);
        let new_entries = reuse_entries(prefix_meta, mid_meta, suffix_meta, adopt_from, byte_delta, tok_delta);
        let (off, end, tok_start, tok_end) = reuse_span(&new_entries);
        let sb = self.scratch.len();
        self.scratch.extend_from_slice(&children);
        self.b.node(&mut self.scratch, sb, rule_id, off, end, tok_start, tok_end);
        let root = self.scratch.pop().expect("finish_reuse root");
        self.entries = new_entries;
        self.pos = self.toks.len();
        (root, prefix_meta.len() + adopted_segs.len())
    }
    fn try_reuse(&mut self, old_root: B::H, old_entries: &[EntryMeta], new_toks: Vec<Tok>, byte_delta: isize, old_n: usize, prefix: usize, suffix: usize, validate: bool) -> Option<(B::H, usize)> {
        ${shapeB ? 'if old_entries.is_empty() { return None; }\n        ' : ''}if validate { self.b.validate_entries(old_entries, old_root); }
        let (prefix_len, suffix_start) = reuse_bounds(old_entries, prefix, old_n, suffix);
        let prefix_meta = &old_entries[..prefix_len];
        let suffix_meta = &old_entries[suffix_start..];
        let mut prefix_kids: Vec<B::H> = Vec::new();
        for s in prefix_meta {
            for j in 0..s.kid_count as usize {
                prefix_kids.push(self.b.root_kid_at(old_root, s.kid_start as usize + j));
            }
        }
        self.toks = new_toks;
        self.pos = if prefix_len > 0 { prefix_meta[prefix_len - 1].tok_end as usize } else { 0 };
        self.scratch.clear();
        let mut mid_kids: Vec<B::H> = Vec::new();
        let mut mid_meta: Vec<EntryMeta> = Vec::new();
        let rule_id = self.b.rule_id_of(old_root);
        let try_hit = |p: &mut Parser<'a, B>, mid_kids: &[B::H], mid_meta: &[EntryMeta]| -> Option<(B::H, usize)> {
            let at = reuse_adopt_at(suffix_meta, old_n, suffix, p.toks.len() - p.pos);
            if at < 0 { return None; }
            Some(p.finish_reuse(rule_id, &prefix_kids, mid_kids, prefix_meta, mid_meta, suffix_meta, old_root, at as usize, byte_delta))
        };
        let passed = |p: &Parser<'a, B>| reuse_gave_up(suffix_meta, old_n, p.toks.len() - p.pos);
        if let Some(hit) = try_hit(self, &mid_kids, &mid_meta) { return Some(hit); }
        if passed(self) { return None; }
        ${hasHeadB ? `if prefix_len == 0 {
            let sb = self.scratch.len();
            if let Some(mut m) = self.parse_head_seg(sb) {
                m.kid_start = 0;
                mid_kids.extend_from_slice(&self.scratch[sb..]);
                self.scratch.truncate(sb);
                mid_meta.push(m);
                if let Some(hit) = try_hit(self, &mid_kids, &mid_meta) { return Some(hit); }
                if passed(self) { return None; }
            }
        }
        ` : ''}loop {
            if self.pos >= self.toks.len() {
                return try_hit(self, &mid_kids, &mid_meta);
            }
            let sb = self.scratch.len();
            let meta = match self.parse_${shapeA ? 'top_entry' : 'loop_seg'}(sb) {
                Some(meta) => meta,
                None => return try_hit(self, &mid_kids, &mid_meta),
            };
            let count = self.scratch.len() - sb;
            mid_kids.extend_from_slice(&self.scratch[sb..]);
            self.scratch.truncate(sb);
            mid_meta.push(EntryMeta { kid_start: 0, kid_count: count as u32, tok_start: meta.tok_start, tok_end: meta.tok_end, ext: meta.ext, off: meta.off, end: meta.end });
            if let Some(hit) = try_hit(self, &mid_kids, &mid_meta) { return Some(hit); }
            if passed(self) { return None; }
        }
    }
}
` : '';
  const treeEqFn = `
fn cmp_kid(nodes_a: &[Node], kids_a: &[i32], toks_a: &[Tok], kid_a: i32, nodes_b: &[Node], kids_b: &[i32], toks_b: &[Tok], kid_b: i32) -> bool {
    if (kid_a < 0) != (kid_b < 0) { return false; }
    if kid_a < 0 {
        let (ti_a, tt_a) = decode_leaf(kid_a);
        let (ti_b, tt_b) = decode_leaf(kid_b);
        if tt_a != tt_b { return false; }
        let ta = &toks_a[ti_a as usize];
        let tb = &toks_b[ti_b as usize];
        ta.off == tb.off && ta.end == tb.end
    } else {
        let na = &nodes_a[kid_a as usize];
        let nb = &nodes_b[kid_b as usize];
        if na.rule_id != nb.rule_id || na.kid_count != nb.kid_count || na.offset != nb.offset || na.end != nb.end { return false; }
        for i in 0..na.kid_count {
            let ca = kids_a[na.kid_start as usize + i as usize];
            let cb = kids_b[nb.kid_start as usize + i as usize];
            if !cmp_kid(nodes_a, kids_a, toks_a, ca, nodes_b, kids_b, toks_b, cb) { return false; }
        }
        true
    }
}
fn check_tree_eq_arena(text: &str, toks_a: &[Tok], nodes: &[Node], kids: &[i32], root: Option<i32>) -> bool {
    let root_ok = root.is_some();
    let s1 = if let Some(r) = root {
        let mut b = String::new();
        write_json_arena(nodes, kids, toks_a, r, &mut b);
        b
    } else { String::new() };
    let fresh = parse(text);
    match (root_ok, fresh) {
        (false, None) => true,
        (true, Some((p, fr))) => {
            if !cmp_kid(nodes, kids, toks_a, root.unwrap(), &p.b.nodes, &p.b.kids, &p.toks, fr) { return false; }
            let mut b2 = String::new();
            write_json(&p, fr, &mut b2);
            s1 == b2
        }
        _ => false,
    }
}
`;
  const editParseReuse = topReuse
    ? `        let byte_delta = self.text.len() as isize - old_text.len() as isize;
        let mut reused = 0usize;
        let force_fresh = self.root.is_none()
            || !B::SUPPORTS_SHIFT
            || self.root.map(|r| self.b.should_reclaim(r, self.baseline)).unwrap_or(true);
        let text = self.text.clone();
        let meta = self.toks.clone();
        if !force_fresh {
            let b = std::mem::take(&mut self.b);
            let scratch = std::mem::take(&mut self.scratch);
            let old_entries = std::mem::take(&mut self.entries);
            let old_root = self.root.take().unwrap();
            let mut p = Parser { toks: Vec::new(), pos: 0, max_look: 0, peek_end: 0, capped: false, form: 0, tail: false, suppress_next: 0, suppress_cur: 0, ctx: 0, src: &text, b, scratch, entries: Vec::new() };
            if let Some((root, n)) = p.try_reuse(old_root, &old_entries, toks_from_meta(&text, &meta), byte_delta, old_n, prefix, suffix, self.validate) {
                self.root = Some(root);
                reused = n;
                self.last_pos = p.pos;
                self.b = p.b; self.scratch = p.scratch; self.keep_toks(p.toks); self.entries = p.entries;
            } else {
                let ntoks = toks_from_meta(&text, &meta);
                let mut p = Parser { toks: ntoks, pos: 0, max_look: 0, peek_end: 0, capped: false, form: 0, tail: false, suppress_next: 0, suppress_cur: 0, ctx: 0, src: &text, b: B::default(), scratch: Vec::new(), entries: Vec::new() };
                match p.parse_${ir.entry}() {
                    Some(fr) if p.pos == p.toks.len() => {
                        self.root = Some(fr.root()); self.baseline = p.b.arena_len(); self.last_pos = p.pos;
                        self.b = p.b; self.scratch = p.scratch; self.keep_toks(p.toks); self.entries = p.entries; reused = 0;
                    }
                    _ => {
                        self.root = None; self.baseline = p.b.arena_len(); self.last_pos = p.pos;
                        self.b = p.b; self.scratch = p.scratch; self.keep_toks(p.toks); self.entries = p.entries; reused = 0;
                    }
                }
            }
        } else {
            let ntoks = toks_from_meta(&text, &meta);
            let mut p = Parser { toks: ntoks, pos: 0, max_look: 0, peek_end: 0, capped: false, form: 0, tail: false, suppress_next: 0, suppress_cur: 0, ctx: 0, src: &text, b: B::default(), scratch: Vec::new(), entries: Vec::new() };
            match p.parse_${ir.entry}() {
                Some(fr) if p.pos == p.toks.len() => {
                    self.root = Some(fr.root()); self.baseline = p.b.arena_len(); self.last_pos = p.pos;
                    self.b = p.b; self.scratch = p.scratch; self.keep_toks(p.toks); self.entries = p.entries;
                }
                _ => {
                    self.root = None; self.baseline = p.b.arena_len(); self.last_pos = p.pos;
                    self.b = p.b; self.scratch = p.scratch; self.keep_toks(p.toks); self.entries = p.entries;
                }
            }
            reused = 0;
        }
        let stream_eq = if self.validate { Some(check_stream_eq(&self.text, &self.toks)) } else { None };
        let tree_eq = if self.validate && B::SUPPORTS_TREE_EQ {
            Some(self.b.check_tree_eq(&self.text, self.root))
        } else { None };
        self.align = Some(Align { old_n, new_n, prefix, suffix, relexed, reused, stream_eq, tree_eq });`
    : '';
  const docTakeReuse = topReuse
    ? ' self.entries = p.entries;'
    : '';
  const editParse = topReuse
    ? editParseReuse
    : `        let text = self.text.clone();
        let meta = self.toks.clone();
        let ntoks = toks_from_meta(&text, &meta);
        let mut p = Parser { toks: ntoks, pos: 0, max_look: 0, peek_end: 0, capped: false, form: 0, tail: false, suppress_next: 0, suppress_cur: 0, ctx: 0, src: &text, b: B::default(), scratch: Vec::new()${reuseInit} };
        match p.parse_${ir.entry}() {
            Some(fr) if p.pos == p.toks.len() => {
                self.root = Some(fr.root()); self.baseline = p.b.arena_len(); self.last_pos = p.pos;
                self.b = p.b; self.scratch = p.scratch; self.keep_toks(p.toks);${docTakeReuse}
            }
            _ => {
                self.root = None; self.baseline = p.b.arena_len(); self.last_pos = p.pos;
                self.b = p.b; self.scratch = p.scratch; self.keep_toks(p.toks);${docTakeReuse}
            }
        }
        let reused = 0usize;
        let stream_eq = if self.validate { Some(check_stream_eq(&self.text, &self.toks)) } else { None };
        let tree_eq = if self.validate && B::SUPPORTS_TREE_EQ {
            Some(self.b.check_tree_eq(&self.text, self.root))
        } else { None };
        self.align = Some(Align { old_n, new_n, prefix, suffix, relexed, reused, stream_eq, tree_eq });`;
  const docEntriesField = topReuse ? '\n    entries: Vec<EntryMeta>,' : '';
  const docEntriesInit = topReuse ? ', entries: Vec::new()' : '';
  const docExtraField = docEntriesField;
  const docExtraInit = docEntriesInit;
  return `pub struct Edit { pub start: usize, pub end: usize, pub text: String }
/// Packed Doc-state token (16B). kind → kid+KIND_STR; text → src[off..end];
/// nl/lc/lb/hd packed in flags; pd/fd/td are narrow depths (paren/flow/template).
#[derive(Clone, Copy, PartialEq, Eq)]
struct AlignMeta { off: u32, end: u32, kid: u16, pd: u16, fd: u16, flags: u8, td: u8 }
#[inline(always)] fn am_nl(m: &AlignMeta) -> bool { m.flags & 1 != 0 }
#[inline(always)] fn am_lc(m: &AlignMeta) -> bool { m.flags & 2 != 0 }
#[inline(always)] fn am_lb(m: &AlignMeta) -> bool { m.flags & 4 != 0 }
#[inline(always)] fn am_hd(m: &AlignMeta) -> bool { m.flags & 8 != 0 }
#[inline(always)] fn am_text<'a>(src: &'a str, m: &AlignMeta) -> &'a str { &src[m.off as usize..m.end as usize] }
#[inline(always)] fn mk_align(off: u32, end: u32, kid: u16, nl: bool, fd: u16, pd: u16, lc: bool, lb: bool, hd: bool, td: u8) -> AlignMeta {
    AlignMeta { off, end, kid, pd, fd, td, flags: (nl as u8) | ((lc as u8) << 1) | ((lb as u8) << 2) | ((hd as u8) << 3) }
}
#[inline(always)] fn shift_align(m: &AlignMeta, delta: isize) -> AlignMeta {
    AlignMeta { off: (m.off as isize + delta) as u32, end: (m.end as isize + delta) as u32, kid: m.kid, pd: m.pd, fd: m.fd, flags: m.flags, td: m.td }
}
struct Align { old_n: usize, new_n: usize, prefix: usize, suffix: usize, relexed: usize, reused: usize, stream_eq: Option<bool>, tree_eq: Option<bool> }
${relexFamily}${reuseFamily}
fn toks_from_meta(text: &str, meta: &[AlignMeta]) -> Vec<Tok> {
    meta.iter().map(|m| { let tx = am_text(text, m); mk_tok(m.off as usize, m.end as usize, am_nl(m), m.kid, ${regionKids(ir, buildLexIdPlan(ir)).length ? `if ${regionKids(ir, buildLexIdPlan(ir)).map((k) => `m.kid == ${k}`).join(' || ')} { 0 } else { lid_of(tx.as_bytes()) }` : 'lid_of(tx.as_bytes())'}) }).collect()
}
${treeEqFn}${reuseFns}pub struct Doc<B: Builder = CstBuilder> {
    text: String,
    toks: Vec<AlignMeta>,
    align: Option<Align>,
    validate: bool,
    b: B,
    scratch: Vec<B::H>,${docExtraField}
    root: Option<B::H>,
    baseline: usize,
    last_pos: usize,
}
impl<B: Builder + Default> Doc<B> {
    /// Explicit builder (handout Doc::new(src, builder) form — Rust has no arity overload).
    pub fn new_with(text: String, b: B) -> Doc<B> {
        let toks = match ${initToks} { (toks, None) => toks, (_, Some(e)) => panic!("{}", lex_error(&text, e).msg) };
        let mut d = Doc { text, toks, align: None, validate: false, b, scratch: Vec::new()${docExtraInit}, root: None, baseline: 0, last_pos: 0 };
        d.reparse_fresh();
        d
    }
    /// Convenient constructor via B::default(). Bare Doc::new(src) → CstBuilder (default type param).
    pub fn new(text: String) -> Doc<B> {
        Doc::new_with(text, B::default())
    }
    fn reparse_fresh(&mut self) {
        let text = self.text.clone();
        let meta = self.toks.clone();
        let ntoks = toks_from_meta(&text, &meta);
        let b = std::mem::take(&mut self.b);
        let mut p = Parser { toks: ntoks, pos: 0, max_look: 0, peek_end: 0, capped: false, form: 0, tail: false, suppress_next: 0, suppress_cur: 0, ctx: 0, src: &text, b, scratch: Vec::new()${reuseInit} };
        match p.parse_${ir.entry}() {
            Some(fr) if p.pos == p.toks.len() => {
                self.root = Some(fr.root()); self.baseline = p.b.arena_len(); self.last_pos = p.pos;
                self.b = p.b; self.scratch = p.scratch; self.keep_toks(p.toks);${docTakeReuse}
            }
            _ => {
                self.root = None; self.baseline = p.b.arena_len(); self.last_pos = p.pos;
                self.b = p.b; self.scratch = p.scratch; self.keep_toks(p.toks);${docTakeReuse}
            }
        }
    }
    fn keep_toks(&mut self, t: Vec<Tok>) { if let Some(s) = self.b.toks_mut() { *s = t; } }
    pub fn set_validate(&mut self, v: bool) { self.validate = v; }
    pub fn text(&self) -> &str { &self.text }
    pub fn alignment(&self) -> Option<&Align> { self.align.as_ref() }
    pub fn builder(&self) -> &B { &self.b }
    pub fn root_handle(&self) -> Option<B::H> { self.root }
    pub fn edit(&mut self, edits: &[Edit]) {
        let old_text = self.text.clone();
        let old_toks = self.toks.clone();
        // A lexer error in the relex is the text's own (the relexed stream equals a fresh lex:
        // relex-family.ts): the text is rejected and the Doc keeps no token stream (the next edit
        // relexes it all).
        let relexed = match relex_edits(&old_text, &old_toks, edits) {
            (text, toks, n, None) => { self.text = text; self.toks = toks; n as usize }
            (_, _, _, Some(_)) => {
                self.text = apply_edits(&old_text, edits);
                self.toks = Vec::new();
                self.root = None;
                self.keep_toks(Vec::new());
                let v = if self.validate { Some(true) } else { None };
                self.align = Some(Align { old_n: old_toks.len(), new_n: 0, prefix: 0, suffix: 0, relexed: 0, reused: 0, stream_eq: v, tree_eq: if B::SUPPORTS_TREE_EQ { v } else { None } });
                return;
            }
        };
        let (old_n, new_n, prefix, suffix) = compute_align_core(&old_text, &old_toks, &self.text, &self.toks);
${editParse}
    }
}
impl Doc<CstBuilder> {
    pub fn cst_json(&self) -> Option<String> {
        let root = self.root?;
        if self.last_pos != self.b.toks.len() { return None; }
        let mut out = String::new();
        write_json_arena(&self.b.nodes, &self.b.kids, &self.b.toks, root, &mut out);
        Some(out)
    }
    pub fn parse(&self) -> Option<(Parser<'_>, i32)> {
        // Fresh independent parse (does not touch Doc arena) — used by non-edit callers.
        let toks = toks_from_meta(&self.text, &self.toks);
        let n = toks.len();
        let mut p = Parser { toks, pos: 0, max_look: 0, peek_end: 0, capped: false, form: 0, tail: false, suppress_next: 0, suppress_cur: 0, ctx: 0, src: &self.text, b: CstBuilder::default(), scratch: Vec::new()${reuseInit} };
        match p.parse_${ir.entry}() {
            Some(fr) if p.pos == p.toks.len() => Some((p, fr.root())),
            _ => None,
        }
    }
}`;
}



/** Emit Builder trait, CstBuilder/SlimBuilder, sole Parser machine, and parse_with helpers. */
// The `ahead` test's table: whether a token is in tokenSets[k] (see tokenSetBits).
function tokenSetRuntimeRust(ir: ParserIR, ids: LexIdPlan): string {
  const b = tokenSetBits(ids, ir.tokenSets);
  const rows: string[] = [];
  for (let r = 0; r * b.width < b.words.length; r++) rows.push(`[${b.words.slice(r * b.width, (r + 1) * b.width).join(', ')}]`);
  return `#[allow(dead_code)]
const TOKEN_SET_KID: usize = ${b.kidBase};
#[allow(dead_code)]
static TOKEN_SETS: [[u32; ${b.width}]; ${rows.length}] = [${rows.join(', ')}];
#[inline(always)]
#[allow(dead_code)]
fn in_token_set(k: usize, t: &Tok) -> bool {
    // Rows are exact-size (one per lid, then one per kid) and a token's ids are always in range,
    // as for the lexer's flag tables; k is a constant at every call site, so is word k >> 5.
    let (l, c) = unsafe { (TOKEN_SETS.get_unchecked(t.lid as usize), TOKEN_SETS.get_unchecked(TOKEN_SET_KID + t.kid as usize)) };
    (l[k >> 5] | c[k >> 5]) & (1 << (k & 31)) != 0
}
// Whether t is a word the context ctx reserves (ParserIR.ctxWords): with the \`ahead\` test of the
// guard's own set, an \`aheadCtx\` test.
#[inline(always)]
#[allow(dead_code)]
fn in_ctx_words(ctx: u8, t: &Tok) -> bool { let _ = (ctx, t); false${ctxWordLids(ir, ids).map((w) => ` || (ctx & ${w.bit} != 0 && t.lid == ${w.lid})`).join('')} }`;
}

function emitParserMachine(ir: ParserIR, ids: LexIdPlan, ar: ArenaIdPlan, shapeB: boolean): string {
  const reuse = ir.reuse;
  const entriesField = reuse ? '\n    entries: Vec<EntryMeta>,' : '';
  const ruleFns = [...ir.rules.filter((r) => ir.forms.buildRules.includes(r.name)).map((r) => {
    if (r.kind === 'pratt') return prattRule(r, ir, ids, ar);
    if (reuse && r.name === ir.entry) return rdEntryWithReuse(r, reuse, ids, ar);
    return rdRule(r, ids, ar);
  }), ...ir.rules.filter((r) => ir.forms.recognizeRules.includes(r.name)).map((r) => ruleR(r, ids, ar))].join('\n\n');
  const matchTemplate = ir.tpl ? `    // interp: the rule that parses each \`\${…}\` hole — the one the matching reference declares
    // (the grammar's expression rule, or the rule a withHoles reference names).
    fn match_template(&mut self, interp: fn(&mut Parser<'a, B>) -> Option<Spanned<B::H>>) -> Option<Spanned<B::H>> {
        let t = self.peek()?;
        if t.kid != ${kidOf(ids, "$templateHead")} { return None; }
        let save = self.pos; let sb = self.scratch.len(); let ck = self.b.checkpoint();
        self.push_leaf(${ttIdOf(ar, '$templateHead')}, self.pos as u32, t.off, t.end); self.pos += 1;
        loop {
            let expr = match interp(self) { Some(e) => e, None => { self.back(save); self.scratch.truncate(sb); self.b.restore(ck); return None; } };
            if expr.present { self.scratch.push(expr.h); }
            let next = match self.peek() { Some(x) => x, None => { self.back(save); self.scratch.truncate(sb); self.b.restore(ck); return None; } };
            if next.kid == ${kidOf(ids, "$templateMiddle")} { self.push_leaf(${ttIdOf(ar, '$templateMiddle')}, self.pos as u32, next.off, next.end); self.pos += 1; continue; }
            if next.kid == ${kidOf(ids, "$templateTail")} { self.push_leaf(${ttIdOf(ar, '$templateTail')}, self.pos as u32, next.off, next.end); self.pos += 1; break; }
            self.back(save); self.scratch.truncate(sb); self.b.restore(ck); return None;
        }
        Some(self.finish(${ruleIdOf(ar, '$template')}, sb, self.off_at(save), save))
    }
` : '';

  const dropTtIds = ['$punct', '$keyword', '$operator']
    .map((n) => {
      try { return ttIdOf(ar, n); } catch { return null; }
    })
    .filter((x): x is number => x !== null);
  const punctId = TT_SKIP_PUNCT;
  const slimDropMatch = dropTtIds.length
    ? dropTtIds.map((id) => `${id}`).join(' | ')
    : 'u16::MAX';

  return `// ─── Builder API ─────────────────────────────────────────────────────────────
// Builder is pure / bottom-up. Backtracking truncates scratch (+ optional arena
// checkpoint); discarded handles are garbage. H: Copy (arena i32) — owning
// builders that need cleanup on truncate must self-manage.
pub trait Builder {
    type H: Copy;
    /// When false, Doc::edit skips subtree reuse (fresh parse). Default: no shift.
    const SUPPORTS_SHIFT: bool = false;
    /// When true, validate runs treeEq against a full CST (CstBuilder only).
    const SUPPORTS_TREE_EQ: bool = false;
    /// Shift handle spans by edit deltas. Leaves may return a re-encoded handle.
    /// Engine never touches arena kid encoding directly (D0 R5).
    #[inline(always)]
    fn shift(&mut self, h: Self::H, _byte_delta: isize, _tok_delta: isize) -> Self::H { h }
    /// Arena reclaim probe (CstBuilder). Default: never reclaim.
    #[inline(always)]
    fn should_reclaim(&self, _root: Self::H, _baseline: usize) -> bool { false }
    /// Arena node count for baseline after fresh parse. Default 0.
    #[inline(always)]
    fn arena_len(&self) -> usize { 0 }
    /// Kid at relative index under root (the root's entries' kids). Default dummy.
    #[inline(always)]
    fn root_kid_at(&self, _root: Self::H, _idx: usize) -> Self::H { Self::dummy_h() }
    /// Rule id of a rule-node handle (reuse finish). Default 0.
    #[inline(always)]
    fn rule_id_of(&self, _h: Self::H) -> u16 { 0 }
    /// D1 EntryMeta ↔ arena asserts (CstBuilder). Default no-op.
    #[inline(always)]
    fn validate_entries(&self, _entries: &[EntryMeta], _root: Self::H) {}
    /// treeEq oracle (CstBuilder). Default true (unused when SUPPORTS_TREE_EQ=false).
    #[inline(always)]
    fn check_tree_eq(&self, _text: &str, _root: Option<Self::H>) -> bool { true }
    /// Where the builder keeps the parse stream its handles' leaves index (CstBuilder and
    /// SlimBuilder serialize against it); parse_with and Doc store it there. Default: not kept
    /// (a Doc keeps it itself).
    #[inline(always)]
    fn toks(&self) -> Option<&Vec<Tok>> { None }
    #[inline(always)]
    fn toks_mut(&mut self) -> Option<&mut Vec<Tok>> { None }
    /// Where the builder keeps the engine's transient buffers between parses (see Workspace).
    /// parse_with takes them from here and puts them back, so a builder that returns one makes a
    /// later parse reuse their capacity. Default: none kept (each parse allocates its own).
    #[inline(always)]
    fn workspace_mut(&mut self) -> Option<&mut Workspace<Self::H>> { None }
    fn leaf(&mut self, scratch: &mut Vec<Self::H>, tt_id: u16, tok_idx: u32, off: u32, end: u32) -> bool;
    /// Consume scratch[sb..] → 0..=n handles; return (primary H, off, present).
    /// Default: span_of + node (drop/splice via leftover scratch count). CstBuilder overrides
    /// with an arena \`finish\` twin so monomorphization matches native parse.
    #[inline(always)]
    fn finish(
        &mut self, scratch: &mut Vec<Self::H>, sb: usize, rule_id: u16,
        fallback_off: u32, tok_start: u32, tok_end: u32, toks: &[Tok],
    ) -> (Self::H, u32, bool) {
        let nn = scratch.len();
        let (offset, end) = if nn > sb {
            let (o0, _) = self.span_of(scratch[sb], toks);
            let (_, e1) = self.span_of(scratch[nn - 1], toks);
            (o0, e1)
        } else {
            (fallback_off, fallback_off)
        };
        self.node(scratch, sb, rule_id, offset, end, tok_start, tok_end);
        let n = scratch.len() - sb;
        if n == 1 {
            (scratch.pop().unwrap(), offset, true)
        } else if n == 0 {
            (Self::dummy_h(), offset, false)
        } else {
            let h = scratch[sb];
            scratch.truncate(sb);
            (h, offset, true)
        }
    }
    fn node(&mut self, scratch: &mut Vec<Self::H>, sb: usize, rule_id: u16, off: u32, end: u32, tok_start: u32, tok_end: u32);
    fn span_of(&self, h: Self::H, toks: &[Tok]) -> (u32, u32);
    fn head_span(&self, h: Self::H, toks: &[Tok]) -> (u32, u32);
    /// Arena builders: (nodes.len(), kids.len()). Default no-op for pure builders.
    #[inline(always)] fn checkpoint(&self) -> (usize, usize) { (0, 0) }
    #[inline(always)] fn restore(&mut self, _ck: (usize, usize)) {}
    fn dummy_h() -> Self::H;
    /// Record lookahead watermark on a finished kid (shape-A reuse). Default no-op.
    #[inline(always)] fn note_look(&mut self, _h: Self::H, _max_look: u32) {}
    /// Build EntryMeta for an entry handle; CstBuilder also stamps Node.ext (note_look fused).
    #[inline(always)]
    fn entry_meta(&mut self, h: Self::H, max_look: u32, toks: &[Tok]) -> EntryMeta {
        let (tok_start, tok_end) = self.tok_range(h);
        let mut ext = tok_end;
        if max_look > ext { ext = max_look; }
        let (off, end) = self.span_of(h, toks);
        EntryMeta { tok_start, tok_end, ext, off, end, kid_start: 0, kid_count: 1 }
    }
    /// Token span of handle h (leaf encoding or rule node).
    fn tok_range(&self, h: Self::H) -> (u32, u32);
}

/// The engine's transient buffers — the scratch stack of handles, the top-level entry list and the
/// lexer's bracket / template stacks — kept by a builder between parses (Builder::workspace_mut).
/// Opaque: only parse_with reads or writes it, and each parse starts every buffer empty, so what a
/// previous parse (accepted, rejected or panicking) left in it is never observed. Generic over the
/// builder's handle type because the scratch stack holds handles.
pub struct Workspace<H> {
    scratch: Vec<H>,${reuse ? '\n    entries: Vec<EntryMeta>,' : ''}
    lex: LexStacks,
}
impl<H> Default for Workspace<H> {
    fn default() -> Self { Workspace { scratch: Vec::new(),${reuse ? ' entries: Vec::new(),' : ''} lex: LexStacks::default() } }
}

/// Parser-side span+handle frame. Span fields are independent of H (Pratt never reads H for spans).
#[derive(Clone, Copy)]
struct Spanned<H: Copy> { h: H, off: u32, tok_start: u32, present: bool }
impl<H: Copy> Spanned<H> {
    /// The root of an accepted parse. Accepting or rejecting is the parser's verdict, never the
    /// builder's, so a builder that kept no node for the entry rule breaks the contract (the
    /// built-in builders always keep the root): reported loudly, not as a reject.
    fn root(self) -> H { if !self.present { panic!("the builder kept no node for the root rule of an accepted parse (a Builder must return one for the entry rule)"); } self.h }
}
/// Where a construct that may have to undo what it tries starts: the position, the scratch length
/// and the builder's checkpoint. Parser::reset goes back to it.
#[derive(Clone, Copy)]
struct Mark { pos: usize, sb: usize, ck: (usize, usize) }
/// A node's children appended to the kids arena: a node has few (about two), so an element loop
/// printed at each finish, never a call (a generic \`extend\` is inlined or called at LLVM's choice,
/// which made each finish site's cost depend on the size of the function holding it).
#[inline(always)]
fn copy_kids(kids: &mut Vec<i32>, s: &[i32]) {
    kids.reserve(s.len());
    let n = kids.len();
    unsafe {
        let p = kids.as_mut_ptr().add(n);
        for i in 0..s.len() { p.add(i).write(*s.get_unchecked(i)); }
        kids.set_len(n + s.len());
    }
}
${CAND_MACRO_RS}

#[derive(Default)]
pub struct CstBuilder {
    pub nodes: Vec<Node>,
    pub kids: Vec<i32>,
    toks: Vec<Tok>,
    ws: Workspace<i32>,
}
impl CstBuilder {
    pub fn new() -> Self { Self::default() }
}
impl Builder for CstBuilder {
    type H = i32;
    #[inline(always)]
    fn toks(&self) -> Option<&Vec<Tok>> { Some(&self.toks) }
    #[inline(always)]
    fn toks_mut(&mut self) -> Option<&mut Vec<Tok>> { Some(&mut self.toks) }
    #[inline(always)]
    fn workspace_mut(&mut self) -> Option<&mut Workspace<i32>> { Some(&mut self.ws) }
    const SUPPORTS_SHIFT: bool = ${reuse ? 'true' : 'false'};
    const SUPPORTS_TREE_EQ: bool = true;
    #[inline(always)]
    fn dummy_h() -> i32 { 0 }
${reuse ? `    #[inline(always)]
    fn shift(&mut self, h: i32, byte_delta: isize, tok_delta: isize) -> i32 {
        if h < 0 {
            let (ti, tt) = decode_leaf(h);
            encode_leaf((ti as isize + tok_delta) as u32, tt)
        } else {
            shift_subtree(&mut self.nodes, &mut self.kids, h, byte_delta, tok_delta);
            h
        }
    }
    #[inline(always)]
    fn should_reclaim(&self, root: i32, baseline: usize) -> bool {
        should_reclaim_arena(&self.nodes, &self.kids, root, baseline)
    }
    #[inline(always)]
    fn arena_len(&self) -> usize { self.nodes.len() }
    #[inline(always)]
    fn root_kid_at(&self, root: i32, idx: usize) -> i32 {
        let old = &self.nodes[root as usize];
        self.kids[old.kid_start as usize + idx]
    }
    #[inline(always)]
    fn rule_id_of(&self, h: i32) -> u16 { self.nodes[h as usize].rule_id }
    #[inline(always)]
    fn validate_entries(&self, entries: &[EntryMeta], root: i32) {
        assert_entries_vs_${shapeB ? 'kids' : 'nodes'}(entries, &self.nodes, &self.kids, root);
    }
    #[inline(always)]
    fn check_tree_eq(&self, text: &str, root: Option<i32>) -> bool {
        check_tree_eq_arena(text, &self.toks, &self.nodes, &self.kids, root)
    }
` : `    #[inline(always)]
    fn arena_len(&self) -> usize { self.nodes.len() }
    #[inline(always)]
    fn check_tree_eq(&self, text: &str, root: Option<i32>) -> bool {
        check_tree_eq_arena(text, &self.toks, &self.nodes, &self.kids, root)
    }
`}    #[inline(always)]
    fn checkpoint(&self) -> (usize, usize) { (self.nodes.len(), self.kids.len()) }
    #[inline(always)]
    fn restore(&mut self, ck: (usize, usize)) { self.nodes.truncate(ck.0); self.kids.truncate(ck.1); }
    #[inline(always)]
    fn leaf(&mut self, scratch: &mut Vec<i32>, tt_id: u16, tok_idx: u32, _off: u32, _end: u32) -> bool {
        if tt_id == ${punctId} { return false; }
        scratch.push(encode_leaf(tok_idx, tt_id as u8));
        true
    }
    /// Byte-twin of Parser::finish (arena path): compute span, extend kids, push node, return id.
    #[inline(always)]
    fn finish(
        &mut self, scratch: &mut Vec<i32>, sb: usize, rule_id: u16,
        fallback_off: u32, tok_start: u32, tok_end: u32, toks: &[Tok],
    ) -> (i32, u32, bool) {
        let nn = scratch.len();
        let kid_start = self.kids.len();
        let (offset, end) = if nn > sb {
            let (o0, _) = Self::kid_off_end(&self.nodes, toks, scratch[sb]);
            let (_, e1) = Self::kid_off_end(&self.nodes, toks, scratch[nn - 1]);
            (o0, e1)
        } else {
            (fallback_off, fallback_off)
        };
        copy_kids(&mut self.kids, &scratch[sb..nn]);
        scratch.truncate(sb);
        self.nodes.push(Node { rule_id, kid_start: kid_start as u32, kid_count: (nn - sb) as u32, offset, end, tok_start, tok_end, ext: 0 });
        ((self.nodes.len() - 1) as i32, offset, true)
    }
    #[inline(always)]
    fn node(&mut self, scratch: &mut Vec<i32>, sb: usize, rule_id: u16, off: u32, end: u32, tok_start: u32, tok_end: u32) {
        let nn = scratch.len();
        let kid_start = self.kids.len();
        copy_kids(&mut self.kids, &scratch[sb..nn]);
        scratch.truncate(sb);
        self.nodes.push(Node { rule_id, kid_start: kid_start as u32, kid_count: (nn - sb) as u32, offset: off, end, tok_start, tok_end, ext: 0 });
        scratch.push((self.nodes.len() - 1) as i32);
    }
    #[inline(always)]
    fn span_of(&self, h: i32, toks: &[Tok]) -> (u32, u32) {
        Self::kid_off_end(&self.nodes, toks, h)
    }
    #[inline(always)]
    fn head_span(&self, h: i32, toks: &[Tok]) -> (u32, u32) {
        let mut id = h;
        loop {
            if id < 0 { let (ti, tt) = decode_leaf(id); return (toks[ti as usize].off, leaf_end(toks, ti, tt)); }
            let nd = &self.nodes[id as usize];
            if nd.kid_count == 0 { return (nd.offset, nd.end); }
            id = self.kids[nd.kid_start as usize];
        }
    }
    #[inline(always)]
    fn note_look(&mut self, h: i32, max_look: u32) {
        if h >= 0 {
            let nd = &mut self.nodes[h as usize];
            let mut ext = nd.tok_end;
            if max_look > ext { ext = max_look; }
            nd.ext = ext;
        }
    }
    #[inline(always)]
    fn entry_meta(&mut self, h: i32, max_look: u32, toks: &[Tok]) -> EntryMeta {
        if h < 0 {
            let (ti, _) = decode_leaf(h);
            let t = &toks[ti as usize];
            let tok_end = ti + 1;
            let mut ext = tok_end;
            if max_look > ext { ext = max_look; }
            EntryMeta { tok_start: ti, tok_end, ext, off: t.off, end: t.end, kid_start: 0, kid_count: 1 }
        } else {
            let nd = &mut self.nodes[h as usize];
            let mut ext = nd.tok_end;
            if max_look > ext { ext = max_look; }
            nd.ext = ext;
            EntryMeta { tok_start: nd.tok_start, tok_end: nd.tok_end, ext, off: nd.offset, end: nd.end, kid_start: 0, kid_count: 1 }
        }
    }
    #[inline(always)]
    fn tok_range(&self, h: i32) -> (u32, u32) {
        if h < 0 { let (ti, _) = decode_leaf(h); (ti, ti + 1) }
        else { let nd = &self.nodes[h as usize]; (nd.tok_start, nd.tok_end) }
    }
}
impl CstBuilder {
    #[inline(always)]
    fn kid_off_end(nodes: &[Node], toks: &[Tok], kid: i32) -> (u32, u32) {
        if kid < 0 { let (ti, tt) = decode_leaf(kid); (toks[ti as usize].off, leaf_end(toks, ti, tt)) }
        else { let nd = &nodes[kid as usize]; (nd.offset, nd.end) }
    }
}

#[derive(Default)]
pub struct SlimBuilder {
    pub nodes: Vec<Node>,
    pub kids: Vec<i32>,
    toks: Vec<Tok>,
    ws: Workspace<i32>,
}
impl SlimBuilder {
    pub fn new() -> Self { Self::default() }
}
impl Builder for SlimBuilder {
    type H = i32;
    #[inline(always)]
    fn toks(&self) -> Option<&Vec<Tok>> { Some(&self.toks) }
    #[inline(always)]
    fn toks_mut(&mut self) -> Option<&mut Vec<Tok>> { Some(&mut self.toks) }
    #[inline(always)]
    fn workspace_mut(&mut self) -> Option<&mut Workspace<i32>> { Some(&mut self.ws) }
    #[inline(always)]
    fn dummy_h() -> i32 { 0 }
    #[inline(always)]
    fn arena_len(&self) -> usize { self.nodes.len() }
    #[inline(always)]
    fn rule_id_of(&self, h: i32) -> u16 { if h < 0 { 0 } else { self.nodes[h as usize].rule_id } }
    #[inline(always)]
    fn root_kid_at(&self, root: i32, idx: usize) -> i32 {
        let old = &self.nodes[root as usize];
        self.kids[old.kid_start as usize + idx]
    }
    #[inline(always)]
    fn checkpoint(&self) -> (usize, usize) { (self.nodes.len(), self.kids.len()) }
    #[inline(always)]
    fn restore(&mut self, ck: (usize, usize)) { self.nodes.truncate(ck.0); self.kids.truncate(ck.1); }
    #[inline(always)]
    fn leaf(&mut self, scratch: &mut Vec<i32>, tt_id: u16, tok_idx: u32, _off: u32, _end: u32) -> bool {
        match tt_id { ${slimDropMatch} => return false, _ => {} }
        if tt_id == ${punctId} { return false; }
        scratch.push(encode_leaf(tok_idx, tt_id as u8));
        true
    }
    #[inline(always)]
    fn node(&mut self, scratch: &mut Vec<i32>, sb: usize, rule_id: u16, off: u32, end: u32, tok_start: u32, tok_end: u32) {
        let nn = scratch.len();
        let count = nn - sb;
        if count == 1 { return; }
        // The root keeps its node with no child: an accepted parse always has a root (parse_with).
        if count == 0 && rule_id != ${ruleIdOf(ar, ir.entry)} { scratch.truncate(sb); return; }
        let kid_start = self.kids.len();
        copy_kids(&mut self.kids, &scratch[sb..nn]);
        scratch.truncate(sb);
        self.nodes.push(Node { rule_id, kid_start: kid_start as u32, kid_count: count as u32, offset: off, end, tok_start, tok_end, ext: 0 });
        scratch.push((self.nodes.len() - 1) as i32);
    }
    #[inline(always)]
    fn span_of(&self, h: i32, toks: &[Tok]) -> (u32, u32) {
        if h < 0 { let (ti, tt) = decode_leaf(h); (toks[ti as usize].off, leaf_end(toks, ti, tt)) }
        else { let nd = &self.nodes[h as usize]; (nd.offset, nd.end) }
    }
    #[inline(always)]
    fn head_span(&self, h: i32, toks: &[Tok]) -> (u32, u32) {
        let mut id = h;
        loop {
            if id < 0 { let (ti, tt) = decode_leaf(id); return (toks[ti as usize].off, leaf_end(toks, ti, tt)); }
            let nd = &self.nodes[id as usize];
            if nd.kid_count == 0 { return (nd.offset, nd.end); }
            id = self.kids[nd.kid_start as usize];
        }
    }
    #[inline(always)]
    fn tok_range(&self, h: i32) -> (u32, u32) {
        if h < 0 { let (ti, _) = decode_leaf(h); (ti, ti + 1) }
        else { let nd = &self.nodes[h as usize]; (nd.tok_start, nd.tok_end) }
    }
}

struct Parser<'a, B: Builder = CstBuilder> {
    toks: Vec<Tok>,
    pos: usize,
    /// One past the furthest token the current entry's parse has examined, as far as recorded:
    /// a read past the current token (second_in, a composed '>') records here at once; a peek
    /// records in peek_end, which back() and look_end() fold in.
    max_look: usize,
    /// One past the token of the latest peek. Between two moves back the position only grows,
    /// so the latest peek is the furthest one since the last move back.
    peek_end: usize,
    capped: bool,
    /// Assignment-target form of the node the last nud/bp call returned.
    form: u8,
    /// Whether the node the last nud call returned closes the access tail.
    tail: bool,
    /// Indices into the grammar's suppress sets (ParserIR.suppressSets; 0 = none): the set a
    /// \`suppress\` step stages for the next Pratt call, and the set in force in the current one.
    suppress_next: u16,
    suppress_cur: u16,
    /// The [Await]/[Yield] context word in force (bit 1 await, bit 2 yield; see ParserIR's Ctx).
    /// A \`ctx\` step sets it for its body and puts back what it found, so outside every such body it is 0.
    ctx: u8,
    src: &'a str,
    b: B,
    scratch: Vec<B::H>,${entriesField}
}

${tokenSetRuntimeRust(ir, ids)}
impl<'a, B: Builder> Parser<'a, B> {
    #[inline(always)]
    fn peek(&mut self) -> Option<Tok> {
        self.peek_end = self.pos + 1;
        if self.pos < self.toks.len() { Some(self.toks[self.pos]) } else { None }
    }
    /// Move the position back to sp (sp <= pos), first folding the stretch being abandoned into
    /// max_look: the furthest token it peeked at is the latest peek.
    #[inline(always)]
    fn back(&mut self, sp: usize) {
        if self.peek_end > self.max_look { self.max_look = self.peek_end; }
        self.pos = sp;
    }
    /// One past the furthest token the current entry examined: max_look and the stretch since
    /// the last move back.
    #[inline(always)]
    fn look_end(&self) -> usize { if self.peek_end > self.max_look { self.peek_end } else { self.max_look } }
    /// Start recording an entry's extent.
    #[inline(always)]
    fn look_reset(&mut self) { self.max_look = 0; self.peek_end = 0; }
    /// A NUD that matched nothing, from its commit switch: the state its frame leaves then (prattRule's nudClose).
    #[inline(always)]
    #[allow(dead_code)]
    fn nud_none(&mut self) -> Option<Spanned<B::H>> { self.capped = false; self.form = 0; self.tail = false; None }
    #[inline(always)]
    fn mark(&self) -> Mark { Mark { pos: self.pos, sb: self.scratch.len(), ck: self.b.checkpoint() } }
    /// Undo everything since m: the position (as back), the scratch list and the builder.
    #[inline(always)]
    fn reset(&mut self, m: Mark) { self.back(m.pos); self.scratch.truncate(m.sb); self.b.restore(m.ck); }
    #[inline(always)]
    #[allow(dead_code)]
    fn ahead(&mut self, k: usize, is: bool) -> bool { match self.peek() { Some(t) => in_token_set(k, &t) == is, None => !is } }
    #[inline(always)]
    #[allow(dead_code)]
    /// Whether the next token is a word the context in force reserves; outside every context it reads nothing.
    fn ctx_word(&mut self) -> bool { self.ctx != 0 && match self.peek() { Some(t) => in_ctx_words(self.ctx, &t), None => false } }
    /// Whether the token after the current one is in token set k (a longest-match candidate's SECOND guard).
    #[inline(always)]
    #[allow(dead_code)]
    fn second_in(&mut self, k: usize) -> bool {
        let i = self.pos + 1;
        if i + 1 > self.max_look { self.max_look = i + 1; }
        i < self.toks.len() && in_token_set(k, &self.toks[i])
    }
    #[inline(always)]
    fn off_at(&self, i: usize) -> usize { if i < self.toks.len() { self.toks[i].off as usize } else { 0 } }
    #[inline(always)]
    fn push_leaf(&mut self, tt_id: u16, tok_idx: u32, off: u32, end: u32) {
        let _ = self.b.leaf(&mut self.scratch, tt_id, tok_idx, off, end);
    }
    #[inline(always)]
    fn finish(&mut self, rule_id: u16, sb: usize, fallback_off: usize, tok_start: usize) -> Spanned<B::H> {
        let (h, off, present) = self.b.finish(
            &mut self.scratch, sb, rule_id, fallback_off as u32, tok_start as u32, self.pos as u32, &self.toks,
        );
        Spanned { h, off, tok_start: tok_start as u32, present }
    }
    #[inline(always)]
    fn head_leaf_text(&self, f: &Spanned<B::H>) -> &'a str {
        if !f.present { return ""; }
        let (a, b) = self.b.head_span(f.h, &self.toks);
        let a = a as usize; let b = b as usize;
        if a <= b && b <= self.src.len() { &self.src[a..b] } else { "" }
    }
    #[inline(always)]
    fn nll_blocked(&self, words: &[&str], left: &Spanned<B::H>) -> bool {
        let h = self.head_leaf_text(left); words.iter().any(|w| *w == h)
    }
    #[inline(always)]
    fn match_lit(&mut self, lid: u16) -> bool {
        match self.peek() {
            Some(t) if t.lid == lid => { self.push_leaf(if lid >= LID_KW { ${ttIdOf(ar, '$keyword')} } else { ${punctId} }, self.pos as u32, t.off, t.end); self.pos += 1; true }
            _ => false
        }
    }
    /// Match a composite '>'-led literal (a lookahead operand; never a tree leaf).
    #[inline(always)]
    fn match_comp(&mut self, lid: u16) -> bool {
        if self.peek().is_none() { return false; }
        let (c, n, _) = gt_op(&self.toks, self.pos);
        if c != lid { return false; }
        if self.pos + n + 1 > self.max_look { self.max_look = self.pos + n + 1; }
        self.pos += n;
        true
    }
    /// The binary operator read at pos (t = toks[pos]): its lid, token count and end offset. A '>'
    /// read counts the tokens it inspected toward max_look.
    #[inline(always)]
    fn op_read(&mut self, t: Tok) -> (u16, usize, u32) {
        if t.lid != GT_LID { return (t.lid, 1, t.end); }
        let r = gt_op(&self.toks, self.pos);
        if self.pos + r.1 + 1 > self.max_look { self.max_look = self.pos + r.1 + 1; }
        r
    }
    #[inline(always)]
    /// A token kind's leaf type id is its kid (ArenaIdPlan: TT_NAMES starts with the kids).
    fn match_tok(&mut self, kid: u16) -> bool {
        match self.peek() {
            Some(t) if t.kid == kid => { self.push_leaf(kid, self.pos as u32, t.off, t.end); self.pos += 1; true }
            _ => false
        }
    }
    #[inline(always)]
    fn call_rule(&mut self, f: fn(&mut Parser<'a, B>) -> Option<Spanned<B::H>>) -> bool {
        match f(self) {
            Some(fr) => { if fr.present { self.scratch.push(fr.h); } true }
            None => false
        }
    }
    #[inline(always)]
    fn star(&mut self, once: fn(&mut Parser<'a, B>) -> bool) -> bool {
        loop {
            let m = self.mark();
            if !once(self) { self.reset(m); break; }
        }
        true
    }
    #[inline(always)]
    fn opt(&mut self, body: fn(&mut Parser<'a, B>) -> bool) -> bool {
        let m = self.mark();
        if !body(self) { self.reset(m); }
        true
    }
    #[inline(always)]
    fn sep_by(&mut self, elem: fn(&mut Parser<'a, B>) -> bool, delim: u16) -> bool {
        let m0 = self.mark();
        if !elem(self) { self.reset(m0); return true; }
        loop {
            if !self.match_lit(delim) { break; } // a failed delimiter match changes nothing: no mark before it
            let m2 = self.mark();
            if !elem(self) { self.reset(m2); break; }
        }
        true
    }
    // The guarded forms: the body is attempted only where the next token is in tokenSets[k]. Out of
    // line and generic over the body, so each site is its own small function with the body inlined.
    #[inline(never)]
    #[allow(dead_code)]
    fn star_in<F: Fn(&mut Self) -> bool>(&mut self, k: usize, once: F) -> bool {
        while self.ahead(k, true) {
            let m = self.mark();
            if !once(self) { self.reset(m); break; }
        }
        true
    }
    // The attempt of a guarded opt / sep whose guard the caller tested: out of line, per site.
    #[inline(never)]
    #[allow(dead_code)]
    fn opt_out<F: Fn(&mut Self) -> bool>(&mut self, body: F) -> bool {
        let m = self.mark(); if !body(self) { self.reset(m); } true
    }
    #[inline(never)]
    #[allow(dead_code)]
    fn sep_by_out<F: Fn(&mut Self) -> bool>(&mut self, elem: F, delim: u16) -> bool {
        let m0 = self.mark();
        if !elem(self) { self.reset(m0); return true; }
        loop {
            if !self.match_lit(delim) { break; } // a failed delimiter match changes nothing: no mark before it
            let m2 = self.mark();
            if !elem(self) { self.reset(m2); break; }
        }
        true
    }
    #[inline(never)]
    #[allow(dead_code)]
    fn opt_out_r<F: Fn(&mut Self) -> bool>(&mut self, body: F) -> bool {
        let sp = self.pos; if !body(self) { self.back(sp); } true
    }
    #[inline(never)]
    #[allow(dead_code)]
    fn sep_by_out_r<F: Fn(&mut Self) -> bool>(&mut self, elem: F, delim: u16) -> bool {
        let sp0 = self.pos;
        if !elem(self) { self.back(sp0); return true; }
        loop {
            if !self.match_lit_r(delim) { break; } // a failed delimiter match changes nothing: no mark before it
            let sp2 = self.pos;
            if !elem(self) { self.back(sp2); break; }
        }
        true
    }
    #[inline(never)]
    #[allow(dead_code)]
    fn star_in_r<F: Fn(&mut Self) -> bool>(&mut self, k: usize, once: F) -> bool {
        while self.ahead(k, true) { let sp = self.pos; if !once(self) { self.back(sp); break; } }
        true
    }
    // A clean body (Step.clean) leaves no trace when it fails: no mark, nothing to undo; the same
    // code builds or recognizes (the body is the form's own), except a delimiter's match.
    #[inline(always)]
    #[allow(dead_code)]
    fn star_c(&mut self, once: fn(&mut Parser<'a, B>) -> bool) -> bool { while once(self) {} true }
    #[inline(always)]
    #[allow(dead_code)]
    fn opt_c(&mut self, body: fn(&mut Parser<'a, B>) -> bool) -> bool { body(self); true }
    #[inline(always)]
    #[allow(dead_code)]
    fn sep_by_c(&mut self, elem: fn(&mut Parser<'a, B>) -> bool, delim: u16) -> bool {
        if elem(self) { while self.match_lit(delim) && elem(self) {} }
        true
    }
    #[inline(always)]
    #[allow(dead_code)]
    fn sep_by_c_r(&mut self, elem: fn(&mut Parser<'a, B>) -> bool, delim: u16) -> bool {
        if elem(self) { while self.match_lit_r(delim) && elem(self) {} }
        true
    }
    #[inline(never)]
    #[allow(dead_code)]
    fn star_in_c<F: Fn(&mut Self) -> bool>(&mut self, k: usize, once: F) -> bool {
        while self.ahead(k, true) && once(self) {}
        true
    }
    #[inline(never)]
    #[allow(dead_code)]
    fn opt_out_c<F: Fn(&mut Self) -> bool>(&mut self, body: F) -> bool { body(self); true }
    #[inline(never)]
    #[allow(dead_code)]
    fn sep_by_out_c<F: Fn(&mut Self) -> bool>(&mut self, elem: F, delim: u16) -> bool {
        if elem(self) { while self.match_lit(delim) && elem(self) {} }
        true
    }
    #[inline(never)]
    #[allow(dead_code)]
    fn sep_by_out_c_r<F: Fn(&mut Self) -> bool>(&mut self, elem: F, delim: u16) -> bool {
        if elem(self) { while self.match_lit_r(delim) && elem(self) {} }
        true
    }
    #[inline(always)]
    fn alt_lit(&mut self, lids: &[u16]) -> bool {
        for lid in lids { if self.match_lit(*lid) { return true; } }
        false
    }
    // The recognize forms (ParserIR.forms): the same tokens examined, nothing built.
    #[inline(always)]
    #[allow(dead_code)]
    fn match_lit_r(&mut self, lid: u16) -> bool {
        match self.peek() { Some(t) if t.lid == lid => { self.pos += 1; true } _ => false }
    }
    #[inline(always)]
    #[allow(dead_code)]
    fn match_tok_r(&mut self, kid: u16) -> bool {
        match self.peek() { Some(t) if t.kid == kid => { self.pos += 1; true } _ => false }
    }
    #[inline(always)]
    #[allow(dead_code)]
    fn star_r(&mut self, once: fn(&mut Parser<'a, B>) -> bool) -> bool {
        loop { let sp = self.pos; if !once(self) { self.back(sp); break; } }
        true
    }
    #[inline(always)]
    #[allow(dead_code)]
    fn opt_r(&mut self, body: fn(&mut Parser<'a, B>) -> bool) -> bool {
        let sp = self.pos; if !body(self) { self.back(sp); } true
    }
    #[inline(always)]
    #[allow(dead_code)]
    fn sep_by_r(&mut self, elem: fn(&mut Parser<'a, B>) -> bool, delim: u16) -> bool {
        let sp0 = self.pos;
        if !elem(self) { self.back(sp0); return true; }
        loop {
            if !self.match_lit_r(delim) { break; } // a failed delimiter match changes nothing: no mark before it
            let sp2 = self.pos;
            if !elem(self) { self.back(sp2); break; }
        }
        true
    }
    #[inline(always)]
    #[allow(dead_code)]
    fn alt_lit_r(&mut self, lids: &[u16]) -> bool {
        for lid in lids { if self.match_lit_r(*lid) { return true; } }
        false
    }

${matchTemplate}${lookFns(ir, ids, ar)}${sharedFns(ir, ids, ar)}${ruleFns}
}
`;
}

function emitParseWithHelpers(ir: ParserIR, shapeB: boolean): string {
  const reuse = !!ir.reuse;
  return `
pub fn parse_with<'a, B: Builder + Default>(src: &'a str, b: &mut B) -> Option<B::H> {
    // A builder that parsed before is reused: its token buffer, arena and workspace are emptied
    // (capacity kept), so nothing of the previous parse stays reachable and nothing is allocated
    // again. The guard hands them back to the builder when the parse ends, also by a panic (input
    // the lexer cannot tokenize), so a rejected parse does not cost the next one its buffers
    // (except the lexer's two small stacks after a lexer panic: see LexStacks).
    let toks = b.toks_mut().map(std::mem::take).unwrap_or_default();
    let ws = b.workspace_mut().map(std::mem::take).unwrap_or_default();
    b.restore((0, 0));
    let owned = std::mem::take(b);
    let mut g = ParseGuard { home: b, lex: ws.lex, p: Parser { toks, pos: 0, max_look: 0, peek_end: 0, capped: false, form: 0, tail: false, suppress_next: 0, suppress_cur: 0, ctx: 0, src, b: owned, scratch: ws.scratch${reuse ? ', entries: ws.entries' : ''} } };
    let p = &mut g.p;
    if let Some(e) = lex_into(src, &mut p.toks, &mut g.lex) { panic!("{}", lex_error(src, e).msg); }
    p.scratch.clear();
    let root = match p.parse_${ir.entry}() {
        Some(fr) if p.pos == p.toks.len() => Some(fr.root()),
        _ => None,
    };
    root
}

/// Returns a parse's buffers to the builder parse_with took them from, when the parse ends.
struct ParseGuard<'x, 'a, B: Builder + Default> { home: &'x mut B, lex: LexStacks, p: Parser<'a, B> }
impl<'x, 'a, B: Builder + Default> Drop for ParseGuard<'x, 'a, B> {
    fn drop(&mut self) {
        *self.home = std::mem::take(&mut self.p.b);
        if let Some(t) = self.home.toks_mut() { *t = std::mem::take(&mut self.p.toks); }
        if let Some(w) = self.home.workspace_mut() {
            w.scratch = std::mem::take(&mut self.p.scratch);${reuse ? '\n            w.entries = std::mem::take(&mut self.p.entries);' : ''}
            w.lex = std::mem::take(&mut self.lex);
        }
    }
}

pub fn cst_json_with(b: &CstBuilder, root: i32) -> String {
    let mut out = String::new();
    write_json_arena(&b.nodes, &b.kids, &b.toks, root, &mut out);
    out
}

pub fn slim_json_with(b: &SlimBuilder, root: i32) -> String {
    let mut out = String::new();
    write_json_arena(&b.nodes, &b.kids, &b.toks, root, &mut out);
    out
}
`;
}

// ─── Shape AST codegen (SH3-1: RD full constructs + toy-scale Pratt) ──────────

type RustShapeUnionMember = { variant: string; ty: string; boxed: boolean };
type RustShapeUnion = { name: string; alias?: string; members: RustShapeUnionMember[] };

function rustShapeIdent(name: string): string {
  const out = name.replace(/[^A-Za-z0-9_]/g, '_');
  return /^[0-9]/.test(out) ? `_${out}` : out;
}

function rustShapeUnionName(ruleName: string): string {
  return `${rustShapeIdent(ruleName)}Shape`;
}

function rustShapeScalar(fn: string): string {
  if (fn === 'number') return 'f64';
  if (fn === 'boolean') return 'bool';
  return 'String';
}

function rustShapeHint(hint: string | string[] | undefined, known?: Set<string>): string {
  const h = Array.isArray(hint) ? hint[0] : hint;
  if (!h || h === 'unknown') return 'AstValue';
  if (h === 'string' || h === 'Identifier') return 'String';
  if (h === 'number' || h === 'Number') return 'f64';
  if (h === 'boolean' || h === 'Boolean') return 'bool';
  const id = rustShapeIdent(h);
  const shape = `${id}Shape`;
  if (known?.has(id)) return id;
  if (known?.has(shape)) return shape;
  return 'AstValue';
}

function rustShapeFieldType(field: FieldDecl, known?: Set<string>): string {
  let ty = field.bind === 'opText' ? 'String' : rustShapeHint(field.typeHint, known);
  const isList = typeof field.bind === 'object' && 'from' in field.bind && field.bind.from === 'list';
  const scalar = ty === 'String' || ty === 'f64' || ty === 'bool' || ty === 'AstValue';
  if (isList) ty = `Vec<${ty}>`;
  else if (!scalar) ty = `Box<${ty}>`;
  if (field.optional) ty = `Option<${ty}>`;
  return ty;
}

function rustLeafDropped(ttype: string, leaves: Record<string, TokenLeafPolicy>): boolean {
  return leaves[ttype]?.action === 'drop';
}

function collectRustShapeNodes(shapeIR: ShapeIR): Map<string, NodeShape> {
  const out = new Map<string, NodeShape>();
  const walk = (shape: RuleShape): void => {
    if (shape.kind === 'node') out.set(shape.type, shape);
    else if (shape.kind === 'choice') for (const arm of shape.arms) walk(arm.shape);
    else if (shape.kind === 'pratt') {
      for (const key of ['atom', 'group', 'nudSeq', 'nudCapped', 'prefix', 'binary', 'postfix', 'led', 'postfixTok', 'template'] as const) {
        const slot = shape[key];
        if (slot && typeof slot === 'object' && 'kind' in slot && slot.kind !== 'rule') walk(slot as RuleShape);
      }
    }
  };
  for (const rule of shapeIR.rules) walk(rule.shape);
  return out;
}

function rustShapeUnions(shapeIR: ShapeIR): RustShapeUnion[] {
  const out: RustShapeUnion[] = [];
  const aliasesUsed = new Set<string>();
  for (const rule of shapeIR.rules) {
    if (rule.shape.kind === 'choice') {
      const members: RustShapeUnionMember[] = [];
      const seen = new Set<string>();
      for (const arm of rule.shape.arms) {
        const member: RustShapeUnionMember = arm.shape.kind === 'node'
          ? { variant: rustShapeIdent(arm.shape.type), ty: rustShapeIdent(arm.shape.type), boxed: true }
          : { variant: rustShapeIdent(arm.name), ty: 'AstValue', boxed: false };
        if (!seen.has(member.variant)) {
          seen.add(member.variant);
          members.push(member);
        }
      }
      let alias: string | undefined;
      if (rule.name === 'Stmt' && !aliasesUsed.has('Statement')) {
        alias = 'Statement';
        aliasesUsed.add('Statement');
      }
      out.push({ name: rustShapeUnionName(rule.name), alias, members });
    } else if (rule.shape.kind === 'pratt') {
      const members: RustShapeUnionMember[] = [];
      for (const tok of (portableRule(shapeIR, rule.name) as PrattRule).nudToks) {
        const policy = shapeIR.leaves[tok];
        if (policy?.action === 'leafValue') {
          members.push({ variant: rustShapeIdent(tok), ty: rustShapeScalar(policy.fn), boxed: false });
        }
      }
      for (const slot of [rule.shape.prefix, rule.shape.binary, rule.shape.postfix]) {
        if (slot?.kind === 'node' && !members.some((m) => m.variant === rustShapeIdent(slot.type))) {
          members.push({ variant: rustShapeIdent(slot.type), ty: rustShapeIdent(slot.type), boxed: true });
        }
      }
      members.push({ variant: 'Keep', ty: 'AstValue', boxed: false });
      let alias: string | undefined;
      if (rule.name === 'Expr' && !aliasesUsed.has('Expression')) {
        alias = 'Expression';
        aliasesUsed.add('Expression');
      }
      out.push({
        name: rustShapeUnionName(rule.name),
        alias,
        members,
      });
    }
  }
  return out;
}

let _rustShapeParserIR: ParserIR | null = null;
function portableRule(_shapeIR: ShapeIR, name: string): RdRule | PrattRule {
  const rule = _rustShapeParserIR?.rules.find((r) => r.name === name);
  if (!rule) throw new Error(`shape rust emit: missing IR rule ${name}`);
  return rule;
}

// ── Step-level FIRST pre-filters (SH3-5 O5) ────────────────────────────────
// Per-rule leading FIRST (null = unknown/unpredictable), built once per emit.
// Soundness: a rule with a known FIRST is NON-nullable — a nullable alt is
// always seqFirst-unpredictable (null), which poisons the union. Guards are
// therefore pure pre-filters: reject ⇒ the walk would have failed anyway.
let _rustShapeRuleFirst: Map<string, FirstSig> | null = null;

/** FIRST of a step sequence (sound superset; null = unknown → no guard). */
function rustShapeFirstOfSteps(steps: Step[]): FirstSig {
  const rf = _rustShapeRuleFirst;
  if (!rf) return null;
  const lits = new Set<string>();
  const toks = new Set<string>();
  // 'done' = a consuming step fixed the FIRST; 'nullable' = may derive ε (keep
  // folding into the next step); 'unknown' = give up (null).
  const walkSeq = (xs: Step[]): 'done' | 'nullable' | 'unknown' => {
    for (const s of xs) {
      const r = walkStep(s);
      if (r !== 'nullable') return r;
    }
    return 'nullable';
  };
  const walkStep = (s: Step): 'done' | 'nullable' | 'unknown' => {
    switch (s.t) {
      case 'lit': lits.add(s.value); return 'done';
      case 'tok': toks.add(s.name); return 'done';
      case 'altlit': s.opts.forEach((o) => lits.add(o.value)); return 'done';
      case 'rule':
      case 'ruleBp': {
        const f = rf.get(s.name);
        if (f == null) return 'unknown';
        f.lits.forEach((x) => lits.add(x));
        f.toks.forEach((x) => toks.add(x));
        return 'done';
      }
      case 'seq':
      case 'suppress':
      case 'ctx': return walkSeq(s.steps);
      case 'look':
      case 'ahead':
      case 'aheadCtx':
      case 'sameLine': return 'nullable'; // zero-width: consumes nothing
      case 'opt': return walkSeq(s.steps) === 'unknown' ? 'unknown' : 'nullable';
      case 'star': return walkSeq([s.step]) === 'unknown' ? 'unknown' : 'nullable';
      case 'sep': return walkStep(s.elem) === 'unknown' ? 'unknown' : 'nullable';
      case 'alt': {
        let sawBranch = false;
        for (const b of s.branches) {
          const r = walkSeq(b);
          if (r === 'unknown') return 'unknown';
          if (r === 'done') sawBranch = true;
        }
        // all-nullable (or empty) alt contributes its FIRST and stays nullable
        return sawBranch ? 'done' : 'nullable';
      }
    }
    return 'unknown';
  };
  const r = walkSeq(steps);
  // Fully-nullable seqs (derive ε) would succeed even when the guard rejects
  // (star/sep semantics diverge), so they get no guard.
  if (r === 'unknown' || r === 'nullable') return null;
  return { lits: [...lits], toks: [...toks] };
}

/** Build per-rule leading FIRST for all parser rules (rd unions + pratt nud). */
function buildRustShapeRuleFirst(ir: ParserIR): Map<string, FirstSig> {
  const out = new Map<string, FirstSig>();
  for (const rule of ir.rules) {
    if (rule.kind === 'rd') {
      // A predictive rule's alternatives by their switch keys, any other's by their guards.
      const firsts: FirstSig[] = rule.predictive ? rule.altFirst : rule.altGuard.map((g) => g && g.first);
      if (firsts.some((f) => f === null)) {
        out.set(rule.name, null);
        continue;
      }
      const lits = new Set<string>();
      const toks = new Set<string>();
      for (const f of firsts) {
        f!.lits.forEach((x) => lits.add(x));
        f!.toks.forEach((x) => toks.add(x));
      }
      out.set(rule.name, { lits: [...lits], toks: [...toks] });
      continue;
    }
    // pratt: a parse must nud — leading FIRST is the nud dispatch set.
    const lits = new Set<string>();
    const toks = new Set<string>();
    let unknown = false;
    for (const t of rule.nudToks) toks.add(t);
    for (const p of rule.prefix) lits.add(p.op);
    for (const b of rule.nudBrackets) lits.add(b.first);
    for (const f of [...rule.nudSeqGuard, ...rule.nudCappedGuard].map((g) => g && g.first)) {
      if (f === null) { unknown = true; break; }
      f.lits.forEach((x) => lits.add(x));
      f.toks.forEach((x) => toks.add(x));
    }
    if (!unknown && ir.tpl && rule.nudToks.includes(ir.tpl.token)) toks.add('$templateHead');
    out.set(rule.name, unknown ? null : { lits: [...lits], toks: [...toks] });
  }
  return out;
}


function rustShapeRuleType(rule: ShapeIRRule): string {
  // Runtime is AstValue-centric (RD kids / keep / unknown). Typed structs remain for API docs + gates.
  return 'AstValue';
}

function rustShapeSpanFields(spans: ShapeSpec['spans']): string {
  if (spans === 'none') return '';
  const ty = spans === 'optional' ? 'Option<usize>' : 'usize';
  return `\n    pub off: ${ty},\n    pub end: ${ty},`;
}

/** M-A1.4-S5: streaming node completion — push the structure event and return
 *  the node's source span as the placeholder value. ledNotLeftLeaf guards read
 *  shape_head_text(left): the span text matches the tree-mode head-text for
 *  leaf atoms (e.g. `void` in `void##x`), keeping accept decisions identical. */
function rustStreamFinish(typ: string, offExpr: string, endExpr: string, alt = '0'): string {
  return `{
            let __so = (${offExpr}) as usize;
            let __se = (${endExpr}) as usize;
            if self.emit_events { self.events.push(StreamEvent { id: self.events.len() as u32, typ: ${typ}, alt: ${alt}, off: __so as u32, end: __se as u32 }); }
            SVal::Str(__so as u32, (__se - __so) as u32)
        }`;
}

function rustShapeNodeObjectExpr(
  node: NodeShape,
  _baseExpr: string,
  _opExpr: string,
  _spans: ShapeSpec['spans'],
  offExpr: string,
  endExpr: string,
  _leftExpr?: string,
): string {
  // M-A1.2/S5: streaming-only — node completion emits the structure event
  // (field computation and DynObj construction were tree-mode, removed).
  return rustStreamFinish(J(node.type), offExpr, endExpr);
}

function emitRustShapeTypes(ir: ParserIR, shapeIR: ShapeIR): string {
  _rustShapeParserIR = ir;
  _rustShapeParserIR = null;
  const lines: string[] = [
    '// ─── Shape AST runtime (arena values, SH3-6) ──────────────────────────────',
    'fn _shape_json_string(value: &str, out: &mut String) {',
    "    out.push('\"');",
    '    for c in value.chars() { match c {',
    "        '\"' => out.push_str(\"\\\\\\\"\"), '\\\\' => out.push_str(\"\\\\\\\\\"), '\\n' => out.push_str(\"\\\\n\"),",
    "        '\\r' => out.push_str(\"\\\\r\"), '\\t' => out.push_str(\"\\\\t\"), c if c < ' ' => out.push_str(&format!(\"\\\\u{:04x}\", c as u32)),",
    '        c => out.push(c),',
    '    }}',
    "    out.push('\"');",
    '}',
    '// Arena value: every variant Copy — speculative truncate on restore runs no',
    '// drop glue. M15 slim: Str is a (off, len) span into AstArena.src, not a',
    '// borrowed slice — the enum drops from 24B to 16B (max payload 8B).',
    '#[derive(Clone, Copy, Debug)]',
    "pub enum SVal<'a> {",
    '    Null,',
    '    Bool(bool),',
    '    Number(f64),',
    '    /// (byte offset, byte length) into AstArena.src.',
    '    Str(u32, u32),',
    '    OwnStr(u32),',
    '    Node(u32),',
    '    List(u32, u32),',
    '    /// Packed TNode range into AstArena.node_lists (each element = (tag<<24)|idx).',
    '    /// Only lists whose elements are ALL TNode use this slab — 4B/element vs 16B.',
    '    NodeList(u32, u32),',
    '    Partial(u32),',
    '    /// Typed custom node: (customs type tag, index into the customs-owned arena).',
    '    /// JSON is written via ShapeCustoms::write_tnode_json (M2 typed direct-emit).',
    '    TNode(u16, u32),',
    '    /// Keeps the (now payload-less) lifetime parameter occupied: every existing',
    '    /// SVal<\'a> signature stays valid. ZST — size is still 16B.',
    '    #[doc(hidden)]',
    "    _Marker(std::marker::PhantomData<&'a ()>),",
    '}',
    '#[derive(Debug)]',
    "struct DynObj { typ: &'static str, fields: (u32, u32) }",
    '#[derive(Clone, Copy, Debug)]',
    "struct PartialRec<'a> { tag: &'static str, mode: &'static str, value: SVal<'a> }",
    '#[derive(Debug, Default)]',
    "pub struct AstArena<'a> {",
    "    /// Source text every SVal::Str span indexes into (M15). Default \"\" —",
    '    /// any Str read on a default-built arena fails loud (out of bounds).',
    "    pub src: &'a str,",
    "    pub lists: Vec<SVal<'a>>,",
    "    pub node_lists: Vec<u32>,",
    "    pub fields: Vec<(&'static str, SVal<'a>)>,",
    '    nodes: Vec<DynObj>,',
    "    partials: Vec<PartialRec<'a>>,",
    '    /// Monotonic count of mk_partial calls (never decremented, even on txn',
    '    /// rollback). Zero means no Partial marker exists anywhere in the arena —',
    '    /// shape_fold_kids can skip its recursive has_partial scan (M21).',
    '    pub partial_count: usize,',
    '    strings: Vec<String>,',
    '}',
    "impl<'a> AstArena<'a> {",
    "    pub fn mk_own_str(&mut self, s: &str) -> SVal<'a> { self.strings.push(s.to_owned()); SVal::OwnStr((self.strings.len() - 1) as u32) }",
    "    pub fn mk_partial(&mut self, tag: &'static str, mode: &'static str, value: SVal<'a>) -> SVal<'a> { self.partial_count += 1; self.partials.push(PartialRec { tag, mode, value }); SVal::Partial((self.partials.len() - 1) as u32) }",
    "    pub fn typ_of(&self, v: SVal<'a>) -> &'static str { if let SVal::Node(i) = v { self.nodes[i as usize].typ } else { \"\" } }",
    "    pub fn fields_of(&self, v: SVal<'a>) -> &[(&'static str, SVal<'a>)] {",
    '        if let SVal::Node(i) = v {',
    '            let (fs, fl) = self.nodes[i as usize].fields;',
    '            &self.fields[fs as usize..(fs + fl) as usize]',
    '        } else { &[] }',
    '    }',
    "    pub fn list_of(&self, v: SVal<'a>) -> &[SVal<'a>] {",
    '        if let SVal::List(s, l) = v { &self.lists[s as usize..(s + l) as usize] } else { &[] }',
    '    }',
    "    pub fn obj_field(&self, v: SVal<'a>, name: &'static str) -> SVal<'a> {",
    '        self.fields_of(v).iter().find(|(k, _)| *k == name).map(|(_, x)| *x).unwrap_or(SVal::Null)',
    '    }',
    "    pub fn fields_range_of(&self, v: SVal<'a>) -> (usize, usize) {",
    '        if let SVal::Node(i) = v { let (fs, fl) = self.nodes[i as usize].fields; (fs as usize, fl as usize) } else { (0, 0) }',
    '    }',
    "    /// Span → source slice (M15). The slice keeps the source lifetime 'a,",
    '    /// unlike str_of which reborrows through &self.',
    "    pub fn str_span(&self, off: u32, len: u32) -> &'a str {",
    '        &self.src[off as usize..(off + len) as usize]',
    '    }',
    "    pub fn str_of(&self, v: SVal<'a>) -> &str {",
    '        match v {',
    '            SVal::Str(o, l) => &self.src[o as usize..(o + l) as usize],',
    '            SVal::OwnStr(i) => &self.strings[i as usize],',
    '            _ => "",',
    '        }',
    '    }',
    '}',
    'fn write_sval_json<\'a, C: ShapeCustoms<\'a>>(ar: &AstArena<\'a>, customs: &C, v: SVal<\'a>, out: &mut String) {',
    '    match v {',
    '        SVal::Null => out.push_str("null"),',
    '        SVal::Bool(b) => out.push_str(if b { "true" } else { "false" }),',
    '        SVal::Number(n) => out.push_str(&n.to_string()),',
    '        SVal::Str(o, l) => _shape_json_string(&ar.src[o as usize..(o + l) as usize], out),',
    '        SVal::OwnStr(i) => _shape_json_string(&ar.strings[i as usize], out),',
    '        SVal::Node(i) => {',
    '            let o = &ar.nodes[i as usize];',
    "            out.push('{');",
    '            let mut wrote = false;',
    '            if !o.typ.is_empty() { _shape_json_string("type", out); out.push(\':\'); _shape_json_string(o.typ, out); wrote = true; }',
    '            let (fs, fl) = o.fields;',
    '            for (k, v) in &ar.fields[fs as usize..(fs + fl) as usize] { if wrote { out.push(\',\'); } _shape_json_string(k, out); out.push(\':\'); write_sval_json(ar, customs, *v, out); wrote = true; }',
    "            out.push('}');",
    '        }',
    '        SVal::List(s, l) => {',
    "            out.push('[');",
    '            for (i, v) in ar.lists[s as usize..(s + l) as usize].iter().enumerate() { if i > 0 { out.push(\',\'); } write_sval_json(ar, customs, *v, out); }',
    "            out.push(']');",
    '        }',
    '        SVal::NodeList(s, l) => {',
    "            out.push('[');",
    '            for (i, e) in ar.node_lists[s as usize..(s + l) as usize].iter().enumerate() { if i > 0 { out.push(\',\'); } customs.write_tnode_json(ar, (e >> 24) as u16, e & 0xFFFFFF, out); }',
    "            out.push(']');",
    '        }',
    '        SVal::Partial(i) => {',
    '            let p = &ar.partials[i as usize];',
    '            out.push_str("{\\"__shapePartial\\":"); _shape_json_string(p.tag, out);',
    '            out.push_str(",\\"mode\\":"); _shape_json_string(p.mode, out);',
    '            out.push_str(",\\"value\\":"); write_sval_json(ar, customs, p.value, out);',
    "            out.push('}');",
    '        }',
    '        SVal::TNode(tag, idx) => customs.write_tnode_json(ar, tag, idx, out),',
    '        SVal::_Marker(_) => {},',
    '    }',
    '}',
    "/// M-A1.4-S3: a committed node-completion event from the streaming parse.\n",
    "/// id = per-parse event index (continuous after checkpoint truncation).\n",
    "#[derive(Clone, Copy, Debug)]\n",
    "pub struct StreamEvent {\n",
    "    pub id: u32,        // per-parse event index\n",
    "    pub typ: &'static str,\n",
    "    pub alt: u32,\n",
    "    pub off: u32,\n",
    "    pub end: u32,\n",
    "}\n",
    "pub struct AstRoot<'a> { pub root: SVal<'a>, pub arena: AstArena<'a>, pub events: Vec<StreamEvent> }",
    "impl<'a> AstRoot<'a> {",
    '    pub fn write_shape_json_with<C: ShapeCustoms<\'a>>(&self, customs: &C, out: &mut String) { write_sval_json(&self.arena, customs, self.root, out); }',
    '    pub fn to_shape_json_with<C: ShapeCustoms<\'a>>(&self, customs: &C) -> String { let mut out = String::new(); self.write_shape_json_with(customs, &mut out); out }',
    '    pub fn to_shape_json(&self) -> String { self.to_shape_json_with(&DefaultShapeCustoms) }',
    '}',
  ];
  return lines.join('\n');
}

/** M15: leaves are source spans — offExpr/lenExpr are u32 code fragments.
 *  leaf_number/leaf_boolean still go through the customs hook with a source
 *  slice (TS overrides leaf_number); ident/bigint leaves construct the span
 *  directly (the identity hooks were removed with tree mode, S5). */
function rustShapeLeafAstExpr(policy: TokenLeafPolicy, off: string, len: string): string {
  const slice = `&self.src[${off} as usize..(${off} + ${len}) as usize]`;
  if (policy.action !== 'leafValue') return `SVal::Str(${off}, ${len})`;
  if (policy.fn === 'number') return `SVal::Number(self.customs.leaf_number(${slice}))`;
  if (policy.fn === 'boolean') return `SVal::Bool(self.customs.leaf_boolean(${slice}))`;
  return `SVal::Str(${off}, ${len})`; // bigint/ident: leaf hook is identity (M15)
}

/** Recursive RD step renderer — arena stack model (SH3-6): every sink is the
 *  parser's arena vals stack; per-construct "vecs" are base watermarks. */
function emitRustAstRdAltSteps(
  steps: Step[],
  ids: LexIdPlan,
  leaves: Record<string, TokenLeafPolicy>,
  look: readonly Alt[],   // ParserIR.lookaheads: the body a `look` step runs
  selfRule?: string,
  selfRuleUseBp?: boolean,
): { ok: string; okVar: string } {
  const visible = (s: Step): boolean => {
    switch (s.t) {
      case 'lit': return !rustLeafDropped(s.ttype, leaves);
      case 'tok': return !rustLeafDropped(s.name, leaves);
      case 'rule':
      case 'ruleBp': return true;
      case 'star': return visible(s.step);
      case 'opt':
      case 'seq':
      case 'suppress':
      case 'ctx': return s.steps.some(visible);
      case 'sep': return visible(s.elem);
      case 'altlit': return s.opts.some((o) => !rustLeafDropped(o.ttype, leaves));
      case 'alt': return s.branches.some((b) => b.some(visible));
      case 'look':
      case 'ahead':
      case 'aheadCtx':
      case 'sameLine': return false;
    }
  };
  /** M18: txn purity — true when the step's OUTER trace is confined to
   *  pos/vals (so a surrounding txn can use the 2-field light snapshot).
   *  lit/tok/altlit touch pos + vals only; sameLine is read-only; look is
   *  self-restoring (full ck/restore inside) and externally transparent;
   *  suppress self-restores suppress_next, ctx the context. Visible star/opt/sep/alt write
   *  the arena via shape_pack_range/shape_list_from on success paths —
   *  impure. rule/ruleBp call parse_ast_* which may write the arena
   *  (customs/pack) — always impure. */
  const pure = (s: Step): boolean => {
    switch (s.t) {
      case 'lit':
      case 'tok':
      case 'altlit': return true;
      case 'sameLine': return true;
      case 'ahead': return true;
      case 'aheadCtx': return true;
      case 'look': return true;
      case 'suppress': return s.steps.every(pure);
      case 'ctx': return s.steps.every(pure);
      case 'seq': return s.steps.every(pure);
      case 'star': return !visible(s.step) && pure(s.step);
      case 'opt': return !s.steps.some(visible) && s.steps.every(pure);
      case 'sep': return !visible(s.elem) && pure(s.elem);
      case 'alt': return !visible(s) && s.branches.every((b) => b.every(pure));
      case 'rule':
      case 'ruleBp': return false;
    }
  };
  /** M18: txn snapshot pair — pure guarded steps get a light snapshot of the
   *  three mutable channels a pure txn can touch (pos, vals, ap_stack — the
   *  alt-branch shell pushes ap_stack inside the guarded region, so the light
   *  restore must rewind it too); anything that can touch the arena, suppress
   *  state or capped keeps the full ShapeCk. */
  const txnCk = (v: string, light: boolean): string =>
    light ? `let ${v} = (self.pos, self.vals.len(), self.ap_stack.len());` : `let ${v} = self.shape_ck();`;
  const txnRestore = (v: string, light: boolean): string =>
    light ? `self.pos = ${v}.0; self.vals.truncate(${v}.1); self.ap_stack.truncate(${v}.2);` : `self.shape_restore(${v});`;
  let localId = 0;
  const local = (stem: string): string => `_shape_${stem}_${localId++}`;
  /** FIRST pre-filter over the current token; null when not worth guarding. */
  const firstGuard = (f: FirstSig, nAlts?: number): string | null =>
    isFirstGuardable(f, nAlts) ? firstCond(f, 't', ids) : null;
  const emitSteps = (xs: Step[], okVar: string): string =>
    xs.map((x) => emitStep(x, okVar)).join('\n');
  const emitStep = (s: Step, okVar: string): string => {
    switch (s.t) {
      case 'lit': {
        // M15: a consumed literal's text is exactly its token span in src.
        const push = rustLeafDropped(s.ttype, leaves) ? '' : `let _lt = self.toks[self.pos - 1]; self.vals.push(SVal::Str(_lt.off, _lt.end - _lt.off));`;
        const take = gtCompLit(ids, s) ? `self.take_comp(${lidOf(ids, s.value)})` : `self.take_lit(${lidOf(ids, s.value)})`;
        return `if ${okVar} { if ${take}.is_none() { ${okVar} = false; } else { ${push} } }`;
      }
      case 'tok': {
        const t = local('tok');
        if (rustLeafDropped(s.name, leaves)) {
          return `if ${okVar} { if self.take_span(${kidOf(ids, s.name)}).is_none() { ${okVar} = false; } }`;
        }
        return `if ${okVar} { match self.take_span(${kidOf(ids, s.name)}) { Some((${t}_o, ${t}_l)) => { self.vals.push(${rustShapeLeafAstExpr(leaves[s.name] ?? { action: 'keep' }, `${t}_o`, `${t}_l`)}); } None => { ${okVar} = false; } } }`;
      }
      case 'rule': {
        const v = local('rule');
        const call = selfRuleUseBp && s.name === selfRule
          ? `self.parse_ast_${s.name}_bp(1)`
          : `self.parse_ast_${s.name}()`;
        return `if ${okVar} { match ${call} { Some(${v}) => { self.vals.push(${v}); } None => { ${okVar} = false; } } }`;
      }
      case 'ruleBp': {
        const v = local('rulebp');
        return `if ${okVar} { match self.parse_ast_${s.name}_bp(${s.bp}) { Some(${v}) => { self.vals.push(${v}); } None => { ${okVar} = false; } } }`;
      }
      case 'seq':
        return emitSteps(s.steps, okVar);
      case 'sameLine':
        return `if ${okVar} { match self.toks.get(self.pos) { Some(t) if !t.nl => {} _ => { ${okVar} = false; } } }`;
      case 'ahead':
        return `if ${okVar} && self.toks.get(self.pos).map_or(false, |t| in_token_set(${s.set}, t)) != ${s.is} { ${okVar} = false; }`;
      case 'aheadCtx':
        return `if ${okVar} && self.toks.get(self.pos).map_or(false, |t| in_token_set(${s.set}, t) || (self.ctx != 0 && in_ctx_words(self.ctx, t))) != ${s.is} { ${okVar} = false; }`;
      case 'look': {
        // Gate on okVar to match TS `&&` short-circuit — otherwise probe still
        // runs after a failed predecessor and can re-enter recursive rules.
        const poke = local('probe');
        const steps = look[s.id]!;
        const body = emitSteps(steps, poke);
        const light = steps.every(pure);
        return `if ${okVar} {
            ${txnCk('_ck', light)}
            let mut ${poke} = true;
            ${body}
            let _probe_hit = ${poke};
            ${txnRestore('_ck', light)}
            if _probe_hit != ${s.is} { ${okVar} = false; }
        }`;
      }
      case 'suppress': {
        const sok = local('sup_ok');
        return `if ${okVar} {
            let _sn_save = self.suppress_next;
            self.set_suppress_next(${s.set});
            let mut ${sok} = true;
            ${emitSteps(s.steps, sok)}
            self.set_suppress_next(_sn_save);
            if !${sok} { ${okVar} = false; }
        }`;
      }
      case 'ctx': {
        // The steps hold no return and no \`?\`, so the context is put back on either outcome.
        const cok = local('ctx_ok');
        return `if ${okVar} {
            let _ctx_save = self.ctx;
            self.ctx = ${s.ctx};
            let mut ${cok} = true;
            ${emitSteps(s.steps, cok)}
            self.ctx = _ctx_save;
            if !${cok} { ${okVar} = false; }
        }`;
      }
      case 'altlit': {
        const matched = local('altlit');
        const arms = s.opts.map((o) => {
          const push = visible(s)
            ? (rustLeafDropped(o.ttype, leaves)
              ? `self.vals.push(SVal::Null);`
              : `self.vals.push(SVal::Str(t.off, t.end - t.off));`)
            : '';
          return `${lidOf(ids, o.value)} => { self.pos += 1; ${push} ${matched} = true; }`;
        }).join('\n                    ');
        return `if ${okVar} {
            let mut ${matched} = false;
            if let Some(t) = self.toks.get(self.pos).copied() {
                match t.lid {
                    ${arms}
                    _ => {}
                }
            }
            if !${matched} { ${okVar} = false; }
        }`;
      }
      case 'alt': {
        // Must short-circuit on okVar — ungated alt/star/opt closed the
        // ClassMember↔Block↔Stmt↔Decl infinite recursion on shallow inputs.
        const flag = local('alt_ok');
        const tries = s.branches.map((b, i) => {
          const ab = local('alt_base');
          const bok = local('br');
          const body = emitSteps(b, bok);
          const push = visible(s) ? `self.shape_pack_push(${ab});` : '';
          // FIRST pre-filter: a branch whose leading set misses the current
          // token is skipped without ck + walk + restore (IR-annotated firsts).
          const fguard = firstGuard(s.firsts?.[i] ?? null, s.branches.length);
          const cond = fguard
            ? `!${flag} && (match self.toks.get(self.pos) { Some(t) => ${fguard}, None => false })`
            : `!${flag}`;
          const light = b.every(pure);
          return `if ${cond} {
                ${txnCk('_ck', light)}
                self.ap_stack.push(${i});
                let ${ab} = self.vals.len();
                let mut ${bok} = true;
                ${body}
                if ${bok} {
                    ${push}
                    ${flag} = true;
                } else {
                    ${txnRestore('_ck', light)}
                }
            }`;
        }).join('\n            ');
        return `if ${okVar} {
            let mut ${flag} = false;
            ${tries}
            if !${flag} { ${okVar} = false; }
        }`;
      }
      case 'star': {
        const ob = local('star_base');
        const sb = local('star_vbase');
        const sok = local('star_ok');
        const body = emitStep(s.step, sok);
        const add = visible(s.step) ? `self.shape_pack_push(${sb});` : '';
        const finish = visible(s.step) ? `let _lst = self.shape_list_from(${ob}); self.vals.push(_lst);` : '';
        // FIRST pre-filter: skip the doomed exit walk (ck + failed body + restore).
        const fguard = firstGuard(rustShapeFirstOfSteps([s.step]));
        const cont = fguard
          ? `if !(match self.toks.get(self.pos) { Some(t) => ${fguard}, None => false }) { break; }`
          : '';
        const light = pure(s.step);
        return `if ${okVar} {
            let ${ob} = self.vals.len();
            loop {
                ${cont}
                ${txnCk('_ck', light)}
                let ${sb} = self.vals.len();
                let mut ${sok} = true;
                ${body}
                if !${sok} {
                    ${txnRestore('_ck', light)}
                    break;
                }
                ${add}
            }
            ${finish}
        }`;
      }
      case 'opt': {
        // FIRST pre-filter: an absent optional skips ck + walk + restore.
        const ob = local('opt_base');
        const ook = local('opt_ok');
        const body = emitSteps(s.steps, ook);
        const push = s.steps.some(visible)
          ? `if ${ook} { self.shape_pack_push(${ob}) } else { self.vals.push(SVal::Null) }`
          : '';
        const fguard = firstGuard(rustShapeFirstOfSteps(s.steps));
        const light = s.steps.every(pure);
        const inner = `${txnCk('_ck', light)}
            ${body}
            if !${ook} {
                ${txnRestore('_ck', light)}
            }`;
        return `if ${okVar} {
            let ${ob} = self.vals.len();
            let mut ${ook} = true;
            ${fguard ? `if (match self.toks.get(self.pos) { Some(t) => ${fguard}, None => false }) { ${inner} }` : inner}
            ${push}
        }`;
      }
      case 'sep': {
        const ob = local('sep_base');
        const eb = local('sep_vbase');
        const fok = local('first_ok');
        const eok = local('elem_ok');
        const bodyFirst = emitStep(s.elem, fok);
        const bodyElem = emitStep(s.elem, eok);
        const add = visible(s.elem) ? `self.shape_pack_push(${eb});` : '';
        // After first failure: push empty array (zero elems). After success path: move out.
        const finishEmpty = visible(s.elem) ? `self.vals.push(SVal::List(0, 0));` : '';
        const finishMove = visible(s.elem) ? `let _lst = self.shape_list_from(${ob}); self.vals.push(_lst);` : '';
        // FIRST pre-filter on the leading element: absent list skips ck + walk.
        const fguard = firstGuard(rustShapeFirstOfSteps([s.elem]));
        const light = pure(s.elem);
        const attempt = `${txnCk('_ck', light)}
            let ${eb} = self.vals.len();
            let mut ${fok} = true;
            ${bodyFirst}
            if !${fok} {
                ${txnRestore('_ck', light)}
                ${finishEmpty}
            } else {
                ${add}
                loop {
                    let _d = self.pos;
                    if self.take_lit(${lidOf(ids, s.delim)}).is_none() {
                        self.pos = _d;
                        break;
                    }
                    let ${eb} = self.vals.len();
                    let mut ${eok} = true;
                    ${bodyElem}
                    if !${eok} {
                        // trailing delimiter consumed — CST-aligned
                        break;
                    }
                    ${add}
                }
                ${finishMove}
            }`;
        return `if ${okVar} {
            let ${ob} = self.vals.len();
            ${fguard ? `if (match self.toks.get(self.pos) { Some(t) => ${fguard}, None => false }) { ${attempt} } else { ${finishEmpty} }` : attempt}
        }`;
      }
    }
  };
  const okVar = local('steps_ok');
  const body = emitSteps(steps, okVar);
  const light = steps.every(pure);
  return {
    ok: `${txnCk('_txn_ck', light)}
        let mut ${okVar} = true;
        ${body}
        if !${okVar} {
            ${txnRestore('_txn_ck', light)}
        }`,
    okVar,
  };
}


/** Emit the streaming structure event for a custom completion (M-A1.2/S5). */
function rustAstCustomCall(
  fn: string,
  ruleName: string,
  args: {
    /** Statements staging kids before the call (usually ''; kids slice borrows self.vals directly). */
    kidsPrep: string;
    /** `&[SVal]` expression usable after kidsPrep. */
    kidsSlice: string;
    /** Statements staging the alt path ('' when none). */
    altPrep: string;
    /** `&[usize]` expression usable after altPrep. */
    altSlice: string;
    offExpr: string;
    endExpr: string;
    leftExpr?: string;
    opExpr?: string;
    folds?: ParentFold[];
  },
): string {
  // M-A1.2: structure event only — no field computation, no customs call.
  // Control flow (kids staging, fold prep, vals truncate) is preserved.
  const folds = args.folds ?? [];
  const foldPairs = folds.map((f) => `(${J(f.tag)}, ${J(f.into)})`).join(', ');
  const foldPrep = folds.length > 0
    ? `let (__fk, __fs) = Self::shape_fold_kids(&mut self.arena, self.customs, ${args.kidsSlice}, &[${foldPairs}]);`
    : '';
  const call = `{
            let __off = ${args.offExpr};
            let __end = ${args.endExpr};
            ${args.kidsPrep}
            ${args.altPrep}
            ${foldPrep}
            if self.emit_events { self.events.push(StreamEvent { id: self.events.len() as u32, typ: estree_type_of_streaming(${J(fn)}, ${args.altSlice}, ${args.kidsSlice}, ${args.opExpr ? `Some((${args.opExpr}).as_ref())` : 'None'}, None), alt: (${args.altSlice}).first().copied().unwrap_or(0) as u32, off: __off as u32, end: __end as u32 }); }
            SVal::Str(__off as u32, (__end - __off) as u32)
        }`;
  return args.kidsSlice === '&self.vals[_sk_base..]'
    ? `{ let _cv = ${call}; self.vals.truncate(_sk_base); _cv }`
    : call;
}

function emitRustRdMethod(
  rule: RdRule,
  sir: ShapeIRRule,
  ids: LexIdPlan,
  shapeIR: ShapeIR,
  ir: ParserIR,
): string {
  const leaves = shapeIR.leaves;
  const ret = "SVal<'a>";

  const finishNode = (node: NodeShape, baseExpr: string, offExpr: string): string =>
    rustShapeNodeObjectExpr(node, baseExpr, '(0u32, 0u32)', shapeIR.spans, offExpr, 'self.last_end(' + offExpr + ')', undefined);

  const tryAlt = (altIdx: number, finish: string, guardFirst: boolean): string => {
    const alt = rule.alts[altIdx]!;
    const g = guardFirst ? astGuardRs(rule.altGuard[altIdx]!, 't') : null;
    const guardExpr = g !== null ? `_ft.is_some() && { let t = _ft.unwrap(); ${g} }` : 'true';
    const steps = emitRustAstRdAltSteps(alt, ids, leaves, ir.lookaheads);
    const finished = finish.replaceAll('__ALT__', String(altIdx)).replaceAll('__SK__', '_sk_base').replaceAll('__SPOFF__', 'sp_off');
    return `{
            let sp = self.pos;
            let sp_off = self.current_off();
            if ${guardExpr} {
                let _sk_base = self.vals.len();
                let _ap_base = self.ap_stack.len();
                self.ap_stack.push(${altIdx}usize);
                ${steps.ok}
                if ${steps.okVar} {
                    let _shape_finished = ${finished};
                    self.vals.truncate(_sk_base);
                    if _shape_finished.is_some() { self.ap_stack.truncate(_ap_base); return _shape_finished; }
                }
                self.ap_stack.truncate(_ap_base);
                self.pos = sp;
            }
        }`;
  };

  /** Alt composition: disjoint-FIRST rules dispatch via one match on the
   *  current token instead of sequential guard evals (SH3-6 M3).
   *  NOTE: partial-predictive (match on a disjoint subset) measured a
   *  wash-to-loss on this grammar — or-pattern chains don't jump-table and
   *  cost more than the cheap sequential FIRST guards they replace (M6
   *  reverted). */
  const tryAlts = (tries: Array<{ altIdx: number; finish: string }>): string => {
    if (!rule.predictive) {
      return tries.map((t) => tryAlt(t.altIdx, t.finish, true)).join('\n        ');
    }
    const arms = tries.map(({ altIdx, finish }) => {
      const f = rule.altFirst[altIdx]!;
      const pats = [
        ...f.lits.map((l) => `Some((${lidOf(ids, l)}, _))`),
        ...f.toks.map((k) => `Some((_, ${kidOf(ids, k)}))`),
      ].join(' | ');
      const alt = rule.alts[altIdx]!;
      const steps = emitRustAstRdAltSteps(alt, ids, leaves, ir.lookaheads);
      const finished = finish.replaceAll('__ALT__', String(altIdx)).replaceAll('__SK__', '_sk_base').replaceAll('__SPOFF__', 'sp_off');
      return `${pats} => {
                let _sk_base = self.vals.len();
                let _ap_base = self.ap_stack.len();
                self.ap_stack.push(${altIdx}usize);
                ${steps.ok}
                if ${steps.okVar} {
                    let _shape_finished = ${finished};
                    self.vals.truncate(_sk_base);
                    if _shape_finished.is_some() { self.ap_stack.truncate(_ap_base); return _shape_finished; }
                }
                self.ap_stack.truncate(_ap_base);
                self.pos = sp;
            }`;
    }).join('\n        ');
    return `{
            let sp = self.pos;
            let sp_off = self.current_off();
            match self.toks.get(self.pos).map(|t| (t.lid, t.kid)) {
                ${arms}
                _ => {}
            }
        }`;
  };

  // parse_ast_<rule> chooses among the alternatives as parse_<rule> does: longest match in
  // declaration order (emit-portable.ts, RdRule). Each alternative is `parse_ast_<rule>_alt(i)`;
  // one that ends past the best so far becomes the best, any other is rolled back. An
  // alternative's events are already in the stream when it returns, so when a later one
  // SUPERSEDES an earlier best both are rolled back and the later one is built again from the
  // clean state — the stream then holds the winner's events only.
  const rdMethod = (tries: Array<{ altIdx: number; finish: string }>): string => {
    const needPeek = rule.altGuard.some((g) => g !== null);
    const peek = needPeek && !rule.predictive ? 'let _ft = self.toks.get(self.pos).copied();\n        ' : '';
    if (rule.predictive || tries.length <= 1) {   // at most one alternative can match: nothing to choose
      return `    fn parse_ast_${rule.name}(&mut self) -> Option<${ret}> {
        ${peek}${tryAlts(tries)}
        None
    }`;
    }
    const ordered = [...tries].sort((x, y) => x.altIdx - y.altIdx);
    const select = ordered.map((t) => `{
            match self.parse_ast_${rule.name}_alt(${t.altIdx}) {
                Some(_v) if self.pos > _best_pos => {
                    let _end = self.pos;
                    let _v = if _best.is_some() {
                        self.shape_restore(_sel_ck0);
                        match self.parse_ast_${rule.name}_alt(${t.altIdx}) { Some(v) => v, None => unreachable!("shape: a superseding alternative of ${rule.name} did not match again") }
                    } else { _v };
                    _best = Some(_v); _best_pos = _end; _sel_ck = self.shape_ck();
                }
                Some(_) => { self.shape_restore(_sel_ck); }
                None => {}
            }
            self.pos = _sel_sp;
        }`).join('\n        ');
    return `    fn parse_ast_${rule.name}_alt(&mut self, _alt: usize) -> Option<${ret}> {
        ${peek}match _alt {
            ${ordered.map((t) => `${t.altIdx} => ${tryAlt(t.altIdx, t.finish, true)}`).join('\n            ')}
            _ => {}
        }
        None
    }
    fn parse_ast_${rule.name}(&mut self) -> Option<${ret}> {
        let _sel_sp = self.pos;
        let _sel_ck0 = self.shape_ck();
        let mut _sel_ck = _sel_ck0;
        let mut _best: Option<${ret}> = None; let mut _best_pos = _sel_sp;
        ${select}
        self.pos = _best_pos;
        _best
    }`;
  };

  if (sir.shape.kind === 'drop') {
    return `    fn parse_ast_${rule.name}(&mut self) -> Option<${ret}> {
        let sp = self.pos;
        // Recognizer-only: reuse CST parse path via token consumption is not available;
        // drop shape mirrors accept by running steps then discarding.
        None
    }`;
  }
  if (sir.shape.kind === 'custom') {
    const shape = sir.shape;
    const tries = rule.alts.map((_, ai) => ({
      altIdx: ai,
      finish: `match ${rustAstCustomCall(shape.fn, rule.name, {
        kidsPrep: '',
        kidsSlice: '&self.vals[_sk_base..]',
        altPrep: '',
        altSlice: '&self.ap_stack[_ap_base..]',
        offExpr: 'sp_off',
        endExpr: 'self.last_end(sp_off)',
        folds: shape.folds,
      })} { SVal::Null => None, v => Some(v) }`,
    }));
    return rdMethod(tries);
  }
  if (sir.shape.kind === 'inline') {
    return `    fn parse_ast_${rule.name}(&mut self) -> Option<${ret}> {
        let _ = self;
        panic!("shape: inline ${rule.name} must be spliced by parent");
    }`;
  }
  if (sir.shape.kind === 'list') {
    const inner = rule.alts[0]?.[0];
    const elemRule = inner?.t === 'star' && inner.step.t === 'rule' ? inner.step.name : null;
    if (!elemRule) {
      return `    fn parse_ast_${rule.name}(&mut self) -> Option<${ret}> {
        let _ = self;
        unimplemented!("shape rust: list ${rule.name} unsupported IR")
    }`;
    }
    return `    fn parse_ast_${rule.name}(&mut self) -> Option<${ret}> {
        let sp = self.pos;
        let _out_base = self.vals.len();
        loop {
            let sp2 = self.pos;
            match self.parse_ast_${elemRule}() {
                Some(el) => self.vals.push(el),
                None => { self.pos = sp2; break; }
            }
        }
        if self.pos == sp && self.vals.len() == _out_base { return None; }
        Some(self.shape_list_from(_out_base))
    }`;
  }
  if (sir.shape.kind === 'keep') {
    // Positional keep via RD alts → structure event (streaming-only).
    const tries = rule.alts.map((_, ai) => ({
      altIdx: ai,
      finish: `Some(${rustStreamFinish(J(rule.name), '__SPOFF__', 'self.last_end(__SPOFF__)')})`,
    }));
    return rdMethod(tries);
  }
  if (sir.shape.kind === 'choice') {
    const shape = sir.shape;
    const armBlocks: Array<{ altIdx: number; finish: string }> = [];
    for (const arm of shape.arms) {
      let finish: string;
      if (arm.shape.kind === 'node') {
        finish = `Some(${finishNode(arm.shape, '__SK__', '__SPOFF__')})`;
      } else if (arm.shape.kind === 'inline') {
        finish = `Some(self.shape_pack_range(_sk_base))`;
      } else if (arm.shape.kind === 'keep') {
        finish = `Some(${rustStreamFinish(J(rule.name), '__SPOFF__', 'self.last_end(__SPOFF__)', '__ALT__')})`;
      } else if (arm.shape.kind === 'list') {
        finish = `Some(self.shape_list_from(_sk_base))`;
      } else if (arm.shape.kind === 'custom') {
        finish = `match ${rustAstCustomCall(arm.shape.fn, rule.name, {
          kidsPrep: '',
          kidsSlice: '&self.vals[_sk_base..]',
          altPrep: '',
          altSlice: '&self.ap_stack[_ap_base..]',
          offExpr: '__SPOFF__',
          endExpr: 'self.last_end(__SPOFF__)',
          folds: arm.shape.folds,
        })} { SVal::Null => None, v => Some(v) }`;
      } else {
        finish = `None`;
      }
      for (const altIdx of arm.altIndices) {
        armBlocks.push({ altIdx, finish });
      }
    }
    return rdMethod(armBlocks);
  }
  if (sir.shape.kind === 'node') {
    const node = sir.shape;
    if (rule.alts.length === 1) {
      const steps = emitRustAstRdAltSteps(rule.alts[0]!, ids, leaves, ir.lookaheads);
      return `    fn parse_ast_${rule.name}(&mut self) -> Option<${ret}> {
        let sp = self.pos;
        let sp_off = self.current_off();
        let _sk_base = self.vals.len();
        ${steps.ok}
        if !${steps.okVar} { self.pos = sp; return None; }
        let _shape_v = ${finishNode(node, '_sk_base', 'sp_off')};
        self.vals.truncate(_sk_base);
        Some(_shape_v)
    }`;
    }
    const tries = rule.alts.map((_, ai) => ({
      altIdx: ai,
      finish: `Some(${finishNode(node, '__SK__', '__SPOFF__')})`,
    }));
    return rdMethod(tries);
  }
  return `    fn parse_ast_${rule.name}(&mut self) -> Option<${ret}> {
        let _ = self;
        unimplemented!("shape rust: unsupported RD shape for ${rule.name}")
    }`;
}

function emitRustPrattMethod(
  rule: PrattRule,
  sir: ShapeIRRule,
  ids: LexIdPlan,
  shapeIR: ShapeIR,
  ir: ParserIR,
): string {
  let shape: RuleShape = sir.shape;
  if (shape.kind === 'keep') shape = { kind: 'pratt' };
  if (shape.kind !== 'pratt') {
    return `    fn parse_ast_${rule.name}(&mut self) -> Option<SVal<'a>> { unimplemented!("expected pratt") }
    fn parse_ast_${rule.name}_bp(&mut self, _min_bp: i64) -> Option<SVal<'a>> { unimplemented!() }
    fn parse_ast_${rule.name}_nud(&mut self, _min_bp: i64) -> Option<SVal<'a>> { unimplemented!() }`;
  }
  const ps = shape;
  const leaves = shapeIR.leaves;
  const ret = "SVal<'a>";
  const tpl = ir.tpl;
  const emptySteps = (steps: Step[], selfBp = false) =>
    emitRustAstRdAltSteps(steps, ids, leaves, ir.lookaheads, selfBp ? rule.name : undefined, selfBp);

  /** Missing Pratt slot → keep (positional), matching TS emitAstPrattRule. */
  const slotOf = (declared: { kind: string } | undefined, present: boolean): { kind: string } | null => {
    if (!present) return null;
    return declared ?? { kind: 'keep' };
  };

  /** Keep finish from a stack range [baseExpr..] — emits the structure event. */
  const keepFinish = (baseExpr: string, cstName: string, offExpr: string): string =>
    rustStreamFinish(J(cstName), offExpr, `self.last_end(${offExpr})`);

  /** Keep finish from a borrowed slice (template helper kids) — event only. */
  const keepFinishSlice = (kidsSlice: string, cstName: string, offExpr: string, endExpr: string): string =>
    rustStreamFinish(J(cstName), offExpr, endExpr);

  /** TS three-state inline finish: 1→unwrap, 0→None, else array. */
  const inlineFinishReturn = (baseExpr: string): string =>
    `match self.shape_inline_finish(${baseExpr}) { Some(v) => return Some(v), None => return None }`;

  /** Node finishes only READ the kids range — consume it before returning. */
  const nodeFinish = (nodeExpr: string, baseExpr: string): string =>
    `{ let _shape_v = ${nodeExpr}; self.vals.truncate(${baseExpr}); _shape_v }`;

  const customCall = (
    fn: string,
    kidsSlice: string,
    altExpr: string,
    offExpr: string,
    endExpr: string,
    leftExpr?: string,
    opExpr?: string,
    folds?: ParentFold[],
  ): string => {
    const kidsPrep = '';
    const kids = kidsSlice === '_sk_base' ? '&self.vals[_sk_base..]' : kidsSlice;
    const altSlice = altExpr === '[]' ? '&[]' : `&${altExpr}`;
    return rustAstCustomCall(fn, rule.name, {
      kidsPrep,
      kidsSlice: kids,
      altPrep: '',
      altSlice,
      offExpr,
      endExpr,
      leftExpr,
      opExpr,
      folds,
    });
  };

  /** Explicit pratt.template only — omitted keeps the `$template` node. */
  const templateSlot = ps.template as CustomShape | { kind: 'keep' } | undefined;
  const hasTplNud = rule.nudTplHole !== undefined;
  const hasTplPostfix = rule.postfixTplHole !== undefined;
  const templateFinish = (kidsSlice: string, offExpr: string, endExpr: string): string => {
    if (!templateSlot || templateSlot.kind === 'keep') return keepFinishSlice(kidsSlice, '$template', offExpr, endExpr);
    return customCall(templateSlot.fn, kidsSlice, '[]', offExpr, endExpr, undefined, undefined, templateSlot.folds);
  };
  // Template holes parse with the rule the matching reference declares (PrattRule.nudTplHole /
  // postfixTplHole): an expression template's `${f(1)}` / `${b + 1}` are Exprs, a template
  // literal type's `${A & B}` is a Type. One helper per hole rule this Pratt rule uses.
  const tplAstFn = (hole: string) => `match_template_ast_${rule.name}_holes_${hole}`;
  const tplHoles = [...new Set([rule.nudTplHole, rule.postfixTplHole].filter((h): h is string => h !== undefined))];
  const tplHelperCode = tplHoles.map((holeRule) => `    fn ${tplAstFn(holeRule)}(&mut self) -> Option<(Vec<SVal<'a>>, usize)> {
        let t = self.toks.get(self.pos).copied()?;
        if t.kid != ${kidOf(ids, '$templateHead')} { return None; }
        let save = self.pos;
        let save_snap = self.shape_tpl_snap();
        let mut kids: Vec<SVal<'a>> = vec![SVal::Str(t.off, t.end - t.off)];
        self.pos += 1;
        loop {
            let accept_hole = match self.parse_ast_${holeRule}() {
                Some(v) => v,
                None => { self.shape_tpl_restore(&save_snap); return None; }
            };
            kids.push(accept_hole);
            let next = match self.toks.get(self.pos).copied() {
                Some(v) => v,
                None => { self.shape_tpl_restore(&save_snap); return None; }
            };
            if next.kid == ${kidOf(ids, '$templateMiddle')} {
                kids.push(SVal::Str(next.off, next.end - next.off));
                self.pos += 1;
                continue;
            }
            if next.kid == ${kidOf(ids, '$templateTail')} {
                kids.push(SVal::Str(next.off, next.end - next.off));
                self.pos += 1;
                break;
            }
            self.shape_tpl_restore(&save_snap);
            return None;
        }
        Some((kids, save))
    }
`).join('');

  // ── atom: one arm per atom token (its place in PrattRule.nudOrder) ──
  const atomArmOf = (tok: string): string => {
    const k = kidOf(ids, tok);
    const policy = leaves[tok] ?? { action: 'keep' as const };
    if (ps.atom?.kind === 'rule') {
      return `if self.peek_kid() == Some(${k}) { return self.parse_ast_${ps.atom.name}(); }`;
    }
    if (ps.atom?.kind === 'custom') {
      return `if let Some(t) = self.toks.get(self.pos).copied() {
            if t.kid == ${k} {
                let sp_off = t.off as usize;
                let _leaf = ${rustShapeLeafAstExpr(policy, 't.off', 't.end - t.off')};
                self.pos += 1;
                return Some(${customCall(ps.atom.fn, '&[_leaf]', '[]', 'sp_off', 't.end as usize', undefined, undefined, ps.atom.folds)});
            }
        }`;
    }
    if (!ps.atom || ps.atom.kind === 'keep' || (ps.atom as { kind: string }).kind === 'leafValue' || ps.atom.kind === undefined) {
      const body = tpl && tok === tpl.token && templateSlot
        ? `let leaf = ${rustShapeLeafAstExpr(policy, 't.off', 't.end - t.off')};
                self.pos += 1;
                return Some(${templateFinish('&[leaf]', 't.off as usize', 't.end as usize')});`
        : `self.pos += 1;
                return Some(${rustShapeLeafAstExpr(policy, 't.off', 't.end - t.off')});`;
      return `if let Some(t) = self.toks.get(self.pos).copied() {
            if t.kid == ${k} {
                ${body}
            }
        }`;
    }
    return '';
  };

  // ── template NUD ──
  const tplNudCode = hasTplNud
    ? `if self.peek_kid() == Some(${kidOf(ids, '$templateHead')}) {
            let (_tm_kids, _tm_save) = self.${tplAstFn(rule.nudTplHole!)}()?;
            let _tm_off = self.toks[_tm_save].off as usize;
            let _tm_end = self.last_end(_tm_off);
            return Some(${templateFinish('&_tm_kids', '_tm_off', '_tm_end')});
        }
        `
    : '';

  // ── group (lid-grouped; RD steps; custom slot reserved but inventory fail-fast) ──
  let bracketArms: string[] = [];
  const groupSlot = slotOf(ps.group as { kind: string } | undefined, rule.nudBrackets.length > 0);
  if (groupSlot && rule.nudBrackets.length) {
    {
      bracketArms = rule.nudBrackets.map((b, bi) => {
        const st = emptySteps(b.steps);
        let finish: string;
        if (groupSlot.kind === 'inline') {
          finish = inlineFinishReturn('_sk_base');
        } else if (groupSlot.kind === 'custom') {
          const gs = groupSlot as CustomShape;
          finish = `return Some(${customCall(gs.fn, '_sk_base', `[${bi}]`, 'save_off', 'self.last_end(save_off)', undefined, undefined, gs.folds)});`;
        } else if (groupSlot.kind === 'node') {
          finish = `return Some(${nodeFinish(rustShapeNodeObjectExpr(groupSlot as NodeShape, '_sk_base', '(0u32, 0u32)', shapeIR.spans, 'save_off', 'self.last_end(save_off)', undefined), '_sk_base')});`;
        } else {
          finish = `return Some(${keepFinish('_sk_base', rule.name, 'save_off')});`;
        }
        return `if self.peek_lid() == Some(${lidOf(ids, b.first)}) {
            let save = self.pos;
            let save_off = self.current_off();
            let _sk_base = self.vals.len();
            let _ap_base = self.ap_stack.len();
            ${st.ok}
            if ${st.okVar} {
                ${rule.nudBracketClosesTail[bi] ? '*pt = true; ' : ''}${finish}
                self.ap_stack.truncate(_ap_base);
            }
            self.pos = save;
        }`;
      });
    }
  }

  // ── prefix ──
  let prefixCode = '';
  const prefixSlot = slotOf(ps.prefix as { kind: string } | undefined, rule.prefix.length > 0);
  if (prefixSlot && rule.prefix.length) {
    for (const prefix of rule.prefix) {
      const lid = lidOf(ids, prefix.op);
      if (prefixSlot.kind === 'node') {
        prefixCode += `if self.peek_lid() == Some(${lid}) {
            let save = self.pos;
            let _off = self.current_off();
            let _op = self.current_span();
            self.pos += 1;
            let _argument = match self.parse_ast_${rule.name}_bp(${prefix.rbp}) {
                Some(v) if !${prefix.requireTarget} || self.form == 0 => v,
                Some(_) => { *hard = true; self.pos = save; return None; }
                None => { self.pos = save; return None; }
            };
            *pf = ${prefix.form}; *pt = true;
            let _ab = self.vals.len();
            self.vals.push(_argument);
            return Some(${nodeFinish(rustShapeNodeObjectExpr(prefixSlot as NodeShape, '_ab', '_op', shapeIR.spans, '_off', 'self.last_end(_off)', undefined), '_ab')});
        }\n        `;
      } else if (prefixSlot.kind === 'custom') {
        const psCustom = prefixSlot as CustomShape;
        prefixCode += `if self.peek_lid() == Some(${lid}) {
            let save = self.pos;
            let _off = self.current_off();
            let _op = self.current_text();
            self.pos += 1;
            let argument = match self.parse_ast_${rule.name}_bp(${prefix.rbp}) {
                Some(v) if !${prefix.requireTarget} || self.form == 0 => v,
                Some(_) => { *hard = true; self.pos = save; return None; }
                None => { self.pos = save; return None; }
            };
            *pf = ${prefix.form}; *pt = true;
            return Some(${customCall(psCustom.fn, '&[argument]', '[]', '_off', 'self.last_end(_off)', undefined, '_op', psCustom.folds)});
        }\n        `;
      } else if (prefixSlot.kind === 'inline') {
        prefixCode += `if self.peek_lid() == Some(${lid}) {
            let save = self.pos;
            self.pos += 1;
            match self.parse_ast_${rule.name}_bp(${prefix.rbp}) {
                Some(v) if !${prefix.requireTarget} || self.form == 0 => { *pf = ${prefix.form}; *pt = true; return Some(v); }
                Some(_) => { *hard = true; self.pos = save; return None; }
                None => { self.pos = save; return None; }
            }
        }\n        `;
      } else {
        prefixCode += `if self.peek_lid() == Some(${lid}) {
            let save = self.pos;
            let _op = self.current_span();
            self.pos += 1;
            let argument = match self.parse_ast_${rule.name}_bp(${prefix.rbp}) {
                Some(v) if !${prefix.requireTarget} || self.form == 0 => v,
                Some(_) => { *hard = true; self.pos = save; return None; }
                None => { self.pos = save; return None; }
            };
            *pf = ${prefix.form}; *pt = true;
            let _ab = self.vals.len();
            self.vals.push(SVal::Str(_op.0, _op.1));
            self.vals.push(argument);
            return Some(${keepFinish('_ab', rule.name, '_op.0')});
        }\n        `;
      }
    }
  }

  // ── nudSeq ──
  let seqArms: string[] = [];
  const nudSeqSlot = slotOf(ps.nudSeq as { kind: string } | undefined, rule.nudSeqs.length > 0);
  if (nudSeqSlot && rule.nudSeqs.length) {
    seqArms = rule.nudSeqs.map((seq, si) => {
      const st = emptySteps(seq, true);
      let finish: string;
      if (nudSeqSlot.kind === 'custom') {
        const ns = nudSeqSlot as CustomShape;
        finish = `return Some(${customCall(ns.fn, '_sk_base', `[${si}]`, 'save_off', 'self.last_end(save_off)', undefined, undefined, ns.folds)});`;
      } else if (nudSeqSlot.kind === 'node') {
        finish = `return Some(${nodeFinish(rustShapeNodeObjectExpr(nudSeqSlot as NodeShape, '_sk_base', '(0u32, 0u32)', shapeIR.spans, 'save_off', 'self.last_end(save_off)', undefined), '_sk_base')});`;
      } else if (nudSeqSlot.kind === 'inline') {
        finish = inlineFinishReturn('_sk_base');
      } else {
        finish = `return Some(${keepFinish('_sk_base', rule.name, 'save_off')});`;
      }
      return `{
            let save = self.pos;
            {
                let save_off = self.current_off();
                let _sk_base = self.vals.len();
                let _ap_base = self.ap_stack.len();
                ${st.ok}
                if ${st.okVar} {
                    ${rule.nudSeqClosesTail[si] ? '*pt = true; ' : ''}${finish}
                    self.ap_stack.truncate(_ap_base);
                }
            }
            self.pos = save;
        }`;
    });
  }

  // ── nudCapped ──
  let cappedArms: string[] = [];
  const nudCappedSlot = slotOf(ps.nudCapped as { kind: string } | undefined, rule.nudCapped.length > 0);
  if (nudCappedSlot && rule.nudCapped.length) {
    cappedArms = rule.nudCapped.map((c, ci) => {
      const st = emptySteps(c.steps, true);
      let finish: string;
      if (nudCappedSlot.kind === 'custom') {
        const nc = nudCappedSlot as CustomShape;
        finish = `*pc = true; return Some(${customCall(nc.fn, '_sk_base', `[${ci}]`, 'save_off', 'self.last_end(save_off)', undefined, undefined, nc.folds)});`;
      } else if (nudCappedSlot.kind === 'node') {
        finish = `*pc = true; return Some(${nodeFinish(rustShapeNodeObjectExpr(nudCappedSlot as NodeShape, '_sk_base', '(0u32, 0u32)', shapeIR.spans, 'save_off', 'self.last_end(save_off)', undefined), '_sk_base')});`;
      } else if (nudCappedSlot.kind === 'inline') {
        finish = `*pc = true; ${inlineFinishReturn('_sk_base')}`;
      } else {
        finish = `*pc = true; return Some(${keepFinish('_sk_base', rule.name, 'save_off')});`;
      }
      return `if min_bp < ${c.capBp} {
            let save = self.pos;
            {
                let save_off = self.current_off();
                let _sk_base = self.vals.len();
                let _ap_base = self.ap_stack.len();
                ${st.ok}
                if ${st.okVar} {
                    ${finish}
                    self.ap_stack.truncate(_ap_base);
                }
            }
            self.pos = save;
        }`;
    });
  }

  // ── NUD selection ──
  // Longest match over the arms (emit-portable.ts, PrattRule.nudOrder), as the CST parser does:
  // the arm that ends farthest wins, the earliest-declared one on a tie. Each arm is
  // `parse_ast_<rule>_nud_arm(i, ..)`, `i` its declaration index; it returns its value when it
  // matches. One that beats the best so far becomes the best; any other is rolled back.
  // An arm's events are already in the stream when it returns, so when an arm SUPERSEDES a best
  // found before it both are rolled back and the arm is built again from the clean state. That
  // rebuild is why the arms are TRIED capped first, then atoms, brackets, sequences and the
  // prefix arm (the comparison carries the declaration index, so the order tried cannot change
  // the winner): the forms that usually end farthest come first and are rarely superseded.
  // `hard` is the prefix arm's "operand is not the target the operator requires": the whole
  // Pratt call fails.
  const nudArmCode = (a: NudRef): { guard: string; code: string } => {
    switch (a.kind) {
      case 'tok': {
        const tok = rule.nudToks[a.index]!;
        const isTpl = !!(tpl && tok === tpl.token);
        const kinds = [kidOf(ids, tok), ...(isTpl && hasTplNud ? [kidOf(ids, '$templateHead')] : [])];
        return { guard: `matches!(t.kid, ${kinds.join(' | ')})`, code: [atomArmOf(tok), isTpl ? tplNudCode : ''].filter(Boolean).join('\n        ') };
      }
      case 'bracket': return { guard: `t.lid == ${lidOf(ids, rule.nudBrackets[a.index]!.first)}`, code: bracketArms[a.index] ?? '' };
      case 'seq':
        return { guard: astGuardRs(rule.nudSeqGuard[a.index]!, 't') ?? 'true', code: seqArms[a.index] ?? '' };
      case 'capped': {
        const g = astGuardRs(rule.nudCappedGuard[a.index]!, 't');
        return { guard: `min_bp < ${rule.nudCapped[a.index]!.capBp}${g !== null ? ` && ${g}` : ''}`, code: cappedArms[a.index] ?? '' };
      }
      case 'prefix': return { guard: rule.prefix.length ? `matches!(t.lid, ${rule.prefix.map((p) => lidOf(ids, p.op)).join(' | ')})` : 'false', code: prefixCode };
    }
  };
  const nudArms = rule.nudOrder.map(nudArmCode).map((x, i) => ({ ...x, i })).filter((x) => x.code.trim() !== '');
  const tryRank = { capped: 0, tok: 1, bracket: 2, seq: 3, prefix: 4 };
  const nudTried = [...nudArms].sort((x, y) => tryRank[rule.nudOrder[x.i]!.kind] - tryRank[rule.nudOrder[y.i]!.kind] || x.i - y.i);
  const nudSelect = nudTried.map(({ guard, i }) => `if ${guard} {
            let (mut pf, mut pt, mut pc, mut hard) = (0u8, false, false, false);
            let _r = self.parse_ast_${rule.name}_nud_arm(${i}, min_bp, &mut pf, &mut pt, &mut pc, &mut hard);
            if hard { self.shape_restore(_sel_ck0); self.capped = false; return None; }
            match _r {
                Some(_v) if self.pos > _best_pos || (self.pos == _best_pos && _best.is_some() && ${i} < _best_arm) => {
                    let _end = self.pos;
                    let _v = if _best.is_some() {
                        self.shape_restore(_sel_ck0);
                        match self.parse_ast_${rule.name}_nud_arm(${i}, min_bp, &mut pf, &mut pt, &mut pc, &mut hard) { Some(v) => v, None => unreachable!("shape: a superseding NUD arm of ${rule.name} did not match again") }
                    } else { _v };
                    _best = Some(_v); _best_pos = _end; _best_arm = ${i}; bf = pf; bt = pt; bc = pc; _sel_ck = self.shape_ck();
                }
                Some(_) => { self.shape_restore(_sel_ck); }
                None => {}
            }
            self.pos = _sel_sp;
        }`).join('\n        ');
  const nudFns = `    fn parse_ast_${rule.name}_nud(&mut self, min_bp: i64) -> Option<${ret}> {
        self.capped = false;
        let t = match self.toks.get(self.pos).copied() { Some(t) => t, None => return None };
        let _ = (min_bp, &t);
        let _sel_sp = self.pos;
        let _sel_ck0 = self.shape_ck();
        let mut _sel_ck = _sel_ck0;
        let mut _best: Option<${ret}> = None; let mut _best_pos = _sel_sp; let mut _best_arm = usize::MAX;
        let (mut bf, mut bt, mut bc) = (0u8, false, false);
        ${nudSelect}
        // A sub-parse may leave self.capped set: only a capped arm that won makes THIS node capped.
        self.pos = _best_pos;
        self.capped = bc;
        self.form = bf;
        self.tail = bt;
        _best
    }
    fn parse_ast_${rule.name}_nud_arm(&mut self, _arm: usize, min_bp: i64, pf: &mut u8, pt: &mut bool, pc: &mut bool, hard: &mut bool) -> Option<${ret}> {
        let _ = (min_bp, &pf, &pt, &pc, &hard);
        match _arm {
            ${nudArms.map(({ code, i }) => `${i} => {
        ${code}
            }`).join('\n            ')}
            _ => {}
        }
        None
    }`;

  // ── binary ──
  let binaryBody = '';
  const binarySlot = slotOf(ps.binary as { kind: string } | undefined, rule.binary.length > 0);
  if (binarySlot && rule.binary.length) {
    const binaryArms = rule.binary.map((b) =>
      `Some(${lidOf(ids, b.op)}) => (${b.lbp}, ${b.rbp}, ${b.requireTarget}, ${b.noUnaryLhs}),`,
    ).join('\n                ');
    if (binarySlot.kind === 'node') {
      binaryBody = `{
            let (_lbp, _rbp, _tgt, _no_unary) = match self.peek_op_lid() {
                ${binaryArms}
                _ => break,
            };
            if _lbp <= min_bp { break; }
            if _tgt && form != 0 || _no_unary && form == 2 { return None; }
            let _save = self.pos;
            let _op = self.op_span();
            self.pos += self.op_len();
            let _right = match self.parse_ast_${rule.name}_bp(_rbp) {
                Some(v) => v,
                None => { self.pos = _save; break; }
            };
            let _ab = self.vals.len();
            self.vals.push(left);
            self.vals.push(_right);
            left = ${nodeFinish(rustShapeNodeObjectExpr(binarySlot as NodeShape, '_ab', '_op', shapeIR.spans, '_off', 'self.last_end(_off)', undefined), '_ab')};
            form = 1; tail_closed = true;
            continue;
        }`;
    } else if (binarySlot.kind === 'custom') {
      const bs = binarySlot as CustomShape;
      binaryBody = `{
            let (_lbp, _rbp, _tgt, _no_unary) = match self.peek_op_lid() {
                ${binaryArms}
                _ => break,
            };
            if _lbp <= min_bp { break; }
            if _tgt && form != 0 || _no_unary && form == 2 { return None; }
            let _save = self.pos;
            let _op = self.op_text();
            self.pos += self.op_len();
            let _right = match self.parse_ast_${rule.name}_bp(_rbp) {
                Some(v) => v,
                None => { self.pos = _save; break; }
            };
            left = ${customCall(bs.fn, '&[_right]', '[]', '_off', 'self.last_end(_off)', 'left', '_op', bs.folds)};
            form = 1; tail_closed = true;
            continue;
        }`;
    } else {
      binaryBody = `{
            let (_lbp, _rbp, _tgt, _no_unary) = match self.peek_op_lid() {
                ${binaryArms}
                _ => break,
            };
            if _lbp <= min_bp { break; }
            if _tgt && form != 0 || _no_unary && form == 2 { return None; }
            let _save = self.pos;
            let _op = self.op_span();
            self.pos += self.op_len();
            let _right = match self.parse_ast_${rule.name}_bp(_rbp) {
                Some(v) => v,
                None => { self.pos = _save; break; }
            };
            let _ab = self.vals.len();
            self.vals.push(left);
            self.vals.push(SVal::Str(_op.0, _op.1));
            self.vals.push(_right);
            left = ${keepFinish('_ab', rule.name, '_off')};
            form = 1; tail_closed = true;
            continue;
        }`;
    }
  }

  // ── postfix ──
  let postfixCode = '';
  const postfixSlot = slotOf(ps.postfix as { kind: string } | undefined, rule.postfix.length > 0);
  if (postfixSlot && rule.postfix.length) {
    const postArms = rule.postfix.map((p) =>
      `Some(${lidOf(ids, p.op)}) => (${p.lbp}, ${p.requireTarget}),`,
    ).join('\n                    ');
    if (postfixSlot.kind === 'node') {
      postfixCode = `{
                let (post, post_tgt) = match self.peek_lid() {
                    ${postArms}
                    _ => (-1, false),
                };
                if !tail_closed && post > min_bp${rule.postfixSameLine ? ' && !self.toks[self.pos].nl' : ''} {
                    if post_tgt && form != 0 { return None; }
                    let _op = self.current_span();
                    let _end_tok = self.toks[self.pos];
                    self.pos += 1;
                    let _ab = self.vals.len();
                    self.vals.push(left);
                    left = ${nodeFinish(rustShapeNodeObjectExpr(postfixSlot as NodeShape, '_ab', '_op', shapeIR.spans, '_off', '_end_tok.end as usize', undefined), '_ab')};
                    tail_closed = true;
                    form = 1;
                    continue;
                }
            }`;
    } else if (postfixSlot.kind === 'custom') {
      const pfs = postfixSlot as CustomShape;
      postfixCode = `{
                let (post, post_tgt) = match self.peek_lid() {
                    ${postArms}
                    _ => (-1, false),
                };
                if !tail_closed && post > min_bp${rule.postfixSameLine ? ' && !self.toks[self.pos].nl' : ''} {
                    if post_tgt && form != 0 { return None; }
                    let _op = self.current_text();
                    self.pos += 1;
                    left = ${customCall(pfs.fn, '&[]', '[]', '_off', 'self.last_end(_off)', 'left', '_op', pfs.folds)};
                    tail_closed = true;
                    form = 1;
                    continue;
                }
            }`;
    } else {
      postfixCode = `{
                let (post, post_tgt) = match self.peek_lid() {
                    ${postArms}
                    _ => (-1, false),
                };
                if !tail_closed && post > min_bp${rule.postfixSameLine ? ' && !self.toks[self.pos].nl' : ''} {
                    if post_tgt && form != 0 { return None; }
                    let _op = self.current_span();
                    self.pos += 1;
                    let _ab = self.vals.len();
                    self.vals.push(left);
                    self.vals.push(SVal::Str(_op.0, _op.1));
                    left = ${keepFinish('_ab', rule.name, '_off')};
                    tail_closed = true;
                    form = 1;
                    continue;
                }
            }`;
    }
  }

  // ── postfixTok (plain token + template-headed tagged form) ──
  let postfixTokCode = '';
  const postfixTokSlot = slotOf(ps.postfixTok as { kind: string } | undefined, rule.postfixToks.length > 0);
  if (postfixTokSlot && rule.postfixToks.length) {
    const groups = groupByPreserveOrder(rule.postfixToks, (tok) => kidOf(ids, tok));
    const cases = groups.map((g) => {
      const tokName = rule.postfixToks.find((t) => kidOf(ids, t) === g.key)!;
      const policy = leaves[tokName] ?? { action: 'keep' as const };
      let finish: string;
      if (postfixTokSlot.kind === 'custom') {
        const pts = postfixTokSlot as CustomShape;
        finish = `left = ${customCall(pts.fn, '&[leaf]', '[]', '_off', 't.end as usize', 'left', 'op_owned', pts.folds)};`;
      } else if (postfixTokSlot.kind === 'node') {
        const node = postfixTokSlot as NodeShape;
        // Used as a bare statement (no left assignment in streaming) — the
        // block needs a trailing ';' so its SVal tail is not mistaken for the
        // enclosing block's value.
        finish = rustStreamFinish(J(node.type), 't.off as u32', 't.end as u32') + ';';
      } else {
        finish = `{ let _ab = self.vals.len(); self.vals.push(left); self.vals.push(leaf); left = ${keepFinish('_ab', rule.name, '_off')}; }`;
      }
      return `if self.peek_kid() == Some(${g.key}) {
                if !tail_closed {
                    let t = self.toks[self.pos];
                    ${postfixTokSlot.kind === 'custom' ? 'let op_owned = tok_text(self.src, &t);' : ''}
                    let leaf_value = ${rustShapeLeafAstExpr(policy, 't.off', 't.end - t.off')};
                    self.pos += 1;
                    #[allow(unused_mut)]
                    let mut leaf = ${tpl && tokName === tpl.token && templateSlot
        ? templateFinish('&[leaf_value]', 't.off as usize', 't.end as usize')
        : 'leaf_value'};
                    ${finish}
                    form = 0;
                    continue;
                }
            }`;
    }).join('\n            ');
    let tplPart = '';
    if (hasTplPostfix) {
      let tplFinish: string;
      if (postfixTokSlot.kind === 'custom') {
        const pts = postfixTokSlot as CustomShape;
        tplFinish = `left = ${customCall(pts.fn, '&[node]', '[]', '_off', 'node_end', 'left', 'op_owned', pts.folds)};`;
      } else if (postfixTokSlot.kind === 'node') {
        const nodeShape = postfixTokSlot as NodeShape;
        tplFinish = rustStreamFinish(J(nodeShape.type), 'node_off as u32', 'node_end as u32') + ';';
      } else {
        tplFinish = `{ let _ab = self.vals.len(); self.vals.push(left); self.vals.push(node); left = ${keepFinish('_ab', rule.name, 'node_off')}; }`;
      }
      tplPart = `
            if !tail_closed && self.peek_kid() == Some(${kidOf(ids, '$templateHead')}) {
                let node_off = self.current_off();
                if let Some((_tm_kids, _tm_save)) = self.${tplAstFn(rule.postfixTplHole!)}() {
                    let node_end = self.last_end(node_off);
                    #[allow(unused_mut)]
                    let mut node = ${templateFinish('&_tm_kids', 'node_off', 'node_end')};
                    ${postfixTokSlot.kind === 'custom' ? 'let op_owned = &self.src[node_off..node_end];' : ''}
                    ${tplFinish}
                    form = 0;
                    continue;
                }
            }`;
    }
    postfixTokCode = cases + tplPart;
  }

  // ── LED (mixfix; RD steps; guards; success-only commit) ──
  let ledCode = '';
  const ledSlot = slotOf(ps.led as { kind: string } | undefined, rule.leds.length > 0);
  if (ledSlot && rule.leds.length) {
    // A lid that ALSO has a binary entry (`<` is both a type-arg LED and the
    // relational operator) must not `break` the Pratt loop when its LED steps
    // fail — the restore happens, then control falls through to the binary
    // body so `<` still parses as a comparison. Multiple arms sharing a lid
    // (e.g. `[` array-type then indexed-access) fall through to each other;
    // only the LAST arm of a group emits `break`.
    const binLids = new Set(rule.binary.map((b) => lidOf(ids, b.op)));
    const groups = groupByPreserveOrder(rule.leds, (b) => lidOf(ids, b.first));
    // binLid disambiguation (grammar-agnostic): a lid that is BOTH a binary op
    // and a LED opener (e.g. `<` = relational + type-args) should not blindly
    // run every LED arm (full checkpoint + speculative parse + restore) before
    // falling through to binary. When the LED arms close with a `>` (the C-like
    // type-args shape), peek forward for the matching `>` before a hard
    // terminator: none ⇒ skip the LED arms and go straight to binary. `>`-found
    // is NOT proof of type-args (`a < b > c` is comparison), but trying the LED
    // then is SAFE — it fails and falls through, same as the old code.
    const stepsCloseWithGt = (steps: Step[]): boolean => {
      for (const s of steps) {
        if (s.t === 'lit' && s.value === '>') return true;
        if (s.t === 'seq' || s.t === 'suppress' || s.t === 'ctx') { if (stepsCloseWithGt(s.steps)) return true; }
      }
      return false;
    };
    const gtLid = lidOf(ids, '>');
    const lparenLid = lidOf(ids, '(');
    const rparenLid = lidOf(ids, ')');
    const lbrackLid = lidOf(ids, '[');
    const rbrackLid = lidOf(ids, ']');
    const lbraceLid = lidOf(ids, '{');
    const rbraceLid = lidOf(ids, '}');
    const semiLid = lidOf(ids, ';');
    const colonLid = lidOf(ids, ':');
    const eqLid = lidOf(ids, '=');
    ledCode = groups.map((g) => {
      const lid = g.key as number;
      const hasBin = binLids.has(lid);
      const arms = g.members.map(({ item: b, index: i }, j) => {
        const parts: string[] = [];
        if (rule.ledAccessTail[i]) parts.push('!tail_closed');
        if (rule.ledLbp[i] !== null && rule.ledLbp[i] !== undefined) parts.push(`${rule.ledLbp[i]} > min_bp`);
        if (rule.ledSameLine[i]) parts.push('!t.nl');
        if (rule.ledNotLeftLeaf[i]) {
          const set = rule.ledNotLeftLeaf[i]!;
          parts.push(`{ let _ht = self.shape_head_text(left); !matches!(Self::shape_sval_str(&self.arena, _ht), ${set.map((x) => J(x)).join(' | ')}) }`);
        }
        for (const set of rule.ledSuppressedIn[i]!) parts.push(`self.suppress_cur != ${set}`);
        const st = emptySteps(b.steps);
        let finish: string;
        if (ledSlot.kind === 'custom') {
          const ls = ledSlot as CustomShape;
          finish = `left = ${customCall(ls.fn, '_sk_base', `[${i}]`, '_off', 'self.last_end(_off)', 'left', '_op', ls.folds)};`;
        } else if (ledSlot.kind === 'node') {
          finish = `left = ${nodeFinish(rustShapeNodeObjectExpr(ledSlot as NodeShape, '_sk_base', '_op', shapeIR.spans, '_off', 'self.last_end(_off)', 'left'), '_sk_base')};`;
        } else if (ledSlot.kind === 'inline') {
          finish = `left = self.shape_pack_range(_sk_base);`;
        } else {
          finish = `{ self.vals.insert(_sk_base, left); left = ${keepFinish('_sk_base', rule.name, '_off')}; }`;
        }
        return `${parts.length ? `if ${parts.join(' && ')} ` : ''}{
                    let led_save = self.pos;
                    ${ledSlot.kind === 'node' ? 'let _op = self.current_span();' : ledSlot.kind === 'custom' ? 'let _op = self.current_text();' : ''}
                    let _capped_save = self.capped;
                    let _sk_base = self.vals.len();
                    let _ap_base = self.ap_stack.len();
                    ${st.ok}
                    if ${st.okVar} {
                        ${finish}
                        self.ap_stack.truncate(_ap_base);
                        form = ${rule.ledForm[i]!};${rule.ledClosesTail[i] ? ' tail_closed = true;' : ''}
                        continue;
                    }
                    self.pos = led_save;
                    self.capped = _capped_save;
                    ${hasBin ? '' : (j === g.members.length - 1 ? 'break;' : '')}
                }`;
      }).join('\n                ');
      const doScan = hasBin && g.members.every(({ item }) => stepsCloseWithGt(item.steps));
      if (!doScan) {
        return `if self.peek_lid() == Some(${lid}) {
                let t = self.toks[self.pos];
                ${arms}
            }`;
      }
      const scan = `let mut _scan_found_gt = false;
                let mut _scan_nest = 0usize;
                let mut _scan_i = self.pos + 1;
                while _scan_i < self.toks.len() {
                    let _st = self.toks[_scan_i];
                    let _sl = _st.lid;
                    if _sl == ${gtLid} {
                        _scan_found_gt = true;
                        break;
                    }
                    if _sl == ${semiLid} || _sl == ${eqLid} {
                        break;
                    }
                    if _sl == ${colonLid} || _sl == ${rparenLid} || _sl == ${rbrackLid} || _sl == ${rbraceLid} {
                        if _scan_nest == 0 { break; }
                        _scan_nest -= 1;
                    } else if _sl == ${lparenLid} || _sl == ${lbrackLid} || _sl == ${lbraceLid} {
                        _scan_nest += 1;
                    }
                    _scan_i += 1;
                }
                if _scan_found_gt {
                    ${arms}
                }`;
      return `if self.peek_lid() == Some(${lid}) {
                let t = self.toks[self.pos];
                ${scan}
            }`;
    }).join('\n            ');
  }

  const hasLoop = !!(ledCode || postfixCode || postfixTokCode || binaryBody);

  return `${tplHelperCode}    fn parse_ast_${rule.name}(&mut self) -> Option<${ret}> {
        // Fast path: no pending suppress swap — skip the log traffic.
        if self.suppress_next == 0 && self.suppress_cur == 0 {
            return self.parse_ast_${rule.name}_bp(0);
        }
        let prev = self.suppress_cur;
        let _sn = self.take_suppress_next();
        self.set_suppress_cur(_sn);
        let r = self.parse_ast_${rule.name}_bp(0);
        self.set_suppress_cur(prev);
        r
    }
    fn parse_ast_${rule.name}_bp(&mut self, min_bp: i64) -> Option<${ret}> {
        let _off = self.current_off();
        let mut left = self.parse_ast_${rule.name}_nud(min_bp)?;
        #[allow(unused_mut, unused_variables)]
        let mut form = self.form;
        if self.capped { return Some(left); }
        let mut tail_closed = self.tail;
        ${hasLoop ? 'loop {' : ''}
            ${ledCode}
            ${postfixTokCode}
            ${postfixCode}
            ${binaryBody || (hasLoop ? 'break;' : '')}
        ${hasLoop ? '}' : ''}
        self.form = form;
        Some(left)
    }
${nudFns}
`;
}

function rustShapeUnsupported(ir: ParserIR, shapeIR: ShapeIR): Array<{ rule: string; construct: string }> {
  const out: Array<{ rule: string; construct: string }> = [];
  const note = (rule: string, construct: string): void => { out.push({ rule, construct }); };
  const supportedLeaf = (name: string): boolean => {
    const p = shapeIR.leaves[name];
    return p?.action === 'drop' || (p?.action === 'leafValue' && ['number', 'ident', 'identity', 'string', 'boolean', 'bigint'].includes(p.fn));
  };
  const walkStep = (rule: string, step: Step): void => {
    // SH3-1: all RD step kinds are supported.
    if (step.t === 'lit') {
      if (shapeIR.leaves[step.ttype]?.action !== 'drop') note(rule, `step:lit-kept:${step.value}`);
    } else if (step.t === 'tok') {
      if (!supportedLeaf(step.name) || shapeIR.leaves[step.name]?.action === 'drop') note(rule, `step:tok-policy:${step.name}`);
    } else if (step.t === 'alt') {
      for (const branch of step.branches) for (const s of branch) walkStep(rule, s);
    } else if (step.t === 'opt' || step.t === 'seq' || step.t === 'suppress' || step.t === 'ctx') {
      for (const s of step.steps) walkStep(rule, s);
    } else if (step.t === 'look') {
      for (const s of ir.lookaheads[step.id]!) walkStep(rule, s);
    } else if (step.t === 'star') walkStep(rule, step.step);
    else if (step.t === 'sep') walkStep(rule, step.elem);
    // rule/ruleBp/altlit/sameLine: ok
  };
  const walkShape = (rule: string, shape: RuleShape): void => {
    if (shape.kind === 'custom') {
      // SH3-4: custom supported (streaming structure event + type table)
    } else if (shape.kind === 'choice') for (const arm of shape.arms) walkShape(rule, arm.shape);
    else if (shape.kind === 'keep' || shape.kind === 'inline' || shape.kind === 'list' || shape.kind === 'node' || shape.kind === 'pratt' || shape.kind === 'drop') {
      // supported RD shape kinds
    } else if (shape.kind === 'leafValue') note(rule, `shape:${shape.kind}`);
    else note(rule, `shape:${(shape as { kind: string }).kind}`);
  };

  for (const sir of shapeIR.rules) {
    const rule = ir.rules.find((r) => r.name === sir.name)!;
    walkShape(rule.name, sir.shape);
    if (rule.kind === 'rd') {
      if (sir.shape.kind === 'node') {
        for (const alt of rule.alts) for (const step of alt) walkStep(rule.name, step);
      } else if (sir.shape.kind === 'choice') {
        for (const arm of sir.shape.arms) {
          if (arm.shape.kind === 'custom') {
            // SH3-4: choice-arm custom supported
          } else if (!['node', 'keep', 'inline', 'list', 'drop'].includes(arm.shape.kind)) {
            note(rule.name, `choice-arm:${arm.shape.kind}`);
          }
          for (const ai of arm.altIndices) for (const step of rule.alts[ai] ?? []) walkStep(rule.name, step);
        }
      } else if (sir.shape.kind === 'custom') {
        // already noted
      } else if (['keep', 'inline', 'list', 'drop'].includes(sir.shape.kind)) {
        for (const alt of rule.alts) for (const step of alt) walkStep(rule.name, step);
      } else if (sir.shape.kind !== 'pratt') {
        note(rule.name, `rd-shape:${sir.shape.kind}`);
      }
      continue;
    }
    if (sir.shape.kind !== 'pratt') {
      note(rule.name, `pratt-shape:${sir.shape.kind}`);
      continue;
    }
    const ps = sir.shape;
    // Supported toy/calc Pratt slots:
    const atomOk = !ps.atom || ps.atom.kind === 'keep' || ps.atom.kind === 'leafValue' || ps.atom.kind === 'rule'
      || ps.atom.kind === 'drop' || ps.atom.kind === 'custom';
    if (ps.atom && !atomOk) {
      note(rule.name, `pratt-shape:atom:${ps.atom.kind}`);
    }
    if (ps.group && !['inline', 'keep', 'node', 'custom'].includes(ps.group.kind)) {
      note(rule.name, `pratt-shape:group:${ps.group.kind}`);
    }
    // Complex groups: allow if we render via RD steps (all brackets ok in SH3-1 for keep/inline/node)
    for (const tok of rule.nudToks) {
      if (ps.atom?.kind === 'rule') continue;
      if (!supportedLeaf(tok) || shapeIR.leaves[tok]?.action === 'drop') note(rule.name, `pratt-ir:atom-policy:${tok}`);
    }
    if (rule.prefix.length && ps.prefix && !['node', 'keep', 'inline', 'custom'].includes(ps.prefix.kind)) {
      note(rule.name, `pratt-shape:prefix:${ps.prefix.kind}`);
    }
    if (rule.binary.length && ps.binary && !['node', 'keep', 'custom'].includes(ps.binary.kind)) {
      note(rule.name, `pratt-shape:binary:${ps.binary.kind}`);
    }
    if (rule.postfix.length && ps.postfix && !['node', 'keep', 'inline', 'custom'].includes(ps.postfix.kind)) {
      note(rule.name, `pratt-shape:postfix:${ps.postfix.kind}`);
    }
    // led / nudSeq / nudCapped / postfixTok: keep|inline|node|custom supported
    for (const [slotName, slot, present] of [
      ['nudSeq', ps.nudSeq, rule.nudSeqs.length],
      ['nudCapped', ps.nudCapped, rule.nudCapped.length],
      ['led', ps.led, rule.leds.length],
      ['postfixTok', ps.postfixTok, rule.postfixToks.length],
    ] as const) {
      if (!present) continue;
      const kind = slot?.kind ?? 'keep';
      if (!['keep', 'inline', 'node', 'custom'].includes(kind)) note(rule.name, `pratt-shape:${slotName}:${kind}`);
    }
    if (ps.template && !['keep', 'custom'].includes(ps.template.kind)) {
      note(rule.name, `pratt-shape:template:${ps.template.kind}`);
    }
  }
  return out;
}


/**
 * M-A1.4-S2: streaming estree-type table. Emit-time totality check + collection.
 * Every custom/Pratt-custom site declares per-arm `types` (or `opMap` for
 * op-driven binary/prefix). Declared coverage must span the grammar's reachable
 * arms/ops; anything missing is an emit error. Sites of the same fn are merged;
 * conflicting arm/op types across sites → error. Returns the merged table.
 */
type StreamTypeObj = { passthrough: true } | { optionalChain: true } | { parenOrComma: true };
function collectStreamTypes(ir: ParserIR, shapeIR: ShapeIR, ids: LexIdPlan): Map<string, { perArm: (string | StreamTypeObj)[]; opMap?: Record<string, string> }> {
  const merged = new Map<string, { perArm: (string | StreamTypeObj)[]; opMap?: Record<string, string> }>();
  const fail = (msg: string): never => { throw new Error('stream-type totality: ' + msg); };
  const ensureTypes = (fn: string, types: StreamType[] | undefined, armCount: number) => {
    if (!types) { fail(`${fn} declares no types`); return; }
    // A single parenOrComma marker is a site-level decision covering every arm.
    if (types.length === 1 && typeof types[0] === 'object' && types[0] !== null && 'parenOrComma' in (types[0] as object)) return;
    if (types.length !== armCount) fail(`${fn} expects ${armCount} reachable arm(s), got ${types.length} declared`);
  };
  const collect = (fn: string, types: StreamType[] | undefined, opMap: Record<string, string> | undefined) => {
    const cur = merged.get(fn) ?? { perArm: [] as (string | StreamTypeObj)[] };
    if (opMap) {
      for (const [op, ty] of Object.entries(opMap)) {
        if (cur.opMap && cur.opMap[op] && cur.opMap[op] !== ty) fail(`${fn} op ${op} has two types (${cur.opMap[op]} vs ${ty})`);
        (cur.opMap ??= {})[op] = ty;
      }
    }
    if (types) {
      if (cur.perArm.length === 0) cur.perArm = types;
      else {
        const len = Math.max(cur.perArm.length, types.length);
        for (let i = 0; i < len; i++) {
          const a = cur.perArm[i];
          const b = types[i];
          if (a !== undefined && b !== undefined && JSON.stringify(a) !== JSON.stringify(b)) fail(`${fn} arm ${i} has two types (${JSON.stringify(a)} vs ${JSON.stringify(b)})`);
          if (a === undefined) cur.perArm[i] = b;
        }
      }
    }
    merged.set(fn, cur);
  };
  for (const sir of shapeIR.rules) {
    const rule = ir.rules.find((r) => r.name === sir.name)!;
    if (rule.kind === 'rd') {
      const sh = sir.shape;
      if (sh.kind === 'custom') {
        ensureTypes(sh.fn, sh.types, rule.alts.length);
        collect(sh.fn, sh.types, undefined);
      } else if (sh.kind === 'choice') {
        for (const arm of sh.arms) {
          if (arm.shape.kind === 'custom') {
            ensureTypes(arm.shape.fn, arm.shape.types, arm.altIndices.length);
            // choice-arm types are positional (types[i] ↔ altIndices[i]) — place
            // each at its actual alt value so the table matches the event alt.
            const perArm: (string | StreamTypeObj)[] = [];
            for (let i = 0; i < arm.altIndices.length; i++) perArm[arm.altIndices[i]!] = arm.shape.types![i] as string | StreamTypeObj;
            collect(arm.shape.fn, perArm, undefined);
          }
        }
      }
      continue;
    }
    const ps = sir.shape as PrattShape;
    const slot = (name: string, s: { kind: string } | undefined): void => {
      if (!s || s.kind !== 'custom') return;
      const cs = s as CustomShape;
      let n: number | null = null;
      if (name === 'nudSeq') n = rule.nudSeqs.length;
      else if (name === 'nudCapped') n = rule.nudCapped.length;
      else if (name === 'led') n = rule.leds.length;
      else if (name === 'group') n = rule.nudBrackets.length;
      else if (name === 'postfixTok') n = rule.postfixToks.length;
      else if (name === 'template' || name === 'atom') n = 1;
      if (n !== null) ensureTypes(cs.fn, cs.types, n);
      collect(cs.fn, cs.types, undefined);
    };
    slot('atom', ps.atom);
    slot('group', ps.group);
    slot('nudSeq', ps.nudSeq);
    slot('nudCapped', ps.nudCapped);
    slot('led', ps.led);
    slot('postfixTok', ps.postfixTok);
    slot('template', ps.template);
    if (ps.prefix?.kind === 'custom') {
      const cs = ps.prefix as CustomShape;
      if (!cs.opMap) fail(`${cs.fn} is op-driven but declares no opMap`);
      const ops = rule.prefix.map((p) => p.op);
      for (const op of ops) if (!(op in (cs.opMap ?? {}))) fail(`${cs.fn} op ${op} missing from opMap`);
      collect(cs.fn, undefined, cs.opMap);
    }
    if (ps.binary?.kind === 'custom') {
      const cs = ps.binary as CustomShape;
      if (!cs.opMap) fail(`${cs.fn} is op-driven but declares no opMap`);
      const ops = rule.binary.map((b) => b.op);
      for (const op of ops) if (!(op in (cs.opMap ?? {}))) fail(`${cs.fn} op ${op} missing from opMap`);
      collect(cs.fn, undefined, cs.opMap);
    }
  }
  return merged;
}

/** Emit the estree_type_of_streaming function from the collected table. */
function emitStreamTypeFn(table: Map<string, { perArm: (string | StreamTypeObj)[]; opMap?: Record<string, string> }>): string {
  const lines: string[] = [];
  for (const [fn, info] of table) {
    if (info.opMap) {
      const byType = new Map<string, string[]>();
      for (const [op, ty] of Object.entries(info.opMap)) {
        const arr = byType.get(ty) ?? [];
        arr.push(op);
        byType.set(ty, arr);
      }
      const arms: string[] = [];
      for (const [ty, ops] of byType) arms.push(`                ${ops.map((o) => JSON.stringify(o)).join(' | ')} => ${JSON.stringify(ty)},`);
      lines.push(`            ${JSON.stringify(fn)} => match op {
${arms.join('\n')}
                _ => ${JSON.stringify('Unknown' + fn)},
            },`);
    } else {
      // parenOrComma is a site-level decision for every arm — emit one branch.
      if (info.perArm.length === 1 && typeof info.perArm[0] === 'object' && info.perArm[0] !== null && 'parenOrComma' in (info.perArm[0] as object)) {
        lines.push(`            ${JSON.stringify(fn)} => if arm == 7 { "MetaProperty" } else if kids.len() == 1 { kid_type(kids[0]) } else { "SequenceExpression" },`);
        continue;
      }
      const arms: string[] = [];
      info.perArm.forEach((t, i) => {
        if (t === undefined) return; // sparse hole — choice-arm alt not mapped
        let rhs: string;
        if (typeof t === 'string') rhs = JSON.stringify(t);
        else if ('passthrough' in t) rhs = 'kid_type(kids.first().copied().unwrap_or(SVal::Null))';
        else if ('optionalChain' in t) rhs = 'optional_chain_type(kids)';
        else rhs = 'if arm == 7 { "MetaProperty" } else if kids.len() == 1 { kid_type(kids[0]) } else { "SequenceExpression" }';
        arms.push(`                ${i} => ${rhs},`);
      });
      lines.push(`            ${JSON.stringify(fn)} => match arm {
${arms.join('\n')}
                _ => ${JSON.stringify('Unknown' + fn)},
            },`);
    }
  }
  return `/// M-A1.4-S2: estree type of a streaming event — generated from the shape
/// spec's per-arm types (source of truth; fixture's handwritten table removed).
pub fn estree_type_of_streaming<'a>(fn_name: &str, alt: &[usize], kids: &[SVal<'a>], op_text: Option<&str>, _kind: Option<&str>) -> &'static str {
        let arm = alt.first().copied().unwrap_or(0);
        let op = op_text.unwrap_or("");
        match fn_name {
${lines.join('\n')}
            _ => "UnknownFn",
        }
    
}
`;
}

function emitRustShapeAddon(ir: ParserIR, shapeIR: ShapeIR, ids: LexIdPlan): string {
  const unsupported = rustShapeUnsupported(ir, shapeIR);
  if (unsupported.length) {
    throw new Error(
      `shape rust emit: ${unsupported.length} unsupported construct(s):\n` +
      unsupported.map((u) => `  ${u.rule}: ${u.construct}`).join('\n'),
    );
  }
  _rustShapeRuleFirst = buildRustShapeRuleFirst(ir);
  // M-A1.4-S5: streaming-only — the estree-type table is always collected
  // (every custom site must declare per-arm types/opMap).
  const streamTypeTable = collectStreamTypes(ir, shapeIR, ids);
  const streamTypeFn = streamTypeTable.size ? emitStreamTypeFn(streamTypeTable) : '';
  const methods = shapeIR.rules.map((sir) => {
    const rule = ir.rules.find((r) => r.name === sir.name)!;
    return rule.kind === 'pratt'
      ? emitRustPrattMethod(rule, sir, ids, shapeIR, ir)
      : emitRustRdMethod(rule, sir, ids, shapeIR, ir);
  }).join('\n\n');
  _rustShapeRuleFirst = null;
  return `

${emitRustShapeTypes(ir, shapeIR)}

${streamTypeFn}// Generic C makes every hook statically dispatched and monomorphized. No trait object,
// callback table, or per-node allocation is introduced by the customs boundary.
#[derive(Debug, Clone, Default)]
pub struct AstFoldCounts { pub starts: usize, pub appends: usize }

pub trait ShapeCustoms<'a> {
    #[inline(always)]
    fn leaf_number(&self, text: &str) -> f64 {
        // Fast path: plain integer literals — a digit loop avoids f64::from_str's
        // correct-rounding cost (the common case in real code). >19 digits or
        // any non-digit falls back to the full parser (overflow/hex/float-safe).
        let b = text.as_bytes();
        if !b.is_empty() && b.len() <= 19 && b.iter().all(|c| c.is_ascii_digit()) {
            let mut v: u64 = 0;
            for &c in b { v = v * 10 + (c - b'0') as u64; }
            return v as f64;
        }
        text.parse::<f64>().expect("shape number")
    }
    #[inline(always)] fn leaf_boolean(&self, text: &str) -> bool { text == "true" }
    /// JSON writer for typed custom nodes (SVal::TNode) — M2 typed direct-emit.
    /// Customs that produce TNodes must override; default panics (never hit otherwise).
    fn write_tnode_json(&self, _ar: &AstArena<'a>, _tag: u16, _idx: u32, _out: &mut String) {
        panic!("shape rust: write_tnode_json not implemented for this customs")
    }
    /// Fold append into a typed node's field (TNode) — M2 typed fold protocol.
    /// Default panics; customs with fold-capable typed products must override.
    fn tnode_fold_append(&self, _ar: &mut AstArena<'a>, _tag: u16, _idx: u32, _into: &'static str, _value: SVal<'a>) {
        panic!("shape rust: tnode_fold_append not implemented for this customs")
    }
    /// Reserve hook (M10) — called once per parse with the token count so
    /// customs-owned arenas can pre-size (the customs value is fresh per parse,
    /// so its Vecs would otherwise grow from zero with realloc churn).
    fn reserve(&self, _n: usize) {}
    /// Head-text of a typed node (M14) — mirrors the DynObj "headText" field
    /// read that shape_head_text performs on keep-wrapper objects. Default ""
    /// (the pre-M14 TNode behavior).
    fn tnode_head_text(&self, _tag: u16, _idx: u32) -> SVal<'a> { SVal::Str(0, 0) }
}
pub struct DefaultShapeCustoms;
impl ShapeCustoms<'_> for DefaultShapeCustoms {}

// suppress_next / suppress_cur are indices into the grammar's suppress sets
// (ParserIR.suppressSets; 0 = none): no allocation, and the undo log just
// records old values (SH3-6 M3).
#[derive(Clone, Copy)]
struct ShapeCk {
    pos: usize,
    vals_len: usize,
    lists_len: usize,
    // fields/nodes/partials are omitted: the streaming-only shape codegen never
    // mutates those arena slabs (no DynObj/Partial construction), so their len is
    // constant 0 and snapshotting/truncating them is pure per-alt overhead.
    //
    // strings_len is deliberately omitted too: arena.strings only grows via
    // mk_own_str (Number/Bool shape_head_text), and SVal::OwnStr indices are
    // monotonic (never reused after rollback) — so skipping the snapshot/truncate
    // is a benign one-way memory leak (speculative OwnStrs are simply never
    // reclaimed), not a dangling-ref bug. strings is near-unused in this grammar
    // (head_text is rare), so the leak is negligible.
    ap_len: usize,
    suppress_log_len: usize,
    capped: bool,
    // events_len is only meaningful when emit_events (parse_ast_with_buf /
    // parse_stream_buf). With emit_events=false events never grows, so shape_ck
    // snapshots 0 and shape_restore skips the truncate (gated below).
    events_len: usize,
}

#[derive(Clone, Copy)]
struct ShapeTplSnap {
    pos: usize,
    suppress_next: u16,
    suppress_cur: u16,
    capped: bool,
    events_len: usize,
}

struct ShapeParser<'a, 'c, C: ShapeCustoms<'a>> {
    src: &'a str,
    toks: Vec<Tok>,
    pos: usize,
    customs: &'c C,
    arena: AstArena<'a>,
    /// Shape value stack — lives on the parser (not AstArena) so customs can
    /// borrow &self.vals[base..] as kids while &mut self.arena is passed
    /// (disjoint field borrows; kills the old kids_scratch drain-copy per call).
    vals: Vec<SVal<'a>>,
    /// Global alt_path stack: rule alt index + nested alt-step branch picks.
    ap_stack: Vec<usize>,
    suppress_next: u16,
    suppress_cur: u16,
    suppress_log: Vec<(u8, u16)>,
    /// The [Await]/[Yield] context word in force (see Parser::ctx); a \`ctx\` step restores it itself.
    ctx: u8,
    capped: bool,
    /// Assignment-target form of the node the last nud/bp call returned.
    form: u8,
    /// Whether the node the last nud call returned closes the access tail.
    tail: bool,
    /// When true, committed node completions also emit StreamEvents (parse_stream_buf
    /// path); when false the walk is tree-only and skips event/type-tag work.
    emit_events: bool,
    /// M-A1.2/S5: streaming structure events (typ, alt, off, end) — populated
    /// at every committed node completion (speculative events are rolled back
    /// by checkpoint truncation); parse_stream replays them to the caller.
    events: Vec<StreamEvent>,
}
impl<'a, 'c, C: ShapeCustoms<'a>> ShapeParser<'a, 'c, C> {
    #[inline(always)] fn peek_kid(&self) -> Option<u16> { self.toks.get(self.pos).map(|t| t.kid) }
    #[inline(always)] fn peek_lid(&self) -> Option<u16> { self.toks.get(self.pos).map(|t| t.lid) }
    #[inline(always)] fn current_off(&self) -> usize { self.toks.get(self.pos).map(|t| t.off as usize).unwrap_or(self.src.len()) }
    #[inline(always)] fn current_text(&self) -> &'a str { self.toks.get(self.pos).map(|t| tok_text(self.src, t)).unwrap_or("") }
    /// M15: span of the current token — (off, len); (src.len(), 0) at EOF.
    #[inline(always)] fn current_span(&self) -> (u32, u32) { self.toks.get(self.pos).map(|t| (t.off, t.end - t.off)).unwrap_or((self.src.len() as u32, 0)) }
    #[inline(always)] fn last_end(&self, fallback: usize) -> usize { if self.pos > 0 { self.toks[self.pos - 1].end as usize } else { fallback } }
    #[inline(always)] fn take_lit(&mut self, lid: u16) -> Option<()> {
        if self.peek_lid() != Some(lid) { return None; }
        self.pos += 1;
        Some(())
    }
    #[inline(always)] fn take_comp(&mut self, lid: u16) -> Option<()> {
        if self.pos >= self.toks.len() { return None; }
        let (c, n, _) = gt_op(&self.toks, self.pos);
        if c != lid { return None; }
        self.pos += n;
        Some(())
    }
    /// The binary operator read at pos: its lid (None at EOF), span (off, len), text and token count.
    #[inline(always)] fn peek_op_lid(&self) -> Option<u16> { if self.pos < self.toks.len() { Some(gt_op(&self.toks, self.pos).0) } else { None } }
    #[inline(always)] fn op_span(&self) -> (u32, u32) { let (_, _, e) = gt_op(&self.toks, self.pos); let o = self.toks[self.pos].off; (o, e - o) }
    #[inline(always)] fn op_text(&self) -> &'a str { let (_, _, e) = gt_op(&self.toks, self.pos); &self.src[self.toks[self.pos].off as usize..e as usize] }
    #[inline(always)] fn op_len(&self) -> usize { gt_op(&self.toks, self.pos).1 }
    #[inline(always)] fn take_span(&mut self, kid: u16) -> Option<(u32, u32)> {
        if self.peek_kid() != Some(kid) { return None; }
        let t = &self.toks[self.pos];
        let span = (t.off, t.end - t.off);
        self.pos += 1;
        Some(span)
    }
    #[inline(always)]
    fn set_suppress_next(&mut self, v: u16) {
        let old = std::mem::replace(&mut self.suppress_next, v);
        self.suppress_log.push((0, old));
    }
    #[inline(always)]
    fn set_suppress_cur(&mut self, v: u16) {
        let old = std::mem::replace(&mut self.suppress_cur, v);
        self.suppress_log.push((1, old));
    }
    #[inline(always)]
    fn take_suppress_next(&mut self) -> u16 {
        let old = std::mem::take(&mut self.suppress_next);
        self.suppress_log.push((0, old));
        old
    }
    fn shape_tpl_snap(&self) -> ShapeTplSnap {
        ShapeTplSnap {
            pos: self.pos,
            suppress_next: self.suppress_next,
            suppress_cur: self.suppress_cur,
            capped: self.capped,
            events_len: self.events.len(),
        }
    }
    fn shape_tpl_restore(&mut self, snap: &ShapeTplSnap) {
        self.pos = snap.pos;
        self.suppress_next = snap.suppress_next;
        self.suppress_cur = snap.suppress_cur;
        self.capped = snap.capped;
        self.events.truncate(snap.events_len);
    }
    #[inline(always)]
    fn shape_ck(&self) -> ShapeCk {
        ShapeCk {
            pos: self.pos,
            vals_len: self.vals.len(),
            lists_len: self.arena.lists.len(),
            ap_len: self.ap_stack.len(),
            suppress_log_len: self.suppress_log.len(),
            capped: self.capped,
            // events_len is structurally 0 when emit_events=false (events never
            // grows); gating the load here keeps the parse_ast snapshot cheaper
            // while parse_ast_with_buf still snapshots the real events len.
            events_len: if self.emit_events { self.events.len() } else { 0 },
        }
    }
    #[inline(always)]
    fn shape_restore(&mut self, ck: ShapeCk) {
        self.pos = ck.pos;
        self.vals.truncate(ck.vals_len);
        self.arena.lists.truncate(ck.lists_len);
        self.ap_stack.truncate(ck.ap_len);
        while self.suppress_log.len() > ck.suppress_log_len {
            match self.suppress_log.pop() {
                Some((0, old)) => self.suppress_next = old,
                Some((_, old)) => self.suppress_cur = old,
                None => break,
            }
        }
        self.capped = ck.capped;
        // Only the emit_events walk (parse_ast_with_buf / parse_stream_buf)
        // populates self.events, so only that path needs the rollback truncate.
        if self.emit_events { self.events.truncate(ck.events_len); }
    }
    /// Pack the vals stack range [base..] into one value; list storage copies
    /// into the lists slab via memcpy (SVal is Copy — extend_from_slice
    /// specializes to ptr::copy_nonoverlapping; alloc-free once warm).
    #[inline(always)]
    fn shape_pack_range(&mut self, base: usize) -> SVal<'a> {
        let n = self.vals.len() - base;
        match n {
            0 => SVal::Null,
            1 => self.vals.pop().unwrap(),
            _ => {
                if self.vals[base..].iter().all(|v| matches!(v, SVal::TNode(..))) {
                    let st = self.arena.node_lists.len() as u32;
                    for v in &self.vals[base..] { if let SVal::TNode(t, i) = *v { self.arena.node_lists.push((t as u32) << 24 | i); } }
                    self.vals.truncate(base);
                    SVal::NodeList(st, n as u32)
                } else {
                    let start = self.arena.lists.len() as u32;
                    self.arena.lists.extend_from_slice(&self.vals[base..]);
                    self.vals.truncate(base);
                    SVal::List(start, n as u32)
                }
            }
        }
    }
    /// Pack [base..] to one value and leave it on the stack. For the common
    /// single-value case this is a no-op (the value is already in place),
    /// eliding the pop+push roundtrip of shape_pack_range + vals.push (the
    /// alt/star/sep codegen always packs then re-pushes).
    #[inline(always)] fn shape_pack_push(&mut self, base: usize) {
        let n = self.vals.len() - base;
        match n {
            0 => self.vals.push(SVal::Null),
            1 => {}
            _ => { let v = self.shape_pack_range(base); self.vals.push(v); }
        }
    }
    /// Close the vals stack range [base..] as a list value (copies it).
    #[inline(always)] fn shape_list_from(&mut self, base: usize) -> SVal<'a> {
        let n = self.vals.len() - base;
        match n {
            0 => SVal::List(0, 0),
            1 => {
                let v = self.vals.pop().unwrap();
                if matches!(v, SVal::TNode(..)) {
                    let st = self.arena.node_lists.len() as u32;
                    if let SVal::TNode(t, i) = v { self.arena.node_lists.push((t as u32) << 24 | i); }
                    SVal::NodeList(st, 1)
                } else {
                    let start = self.arena.lists.len() as u32;
                    self.arena.lists.push(v);
                    SVal::List(start, 1)
                }
            }
            _ => {
                if self.vals[base..].iter().all(|v| matches!(v, SVal::TNode(..))) {
                    let st = self.arena.node_lists.len() as u32;
                    for v in &self.vals[base..] { if let SVal::TNode(t, i) = *v { self.arena.node_lists.push((t as u32) << 24 | i); } }
                    self.vals.truncate(base);
                    SVal::NodeList(st, n as u32)
                } else {
                    let start = self.arena.lists.len() as u32;
                    self.arena.lists.extend_from_slice(&self.vals[base..]);
                    self.vals.truncate(base);
                    SVal::List(start, n as u32)
                }
            }
        }
    }
    fn shape_inline_finish(&mut self, base: usize) -> Option<SVal<'a>> {
        if self.vals.len() - base == 0 { None } else { Some(self.shape_pack_range(base)) }
    }
    /// Read an object's field by name (linear scan of its fields range).
    fn shape_obj_field(&self, obj: SVal<'a>, name: &'static str) -> SVal<'a> {
        if let SVal::Node(i) = obj {
            let o = &self.arena.nodes[i as usize];
            let (fs, fl) = o.fields;
            for (k, v) in &self.arena.fields[fs as usize..(fs + fl) as usize] {
                if *k == name { return *v; }
            }
        }
        SVal::Null
    }
    /// Fold child partial markers per parent folds (recursive into list slots). Equals TS _shapeFoldKids.
    /// Fast path: no folds, no partials ever created this parse (monotonic
    /// partial_count — M21), or no Partial kids at any depth → borrowed kids,
    /// zero allocation.
    fn shape_fold_kids<'x>(ar: &mut AstArena<'a>, customs: &'x C, kids: &'x [SVal<'a>], folds: &[(&'static str, &'static str)]) -> (std::borrow::Cow<'x, [SVal<'a>]>, Option<Vec<(&'static str, AstFoldCounts)>>) {
        if folds.is_empty() { return (std::borrow::Cow::Borrowed(kids), None); }
        if ar.partial_count == 0 { return (std::borrow::Cow::Borrowed(kids), None); }
        fn has_partial<'a>(ar: &AstArena<'a>, list: &[SVal<'a>]) -> bool {
            list.iter().any(|v| match *v {
                SVal::Partial(_) => true,
                SVal::List(_, _) => has_partial(ar, ar.list_of(*v)),
                _ => false,
            })
        }
        if !has_partial(ar, kids) { return (std::borrow::Cow::Borrowed(kids), None); }
        let mut state: Vec<(&'static str, AstFoldCounts)> = folds.iter().map(|(tag, _)| (*tag, AstFoldCounts::default())).collect();
        let out = Self::shape_fold_list(ar, customs, kids, folds, &mut state);
        (std::borrow::Cow::Owned(out), Some(state))
    }
    fn shape_fold_list(ar: &mut AstArena<'a>, customs: &C, list: &[SVal<'a>], folds: &[(&'static str, &'static str)], state: &mut Vec<(&'static str, AstFoldCounts)>) -> Vec<SVal<'a>> {
        let into_of = |tag: &str| -> Option<&'static str> {
            folds.iter().find(|(t, _)| *t == tag).map(|(_, into)| *into)
        };
        let mut out: Vec<SVal<'a>> = Vec::new();
        for k in list {
            match *k {
                SVal::Partial(pi) => {
                    let rec = ar.partials[pi as usize];
                    if let Some(into) = into_of(rec.tag) {
                        if rec.mode == "start" {
                            if let Some((_, c)) = state.iter_mut().find(|(t, _)| *t == rec.tag) { c.starts += 1; }
                            out.push(rec.value);
                        } else if rec.mode == "append" {
                            match out.last().copied() {
                                Some(SVal::Node(ni)) => {
                                    Self::shape_fold_append(ar, ni, into, rec.value);
                                    if let Some((_, c)) = state.iter_mut().find(|(t, _)| *t == rec.tag) { c.appends += 1; }
                                }
                                Some(SVal::TNode(tag, tidx)) => {
                                    customs.tnode_fold_append(ar, tag, tidx, into, rec.value);
                                    if let Some((_, c)) = state.iter_mut().find(|(t, _)| *t == rec.tag) { c.appends += 1; }
                                }
                                _ => panic!("shape: partial append has no preceding start for {}", rec.tag),
                            }
                        } else {
                            out.push(*k);
                        }
                    } else {
                        out.push(*k);
                    }
                }
                SVal::List(s, l) => {
                    let inner: Vec<SVal<'a>> = ar.lists[s as usize..(s + l) as usize].to_vec();
                    let folded = Self::shape_fold_list(ar, customs, &inner, folds, state);
                    let start = ar.lists.len() as u32;
                    let flen = folded.len() as u32;
                    ar.lists.extend_from_slice(&folded);
                    out.push(SVal::List(start, flen));
                }
                // NodeList holds packed TNode u32s — no Partial possible, pass through.
                SVal::NodeList(..) => out.push(*k),
                other => out.push(other),
            }
        }
        out
    }
    /// Append a partial value into an object's into-field (list slot), growing
    /// the field range at the slab tail when the field is absent.
    fn shape_fold_append(ar: &mut AstArena<'a>, ni: u32, into: &'static str, value: SVal<'a>) {
        let (fs, fl) = ar.nodes[ni as usize].fields;
        let fr = fs as usize..(fs + fl) as usize;
        let mut slot_idx: Option<usize> = None;
        for (i, (k, _)) in ar.fields[fr.clone()].iter().enumerate() {
            if *k == into { slot_idx = Some(fs as usize + i); break; }
        }
        if let Some(si) = slot_idx {
            match ar.fields[si].1 {
                SVal::List(s, l) => {
                    if (s + l) as usize == ar.lists.len() {
                        ar.lists.push(value);
                        ar.fields[si].1 = SVal::List(s, l + 1);
                    } else {
                        let start = ar.lists.len() as u32;
                        ar.lists.extend_from_within(s as usize..(s + l) as usize);
                        ar.lists.push(value);
                        ar.fields[si].1 = SVal::List(start, l + 1);
                    }
                }
                // Defensive: TS grammar never appends into a NodeList slot, but
                // unroll packed TNode elements into a generic List if it does.
                SVal::NodeList(s, l) => {
                    let start = ar.lists.len() as u32;
                    for e in &ar.node_lists[s as usize..(s + l) as usize] {
                        ar.lists.push(SVal::TNode((e >> 24) as u16, e & 0xFFFFFF));
                    }
                    ar.lists.push(value);
                    ar.fields[si].1 = SVal::List(start, l + 1);
                }
                _ => {
                    let start = ar.lists.len() as u32;
                    ar.lists.push(value);
                    ar.fields[si].1 = SVal::List(start, 1);
                }
            }
        } else {
            // Field absent: move the object's field range to the slab tail with the new field.
            let old: Vec<(&'static str, SVal<'a>)> = ar.fields[fr].to_vec();
            let start = ar.fields.len() as u32;
            ar.fields.extend(old);
            let vstart = ar.lists.len() as u32;
            ar.lists.push(value);
            ar.fields.push((into, SVal::List(vstart, 1)));
            ar.nodes[ni as usize].fields = (start, fl + 1);
        }
    }
    /// Head text of a value (≡ TS shapeHeadText) — spans where possible.
    fn shape_head_text(&mut self, v: SVal<'a>) -> SVal<'a> {
        match v {
            SVal::Null => SVal::Str(0, 0),
            SVal::TNode(t, i) => self.customs.tnode_head_text(t, i),
            SVal::Str(..) | SVal::OwnStr(_) => v,
            SVal::Number(n) => { let s = n.to_string(); self.arena.mk_own_str(&s) }
            SVal::Bool(b) => { let s = b.to_string(); self.arena.mk_own_str(&s) }
            SVal::List(s, l) => {
                if l == 0 { SVal::Str(0, 0) } else {
                    let first = self.arena.lists[s as usize];
                    // M21: keep-wrapper children's first kid is usually a Str
                    // (identifier/keyword) — resolve it inline instead of a
                    // recursive call; semantics identical to shape_head_text(first).
                    match first {
                        SVal::Str(..) | SVal::OwnStr(_) => first,
                        _ => self.shape_head_text(first),
                    }
                }
            }
            // NodeList elements are all TNode — head text resolves via the typed node.
            SVal::NodeList(s, l) => {
                if l == 0 { SVal::Str(0, 0) } else {
                    let e = self.arena.node_lists[s as usize];
                    self.customs.tnode_head_text((e >> 24) as u16, e & 0xFFFFFF)
                }
            }
            SVal::Partial(pi) => {
                let rec = self.arena.partials[pi as usize];
                self.shape_head_text(rec.value)
            }
            SVal::Node(_) => {
                let ht = self.shape_obj_field(v, "headText");
                if let SVal::Str(_, l) = ht { if l > 0 { return ht; } }
                if let SVal::OwnStr(_) = ht { return ht; }
                let op = self.shape_obj_field(v, "operator");
                let has_arg = !matches!(self.shape_obj_field(v, "argument"), SVal::Null);
                let has_left = !matches!(self.shape_obj_field(v, "left"), SVal::Null);
                let has_right = !matches!(self.shape_obj_field(v, "right"), SVal::Null);
                if has_arg && !has_left && !has_right {
                    if let SVal::Str(..) | SVal::OwnStr(_) = op { return op; }
                }
                let name = self.shape_obj_field(v, "name");
                if let SVal::Str(..) | SVal::OwnStr(_) = name { return name; }
                let val = self.shape_obj_field(v, "value");
                if !matches!(val, SVal::Null) { return self.shape_head_text(val); }
                let left = self.shape_obj_field(v, "left");
                if !matches!(left, SVal::Null) { return self.shape_head_text(left); }
                let kids = self.shape_obj_field(v, "children");
                if let SVal::List(s, l) = kids {
                    if l > 0 {
                        let first = self.arena.lists[s as usize];
                        return self.shape_head_text(first);
                    }
                }
                if let SVal::NodeList(s, l) = kids {
                    if l > 0 {
                        let e = self.arena.node_lists[s as usize];
                        return self.customs.tnode_head_text((e >> 24) as u16, e & 0xFFFFFF);
                    }
                }
                let arg = self.shape_obj_field(v, "argument");
                if !matches!(arg, SVal::Null) { return self.shape_head_text(arg); }
                SVal::Str(0, 0)
            }
            SVal::_Marker(_) => SVal::Str(0, 0),
        }
    }
    /// String view of a head-text value (for guard comparisons).
    fn shape_sval_str<'s>(ar: &'s AstArena<'a>, v: SVal<'a>) -> &'s str {
        match v {
            SVal::Str(o, l) => &ar.src[o as usize..(o + l) as usize],
            SVal::OwnStr(i) => &ar.strings[i as usize],
            _ => "",
        }
    }

${methods}
}

pub fn parse_ast_with<'a, 'c, C: ShapeCustoms<'a>>(src: &'a str, customs: &'c C) -> Option<AstRoot<'a>> {
    parse_ast_impl(src, customs, false, &mut None)
}
pub fn parse_ast_with_buf<'a, 'c, C: ShapeCustoms<'a>>(src: &'a str, customs: &'c C, events_buf: &mut Option<Vec<StreamEvent>>) -> Option<AstRoot<'a>> {
    parse_ast_impl(src, customs, true, events_buf)
}
fn parse_ast_impl<'a, 'c, C: ShapeCustoms<'a>>(src: &'a str, customs: &'c C, emit_events: bool, events_buf: &mut Option<Vec<StreamEvent>>) -> Option<AstRoot<'a>> {
    let toks = lex(src);
    let n = toks.len();
    customs.reserve(n);
    let events_init = events_buf.take().unwrap_or_else(Vec::new);
    let mut parser = ShapeParser {
        src, toks, pos: 0, customs,
        arena: AstArena {
            src,
            lists: Vec::with_capacity(n + 64),
            node_lists: Vec::with_capacity(n / 8 + 64),
            fields: Vec::with_capacity(n * 2 + 64),
            nodes: Vec::with_capacity(n * 3 / 4 + 64),
            partials: Vec::with_capacity(128),
            partial_count: 0,
            strings: Vec::with_capacity(n / 32 + 64),
        },
        vals: Vec::with_capacity(1024),
        ap_stack: Vec::with_capacity(256),
        suppress_next: 0, suppress_cur: 0, ctx: 0, suppress_log: Vec::with_capacity(64), capped: false, form: 0, tail: false,
        emit_events,
        events: events_init,
    };
    let root = parser.parse_ast_${ir.entry}()?;
    if parser.pos != parser.toks.len() { return None; }
    let events = parser.events;
    if emit_events { *events_buf = Some(events.clone()); }
    Some(AstRoot { root, arena: parser.arena, events })
}
pub fn parse_ast(src: &str) -> Option<AstRoot<'_>> {
    parse_ast_with(src, &DefaultShapeCustoms)
}
`;
}

const RS_ELEM: Record<Exclude<ListTy, `recs_${string}`>, string> = { metas: 'AlignMeta', toks: 'Tok', bools: 'bool', depths: 'i64', edits: 'Edit' };
const RS_SCALAR: Record<string, string> = { int: 'isize', lid: 'u16', depth: 'i64', pos: 'u32', idx: 'usize', bool: 'bool', meta: 'AlignMeta', tok: 'Tok' };
const RS_META: Record<MetaInt, string> = { off: 'u32', end: 'u32', kid: 'u16', pd: 'u16', fd: 'u16', td: 'u8' };
const RS_TOK: Record<TokInt, string> = { off: 'u32', end: 'u32', kid: 'u16', lid: 'u16' };
const RS_MK: Record<keyof MkMeta, string> = { off: 'u32', end: 'u32', kid: 'u16', nl: 'bool', fd: 'u16', pd: 'u16', lc: 'bool', lb: 'bool', hd: 'bool', td: 'u8' };
// Operator spelling and binding strength; unary is 90, a negative literal 7, an `as` cast 8
// (bare as an argument or index, parenthesized as an operand, where `x as T < y` reads as generics).
const RS_OPS: Record<BinOp, [string, number]> = {
  or: ['||', 1], and: ['&&', 2], eq: ['==', 3], ne: ['!=', 3], lt: ['<', 4], le: ['<=', 4], gt: ['>', 4], ge: ['>=', 4], shr: ['>>', 5], shl: ['<<', 5], add: ['+', 6], sub: ['-', 6],
};
const RS_CAST = 8;
const RS_IND = '    ';
const snake = (s: string): string => s.replace(/[A-Z]/g, (m) => '_' + m.toLowerCase());
const rsWrap = (r: R, min: number): string => (r.prec < min ? `(${r.c})` : r.c);
const rsBlock = (lines: string[]): string[] => lines.map((l) => RS_IND + l);

// Shared-algorithm lowering: snake_case, `as` casts, owned String/Vec vs borrowed &str/&[T].
// Lists without an exact capacity grow as they are pushed to. Exact capacities are kept.
const rustLowering: Lowering = {
  units: UNITS,
  ident: snake,
  num: { int: 'isize', lid: 'u16', depth: 'i64', pos: 'u32', idx: 'usize' },
  type: (t, role, owned) => {
    if (isList(t)) {
      const el = isRecList(t) ? recName(t) : RS_ELEM[t];
      return role === 'param' ? `&[${el}]` : `Vec<${el}>`;
    }
    if (isRec(t)) return recName(t);
    if (isOpt(t)) return `Option<${recName(t)}>`;
    if (t === 'str') return role === 'param' || !owned ? '&str' : 'String';
    if (t === 'edit') return '&Edit';
    return RS_SCALAR[t];
  },
  cast: (_cx, r, nat) => ({ ...r, c: `${rsWrap(r, ATOM)} as ${nat}`, nat, prec: RS_CAST }),
  owns: true,
  borrowStr: (r) => (!r.owned ? r.c : /^\w+$/.test(r.c) ? `${r.c}.as_str()` : `(${r.c}).as_str()`),
  borrowList: (r) => (r.owned ? `&${r.c}` : r.c),
  borrowVal: (r) => `&${r.c}`,
  charSet: (name, rs) => {
    const a = Array<boolean>(256).fill(false);
    for (const [lo, hi] of rs) for (let c = lo; c <= hi; c++) a[c] = true;
    return `const ${name.toUpperCase()}: [bool; 256] = [${a.map((b) => (b ? 'true' : 'false')).join(', ')}];`;
  },
  // Four bytes per round: one table test each, and one bounds test per round instead of per byte.
  runEndFn: `/// The end of the run of bytes in \`set\` from i: the first j >= i at which b ends or b[j] is not in it.
#[inline(always)]
fn lex_run_end(b: &[u8], mut i: usize, set: &[bool; 256]) -> usize {
    while let Some(w) = b.get(i..i + 4) {
        if !set[w[0] as usize] { return i; }
        if !set[w[1] as usize] { return i + 1; }
        if !set[w[2] as usize] { return i + 2; }
        if !set[w[3] as usize] { return i + 3; }
        i += 4;
    }
    while i < b.len() && set[b[i] as usize] { i += 1; }
    i
}`,
  // Eight bytes per round test for the literal's first byte (a zero-byte mask of the word XOR that
  // byte: its lowest flagged byte is the first match); a match is then compared whole.
  findFn: `/// Where lit next occurs in b from i: the first j >= i at which b has it, or b.len().
#[inline(never)]
fn lex_find(b: &[u8], mut i: usize, lit: &[u8]) -> usize {
    const L: u64 = 0x0101_0101_0101_0101;
    let k = L * lit[0] as u64;
    loop {
        match b.get(i..i + 8) {
            Some(w) => {
                let v = u64::from_le_bytes([w[0], w[1], w[2], w[3], w[4], w[5], w[6], w[7]]) ^ k;
                let m = v.wrapping_sub(L) & !v & (L << 7);
                if m == 0 { i += 8; continue; }
                i += (m.trailing_zeros() >> 3) as usize;
            }
            None => {
                while i < b.len() && b[i] != lit[0] { i += 1; }
                if i == b.len() { return i; }
            }
        }
        if b[i..].starts_with(lit) { return i; }
        i += 1;
    }
}`,
  // Eight bytes per round: each test of the stop plan flags the bytes that may begin a stop (a
  // zero-byte mask of the word XOR a byte, or the bytes below a bound), ORed; each flagged byte, in
  // order, is then confirmed, without reading the word again.
  findAnyFn: (stops) => {
    const { masks, one, wide } = stopBytes(stops);
    const hex = (b: number) => `0x${b.toString(16).toUpperCase().padStart(2, '0')}`;
    const lets: string[] = [], terms: string[] = [];
    masks.forEach((m, k) => {
      if ('below' in m) terms.push(`(v.wrapping_sub(L * ${hex(m.below)}) & !v)`);
      else { lets.push(`let x${k} = v ^ (L * ${hex(m.eq)});`); terms.push(`(x${k}.wrapping_sub(L) & !x${k})`); }
    });
    const at = (j: string) => [
      ...one.map((b) => `b[${j}] == ${hex(b)}`),
      ...wide.map((w) => `(b[${j}..].starts_with(&[${w.head.map(hex).join(', ')}]) && matches!(b.get(${j} + ${w.head.length}), Some(&(${w.last.map(hex).join(' | ')}))))`),
    ].join(' || ');
    return `/// Where the next of ${stops.map((c) => `U+${c.toString(16).toUpperCase().padStart(4, '0')}`).join(', ')} is in b from i: the index of its first byte, or b.len().
#[inline(never)]
fn ${findAnyName(stops)}(b: &[u8], mut i: usize) -> usize {
    const L: u64 = 0x0101_0101_0101_0101;
    while let Some(w) = b.get(i..i + 8) {
        let v = u64::from_le_bytes([w[0], w[1], w[2], w[3], w[4], w[5], w[6], w[7]]);
        ${lets.join('\n        ')}
        let mut m = (${terms.join(' | ')}) & (L << 7);
        while m != 0 {
            let j = i + (m.trailing_zeros() >> 3) as usize;
            if ${at('j')} { return j; }
            m &= m - 1;
        }
        i += 8;
    }
    while i < b.len() {
        if ${at('i')} { return i; }
        i += 1;
    }
    i
}`;
  },
  expr: {
    literal: (v) => ({ c: typeof v === 'string' ? JSON.stringify(v) : String(v), prec: typeof v === 'number' && v < 0 ? 7 : ATOM }),
    not: (r) => ({ c: `!${rsWrap(r, ATOM)}`, prec: 90 }),
    bin: (op, a, b) => {
      const [sp, p] = RS_OPS[op];
      const side = (r: R, right: boolean): string =>
        (r.prec < p || r.prec === RS_CAST || (right && r.prec === p) || ((op === 'shr' || op === 'shl') && r.prec < ATOM) || (COMPARISON.has(op) && r.prec >= 3 && r.prec <= 4) ? `(${r.c})` : r.c);
      return { c: `${side(a, false)} ${sp} ${side(b, true)}`, prec: p };
    },
    call: (name, args) => `${name}(${args.join(', ')})`,
    len: (cx, l) => cx.atom(`${rsWrap(l, ATOM)}.len()`, 'int', 'usize'),
    code: (cx, s, i) => ({ c: `${rsWrap(s, ATOM)}.as_bytes()[${cx.coerce(i, 'usize')}] as u32`, ty: 'int', nat: 'u32', prec: RS_CAST }),
    hasAt: (cx, s, i, lit) => cx.atom(`${rsWrap(s, ATOM)}.as_bytes()[${cx.coerce(i, 'usize')}..].starts_with(${J(lit)}.as_bytes())`, 'bool', 'bool'),
    inSet: (cx, set, c) => cx.atom(`${set.toUpperCase()}[${cx.coerce(c, 'usize')}]`, 'bool', 'bool'),
    runEnd: (cx, set, s, i) => cx.atom(`lex_run_end(${rsWrap(s, ATOM)}.as_bytes(), ${cx.coerce(i, 'usize')}, &${set.toUpperCase()})`, 'int', 'usize'),
    find: (cx, s, i, lit) => cx.atom(`lex_find(${rsWrap(s, ATOM)}.as_bytes(), ${cx.coerce(i, 'usize')}, ${J(lit)}.as_bytes())`, 'int', 'usize'),
    findAny: (cx, s, i, stops) => cx.atom(`${findAnyName(stops)}(${rsWrap(s, ATOM)}.as_bytes(), ${cx.coerce(i, 'usize')})`, 'int', 'usize'),
    own: (cx, r) => {
      if (r.ty === 'str') return cx.atom(`${rsWrap(r, ATOM)}.to_string()`, 'str', 'str', { owned: true });
      if (isList(r.ty)) return cx.atom(`${rsWrap(r, ATOM)}.to_vec()`, r.ty, r.ty, { owned: true });
      return r;
    },
  },
  stmt: {
    comment: (text) => [`// ${text}`],
    let: (cx, s) => [`let ${s.mutable ? 'mut ' : ''}${s.id}: ${cx.type(s.ty, 'local', s.owned)} = ${isNum(s.ty) ? cx.coerce(s.r, cx.nat(s.ty)) : s.r.c};`],
    set: (id, val) => [`${id} = ${val};`],
    if: (s) => {
      const head = `if ${s.c}`;
      if (s.inline !== undefined && RS_IND.length * s.depth + head.length + s.inline.length + 5 <= 110) return [`${head} { ${s.inline} }`];
      return [`${head} {`, ...rsBlock(s.then), ...(s.else ? ['} else {', ...rsBlock(s.else)] : []), '}'];
    },
    while: (c, body) => [`while ${c} {`, ...rsBlock(body), '}'],
    break: () => ['break;'],
    run: (call) => `${call};`,
    return: (vals) => [`return ${vals.length === 1 ? vals[0] : `(${vals.join(', ')})`};`],
    fn: (f) => [
      ...f.doc.map((l) => `// ${l}`),
      ...(f.inline ? ['#[inline(always)]'] : []),
      // Out of line only: `#[cold]` on the identifier escape scanners moved lex_from's register layout
      // (+0.2% to +0.4% lexer instructions on real inputs, profile runs 45034540295 / 45035043707).
      ...(f.cold ? ['#[inline(never)]'] : []),
      `fn ${f.name}(${f.params.map((p) => `${p.name}: ${p.type}`).join(', ')})${f.rets.length === 0 ? '' : ` -> ${f.rets.length === 1 ? f.rets[0] : `(${f.rets.join(', ')})`}`} {`,
      ...rsBlock(f.body),
      '}',
    ].join('\n'),
  },
  relex: {
    index: 'usize',
    expr: {
      index: (l, i) => ({ c: `${rsWrap(l, ATOM)}[${i.c}]`, prec: ATOM }),
      metaInt: (cx, m, f) => cx.atom(`${rsWrap(m, ATOM)}.${f}`, 'int', RS_META[f]),
      metaFlag: (cx, m, f) => cx.atom(`am_${f}(${cx.ref(m)})`, 'bool', 'bool'),
      tokInt: (cx, t, f) => cx.atom(`${rsWrap(t, ATOM)}.${f}`, 'int', RS_TOK[f]),
      tokNl: (cx, t) => cx.atom(`${rsWrap(t, ATOM)}.nl`, 'bool', 'bool'),
      editInt: (cx, e, f) => cx.atom(`${e.c}.${f}`, 'int', 'usize'),
      editText: (cx, e) => cx.atom(`${e.c}.text.as_str()`, 'str', 'str', { owned: false }),
      metaText: (cx, t, m) => cx.atom(`am_text(${cx.str(t)}, ${cx.ref(m)})`, 'str', 'str', { owned: false }),
      substr: (cx, s, a, b) => ({ c: `&${rsWrap(s, ATOM)}[${cx.coerce(a, 'usize')}..${cx.coerce(b, 'usize')}]`, ty: 'str', nat: 'str', prec: 90, owned: false }),
      lidOf: (cx, s) => cx.atom(`lid_of(${cx.str(s)}.as_bytes())`, 'lid', cx.nat('lid')),
      mkMeta: (cx, fs) => cx.atom(`mk_align(${fs.map(([f, r]) => cx.coerce(r, RS_MK[f])).join(', ')})`, 'meta', 'meta'),
      shiftMeta: (cx, m, d) => cx.atom(`shift_align(${cx.ref(m)}, ${cx.coerce(d, 'isize')})`, 'meta', 'meta'),
      metaEq: (_cx, a, b) => ({ c: `${a.c} == ${b.c}`, ty: 'bool', nat: 'bool', prec: RS_OPS.eq[1] }),
      splice: (cx, s, a, b, ins) => cx.atom(`format!("{}{}{}", &${rsWrap(s, ATOM)}[..${cx.coerce(a, 'usize')}], ${cx.str(ins)}, &${rsWrap(s, ATOM)}[${cx.coerce(b, 'usize')}..])`, 'str', 'str', { owned: true }),
      newList: (cx, ty, cap) => cx.atom(cap ? `Vec::with_capacity(${cx.coerce(cap, 'usize')})` : 'Vec::new()', ty, ty, { owned: true }),
      falses: (cx, n) => cx.atom(`vec![false; ${cx.coerce(n, 'usize')}]`, 'bools', 'bools', { owned: true }),
      prefix: (cx, l, n) => cx.atom(`${rsWrap(l, ATOM)}[..${cx.coerce(n, 'usize')}].to_vec()`, l.ty, l.ty, { owned: true }),
    },
    stmt: {
      setAt: (id, i, val) => [`${id}[${i}] = ${val};`],
      push: (_cx, l, r) => [`${l}.push(${r.c});`],
      for: (cx, v, from, to, body) => [`for ${v} in ${cx.coerce(from, 'isize')}..${cx.coerce(to, 'isize')} {`, ...rsBlock(body), '}'],
      forEach: (v, l, body) => [`for ${v} in ${l} {`, ...rsBlock(body), '}'],
      destructure: (_cx, s) => {
        if (!s.declare) return [`(${s.ids.join(', ')}) = ${s.call};`];
        return [`let (${s.names.map((n, i) => (n !== '_' && s.mutable(n) ? `mut ${s.ids[i]}` : s.ids[i])).join(', ')}) = ${s.call};`];
      },
      lexStep: (cx, s) => [
        `let lexed = lex_from(${cx.str(s.text)}, ${s.pos} as usize, ${[...s.state, `&mut ${s.out}`].join(', ')}, 1);`,
        `${s.pos} = lexed.0 as isize;`,
        ...s.state.map((n, i) => `${n} = lexed.${i + 1};`),
        `${s.err} = lexed.${s.state.length + 1};`,
      ],
      lexAll: (cx, s) => [`let (${s.mutable ? 'mut ' : ''}${s.out}, ${s.err}) = lex_all(${cx.str(s.text)});`],
    },
  },
  record: {
    field: (cx, r, _rec, f, ty, nat) => cx.atom(`${rsWrap(r, ATOM)}.${snake(f)}`, ty, nat),
    setField: (id, f, val) => [`${id}.${snake(f)} = ${val};`],
    make: (cx, rec, fs) => cx.atom(`${rec} { ${fs.map(([f, v]) => `${snake(f)}: ${v}`).join(', ')} }`, `rec_${rec}`, `rec_${rec}`, { owned: true }),
    refType: (rec) => `&mut ${rec}`,
    refArg: (r) => `&mut ${r.c}`,
    extend: (_cx, l, from) => [`${l}.extend_from_slice(${from.owned ? `&${from.c}` : from.c});`],
    none: (cx, rec) => cx.atom('None', `opt_${rec}`, `opt_${rec}`),
    some: (cx, rec, r) => cx.atom(`Some(${r.c})`, `opt_${rec}`, `opt_${rec}`),
    isSome: (_cx, r) => ({ c: `${rsWrap(r, ATOM)}.is_some()`, prec: ATOM }),
  },
};

// Callee-FIRST body guards: a Rust rd call runs its prologue before the dispatch that refuses (40-48
// instructions per refused call, PR #184), more than the guard's test on each iteration.
const FACTS: PortableFacts = { calleeFirstGuards: true };

export const rustTarget = defineTarget({
  name: 'rust',
  ext: 'rs',
  lowering: rustLowering,
  emitParser(grammar: CstGrammar, shared: SharedAlgorithms): string {
    const ir = portableIR(grammar, FACTS);
    return emitRustLibrary(ir, buildLexIdPlan(ir), shared);
  },
  emitRunner,
});

function emitRustLibrary(ir: ParserIR, ids: LexIdPlan, shared: SharedAlgorithms): string {
    const ar = buildArenaIdPlan(ir, ids);
    const reuse = ir.reuse;
    const shapeB = reuse?.kind === 'B';
    const reuseInit = reuse ? ', entries: Vec::new()' : '';
    // EntryMeta is always emitted — Builder::entry_meta returns it (even when the side table is unused).
    const entryMetaStruct = `\n#[derive(Clone, Copy)]\nstruct EntryMeta { tok_start: u32, tok_end: u32, ext: u32, off: u32, end: u32, kid_start: u32, kid_count: u32 }\n`;
    const arenaIdTables = renderArenaIdTablesRust(ar);
    return `// GENERATED by emit-portable.ts (rustTarget) — parser library for grammar "${ir.grammarName}".
// Public API: tokenize(src) -> Result<Vec<Token>, LexError> (the lexer alone; tokens borrow only src), parse_with /
// Doc (CST). Compile as a library (rustc --crate-type lib) or include via \`mod\`.
#![allow(non_snake_case)]

// Slim hot-path token (16B): kind/text reconstructed via KIND_STR / src[off..end].
#[repr(C)]
#[derive(Clone, Copy)]
struct Tok { off: u32, end: u32, kid: u16, lid: u16, nl: bool }
const _: () = assert!(std::mem::size_of::<Tok>() == 16);

// Arena node: a flat record in \`nodes\`; children are a contiguous range in \`kids\`.
// Rule nodes only — leaf kids are negative i32 encodings in \`kids\` / \`scratch\`.
#[repr(C)]
#[derive(Clone, Copy)]
struct Node { rule_id: u16, kid_start: u32, kid_count: u32, offset: u32, end: u32, tok_start: u32, tok_end: u32, ext: u32 }
const _: () = assert!(std::mem::size_of::<Node>() == 32);
${entryMetaStruct}
${lexer(ir, ids, shared)}

${arenaIdTables}
const ARENA_COMPACT_K: usize = 4;

#[inline]
fn encode_leaf(tok_idx: u32, tt_id: u8) -> i32 {
    debug_assert!(tok_idx < (1u32 << 25));
    debug_assert!((tt_id as u32) < 64);
    let packed = tok_idx | ((tt_id as u32) << 25);
    !(packed as i32)
}
#[inline]
fn decode_leaf(v: i32) -> (u32, u8) {
    debug_assert!(v < 0);
    let packed = (!v) as u32;
    (packed & ((1u32 << 25) - 1), (packed >> 25) as u8)
}
/// A leaf's end offset: an operator leaf at a '>' spans the composite read there (gt_op).
#[inline]
fn leaf_end(toks: &[Tok], ti: u32, tt: u8) -> u32 {
    let t = &toks[ti as usize];
    if tt == ${ttIdOf(ar, '$operator')} && t.lid == GT_LID { gt_op(toks, ti as usize).2 } else { t.end }
}

${emitParserMachine(ir, ids, ar, shapeB)}

fn write_json_kid(nodes: &[Node], kids: &[i32], toks: &[Tok], kid: i32, out: &mut String) {
    if kid < 0 {
        let (ti, tt) = decode_leaf(kid);
        out.push_str(&format!("{{\\"tokenType\\":\\"{}\\",\\"offset\\":{},\\"end\\":{}}}", TT_NAMES[tt as usize], toks[ti as usize].off, leaf_end(toks, ti, tt)));
        return;
    }
    write_json_arena(nodes, kids, toks, kid, out);
}
fn write_json_arena(nodes: &[Node], kids: &[i32], toks: &[Tok], id: i32, out: &mut String) {
    let nd = &nodes[id as usize];
    out.push_str(&format!("{{\\"rule\\":\\"{}\\",\\"children\\":[", RULE_NAMES[nd.rule_id as usize]));
    for i in 0..nd.kid_count {
        if i > 0 { out.push(','); }
        write_json_kid(nodes, kids, toks, kids[nd.kid_start as usize + i as usize], out);
    }
    out.push_str(&format!("],\\"offset\\":{},\\"end\\":{}}}", nd.offset, nd.end));
}
fn write_json(p: &Parser<'_>, id: i32, out: &mut String) {
    write_json_arena(&p.b.nodes, &p.b.kids, &p.toks, id, out);
}

/// A token of the public tokenizer: owned fields plus a text slice borrowed from the source.
pub struct Token<'a> { pub kind: &'static str, pub text: &'a str, pub off: usize, pub end: usize, pub nl: bool, pub kid: u16, pub lid: u16 }
/// The lexer alone: a fresh Vec the caller owns (Rust keeps no globals, so nothing else is touched),
/// or the error of input the lexer cannot tokenize (its offset and message: "Unexpected character
/// at offset …", "Unterminated template literal at offset …").
pub fn tokenize<'a>(src: &'a str) -> Result<Vec<Token<'a>>, LexError> {
    match lex_all(src) {
        (toks, None) => Ok(toks.into_iter().map(|t| Token { kind: tok_kind(&t), text: tok_text(src, &t), off: t.off as usize, end: t.end as usize, nl: t.nl, kid: t.kid, lid: t.lid }).collect()),
        (_, Some(e)) => Err(lex_error(src, e)),
    }
}
// The CST over a fresh arena that lives in the returned Parser (serialize with write_json).
// Library callers use parse_with / Doc.
fn parse<'a>(src: &'a str) -> Option<(Parser<'a>, i32)> {
    let mut p = Parser { toks: lex(src), pos: 0, max_look: 0, peek_end: 0, capped: false, form: 0, tail: false, suppress_next: 0, suppress_cur: 0, ctx: 0, src, b: CstBuilder::default(), scratch: Vec::new()${reuseInit} };
    match p.parse_${ir.entry}() {
        Some(fr) if p.pos == p.toks.len() => Some((p, fr.root())),
        _ => None,
    }
}

${docEditBlockRust(ir, shared)}
${emitParseWithHelpers(ir, shapeB)}
`;
}

function emitRunner(): string {
    return `
// CLI runner (harness only): stdin -> CST JSON + a self-bench mode. Appended to the parser
// library by the gate (same file/crate, so it calls \`parse\`/\`write_json\` directly); NOT part
// of the parser.
fn skip_ws(s: &[u8], mut i: usize) -> usize { while i < s.len() && (s[i] as char).is_whitespace() { i += 1; } i }
fn parse_str(s: &[u8], mut i: usize) -> Option<(String, usize)> {
    if s.get(i)? != &b'"' { return None; }
    i += 1;
    let mut out = String::new();
    while i < s.len() {
        match s[i] {
            b'"' => return Some((out, i + 1)),
            b'\\\\' => { i += 1; if i >= s.len() { return None; }
                out.push(match s[i] { b'n' => '\\n', b'r' => '\\r', b't' => '\\t', b'"' => '"', b'\\\\' => '\\\\', b'/' => '/', c => c as char });
                i += 1; }
            // Decode UTF-8 properly: byte-as-char Latin-1 corrupted multi-byte (e.g. é → Ã©)
            // and made edit offsets disagree with go/ts JSON parsers.
            c if c < 0x80 => { out.push(c as char); i += 1; }
            _ => {
                let w = match s[i] { 0xC0..=0xDF => 2, 0xE0..=0xEF => 3, 0xF0..=0xF7 => 4, _ => return None };
                if i + w > s.len() { return None; }
                let ch = std::str::from_utf8(&s[i..i + w]).ok()?.chars().next()?;
                out.push(ch); i += w;
            }
        }
    }
    None
}
fn parse_num(s: &[u8], mut i: usize) -> Option<(usize, usize)> {
    let start = i;
    while i < s.len() && s[i].is_ascii_digit() { i += 1; }
    if i == start { return None; }
    s[start..i].iter().fold(Some(0usize), |a, &d| a.and_then(|n| n.checked_mul(10).and_then(|m| m.checked_add((d - b'0') as usize))))
        .map(|n| (n, i))
}
fn parse_triple(s: &[u8], mut i: usize) -> Option<((usize, usize, String), usize)> {
    if s.get(i)? != &b'[' { return None; }
    i = skip_ws(s, i + 1);
    let (a, mut i) = parse_num(s, i)?;
    i = skip_ws(s, i); if s.get(i)? != &b',' { return None; }
    i = skip_ws(s, i + 1);
    let (b, mut i) = parse_num(s, i)?;
    i = skip_ws(s, i); if s.get(i)? != &b',' { return None; }
    i = skip_ws(s, i + 1);
    let (t, mut i) = parse_str(s, i)?;
    i = skip_ws(s, i); if s.get(i)? != &b']' { return None; }
    Some(((a, b, t), i + 1))
}
fn parse_batch(s: &[u8], mut i: usize) -> Option<(Vec<(usize, usize, String)>, usize)> {
    if s.get(i)? != &b'[' { return None; }
    i = skip_ws(s, i + 1);
    let mut batch = Vec::new();
    if s.get(i)? == &b']' { return Some((batch, i + 1)); }
    loop {
        let (t, ni) = parse_triple(s, i)?;
        batch.push(t);
        i = skip_ws(s, ni);
        if s.get(i)? == &b']' { return Some((batch, i + 1)); }
        if s.get(i)? != &b',' { return None; }
        i = skip_ws(s, i + 1);
    }
}
fn parse_edit_session(s: &str) -> Option<(String, Vec<Vec<(usize, usize, String)>>)> {
    let b = s.as_bytes();
    let mut i = skip_ws(b, 0);
    if b.get(i)? != &b'{' { return None; }
    i = skip_ws(b, i + 1);
    let mut init = None;
    let mut batches = None;
    loop {
        let (key, ni) = parse_str(b, i)?;
        i = skip_ws(b, ni);
        if b.get(i)? != &b':' { return None; }
        i = skip_ws(b, i + 1);
        if key == "init" {
            let (v, ni) = parse_str(b, i)?;
            init = Some(v);
            i = skip_ws(b, ni);
        } else if key == "batches" {
            if b.get(i)? != &b'[' { return None; }
            i = skip_ws(b, i + 1);
            let mut bs = Vec::new();
            if b.get(i)? == &b']' { batches = Some(bs); i += 1; }
            else {
                loop {
                    let (batch, ni) = parse_batch(b, i)?;
                    bs.push(batch);
                    i = skip_ws(b, ni);
                    if b.get(i)? == &b']' { batches = Some(bs); i += 1; break; }
                    if b.get(i)? != &b',' { return None; }
                    i = skip_ws(b, i + 1);
                }
            }
        } else { return None; }
        if b.get(i)? == &b'}' { break; }
        if b.get(i)? != &b',' { return None; }
        i = skip_ws(b, i + 1);
    }
    Some((init?, batches?))
}

fn main() {
    use std::io::Read;
    let mut src = String::new();
    std::io::stdin().read_to_string(&mut src).unwrap();
    let args: Vec<String> = std::env::args().collect();
    if args.len() > 1 && (args[1] == "edit-session" || args[1] == "edit-session-fast") {
        let (init, batches) = parse_edit_session(&src).unwrap();
        let mut doc = Doc::new(init);
        if args[1] == "edit-session" { doc.set_validate(true); }
        for batch in &batches {
            let edits: Vec<Edit> = batch.iter().map(|&(s, e, ref t)| Edit { start: s, end: e, text: t.clone() }).collect();
            doc.edit(&edits);
        }
        if let Some(a) = doc.alignment() {
            match (a.stream_eq, a.tree_eq) {
                (Some(eq), Some(te)) => eprintln!("{{\\"oldN\\":{},\\"newN\\":{},\\"prefix\\":{},\\"suffix\\":{},\\"relexed\\":{},\\"reused\\":{},\\"streamEq\\":{},\\"treeEq\\":{}}}", a.old_n, a.new_n, a.prefix, a.suffix, a.relexed, a.reused, eq, te),
                (Some(eq), None) => eprintln!("{{\\"oldN\\":{},\\"newN\\":{},\\"prefix\\":{},\\"suffix\\":{},\\"relexed\\":{},\\"reused\\":{},\\"streamEq\\":{}}}", a.old_n, a.new_n, a.prefix, a.suffix, a.relexed, a.reused, eq),
                (None, Some(te)) => eprintln!("{{\\"oldN\\":{},\\"newN\\":{},\\"prefix\\":{},\\"suffix\\":{},\\"relexed\\":{},\\"reused\\":{},\\"treeEq\\":{}}}", a.old_n, a.new_n, a.prefix, a.suffix, a.relexed, a.reused, te),
                (None, None) => eprintln!("{{\\"oldN\\":{},\\"newN\\":{},\\"prefix\\":{},\\"suffix\\":{},\\"relexed\\":{},\\"reused\\":{}}}", a.old_n, a.new_n, a.prefix, a.suffix, a.relexed, a.reused),
            }
        }
        match doc.cst_json() {
            Some(out) => print!("{}", out),
            None => { eprintln!("parse error"); std::process::exit(1); }
        }
        return;
    }
    // Self-bench: a numeric arg N times the lex+parse loop and prints ms/iteration.
    if let Some(iters) = args.get(1).and_then(|a| a.parse::<u64>().ok()) {
        for _ in 0..3 { let s = std::hint::black_box(&src); if let Some((p, r)) = parse(s) { std::hint::black_box((&p.b.nodes[r as usize], p.pos)); } }
        let t = std::time::Instant::now();
        for _ in 0..iters { let s = std::hint::black_box(&src); if let Some((p, r)) = parse(s) { std::hint::black_box((&p.b.nodes[r as usize], p.pos)); } }
        println!("{:.4}", t.elapsed().as_secs_f64() * 1000.0 / iters as f64);
        return;
    }
    // batch: NUL-separated inputs in, one line per input out — the CST JSON, "-" for an input
    // the parser rejects, or "!" and the message for one that panicked (a lexer error panics).
    // One process start for a whole corpus.
    if args.get(1).map(|a| a.as_str()) == Some("batch") {
        std::panic::set_hook(Box::new(|_| {}));
        let mut out = String::new();
        for s in src.split('\\0') {
            let line = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let mut one = String::new();
                match parse(s) {
                    Some((p, root)) => write_json(&p, root, &mut one),
                    None => one.push('-'),
                }
                one
            }));
            match line {
                Ok(l) => out.push_str(&l),
                Err(e) => {
                    out.push('!');
                    if let Some(m) = e.downcast_ref::<String>() { out.push_str(&m.replace('\\n', " ")); }
                    else if let Some(m) = e.downcast_ref::<&str>() { out.push_str(&m.replace('\\n', " ")); }
                }
            }
            out.push('\\n');
        }
        print!("{}", out);
        return;
    }
    // batch-doc: as batch, but each input is typed into an empty Doc (one edit), so the whole text
    // is parsed from tokens the Doc rebuilds from its metadata — the CST JSON, or "-" when that
    // Doc rejects (a lexer error included).
    if args.get(1).map(|a| a.as_str()) == Some("batch-doc") {
        std::panic::set_hook(Box::new(|_| {}));
        let mut out = String::new();
        for s in src.split('\\0') {
            let line = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let mut doc: Doc<CstBuilder> = Doc::new(String::new());
                doc.edit(&[Edit { start: 0, end: 0, text: s.to_string() }]);
                doc.cst_json()
            }));
            match line { Ok(Some(l)) => out.push_str(&l), _ => out.push('-') }
            out.push('\\n');
        }
        print!("{}", out);
        return;
    }
    // lid-of: NUL-separated texts in, one line per text out — lid_of(text), the literal id the Doc
    // gives a token of that text when it rebuilds the token from its metadata.
    if args.get(1).map(|a| a.as_str()) == Some("lid-of") {
        let mut out = String::new();
        for s in src.split('\\0') { out.push_str(&lid_of(s.as_bytes()).to_string()); out.push('\\n'); }
        print!("{}", out);
        return;
    }
    // batch-tokens: NUL-separated inputs in, one line per input out — the token stream as a JSON
    // array of [kind, text, newline-before, lid], or "!" and the message for a lexer error.
    if args.get(1).map(|a| a.as_str()) == Some("batch-tokens") {
        std::panic::set_hook(Box::new(|_| {}));
        let js = |t: &str, out: &mut String| {
            out.push('"');
            for ch in t.chars() {
                match ch {
                    '"' => out.push_str("\\\\\\""),
                    '\\\\' => out.push_str("\\\\\\\\"),
                    c if (c as u32) < 0x20 => out.push_str(&format!("\\\\u{:04x}", c as u32)),
                    c => out.push(c),
                }
            }
            out.push('"');
        };
        let mut out = String::new();
        for s in src.split('\\0') {
            match tokenize(s) {
                Ok(toks) => {
                    out.push('[');
                    for (i, t) in toks.iter().enumerate() {
                        if i > 0 { out.push(','); }
                        out.push('['); js(t.kind, &mut out); out.push(','); js(t.text, &mut out); out.push_str(if t.nl { ",true," } else { ",false," }); out.push_str(&t.lid.to_string()); out.push(']');
                    }
                    out.push(']');
                }
                Err(e) => { out.push('!'); out.push_str(&e.msg.replace('\\n', " ")); }
            }
            out.push('\\n');
        }
        print!("{}", out);
        return;
    }
    if args.get(1).map(|a| a.as_str()) == Some("tok-spans") {
        match parse(&src) {
            Some((p, root)) => {
                let nd = &p.b.nodes[root as usize];
                for i in 0..nd.kid_count {
                    let kv = p.b.kids[nd.kid_start as usize + i as usize];
                    if kv < 0 {
                        let (ti, tt) = decode_leaf(kv);
                        println!("{}\t{}\t{}", TT_NAMES[tt as usize], ti, ti + 1);
                    } else {
                        let k = &p.b.nodes[kv as usize];
                        println!("{}\t{}\t{}", RULE_NAMES[k.rule_id as usize], k.tok_start, k.tok_end);
                    }
                }
                println!("total\t0\t{}", p.pos);
            }
            None => { eprintln!("parse error"); std::process::exit(1); }
        }
        return;
    }
    match parse(&src) {
        Some((p, root)) => { let mut out = String::new(); write_json(&p, root, &mut out); print!("{}", out); }
        None => { eprintln!("parse error"); std::process::exit(1); }
    }
}
`;
}

/** Emit a Rust parser with an optional specialized declarative-shape AST entry. */
export function emitRust(grammar: CstGrammar, opts?: { shape?: ShapeSpec }): string {
  const ir = portableIR(grammar, FACTS);
  const ids = buildLexIdPlan(ir);
  const base = emitRustLibrary(ir, ids, rustTarget.shared);
  if (!opts?.shape) return base;
  return base + emitRustShapeAddon(ir, validateShapeOrThrow(grammar, opts.shape), ids);
}
