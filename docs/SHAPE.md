# Shape mapping — declarative AST on top of the CST

> **Two generations.** A v2 shape (this section and the next) binds the grammar's stable NAMES and
> is written with `defineShape` (`monogram/shape`, [`src/shape.ts`](../src/shape.ts)); it is a
> closed calculus of plain data ([`src/shape2-schema.ts`](../src/shape2-schema.ts)) with no escape
> to code. **What v2 does today:** it is checked against its grammar when it is defined, and
> EVALUATED over the interpreter's CST ([`src/shape2-eval.ts`](../src/shape2-eval.ts), the
> reference). **What it does not do yet:** no emitted parser builds a v2 shape's AST, and no AST
> type definitions are derived from one. `emitTs` / `emitRust` with `{ shape }` still take a v1
> spec, which binds by POSITION; the sections from "v1: the positional ShapeSpec" down describe it.

## Writing a shape with defineShape

A shape maps each (rule, arm) of a grammar to a TERM over the arm's named children. Half of
those names are derived from the syntax (`binaryOp`, `led_dot`, `left`, `expr`), so start from
the grammar's own list of them:

1. **Print the skeleton.** `node src/cli.ts calc.ts --shape-skeleton > calc-shape.ts` prints a
   complete shape module: every arm of every rule, mapped to a node `Rule.arm` that holds its
   named children (the CST as a shape), each arm with its children and their multiplicity in a
   comment (`left: Expr, op: leaf, right: Expr`; `x?` optional, `x[]` a list). It loads as it is.
2. **Fill it in.** Replace each term with the node you want; delete the arms you do not map yet.
3. **Check it.** `node src/cli.ts calc.ts --shape calc-shape.ts` loads the shape (every problem
   is reported at once, `<where>: <what>`, with the names that do exist: in full when there are
   few, else the nearest) and prints its COVERAGE: the arms it maps, the arms it leaves out that
   evaluation from the grammar's entry rule can reach (each with a skeleton term to start from),
   and the arms it leaves out that nothing mapped reaches. `shapeCoverage(shape)` returns the same
   as data. Reachability is computed from the grammar and the spec, not from inputs.

The example below is `test/fixtures/shape-namedcalc.ts`, on the grammar
`test/fixtures/namedcalc.ts`; the gate `shape2-eval` checks that this page holds it verbatim and
that it evaluates to the value shown.

<!-- shape-example:start -->
```ts
// The shape docs/SHAPE.md shows ("Writing a shape with defineShape"): the gate shape2-eval checks
// that the document holds this file verbatim and that it evaluates to the value shown there.
import grammar from './namedcalc.ts';
import { defineShape, child, cook, node, text, typeByText } from 'monogram/shape';

export default defineShape(grammar, {
  name: 'calc-ast',
  total: true,   // every arm of a mapped rule must be mapped: a left-out arm is a load error
  rules: {
    Program: { program: node('Program', { body: child('statement') }) },
    Stmt: {
      letDeclaration: node('Let', { name: text('binding'), init: child('initializer') }),
      expression: node('ExpressionStatement', { expression: child('expression') }),
    },
    Expr: {
      number: node('Num', { value: cook('numberValue', 'number') }),
      name: node('Name', { name: text('ident') }),
      parenthesized: child('expression'),   // pass-through: written, never implied
      binaryOp: node(typeByText('op', { '+': 'Add', '-': 'Sub', '*': 'Mul', '/': 'Div' }), { left: child('left'), right: child('right') }),
      prefixOp: node('Neg', { operand: child('operand') }),
      postfixOp: child('operand'),   // calc has no postfix operator: the arm never occurs
    },
  },
});
```
<!-- shape-example:end -->

<!-- shape-example-value:start -->
```js
evaluateShape(shape, parse("let x = -(1 + y);"), "let x = -(1 + y);")
// =>
{ "kind": "Program", "start": 0, "end": 17, "body": [
  { "kind": "Let", "start": 0, "end": 17, "name": "x", "init":
    { "kind": "Neg", "start": 8, "end": 16, "operand":
      { "kind": "Add", "start": 10, "end": 15,
        "left": { "kind": "Num", "start": 10, "end": 11, "value": 1 },
        "right": { "kind": "Name", "start": 14, "end": 15, "name": "y" } } } } ] }
```
<!-- shape-example-value:end -->

A node is ONE flat object: its kind and span under the shape's node keys, then its fields in the
term's order (an absent one left out). The keys default to `kind`, `start`, `end`; a shape declares
its own with `node: { kind, start, end }` (ESTree: `node: { kind: 'type' }`, so the value IS an
ESTree node), and a node term with a field of one of those names is a load error.

(`parse` is the interpreter's: `createParser(grammar).parse(src)` from `src/gen-parser.ts`. The
parenthesised `1 + y` passes through: the Add node spans `1 + y`, not its parentheses.)

What is checked, and where:
- **By TypeScript:** rule names. `defineGrammar`'s type carries its rule names (`Grammar<R>`), so
  `Exprr: { ... }` in `rules` (or in an attribute's `rules`) is a type error. Arm and child names
  are strings to TypeScript: half of them are derived at load time (below), and the type system
  would have to re-run that derivation.
- **When the shape is defined** (`defineShape` throws `ShapeSpecError`, listing every problem):
  rule / arm / child / branch / attribute / record-field names; a term outside the calculus (a
  function, an unknown operator or cooking function); a term reading a child the arm does not have
  or reading it the wrong way (`child` of a leaf, `text` of a list, `present` of a required child,
  `get` of a rule that is not record-valued); attribute types (a `bool` attribute's equation, a
  copy of a `string` attribute into a `bool` one); an inherited equation outside its allowed forms
  (a constant, a copy, a scalar over the parent's own leaves, a thread, or a nodes list built from
  what is LEFT of the child); with `total: true`, a left-out arm of a mapped rule.
- **An arm with no term is UNMAPPED**, never passed through implicitly: evaluating one throws
  `ShapeUnmapped` naming it (a pass-through is written: `parenthesized: child('expression')`).
  `--shape` lists every left-out arm evaluation can reach.

### Names a shape depends on, and what renames them

A shape is a contract against the grammar's names ([`src/grammar-names.ts`](../src/grammar-names.ts)).
A name the grammar author WRITES, `arm('letDeclaration', ...)` or `field('binding', Ident)`, never
changes unless the author changes it. A DERIVED name changes when:
- an arm's first significant item changes (an arm is named from it: `if`, `led_dot` for a led
  starting `.`, `binaryOp` / `prefixOp` / `postfixOp` for the operator forms);
- a child's reference changes (a child is named from what it references: `expr`, `block`; a
  keyword leading an optional group is `<kw>Tok`, a keyword alternation `<first>Kw`, a structural
  alternation `alt`);
- an earlier arm or child with the same derived name is added or removed: a repeated derived
  name gets a numeric suffix (`export2`, `expr2`), which is POSITIONAL. `nameReport` in
  `src/grammar-names.ts` lists every such name.

To pin a name, write it in the grammar (`arm(name, ...)` / `field(name, item)`): naming is
transparent (every generated parser and highlighter is byte-identical with or without names:
gate `grammar-names-transparent`), so pinning costs nothing. A renamed name is a load error of
every shape that uses it, with the names that exist now.

## v2: the parts the fused end state needs

The two v2 specs are `test/fixtures/shape-v2-estree-expr.ts` (ESTree, against acorn) and
`test/fixtures/shape-v2-tsc-expr.ts` (tsc's AST, against tsc). Both are built from the same
grammar names.

### Template literals

A template reference (a `template` token) is read as a fixed inline alternation. It is a
structure the calculus reads, not a new operator (`TemplateView` in `src/shape2-eval.ts`):

| branch | children |
|---|---|
| `noSubstitution` | `quasi`: the whole token (a leaf) |
| `substitution` | `head` (a leaf), then one iteration per hole: `expr` (the hole's rule node) and `part`, an alternation `middle` / `tail`, each holding the leaf `literal` |

- **A template hole is a fresh expression context.** Its node takes every inherited
  attribute's DEFAULT, whatever the arm holding the template hands its other children.
- The hole's rule is the reference's `withHoles` rule, else the grammar's expression rule.
- A part's values come from five cooking functions over the part's token text:
  `templateCooked`, `templateRaw`, `tsTemplateText`, `tsTemplateRawText`, `tsTemplateFlags`.
  `hasExtendedUnicodeEscape` reads a valid `\u{…}` in a part as it does in a string.
- The span `{ inside: X }` is the part X without its delimiters (ESTree's TemplateElement). The
  delimiters come from the token's `template` config when the spec is loaded. X must be a
  template part; any other leaf is a load error.

### Inherited equations: what they may read, and which are right-dependent

An inherited equation (the context a parent arm hands a named child) is one of:
- a constant;
- a copy of the parent's own attribute (`inh`);
- a scalar over the parent arm's own LEAVES (`text`, `cook`, `present`, and `armOf` / `branch`
  of an alternation of leaves) and the parent's inherited attributes, combined with `match` /
  `if` / `and` / `or` / `not` / `orElse`.

It never reads `syn` of a sibling node, or anything else inside a sibling subtree. So at worst,
ONE LEAF to the right of the child decides the child's context.

The loader classifies every equation (`Shape.rightDependent`):
- **L-attributed**: it reads nothing to the right of the child it feeds;
- **RIGHT-DEPENDENT**: it reads a leaf that comes after the child.

| spec | right-dependent equations |
|---|---|
| ESTree | `Expr.binaryOp.left` → `pattern`, read from the operator leaf `op` (`=`) |
| tsc | none (the gate `shape2-eval` asserts it); its inherited equations are `chainTop` and `heritageElement`, constants, and `modifiers`, node-valued (below) |

A **node-valued** inherited attribute (`type: 'nodes'`, `NodesAttr` in `src/shape2-schema.ts`) is
the one attribute type that is not a scalar: an immutable list of nodes, default the empty list.
- **What it is for.** tsc puts the `export` / `declare` words and the outer decorators on the
  INNER declaration node (`export declare function f(): void;` is one FunctionDeclaration whose
  modifiers are [ExportKeyword, DeclareKeyword]; `@d export class C {}` is one ClassDeclaration at
  0 whose modifiers are [Decorator, ExportKeyword]), while in the grammar those words sit in the
  Decl arms that wrap the declaration. A scalar label cannot carry nodes with their own spans.
- **Its equations.** A value term (list, spread, child, inh, node, a leaf's token, and the
  scalar operators over leaves; no `syn`, `get`, `fold`, `let`) that reads only children strictly
  to the LEFT of the child it feeds. The loader rejects a read at or to the right of it (a branch
  that holds the child counts as "at"), so every such equation is **L-attributed by construction**
  and is never on the right-dependent list.
- **Immutable.** `inh` of it, and a `let` variable bound to it, appears only as a `spread` item of
  a list, a span endpoint, or under `present` (whether it is non-empty). Anything else (a field, a
  condition, a scalar equation) is a load error.
- **The receiver says where it starts.** A list-valued variable spans its first element's start to
  its last element's end, as a list-valued child does, so a receiver writes "I start at the first
  inherited node when there is one" itself: `let_('m', inh('modifiers'), iff(present('m'),
  node(T, { modifiers: list(spread(v('m')), …) }, { from: 'm', to: … }), node(T, …)))`.
- **Placed or loud.** A node handed a non-empty list whose arm does not read it is outside the
  subset (`Stmt.expr (handed modifiers)`: tsc's `declare x;`), never a node without them.
- **Reuse.** A receiver's node depends on the nodes its wrappers built to its left: `dependencies`
  marks every receiver (and every arm that hands the list on) context-dependent, so it is reused
  only where its inherited list is unchanged.

ESTree's `pattern` is the cover grammar. A literal on the left of `=`, or in a `for … in / of`
head's left (a constant equation, so L-attributed), is an assignment pattern there:
ArrayPattern / ObjectPattern / RestElement / AssignmentPattern. tsc keeps the literal as it is.

The SPINE of `pattern` is derived by `spineOf`:
- arms that read it: `Expr.array`, `Expr.binaryOp`, `Expr.object`, `Expr.spread`, `Prop.spread`;
- children it is copied into: `Expr.array.element` / `elementRest`, `Expr.object.property`,
  `Expr.spread.expr`, `Prop.init.value`, `Prop.spread.argument`.

Whether a pattern is VALID (`[a + b] = c`) is the grammar's or the early errors' business, not
the shape's.

### How a generated parser builds the two Pratt-left attributes (no variants)

The left operand of a led is built before the led is seen, so an inherited attribute a led hands
its LEFT is not known when the left is built. The plan (`src/shape-plan.ts`) derives one of two
treatments from the spec; neither is a term the author writes:

- **A reader-applied top** (`topForm`; ESTree `chainTop`, tsc `heritageElement`'s form). An
  inherited attribute read only in a term's outermost layer `iff(c, W[X], X)`, with X not reading
  it and c, W reading only it, the arm's own synthesized attributes and X: the construct builds X
  (and keeps c under the attribute = true, one bit per slot); each reader of the slot applies the
  layer with its own equation value. It is legal because the layer is a function of what the
  reader knows (its equation value) and of what the child synthesized (X and its attributes), so
  the attribute's last use moves up into the reader: the same L-attributed question answered from
  the other side. A chain link is built once (`a?.b.c`: `.c` reads `a?.b` with `chainTop` false,
  the statement reads `a?.b.c` with true and wraps it in ChainExpression).
- **Re-parse on demand** (ESTree `pattern`, which the literals copy into their elements: a spine,
  not a top). The attribute is context, as an rd rule's is: set at every call of the rule, read
  where an arm reads it. At a led (or the binary operator) whose value for its left differs from
  the value the left was built under, and whose left's arm reads or copies the attribute (a SPINE
  arm), the parser restores to the Pratt invocation's mark and parses the left again under the
  led's value, up to the led's token, then goes on. Only destructuring assignments pay: 7 of 8,908
  `=` in the real JavaScript corpus have a literal on their left (72 constructions rebuilt, against
  26,622 pairs if both readings of every spine node were built). Bound: one re-parse per Pratt
  invocation in a valid program (nested destructuring re-parses once per nesting level); the gate
  `shape2-oracle` fails when an invocation re-parses more than once. The trigger "the left's arm is a
  spine arm" is one plan predicate per led (`Restart.spine`); the engine's assignment-target form
  bits (`form & formPass(i)`) are the exact form of the same test.

### Classes

- **ESTree.** Block is RECORD-VALUED (its `body`): a block statement, a function body and a
  static block share the grammar's one Block rule, and each parent builds the node it needs
  (StaticBlock holds the statements itself and spans from `static`).
- **tsc.** A heritage element is an ExpressionWithTypeArguments around its top ClassHeritage node.
  The inherited `heritageElement` (bool) says "top". The class arms hand it to their `base`
  children as a constant, so it is L-attributed. The element's own `left` children take the
  default. A method named `constructor` (the identifier, or a string with that value) is tsc's
  Constructor: synthesized `constructorName` on MemberName. A modifier word is its keyword token
  (`match` on the word's text), and `modifiers` is absent when it would be empty.
- **Not yet in the subset (tsc).** Decorators (DecoratorExpr), index signatures, types, the `new
  class` arms, and a class expression as a heritage base. A class an `export` / `declare` / modifier
  prefix arm wraps is in it (the `modifiers` attribute, below).

### Modules

- **ESTree.** ImportDeclaration (ImportDefaultSpecifier, ImportSpecifier, ImportNamespaceSpecifier;
  an import clause is its specifier list), ExportNamedDeclaration (of a declaration, or of
  specifiers with or without a source), ExportDefaultDeclaration (a function / class declaration
  spans its own branch; an expression is itself), ExportAllDeclaration, ImportAttribute,
  ImportExpression and `import.meta` (MetaProperty). An unrenamed specifier holds its one name twice.
- **tsc.** ImportDeclaration with ImportClause (RECORD-VALUED in the grammar's ImportClause rule:
  tsc's node also spans a `type` that the Decl arm reads), NamedImports / NamespaceImport, the
  `type` / `defer` phases, ImportEqualsDeclaration (ExternalModuleReference, QualifiedName chains),
  ExportDeclaration (NamedExports, NamespaceExport, `isTypeOnly`), ExportAssignment (`export =`,
  `export default x`), NamespaceExportDeclaration, ImportAttributes. The `export` / `declare` /
  prefix arms are pass-through; they hand `modifiers` down.

### What a generated parser must have at hand, per operator (the parser-emit table)

| operator | at the construct site |
|---|---|
| `child`, `get`, `present`, `armOf`, `branch` | the arm's named finish sites; a record-valued rule's function returns a value struct with no node and no builder call |
| `text`, `cook`, span endpoints | the named leaf's offsets (and its text for `cook`) |
| `syn` | a scalar returned beside the node |
| `inh` | a scalar parameter of the rule function |
| `thread` | a loop-local scalar |
| `map`, `fold` | the repetition's loop; a fold's accumulator is a loop-local |
| `dropLastIf(cond, list)` | one loop-local "last element was a hole" bit (the fold), and a conditional pop at the loop's end |
| span `{ after: X }` | the end offset of the consumed leaf X, which the parser holds when it consumes it |
| template parts (`noSubstitution` / `substitution`) | the head / middle / tail leaves the parser consumes; a hole's value is built by the hole rule's function, called with the default context |
| span `{ inside: X }` | X's offsets, and the static widths of its part kind's delimiters (from the token's template config at generation time) |
| an L-attributed inherited equation | its scalar, computed at the call site from leaves already consumed and the parent's attributes |
| a node-valued inherited attribute | a handle to an immutable list of nodes already built to the child's left, passed as a parameter of the child's rule function; the receiving arm places it and takes its span start from its first element. Arena: the nodes precede the child's mark, so a losing candidate's reset never frees them |
| `present(v)` of a nodes variable, a span endpoint at it | the handle's length; its first node's start |
| a right-dependent inherited equation | the child is built under the invocation's context. When the deciding leaf arrives and the value differs and the child's arm is a spine arm, the parser re-parses the child under the new value (above: re-parse on demand) |
| an inherited attribute read only in the top layer | the child's value without the layer and the layer's condition bit; the reader applies the layer (above: a reader-applied top) |

## v1: the positional ShapeSpec (what `emitTs` / `emitRust` consume today)

A **shape** maps a grammar's concrete syntax tree (CST) into a consumer AST
(types + builders). You declare the mapping once as a `ShapeSpec`;
[`emitTs(grammar, { shape })`](../src/target-ts.ts) appends typed AST constructors
and a specialized `parseAst` entry. Without a shape, `emitTs(grammar)` is
byte-identical to `tsTarget.emitParser(...)`.

Source of truth for types: [`src/shape-schema.ts`](../src/shape-schema.ts).
Target-neutral contracts (custom context, fold markers, transaction rules):
[`src/shape-machine.ts`](../src/shape-machine.ts).

---

## ShapeSpec

```ts
type ShapeSpec = {
  grammar: string;                           // must match the grammar's name
  spans: 'required' | 'optional' | 'none';   // off/end injection on nodes
  unmapped: 'default' | 'error';             // keep vs fail on missing rules
  leaves: Record<string, TokenLeafPolicy>;   // per token-class policy
  rules: Record<string, RuleShape>;          // per IR / CST rule product
};
```

| Field | Meaning |
|---|---|
| `grammar` | Labels the spec; validated against the grammar you emit. |
| `spans` | Inject unified `off`/`end` source-range fields on node products (`required` always, `optional` as `off?`/`end?`, `none` omit). |
| `unmapped` | `'default'` keeps unmapped rules as positional CST-shaped nodes; `'error'` demands full coverage (calc uses this). |
| `leaves` | Token-class policies: `{ action: 'drop' \| 'keep' \| 'leafValue', fn? }`. `leafValue` coercions: `identity`, `number`, `bigint`, `string`, `boolean`, `ident` (or a custom name). |
| `rules` | Map rule name → product shape. |

Adjudications (spans, unmapped, heterogeneous alts, rule keying) live in
`ADJUDICATIONS` in [`shape-schema.ts`](../src/shape-schema.ts).

### Field binds (`FieldDecl`)

Node fields bind from packed kids / Pratt locals:

| Bind | Effect |
|---|---|
| `{ at: n }` | Kid at index `n`. |
| `{ label }` | Named kid (when labeled). |
| `{ from: 'list'; of: n \| 'rest' }` | List / rest slot. |
| `{ from: 'opt'; at: n }` | Optional hole (null when absent). |
| `'opText'` | Pratt connector text (**bindOp**) — prefix / binary / postfix only. |

---

## Primitives

### Core six

| Kind | Role |
|---|---|
| `drop` | Consume the rule; product is absent (`null`). |
| `inline` | Splice kids into the parent (no wrapper). Pratt `group` often uses this for `(Expr)`. |
| `node` | Named product `{ type, fields, exact? }` with field binds. |
| `list` | Array product over a repeated element rule (`field` + optional `elemHint`). |
| `leafValue` | Coerce a token lexeme (`fn: 'number' \| 'ident' \| …`). Usually via `leaves`, not RD rules. |
| `custom` | Handwritten builder by name: `{ kind: 'custom', fn, reason, result?, folds? }`. |

### Declared additions (`ADDED_PRIMITIVES`)

| Name | Why |
|---|---|
| `choice` | Heterogeneous RD alternatives — each arm maps a disjoint `altIndices` set to a product. |
| `pratt` | Pratt rules have distinct atom / group / prefix / binary / postfix / … slots. |
| `keep` | Sugar for the default positional node (`{ type, children, headText, … }`). |
| `bindOp` | Not a `kind` — the `'opText'` field bind so dropped operators still expose source text. |
| `parentFold` | Parent `custom.folds: ParentFold[]` accumulates child `__shapePartial` markers into a field. |

### Pratt slots (brief)

```ts
type PrattShape = {
  kind: 'pratt';
  atom?, group?, nudSeq?, nudCapped?,
  prefix?, binary?, postfix?, led?, postfixTok?,
  template?: CustomShape | KeepShape;  // see below
};
```

Unmapped IR brackets default to **keep**. Omitted slots follow the same keep/default
rules as adjudication.

**`template`** — template-literal product (`$templateHead`… or a no-subst Template
leaf). Only `custom` | `keep`. Omitted → the `$template` node is kept. Declared →
kids are head, expr, optional middle/expr pairs, then tail (or `[leaf]` for
no-subst), finished by this slot. Either way each hole is parsed, and its AST
produced, by the rule the template reference declares: the grammar's `expression`
rule, or the rule a `withHoles(token, rule)` reference names.

---

## Custom context (`AstCustomCtx`)

Defined in [`src/shape-machine.ts`](../src/shape-machine.ts). Populated **only after**
the recognizer has successfully finished the current rule / Pratt event:

```ts
type AstCustomCtx = {
  src: string;                  // full source
  kids: readonly unknown[];     // packed kids (lists as arrays; absent opts as null)
  off: number;                  // consumed range start
  end: number;                  // consumed range end
  altPath: readonly number[];   // selected RD/Pratt arm, then nested inline alts (outermost-first)
  opText?: string;              // Pratt LED connector text
  left?: unknown;               // Pratt LED left value
  state?: unknown;              // present only when parent declares folds (fold counters)
};
type AstCustom = (ctx: AstCustomCtx) => unknown;
```

`altPath` in the machine is a richer `AltPath` (RD / inline-alt / pratt-nud /
pratt-led). The emitted TS `parseAst` surface exposes flattened numeric indices
on the ctx object above — enough for arm selection in builders.

Transaction rules for speculative append channels (same module):
`SHAPE_TRANSACTION_CONTRACT` — append-only restore by length; overwrites via undo
log or commit-on-success; Pratt locals commit on success; control flags restore
with the checkpoint.

---

## Fold protocol

A child `custom` that produces a partial returns:

```ts
{ __shapePartial: tag, mode: 'start' | 'append', value }
```

The parent declares how to fold those markers:

```ts
type ParentFold = { tag: string; into: string };
// on CustomShape:
folds?: ParentFold[];
```

At parent finish, `_shapeFoldKids` runs **before** the parent's custom callback:

1. Matching `start` opens an output item (`value` pushed as-is).
2. Matching `append` pushes `value` into that item's `into` array field.
3. Non-partial kids pass through (lists recurse).
4. Fold counters land on `ctx.state` when `folds` is non-empty.

Example pattern (switch cases — see `estreeSwitchCase` /
`Stmt.folds` in the TypeScript shape fixture): case arms `start` a
`SwitchCase`; following statement arms `append` into `consequent`.

No grammar or rule name is embedded in the mechanism — only the declared `tag`.

---

## API

### Emit

```ts
import { emitTs } from './src/target-ts.ts';
import type { ShapeSpec } from './src/shape-schema.ts';

const src = emitTs(grammar, { shape: myShape });
// write src → module that exports tokenize, parse, parseAst, AstRoot, …
```

- No `shape` → same bytes as `emitParser(grammar, tsTarget)` (byte-identity gate).
- With `shape` → base CST parser **plus** AST type decls, `parseAst*`, helpers,
  and `shapeCoverage`.

Validation (`validateShape` / `validateShapeOrThrow`) runs inside `emitTs` before
codegen.

### Parse

```ts
import type { AstCustoms } from './emitted-parser.ts';  // generated

const ast = parseAst(src, { customs?: AstCustoms });
// AstRoot | null  (full consume; pos === toks.length)
```

Register every `custom.fn` name used by the spec. Missing customs throw at the
call site (`shape: custom X not provided`). Specs that need no customs (e.g. calc)
call `parseAst(src)` with an empty map.

---

## Walkthrough: calc

Full declarative coverage lives in [`src/shape-calc.ts`](../src/shape-calc.ts)
(`unmapped: 'error'`). Highlights:

```ts
export const calcShape: ShapeSpec = {
  grammar: 'calc',
  spans: 'optional',
  unmapped: 'error',
  leaves: {
    $punct: { action: 'drop' },
    $keyword: { action: 'drop' },
    Number: { action: 'leafValue', fn: 'number' },
    Ident: { action: 'leafValue', fn: 'ident' },
  },
  rules: {
    Expr: {
      kind: 'pratt',
      atom: { kind: 'keep' },
      group: { kind: 'inline' },
      prefix: {
        kind: 'node', type: 'UnaryExpression',
        fields: [
          { name: 'operator', bind: 'opText', typeHint: 'string' },
          { name: 'argument', bind: { at: 0 }, typeHint: 'Expression' },
        ],
      },
      binary: {
        kind: 'node', type: 'BinaryExpression',
        fields: [
          { name: 'left', bind: { at: 0 }, typeHint: 'Expression' },
          { name: 'operator', bind: 'opText', typeHint: 'string' },
          { name: 'right', bind: { at: 1 }, typeHint: 'Expression' },
        ],
      },
    },
    Stmt: {
      kind: 'choice',
      arms: [
        { name: 'LetStatement', altIndices: [0], shape: { kind: 'node', type: 'LetStatement', /* id, init */ } },
        { name: 'ExpressionStatement', altIndices: [1], shape: { kind: 'node', type: 'ExpressionStatement', /* expression */ } },
      ],
    },
    Program: {
      kind: 'node', type: 'Program',
      fields: [{ name: 'body', bind: { from: 'list', of: 0 }, typeHint: 'Statement' }],
    },
  },
};
```

Emit → load → parse (mirrors the calc shape-codegen section of [`test/shape-parity.ts`](../test/shape-parity.ts)):

```ts
import calcGrammar from './test/fixtures/calc.ts';
import { calcShape } from './src/shape-calc.ts';
import { emitTs } from './src/target-ts.ts';

const code = emitTs(calcGrammar, { shape: calcShape });
// write + dynamic import → { parseAst }

parseAst('let x = 1;');
// { type: 'Program', body: [{ type: 'LetStatement', id: 'x', init: 1 }], off?, end? }

parseAst('1 + 2 * 3;');
// Program → ExpressionStatement → BinaryExpression(+ , BinaryExpression(*, …))
```

No `customs` map — every product is declarative (`node` / `choice` / `pratt` /
`leafValue` / `inline` / `keep`).

---

## Gates

| Gate | Question |
|---|---|
| [`test/shape-parity.ts`](../test/shape-parity.ts) | CST↔`parseAst` accept/reject parity (calc + toy corpora); custom/`parentFold` spots; TypeScript shape coverage + ESTree customs; no-shape byte identity vs `emitParser`; `validateShape` on calc and its negatives; golden `parseAst` ASTs for calc (handwritten expects); perf smoke. |

It runs under `npm run check` (see [`docs/TESTING.md`](TESTING.md)).
