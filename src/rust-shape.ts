// The Rust spelling of a shape-building parser (emitParser(g, rustTarget, { shape })): the shape's
// construct plans (src/shape-plan.ts, printed through algo-ir) run where the portable engine
// accepts an arm, over a builder (`Ast`) whose handle is a SLOT (`Slot`: the value word, the
// grammar tag, the engine arm, the span and head span, the synthesized attributes), and build the
// shape's AST as TYPED data (src/shape-types.ts): one struct per node kind kept in one arena (a
// `Vec`) per kind, `Id<Kind>(u32)` handles, one Copy enum per union of kinds (a rule that may miss:
// a `Missing` variant), lists as (start, len) into one slab, strings as a source span or an index.
// Nothing is dropped node by node; a losing candidate's nodes stay in their arenas, unreferenced
// (the slab and the owned strings are cut back on restore).
//
// Inside the plans every value is ONE WORD (`W`, a NaN-boxed u64): a number is its f64 bits; a node,
// list, string, bool, null, absent or missing value a tagged quiet NaN. The plans are untyped (the
// IR's `val_any`); a node's constructor (`mkN`) converts each field word to the field's derived
// type (FromW), so the AST a caller reads is typed.
//
// Refused at emit time (the typed target builds them not yet, or never): VARIANTS (a Pratt arm
// built under both values of an attribute), a reader-applied top, re-parse on demand, inherited
// context attributes and threads; a cooking function without a Rust definition.
import type { Cx, Fn, R, ShapeLowering } from './algo-ir.ts';
import type { ShapePlan } from './shape-plan.ts';
import type { Shape } from './shape2-eval.ts';
import { recordKey, shapeTypes, type FieldType, type KindDecl, type ShapeTypes, type TypeRef } from './shape-types.ts';

export type RsShape = {
  plan: ShapePlan; types: ShapeTypes; entry: string;
  consts: string[]; constIdx: Map<string, number>;
  kindIdx: Map<string, number>;
};
const J = JSON.stringify;
/** A Rust string literal. */
const rsStr = (s: string): string => J(s).replace(/\\u([0-9a-fA-F]{4})/g, '\\u{$1}');

const RS_KEYWORDS = new Set(['as', 'break', 'const', 'continue', 'crate', 'else', 'enum', 'extern', 'false', 'fn', 'for', 'if', 'impl', 'in', 'let', 'loop', 'match', 'mod', 'move', 'mut', 'pub', 'ref', 'return', 'self', 'static', 'struct', 'super', 'trait', 'true', 'type', 'unsafe', 'use', 'where', 'while', 'async', 'await', 'dyn', 'abstract', 'become', 'box', 'do', 'final', 'macro', 'override', 'priv', 'typeof', 'unsized', 'virtual', 'yield', 'try']);
const RESERVED_TYPES = new Set(['W', 'Id', 'List', 'Str', 'Ast', 'Slot', 'Option', 'Some', 'None', 'Vec', 'String', 'Box', 'Self', 'FromW', 'ToW', 'Json', 'Result', 'Ok', 'Err', 'Builder', 'Parser', 'Tok', 'Token', 'Node', 'Mark', 'Spanned', 'Workspace', 'EntryMeta', 'LexError', 'Doc', 'CstBuilder', 'SlimBuilder']);
/** A type name in Rust (a kind, union, enum or record). */
export const rsTy = (n: string): string => { const s = n.replace(/[^A-Za-z0-9_]/g, '_'); return RESERVED_TYPES.has(s) || /^[0-9]/.test(s) ? `${s}_` : s; };
/** A field name in Rust. */
export const rsField = (n: string): string => { const s = n.replace(/[A-Z]/g, (m) => '_' + m.toLowerCase()).replace(/[^A-Za-z0-9_]/g, '_'); return RS_KEYWORDS.has(s) ? `r#${s}` : s; };

/** The Rust definitions of the cooking functions (src/shape-cook.ts is the reference): `&str` -> W. */
const RS_COOKS: Record<string, string> = {
  numberValue: `fn cook_number_value(&mut self, s: &str) -> W {
        let t: String = s.chars().filter(|&c| c != '_').collect();
        let radix = |d: &str, r: u32| -> f64 { d.chars().fold(0f64, |a, c| a * r as f64 + c.to_digit(r).unwrap_or(0) as f64) };
        let b = t.as_bytes();
        let x = if b.len() > 1 && b[0] == b'0' && (b[1] | 0x20) == b'x' { radix(&t[2..], 16) }
            else if b.len() > 1 && b[0] == b'0' && (b[1] | 0x20) == b'o' { radix(&t[2..], 8) }
            else if b.len() > 1 && b[0] == b'0' && (b[1] | 0x20) == b'b' { radix(&t[2..], 2) }
            else if b.len() > 1 && b[0] == b'0' && b[1..].iter().all(|c| (b'0'..=b'7').contains(c)) { radix(&t[1..], 8) }
            else { t.parse::<f64>().unwrap_or(f64::NAN) };
        w_num(x)
    }`,
  tsNumericText: `fn cook_ts_numeric_text(&mut self, s: &str) -> W { let x = f64::from_bits(self.cook_number_value(s)); let t = js_num_str(x); self.w_own(t) }`,
  tsNumericLiteralFlags: `fn cook_ts_numeric_literal_flags(&mut self, s: &str) -> W {
        let b = s.as_bytes();
        let mut f = 0u32;
        let pre = |c: u8| b.len() > 1 && b[0] == b'0' && (b[1] | 0x20) == c;
        if pre(b'x') { f |= 64; } else if pre(b'b') { f |= 128; } else if pre(b'o') { f |= 256; }
        else if b.len() > 1 && b[0] == b'0' && b[1..].iter().all(|c| (b'0'..=b'7').contains(c)) { f |= 32; }
        else { if b.len() > 1 && b[0] == b'0' && b[1].is_ascii_digit() { f |= 8192; } if b.iter().any(|&c| c == b'e' || c == b'E') { f |= 16; } }
        if b.contains(&b'_') { f |= 512; }
        if f == 0 { W_ABSENT } else { w_num(f as f64) }
    }`,
  tsBigIntText: `fn cook_ts_big_int_text(&mut self, s: &str) -> W { if s.contains('_') { let t = s.replace('_', ""); self.w_own(t) } else { self.w_text(s) } }`,
  identifierName: `fn cook_identifier_name(&mut self, s: &str) -> W {
        if !s.contains('\\\\') { return self.w_text(s); }
        let mut out = String::new(); let mut units: Vec<u16> = Vec::new();
        let b = s.as_bytes(); let mut i = 0;
        while i < b.len() {
            if b[i] == b'\\\\' && b.get(i + 1) == Some(&b'u') {
                let (cp, n) = if b.get(i + 2) == Some(&b'{') { let close = s[i..].find('}').unwrap() + i; (u32::from_str_radix(&s[i + 3..close], 16).unwrap_or(0xFFFD), close + 1 - i) } else { (u32::from_str_radix(&s[i + 2..i + 6], 16).unwrap_or(0xFFFD), 6) };
                push_unit(&mut out, &mut units, cp); i += n;
            } else { flush_units(&mut out, &mut units); let c = s[i..].chars().next().unwrap(); out.push(c); i += c.len_utf8(); }
        }
        flush_units(&mut out, &mut units);
        self.w_own(out)
    }`,
  stringValue: `fn cook_string_value(&mut self, s: &str) -> W {
        let body = &s[1..s.len() - 1];
        if !body.contains('\\\\') { return self.w_text(body); }
        let mut out = String::new(); let mut units: Vec<u16> = Vec::new();
        let b = body.as_bytes(); let mut i = 0;
        while i < b.len() {
            if b[i] != b'\\\\' { flush_units(&mut out, &mut units); let c = body[i..].chars().next().unwrap(); out.push(c); i += c.len_utf8(); continue; }
            i += 1;
            let c = body[i..].chars().next().unwrap();
            match c {
                'n' => { flush_units(&mut out, &mut units); out.push('\\n'); i += 1; }
                't' => { flush_units(&mut out, &mut units); out.push('\\t'); i += 1; }
                'r' => { flush_units(&mut out, &mut units); out.push('\\r'); i += 1; }
                'b' => { flush_units(&mut out, &mut units); out.push('\\u{8}'); i += 1; }
                'f' => { flush_units(&mut out, &mut units); out.push('\\u{c}'); i += 1; }
                'v' => { flush_units(&mut out, &mut units); out.push('\\u{b}'); i += 1; }
                '\\r' => { i += 1; if b.get(i) == Some(&b'\\n') { i += 1; } }
                '\\n' | '\\u{2028}' | '\\u{2029}' => { i += c.len_utf8(); }
                'x' => { let v = u32::from_str_radix(&body[i + 1..i + 3], 16).unwrap_or(0xFFFD); push_unit(&mut out, &mut units, v); i += 3; }
                'u' => {
                    if b.get(i + 1) == Some(&b'{') { let close = body[i..].find('}').unwrap() + i; let v = u32::from_str_radix(&body[i + 2..close], 16).unwrap_or(0xFFFD); push_unit(&mut out, &mut units, v); i = close + 1; }
                    else { let v = u32::from_str_radix(&body[i + 1..i + 5], 16).unwrap_or(0xFFFD); push_unit(&mut out, &mut units, v); i += 5; }
                }
                '0'..='7' => {
                    let max = if c <= '3' { 3 } else { 2 };
                    let mut n = 0; let mut v = 0u32;
                    while n < max && i + n < b.len() && (b'0'..=b'7').contains(&b[i + n]) { v = v * 8 + (b[i + n] - b'0') as u32; n += 1; }
                    push_unit(&mut out, &mut units, v); i += n;
                }
                c => { flush_units(&mut out, &mut units); out.push(c); i += c.len_utf8(); }
            }
        }
        flush_units(&mut out, &mut units);
        self.w_own(out)
    }`,
  hasExtendedUnicodeEscape: `fn cook_has_extended_unicode_escape(&mut self, s: &str) -> W {
        let body = if s.starts_with('"') || s.starts_with('\\'') { &s[1..s.len() - 1] } else { let e = if s.ends_with("\${") { 2 } else { 1 }; &s[1..s.len() - e] };
        let b = body.as_bytes(); let mut i = 0;
        while i < b.len() {
            if b[i] == b'\\\\' {
                if b.get(i + 1) == Some(&b'u') && b.get(i + 2) == Some(&b'{') {
                    if let Some(close) = body[i..].find('}') { let h = &body[i + 3..i + close]; if !h.is_empty() && h.bytes().all(|c| c.is_ascii_hexdigit()) && u32::from_str_radix(h, 16).map_or(false, |v| v <= 0x10FFFF) { return W_TRUE; } }
                }
                i += 2;
            } else { i += 1; }
        }
        W_FALSE
    }`,
};
/** UTF-16 code units (a JavaScript string's escapes) into UTF-8: a pair is one character, a lone
 * surrogate U+FFFD (a Rust string holds none). */
const RS_UNITS = `fn push_unit(out: &mut String, units: &mut Vec<u16>, cp: u32) {
    if cp > 0xFFFF { flush_units(out, units); out.push(char::from_u32(cp).unwrap_or('\\u{FFFD}')); } else { units.push(cp as u16); }
}
fn flush_units(out: &mut String, units: &mut Vec<u16>) {
    if units.is_empty() { return; }
    for c in char::decode_utf16(units.iter().copied()) { out.push(c.unwrap_or('\\u{FFFD}')); }
    units.clear();
}
/// A number as JavaScript's Number.prototype.toString writes it (ECMA-262 Number::toString).
fn js_num_str(x: f64) -> String {
    if x.is_nan() { return "NaN".into(); }
    if x == 0.0 { return "0".into(); }
    if x.is_infinite() { return if x > 0.0 { "Infinity".into() } else { "-Infinity".into() }; }
    let neg = x < 0.0;
    let e = format!("{:e}", x.abs());
    let (m, ex) = e.split_once('e').unwrap();
    let digits: String = m.chars().filter(|c| *c != '.').collect();
    let k = digits.len() as i32;
    let n = ex.parse::<i32>().unwrap() + 1;
    let s = if k <= n && n <= 21 { format!("{}{}", digits, "0".repeat((n - k) as usize)) }
        else if 0 < n && n <= 21 { format!("{}.{}", &digits[..n as usize], &digits[n as usize..]) }
        else if -6 < n && n <= 0 { format!("0.{}{}", "0".repeat((-n) as usize), digits) }
        else { let t = if k == 1 { digits.clone() } else { format!("{}.{}", &digits[..1], &digits[1..]) }; format!("{}e{}{}", t, if n - 1 >= 0 { "+" } else { "-" }, (n - 1).abs()) };
    if neg { format!("-{}", s) } else { s }
}`;

/** Begin printing `plan` (built from `shape`) as a typed Rust parser: what it refuses, its types. */
export function beginRsShape(plan: ShapePlan, shape: Shape, entry: string): RsShape {
  const refused: string[] = [];
  const armName = (id: number): string => `${plan.arms[id]!.rule}.${plan.arms[id]!.arm}`;
  plan.variantBit.forEach((b, id) => { if (b >= 0) refused.push(`${armName(id)}: built under both values of an inherited attribute (variants); the typed target refuses variants`); });
  plan.tops.forEach((t, id) => { if (t !== null) refused.push(`${armName(id)}: a reader-applied top layer`); });
  for (const r of plan.restarts) refused.push(`${r.rule}: re-parse on demand (attribute ${r.k})`);
  if (plan.inh.length) refused.push(`inherited context attributes (${plan.inh.map((a) => a.name).join(', ')})`);
  const missingCooks = plan.cooks.filter((c) => !(c in RS_COOKS));
  if (missingCooks.length) refused.push(`cooking functions with no Rust definition yet: ${missingCooks.join(', ')}`);
  if (refused.length) throw new Error(`rustTarget: this shape-building parser is not printed yet (the typed target):\n  ${refused.join('\n  ')}`);
  const missing = new Set<string>();
  for (const [id] of plan.unsupported) missing.add(armName(id));
  const types = shapeTypes(shape, missing);
  const kindIdx = new Map<string, number>();
  types.kinds.forEach((k, i) => kindIdx.set(k.record ? k.key : k.name, i));
  const st: RsShape = { plan, types, entry, consts: [], constIdx: new Map(), kindIdx };
  for (const a of plan.arms) intern(st, a.arm);
  for (const e of types.enums) for (const v of e.values) intern(st, v);
  return st;
}
function intern(st: RsShape, s: string): number {
  let i = st.constIdx.get(s);
  if (i === undefined) { i = st.consts.length; st.consts.push(s); st.constIdx.set(s, i); }
  return i;
}

let CUR: RsShape | null = null;
export function setRsShape(st: RsShape | null): void { CUR = st; }
const cur = (): RsShape => { if (!CUR) throw new Error('rust shape lowering outside a shape emission'); return CUR; };
const kindOf = (name: string): KindDecl => cur().types.kinds[cur().kindIdx.get(name)!]!;
const constW = (s: string): string => `(T_STRI | ${intern(cur(), s)})`;
const f64Lit = (x: number): string => (Number.isInteger(x) ? `${x}.0` : String(x)).replace(/^-(.*)$/, '(-$1)');

/** The ShapeLowering of the Rust target (see the header). */
export const rsShapeLowering: ShapeLowering = {
  vConst: (cx, v) => cx.atom(v === null ? 'W_NULL' : typeof v === 'string' ? constW(v) : typeof v === 'number' ? `w_num(${f64Lit(v)})` : v ? 'W_TRUE' : 'W_FALSE', 'val_any', 'val_any'),
  vAbsent: (cx) => cx.atom('W_ABSENT', 'val_any', 'val_any'),
  vText: (cx, s) => cx.atom(`self.w_text(${s.c})`, 'val_any', 'val_any'),
  mkNode: (cx, kind, fields, start, end, kinds) => {
    if (kinds.length === 0) throw new Error('rust shape: a node of no constant kind');
    const given = new Map(fields.map(([n, r]) => [n, r.c]));
    const mk = (k: string): string => `self.mk${cur().kindIdx.get(k)}(${[cx.coerce(start, 'u32'), cx.coerce(end, 'u32'), ...kindOf(k).fields.map((f) => given.get(f.name) ?? 'W_ABSENT')].join(', ')})`;
    if (kinds.length === 1) return cx.atom(mk(kinds[0]!), 'val_any', 'val_any');
    return cx.atom(`{ let k: W = ${kind.c}; ${kinds.map((k) => `if k == ${constW(k)} { ${mk(k)} }`).join(' else ')} else { unreachable!() } }`, 'val_any', 'val_any');
  },
  mkRecord: (cx, fields) => {
    const key = recordKey(fields.map(([n]) => n));
    const i = cur().kindIdx.get(key);
    if (i === undefined) throw new Error(`rust shape: no record type ${key}`);
    const given = new Map(fields.map(([n, r]) => [n, r.c]));
    return cx.atom(`self.mk${i}(${cur().types.kinds[i]!.fields.map((f) => given.get(f.name) ?? 'W_ABSENT').join(', ')})`, 'val_any', 'val_any');
  },
  vList: (cx, l) => cx.atom(`self.w_list(&${l.c})`, 'val_any', 'val_any'),
  vItems: (cx, e) => cx.atom(`self.w_items(${e.c})`, 'vals_any', 'vals_any', { owned: false }),
  vIs: (_cx, e, v) => (v === null ? { c: `${e.c} == W_NULL`, prec: 3 } : typeof v === 'string' ? { c: `self.w_is_str(${e.c}, ${J(v)})`, prec: 100 } : typeof v === 'number' ? { c: `${e.c} == w_num(${f64Lit(v)})`, prec: 3 } : { c: `${e.c} == ${v ? 'W_TRUE' : 'W_FALSE'}`, prec: 3 }),
  vPresent: (_cx, e) => ({ c: `${e.c} != W_ABSENT`, prec: 3 }),
  vNeed: (cx, e) => cx.atom(`need!(${e.c})`, 'val_any', 'val_any'),
  vMissing: (cx, where, why) => cx.atom(`(T_MISS | ${intern(cur(), `${why} arm ${where}`)})`, 'val_any', 'val_any'),
  switch: (_cx, on, cases, dflt) => [
    `match self.w_case(${on.c}, &[${cases.map((c) => J(c.v)).join(', ')}]) {`,
    ...cases.flatMap((c, i) => [`    ${i} => {`, ...c.body.map((l) => `        ${l}`), '    }']),
    '    _ => {', ...dflt.map((l) => `        ${l}`), '    }', '}',
  ],
};

/** Calls the Rust lowering prints as methods of the builder (`self.`): the cooking functions. */
export const rsShapeCall = (name: string): boolean => name.startsWith('cook_') || ['val_start', 'val_end', 'v_drop_last', 'rec_get'].includes(name);

// ── The typed declarations ──
function rsType(t: TypeRef): string {
  switch (t.k) {
    case 'union': return rsTy(t.name);
    case 'str': return 'Str';
    case 'strEnum': return rsTy(t.name);
    case 'num': return 'f64';
    case 'bool': return 'bool';
    case 'list': return `List<${t.elemNull ? `Option<${rsType(t.of)}>` : rsType(t.of)}>`;
    case 'record': return `Id<${rsTy(t.name)}>`;
    case 'none': return '()';
  }
}
const rsField_ = (f: FieldType): string => (f.opt ? `Option<${rsType(f.ty)}>` : rsType(f.ty));

function typedDecls(st: RsShape): string {
  const T = st.types;
  const K = st.plan.nodeKeys;
  const out: string[] = [];
  T.kinds.forEach((k, i) => {
    const name = rsTy(k.name);
    out.push(`/// ${k.record ? 'Record' : 'Node kind'} ${J(k.record ? k.key : k.name)}.\n#[derive(Clone, Copy)]\npub struct ${name} {${k.record ? '' : ' pub start: u32, pub end: u32,'}${k.fields.map((f) => ` pub ${rsField(f.name)}: ${rsField_(f.type)},`).join('')} }`);
    out.push(`impl Json for Id<${name}> { fn json(&self, a: &Ast, out: &mut String) { a.json${i}(self.0, out) } }`);
    out.push(`impl FromW for Id<${name}> { #[inline(always)] fn from_w(_a: &Ast, w: W) -> Self { Id(w as u32, PhantomData) } }`);
    out.push(`impl ToW for Id<${name}> { #[inline(always)] fn to_w(&self) -> W { w_node(${i}, self.0 as usize) } }`);
  });
  for (const u of T.unions) {
    const name = rsTy(u.name);
    const vs = u.kinds.map((k) => ({ v: rsTy(k), ty: rsTy(k), i: st.kindIdx.get(k)! }));
    out.push(`/// One of ${u.kinds.join(' | ')}${u.missing ? ', or Missing (an arm the shape or this parser builds no value for)' : ''}.\n#[derive(Clone, Copy)]\npub enum ${name} { ${vs.map((x) => `${x.v}(Id<${x.ty}>)`).join(', ')}${u.missing ? ', Missing' : ''} }`);
    out.push(`impl FromW for ${name} { fn from_w(_a: &Ast, w: W) -> Self { ${u.missing ? `if w & TAGM == T_MISS { return ${name}::Missing; } ` : ''}match (w >> 32) as u32 & 0xFFFF { ${vs.map((x) => `${x.i} => ${name}::${x.v}(Id(w as u32, PhantomData))`).join(', ')}, _ => panic!("shape: not a ${name}") } } }`);
    out.push(`impl ToW for ${name} { fn to_w(&self) -> W { match self { ${vs.map((x) => `${name}::${x.v}(id) => w_node(${x.i}, id.0 as usize)`).join(', ')}${u.missing ? `, ${name}::Missing => T_MISS` : ''} } } }`);
    out.push(`impl Json for ${name} { fn json(&self, a: &Ast, out: &mut String) { match self { ${vs.map((x) => `${name}::${x.v}(id) => id.json(a, out)`).join(', ')}${u.missing ? `, ${name}::Missing => out.push_str("null")` : ''} } } }`);
  }
  for (const e of T.enums) {
    const name = rsTy(e.name);
    out.push(`/// A closed string: ${e.values.map((v) => J(v)).join(' | ')}.\n#[derive(Clone, Copy, PartialEq, Eq)]\npub enum ${name} { ${e.values.map((_, i) => `V${i}`).join(', ')} }`);
    out.push(`impl ${name} { pub fn as_str(&self) -> &'static str { match self { ${e.values.map((v, i) => `${name}::V${i} => ${J(v)}`).join(', ')} } } }`);
    out.push(`impl FromW for ${name} { fn from_w(a: &Ast, w: W) -> Self { match a.w_str(w) { ${e.values.map((v, i) => `${J(v)} => ${name}::V${i}`).join(', ')}, _ => panic!("shape: not a ${name}") } } }`);
    out.push(`impl ToW for ${name} { fn to_w(&self) -> W { match self { ${e.values.map((v, i) => `${name}::V${i} => T_STRI | ${intern(st, v)}`).join(', ')} } } }`);
    out.push(`impl Json for ${name} { fn json(&self, _a: &Ast, out: &mut String) { json_str(self.as_str(), out) } }`);
  }
  // Constructors and JSON writers, per kind.
  const impls: string[] = [];
  T.kinds.forEach((k, i) => {
    const name = rsTy(k.name);
    const ps = k.fields.map((f, j) => `f${j}: W`);
    const conv = k.fields.map((f, j) => `${rsField(f.name)}: <${rsField_(f.type)}>::from_w(self, f${j})`);
    impls.push(`    #[inline(never)]\n    fn mk${i}(&mut self${k.record ? '' : ', start: u32, end: u32'}${ps.map((p) => `, ${p}`).join('')}) -> W { let n = ${name} {${k.record ? '' : ' start, end,'} ${conv.join(', ')} }; self.a${i}.push(n); w_node(${i}, self.a${i}.len() - 1) }`);
    const body: string[] = [];
    if (k.record) body.push(`out.push_str(${rsStr('{"record":{')}); let mut first = true;`);
    else body.push(`out.push_str(${rsStr(`{${J(K.kind)}:${J(k.name)},${J(K.start)}:`)}); json_u32(n.start, out); out.push_str(${rsStr(`,${J(K.end)}:`)}); json_u32(n.end, out); let first = false;`);
    k.fields.forEach((f) => {
      const sep = `if !first { out.push(','); } out.push_str(${rsStr(`${J(f.name)}:`)});`;
      if (f.type.opt === 'absent') body.push(`if let Some(v) = &n.${rsField(f.name)} { ${sep} v.json(self, out); ${k.record ? 'first = false; ' : ''}}`);
      else body.push(`{ ${sep} n.${rsField(f.name)}.json(self, out); ${k.record ? 'first = false; ' : ''}}`);
    });
    body.push(k.record ? `let _ = first; out.push_str("}}");` : `let _ = first; out.push('}');`);
    impls.push(`    fn json${i}(&self, id: u32, out: &mut String) { let n = &self.a${i}[id as usize]; ${body.join(' ')} }`);
  });
  return `${out.join('\n')}\nimpl<'s> Ast<'s> {\n${impls.join('\n')}\n}`;
}

/** The runtime: value words, the typed support, the builder and the plans' engine methods.
 * `fns`: the construct plans printed by algo-ir (methods of Ast). */
export function rsShapeRuntime(st: RsShape, fns: string): string {
  const plan = st.plan, T = st.types;
  const nsyn = plan.syn.length;
  const tplMiss = intern(st, 'unsupported node (an interpolated template)');
  const synDefault = plan.syn.map((a) => (a.dflt === undefined || a.dflt === null ? 'W_NULL' : typeof a.dflt === 'string' ? `(T_STRI | ${intern(st, a.dflt)})` : typeof a.dflt === 'number' ? `w_num(${f64Lit(a.dflt)})` : a.dflt ? 'W_TRUE' : 'W_FALSE'));
  const synArms = plan.arms.filter((x) => plan.syn.some((a) => a.fns[x.id] !== null));
  const root = T.rules.get(st.entry);
  if (!root) throw new Error(`rust shape: the entry rule ${st.entry} is not mapped`);
  const rootTy = rsField_(root);
  // Record fields, for get (recGet).
  const recFields = T.kinds.map((k, i) => ({ k, i })).filter((x) => x.k.record).flatMap(({ k, i }) => k.fields.map((f) => `(${i}, ${J(f.name)}) => self.a${i}[id].${rsField(f.name)}.to_w()`));
  const decls = typedDecls(st);   // interns enum constants: before the const table is printed
  const armNames = plan.arms.map((a) => intern(st, a.arm));
  const body = `
// ─── Shape AST (typed; rust-shape.ts) ───
use std::marker::PhantomData;
/// A value word inside the construct plans: an f64's bits, or a tagged quiet NaN.
pub type W = u64;
const TAGM: u64 = 0xFFFF_0000_0000_0000;
const T_NODE: u64 = 0xFFF9_0000_0000_0000;
const T_LIST: u64 = 0xFFFA_0000_0000_0000;
const T_SPAN: u64 = 0xFFFB_0000_0000_0000;
const T_STRI: u64 = 0xFFFC_0000_0000_0000;
const T_BOOL: u64 = 0xFFFD_0000_0000_0000;
const W_ABSENT: W = 0xFFFE_0000_0000_0000;
const T_MISS: u64 = 0xFFFF_0000_0000_0000;
const W_FALSE: W = T_BOOL; const W_TRUE: W = T_BOOL | 1; const W_NULL: W = T_BOOL | 2;
#[inline(always)] fn w_num(x: f64) -> W { if x.is_nan() { f64::NAN.to_bits() } else { x.to_bits() } }
#[inline(always)] fn w_node(k: u32, id: usize) -> W { T_NODE | (k as u64) << 32 | id as u64 }
/// A missing value propagates: the plan reading it returns it (its arm's value is missing too).
macro_rules! need { ($e:expr) => {{ let x: W = $e; if x & TAGM == T_MISS { return x; } x }} }
/// The constant strings: arm names, kinds' and closed enums' values, the plans' constants, messages.
static SH_CONST: &[&str] = &[${st.consts.map((s) => rsStr(s)).join(', ')}];
const SH_NCONST: usize = ${st.consts.length};
const SH_ARM_NAME: [u32; ${armNames.length}] = [${armNames.join(', ')}];
const SH_SYN0: [W; ${nsyn}] = [${synDefault.join(', ')}];

/// A handle to a node (or record) of kind T in its arena.
pub struct Id<T>(pub u32, PhantomData<T>);
impl<T> Clone for Id<T> { fn clone(&self) -> Self { *self } }
impl<T> Copy for Id<T> {}
/// A list: (start, len) in the slab, each element a value word read as T.
pub struct List<T> { pub start: u32, pub len: u32, _p: PhantomData<T> }
impl<T> Clone for List<T> { fn clone(&self) -> Self { *self } }
impl<T> Copy for List<T> {}
/// A string: a span of the source, or an index (a constant or a cooked string): Ast::text.
#[derive(Clone, Copy)]
pub struct Str(pub W);
/// A text of the source (what the plans' srcText reads): borrowed from it, not from the builder.
#[derive(Clone, Copy)]
pub struct SrcStr<'s>(&'s str);
impl<'s> SrcStr<'s> { #[inline(always)] fn as_str(&self) -> &'s str { self.0 } }
impl<'s> AsRef<str> for SrcStr<'s> { fn as_ref(&self) -> &str { self.0 } }
pub trait FromW { fn from_w(a: &Ast, w: W) -> Self; }
pub trait ToW { fn to_w(&self) -> W; }
pub trait Json { fn json(&self, a: &Ast, out: &mut String); }
impl FromW for f64 { #[inline(always)] fn from_w(_a: &Ast, w: W) -> Self { f64::from_bits(w) } }
impl FromW for bool { #[inline(always)] fn from_w(_a: &Ast, w: W) -> Self { w == W_TRUE } }
impl FromW for Str { #[inline(always)] fn from_w(_a: &Ast, w: W) -> Self { Str(w) } }
impl FromW for () { #[inline(always)] fn from_w(_a: &Ast, _w: W) -> Self {} }
impl<T: FromW> FromW for Option<T> { #[inline(always)] fn from_w(a: &Ast, w: W) -> Self { if w == W_ABSENT || w == W_NULL { None } else { Some(T::from_w(a, w)) } } }
impl<T> FromW for List<T> { #[inline(always)] fn from_w(_a: &Ast, w: W) -> Self { List { start: (w >> 24) as u32 & 0xFF_FFFF, len: w as u32 & 0xFF_FFFF, _p: PhantomData } } }
impl ToW for f64 { fn to_w(&self) -> W { w_num(*self) } }
impl ToW for bool { fn to_w(&self) -> W { if *self { W_TRUE } else { W_FALSE } } }
impl ToW for Str { fn to_w(&self) -> W { self.0 } }
impl ToW for () { fn to_w(&self) -> W { W_ABSENT } }
impl<T: ToW> ToW for Option<T> { fn to_w(&self) -> W { match self { Some(x) => x.to_w(), None => W_ABSENT } } }
impl<T> ToW for List<T> { fn to_w(&self) -> W { T_LIST | (self.start as u64) << 24 | self.len as u64 } }
impl Json for f64 { fn json(&self, _a: &Ast, out: &mut String) { if self.is_finite() { use std::fmt::Write; let _ = write!(out, "{}", self); } else { out.push_str("null"); } } }
impl Json for bool { fn json(&self, _a: &Ast, out: &mut String) { out.push_str(if *self { "true" } else { "false" }); } }
impl Json for Str { fn json(&self, a: &Ast, out: &mut String) { json_str(a.text(*self), out) } }
impl Json for () { fn json(&self, _a: &Ast, out: &mut String) { out.push_str("null") } }
impl<T: Json> Json for Option<T> { fn json(&self, a: &Ast, out: &mut String) { match self { Some(x) => x.json(a, out), None => out.push_str("null") } } }
impl<T: FromW + Json> Json for List<T> {
    fn json(&self, a: &Ast, out: &mut String) {
        out.push('[');
        for (i, x) in a.items(*self).enumerate() { if i > 0 { out.push(','); } x.json(a, out); }
        out.push(']');
    }
}
${RS_UNITS}
fn json_u32(x: u32, out: &mut String) { use std::fmt::Write; let _ = write!(out, "{}", x); }
fn json_str(value: &str, out: &mut String) {
    use std::fmt::Write;
    out.push('"');
    for c in value.chars() {
        match c {
            '"' => out.push_str("\\\\\\""), '\\\\' => out.push_str("\\\\\\\\"), '\\n' => out.push_str("\\\\n"), '\\r' => out.push_str("\\\\r"), '\\t' => out.push_str("\\\\t"),
            '\\u{8}' => out.push_str("\\\\b"), '\\u{c}' => out.push_str("\\\\f"),
            c if (c as u32) < 0x20 => { let _ = write!(out, "\\\\u{:04x}", c as u32); }
            c => out.push(c),
        }
    }
    out.push('"');
}
${decls}

/// One child-stack slot: its value word, grammar tag (-1: none), engine arm (-1: a leaf or marker),
/// span, head span and synthesized attributes.
#[derive(Clone, Copy)]
pub struct Slot { w: W, tag: i32, arm: i32, off: u32, end: u32, ho: u32, he: u32, sy: [W; ${nsyn}] }
impl Default for Slot { fn default() -> Self { Slot { w: W_ABSENT, tag: -1, arm: -1, off: 0, end: 0, ho: 0, he: 0, sy: SH_SYN0 } } }

/// The shape's AST (and, while parsing, its builder): one arena per kind, the list slab, the cooked
/// strings; \`root\` the entry rule's value.
#[derive(Default)]
pub struct Ast<'s> {
    pub src: &'s str,
    root: W,
    sc: Vec<Slot>,
    slab: Vec<W>,
    owned: Vec<String>,
    ys: [W; ${nsyn}],
    ws: Workspace<Slot>,
${T.kinds.map((k, i) => `    pub a${i}: Vec<${rsTy(k.name)}>,`).join('\n')}
}
impl<'s> Ast<'s> {
    /// The entry rule's value.
    pub fn root(&self) -> ${rootTy} { <${rootTy}>::from_w(self, self.root) }
    /// The AST as JSON, as the evaluator's value (src/shape2-eval.ts) serializes.
    pub fn to_json(&self) -> String { let mut out = String::new(); self.root().json(self, &mut out); out }
    /// A string's text.
    pub fn text(&self, s: Str) -> &str { self.w_str(s.0) }
    /// A list's elements.
    pub fn items<T: FromW>(&self, l: List<T>) -> impl Iterator<Item = T> + '_ { self.slab[l.start as usize..(l.start + l.len) as usize].iter().map(move |&w| T::from_w(self, w)) }
    fn w_str(&self, w: W) -> &str {
        match w & TAGM {
            T_SPAN => { let o = (w >> 16) as u32 as usize; &self.src[o..o + (w & 0xFFFF) as usize] }
            T_STRI => { let i = w as u32 as usize; if i < SH_NCONST { SH_CONST[i] } else { &self.owned[i - SH_NCONST] } }
            _ => "\\u{0}",
        }
    }
    fn w_own(&mut self, s: String) -> W { self.owned.push(s); T_STRI | (SH_NCONST + self.owned.len() - 1) as u64 }
    /// The word of a string of the source (a span when it fits, else a copy).
    fn w_text<S: AsRef<str>>(&mut self, s: S) -> W {
        let s = s.as_ref();
        let o = s.as_ptr() as usize - self.src.as_ptr() as usize;
        if o <= self.src.len() && s.len() < 0x1_0000 && o < 0x1_0000_0000 { T_SPAN | (o as u64) << 16 | s.len() as u64 } else { self.w_own(s.to_string()) }
    }
    fn w_is_str(&self, w: W, s: &str) -> bool { (w & TAGM == T_SPAN || w & TAGM == T_STRI) && self.w_str(w) == s }
    fn w_case(&self, w: W, cases: &[&str]) -> usize { let s = self.w_str(w); cases.iter().position(|c| *c == s).unwrap_or(usize::MAX) }
    fn w_list(&mut self, l: &[W]) -> W {
        let s = self.slab.len();
        assert!(s + l.len() < 0x100_0000 && l.len() < 0x100_0000, "shape: the list slab exceeds 2^24 words");
        self.slab.extend_from_slice(l);
        T_LIST | (s as u64) << 24 | l.len() as u64
    }
    fn w_items(&self, w: W) -> std::iter::Copied<std::slice::Iter<'_, W>> { let s = (w >> 24) as usize & 0xFF_FFFF; self.slab[s..s + (w as usize & 0xFF_FFFF)].iter().copied() }
    // The plans' engine methods (src/shape-plan.ts EXTERNS), over the slots of the arm being built.
    #[inline(always)] fn slot_tag(&self, i: usize) -> isize { self.sc[i].tag as isize }
    #[inline(always)] fn slot_off(&self, i: usize) -> u32 { self.sc[i].off }
    #[inline(always)] fn slot_end(&self, i: usize) -> u32 { self.sc[i].end }
    #[inline(always)] fn slot_val(&self, i: usize) -> W { self.sc[i].w }
    #[inline(always)] fn slot_arm_name(&self, i: usize) -> W { T_STRI | SH_ARM_NAME[self.sc[i].arm as usize] as u64 }
    #[inline(always)] fn slot_top(&self) -> usize { self.sc.len() }
    fn slot_find(&self, lo: usize, hi: usize, t0: isize, t1: isize) -> isize { for i in lo..hi { let t = self.sc[i].tag as isize; if t >= t0 && t <= t1 { return i as isize; } } -1 }
    fn slot_find_last(&self, lo: usize, hi: usize, t0: isize, t1: isize) -> isize { for i in (lo..hi).rev() { let t = self.sc[i].tag as isize; if t >= t0 && t <= t1 { return i as isize; } } -1 }
    #[inline(always)] fn slot_at(&self, i: usize, lo: usize, hi: usize, t0: isize, t1: isize) -> isize { if i < lo || i >= hi { return -1; } let t = self.sc[i].tag as isize; if t >= t0 && t <= t1 { i as isize } else { -1 } }
    fn named_end(&self, lo: usize, hi: usize) -> isize { for i in (lo..hi).rev() { let t = self.sc[i].tag; if t >= 0 && t & 1 == 0 { return self.sc[i].end as isize; } } -1 }
    #[inline(always)] fn src_text(&self, a: u32, b: u32) -> SrcStr<'s> { SrcStr(&self.src[a as usize..b as usize]) }
    fn w_span(&self, x: W) -> Option<(u32, u32)> {
        if x & TAGM != T_NODE { return None; }
        let id = x as u32 as usize;
        match (x >> 32) as u32 & 0xFFFF { ${T.kinds.map((k, i) => (k.record ? null : `${i} => Some((self.a${i}[id].start, self.a${i}[id].end))`)).filter((x) => x !== null).join(', ')}${T.kinds.some((k) => !k.record) ? ', ' : ''}_ => None }
    }
    fn val_start(&self, x: W, dflt: u32) -> isize {
        if let Some((s, _)) = self.w_span(x) { return s as isize; }
        if x & TAGM == T_LIST { let mut it = self.w_items(x); if let (Some(f), Some(l)) = (it.next(), self.w_items(x).last()) { if let (Some((s, _)), Some(_)) = (self.w_span(f), self.w_span(l)) { return s as isize; } } }
        dflt as isize
    }
    fn val_end(&self, x: W, dflt: u32) -> isize {
        if let Some((_, e)) = self.w_span(x) { return e as isize; }
        if x & TAGM == T_LIST { let mut it = self.w_items(x); if let (Some(f), Some(l)) = (it.next(), self.w_items(x).last()) { if let (Some(_), Some((_, e))) = (self.w_span(f), self.w_span(l)) { return e as isize; } } }
        dflt as isize
    }
    fn self_syn(&self, k: isize) -> W { self.ys[k as usize] }
    fn slot_syn(&self, k: isize, i: usize) -> W { self.sc[i].sy[k as usize] }
    #[allow(unused_variables)]
    fn rec_get(&self, x: W, f: &str) -> W { let id = x as u32 as usize; match ((x >> 32) as u32 & 0xFFFF, f) { ${recFields.join(', ')}${recFields.length ? ', ' : ''}_ => W_ABSENT } }
    fn v_drop_last(&self, x: W, c: bool) -> W { if c && x & 0xFF_FFFF != 0 { x - 1 } else { x } }
${[...new Set([...plan.cooks, ...(plan.cooks.includes('tsNumericText') ? ['numberValue'] : [])])].map((c) => `    ${RS_COOKS[c]}`).join('\n')}
    /// Engine arm id's value over slots b.. (its synthesized attributes first, into ys).
    fn construct(&mut self, id: usize, b: usize, off: u32, end: u32) -> W {
${nsyn ? `        self.ys = SH_SYN0;
        match id { ${synArms.map((x) => `${x.id} => { ${plan.syn.map((a, k) => (a.fns[x.id] ? `self.ys[${k}] = self.${a.fns[x.id]}(b, off, end); ` : '')).join('')}}`).join(' ')} _ => {} }
` : ''}        match id {
${plan.arms.map((a) => `            ${a.id} => self.construct${a.id}(b, off, end),`).join('\n')}
            _ => T_MISS | ${tplMiss},
        }
    }
${fns.split('\n').map((l) => (l ? `    ${l}` : l)).join('\n')}
}
impl<'s> Builder for Ast<'s> {
    type H = Slot;
    #[inline(always)]
    fn leaf(&mut self, scratch: &mut Vec<Slot>, _tt_id: u16, _tok_idx: u32, off: u32, end: u32) -> bool {
        scratch.push(Slot { w: W_ABSENT, tag: -1, arm: -1, off, end, ho: off, he: end, sy: SH_SYN0 });
        true
    }
    fn node(&mut self, scratch: &mut Vec<Slot>, sb: usize, rule_id: u16, off: u32, end: u32, _tok_start: u32, _tok_end: u32) {
        std::mem::swap(&mut self.sc, scratch);
        let (ho, he) = if self.sc.len() > sb { (self.sc[sb].ho, self.sc[sb].he) } else { (off, off) };
        let id = rule_id as usize;
        let w = self.construct(id, sb, off, end);
        self.sc.truncate(sb);
        self.sc.push(Slot { w, tag: -1, arm: id as i32, off, end, ho, he, sy: self.ys });
        std::mem::swap(&mut self.sc, scratch);
    }
    #[inline(always)] fn span_of(&self, h: Slot, _toks: &[Tok]) -> (u32, u32) { (h.off, h.end) }
    #[inline(always)] fn head_span(&self, h: Slot, _toks: &[Tok]) -> (u32, u32) { (h.ho, h.he) }
    #[inline(always)] fn checkpoint(&self) -> (usize, usize) { (self.slab.len(), self.owned.len()) }
    #[inline(always)] fn restore(&mut self, ck: (usize, usize)) { self.slab.truncate(ck.0); self.owned.truncate(ck.1); }
    fn dummy_h() -> Slot { Slot::default() }
    #[inline(always)] fn workspace_mut(&mut self) -> Option<&mut Workspace<Slot>> { Some(&mut self.ws) }
    fn tok_range(&self, _h: Slot) -> (u32, u32) { (0, 0) }
    #[inline(always)] fn tag(&mut self, scratch: &mut Vec<Slot>, t: i32) { let n = scratch.len(); scratch[n - 1].tag = t; }
    fn mark(&mut self, scratch: &mut Vec<Slot>, c: usize, mt: i32) {
        let mut m = if scratch.len() > c { scratch[c] } else { Slot { ho: 0, he: 0, ..Slot::default() } };
        m.w = W_ABSENT; m.tag = mt; m.arm = -1; m.end = m.off; m.sy = SH_SYN0;
        scratch.insert(c, m);
    }
}
/// The shape's AST of \`src\`: Err on a syntax error, or when the root's value is missing (an arm
/// the shape leaves out, or one this parser builds no value for, was read).
pub fn parse_shape(src: &str) -> Result<Ast<'_>, String> {
    let mut a = Ast::default();
    parse_shape_into(src, &mut a)?;
    Ok(a)
}
/** parse_shape into \`a\`, emptied first: its arenas, slab and buffers keep their capacity. */
pub fn parse_shape_into<'s>(src: &'s str, a: &mut Ast<'s>) -> Result<(), String> {
    a.src = src;
    a.ys = SH_SYN0;
    a.slab.clear(); a.owned.clear();${T.kinds.map((_, i) => ` a.a${i}.clear();`).join('')}
    match parse_with(src, a) {
        Some(h) => {
            if h.w & TAGM == T_MISS { return Err(format!("shape: {}", SH_CONST[h.w as u32 as usize])); }
            a.root = h.w;
            Ok(())
        }
        None => Err("syntax error".to_string()),
    }
}
impl<'s> Ast<'s> {
    /// The nodes and records built (a losing candidate's included).
    pub fn node_count(&self) -> usize { 0${T.kinds.map((_, i) => ` + self.a${i}.len()`).join('')} }
}
`;
  return body;
}

/** The construct plans as Ast methods: every plan function takes &mut self (a node is pushed). */
export function rsPlanFns(fns: Fn[]): Fn[] {
  return fns.map((f) => (f.extern ? f : { ...f, reads: false }));
}
export type { Cx, R };
