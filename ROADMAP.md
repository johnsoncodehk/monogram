# Monogram — Roadmap

## Current State (v2.5)

**Authoring format**: TypeScript API (`token()`, `rule()`, `defineGrammar()`)

**Grammar concepts**: `token`, `prec`, `rule`, `scopes`
**Annotations**: `@type`, `@skip`, `@scope(...)`, `@escape`, `@regex`, `@embed`
**TypeScript API**: `token()`, `rule($ => [...])`, `defineGrammar()`, `left()`, `right()`, `none()`, `op`, `prefix`, `postfix`, `sep()`, `opt()`, `many()`, `alt()`

**Generator capabilities** (all language-agnostic — gen-tm.ts has zero language-specific strings):
- Token auto-classification (comment / string / number / ident)
- Keyword grouping via `scopes` section (control / storage / operator / constant / etc.)
- Contextual patterns (`'function' Ident` → `entity.name.function`)
- `<`/`>` 5-layer disambiguation (recursive Oniguruma, multi-confirm-token)
- `/` regex literal disambiguation (lookbehind-based, inferred from grammar)
- Type annotation context (`':' Type` → `meta.type.annotation`)
- Declaration body scoping (`meta.function`, `meta.class`, `meta.parameters`)
- Function call detection (`foo(x)` → `entity.name.function`)
- Property access detection (`obj.prop` → `entity.other.property`)
- Arrow parameter detection (`x => ...` → `variable.parameter`)
- String/template begin/end with escape sequences
- Template interpolation (`${expr}` → `meta.embedded.expression` + `$self`)
- Embedded language blocks (`@embed(jsdoc)`)
- Type keyword exclusion for `keyword.control`-scoped dual-use keywords

**TypeScript grammar** (examples/typescript.ts): ~280 lines
- 16 tokens, 17 precedence levels, 23 rules
- 38 syntax constructs covered
- 100% coverage of 3776 TypeScript conformance tests
- 711 tests passing (423 core + 288 regression)

---

## Coverage Assessment (v2.0 vs Official TS Grammar)

### Size comparison

```
                          Official (hand-written)     Ours (generated)     Ratio
File size                      232 KB                    38 KB             6x smaller
Repository keys                   146                       96             66%
Total patterns                    810                      277             34%
Source                         raw JSON               ~280 lines DSL       ~800:1
```

### Quality comparison (15 representative TS snippets, 195 tokens)

| Category | Count | % | Meaning |
|---|---|---|---|
| Exact match | 104 | 53.3% | Identical scopes |
| Missing granularity | 37 | 19.0% | Correct but less specific (`variable.other` vs `variable.other.constant`) |
| Convention difference | 26 | 13.3% | Same semantics, different naming (`punctuation.bracket.round` vs `meta.brace.round`) |
| **Functionally correct** | **167** | **85.6%** | **Highlight looks essentially the same** |
| Wrong scope | 28 | 14.4% | Scope assignment is incorrect |

### The 28 wrong-scope issues

| Issue | Count | Fix approach |
|---|---|---|
| `{}` gets meta scope instead of `punctuation.definition.block` | 10 | gen-tm: add begin/endCaptures to declaration body |
| Template literal `${}` internal scope differences | 5 | gen-tm: refine template interpolation captures |
| `satisfies`/`as` not entering type context properly | 3 | gen-tm: expand type-keyword triggering |
| `extends Base` missing `entity.other.inherited-class` | 1 | gen-tm: detect extends-expression pattern |
| `const fn = () =>` missing function name on `fn` | 1 | gen-tm: detect assignment-to-arrow pattern |
| String quote not tagged as `punctuation.definition` | 2 | gen-tm: add begin/endCaptures to string patterns |
| `import type` keyword scope difference | 1 | scopes section adjustment |
| Conditional type `?` scope | 1 | gen-tm: ternary-in-type detection |
| Other (console, Record after satisfies) | 4 | individual fixes |

---

## Completed Phases (v0 → v2.5)

| Phase | Feature | Status |
|---|---|---|
| 1 | Function call detection | ✅ v0.2 |
| 2 | Keyword scope refinement | ✅ v0.2 |
| 3 | Type annotation context | ✅ v0.3 |
| 4 | Declaration body scoping | ✅ v0.8 |
| 5 | Embedded languages, regex, escapes | ✅ v1.0 |
| 6 | Scope customization (`scopes` section) | ✅ v0.5 |
| 7 | Punctuation & operator sub-classification | ✅ v1.2 |
| 8 | Identifier scoping (this, Promise, string, etc.) | ✅ v1.2 |
| 9 | Property access & decorator | ✅ v1.2 |
| 10 | Numeric literal variants | ✅ v1.2 |
| 11 | Destructuring & arrow parameters | ✅ v2.0 |
| 12 | Remaining long tail (38 constructs) | ✅ v2.0 |
| 13 | Block delimiter captures | ✅ v2.5 |
| 14 | Type-keyword context expansion | ✅ v2.5 |
| 15 | String & template capture refinement | ✅ v2.5 |
| 17 | Scope granularity polish (partial) | ✅ v2.5 |

Additional deliverables:
- TypeScript API (`src/api.ts`)
- CLI support for `.ts` grammar files via dynamic import
- `keyword.control` exclusion from type-keyword triggering (fixes `in` dual-use)
- Type-keyword pattern ordering fix (scope overrides no longer shadow typekw patterns)
- 100% TypeScript conformance test coverage (3776/3776 files)

---

## Phase 13: Block Delimiter Captures ✅

`{` and `}` in declaration bodies get `punctuation.definition.block` via beginCaptures/endCaptures.

**Impact**: 10 of 28 wrong-scope cases fixed.

---

## Phase 14: Type-Keyword Context Expansion ✅

Keywords like `satisfies`, `as` properly enter type scope for the following expression.
Root cause was pattern ordering: `scope-keyword-operator-expression` (a simple match) was consuming
type keywords before the begin/end `-typekw` patterns could fire.

Fix: (1) excluded `scope-` prefix patterns from the `-expression` suffix priority boost;
(2) gave scope overrides with `keyword.operator` scope priority 4 (after typekw at 2, before support at 7.5).

**Impact**: 3 of 28 wrong-scope cases fixed.

---

## Phase 15: String & Template Capture Refinement ✅

String delimiters and template interpolation markers get `punctuation.definition.*` scopes:
- `punctuation.definition.string.begin/end` on string patterns
- `punctuation.definition.string.template.begin/end` on template patterns
- `punctuation.definition.template-expression.begin/end` on template interpolation

**Impact**: 7 of 28 wrong-scope cases fixed.

---

## Phase 16: Inherited Class & Assignment Function Name

**Goal**: Two specific scoping patterns used by official grammars.

### 16a. Inherited class scope

```typescript
class Foo extends Base { }
//                 ^^^^  entity.other.inherited-class (currently variable.other)
```

**Generator logic**: Detect `'extends' ExprRef` in class declaration patterns. The identifier after `extends` gets `entity.other.inherited-class` instead of generic `variable.other`.

### 16b. Assignment function name

```typescript
const fn = async () => { }
//    ^^  entity.name.function (currently variable.other)
```

**Generator logic**: Detect `Ident '=' ... '=>'` or `Ident '=' 'function'` patterns. The assigned identifier gets `entity.name.function`.

**Effort**: Medium. Two new detection passes in gen-tm.ts.

---

## Phase 17: Scope Granularity Polish (partial) ✅

Keyword sub-categories implemented via scopes section:
- `keyword.control.conditional` (if, else, switch, case, default)
- `keyword.control.loop` (for, while, do, in, of)
- `keyword.control.flow` (return, break, continue, await, yield)
- `keyword.control.trycatch` (try, catch, finally, throw)

**Impact**: ~6 of 37 missing-granularity cases fixed.

### Remaining Phase 17 items (future)

| Current scope | Official scope | Count | Approach |
|---|---|---|---|
| `variable.other` | `variable.other.constant` | ~8 | Generator: detect const declarations |
| `variable.other` | `variable.other.object` | ~4 | Generator: detect property access target |
| `storage.type` | `storage.type.ts` suffix | ~5 | Convention difference — may not be worth fixing |
| Other | Various | ~14 | Individual fixes |

---

## Completed Milestones (v2.0 → v2.5)

| Milestone | Phases | Wrong scopes fixed | Tests |
|---|---|---|---|
| **v2.0** ✅ | 1–12 | baseline (28 wrong) | 682 |
| **v2.5** ✅ | + 13, 14, 15, 17-partial | 26 of 28 fixed | 711 |

### Current state: v2.5

```
 DSL source:     ~300 lines  (vs official 232 KB JSON — ~800:1 compression)
 Generator:     ~2500 lines  (language-agnostic, reusable for any language)
 Wrong scopes:      ~2-8     (down from 28)
 Tests:             711      (423 core + 288 regression)
```

### Remaining work (Phase 16 + 17 remainder)

Phase 16 (inherited class + assignment fn name): 2 cases, complex context-sensitive patterns.
Phase 17 remainder (variable.other.constant, etc.): ~31 missing-granularity cases, requires generator heuristics.

The remaining wrong-scope cases are:
- `entity.other.inherited-class` vs `entity.name.type` (1 case)
- `entity.name.function` for assigned arrows (1 case)
- Template literal internal scope differences (~5 cases, partial overlap with fixed cases)
- Conditional type `?` scope (1 case)

Beyond these, the remaining ~1% is inherently beyond TextMate grammar capability — import resolution, type inference, overloaded function detection — and requires LSP semantic tokens regardless of grammar complexity.
