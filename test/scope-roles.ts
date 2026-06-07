// ─────────────────────────────────────────────────────────────────────────────
//  scope-roles.ts — the FROZEN, NEUTRAL answer-key spec for the highlight bench.
//
//  This file is the credibility root of the whole benchmark. It maps an abstract
//  syntactic ROLE (what tsc's parser says a token *is*) to the set of TextMate
//  scopes that count as a correct rendering of that role.
//
//  NEUTRALITY RULES (do not violate — they are what make the X%/Y% comparison fair):
//   1. Entries are written from the *public TextMate scope-naming convention*
//      (https://macromates.com/manual/en/language_grammars) and the role side,
//      NEVER from inspecting either grammar's output.
//   2. The SAME table grades both the official and the Monogram grammar. There is
//      no grammar-specific branch anywhere in this file.
//   3. Where two scopes are both defensible for a role (e.g. official uses
//      `variable.other.property`, Monogram uses `entity.other.property`), BOTH are
//      accepted. Convention differences are not correctness differences.
//   4. Genuinely contested roles (a called method = property OR function; a `new X`
//      callee = type OR value) are marked tier 'lenient' and accept the whole
//      family of defensible answers, so neither grammar is falsely penalised and
//      the cell does not become a fake differentiator.
//   5. Purely-semantic distinctions (is bare `Foo` a type or a value? is an import
//      a type or a value?) are NOT decidable from syntax and are graded leniently
//      or excluded — they belong to the optional semantic lens, not this one.
//
//  Tiers:
//   'strict'  — one defensible syntactic answer; counts toward the headline.
//   'lenient' — multiple defensible answers; counts toward the headline but only
//               fails on egregiously-wrong scopes (string/comment/number/keyword).
//   'lexical' — punctuation/operators; reported but EXCLUDED from the headline
//               (both grammars get them ~always right; they only compress the gap).
// ─────────────────────────────────────────────────────────────────────────────

export type Tier = 'strict' | 'lenient' | 'lexical';
export type Verdict = 'exact' | 'family' | 'wrong';

export interface RoleSpec {
  tier: Tier;
  desc: string;
  // A normalised innermost scope is an EXACT match if it startsWith any `exact`
  // prefix, a FAMILY match if it startsWith any `family` prefix, else WRONG.
  exact: string[];
  family: string[];
}

// Canonical role names. The oracle assigns these; the bench never invents others.
export const R = {
  funcDecl: 'function.decl',
  parameter: 'parameter',
  propDecl: 'property.decl',
  propAccess: 'property.access',
  typeDecl: 'type.decl',
  typeRef: 'type.ref',
  typeBuiltin: 'type.builtin',
  typeParam: 'type.param',
  enumMember: 'enum.member',
  namespace: 'namespace',
  varDecl: 'variable.decl',
  label: 'label',
  constBuiltin: 'constant.builtin',
  thisSuper: 'this.super',
  litString: 'lit.string',
  litNumber: 'lit.number',
  litRegex: 'lit.regex',
  litBigint: 'lit.bigint',
  litTemplate: 'lit.template',
  comment: 'comment',
  kwControl: 'kw.control',
  kwOperator: 'kw.operator',
  kwStorage: 'kw.storage',
  kwOther: 'kw.other',
  // lenient
  methodCall: 'method.call',
  classRef: 'class.ref',
  valueRef: 'value.ref',
  importBinding: 'import.binding',
  // the ambiguity fork — graded (NOT lexical floor): < > / when used as operators
  opCompare: 'op.compare',
  // markup (HTML/XML/…) — for the unified scope-gap harness across vscode#203212 languages
  tagName: 'tag.name',
  attrName: 'attr.name',
  // YAML structural roles the coarse key/value/comment oracle used to miss (issue #12):
  // anchors (&a), aliases (*a), document markers (--- / ...), string escapes (\n).
  anchor: 'anchor',
  alias: 'alias',
  docMarker: 'doc.marker',
  escape: 'escape',
  // YAML scopes the coarse key/value/comment oracle never emitted a token for, so ANY grammar
  // scope silently passed: block-scalar indicator (|/>), node tags (!!str), directives (%YAML),
  // flow punctuation ([ ] { } ,). Emitting these makes those blind spots graded.
  blockIndicator: 'block.indicator',
  tagType: 'tag.type',
  directive: 'directive',
  flowPunct: 'flow.punct',
  // lexical floor
  op: 'op',
  punct: 'punct',
} as const;

export type RoleName = (typeof R)[keyof typeof R];

// Common scope-prefix bundles, reused below so the table stays consistent.
// VALUE_SCOPES deliberately EXCLUDES type-name scopes (entity.name.type, support.type,
// support.class): a token tsc says is a *value* that a grammar paints as a *type* is
// the #978/#859 cascade ("typeof x < y" mis-read as a generic), and must read WRONG —
// not lenient-OK. This is what lets the bench see the generic-vs-less-than bug class.
const VALUE_SCOPES = ['variable', 'entity.name.function', 'entity.other', 'support.variable', 'support.function', 'support.constant', 'meta'];
const PROPERTY_SCOPES = [
  'variable.other.property',
  'variable.other.object.property',
  'variable.object.property',
  'entity.name.property',
  'entity.other.property',
  'support.variable.property', // builtin properties (.length, .name, …) — both grammars use this
  'meta.object-literal.key',
];

export const ROLE_SPEC: Record<RoleName, RoleSpec> = {
  // ── declarations: names being introduced ────────────────────────────────────
  [R.funcDecl]: {
    tier: 'strict',
    desc: 'function / method / constructor / accessor declaration name',
    exact: ['entity.name.function'],
    family: ['entity.name', 'support.function', 'variable.function', 'meta.function', 'meta.definition'],
  },
  [R.parameter]: {
    tier: 'strict',
    desc: 'parameter name in a signature',
    exact: ['variable.parameter'],
    family: ['variable', 'meta.parameter'],
  },
  [R.propDecl]: {
    tier: 'strict',
    desc: 'class/interface member name, object-literal key',
    exact: PROPERTY_SCOPES,
    family: ['variable.other', 'variable.object', 'entity.other', 'entity.name', 'meta.object-literal'],
  },
  [R.typeDecl]: {
    tier: 'strict',
    desc: 'class / interface / type-alias / enum declaration name',
    exact: ['entity.name.type', 'entity.name.class'],
    family: ['entity.name', 'support.class', 'support.type', 'meta.definition'],
  },
  [R.typeParam]: {
    tier: 'strict',
    desc: 'type-parameter declaration name (the <T>)',
    exact: ['entity.name.type.parameter', 'entity.name.type'],
    family: ['entity.name', 'variable.parameter', 'support.type'],
  },
  [R.enumMember]: {
    tier: 'strict',
    desc: 'enum member name',
    exact: ['variable.other.enummember', 'variable.other.constant', 'constant.other.enum'],
    family: ['variable.other', 'constant.other', 'entity.name'],
  },
  [R.namespace]: {
    tier: 'strict',
    desc: 'namespace / module declaration name',
    exact: ['entity.name.namespace', 'entity.name.type.module', 'entity.name.module'],
    family: ['entity.name', 'support.other.namespace', 'variable.other'],
  },
  [R.varDecl]: {
    tier: 'strict',
    desc: 'variable / binding declaration name',
    exact: ['variable.other.readwrite', 'variable.other.constant', 'meta.definition.variable', 'entity.name.variable'],
    family: ['variable.other', 'variable', 'meta.definition', 'entity.name'],
  },
  [R.label]: {
    tier: 'strict',
    desc: 'statement label (the `loop:` of a LabeledStatement, the target of break/continue)',
    exact: ['entity.name.label'],
    family: ['entity.name', 'variable.other.label', 'constant.other.label'],
  },

  // ── references in type position ──────────────────────────────────────────────
  [R.typeRef]: {
    tier: 'strict',
    desc: 'identifier used in a type position (annotation, heritage, type arg, constraint)',
    exact: ['entity.name.type', 'support.class'],
    family: ['entity.name', 'support.type', 'entity.other.inherited-class', 'meta.type'],
  },
  [R.typeBuiltin]: {
    tier: 'strict',
    desc: 'primitive type keyword (string, number, boolean, …) in a type position',
    exact: ['support.type'],
    family: ['storage.type', 'keyword', 'entity.name.type'],
  },

  // ── property reads ────────────────────────────────────────────────────────────
  [R.propAccess]: {
    tier: 'strict',
    desc: 'the `.name` of a (non-call) property access',
    exact: PROPERTY_SCOPES,
    family: ['variable.other', 'entity.other', 'entity.name', 'meta.property'],
  },

  // ── literals ──────────────────────────────────────────────────────────────────
  [R.litString]: { tier: 'strict', desc: 'string literal', exact: ['string', 'keyword.control.flow.block-scalar'], family: ['punctuation.definition.string', 'punctuation'] },
  [R.litNumber]: { tier: 'strict', desc: 'numeric literal', exact: ['constant.numeric'], family: ['constant', 'keyword.other.unit'] },
  [R.litRegex]: { tier: 'strict', desc: 'regular-expression literal', exact: ['string.regexp'], family: ['string', 'constant.regexp', 'punctuation.definition.string'] },
  [R.litBigint]: { tier: 'strict', desc: 'bigint literal', exact: ['constant.numeric'], family: ['constant'] },
  [R.litTemplate]: { tier: 'strict', desc: 'template-string text', exact: ['string'], family: ['string.template', 'punctuation.definition.string', 'punctuation'] },

  // ── comments ──────────────────────────────────────────────────────────────────
  [R.comment]: { tier: 'strict', desc: 'line / block / doc comment', exact: ['comment'], family: ['punctuation.definition.comment', 'punctuation.whitespace.comment'] },

  // ── keywords (token kind known from the parse tree) ────────────────────────────
  [R.kwControl]: { tier: 'strict', desc: 'control-flow keyword (if/for/return/…)', exact: ['keyword.control'], family: ['keyword'] },
  [R.kwOperator]: { tier: 'strict', desc: 'operator keyword (typeof/instanceof/in/keyof/new/as/…)', exact: ['keyword.operator', 'keyword.control'], family: ['keyword', 'storage'] },
  [R.kwStorage]: { tier: 'strict', desc: 'storage / modifier keyword (const/class/public/async/…)', exact: ['storage.type', 'storage.modifier'], family: ['keyword', 'storage'] },
  [R.kwOther]: { tier: 'strict', desc: 'other keyword', exact: ['keyword'], family: ['keyword', 'storage', 'constant.language'] },

  // ── special value tokens ──────────────────────────────────────────────────────
  [R.constBuiltin]: { tier: 'strict', desc: 'true / false / null / undefined', exact: ['constant.language'], family: ['constant', 'support.type', 'keyword', 'variable.language'] },
  [R.thisSuper]: { tier: 'strict', desc: 'this / super', exact: ['variable.language'], family: ['variable', 'keyword', 'constant.language'] },

  // ── lenient: genuinely contested between two defensible syntactic readings ─────
  // method-call accepts function OR property (the #736 debate) but NOT type — a
  // called thing painted as a type is still wrong.
  [R.methodCall]: {
    tier: 'lenient',
    desc: 'the `.name` that is the callee of a call — property OR function name (both defensible)',
    exact: ['entity.name.function', ...PROPERTY_SCOPES],
    family: ['entity.name.function', 'variable.other', 'entity.other', 'support.variable', 'support.function', 'meta'],
  },
  // class.ref is the ONE value position where a type scope is legitimately right
  // (a `new X` / decorator target is a class = both type and value).
  [R.classRef]: {
    tier: 'lenient',
    desc: 'identifier in `new X` / decorator position — type OR value (both defensible)',
    exact: ['entity.name.type', 'support.class', 'entity.name.class', 'entity.name.function'],
    family: ['entity.name', 'support', 'variable', 'meta'],
  },
  [R.valueRef]: {
    tier: 'lenient',
    desc: 'bare identifier used as a value, role not pinned by syntax (but NOT a type)',
    exact: [],
    family: VALUE_SCOPES,
  },
  [R.importBinding]: {
    tier: 'lenient',
    desc: 'import/export specifier name — type or value, undecidable without semantics',
    exact: [],
    family: [...VALUE_SCOPES, 'entity.name.type', 'support.type', 'support.class'],
  },

  // ── the ambiguity fork — GRADED (the source token of the regex/generic bugs) ───
  // `<` `>` `/` when tsc says they are binary operators. A grammar that paints them
  // as a generic bracket (punctuation.definition.typeparameters) or a regex
  // (string.regexp) instead of an operator is exactly the #978/#853 class — WRONG.
  [R.opCompare]: { tier: 'strict', desc: '< > / used as a binary operator', exact: ['keyword.operator'], family: ['keyword'] },

  // ── markup roles (HTML/XML) — entity names a highlighter must get right ───────
  [R.tagName]: { tier: 'strict', desc: 'element tag name (<div>, </div>)', exact: ['entity.name.tag'], family: ['entity.name', 'meta.tag', 'support.class.component'] },
  [R.attrName]: { tier: 'strict', desc: 'attribute name (class=, id=)', exact: ['entity.other.attribute-name'], family: ['entity.other'] },
  // ── YAML structural roles (issue #12) ─────────────────────────────────────────
  // An anchor NAME (`&a`): official `variable.other.anchor`, Monogram `entity.name.type.anchor` —
  // both defensible, so accept either. A mis-scope (e.g. the unscoped `source` of `? &a`) reads WRONG.
  [R.anchor]: { tier: 'strict', desc: 'YAML anchor name (&a)', exact: ['variable.other.anchor', 'entity.name.type.anchor'], family: ['variable.other', 'entity.name', 'variable'] },
  [R.alias]: { tier: 'strict', desc: 'YAML alias name (*a)', exact: ['variable.other.alias'], family: ['variable.other', 'variable', 'entity.name'] },
  // A document marker (`---` / `...`): official `entity.other.document.begin`/`.end`.
  [R.docMarker]: { tier: 'strict', desc: 'YAML document marker (--- / ...)', exact: ['entity.other.document', 'keyword.control'], family: ['entity.other', 'keyword', 'punctuation.definition'] },
  // A string escape (`\n`, `\t`, `\\`, `\uXXXX`): both engines use constant.character.escape — for a
  // VALUE; a mis-scope (e.g. inside a quoted KEY painted flat entity.name.tag) reads WRONG.
  [R.escape]: { tier: 'strict', desc: 'string escape sequence (\\n, \\t, …)', exact: ['constant.character.escape'], family: ['constant.character', 'constant.other'] },
  // ── YAML blind-spot roles (block indicator / tag / directive / flow punctuation) ───────────────
  // Written from the public YAML TextMate convention, NOT from either grammar: the block-scalar
  // `|`/`>` (+chomp/indent) is keyword.control.flow.block-scalar; a node tag is storage.type.tag;
  // a directive is keyword.other.directive; flow brackets/separators are punctuation.definition/
  // .separator. family accepts the defensible alternatives each grammar may legitimately use
  // (e.g. a coarse generic `punctuation` for flow, the split punctuation.definition.tag for a tag).
  [R.blockIndicator]: { tier: 'strict', desc: 'YAML block-scalar indicator (|/>, chomping, indent)', exact: ['keyword.control.flow.block-scalar'], family: ['keyword', 'storage.modifier', 'constant.numeric', 'punctuation.definition'] },
  [R.tagType]: { tier: 'strict', desc: 'YAML node tag (!!str / !foo / !<verbatim>)', exact: ['storage.type.tag'], family: ['storage.type', 'storage', 'entity.name.type', 'support.type', 'keyword.other', 'punctuation.definition.tag'] },
  // A directive is graded over its WHOLE line (full-span): the name is keyword.other.directive, but
  // the interior legitimately carries finer scopes a maintained grammar splits out — the version
  // (constant.numeric), the tag handle (punctuation.definition.tag), the tag prefix (support.type),
  // directive parameters (string.unquoted.directive-*). family accepts all of those so a correct
  // fine-grained directive is not penalised, while STILL rejecting the two readings that are the
  // monogram#12 bugs: a `#…` mis-read as a comment (#8) and a `,` mis-read as a flow separator (#1)
  // — neither `comment` nor `punctuation.separator` is in the family.
  // NB family carries `string.unquoted` (a maintained grammar scopes a directive's name/params as
  // string.unquoted.directive-name / -parameter): the comparative bench grades by visual CLASS, and a
  // string-coloured param is a defensible rendering, so it must not read WRONG. The PRECISE should-be
  // (a param belongs to the directive, not a stray plain scalar — monogram#12 #4) is pinned by the
  // strict regression gate yaml-issue12-regressions.ts, not relaxed here.
  [R.directive]: { tier: 'strict', desc: 'YAML directive line (%YAML / %TAG / %…) — name + handle/prefix/version', exact: ['keyword.other.directive'], family: ['keyword', 'punctuation.definition', 'support', 'storage', 'constant.numeric', 'string.unquoted', 'entity.name', 'variable.other'] },
  [R.flowPunct]: { tier: 'strict', desc: 'YAML flow punctuation ([ ] { } ,)', exact: ['punctuation.definition', 'punctuation.separator'], family: ['punctuation'] },

  // ── lexical floor: reported, excluded from the headline ───────────────────────
  [R.op]: { tier: 'lexical', desc: 'operator punctuation (+ - * = => …)', exact: ['keyword.operator'], family: ['keyword', 'punctuation', 'storage', 'meta'] },
  [R.punct]: { tier: 'lexical', desc: 'structural punctuation ( ) { } [ ] , ; …', exact: ['punctuation'], family: ['meta', 'source'] },
};

const LANG_SUFFIX = /\.(tsx?|typescript|jsx?|javascript|js)$/;

/** Normalise a raw innermost TextMate scope: drop the trailing language id. */
export function normScope(scope: string): string {
  let s = scope;
  // strip a trailing language segment, possibly more than one (e.g. `.ts.ts`)
  while (LANG_SUFFIX.test(s)) s = s.replace(LANG_SUFFIX, '');
  if (/^source\.\w+/.test(s)) s = s.replace(/^source\.\w+/, 'source');
  return s;
}

const startsWithAny = (s: string, prefixes: string[]): boolean =>
  prefixes.some((p) => p !== '' && (s === p || s.startsWith(p + '.'))) || prefixes.includes(s);

/** Grade a single TextMate scope against the expected role. */
export function gradeScope(role: RoleName, rawScope: string): Verdict {
  const spec = ROLE_SPEC[role];
  if (!spec) return 'wrong';
  const s = normScope(rawScope);
  if (startsWithAny(s, spec.exact)) return 'exact';
  if (startsWithAny(s, spec.family)) return 'family';
  return 'wrong';
}

// ─── stack-aware grading ────────────────────────────────────────────────────────
// Innermost-only grading (gradeScope on scopes[last]) is BIASED toward flat-painting
// grammars: an official grammar that correctly nests a role's scope as an ANCESTOR of a
// more-specific refinement is marked wrong even though the role is rendered correctly.
//   e.g. a YAML key is  source.yaml › entity.name.tag.yaml › punctuation.definition.string.begin.yaml
//   the ROLE (tagName = entity.name.tag) is the PARENT; innermost-only sees the string
//   delimiter and (wrongly) fails official. Monogram paints a single flat scope, so it wins
//   for free. The SAME bias hit YAML block-scalar `|`/`>`, HTML `<svg>` under an overlay, etc.
//
// FIX: a token is correct for its role if the role's accepted scope appears ANYWHERE in the
// token's scope chain — but ONLY role-bearing scopes (entity/variable/support/string/keyword/
// constant/comment/punctuation/storage/markup/invalid…) may match from an ANCESTOR position.
// The two COARSE region markers — `meta` and `source` — describe a *region*, not a token's
// role, so they keep matching only at the INNERMOST position (exactly as gradeScope already
// does). This is what preserves the #978/#859 cascade guard:
//   a value mis-painted as a generic is  source › meta.type.parameters › entity.name.type
//   innermost `entity.name.type` fails valueRef (whose family excludes type-name scopes); the
//   ancestors are `source` (coarse) and `meta.type.parameters` (coarse) — neither is a value
//   role-bearing scope, so NOTHING rescues it → still WRONG. A genuine mis-scope replaces the
//   role scope, so role-in-chain naturally still fails. (Verified by the calibration negatives
//   and by test/test-issues.ts, which must keep reading value-as-type / regex-as-operator wrong.)
//
// COARSE_PREFIXES is intentionally the *minimal* structural set; widening it could let a region
// wrapper rescue a genuinely-wrong token. Role-bearing prefixes are everything else.
const COARSE_PREFIXES = ['meta', 'source'];
const isCoarse = (prefix: string): boolean =>
  COARSE_PREFIXES.some((c) => prefix === c || prefix.startsWith(c + '.'));

const better = (a: Verdict, b: Verdict): Verdict =>
  a === 'exact' || b === 'exact' ? 'exact' : a === 'family' || b === 'family' ? 'family' : 'wrong';

/**
 * Grade a token by its WHOLE scope chain (outermost→innermost or innermost→outermost; order
 * irrelevant). The innermost scope is graded exactly as gradeScope (coarse prefixes honoured);
 * any ANCESTOR may additionally satisfy the role only via a role-bearing (non-coarse) accepted
 * prefix. Returns the best verdict so a correctly-nested ancestor role is credited, while a
 * value-painted-as-type cascade (whose only matching ancestors are coarse region markers) still
 * reads WRONG. Use this everywhere the bench grades; `chain` is `token.scopes` (any order).
 */
export function gradeScopeStack(role: RoleName, chain: string[]): Verdict {
  if (!chain.length) return 'wrong';
  const spec = ROLE_SPEC[role];
  if (!spec) return 'wrong';
  // 1. innermost scope graded with full semantics (coarse `meta`/`source` allowed here only)
  let best = gradeScope(role, chain[chain.length - 1]);
  if (best === 'exact') return 'exact';
  // 2. any scope (incl. ancestors) may match via a ROLE-BEARING accepted prefix
  const exact = spec.exact.filter((p) => p !== '' && !isCoarse(p));
  const family = spec.family.filter((p) => p !== '' && !isCoarse(p));
  for (const raw of chain) {
    const s = normScope(raw);
    if (startsWithAny(s, exact)) return 'exact';
    if (startsWithAny(s, family)) best = better(best, 'family');
  }
  return best;
}

/** correct = the grammar got the *role* right (exact or family). */
export function isCorrect(v: Verdict): boolean {
  return v === 'exact' || v === 'family';
}

// ─── token FAMILIES — the coarse, cross-ecosystem-fair grading axis ─────────────
// TextMate and tree-sitter classify at different granularities, so the
// multi-grammar README chart grades at the FAMILY level: the bucket where the
// *meaningful* highlighting errors live (value-painted-as-type, regex-as-operator,
// keyword-vs-identifier). A coarse-by-design engine (one that calls a function decl
// just `variableName`) is NOT penalised — both are the `value` family. Contested
// roles accept MULTIPLE families so neither reading is wrongly marked.
export type Family = 'type' | 'value' | 'property' | 'keyword' | 'literal' | 'comment' | 'punct';

/** The single family an oracle role belongs to (used to map engine output too). */
export function roleFamily(role: RoleName): Family {
  switch (role) {
    case R.typeRef: case R.typeDecl: case R.typeBuiltin: case R.typeParam: return 'type';
    case R.propAccess: case R.propDecl: case R.methodCall: return 'property';
    case R.litString: case R.litNumber: case R.litRegex: case R.litBigint: case R.litTemplate: case R.escape: return 'literal';
    case R.comment: return 'comment';
    case R.docMarker: case R.blockIndicator: case R.directive: return 'keyword';
    case R.tagType: return 'type';
    case R.flowPunct: return 'punct';
    case R.kwControl: case R.kwOperator: case R.kwStorage: case R.kwOther: case R.constBuiltin: case R.thisSuper: return 'keyword';
    case R.op: case R.punct: return 'punct';
    default: return 'value'; // funcDecl, parameter, varDecl, valueRef, classRef, namespace, enumMember, importBinding
  }
}

/** Families an engine may use for a role and still be "correct" — wider for the
 *  genuinely contested roles (a `new X` target is type OR value; a called `.m` is
 *  function OR property; `this` is keyword OR value). */
export function acceptableFamilies(role: RoleName): Set<Family> {
  switch (role) {
    case R.classRef: return new Set<Family>(['type', 'value']);     // new X / decorator — class is both
    case R.methodCall: return new Set<Family>(['value', 'property']); // called member — fn or prop
    case R.funcDecl: return new Set<Family>(['value', 'property']);   // a METHOD name is defensibly either
    case R.typeBuiltin: return new Set<Family>(['type', 'keyword']);  // `string`/`void`/… are type-keywords
    case R.importBinding: return new Set<Family>(['value', 'type']);  // import name — value or type
    case R.thisSuper: return new Set<Family>(['keyword', 'value']);   // this/super — either convention
    case R.constBuiltin: return new Set<Family>(['keyword', 'literal']); // true/false/null
    default: return new Set<Family>([roleFamily(role)]);
  }
}

// ─── calibration self-test (run: `node test/scope-roles.ts`) ────────────────────
// Proves the table behaves; guards against accidental edits breaking neutrality.
if (import.meta.url === `file://${process.argv[1]}`) {
  const cases: [RoleName, string, Verdict][] = [
    [R.funcDecl, 'entity.name.function.ts', 'exact'],
    [R.funcDecl, 'support.function.builtin.ts', 'family'],
    [R.funcDecl, 'variable.other.readwrite.ts', 'wrong'],
    [R.parameter, 'variable.parameter.ts', 'exact'],
    [R.parameter, 'entity.name.function.ts', 'wrong'],
    // property: both grammars' conventions accepted
    [R.propAccess, 'variable.other.property.ts', 'exact'],
    [R.propAccess, 'entity.other.property.ts', 'exact'],
    [R.propAccess, 'constant.numeric.ts', 'wrong'],
    [R.typeRef, 'entity.name.type.ts', 'exact'],
    [R.typeRef, 'support.class.ts', 'exact'],
    [R.typeRef, 'keyword.control.ts', 'wrong'],
    [R.litString, 'string.quoted.double.ts', 'exact'],
    [R.litString, 'keyword.control.flow.block-scalar.literal.yaml', 'exact'],
    [R.litString, 'punctuation.definition.string.begin.ts', 'family'],
    [R.litNumber, 'constant.numeric.decimal.ts', 'exact'],
    [R.comment, 'comment.line.double-slash.ts', 'exact'],
    [R.kwControl, 'keyword.control.flow.ts', 'exact'],
    [R.constBuiltin, 'constant.language.null.ts', 'exact'],
    // label role (entity.name.label): a generic value scope is NOT a label (official
    // emits entity.name.label; Monogram's variable.other.readwrite must read WRONG here).
    [R.label, 'entity.name.label.ts', 'exact'],
    [R.label, 'variable.other.readwrite.ts', 'wrong'],
    // `undefined`/`string`/… in TYPE position want support.type; a value-ish constant.language
    // is NOT a type-builtin (this is why Monogram's constant.language.null for `: undefined` is
    // honestly behind official's support.type.builtin — do NOT widen typeBuiltin to accept it).
    [R.typeBuiltin, 'support.type.builtin.ts', 'exact'],
    [R.typeBuiltin, 'constant.language.null.ts', 'wrong'],
    // lenient contested: both readings accepted, junk rejected
    [R.methodCall, 'entity.name.function.ts', 'exact'],
    [R.methodCall, 'variable.other.property.ts', 'exact'],
    [R.methodCall, 'comment.line.ts', 'wrong'],
    [R.classRef, 'support.class.ts', 'exact'],
    [R.classRef, 'entity.name.type.ts', 'exact'],
    [R.valueRef, 'variable.other.readwrite.ts', 'family'],
    [R.valueRef, 'string.quoted.ts', 'wrong'],
    // the #978 cascade guard: a VALUE painted as a TYPE must read WRONG
    [R.valueRef, 'entity.name.type.ts', 'wrong'],
    [R.valueRef, 'support.class.ts', 'wrong'],
    [R.valueRef, 'support.variable.ts', 'family'],
    // the ambiguity-operator fork: operator=correct, generic-bracket/regex=wrong
    [R.opCompare, 'keyword.operator.comparison.ts', 'exact'],
    [R.opCompare, 'punctuation.definition.typeparameters.begin.ts', 'wrong'],
    [R.opCompare, 'string.regexp.ts', 'wrong'],
    // class.ref is the one value spot where a type scope is right (new X)
    [R.classRef, 'entity.name.type.ts', 'exact'],
    // YAML blind-spot roles: public convention = exact; the coarse alternative each grammar may use = family
    [R.blockIndicator, 'keyword.control.flow.block-scalar.yaml', 'exact'],
    [R.blockIndicator, 'storage.modifier.chomping-indicator.yaml', 'family'],
    [R.tagType, 'storage.type.tag.yaml', 'exact'],
    [R.tagType, 'punctuation.definition.tag.begin.yaml', 'family'],
    [R.directive, 'keyword.other.directive.yaml', 'exact'],
    // directive interior: the version/handle/prefix sub-scopes a maintained grammar splits out are
    // FAMILY-correct; the two monogram#12 mis-readings (comment / flow-separator) stay WRONG.
    [R.directive, 'constant.numeric.yaml-version.yaml', 'family'],
    [R.directive, 'punctuation.definition.tag.begin.yaml', 'family'],
    [R.directive, 'comment.line.number-sign.yaml', 'wrong'],
    [R.directive, 'punctuation.separator.sequence.yaml', 'wrong'],
    [R.flowPunct, 'punctuation.definition.sequence.begin.yaml', 'exact'],
    [R.flowPunct, 'punctuation.yaml', 'family'],
  ];
  let pass = 0;
  const fails: string[] = [];
  for (const [role, scope, want] of cases) {
    const got = gradeScope(role, scope);
    if (got === want) pass++;
    else fails.push(`  ${role.padEnd(16)} ${scope.padEnd(40)} want=${want} got=${got}`);
  }
  console.log(`scope-roles calibration: ${pass}/${cases.length} passed`);
  if (fails.length) {
    console.log('FAILURES:\n' + fails.join('\n'));
    process.exit(1);
  }

  // ── stack-aware grading calibration (gradeScopeStack) ─────────────────────────
  // The bench grades the WHOLE scope chain (token.scopes), not just the innermost, so a role
  // correctly nested as an ANCESTOR is credited — WITHOUT letting a region wrapper rescue a
  // genuinely-wrong token (the #978 cascade guard). These lock both halves in.
  const stackCases: [RoleName, string[], Verdict, string][] = [
    // THE FIX: a stacked key — entity.name.tag is the PARENT, the innermost is the string
    // delimiter. Innermost-only marked official wrong; stack-aware credits the parent role.
    [R.tagName, ['source.yaml', 'entity.name.tag.yaml', 'punctuation.definition.string.begin.yaml'], 'exact', 'YAML key: tagName is the parent of the string delimiter'],
    // YAML block-scalar `|`/`>` is semantically part of the scalar, even when scoped as keyword.control.
    [R.litString, ['source.yaml', 'keyword.control.flow.block-scalar.yaml'], 'exact', 'block-scalar indicator as scalar literal'],
    // HTML <svg> tag name correctly nested under an invalid.illegal overlay region.
    [R.tagName, ['text.html', 'meta.tag.metadata.svg', 'entity.name.tag.svg', 'invalid.illegal.unrecognized-tag.html'], 'exact', 'svg tag name with an illegal overlay innermost'],
    // a Vue cast leak: the value `msg` correctly painted, deeper scope is just a meta wrapper.
    [R.valueRef, ['text.html.vue', 'source.ts', 'meta.cast.expr.ts', 'variable.other.readwrite.ts'], 'family', 'value under a cast meta wrapper'],
    // THE GUARD: a value mis-painted as a generic — innermost is the type-name scope and the
    // only matching ancestors are COARSE region markers (meta.type.parameters, source). Nothing
    // role-bearing rescues it → still WRONG. (This is exactly #978/#859.)
    [R.valueRef, ['source.ts', 'meta.type.parameters.ts', 'entity.name.type.ts'], 'wrong', 'value-as-generic cascade stays WRONG'],
    // and the regex/operator cascade: `<` painted as a typeparameter bracket.
    [R.opCompare, ['source.ts', 'meta.type.parameters.ts', 'punctuation.definition.typeparameters.begin.ts'], 'wrong', '< as a generic bracket stays WRONG'],
    // a value left bare inside a meta block (innermost coarse) is still family-OK, as before.
    [R.valueRef, ['source.ts', 'meta.objectliteral.ts', 'variable.other.readwrite.ts'], 'family', 'plain value under meta'],
    // sanity: an empty chain is wrong; a flat single-scope chain matches gradeScope.
    [R.varDecl, [], 'wrong', 'empty chain'],
    [R.varDecl, ['source.ts', 'variable.other.readwrite.ts'], 'exact', 'flat single scope still graded'],
  ];
  let spass = 0;
  const sfails: string[] = [];
  for (const [role, chain, want, why] of stackCases) {
    const got = gradeScopeStack(role, chain);
    if (got === want) spass++;
    else sfails.push(`  ${role.padEnd(12)} want=${want} got=${got}  [${why}]\n      chain=${chain.join(' › ')}`);
  }
  console.log(`scope-roles stack-aware calibration: ${spass}/${stackCases.length} passed`);
  if (sfails.length) {
    console.log('STACK FAILURES:\n' + sfails.join('\n'));
    process.exit(1);
  }

  // sanity: every role in R has a spec
  const missing = Object.values(R).filter((r) => !(r in ROLE_SPEC));
  if (missing.length) {
    console.log('MISSING SPECS: ' + missing.join(', '));
    process.exit(1);
  }
  console.log(`all ${Object.keys(ROLE_SPEC).length} roles specified · table OK`);
}
