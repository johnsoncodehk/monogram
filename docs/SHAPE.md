# Shape mapping — declarative AST on top of the CST

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
| `rules` | Map rule name → product shape. Exact IR names override inherited `cstName` mappings. |

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
leaf). Only `custom` | `keep`. Omitted → legacy `$template` keep with portable
`interpRule` holes (CST-parity accept set). Declared → kids are head, expr,
optional middle/expr pairs, then tail (or `[leaf]` for no-subst), finished by this
slot; hole *accept* still uses portable `interpRule`, hole *AST* uses the
enclosing Pratt.

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

Emit → load → parse (mirrors [`test/shape-codegen.ts`](../test/shape-codegen.ts)):

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
| [`test/shape-codegen.ts`](../test/shape-codegen.ts) | `validateShape` on calc; no-shape byte identity vs `emitParser`; golden `parseAst` ASTs for calc (handwritten expects); perf smoke. |
| [`test/shape-parity.ts`](../test/shape-parity.ts) | CST↔`parseAst` accept/reject parity (calc + toy corpora); custom/`parentFold` spots; TypeScript shape coverage + ESTree customs. |

Both run under `npm run check` (see [`docs/TESTING.md`](TESTING.md)).
