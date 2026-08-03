# Typed Direct-Emit Backend (SH3-6)

Endgame architecture for the Rust shape-AST path: replace the interpreted
`AstValue` runtime with typed, arena-allocated direct construction — the oxc
playbook adapted to a generated parser. Target: **ast/cst ≤ 1.3x, stretch <1x**
on the 2MB TypeScript bench with byte-identical JSON output (the existing
`test/shape-rust.ts` 32-check gate is the acceptance harness).

## Why (measured)

Baseline `9e998a4`: ast/cst **5.9x** (ast ≈ 178ms, cst ≈ 30ms, 2MB).
Decomposition (instrumented, 2MB):

- walk ≈ 78ms — shape-machinery tax on top of the same 4.4M checkpoint/restore
  cycle the 30ms CST walk performs (suppress Rc scans, alt_path tracking,
  head_text scans, per-step okVar ladder).
- construction ≈ 100ms — `AstValue` interpretation: ~4.5M mallocs / 617MB
  churn (per-node Vec, heap String leaves, string-keyed fields), deep drop
  glue on 760k discarded kids, customs building ESTree on dynamic values.

Rejected alternatives (measured): probe-first speculation (17.3x — double-walk
tax on successful branches), checkpoint micro-tuning alone (7.4x → 5.9x).
The `AstValue` runtime model is the wall: allocation and cloning are its
semantics, not an implementation accident. CST mode already proves the same
grammar DSL compiles to oxc-throughput Rust — the shape side must follow.

## Design

### Value model: `SVal` (Copy) + flat arenas

```rust
#[derive(Clone, Copy)]
pub enum SVal {
    Null,
    Bool(bool),
    Number(f64),
    Str(&'a str),        // borrowed from src: leaves, opText
    OwnStr(u32),         // index into strings slab (unescaped/reformatted only)
    Node(u32),           // index into nodes arena
    List(u32, u32),      // (start, len) into vals slab
    Partial(u32),        // index into partials slab (parentFold protocol)
}
```

- `nodes: Vec<DynObj>` where `DynObj { typ: &'static str, fields: (u32, u32) }`
  (range into `fields: Vec<(&'static str, SVal)>`). v1 keeps objects dynamic
  (bridge); typed per-rule product structs land as generated enum variants in
  later milestones (ShapeIR already knows the layouts — calc's
  `pub struct Program` is the proof of concept).
- Every variant is `Copy` ⇒ speculative `truncate` on restore runs **no drop
  glue**; the 760k-kid deep drops and 617MB churn disappear.
- `ShapeCk` gains slab watermarks (vals/fields/nodes/strings/partials lens) —
  still a plain Copy struct of usizes; restore = O(1) truncates.

### Customs interface (breaking change, mechanical rewrite)

```rust
pub struct AstCustomCtx<'a> {
    pub name: &'static str, pub rule: &'static str, pub src: &'a str,
    pub kids: &'a [SVal],          // was Vec<AstValue> (owned)
    pub alt_path: &'a [usize],     // was Vec<usize> (owned)
    pub off: usize, pub end: usize,
    pub left: Option<SVal>, pub op_text: Option<&'a str>,
    pub state: Option<Vec<(&'static str, AstFoldCounts)>>,
}
trait ShapeCustoms { fn ast_custom(&self, ctx, arena: &mut AstArena) -> SVal; }
```

The 20 hand-written estree handlers (`test/fixtures/shape-typescript-rust-customs.rs`,
1003 lines) use ~15 helper patterns (ts_obj / take_kid / take_field / flat_take
/ span_str / shape_partial / unhandled). Rewrite is a mechanical pass over
those helpers; `take_kid` by-value-extraction becomes `kids.get(i).copied()`
(SVal is Copy — round-2's de-clone hacks become obsolete).

### DSL lowering

| DSL op | v1 (SVal) | later (typed) |
|---|---|---|
| leaf | `SVal::Str(&src[off..end])` | same |
| rule result | `SVal::Node` / positional slot | typed `NodeId` |
| opt/star/sep | `SVal::List` arena range | same |
| altPath dispatch | `&[usize]` slice (unchanged) | per-arm monomorphized constant |
| node finish | `DynObj` arena push | typed struct literal |
| customs | SVal + arena (above) | typed kids bindings per arm |
| fold | partials slab, same protocol | generated accumulation |
| JSON out | generated walker over SVal+arena | per-type writers |

### Walk-layer follow-ups (M3)

suppress → u64 bitmask; kill altVar machinery once altPath is static;
pooled scratch vecs; `ledNotLeftLeaf` head_text cached at construction.

## Milestones (each gate-verified, bench-measured)

- **M1 — SVal arena runtime** (this doc's v1): swap `AstValue` → `SVal`+arenas
  across the emit path + customs rewrite. Construction 100ms → ~25ms.
  Expect ≈ 3.5x.
  **Status (done)**: emitter fully converted — SVal + 6-slab arena
  (vals/lists/fields/nodes/partials/strings), checkpoint watermarks,
  steps emitter on the global vals stack (per-construct vecs → base
  watermarks, zero scratch Vecs), all RD/pratt finishes arena-direct,
  leaves borrowed (`SVal::Str`), `AstCustomCtx` borrows kids/alt_path and
  injects `&mut AstArena`; TS customs (23 estree handlers) rewritten to
  the SVal API. Bench **2.73x** (32/32). Follow-ups landed: ap_stack
  zero-alloc alt_path (2.61x), slab/toks reserves + suppress fast path +
  inline restore + predictive rule-alt match dispatch (2.12x), suppress
  as promoted `&'static [u16]` slices (2.08x). Alloc count on the bench:
  4.5M/617MB → 663k/242MB.
- **M2 — per-arm customs monomorphization + typed rule products**: static
  altPath, typed kids bindings, typed structs for node/keep/choice products.
  Expect ≈ 2x.
- **M3 — walk cleanups** (bitmask suppress, scratch pools, altVar removal).
  Expect ≈ 1.3–1.5x.
- **M4 — shape-inherent wins**: dropped leaves never walked, suppressed
  connectors free, CST-pruned subtrees skipped → stretch goal <1x.

## M2 typed direct-emit — substrate (LANDED, milestone 1)

Typed custom nodes now have a generic path that keeps the emitter
grammar-agnostic:

- `SVal::TNode(tag: u16, idx: u32)` — a Copy reference into a **customs-owned**
  typed arena (the emitter knows nothing about ESTree; arbitrary grammars'
  customs own their node types).
- `pub trait ShapeCustoms<'a>` (lifetime moved from method to trait so typed
  arenas can store `SVal<'a>`) gains:
  `write_tnode_json(&self, ar: &AstArena<'a>, tag, idx, out)` — the JSON hook;
  default panics, customs that produce TNodes must implement it.
  `write_sval_json` delegates `TNode` to the hook; `AstRoot::to_shape_json_with`
  takes customs.
- Milestone 1 (proven, gate 32/32, bench-neutral): `TBinExpr` typed arena in
  `TsEstreeCustoms(RefCell<…>)`, BinaryExpression constructed as a plain
  struct (`{ left, operator, right }`) — no DynObj, no field keys, JSON
  byte-identical to the old ts_obj output.
- Field-order fidelity rule for bulk conversion: writers must reproduce the
  exact per-site field order/presence (e.g. Property has two construction
  orders; estree_optional_chain emits a duplicate `"optional"` key on purpose —
  both must stay byte-identical).

Next: bulk conversion of the remaining ~73 types per the proven pattern
(Identifier/ExpressionStatement/CallExpression/MemberExpression in flight).

Known follow-up: typed-arena entries created on FAILED speculative branches
are not checkpoint-reclaimed (the arena is customs-owned, ShapeCk can't see
it) — append-only leak of ~MB scale on the 2MB bench, correctness-safe.
Fix options later: `tnode_ck/tnode_restore` hook pair on the trait (careful:
ck is on the 4.4M-pair hot path — must stay allocation-free), or move typed
storage into a type-erased slab inside AstArena so ck watermarks cover it.

M1/M2a/M3 landed ast/cst **2.1x** (62ms vs CST 29ms). Remaining construction
traffic is dominated by DynObj dynamics: ~570k nodes / 1.37M fields on 2MB
(≈42MB slab writes), string-keyed field pushes, `obj_field` linear scans,
customs temp Vecs. Typed *rule* products would only cover keep/node
intermediates — the majority of nodes are **customs outputs (ESTree)**, so the
real M2 is typing the ESTree product set:

- Declare the ~60 ESTree node types the customs emit (fixed schemas: type tag
  enum + per-type struct fields, `SVal` for child refs, `&'a str` atoms).
  (Inventoried from the customs file: **74 distinct typ literals** — see
  `grep -oE '(ts_obj|mk_obj)\(ar, "[A-Za-z]+"'` on the customs source.)

### Progress log (2MB bench, ast/cst)

- 7.43x baseline → 5.92x (Phase 1+3: undo-log ck, FIRST-guards)
- 2.73x (M1: SVal Copy values + 6-slab arena, global vals stack, borrowed
  leaves; 23 estree handlers rewritten)
- 2.61x (M2a: alt_path on a global stack — `alt_path[1]` IS load-bearing
  (estreeClassMember nested branch); naive static altPath breaks it)
- 2.08x (slab/toks reserves, suppress fast path, predictive rule-alt match
  dispatch, suppress as promoted `&'static [u16]` slices)
- 1.77x (customs temp-Vec series: flat_list direct-writes, alloc-free
  expr_led/arrow/paren_or_comma, tpl_raw slicer, optional_chain/strip_asi)
- 1.52x (**fold fast path**: `shape_fold_kids` allocated 2-3 Vecs per
  fold-capable customs call, and estreeStmt is fold-capable — that was ~94%
  of ALL allocations (663k → 19k). Cow-borrowed kids when no Partial present)
- 1.51x (alloc cleanup + toks reserve, fn_id integer customs dispatch,
  ts_obj const-generic field arrays; u32-packed ShapeCk measured a 5%
  regression and was reverted — checkpoint writes are NOT the bottleneck)
- 1.49x (**ctx by reference**: `AstCustomCtx` was 170B and got MOVED into
  every customs handler (327k calls × 170B ≈ 55MB of copies per parse).
  Split `arena` out of the ctx, pass `&AstCustomCtx` + `&mut AstArena`;
  also fn_id integer customs dispatch + ts_obj const-generic field arrays)
- 1.45x (**M2 typed direct-emit essentially complete** — 75 ESTree node
  types, all customs-constructed types now plain structs in a customs-owned
  typed arena with hand-written per-type JSON writers (`write_tnode_json`),
  zero byte-diffs against the SH3-5 golden binary across 17+31+13+15+10+15+9
  targeted sets + the full gate. BinaryExpression, Identifier,
  ExpressionStatement, CallExpression, MemberExpression, VariableDeclaration,
  VariableDeclarator (Binding/ForBinding re-routed via a new
  `estreeVariableDeclarator` custom — the shape-spec route for emitter-side
  `node` products), BlockStatement, Property (dual field-order hint),
  FunctionDeclaration, ArrowFunctionExpression, TemplateLiteral/Element, 22
  statement-family, 15 module/class-family, 25 TS-family nodes typed.
  SwitchCase then landed via `tnode_fold_append` (fold protocol's typed
  delegation: `shape_fold_list` append arm on `SVal::TNode` calls
  `customs.tnode_fold_append`, consequent tail-extends in shared `ar.lists`;
  `customs: &C` threaded through shape_fold_kids/list). The 1.5664x gate
  reading after that change was A/B-tested against a no-threading variant
  (same binary minus the `customs` param and TNode arm): identical within
  noise (44.2 vs 44.4ms median, interleaved) — threading is free, the delta
  was machine drift. Left on DynObj by design: the `{"raw":X}`/`{"op":X}`
  empty-typ inner objects. leaf_number integer digit-loop fast path
  replacing f64::from_str)
- **M8: vals stack moved out of AstArena onto ShapeParser** — customs now
  borrow `&self.vals[_sk_base..]` as ctx.kids while `&mut self.arena` is
  passed (disjoint field borrows), deleting the kids_scratch drain-copy per
  call (≈327k × ~3 SVals ≈ 25MB memcpy, extend_trusted was 8.5% self-time).
  `rustAstCustomCall` wraps `&self.vals[..]`-sourced calls with a
  truncate-after to restore the drain's cleanup semantics — the Pratt
  led/nud/group/nudCapped finishes have no truncate of their own, and without
  it stale kids polluted every later pack (gate caught it: 347/500 iso
  divergences; fixed centrally, not at 4 call sites).
- **M10: ShapeCustoms::reserve(n) hook** — parse_ast_with calls it with the
  token count; TsEstreeCustoms pre-sizes the 12 hottest typed Vecs
  (idents n/6, member/call/expr_stmt n/24, …). A fresh customs per parse
  was realloc-growing all ~100 typed arenas from zero (realloc/finish_grow
  ≈ 0.3-0.5ms + memmove). ast 41.0 → 39.7ms.
- **Sampled cst-vs-ast profile diff** (macOS `sample`, 12s loops, self-time):
  ast-specific deltas ≈ ast_custom +5.4ms (includes DecoratorExpr/Binding
  work moved into customs ≈ 2.7ms, net ≈ +2.7ms), extend_trusted +3.5ms
  (killed by M8), **parse_ast_Decl +5.8ms self-time vs parse_Decl — biggest
  single remaining mystery**, fold+head_text +0.6ms, ClassMember/Block/Stmt
  ≈ +1.7ms; cst-side DecoratorExpr/Binding/Expr-family self-time moved into
  customs, not eliminated. Lexer identical (≈5.2-5.6ms both) — sanity anchor.
- **Measured-and-rejected**: probe-first speculation (17x — double-walk tax),
  u32-packed ShapeCk (−5%), partial-predictive alt dispatch (M6: or-pattern
  chains don't jump-table — a wash-to-loss vs cheap sequential FIRST guards;
  reverted, note left in tryAlts), **M9 slim checkpoint (static dirty-set
  1-2 word saves for pure-token probes, 42% of ck sites): a wash
  (1.4180 vs 1.4072x, noise) — shape_ck is #[inline(always)] so the full
  10-word save already compiles to plain L1 load/stores; reverted to keep
  the emitter simple**, **M11 trait associated-type Tn (parser-owned typed
  arena replacing RefCell): measured −0.7ms (gate 1.3961 vs 1.3629x,
  in-process A/B 36.5 vs 35.8ms) — the RefCell win showed in ast_custom
  self-time (−66 samples) but was swamped by optimizer inlining
  perturbation; reverted. RefCell borrow stays**. The walk is near its
  structural optimum
  for this codegen shape; remaining levers are unsafe token access (needs
  product sign-off), full string interning for SVal 24B→16B, table-driven
  dispatch, or the M2-full typed outputs above.

Allocation count on the bench: 4.5M/617MB → **19.3k/199MB** (mostly reserves).
Latest self-time profile (frame-pointers, user frames): parse methods ≈ 55%
(Decl 13 / Stmt 9 / Expr×3 18 / Type 4 / ClassMember/Binding/Param 5),
lex_from 11%, `extend_trusted` 10%, customs dispatch 8.4%, memmove 3.4%,
malloc <1%. Allocation is solved; the wall is the generated walk itself.
- `nodes: Vec<EstreeNode>` (enum per type, ~16-24B inline) — no fields slab,
  no string keys; field access = direct struct read.
- Rewrite the 20 estree handlers to construct typed nodes (`mk_call_expr(...)`
  style builders over `&mut AstArena`); JSON writers generated per type,
  byte-identical output remains the gate.
- Folds/partials get typed accumulation sites (same protocol, typed slots).

Projected: construction ~40ms → ~10ms ⇒ total ≈ 35ms ≈ 1.2x; with walk-side
trims (M3: pratt call-chain fusion, ck slimming) ⇒ ≈ 1x territory. This is a
multi-day rewrite of `shape-typescript-rust-customs.rs` + a new typed-node
emitter; the SVal/arena substrate it plugs into is already in place.

## Risks / open questions

- Fold protocol (`Partial` append-into-parent-slot) needs the same semantics
  on slabs — appends land at the slab tail, parent slot rewrite by index.
- `strings` slab holds genuinely-owned Strings (unescape/reformat); keep rare.
- Gate's fail-loud contract (`altPath=[99]` panics) must keep firing —
  `unhandled()` keeps the same message format.
- Arena realloc: reserve slabs from token count (nodes ≈ toks/2, vals ≈ toks).
- Debuggability: JSON differential harness already exists
  (`/tmp/shape-rust-gate/dbg-iso.ts` pattern, 0/1403 baseline).

## Verification

- `node --experimental-strip-types test/shape-rust.ts` — 32/32 required.
- Bench line: `typescript 2MB cst/ast paired timing … median_ast/cst`.
- Any divergence in the 2000-case corpus / 500-case iso / 35 golden is a
  blocker; zero tolerated.

## Endgame: construction representation (post-M12 re-assessment)

Status after M12/M12b (2026-08-02): **1.31x** (gate 32/32). A stub-handler
experiment (all 23 customs return `SVal::Null`, timing-only build) plus
arena statistics re-anchored where the residual gap actually lives.
Per 2MB parse (500-iter in-process loops, totals ÷500):

- lex-only ≈ 7.8ms; stub-ast (lex + full RD walk + entire vals/pack/list
  protocol, no node construction) ≈ 8.4ms — **the walk + protocol costs
  ~0.6ms and is NOT the gap**. parse_ast_Decl is 222KB vs parse_Decl 45KB,
  but sample self-time attribution was misleading: the walk inherits the
  memory stalls *caused by* construction traffic.
- full-cst ≈ 32ms → CST construction ≈ 24ms; full-ast ≈ 39ms → AST
  construction ≈ 29ms. **The gap is construction representation.**

Footprint per 2MB parse (stats mode, n=865,440 toks):

| slab | entries | bytes |
|---|---|---|
| CST nodes+kids | 519,265 + 951,984 | 20.4MB |
| AST lists | 557,728 × 24B | 13.4MB |
| AST fields | 413,491 × 40B | 16.5MB |
| AST DynObj nodes | 173,089 × 24B | 4.2MB |
| AST tnodes (74 vecs) | 394,256 | 23.5MB |
| **AST total** | ~1.4M objects | **57.5MB (2.8x CST)** |

Cost model: ~1.4M writes + ~1M random reads against a 57MB working set
(≫ L2) is latency-bound at ~12ns/object — slabs are fully reserved
(M3/M10), so realloc churn is already dead; raw write bandwidth is cheap
(stub writes 13.4MB of lists for +0.6ms). Access count × miss latency is
the currency; byte volume is the lever (line-packing + total footprint).

DynObj breakdown (mk_obj_raw counts): **Type wrapper 67,312**,
BlockStatement fallback 28,848, empty-typ objects 28,848, Identifier
fallback 19,232, TSTypeParameter(+Declaration) 19,232, MemberName 9,616,
Program 1. Node totals: 394k typed + 173k DynObj = **567k vs CST 519k**
(the "AST is smaller" assumption only holds per-kind — wrappers inflate
AST node count above CST).

Milestones, in order:

- **M14 (landed, 32/32, gate 1.2181 / in-process 1.211): eliminate
  remaining DynObj kinds.** New ShapeCustoms hooks: `keep_node` (keep
  wrapper finish, typed TTypeKeep for "Type"), `finish_obj` (declarative
  node() finish, fields read back + truncated, typed BlockStatement-sp /
  MemberName / TSTypeParameter / TSTypeParameterDeclaration),
  `tnode_head_text` (mirrors the DynObj "headText" read in
  shape_head_text). Customs-side TRawVal/TMetaOp kill the empty-typ
  wrappers. Arena per 2MB: fields 413,491→57,699 (16.5→2.3MB), DynObj
  173,089→19,233 (4.2→0.46MB), tnodes 394k→548k (23.5→30.3MB); total
  57.5→46.5MB (−19%). Remaining DynObj: Identifier fallback 19,232
  (estree_param field-copy arm) + Program 1. Traps hit: (1) TN tag
  collision 75 (TN_TYPEKEEP vs TN_VARDECLARATOR) made the JSON writer
  recurse infinitely — renumber to a free tag, check with
  `grep -oE "const TN_[A-Z]+: u16 = [0-9]+" | sort | uniq -d`;
  (2) behavior readers keyed on DynObj typ/tags must be extended for the
  new tags (is_block_stmt +TN_BLOCKSTMT_SP — 49/500 iso divergences
  caught it: ArrowFunctionExpression.expression flipped).
- **M15 (landed, 32/32, corpus 0/500, in-process ~1.16): slim SVal 24B →
  16B.** `Str(&'a str)` → `Str(off:u32, len:u32)` span into `AstArena.src`;
  hidden `_Marker(PhantomData<&'a ()>)` ZST variant keeps the lifetime
  parameter (~100 struct signatures untouched). Max payload drops to
  f64/List (8B) → 16B enum (verified `size_of::<SVal>() == 16`). The
  planned `SStr` static-table variant turned out unneeded: literals use the
  existing OwnStr slab instead — the emitter prefills choice keep-arm
  names once per parse (`pub const SHAPE_STATIC_STRS`, TS=3), and the new
  `ShapeCustoms::prime` hook prefills customs literals right after (TS: 12
  strings, `S_*` consts = SHAPE_STATIC_STRS + i). lit/altlit/tok leaves
  construct spans straight from the consumed token (`take_span` /
  `current_span`); `leaf_number` keeps its customs hook (TS overrides it),
  `leaf_ident`/`bind_op` call sites are deleted from codegen (identity in
  every shipped customs — the trait hooks stay for API compat; the gate's
  source-presence assertion updated accordingly). Customs-side: op/kind
  &str params originating from src bridge via `sval_str` (pointer
  subtraction + debug_assert); `SVal::Str("")` → `SVal::Str(0,0)` — an
  OwnStr("") would flip shape_head_text's empty-Str fallthrough, so ""
  stays a span. Footprint per 2MB (stats, size_of-honest): lists
  13.4→8.9MB, fields 2.3→1.8MB, tnodes 30.3→20.8MB, DynObj 0.46MB →
  **total 46.5→32.0MB (−31%; 1.57x CST)**. In-process A/B (5 interleaved
  rounds, load ~17): ast 18.18s vs pre-M15 18.72s, cst 15.69s → ratio
  ~1.16 (M14 measured 1.211 at load ~6; treat cross-load comparisons as
  indicative only). The gain is modest relative to −31% bytes —
  construction is latency-bound and instruction count is unchanged.
- **M16 (landed, 32/32, corpus 0/500, in-process ~1.21): type the last
  DynObj source — estree_param's Identifier fallback.** Sole change:
  test/fixtures/shape-typescript-rust-customs.rs. New typed node
  `TParamIdent { name, type_annotation: Option, decorators, optional }`
  (tag TN_PARAMIDENT = 84) with a `param_idents` Vec in AstArena (reserve
  n/90) and a `write_tnode_json` arm in field order type, name,
  [typeAnnotation], decorators, optional. estree_param's Some(1)|Some(2)
  arms — four total — are typed; the Node arm converts only when
  typ=="Identifier" && fields ⊆ {name, typeAnnotation}, otherwise it
  keeps the DynObj fallback (the arm also receives other shapes —
  byte-identical output is the guard). qcheck compiles with only the
  expected E0601 (no main). Footprint per 2MB (size-of-honest): lists
  557,728 → 8.92MB; tnodes 567,344 → 21.85MB; DynObj fields 3 → 96B,
  DynObj nodes 1 → 24B — **Program is the only DynObj node left**; total
  32.0→30.77MB (1.51x CST, vs CST 20.4MB).

  **Anomaly: bytes −34%, time flat (M15+M16).** 46.5→30.77MB (−15.7MB,
  −34%) but parse time did not move. Cross-load in-process readings:
  M14@load6 ast 18.53 / cst 15.31 = 1.211; M15@load17 18.18 / 15.69 =
  1.159; M16@load4 17.32 / 14.37 = 1.205. Same-load head-to-head
  (interleaved): M16 17.10 vs M14 16.87 — M14 measured 1.4% faster,
  inside noise. The ratio sat at ~1.19–1.21 throughout while cst itself
  swings ±8% with machine load. Decision: keep, do not revert — per the
  M12 precedent, time-neutral with memory −34% is a real, banked win and
  paves the way for later cache optimizations; the residual time gap's
  phase decomposition resolves below.

  **Phase decomposition (sample-based, M16).** macOS `sample` on the
  prof-loop binary's loop-ast (500× parse_ast_with, no JSON
  serialization; 2,522 top-of-stack samples, self-time attribution),
  A/B'd at 500 interleaved iters via `/usr/bin/time -p`. Phases (share →
  ms/iter, total ≈ 35.2ms): walk (parse_ast_* self-time) 56.0% ≈
  19.7ms; lex 15.4% ≈ 5.4ms; construction
  (estree_*/finish_obj/leaf_number) 9.7% ≈ 3.4ms; arena writes
  (Vec::extend) 9.2% ≈ 3.2ms; misc 7.2% ≈ 2.5ms; memmove 1.7%;
  alloc/free 0.8%.

  **M13 stub experiment falsified**: prof-stub's customs all return a
  constant SVal::Null and LLVM DCE'd the walker logic — "stub ≈ lex"
  was an artifact, so the "walk+protocol <1ms" conclusion is void; the
  residual gap's bulk is the walk (~20ms), not construction.
  **Bounds-check hypothesis falsified**: all 74 slice read sites
  (str_span/str_of/leaf_number/take_span, …) switched to get_unchecked
  in a prof-nobounds variant — batch output byte-identical, loop-ast
  zero gain (Δ+1.7%, slower); bounds-check paths were 0.24% self-time
  in the original profile. **Footprint is not the bottleneck**: a
  prof-rsv2x variant (all arena reserves ×2, zero realloc, larger
  footprint) was a no-op (Δ+0.5%).

  **M15/M16 did pay off**: prof-old vs prof-loop loop-ast A/B = −2.1%
  (4/5 rounds faster), matching theory (write-path extend+memmove
  ~3.8ms × 34% ≈ 1.3ms ≈ 3.6%); the loop-cst null control (Δ−0.5%)
  confirms the methodology. The expected gain was ~3% all along, buried
  under ±8% noise and the 35ms denominator.

  **Next lever: the walk** (56%, ~20ms) is the home run — generated
  file 6.5MB, one giant function, ~130 cycles/token match cost.
  Directions: cut walker backup/backtracking (shape_restore / pos=sp
  pattern), shared prefix matching, hot/cold function splitting. Halving
  the walk ≈ −10ms (≈ −28% of total) → ast could land below cst (25 vs
  29.3ms, ratio <1.0). lex (15%, 5.4ms) is secondary; construction +
  extend (~19%, 6.6ms) is the only memory-side space left after
  M15/M16.
- **M17 (landed, 32/32, corpus 0/500 + 0/2000 byte-identical, wall-clock
  ~0%): batch-reserve all customs typed Vecs.** Sole change: the
  `reserve(n)` fn in test/fixtures/shape-typescript-rust-customs.rs —
  the M10-era version covered only 20 Vecs with several divisors over-
  or under-shot; M17 makes all 83 typed Vecs an explicit decision: 29
  sized from measured 2MB-corpus counts (865,440 tokens: idents
  n/10=86,544, type_keeps n/13=66,572 deliberately low,
  var_declarators n/22, call_exprs/expr_stmts/var_decls/block_stmt_sps
  n/30, seq_exprs/return_stmts/template_els/raw_vals/param_idents n/45,
  the rest on the 9,616 tier at n/90), and 54 with measured count=0
  explicitly skipped (Vec::new — no allocation, zero waste on small
  inputs). **Premise correction**: alloc's 9.2% was NOT one realloc
  storm — after re-aggregating the samples the largest item is
  `Vec::extend_trusted` 4.5% (the rule-finish
  `arena.lists.extend(vals.drain(..))` SVal bulk copy; the arena is
  already reserved, so reserve() cannot touch it); the real realloc
  chain (finish_grow) is only ~1.3% (≈0.4ms/iter). Verification: qcheck
  leaves only the expected E0601; gate 32/32; diff 0/500 (iso) plus the
  full corpus 0/2000 byte-identical — hard proof for a pure-perf change.
  Mechanism check (sample deltas): alloc_gross 9.81%→6.53%, finish_grow
  1.29%→0.69%; the residual finish_grow is all the type_keeps n/13
  deliberate under-reserve (one amortized grow per parse). Wall clock:
  13-round interleaved A/B mean +0.002s/500iter ≈ 0% (the loop-cst null
  control itself drifts 1.2%; the 0.4ms real realloc chain sits below
  the noise floor). Conclusion: the realloc storm is substantively
  eliminated but wall-clock neutral — kept per the M12/M15 precedent
  (allocation behavior corrected, zero cost). **New lever surfaced**:
  `extend_trusted` 3.8–4.5% (~1.4–1.6ms) is the SVal staging layer (the
  vals → arena.lists bulk copy) — the next alloc-side candidate; R2
  (txn-snapshot slimming, 5,129 shape_ck/shape_restore sites, est
  −1.5–4ms) still goes first per plan.
- **M18 (landed, 32/32, corpus 0/500, loop-ast −1~−2ms/iter): light txn
  snapshots via static purity analysis (generator-side).** Sole change:
  src/target-rust.ts — a new `pure(s: Step)` helper plus `txnCk`/
  `txnRestore` emit helpers; all 6 shape_ck emission sites become
  purity-gated (top-level txn, not probe, alt branch, star, opt, sep).
  pratt (emitRustPrattMethod) was grep-verified to have zero shape_ck
  sites and is untouched, as is the shell (emitRustRdMethod/tryAlt).
  Purity rules: lit/tok/altlit/sameLine/not → pure; seq/suppress → pure
  iff every child is; star/opt/sep/alt → additionally require !visible
  (visible success paths write the arena via shape_pack_range/
  shape_list_from); rule/ruleBp → never pure. Static degradation:
  5,128 sites → 2,176 light (42.4%) / 2,952 keep full — top-level
  188/865, not 632/644, alt-branch 796/1734, star 72/301, opt 488/1180,
  sep 0/404 (TS's sep elems are all rule). A light snapshot is 3 fields
  `(self.pos, self.vals.len(), self.ap_stack.len())`; restore = pos
  rollback + vals.truncate + ap_stack.truncate. **Two iterations
  (lesson)**: round 1 with 2 fields {pos, vals_len} went red (gate
  30/32, diff 35/500) — the alt-branch txn guard scope has
  `ap_stack.push(i)` after the ck, so a failed pure branch left a stale
  alt-path entry and estreeClassMember's `alt_path.get(1)` read the
  wrong arm (ClassBody method divergence). Fix (Option A): light
  snapshot widened to 3 fields incl. ap_len, and both pollution paths
  sealed (alt-branch, and pure-alt inside not-probe). Design invariant:
  a pure txn's mutation set is {pos, vals, ap_stack} — 3-field rollback
  is sound. Acceptance: qcheck only E0601; gate 32/32; diff 0/500 (all
  35 ClassBody divergences gone). A/B (prof-m17 vs prof-m18,
  interleaved, 500 iter): all-5-rounds mean −4.91% (−1.77ms/iter);
  control-stable rounds (r1/r3/r5) −2.73% (−0.97ms); strictly clean
  rounds (r3/r5) −6.32% (−2.24ms); loop-cst null control reversed
  +1.01%. Honest read: positive, ~−1~−2ms/iter, at the low end of the
  −1.5~4ms expectation; 3/3 control-stable rounds negative with a flat
  control support a real effect, but the magnitude needs more rounds to
  be firm. Incidental fix: the baseline tsc error at
  src/target-rust.ts:3912 (pratt NUD custom-atom dead path's
  rustShapeLeafAstExpr missed the len param — an M15 signature-change
  leftover) is now `'t.off', 't.end - t.off'`, consistent with
  neighboring sites; tsc --noEmit exits 0 and q-ts.rs md5 is identical
  (dead path, no emit change).
- **M19 (landed, 32/32, corpus 0/500, perf wash — kept as zero-risk
  structural): pratt atom-chain merge (R3).** Sole change:
  src/target-rust.ts (emitRustPrattMethod's atom else branch): the 10
  consecutive `if self.peek_kid() == Some(N)` guards — each peek_kid is a
  bounds-checked `toks.get(self.pos)` re-reading the same token, and on a
  hit take_span reads it a second time — collapse into a single
  `toks.get(self.pos).copied()` + `matches!(t.kid, 11|12|13|14|16|7|8|9|10)`
  one-shot dispatch, with the `match t.kid` arms using `t.off`/`t.end -
  t.off` directly. Generated code: whole-file peek_kid count 97→17.
  Semantic-equivalence argument: when peek_kid==Some(N) already holds,
  take_span(N) can never fail — (_o,_l) = (t.off, t.end−t.off) and
  pos+=1 — byte-equivalent to the old writeup; hard proof: diff 0/500,
  gate 32/32, 500-sample iso 0 divergences, 2000-case 0 shapeDiv.
  Honest perf read: **wash**. nud_rest self-time 1.65ms ≈ 4.7% is the
  theoretical ceiling, but the measurement window ran loadavg 2.5~8.6,
  the null control drifted +4.50%/+1.69%, and the two A/B runs disagreed
  (RUN1 stable rounds −2%, RUN2 ≈0%) — the ceiling is smaller than the
  environmental noise, so it is unmeasurable. Keep decision (per the
  M12/M15/M17 precedent): the structural improvement is zero-risk
  (removes 9 repeated bounds-checked reads + a second take_span), even
  wall-clock neutral. Lesson recorded: milestones with ~4% ceilings
  cannot be A/B-accepted for perf under this machine's noise floor
  (±4%+); only correctness + mechanism (sample/static structure) are
  acceptable, and future small-ceiling milestones must attach a sample
  comparison.
- **M20 (landed, 32/32, corpus 0/500, extend_trusted 7.18%→0.00%,
  median −0.95ms/iter): arena lists memcpy fast path.** Sole change: the
  runtime prelude template in src/target-rust.ts, 3 sites, no unsafe:
  `shape_pack_range` switches `arena.lists.extend(vals.drain(base..))`
  to `extend_from_slice(&vals[base..])` + `vals.truncate(base)` (the
  existing n==0/1 fast paths stay); `shape_list_from` gains an n==0 fast
  path (direct `SVal::List(0,0)` — the canon empty list, no slab touch)
  and an n==1 fast path (single push), with the main path on
  extend_from_slice + truncate too; `shape_fold_list` switches
  `ar.lists.extend(folded)` to `extend_from_slice(&folded)`. Mechanism:
  SVal is Copy, so `extend_from_slice` hits the memcpy specialization
  (ptr::copy_nonoverlapping) and the drain iterator overhead disappears.
  Sample contrast: extend_trusted 183/2547 = 7.18% (M18) → 0/2526 =
  0.00% (M20); shape_list_from's cost now shows as its own symbol
  (aggregate self 104 — an M21 candidate observation). Semantic
  equivalence: List(0,0) is already the generated code's canon empty
  list (finishEmpty/takeKid both emit it) and no consumer derefs an
  empty list's start; hard proof gate 32/32, corpus diff 0/500, and the
  prof-m19↔prof-m20 pre-main unified diff contains exactly these 3
  hunks (zero template drift — the A/B is fully isolated). A/B
  (load-gated <3.0, 8 interleaved rounds): median −0.95ms/iter
  (−2.8%), 7/8 rounds m20 ≤ m19; null control median ≈ 0 (4/8 rounds
  drifted >2% — background load). Honest note: single-round resolution
  is ~±0.5s and the median effect (−0.48s) is slightly smaller than
  single-round noise, so the conclusion rests on the 7/8 sign
  consistency plus the extend_trusted 7.18%→0% mechanism evidence.
  Accounting update: ast ~33.4 → ~32.4ms/iter vs cst ~29.3ms → ratio
  ~1.11; residual gap ~3.1ms, candidate ranking (from the M20 analysis
  report): ① estree double-write flat_list (0.5–1.0ms, medium risk) ②
  has_partial fold scan (0.3–0.46ms, low risk) ③ head_text cache
  (0.2–0.35ms, low risk) ④ vals staging-layer elimination (design has
  an unresolved nested-rule continuity obstacle, and the memcpy fast
  path already ate part of the ceiling).
- **M21 (landed, 32/32, corpus 0/500, −0.69ms/iter): misc protocol waste
  — fold-scan skip + head_text inline + list_from audit.** Sole change:
  src/target-rust.ts (5 sites, no unsafe); fixtures untouched.
  **Item 1 — has_partial skip (≈ −0.58ms)**: AstArena gains
  `partial_count: usize` (monotonic, never decreases), mk_partial +1,
  and shape_fold_kids opens with `if ar.partial_count == 0 { return
  (Cow::Borrowed(kids), None); }`. Premise instrumented first: the 2MB
  corpus produces **zero Partial** (estree_switch_case is the only
  producer path and the corpus has no switch), so all 105,776 fold_kids
  calls/parse were wasted scans. Correctness: count==0 ⟹ no Partial was
  ever produced ⟹ the skip ≡ scan-then-none; the moment a mk_partial
  happens the scan resumes (safe over-approximation — a txn failure can
  only over-count, never under-scan). Sample: has_partial 44/2547 →
  **0/2543** (symbol gone).
  **Item 2 — head_text: premise failed, caching honestly dropped**:
  code reading + instrumentation show each node's headText is computed
  exactly once at keep_node construction (stored into fields/
  TTypeKeep) — there is no duplicate computation to cache; the corpus
  has only the single List→first→Str pattern (67,312×2/parse), and the
  Node-fallback linear scan and Number/Bool→mk_own_str that M20's
  analysis expected are both zero here. Instead the List arm got a
  semantically-equivalent Str/OwnStr inline micro-optimization:
  shape_head_text 22→16 samples ≈ −0.08ms. **Lesson: items whose
  expectation rests on unverified path assumptions get instrumented
  first, implemented second.**
  **Item 3 — list_from audit (measurement only)**: 721,209 calls/parse
  **confirmed** (the M12-era instrumentation was accurate); n
  distribution n0=73.3% / n1=26.7% / n≥2 exactly once per parse; self
  ≈ 1.27–1.37ms is credible; the shape_* methods have no #[inline] and
  all 96 samples are self-time — pure call+dispatch overhead. **M22
  candidate: #[inline] or emitter-side inlining of the n0/n1 fast paths
  at 742 call sites — ceiling ~1.3ms, low risk.**
  Acceptance: tsc exit 0; qcheck only E0601; gate **32/32**; diff
  **0/500**; shape-parity 85/85; A/B (load-gated, 6 interleaved rounds)
  mean **−0.69ms/iter (−2.06%)**, 6/6 rounds sign-consistent; loop-cst
  control drift 0.56%, sign-mixed. Main agent re-verified: gate 32/32,
  sample has_partial=0, own run m21 16.95/17.00 vs m20 18.96 (load 7)
  consistent. Accounting update: ast ~32.4 → ~31.7ms/iter vs cst
  ~29.3ms → **ratio ~1.08**; residual gap ~2.4ms. M22 targets the
  list_from inlining (~1.3ms ceiling).
- **M22 (landed, 32/32, corpus 0/500, −1.41ms/iter decisive):
  shape_list_from `#[inline(always)]` — one line.** Sole change: the
  prelude template's `fn shape_list_from` in src/target-rust.ts gains
  `#[inline(always)]` (Phase A finalized). Purity proof: dropping that
  line leaves q-ts.rs and prof-m21.rs parser bodies byte-identical; all
  741 call sites inline, binary +132KB. Basis (M21 audit): 721,209
  calls/parse, n0=73.3% / n1=26.7% / n≥2 exactly once per parse, self
  86–96 samples ≈ 1.3ms of pure call+dispatch overhead (LLVM does not
  proactively inline a generic method under 742 call sites). Mechanism
  hard proof: sample shape_list_from self 86/2543 → **0** (symbol gone;
  the untouched shape_pack_range remains in the same session — valid
  control). A/B: the first dirty-load run gave −0.61ms (3/6 sign) — a
  quiet-load rerun went **6/6 rounds sign-consistent, mean −1.41ms/iter
  (−3.93%)**, with the loop-cst null control at only −0.075s (signal ≈
  10x drift); main agent's own run (−1.76ms/iter) was same-direction.
  Phase B (emitter-side n0 fast path, 7 template sites) was rejected on
  measurement: −0.10ms/iter ≈ null drift, the mechanism only halved
  (90→44) and wall-clock could not resolve it. Acceptance: tsc exit 0;
  qcheck only E0601; gate **32/32**; diff **0/500**. Accounting update:
  ast ~31.7 → ~30.3ms/iter vs cst ~29.3ms → **ratio ~1.03**, gap
  ~1.0ms. Remaining candidates: shape_pack_range inline (57,696 calls —
  bonus item, not done), estree double-write flat_list (0.5–1.0ms,
  medium risk; a semantic flatten, not pure waste), walk residuals.
  Lesson recorded: LLVM will not proactively inline generic runtime
  helpers under hundreds of call sites — hot small helpers always get
  `#[inline(always)]` (take_lit/take_span/current_off already had it);
  dirty-load A/Bs only trust quiet-load reruns plus null-control
  separation.
- **M23 (landed, 32/32, corpus 0/500, wall-clock wash — kept as
  cleanup): shape_pack_range `#[inline(always)]`.** Sole change: the
  prelude's `fn shape_pack_range` in src/target-rust.ts gains
  `#[inline(always)]` (V1/V2 premise correction: shape_ck/shape_restore
  were already `#[inline(always)]` since the SH3-5 era, so the two
  variants collapsed into one change). Mechanism proof: sample self
  9→0, and nm confirms the symbol vanished from the binary. Current
  self-time leaderboard (sample-m22 aggregation): lex_from 419 (16.5%)
  is the largest single self-time, then parse_ast_Decl 356, Expr_nud
  205, Stmt 198, estree_stmt 72-83 — the shape-helper class is fully
  zeroed, the prelude layer is squeezed dry. **Measurement-protocol
  correction (important)**: the same-binary same-window paired ratio
  (loop-ast vs loop-cst interleaved, ≥6 pairs, median) is the only
  trustworthy metric — cross-session absolute comparisons (the ~1.03 we
  reported earlier) are not. M23's same-window paired median = 1.076
  (M22 measured the same way: 1.091); the gate's built-in paired timing
  reads 1.139-1.148 (under gate load). A/B is −0.06ms-level,
  statistically a wash with the correct sign — kept as closing cleanup.
- **M24 (landed, 32/32, corpus 0/500, perf wash — kept): flat_list
  single-List identity fast path.** Sole change: flat_list in
  test/fixtures/shape-typescript-rust-customs.rs gains a leading fast
  path — after filtering Null from kids, exactly one survivor that is
  an SVal::List returns the original SVal directly (same range, same
  elements, same order — semantically identical; slab consumers are all
  read-only, and the fold-append's only in-place write targets the
  handler's own mk_list(&[]), never the kid List — verified against the
  generated code). Premise instrumentation: 96,160 calls/parse, 80.0%
  hit rate, saving 57,696 elements ≈ 923KB memcpy/parse (11.5% of the
  lists slab writes). Honest perf-wash conclusion: 923KB/parse is
  ≈0.1-0.3% of an ast iteration — 1/6 of the null-control noise floor
  (±1.6%) — the double-write's second copy is simply too small, and the
  fast path's added scan branch nets zero-to-slightly-negative. A/B
  median +2.38% vs null control ±1.64%, same magnitude. Final ratio
  (M24 same-window paired median): 1.089 (vs M23's 1.076 — inside
  inter-window noise). Lesson: byte-level waste must be converted into
  time share before deciding to pursue it — items under 0.5% cannot be
  accepted under this machine's noise floor.
  **Current standing:** after M26 — paired ratio stable at **~1.076–
  1.089**; 7.43x → ~1.08x overall. The last four milestones are one
  real, two washes, one negative (M22 −1.41ms banked / M23, M24 washes
  / M26 negative, reverted) — the source-level small items are all
  exhausted. The residual ~7.6% gap is structural: estree construction
  produces a richer output (30.8MB vs CST's 20.4MB — real work), the
  walk is already at par with the CST parser, the M6/M13 dispatch
  rewrites failed twice before, and PGO's +31% speeds both sides
  equally, never touching the ratio. **Source-level ratio plateau:
  determination stands.**
- **M25 (probe — no source change; PGO +31~34% both paths, ratio
  unchanged; plateau refuted): build-flag ceiling experiments.**
  Environment: Apple M2 arm64, rustc 1.92.0 (Homebrew, not rustup),
  LLVM 21.1.7; llvm-profdata found at
  /opt/homebrew/Cellar/llvm/21.1.8/bin/ and the PGO pipeline ran end to
  end (instrumented 139s + training 60s + merge + optimized 126s ≈ 5.5
  minutes). Three variants, prof-m24.rs untouched apart from flags:
  **codegen-units=1** — ast ≈0% (median paired 1.001), cst +3.5%
  (1.0348), not worth it, binary +3.2%; **target-cpu=native** —
  noise-level (ast +0.8%, cst +1.8%; on arm64 the default is already
  ≈native); **PGO** — **ast +31% (median paired 1.3115), cst +34%
  (1.3367)**, reproduced at +28~34% across three independent windows;
  correctness 28/28 plus the full 2000/2000 corpus verbatim-identical.
  **Key conclusion ①**: PGO speeds both sides equally → the paired
  ratio is unchanged (1.0754 — same band as M23/M24's 1.076-1.089).
  Build-flags buy absolute performance, not ratio. **Key conclusion
  ②**: the plateau assumption is refuted at the toolchain level —
  LLVM's layout/branch/inlining decisions on the 6.7MB giant branchy
  generated code are worth ~30%, not <2%. **Key conclusion ③ (from the
  PGO sample contrast)**: the hot structure is unchanged (lex_from
  ~16%, parse_ast_Decl ~14%, Stmt ~11.5%, Expr_nud family ~17%); PGO
  absorbs `parse_ast_Expr_nud_rest` (self 147→0) and
  `parse_ast_Type_nud_rest` (78→0) via inlining — both are AST-only
  functions, so a static `#[inline(always)]` would speed up only the
  ast side and directly improve the ratio → M26 does exactly that. R5
  (source-level hot/cold) reassessed: if production can run PGO, R5's
  value collapses (PGO takes the layout gains fully automatically); it
  is only worth it when PGO cannot ship, and source hints
  (#[cold]/#[inline]) are far inferior to PGO's precise branch
  frequencies — expected to land well below 30%. Honest limitations:
  the PGO training set IS the bench itself (an in-distribution upper
  bound); cross-corpus generalization is untested; landing the absolute
  gain is a build-pipeline matter (release profile-use builds), outside
  this repo's source scope.
- **M26 (reverted — negative result): AST pratt nud_rest static
  `#[inline(always)]` (source-level copy of PGO's decision backfires).**
  Change (rolled back): src/target-rust.ts's AST `_nud_rest` emission
  points gained `#[inline(always)]`. Premise correction: it actually
  generates 10 pratt rules (Expr, Type, TypeofRef, NewTarget,
  ClassHeritage + 5 _A shape variants), not 2 — each with a single call
  site, only Expr/Type hot. Mechanism delivered but wall-clock
  reversed: sample has parse_ast_Expr_nud_rest / Type_nud_rest self
  147/78 → 0 (absorbed into _nud, whose self went 214→343), yet the A/B
  across two independent sessions had 12 of 14 pairs m26 **slower**
  (ast +2.4%) with the null control at +0.3% cleanly separated — a
  real, small regression; final ratio 1.097 vs M24's 1.089. **Lesson:
  static always-inline ≠ PGO's inline** — PGO's inlining is coupled to
  whole-binary frequency-driven layout/specialization; a bare
  `#[inline(always)]` only stuffs a big function into a recursive hot
  path, and the saved call overhead loses to register-pressure/code
  layout. The PGO decision cannot be source-ified directly. Rollback
  verification (main agent executed): reverting the one line makes
  qcheck's regenerated q-ts.rs byte-identical to M24's verified source
  (prof-m24.rs minus main) — the strongest possible verification; M24's
  green state (32/32, 0/500) is fully restored, tsc exit 0.

**Multi-corpus validation (post-M26): synthetic baseline vs real files +
two grammar accept-gaps surfaced.** Method: prof-m24 (the M26 rollback
state) run against all ≥100KB real TS files in the repo (11) +
unicode_property_data.ts (451KB) + the 2MB baseline, same-window
interleaved paired ratio (≥4-5 pairs per corpus, median); batch-mode
accept consistency passed everywhere (13/13, zero divergences).
**Premise correction ①**: the 2MB baseline corpus is **synthetic** (8
statements × 9,616 repetitions), not real code — every prior ratio
number rests on it. **Premise correction ②**: 11/13 real TS files in
the repo are **rejected by both paths (CST + AST)** — not an AST
backend problem but a shared-grammar accept gap (the batch cst/ast
divergence check found zero divergences). **Two grammar gaps (minimal
repros, main agent verified)**: the relational `<` rejects a whole file
in any expression position (`return 1 < 2;`, `const x = a < b;` all
reject; `>`/`<=`/`>=`/`===` accept) — tied to the generic `<T>`
ambiguity — and template interpolation accepts `${ident}`/`${a.b}` but
rejects `${f(1)}`, `${a + b}`, `${-a}`, `${a, b}`. Every real repo file
hits one of these: six src/ codegen files carry 67-261 lines of
call-in-interpolation, and five cst-match files hit `e < 0` by line 36.
**Ratio across corpora** (only the two accepting corpora are
measurable): 2MB synthetic median **1.081** (consistent with the prior
1.076); unicode_property_data.ts (a pure string-data array, 47k
non-ASCII chars) median **1.148** (stable over 10 rounds, most rounds
near the 1.15 line). **Real-code ratio is currently unmeasurable** —
the files cannot get into the parser. Implications: ① 1.08 is a
synthetic-corpus number; real content lands at least at ~1.15
(data-dense); ② grammar coverage is more urgent than the ratio — when
the backend cannot even parse `a < b`, the ratio's practical meaning is
limited; ③ fixing either gap unlocks the six real src/ codegen files
(150-505KB) as ratio corpora. Fork in the road: accept ~1.08 as the
wrap-up, pivot to grammar coverage (`<` + template interpolation —
shared grammar; re-measure real-code ratio once fixed), or change
architecture — awaiting the user's decision.
- **Per-rule typed codegen** (the old M13 plan below) is *demoted*: the
  protocol+construction layer it removes measures ~19% (estree_* 9.7% +
  Vec::extend 9.2%, ≈ 6.6ms) — the real headroom is that order, not the
  <1ms the (falsified) stub experiment claimed — but the walk (56%) is
  still the bigger lever, so the demotion stands. M14/M15/M16 have now
  landed at
  30.77MB/2MB (1.51x CST) — reassess: the residual ~5ms/2MB gap (ast
  ≈36.4ms vs cst ≈31.4ms) sits almost entirely in construction
  writes/reads, so the next levers are per-tnode byte shaving (u16
  field-ids, smaller typed layouts) and cache/load-store work, not
  protocol elimination — the DynObj Identifier fallback is typed (M16),
  leaving Program as the last DynObj node.
  Separately measured dead ends: single-SVal star/sep elements need no
  pack-elision (shape_pack_range n==1 is already pop/push); transient
  alt-packs are only 57,696 calls / 154k elems per 2MB (3.7MB), and
  list_from is called 721k times for just 269k elems (mostly empty lists).

**M12 (landed): per-grammar `GrammarCustoms` trait.** The emitter
collects the shape spec's custom fn names (`collectShapeCustomFns`) and
emits one positional trait method per name
(`fn estreeDecl(ar, src, kids, alt_path, off, end, left, op_text, state)`);
the parser calls `self.customs.<fn>(...)` directly — static dispatch,
inlinable, no AstCustomCtx (15 stack fields ≈ 120B/call), no fn_id match.
The generic `ast_custom` ctx dispatch stays only for the fail-loud harness
and cross-handler delegation. Generated file shrank ~9k lines (the inline
ctx constructions vanished). calc/toy/template grammars have zero customs
and get the empty trait. This is the protocol-elimination substrate the
direct-typed slices build on.

Gate: 32/32, median ast/cst 1.29–1.37 across runs (machine under heavy
external load during measurement; paired with M10's 1.3629 the delta is
flat-to-slightly-positive, so kept). **M12b**: `#[inline(always)]` on the 23
forwarding methods in the customs impl — same gate, median 1.3126, kept.

Ceiling honesty: even a perfect representation leaves the RD walk + lexer
(shared with cst mode, ~8.4ms of the ~32ms cst total), so 1x means "AST
build ≤ CST build" — approachable only if AST construction bytes drop to
CST scale (~20MB/2MB; actual M14+M15+M16 landing: 30.77MB from
57.5MB — the 20-25MB target was missed on tnodes, which shrank 31% not
50%+), not "as
fast as oxc" — oxc fuses lex+parse+AST in one hand-written pass with no
grammar-indirection at all.

## M27 plan (post-plateau, user-approved target 0.9): tnode representation compression

User decision (2026-08): next-stage target is **ratio 0.9**, pursued via pure
representation compression inside the current engine (no contract change —
streaming/lazy deferred; its blockers are documented below in the next
section). Investigation completed 2026-08-03 (live stats via a spliced
per-vec stats build of the M26 state, 2MB synthetic corpus):

**Current tnode footprint (M26 state, 2MB):** 567,344 tnodes / 21.85MB
(avg 38.5B) + lists slab 500,032 × 16B = 8.0MB. Top vecs by bytes:

| vec | count | struct bytes | fields (SVal=16B each) |
|---|---|---|---|
| idents | 86,544 | 32B | name SVal, ta Option<SVal> |
| type_keeps | 67,312 | 32B | children SVal, head_text SVal |
| var_declarators | 38,464 | 56B | id, ta, init SVal + off,end u32 |
| call_exprs | 28,848 | 64B | callee, arguments SVal + 2 Option<SVal> |
| for_heads | 9,616 | 104B | kind SVal + 5 Option<SVal> + await |
| block_stmt_sps | 28,848 | 32B | body SVal + off,end f64 |
| var_decls | 28,848 | 32B | kind, declarations SVal |
| func_decls | 9,616 | 88B | 2 bool + 5 SVal |
| class_decls / for_stmts | 9,616 | 64B | 4 SVal |
| ts_type_params | 9,616 | 64B | 3 SVal + off,end f64 |
| method_defs | 9,616 | 56B | 3 SVal + bool + Option<bool> |
| bin_exprs / if_stmts / ts_type_aliases / ts_type_refs | 9,616 | 48B | 3 SVal |

**Constraints that shape the scheme** (measured): ① `SVal::Number` JSON arm
writes a **raw JSON number** (`n.to_string()`), not a Literal object — numeric
leaves CANNOT become typed nodes without breaking the byte-locked gate, so any
expression-position field that can receive a Number must stay able to hold one;
② operator text always originates from a src span (op_text → sval_str), so
operators are `(u32,u32)` spans; ③ kind strings (const/init/method/…) come from
the M15 static OwnStr table → `u32`; ④ f64 span fields (TType/TMemberName/
TTSTypeParam/…) hold src offsets < 2^32 → `u32`; ⑤ child-only fields (callee,
body, consequent, …) always hold TNodes → `u32`; ⑥ `Option<SVal>` where None
dominates → `u32` with `u32::MAX` sentinel; ⑦ list fields → `(u32,u32)` ranges.

**Field-kind scheme:** `u32` node-ref | `u32` tagged (high bit = number-slab
index, else tnode index — new `numbers: Vec<f64>` slab in TnodesArena) |
`(u32,u32)` list range | `u32` OwnStr / `(u32,u32)` span for strings | `u32`
sentinel Option | `u8` flags (pack adjacent bools) | `u32` spans.

**Projected savings (sum over top 26 vecs): ~11.3MB** — 21.85MB → ~10.5MB
(avg 38.5 → ~18.6B). The byte→time rate is the uncertainty: cross-path anchor
(29.9 vs 20.4MB ↔ ~5ms gap) suggests ~0.5ms/MB ⇒ −5.7ms ⇒ ratio ~0.90;
the M14-M16 rewrite anchor (26.7MB ↔ ratio 1.31→1.20 ≈ 3.5ms) suggests
0.13ms/MB ⇒ −1.5ms ⇒ ~1.03. The working set stays > 16MB L2 either way
(lists 8MB + compressed tnodes ~10.5MB), so no regime flip is available.
**Batch 1 is therefore a rate probe**: implement the largest, mechanically
cleanest structs first, A/B paired, and let the measured rate decide whether
0.9 is reachable or the band is ~1.0-1.03.

**Implementation batches (each: fixture structs + handlers + write_tnode_json
arms → tsc → qcheck → diff 0/500 → gate 32/32 → paired A/B):**
- B1 (rate probe, ~4.2MB): expr_stmts, return_stmts, seq_exprs, class_bodys,
  class_decls, for_stmts, if_stmts, template_els, template_lits
- B2 (~4.6MB): idents, type_keeps, var_decls, block_stmt_sps, call_exprs,
  var_declarators, bin_exprs
- B3 (~2.5MB): func_decls, arrow_fns, function_exprs, method_defs,
  member_names, ts_type_params, ts_type_param_decls, ts_type_aliases,
  ts_type_refs, for_heads
The fold interplay (tnode_fold_append rewriting a parent's List field by
index) stays identical — only the field width changes. All edits are
fixture-local (src/target-rust.ts untouched except nothing); verification
chain unchanged.

## Streaming / lazy contract change (deferred — blockers)

Why "not building the tree" was rejected for now (asked by user 2026-08-03):
① checkpoint/restore backtracking (speculative arena appends + O(1) truncate,
M8 lesson) cannot emit a single-pass stream — backtracked branches would have
already written output; buffering per branch = locally re-materializing the
tree; ② the tree is the repo's real downstream asset (cst-match/Monarch/
tmLanguage/incremental align machinery), not an intermediate; ③ the bench
loop-ast drops the parse result (verified prof-loop.rs:112530: `let _ =
parse_ast_with(...)`) — serialization is outside the timed loop, so the
"product" of the measured work is the tree itself; ④ oxc materializes a full
arena AST — "no tree" is not the oxc playbook, fused lex+parse is; ⑤ lazy
materialization pays only for partial consumers; JSON consumes 100%; ⑥ the
gate's structural checks (tree equality, spans, diff 0/500) would go dead.
The streaming floor (~0.35-0.45) is real but requires an engine-level
single-pass redesign or a JSON-only product; revisit only after the 0.9
probe measures the compression rate.

**M27 correction (investigation, before implementation): expression fields
cannot narrow.** `write_sval_json` (verified prof-m24.rs:8649-8652) emits ALL
literals as raw JSON values — Bool→true, Number→raw decimal, Str→JSON-escaped
text, Null→null; there are no Literal nodes. Every expression-position field
(left/right/test/init/argument/callee/object/property/… and idents' name,
type_keeps' head_text) can therefore hold any SVal variant and must stay 16B.
Narrowable fields are only: lists → (u32,u32), child-only nodes → u32,
flags → bool, kind strings → (u32,u32) span, f64 spans → u32. Revised savings:
**~7.9MB** (21.85 → ~14MB; the earlier 11.3MB assumed expression narrowing —
disproven). 0.9 needs ~1.0ms/MB of construction-time saving; the M14-M16 anchor
(26.7MB ↔ 3.5ms = 0.13) and the cross-path anchor (~0.5) bracket it below that
— **honest expectation: ratio ~0.95-1.03, with 0.9 as an optimistic edge**.
B1 proceeds as a rate probe: implement the full narrowable set, A/B paired, and
let the measured rate decide. A full 8B "LeanSVal" (indexed numbers/strings)
could recover another ~2MB but is a protocol change with conversion overhead —
only if B1's rate justifies it.

**M27-B1 (landed, byte-identical verified): tnode field narrowing, tranche 1.**
Implemented in test/fixtures/shape-typescript-rust-customs.rs by a delegated
sub-agent against a complete field-domain spec (K3 authored, agent applied).
New helpers: `list_range` (List SVal → (u32,u32)), `ChildRef {tag:u8, idx:u32}`
(8B child ref with tag — any node type, sentinel CR_NULL = u32::MAX),
`child_ref`/`write_list_range`/`write_child_ref`. Narrowed 12 structs:
TSeqExpr/TClassBody/TTemplateLit fields → (u32,u32) ranges; TTemplateEl.value
→ u32 (fixed TRawVal tag); TClassDecl.decorators → range, body → u32;
TIfStmt.consequent/alternate, TForStmt.body, TFuncDecl.body →
ChildRef; TIdentifier/TParamIdent.type_annotation, TVarDeclarator.type_annotation
→ ChildRef; TCallExpr.arguments → range, optional → Option<bool>,
type_arguments → Option<(u32,u32)>; TVarDecl.declarations, TTypeKeep.children,
TBlockStmtSp.body → range, TBlockStmtSp.off/end f64→u32; TFuncDecl.params → range.
**Empirical value-domain corrections (sub-agent surfaced via strict A/B bytecmp —
the official diff-m14 gate has a scrubIso weakness that silently drops
panic/`E` lines and null fields from the accepted pool, masking regressions;
verified against a hand-built prof-m26 vs prof-b1 all-2001-line bytecmp):**
TVarDeclarator.id (raw Str names + DynObj ObjectPattern), TClassDecl.id,
TFuncDecl.id (raw Str names), TFuncDecl.type_parameters and .return_type
(sometimes raw List) — all FIVE reverted to SVal 16B. E0392 gotcha: structs
losing their last SVal field must drop the `<'a>` lifetime + TnodesArena Vec
declaration. Final state: prof-b1 byte-identical to M26 baseline 0/2001
(all 2001 corpus lines, incl. reject lines) and official diff 0/500
(accept=1403/2000 back to baseline); bench 2MB corpus runs clean (0 E lines).
Byte delta: tnodes 21,847,552 → 17,539,584 (−4,307,968 B = −19.7%, lists slab
unchanged). AST total ≈ 29.9 → 25.6MB. **A/B paired ratio measurement
(pending, load-gated): decides the byte→time rate and whether LeanSVal/B2/B3
continue or byte-shaving is a dead end.**

**M27-B1 rate-probe protocol (pre-registered, 2026-08-03).** A/B: interleaved
same-window rounds of (cst control, m24-ast, b1-ast) with rotation, ≥6 rounds,
`/usr/bin/time -p` capturing BOTH real and user CPU time (user time is
scheduling-robust — the machine was under sustained user load 5-13 during the
first attempt). Load gate: 5-min loadavg < 3.0, up to 60 min wait. Interpretation
thresholds (ast delta = 4.3MB × rate): rate ≥0.58ms/MB → ratio ≤1.0 (continue
B2/B3); rate 0.13-0.5 → ratio ~1.01-1.06 (bytes near-dead-end; stop unless the
user wants LeanSVal's ~5MB more for a ~0.97-0.99 shot); cst control spread
>2% across rounds marks the window unreliable (judge by user time instead).

**M27-B1 rate-probe RESULT (decisive negative — 2026-08-03).** 6-round
interleaved same-window A/B (cst control, prof-m24 vs prof-b1, 500 iter,
real + user CPU time, load-gated <3.0; cst drifted 14.7→16.3 across rounds,
rounds still paired within-window). Paired deltas (b1−m24, s/500):
real −0.86, −0.35, −0.54, −0.94, +0.27, −0.17 → **median −0.45s = −0.89ms/iter
→ rate 0.21ms/MB**; user −0.37, −0.04, −0.25, −0.52, +0.13, +0.04 →
**median −0.15s = −0.29ms/iter → rate 0.07ms/MB**. b1 faster in 4-5/6 rounds on
both metrics — the saving is real but tiny: B1's 4.3MB buys ~0.3-0.9ms/iter →
ratio improvement ~1-2.5% → **landing ratio ~1.05-1.07**. The measured rate is
AT/BELOW the M14-M16 anchor (0.13ms/MB): construction is instruction/stall-
structured, not byte-dominated — M26's source-level plateau is empirically
confirmed a second time. The 0.9 target needs rate ≥0.7ms/MB (3-10x higher);
LeanSVal/B2/B3 (~6-7MB more) would buy only ~0.5-1.5ms more (→~1.04-1.06) at
real protocol risk. **Decision (pre-registered thresholds): STOP byte-shaving.
B1 stays (real, small, byte-identical). 0.9 is unreachable via representation
compression; the honest landing is ~1.05-1.07 on the synthetic corpus.**
Next decision (user): accept as wrap-up / pivot to grammar coverage (unlocks
real-code ratio) / revisit streaming contract.

**M27-B2 (measured: wash — LeanSVal conversion overhead cancels bytes).**
B2+LeanSVal landed byte-identical (prof-b2 vs prof-b1 0/2001, diff 0/500, bench
clean; tnodes 17.54 → 13.65MB, total −37.5% from M26). Agent-surveyed value
domains: 7 fields pre-excluded (MethodDefinition.value/key, TryStatement.handler,
ExportDefault.declaration, TSPropertySig/TSIndexSig.typeAnnotation,
TSEnumDecl/TSModuleDecl.id, ForStatement.init, Property.value, TTSTypeRef.typeName,
TSTypeAlias/TSInterfaceDecl.id, Break/Continue.label — raw strings/lists) + 3
bytecmp-caught (TExprStmt.expression receives **DynObj Nodes** — `a++; b--`
produces an untyped UpdateExpression with off/end!; MethodDefinition.key empty
list; UpdateExpression.argument conservatively reverted). Final 6-round m24-vs-b2
A/B: real median −0.01s, user median +0.075s/500-iter — **wash to slightly
slower**. The 8.19MB total byte reduction bought ~0 time: to_lean's numbers/spans
slab pushes + from_lean + write_lean dispatch fully cancel the savings (same
lesson class as M26). Contrast: B1's simple extractions (list_range/child_ref,
no slab pushes) were genuinely −0.9ms. **Ceiling rule: conversion work ≥ byte
savings → net zero.** Decision: revert B2+LeanSVal to B1 (same perf, far simpler
code, verified) — a direct b1-vs-b2 A/B is running to confirm keep-vs-revert.

**M27-B2 final decision (user, 2026-08-03): KEEP b2 — memory trade accepted.**
Direct b1-vs-b2 A/B (6 rounds; r1-r4 clean medians, r5-r6 excluded —
machine load spiked to 20+, cst control inflated to 78s): b2 − b1 =
real +0.39s/500 (+0.77ms/iter), user +0.29s/500 (+0.58ms/iter). Combined
story across all three A/Bs: b1 < m24 (−0.9ms, real); b2 ≈ m24 (wash); so
**b2 ≈ b1 + ~0.7ms/iter — the LeanSVal conversion overhead cancels B1's gain,
and the final ratio lands back at ~1.08 (M26-equivalent)**. User's call: the
memory reduction (tnodes 21.85 → 13.65MB, −37.5%; net arena ≈ −21% after the
numbers/spans slabs, ~6.4MB/parse on the 2MB corpus) is worth a 0.5-1% wall-clock
cost for real products (editors/batch parsing many files, cache/paging pressure).
B2 stays; the earlier "revert to B1" note is superseded. Remaining acceptance:
the full 32-check gate on the b2 state (bytecmp 0/2001 + diff 0/500 + bench
clean already pass; gate runs to close).

**M27-B3 (landed, byte-identical): lists split-slab — SVal::NodeList.**
User-directed memory compression (option 1 of the memory analysis). Design:
new `SVal::NodeList(u32,u32)` variant + `AstArena.node_lists: Vec<u32>` where each
element packs `(tag << 24) | idx` (4B vs 16B SVal). The bulk list constructors
(`mk_list`, the vals-stack finishes `shape_pack_range`/`shape_list_from`, the
fixture's `flat_list`/`mk_fast`, call-args and template sites) take an all-TNode
fast path: all elements TNode → packed node-list; else the generic SVal list.
Struct fields' (u32,u32) list ranges carry a high-bit `NL_FLAG` (0x8000_0000)
so `write_list_range`/`first_flat`/etc. know which slab. Measured lists
composition drove the split: 58% of elements (288k) are TNode in homogeneous
lists; the Type-keep children (Str/List/Null/Number mix) stay generic by design.
Emitter is shared → defensive arms added (shape_fold_list pass-through,
shape_fold_append NodeList→generic conversion, shape_head_text, list_of → &[]).
Iteration caught by bytecmp: paren_or_comma / array_pattern receiving NodeList
kids, flat_deep_take / nested-8 reads — fixed. Verification: prof-b3 vs prof-b2
**0/2001** (all lines incl. rejects), diff 0/500 (accept 1403/2000), bench clean
(0 E). Memory (my verification): lists 278,864×16B = 4.46MB + node_lists
221,168×4B = 0.88MB = **5.34MB vs 8.0MB (−2.7MB)**; total AST arena
≈ 23.5 → **~20.8MB ≈ CST parity in memory too**. tnodes unchanged (13.65MB).
Full 32-check gate (all grammars — emitter shared) runs to close.
