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
| `var;`, `const;`, `var a,`, `let a, ;` | reject | accept | reject | A VariableDeclarationList / BindingList has one or more declarations and no trailing comma (14.3); `tsc`'s parser reads an empty list and a trailing comma and leaves both to the checker. `let;` is valid: the expression statement of the identifier `let` (sloppy mode), which `tsc` also reads. |
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

## Where the record of each file lives

- JavaScript against its specification: test262's syntax tests, file by file:
  [TEST262.md](TEST262.md) (gate `conformance/test262`). (The former record against `tsc`'s
  JS-mode parser, `JS-CONFORMANCE.md`, was retired with its gate: test262 is the oracle.)
- The productions the JavaScript grammar is held to, with the cases where `tsc` departs:
  gate `conformance/js` ([`test/js-conformance.ts`](../test/js-conformance.ts)).
- The CST lowered to `tsc`'s AST and compared node by node (kind, start, end): gate
  `conformance/ts-ast-structure` ([`test/ts-ast-verify.ts`](../test/ts-ast-verify.ts)).
