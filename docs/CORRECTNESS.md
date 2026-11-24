# Correctness: the productions, not `tsc`

What the parser accepts, and where that differs from `tsc`'s parser on purpose. The policy in
one line: JavaScript syntax follows the ECMAScript productions, TypeScript-only syntax follows
what `tsc`'s parser accepts, and static semantics (early errors, checker rules) are a CST
consumer's job, not the parser's.

## The line between syntax and static semantics

The conformance runs measure Monogram against `tsc`, but `tsc` is the **oracle, not the
definition**. What the grammar models is the language's **syntactic productions**, and the
parser produces a CST, which is *pre-semantic*.

Assignment targets show where the line falls:

- The parser enforces their **shape**. The operand of `=` (and of every compound assignment)
  and of postfix `++`/`--` must be a LeftHandSideExpression, as the production says, so
  `a + b = c`, `-a = 1` and `a++ = 1` have no parse.
- Prefix `++`/`--` gets the same shape rule. That is one step past its production
  (`++ UnaryExpression`) and is what `tsc`'s parser does, so `++ -x` and `++ ++x` reject too.
- Whether a LeftHandSideExpression is a *valid* target (ECMAScript's AssignmentTargetType
  early error, and in TypeScript the checker's rule) is a **static-semantic** rule:
  `1 = 2`, `f() = 1`, `(a + b) = c` and `for (f() in x);` all parse. That belongs to a CST
  *consumer* (the CST-to-AST lowering, or a validator that walks the tree), not to the parser.

Apart from that prefix-update shape check, the parser's job is to accept exactly the strings
the productions derive.

## Where `tsc`'s parser and the productions differ

`tsc`'s *parser* is not the same thing as the language. It draws its own parse-versus-check
line, and on a handful of inputs it diverges from the grammar, and from the other engines
(V8, Babel), in **both** directions. Driving Monogram's accept/reject to *exactly* `tsc` would
mean reproducing those quirks; instead it follows the productions:

| Input | Monogram | `tsc` parser | V8 / Babel | Why |
|---|---|:--:|:--:|---|
| `obj?.#field` | accept | reject | accept | A private member in an optional chain is valid current ECMAScript — V8 and Babel both accept it; `tsc`'s parser is the lone rejecter. |
| `using {a} = b` | reject | accept | reject | A `using` binding is a `BindingIdentifier` (`BindingList[~Pattern]`, and `ForBinding[~Pattern]` in a `for` head: `for (using {a} of b)`); the object pattern has no production. `using [a] = b` *is* valid — there `using` is an identifier and `[a]` is an element access, as in `for (using [a] of b)`. |
| `for (var a, b of c)` | reject | accept | reject | Before `in` / `of` a declaration has one binding: `var ForBinding` and `ForDeclaration` (`LetOrConst ForBinding`) take a single one, where the C-style head takes a list (`for (var a, b;;)`). |
| `for (var of x)`, `for (var in x)`, `for (var;;)` | reject | accept | reject | A `var` head declares at least one binding (`var ForBinding`, `var VariableDeclarationList`), and `var` is a reserved word, so it is no LeftHandSideExpression either; `tsc`'s parser reads an empty declaration list and leaves it to the checker. |
| `var;`, `const;`, `var a,`, `let a, ;`, `export let\n;` | reject | accept | reject | A VariableDeclarationList / BindingList has one or more declarations and no trailing comma (14.3); `tsc`'s parser reads an empty list and a trailing comma and leaves both to the checker. `let;` is valid: the expression statement of the identifier `let` (sloppy mode), which `tsc` also reads. |
| `var [...x = a] = a` | reject | accept | reject | A BindingRestElement is `... BindingIdentifier` or `... BindingPattern`, with no Initializer. |
| `for (async of x)` | reject | accept | reject | The for-of left side has `[lookahead ∉ { let, async of }]`, so `async of` can only begin an arrow, a C-style head (`for (async of => {};;)`); `for await (async of x)`, whose lookahead is `let` alone, *is* valid. |
| `for (using x in y)` | reject | accept | reject | A `using` declaration has no for-in production: the for-in arm's ForDeclaration is `[~Using]`. `for (using in y)` *is* valid — there `using` is an identifier. |
| `class C { async get x() {} }`, `class C { async static m() {} }` (JavaScript) | reject | accept | reject (acorn) | A class element has one `static`, before the rest (`static async m() {}`), and `async [no LineTerminator here]` begins a method or a generator method (AsyncMethod, AsyncGeneratorMethod), never an accessor. |
| `class C { @d static {} }`, `class C { accessor m() {} }` (JavaScript) | reject | accept | | Under the decorators proposal a DecoratorList prefixes a method, a field or an `accessor` field, not a static block, and `accessor [no LineTerminator here] ClassElementName Initializer?` declares a field only. |
| `@d function f() {}`, `@d export var x`, `@d export @e class C {}` (JavaScript) | reject | accept | | Under the decorators proposal a DecoratorList belongs to a class: ClassDeclaration and ClassExpression take one, and an exported class takes it before `export` or after it, not both (`DecoratorList export [lookahead ≠ @] ClassDeclaration`). No other declaration or export form has one. |
| `import x from y`, `export { a } from y`, `import x from "m" with { type: 1 }` | reject | accept | reject | A module specifier and an import attribute's value are string literals (`FromClause : from ModuleSpecifier`, `WithEntries : AttributeKey : StringLiteral`). |
| `import x from "m" assert { type: "json" }` | reject | accept | reject (acorn) | Import attributes are written with `with`. The `assert` form left the proposal before it was standardized. |
| `import x from "m"`⏎`with { type: "json" }` | accept | reject | accept (acorn) | `WithClause` has no `[no LineTerminator here]`; `tsc`'s parser reads `with` there only on the specifier's line. |
| `import defer x from "m"`, `import defer { a } from "m"` | reject | accept | | The import-defer proposal defers a namespace import only (`import defer NameSpaceImport FromClause`). |
| `import x = require("m")`, `x = import(a, b, c)`, `x = import(...a)` (JavaScript) | reject | accept | reject (acorn) | `import x = …` is TypeScript's. An ImportCall takes one or two AssignmentExpressions (`import ( AssignmentExpression , AssignmentExpression ,opt )`), and no spread. |
| `try {} catch (e = 1) {}`, `try {} catch (e: T = 1) {}` | reject | accept | reject | A CatchParameter is a BindingIdentifier or a BindingPattern, with no Initializer; `tsc`'s parser reads a variable declaration there and leaves the initializer to the checker. |

`tsc` rejecting the first and accepting the others (its parser doesn't enforce those
productions until the checker) is exactly why "match `tsc`" can't *be* the definition of
correct, only the measurement oracle.

## Where the oracles themselves are wrong

acorn is the second oracle for JavaScript verdicts, beside tsc's JS mode. It accepts two
inputs that the productions reject. The parser rejects both:

| Input | acorn | `tsc` parser | Why it is no derivation |
|---|:--:|:--:|---|
| `a ? b : () => {} ? c : d` | accept | reject | `ConditionalExpression : ShortCircuitExpression ? AssignmentExpression : AssignmentExpression`. The arrow is the first conditional's last AssignmentExpression. It cannot also be the ShortCircuitExpression that heads the second conditional, because an ArrowFunction is no ShortCircuitExpression. |
| `() => {} ? c : d`, `a => {} ** c` | accept | reject | The same: an ArrowFunction is an AssignmentExpression only, never the operand of a conditional or a binary operator. |

## The engines' mechanisms, one by one

Every engine runs the same plan: try a rule's alternatives, take the longest match, and on a tie take
the earliest-declared one. The table lists each place where the interpreter (`src/interpreter.ts`, the
reference) does more than that. For each, it gives the IR construct in `src/parser-ir.ts`, the
lowering member each printer implements (`src/target-{ts,go,rust}.ts`: the TS `prattRuleW`, the Go
native and builder forms, the Rust `prattRule`; the recovery interpreter `src/recovery-family.ts`
reads the same facts from its table, and `test/ir-engine.ts` mirrors them), and the list rows in
`test/portable-cases.ts` that exercise it. **V** means the exercising rows are in those lists,
which compare every target with the interpreter, verdict and CST (gate
`emit-parity/portable-targets/lists`), and each row's verdict was checked against tsc (and acorn for
JavaScript). **R** means the row was argued from the code: the mechanism has no portable
counterpart, so there is nothing to compare. **W** means the argument has a witness that fails if
it is wrong (a verify mode run over the corpora); **A** means it is an assertion the engine checks on
every parse.

A change to an engine mechanism is checked on both shipped language families: JavaScript /
TypeScript (the lists, test262, the tsc corpora) and Python (`conformance/cpython`). The first time
the second family caught an engine defect, TypeScript had agreed by luck (the tail-closure row).

The table argues that no mechanism is missing: an engine that implements every row behaves like the
interpreter. Where that argument cannot be made for a row, the row says so.

| Mechanism (interpreter) | IR construct | Printers implement | Exercising rows | How known |
|---|---|---|---|---|
| Longest match over a rule's alternatives, strict `pos > bestPos` (a tie goes to the earlier-declared one) | `RdRule.alts` in declaration order; `Dispatch`; candidate frames | `RuleLowering` candidate frame (`candTs` / `candGo` / `cand!`) | every list; gate `guard-refutation` | V |
| `altMightStart` / `altMightSecond` pruning: a FIRST / SECOND over-approximation, so it can only skip an arm that cannot match | `Guard` first / second, `Dispatch` sections, `Commit` | `guardCond` in each printer | gate `guard-refutation` (every refusal re-run; none unsound) | V |
| Ordered choice inside a sequence (`alt`: first match) | `Step alt` (`predictive` when FIRST-disjoint) | `StepLowering.alt` | every list | V |
| `*` / `+` stop on an empty iteration; `sep` takes a trailing delimiter | `Step star` / `sep` | `StepLowering.star` / `sep` | lists (`[a, , ...b,]`) | V |
| Zero-width tests: `not(…)`, a keyword-set fast path, `reservableNot` | `Step look` / `ahead` / `aheadCtx` | `StepLowering.look` / `ahead` | `RESERVED_EXPRS`, `conciseBody` rows (`() => { b() {} }.x`) | V |
| Newline sensitivity: `sameLine` (restricted productions, ASI through `not(sameLine)`) | `Step sameLine`, `PrattRule.postfixSameLine`, `ledSameLine` | `StepLowering.sameLine`, `postfixOp`, `led.sameLine` | `x\n++\ny`, `async\nx => …`, `a ? b : () => {}\n+x;` | V |
| `noCommentBefore`, `noMultilineFlowBefore`, indent, markup containers | none: refused loudly (`portable: rd construct … not in scope`; indent and markup grammars throw in `portableIR`) | — | — | R: the refusal is the argument; no portable grammar can contain them |
| `[Await]` / `[Yield]`: the context word (`ctxWordOfMode`, `ctxObserves`) | `Step ctx`, `aheadCtx`, `ctxWords` | `StepLowering.ctx` | `CTX_CASES` (generator / async rows) | V |
| Contextual keywords: a word is an identifier except where an arm names it | literal steps over the identifier token (`identLike`), `reservableNot` | lexer id plan (`lidOf`) | `RESERVED_EXPRS`, `let;`, `for (async of => {};;)` | V |
| Suppress staging: a `suppress` group stages its set for the next Pratt / leftRec rule call only | `Step suppress`: `_suppressNext = set; body; _suppressNext = 0`; `ledSuppressedIn` | `StepLowering.suppress`, `led.notSuppressed` | `NO_IN_HEADS`, `FOR_HEADS` | V |
| Pratt NUD: longest match over the NUD arms | `nudOrder`, `nudDispatch`, `nudCommit` | `nudSeq` / `nudLeaf` / `commitSeq` | every expression row | V |
| Capped NUD (`capExpr`, an arrow; the `yield` arm): a candidate only when `minBp < capBp`; once it wins, no led | `nudCapped` + `capBp`; the capped flag | `capBelow`; `bpOpen` returns at once when capped | `CAP_PROPAGATION` | V |
| Cap propagation through a binary right operand (`a = () => {} \|\| x` rejects) | `binary` lowering | `PrattLowering.binary` | `CAP_PROPAGATION` (`b = a = () => {} \|\| c`) | V |
| Cap propagation through a trailing operand: a node whose rightmost child is a self operand at bp 0 that returned capped is capped (`a ? b : () => {} \|\| x`, `[...() => {} \|\| x]` reject) | `ledCapsFromTail`, `nudBracketCapsFromTail`, `nudSeqCapsFromTail`; `NodeCap` | `ledArm(…, capsFromTail)`, `nudSeq` / `commitSeq` with `NodeCap` | `CAP_PROPAGATION` (`a ? b : () => {} ? c : d`, `f(...() => {} \|\| x)`), `REBIND.ts` (`let v = a ? (b) : c => {} \|\| x;`) | V |
| The packrat memo over Pratt / leftRec rules, keyed by (rule, start); bypassed under a suppress set or a re-bind cap; the entry is {node, end, capped} | none: the portable engine has no memo (a re-parse yields the same result) | — | `MONOGRAM_MEMO_VERIFY=1`: every hit is parsed again and must give the recorded end, cap and tree, or the parse throws; run over the tsc conformance corpus, test262 `language/` and CPython `Lib/`: no assertion (2026-11-24) | W: a pure function of (rule, start) outside suppress and cap, and it carries the cap that the only post-call reader (above) reads; the witness re-checks it on any corpus |
| Prefix NUD and `requireTarget` (`++-x` rejects) | `prefix[]` with `requireTarget`, `form` | `nudPrefix` / `commitPrefix` | `++-x`, `++ ++x` | V |
| Assignment-target form: an operator node is not a target; a prefix-unary node is not a `noUnaryLhs` operand; the middle-child test applies only to LED-built nodes | `AssignForm`: `ledForm`, `prefix[].form`, `FORM_*` | `binary` (`tgt` / `noUnary`), `postfixOp` | `x = class as {} = 1;`, `-x ** y`, `a + b = c` | V |
| Non-op LEDs: the `ledPrecOf` lbp gate, a chain-rhs operand at its level's bp (`in`, `instanceof`) | `ledLbp`, `Step ruleBp` | `led.lbpAbove`, `ruleBp` step | `a == b ? c : d`, `a in b in c` | V |
| `minBp < maxBp` at every Pratt call (it was a `maxBp <= minBp` skip of the non-op LEDs, dead by arithmetic, now removed) | none | — | `parsePratt` throws when a caller passes `minBp >= maxBp`; every corpus parse checks it | A: `maxBp = (levels+1)*2` and every `minBp` is 0, an rbp (at most `2*levels`) or a chain rhsBp (at most its lbp); an assertion, not a branch |
| Access tails and tail closure: once a postfix, prefix or binary node, or a tail-closing LED, is built, no `.x` / `(…)` / `[…]` / tagged template | `ledAccessTail`, `ledClosesTail`, `nud*ClosesTail` | `led.tailOpen`, `postfixToks` | `a++.b`, `new a?.b` | V |
| A led ending in a NEGATIVE lookahead closes the tail (`f<T>` then no `(`: `f<T>.x` rejects); a positive one (`not(not(X))`) asserts that a continuation follows and leaves it open | `ledClosesTail` (look / ahead / aheadCtx with `is` false) | as above | `let x = f<T>.x;` (reject); lookrec `set a.b.c[1] = x;` (accept) | V |
| The tail closure for leftRec rules' continuations (`type A = keyof void.x;`) | `buildPratt` computes it for leftRec rules too | as above | `keyof void.x` rows | V |
| `notLeftLeaf`: skip a led when the left node's head leaf is in a word set | `ledNotLeftLeaf` | `led.notLeftLeaf` | `void.x`, `null.x` type rows | V |
| Postfix: `sameLine`, `tailClosed`, `requireTarget` | `postfix[]`, `postfixSameLine` | `postfixOp` | `x\n++\ny`, `++x++` | V |
| Mixfix operand re-bind (`matchMixfixLed`): a failed `<L1> $ <L2> …` led retries its operand capped at each depth-0 L2 | `ledRebind`; `rbScan` (`src/rebind-family.ts`, one body for every form) | `PrattLowering.rebind` | `REBIND.ts` | V |
| Template literals: the template token carries its hole rule; a head commits to the chain | `Step tok` with `hole`, `nudTplHole`, `postfixTplHole` | `nudTpl`, `postfixTpl`, `matchTemplate*` | `TEMPLATE_STEPS` | V |
| `>`-composites: `>` `>` `=` are separate tokens, read as one operator where an operator is read | `gtComps`, `gtOpRead` | `_opLid` / `gt_op` | `a >>= b`, `let x = f<A<B>>(c);` | V |
| The empty node's offset (`offset()` with no children) | unreachable: `defineGrammar` refuses nullable rules except the entry | — | `''`, `'// c'` | V |

Not argued by the table: the interpreter's indent / markup / `noCommentBefore` mechanisms. Their
grammars are refused by the portable engine, so no comparison exists. Their argument is the
refusal, and an engine for those grammars owes its own rows. Indent becomes checkable when the
Python lane's offside layer reaches the portable engine: from then on its row is a V row, compared
on `python.ts` (the lists and conformance/cpython) as the others are.

## Where the record of each file lives

- JavaScript against its specification: test262's syntax tests, file by file:
  [TEST262.md](TEST262.md) (gate `conformance/test262`). (The former record against `tsc`'s
  JS-mode parser, `JS-CONFORMANCE.md`, was retired with its gate: test262 is the oracle.)
- The productions the JavaScript grammar is held to, with the cases where `tsc` departs:
  gate `conformance/js` ([`test/js-conformance.ts`](../test/js-conformance.ts)).
- The CST lowered to `tsc`'s AST and compared node by node (kind, start, end): gate
  `conformance/ts-ast-structure` ([`test/ts-ast-verify.ts`](../test/ts-ast-verify.ts)).
