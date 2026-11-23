// ShapeSpec v2: the CORE CALCULUS a shape is written in. A shape maps each (rule, arm NAME) of a
// grammar to a TERM: plain data over the arm's NAMED children (src/grammar-names.ts), closed
// under the operators below. There is no escape to code: a spec holding a function, or a term
// tag not listed here, is rejected when it is loaded (src/shape2-eval.ts `defineShape`). v1
// (src/shape-schema.ts) binds by position and is not changed by this file.
//
// It is an attribute grammar in a restricted form:
// - The node's VALUE is a synthesized attribute: computed from its arm and its named children.
//   A value term may also read the node's INHERITED attributes (`inh`).
// - Further SYNTHESIZED attributes (`synthesized`) are scalars computed from the arm and the
//   children's scalars / syntheses only. They never read inherited context, so each is a
//   function of the node's own subtree.
// - INHERITED attributes (`inherited`) are scalars a parent hands each child. An equation is a
//   constant or a copy of the parent's own inherited attribute; every (parent arm, child) not
//   given an equation gets the attribute's default. So inherited context is a finite label set
//   that flows down, decided by the parent's ARM and the child's NAME; it never carries a value
//   or a subtree. That is the declared, limited use of outer context, and it is what tells the
//   generator which nodes depend on where they sit (see `dependencies` in shape2-eval.ts).
// - One inherited attribute type is not a scalar: a NODE-VALUED attribute (`NodesAttr`), an
//   immutable list of nodes built from children to the LEFT of the child it feeds (tsc's
//   `modifiers`, which the arms wrapping a declaration hand the declaration). It is L-attributed
//   by construction and placed only, never inspected.
// - One list-level construct, THREADED state (`thread`), is the only way a node's context can
//   depend on its SIBLINGS: a parent arm, for a repeated child, threads one scalar left to right
//   across the repetition's iterations (the ELEMENTS): element k receives state k as the
//   inherited attribute; state 0 is the equation's `init` (a constant or a copy of the parent's
//   attribute, like any inherited equation); state k+1 is `next`, a scalar term over state k
//   (`var(acc)`) and element k's OWN children and their synthesized attributes, nothing else
//   (no `inh`, no child outside the element). So an element's context is a function of the
//   synthesized attributes of the elements before it: the directive prologue (a statement is a
//   directive while every statement before it in a Program / function body is one) is
//   `thread(init, 'p', and(v('p'), syn('directive', 'stmt')))`. Nothing else reads a sibling.
//
// Each operator's dependency class is in OPERATORS (`synthesized`: own subtree only;
// `inherited`: reads the parent's context). The survey's primitives (P2 type by operator text,
// P3 present / text / armOf, P5 conditional wrapping, P6 pass-through, P7 list fold / map) are
// these operators or short compositions of them (the constructor helpers at the end).

/** A scalar a term computes. */
export type Scalar = string | number | boolean | null;
export type ScalarType = 'string' | 'number' | 'bool';

/** A span: the start of `from` to the end of `to`; each a child name or a bound variable. A
 * list-valued child contributes its first element's start / its last element's end. Without a
 * span, a node spans the arm (its CST node).
 *
 * `{ after: X }` is ZERO WIDTH at the END of X: a node that consumed no token, placed where the
 * previous token ends (tsc's "missing" nodes: an `OmittedExpression` for an array hole is built
 * at getNodePos, the end of the token before it: in `[e, , f]` at the end of the first `,`; in
 * `[,]` at the end of `[`). X is a child that is always present in its scope (a required child:
 * an optional or repeated one is a load error, since it can be absent and the previous token is
 * not then X) or a bound variable.
 *
 * `{ inside: X }` is X without its DELIMITERS, where X is a part of a template literal (the
 * `quasi` / `head` / `literal` leaves of a template reference: see TemplateView in
 * src/shape2-eval.ts): ESTree's TemplateElement spans the text between `` ` `` / `}` and `${` /
 * `` ` ``. The delimiters are the template token's own (its `template` config), known when the
 * spec is loaded; any other X is a load error. */
export type Span = { from: string; to: string } | { after: string } | { inside: string };

export type Term =
  /** A constant scalar. */
  | { t: 'const'; value: Scalar }
  /** No value: a node field holding it is omitted; a list element holding it is null. */
  | { t: 'absent' }
  /** The value of a named child: a rule node's value under its own rule's mapping (a list when
   * the child repeats; absent when an optional child is missing). Pass-through (P6) is an arm
   * whose term is just `child`. */
  | { t: 'child'; name: string }
  /** The source text of a named single child, or of the arm when `name` is omitted. */
  | { t: 'text'; name?: string }
  /** A closed leaf cooking function (COOK_FNS) applied to a named leaf's text (some are absent
   * for some spellings: `tsNumericLiteralFlags` of a literal tsc flags nothing on). */
  | { t: 'cook'; fn: CookFn; name: string }
  /** Whether an optional child is present / a repeated child has at least one element. */
  | { t: 'present'; name: string }
  /** The arm name of a named rule-node child, or the branch name of a named inline alternation. */
  | { t: 'armOf'; name: string }
  /** A synthesized attribute of a named rule-node child (`name`), or of this node (no `name`). */
  | { t: 'syn'; attr: string; name?: string }
  /** An inherited attribute of this node. */
  | { t: 'inh'; attr: string }
  /** A node. `type` is a string term (a constant, or a `match` on an operator's text: P2). */
  | { t: 'node'; type: Term; fields: Record<string, Term>; span?: Span }
  /** A plain record (a value that is not a node, e.g. ESTree's `regex: { pattern, flags }`). An
   * arm whose whole term is a record makes its rule RECORD-VALUED (see `get`). */
  | { t: 'record'; fields: Record<string, Term> }
  /** A field of a named child's value, where the child's rule is RECORD-VALUED: every mapped arm
   * of that rule is a `record` term, all with the same field names (an arm without a value for
   * one writes `absent`). Such a rule is an interface, not a node: its child is read only through
   * `get` (`child` of it is a load error), and `get` of a field the rule does not declare, or of a
   * child of any other rule, is a load error. Only records are projectable, never a node's fields,
   * so a parent reads no descendant beyond what the child's rule exposes. A helper rule that the
   * grammar factors out of one production (ForHead: the `( … )` of a `for` statement, whose node
   * also holds the body) is mapped this way. */
  | { t: 'get'; name: string; field: string }
  /** A list; a `spread` item splices a list-valued term in. */
  | { t: 'list'; items: (Term | { spread: Term })[] }
  /** `list` without its final element when `cond` (a bool) holds; an empty list stays empty. The
   * condition is an ordinary term over the arm's children, never an absence test on the list's
   * values (a hole a spec writes as null and a missing child stay distinct). An array pattern or
   * literal is `[ E? (, E?)* ]` in the grammar and both oracles drop its final element when that
   * is a hole (`[a,]` -> [a]; `[a,,]` -> [a, hole]; `[,]` -> [hole]): the condition is the fold
   * "the final iteration's element is absent". */
  | { t: 'dropLastIf'; cond: Term; list: Term }
  /** A case on a string term; `else` when no case matches (without it, no match is an error). */
  | { t: 'match'; on: Term; cases: Record<string, Term>; else?: Term }
  | { t: 'if'; cond: Term; then: Term; else: Term }
  | { t: 'and' | 'or'; args: Term[] }
  | { t: 'not'; arg: Term }
  /** `of`, or `else` when `of` is absent. */
  | { t: 'orElse'; of: Term; else: Term }
  /** Dispatch on the branch taken by a named inline alternation; each case is evaluated in that
   * branch's scope (its own named children, then the enclosing arm's). */
  | { t: 'branch'; name: string; cases: Record<string, Term> }
  /** For each iteration of the repetition holding `over`, the body, in that iteration's scope
   * (the iteration's own children by name, then the enclosing scope's). */
  | { t: 'map'; over: string; body: Term }
  /** Left fold over the iterations of the repetition holding `over`: `acc` is bound to `init`
   * (spanning `init`'s child), then to each body result (spanning from the first item to the
   * iteration). A left-nested chain (tsc's comma `BinaryExpression`) is a fold. */
  | { t: 'fold'; over: string; init: Term; acc: string; body: Term }
  /** Bind a name to a value for `body`; its span is the value's span (a node) or the arm's. */
  | { t: 'let'; name: string; value: Term; body: Term }
  | { t: 'var'; name: string };

export type TermTag = Term['t'];

/** Each operator's dependency class: `synthesized` reads only the node's own subtree; `inherited`
 * reads the context the parent hands down. `synAttr` marks the operators a synthesized
 * attribute's equation may use (scalars over the subtree only). */
export const OPERATORS: Record<TermTag, { dep: 'synthesized' | 'inherited'; synAttr: boolean }> = {
  const: { dep: 'synthesized', synAttr: true },
  absent: { dep: 'synthesized', synAttr: true },
  child: { dep: 'synthesized', synAttr: false },
  text: { dep: 'synthesized', synAttr: true },
  cook: { dep: 'synthesized', synAttr: true },
  present: { dep: 'synthesized', synAttr: true },
  armOf: { dep: 'synthesized', synAttr: true },
  syn: { dep: 'synthesized', synAttr: true },
  inh: { dep: 'inherited', synAttr: false },
  node: { dep: 'synthesized', synAttr: false },
  record: { dep: 'synthesized', synAttr: false },
  get: { dep: 'synthesized', synAttr: false },
  list: { dep: 'synthesized', synAttr: false },
  dropLastIf: { dep: 'synthesized', synAttr: false },
  match: { dep: 'synthesized', synAttr: true },
  if: { dep: 'synthesized', synAttr: true },
  and: { dep: 'synthesized', synAttr: true },
  or: { dep: 'synthesized', synAttr: true },
  not: { dep: 'synthesized', synAttr: true },
  orElse: { dep: 'synthesized', synAttr: true },
  branch: { dep: 'synthesized', synAttr: true },
  map: { dep: 'synthesized', synAttr: false },
  fold: { dep: 'synthesized', synAttr: false },
  let: { dep: 'synthesized', synAttr: false },
  var: { dep: 'synthesized', synAttr: false },
};

/** The closed set of leaf cooking functions: each a pure function of one leaf's source text.
 * Every printer will implement exactly these (shape2-eval.ts holds the reference definitions). */
export const COOK_FNS = [
  'identifierName',   // an IdentifierName's StringValue: `a` / `\u{61}` escapes decoded
  'stringValue',      // a string literal's SV (ECMA-262 12.9.4): quotes removed, escapes decoded
  'numberValue',      // a NumericLiteral's MV: decimal, `0x` / `0o` / `0b`, legacy octal, `_` separators
  'bigintValue',      // a BigInt literal's value as decimal digits + `n` (the oracles' JSON form of a bigint)
  'bigintText',       // a BigInt literal as written, without the `n` suffix and `_` separators (ESTree `bigint`)
  'privateName',      // a PrivateIdentifier's name: the text after `#`, escapes decoded
  'tsNumericText',    // tsc's NumericLiteral text: the MV as a JavaScript number string (`0x1F` -> "31", `1.50` -> "1.5")
  'tsNumericLiteralFlags', // tsc's numericLiteralFlags (TokenFlags of the literal's spelling), absent when none
  'tsBigIntText',     // tsc's BigIntLiteral text: as written, `_` separators removed
  'hasExtendedUnicodeEscape', // whether a string literal or a template part holds a valid `\u{...}` escape (tsc stores it on every string, and on a template part only when true)
  'regexPattern',     // a RegularExpressionLiteral's body (between the slashes)
  'regexFlags',       // a RegularExpressionLiteral's flags
  'stringBody',       // a string literal's source between its quotes, escapes kept (ESTree's `directive`)
  // A template literal's part (the token of a `quasi` / `head` / `literal` leaf, delimiters
  // included: `` `a${ ``, `` }b` ``; the text between them is the part's body):
  'templateCooked',   // the TV (ECMA-262 13.15.3): escapes decoded, CR / CRLF as LF; null when an escape is invalid (a tagged template's NotEscapeSequence)
  'templateRaw',      // the TRV: the body as written, CR / CRLF as LF (ESTree `raw`)
  'tsTemplateText',   // tsc's `text`: the TV, but an invalid escape keeps its backslash and the characters after it stay ordinary text
  'tsTemplateRawText', // tsc's `rawText`: the body exactly as written (CR / CRLF kept)
  'tsTemplateFlags',  // tsc's templateFlags (TokenFlags of the body's escapes: ExtendedUnicodeEscape 8, UnicodeEscape 1024, ContainsInvalidEscape 2048, HexEscape 4096), absent when none
] as const;
export type CookFn = (typeof COOK_FNS)[number];

/** A synthesized scalar attribute: an equation per (rule, arm); an arm without one takes
 * `default` (required unless every arm of every rule that is asked has an equation). */
export type SynAttr<R extends string = string> = { type: ScalarType; default?: Scalar; rules: ByRule<R, Record<string, Term>> };
/** A threaded equation (see the header): on a REPEATED child of the arm's own scope. Every rule
 * node inside iteration k of the innermost repetition holding that child (the child itself, or
 * the rule nodes of the branch an alternation took there) receives state k; state 0 is `init`
 * (a constant or `inh` of the parent's attribute), state k+1 is `next` evaluated in iteration
 * k's scope (only that iteration's children) with `acc` bound to state k. */
export type ThreadEq = { t: 'thread'; init: Term; acc: string; next: Term };
/** An inherited equation: a constant, `inh` of the parent's own attribute, or a thread. */
export type InhEq = Term | ThreadEq;
/** An inherited scalar attribute: per (rule, arm, child name) an equation (InhEq); every other
 * child, and the root, gets `default`. An arm holding a thread for the attribute has no other
 * equation for it. */
export type InhAttr<R extends string = string> =
  | { type: ScalarType; default: Scalar; rules: ByRule<R, Record<string, Record<string, InhEq>>> }
  | NodesAttr<R>;
/** A NODE-VALUED inherited attribute: an immutable list of nodes a parent arm builds from what
 * sits to the LEFT of the child it hands them to, and that child's arm places in its own node.
 * tsc's `modifiers`: the `export` / `declare` words and the outer decorators sit in the Decl arms
 * that wrap a declaration, and tsc puts them on the inner declaration node (`export declare
 * function f(): void;` is one FunctionDeclaration whose modifiers are [ExportKeyword,
 * DeclareKeyword]). Its default, at the root and for every child without an equation, is the
 * empty list. An equation is a value term (list / spread / child / inh / node / ..., no `syn`,
 * `get`, `fold`, `let`) that reads only children strictly to the LEFT of the child it feeds, so
 * it is L-attributed by construction. The attribute is IMMUTABLE: `inh` of it (and a `let`
 * variable bound to it) appears only as a `spread` item of a list, a span endpoint, or under
 * `present` (non-empty); anything else is a load error. A list-valued variable spans its first
 * element's start to its last element's end, as a list-valued child does, so a receiver that
 * starts at its first inherited node says so: `let_('m', inh('modifiers'), iff(present('m'),
 * node(T, {...}, { from: 'm', to: … }), node(T, {...})))`. */
export type NodesAttr<R extends string = string> = { type: 'nodes'; rules: ByRule<R, Record<string, Record<string, Term>>> };

/** A table keyed by rule name: with the grammar's rule names known (`R`, from `defineGrammar`'s
 * type), a key that is not one of them is a TypeScript error; arm and child names are strings,
 * checked when the shape is loaded (`defineShape`). */
export type ByRule<R extends string, X> = string extends R ? Record<string, X> : { [K in R]?: X };

export type NodeKeys = { kind?: string; start?: string; end?: string };
export const nodeKeysOf = (spec: { node?: NodeKeys }): { kind: string; start: string; end: string } =>
  ({ kind: spec.node?.kind ?? 'kind', start: spec.node?.start ?? 'start', end: spec.node?.end ?? 'end' });
export type ShapeSpec<R extends string = string> = {
  name: string;
  /** Every arm of every rule in `rules` must be mapped (an unmapped arm is a load error), and
   * every `branch` must have a case for each branch. Without it, evaluating an unmapped arm
   * throws `ShapeUnmapped` naming it. */
  total?: boolean;
  /** The keys a node value holds its kind and span under, beside its fields, in this order (one
   * flat object per node: `{ [kind]: …, [start]: …, [end]: …, ...fields }`). Default `kind`,
   * `start`, `end`; ESTree's are `type`, `start`, `end`. A node term with a field of one of these
   * names is a load error. */
  node?: NodeKeys;
  /** rule -> arm name -> the arm's value. */
  rules: ByRule<R, Record<string, Term>>;
  synthesized?: Record<string, SynAttr<R>>;
  inherited?: Record<string, InhAttr<R>>;
};

// ── Constructor helpers: plain-data builders, and the survey's primitives as sugar ──

export const c = (value: Scalar): Term => ({ t: 'const', value });
export const absent: Term = { t: 'absent' };
export const child = (name: string): Term => ({ t: 'child', name });
export const text = (name?: string): Term => (name === undefined ? { t: 'text' } : { t: 'text', name });
export const cook = (fn: CookFn, name: string): Term => ({ t: 'cook', fn, name });
export const present = (name: string): Term => ({ t: 'present', name });
export const armOf = (name: string): Term => ({ t: 'armOf', name });
export const syn = (attr: string, name?: string): Term => (name === undefined ? { t: 'syn', attr } : { t: 'syn', attr, name });
export const inh = (attr: string): Term => ({ t: 'inh', attr });
export const node = (type: string | Term, fields: Record<string, Term> = {}, span?: Span): Term =>
  ({ t: 'node', type: typeof type === 'string' ? c(type) : type, fields, ...(span ? { span } : {}) });
export const record = (fields: Record<string, Term>): Term => ({ t: 'record', fields });
export const get = (name: string, field: string): Term => ({ t: 'get', name, field });
export const list = (...items: (Term | { spread: Term })[]): Term => ({ t: 'list', items });
export const spread = (of: Term): { spread: Term } => ({ spread: of });
export const dropLastIf = (cond: Term, of: Term): Term => ({ t: 'dropLastIf', cond, list: of });
export const match = (on: Term, cases: Record<string, Term>, orElse?: Term): Term =>
  ({ t: 'match', on, cases, ...(orElse ? { else: orElse } : {}) });
export const iff = (cond: Term, then: Term, otherwise: Term): Term => ({ t: 'if', cond, then, else: otherwise });
export const and = (...args: Term[]): Term => ({ t: 'and', args });
export const or = (...args: Term[]): Term => ({ t: 'or', args });
export const not = (arg: Term): Term => ({ t: 'not', arg });
export const orElse = (of: Term, otherwise: Term): Term => ({ t: 'orElse', of, else: otherwise });
export const branch = (name: string, cases: Record<string, Term>): Term => ({ t: 'branch', name, cases });
export const map = (over: string, body: Term): Term => ({ t: 'map', over, body });
export const fold = (over: string, init: Term, acc: string, body: Term): Term => ({ t: 'fold', over, init, acc, body });
export const let_ = (name: string, value: Term, body: Term): Term => ({ t: 'let', name, value, body });
export const v = (name: string): Term => ({ t: 'var', name });
export const thread = (init: Term, acc: string, next: Term): ThreadEq => ({ t: 'thread', init, acc, next });

/** P2: a node type chosen by a child's text (an operator or a leaf), from a table. */
export const typeByText = (name: string, table: Record<string, string>): Term =>
  match(text(name), Object.fromEntries(Object.entries(table).map(([k, ty]) => [k, c(ty)])));
/** P5: wrap `inner` in a node of `type` holding it as `field` when `cond` holds. */
export const wrapIf = (cond: Term, type: string, field: string, inner: Term): Term =>
  let_('$wrapped', inner, iff(cond, node(type, { [field]: v('$wrapped') }), v('$wrapped')));
