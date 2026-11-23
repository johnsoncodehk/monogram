// ─────────────────────────────────────────────────────────────────────────────
//  test262-classes.ts — the CAUSE CLASSES of the disagreements between `javascript.ts` and
//  test262's parse verdicts (test/test262.ts), each with the verdict on what should happen.
//
//  A class is a predicate over what test262 says about a test, not over our parse: the test's
//  path, its front matter (`flags`, `features`, `description`, `info`, `esid`) and its source
//  text. The first class whose predicate holds is the file's class, so the order below is the
//  order of precedence. Every class was read on a sample of its files; a disagreement no
//  predicate claims falls into `unknown-accept` / `unknown-reject`, which are classes with no
//  verdict: the gate fails while either is non-empty (read the file, then add or widen a class).
//
//  Verdicts:
//    grammar-bug   syntax no goal or mode of the language derives (or derivable syntax the grammar
//                  refuses): the grammar is wrong; owed to the grammar's lane
//    adding        valid syntax the grammar lacks, decided to be added (Stage 3 proposals, Annex B
//                  literals)
//    needs-parameter  depends on the script / module goal, strict mode, [Return] or another parameter the
//                  engine does not have yet (roadmap item 4: parameterised productions)
//    early-error   a static-semantic rule ("It is a Syntax Error if …" in an Early Errors clause):
//                  not the context-free grammar's (docs/CORRECTNESS.md) but a checker's over the
//                  tree, which is not built. Each such class states what that checker reads
//                  (`checker`): the tree alone (a node and its ancestors) or scope analysis (the
//                  names each scope declares); together they are the spec of that pass.
// ─────────────────────────────────────────────────────────────────────────────

export type Verdict = 'grammar-bug' | 'adding' | 'needs-parameter' | 'early-error' | 'unknown';
export interface TestInfo {
  path: string;          // relative to the corpus root: test/language/…
  flags: string[];
  features: string[];
  description: string;   // the front matter's `description` (its `info` quotes spec text wholesale, so no class reads it)
  src: string;           // the test's source text after the front matter
}
export interface CauseClass {
  id: string;
  direction: 'we-accept' | 'we-reject';
  verdict: Verdict;
  title: string;
  why: string;
  // An early-error class only (and every one has it): what the checker that enforces it reads.
  checker?: { needs: 'tree' | 'scope'; reads: string };
  match: (t: TestInfo) => boolean;
}

const has = (t: TestInfo, f: string) => t.features.includes(f);
const flag = (t: TestInfo, f: string) => t.flags.includes(f);
const inDir = (t: TestInfo, ...re: RegExp[]) => re.some((r) => r.test(t.path));
const says = (t: TestInfo, re: RegExp) => re.test(t.description);

export const CLASSES: CauseClass[] = [
  // ── WE-REJECT: valid JavaScript the grammar refuses ──
  {
    id: 'reject/annexb-html-comments', direction: 'we-reject', verdict: 'needs-parameter',
    title: 'HTML-like comments (Annex B)',
    why: '`<!--` and a line-leading `-->` are comments in script code only; in module code they are not comments (`a <!--b` is `a < !--b` there). Without the script / module goal, accepting them changes the meaning of valid module code.',
    match: (t) => inDir(t, /^test\/annexB\/language\/comments\//),
  },
  {
    id: 'reject/lexer-division-after-object-literal', direction: 'we-reject', verdict: 'grammar-bug',
    title: 'a `/` after an object literal\'s `}` is lexed as a regular expression',
    why: '`f({ a: 1 } / 2n, "/")`: after a `}` the lexer reads `/` as a regular expression (a `}` that ends a block or a function body is followed by a regex), but this `}` ends an object literal, a value. Which `}` it is, is the parser\'s knowledge: the lexer\'s regex / division choice needs that context (the lexer lane\'s; the `/` after a hex / octal / binary number was the same class\'s other cause, fixed).',
    match: (t) => inDir(t, /^test\/language\/expressions\/division\/bigint-(toprimitive|wrapped-values)\.js$/),
  },
  {
    id: 'reject/lexer-optional-chain-before-digit', direction: 'we-reject', verdict: 'grammar-bug',
    title: '`?.` before a decimal digit is `?` and a number',
    why: '`true ?.30 : false`: OptionalChainingPunctuator is `?. [lookahead ∉ DecimalDigit]`.',
    match: (t) => inDir(t, /optional-chaining\/punctuator-decimal-lookahead\.js$/),
  },
];

// ── WE-ACCEPT: test262 says SyntaxError, the grammar parses ──
// Grammar bugs first: each is syntax that no goal or mode derives, so no mode-dependent class may
// claim it. Then the classes that wait on a parameter the engine lacks. Then the early errors,
// most specific first.
const WE_ACCEPT: CauseClass[] = [
  // grammar bugs
  {
    id: 'accept/declaration-in-statement-position', direction: 'we-accept', verdict: 'grammar-bug',
    title: 'a declaration where only a Statement may stand',
    why: '`while (x) function f() {}`, `if (x) class C {}`, `for (;;) const y = 1`, `label: async function f() {}`: the body of if / while / for / with / a label is a Statement, and Statement has no Declaration (Annex B adds only the sloppy `if (x) function f() {}` and `label: function f() {}`). The grammar puts Decl in Stmt.',
    match: (t) => says(t, /in statement positions?\b/i) && !flag(t, 'onlyStrict'),
  },
  {
    id: 'accept/let-bracket-lookahead', direction: 'we-accept', verdict: 'grammar-bug',
    title: '`let` ⏎ `[` in statement position',
    why: '`for (;;) let⏎[a] = 0;`: an ExpressionStatement may not begin with `let [`, and a LexicalDeclaration is no Statement, so no production derives it.',
    match: (t) => says(t, /lookahead restriction for `let \[`/),
  },
  {
    id: 'accept/restricted-production-line-break', direction: 'we-accept', verdict: 'grammar-bug',
    title: 'a line break where a production says [no LineTerminator here]',
    why: '`throw⏎1`, `x⏎=> 1`, `async x⏎=> 1`: the restricted productions forbid the line break, and no ASI applies.',
    match: (t) => inDir(t, /^test\/language\/asi\//) || says(t, /\[no LineTerminator here\]|LineTerminator between|line terminator between|newline (may not|between|before)|followed by a line ?terminator|throw \\n/i),
  },
  {
    id: 'accept/rest-element-shape', direction: 'we-accept', verdict: 'grammar-bug',
    title: 'a rest element with an initializer, a trailing comma, or a follower',
    why: '`function f(...a = 1) {}`, `function f(...a,) {}`, `var [...a, b] = c`, `({...a,} = b)` in binding position: FunctionRestParameter and BindingRestElement are `... BindingIdentifier | ... BindingPattern`, last, with no Initializer and no comma after.',
    match: (t) => says(t, /RestParameter does not support an initializer|Rest element .*may not be followed|rest parameter.*(initializer|trailing comma)|FunctionRestParameter is followed by a trailing comma|BindingRestElement|Rest parameter cannot be followed|Includes \.\.\.rest/i),
  },
  {
    id: 'accept/using-binding-pattern', direction: 'we-accept', verdict: 'grammar-bug',
    title: 'a binding pattern in a `using` / `await using` declaration list',
    why: '`using x = 1, [a] = b`: a `using` LexicalBinding is a BindingIdentifier (`BindingList[~Pattern]`); only a leading `using [` is an expression (element access).',
    match: (t) => has(t, 'explicit-resource-management') && says(t, /BindingPattern/),
  },
  {
    id: 'accept/for-in-of-initializer', direction: 'we-accept', verdict: 'grammar-bug',
    title: 'an initializer in a for-in / for-of head',
    why: '`for (let x = 1 of y)`, `for (var [a] = 1 of y)`, `for (let x = 1 in o)`, `for (x = 1 in o)`: ForInOfStatement has no initializer; Annex B (B.3.5) adds only the sloppy `for (var BindingIdentifier Initializer in Expression)`.',
    match: (t) => inDir(t, /^test\/annexB\/language\/statements\/for-in\//, /for-in\/disallow-initialization-assignment\.js$/) || says(t, /for-in (heads|initiali[sz]ers)|Initializer is not allowed in head|does not (allow|support an) initiali[sz]er/i),
  },
  {
    id: 'accept/hashbang-position', direction: 'we-accept', verdict: 'grammar-bug',
    title: 'a hashbang comment that does not start the source text',
    why: '`x⏎#!/y`: a HashbangComment is the first thing in a Script or Module only. The Shebang token\'s start() anchor admits any line start.',
    match: (t) => inDir(t, /^test\/language\/comments\/hashbang\//),
  },
  {
    id: 'accept/accessor-parameters', direction: 'we-accept', verdict: 'grammar-bug',
    title: 'a getter with a parameter',
    why: '`get x(a) {}`: a getter\'s parameter list is `( )`; a setter has exactly one PropertySetParameterList.',
    match: (t) => says(t, /Get accessor method may not have a formal parameter|setter .*exactly one/i),
  },
  {
    id: 'accept/coalesce-mixed-with-logical', direction: 'we-accept', verdict: 'grammar-bug',
    title: '`??` mixed with `&&` / `||` without parentheses',
    why: '`0 && 0 ?? true`, `a ?? b || c`: CoalesceExpression\'s operands are BitwiseORExpressions, so neither side may be a bare `&&` / `||`.',
    match: (t) => inDir(t, /\/expressions\/coalesce\/cannot-chain-/),
  },
  {
    id: 'accept/in-operator-in-for-init', direction: 'we-accept', verdict: 'grammar-bug',
    title: '`in` inside a for-statement initializer\'s nested expression',
    why: '`for (true ? 0 : 0 in {};;)`: the initializer is an Expression[~In] and ConditionalExpression passes ?In to both branches.',
    match: (t) => says(t, /(cannot|may not) include the `in` keyword/i),
  },
  {
    id: 'accept/yield-precedence', direction: 'we-accept', verdict: 'grammar-bug',
    title: '`yield` parsed as a prefix operator',
    why: '`yield 3 + yield 4`, `yield ? a : b`, `yield = 1` in a generator: YieldExpression is an AssignmentExpression alternative, not a UnaryExpression; the grammar lists `yield` with the prefix operators.',
    match: (t) => says(t, /`yield` expressions (are not LogicalOrExpressions|bind weakly)|YieldExpression is not a valid LeftHandSideExpression/i),
  },
  {
    id: 'accept/switch-statement-outside-clause', direction: 'we-accept', verdict: 'grammar-bug',
    title: 'a statement in a switch body before any `case`',
    why: '`switch (x) { a = 2; case 0: }`: a CaseBlock holds CaseClauses and a DefaultClause only; the grammar\'s SwitchCase rule has a bare Stmt arm.',
    match: (t) => says(t, /not followed by "case"/i),
  },
  {
    id: 'accept/numeric-literal-lexical', direction: 'we-accept', verdict: 'grammar-bug',
    title: 'a numeric literal the lexical grammar does not derive',
    why: '`1._5`, `1._e1`: the literal is the longest one (`1.`), and an IdentifierStart may not follow it; the token backs up to `1` and lexes `._5` as a member. Refusing the back-up makes these lex errors, after which the portable lexers\' relex of an edit before the error keeps it (`x = 1._x;` with `.` inserted: edited rejects, fresh accepts): owed to the lexer lane.',
    match: (t) => inDir(t, /^test\/language\/literals\/(numeric|bigint)\//) && !flag(t, 'onlyStrict'),
  },
  // waiting on a parameter the engine lacks
  {
    id: 'accept/use-strict-with-non-simple-parameters', direction: 'we-accept', verdict: 'early-error',
    checker: { needs: 'tree', reads: "a function node: its parameter list's shape and its body's directive prologue" },
    title: '"use strict" in a function with a non-simple parameter list',
    why: 'Early error: ContainsUseStrict of the body is true and IsSimpleParameterList is false.',
    match: (t) => says(t, /ContainsUseStrict|IsSimpleParameterList|non-?simple param|Use Strict Directive are not allowed to coexist/i),
  },
  {
    id: 'accept/strict-mode', direction: 'we-accept', verdict: 'needs-parameter',
    title: 'strict mode code',
    why: 'Valid in sloppy mode, an error in strict code (reserved words `let` / `static` / `implements` / `yield` …, `with`, legacy octal literals and escapes, `delete x`, `eval` / `arguments` as targets or bindings, duplicate parameters, Annex B\'s `if (x) function f() {}`; class bodies are strict). Without a strict mode switch the grammar accepts the sloppy reading.',
    match: (t) => flag(t, 'onlyStrict') || says(t, /strict mode|strict code|strict function|use strict|within classes|FormalParameters contains (arguments|eval)|is not a valid class-name identifier|observes the `Yield` production parameter/i),
  },
  {
    id: 'accept/import-export-not-top-level', direction: 'we-accept', verdict: 'grammar-bug',
    title: 'an import / export declaration inside a statement or expression',
    why: '`{ import v from "m"; }`, `function* g() { export default null; }`: ImportDeclaration and ExportDeclaration are ModuleItems, at a module\'s top level only, in no goal anywhere else. The grammar puts them in Decl, which every block reaches.',
    match: (t) => says(t, /cannot contain an `(import|export)` declaration/),
  },
  {
    id: 'accept/return-outside-function', direction: 'we-accept', verdict: 'needs-parameter',
    title: '`return` outside a function',
    why: 'ReturnStatement is a Statement[+Return] only: script top level and class static blocks are [~Return]. The engine has no [Return] parameter.',
    match: (t) => says(t, /\breturn\b/i) && says(t, /global code|no function|outside|static init|within "try"|catch Block|"Return" parsing context/i) || says(t, /ReturnStatement may not be used/),
  },
  // early errors
  {
    id: 'accept/escaped-keyword', direction: 'we-accept', verdict: 'early-error',
    checker: { needs: 'tree', reads: "an identifier token: its escape-decoded text against the reserved words, with the enclosing function kind for `await` / `yield`" },
    title: 'a keyword written with a Unicode escape',
    why: 'Early error: an IdentifierName whose escapes spell a reserved word is neither that keyword nor an identifier (`v\\u0061r x`, `\\u0061sync function f() {}`, `yi\\u0065ld` in a generator).',
    match: (t) => ((says(t, /escape/i) || inDir(t, /escape/)) && (says(t, /keyword|reserved|contextual/i) || inDir(t, /escaped/))) || says(t, /must not contain escape sequences/),
  },
  {
    id: 'accept/await-yield-binding-identifier', direction: 'we-accept', verdict: 'early-error',
    checker: { needs: 'tree', reads: "a binding name and its enclosing function kinds (async, generator, static block)" },
    title: '`await` / `yield` as a binding name in an async function / generator',
    why: 'Early error: BindingIdentifier derives `yield` and `await`, and "It is a Syntax Error if this production has a [Yield] / [Await] parameter". The grammar keeps them names at binding position, as tsc\'s parser does.',
    match: (t) => says(t, /\b(await|yield)\b/i) && says(t, /binding identifier|BindingIdentifier|binding name|as a parameter|as an identifier in functions nested/i),
  },
  {
    id: 'accept/await-yield-identifier-reference', direction: 'we-accept', verdict: 'grammar-bug',
    title: '`await` / `yield` as an identifier reference or a label where the context forbids it',
    why: 'IdentifierReference and LabelIdentifier are `[~Yield] yield` / `[~Await] await`, parameterised productions the engine has ([Await]/[Yield] families): `({await})` in an async function, `({yield})` in a generator, `yield: ;` in a generator, `await` in a class static block.',
    match: (t) => says(t, /\b(await|yield)\b/i) && says(t, /identifier ?reference|IdentifierReference|label identifier|static block|static init/i),
  },
  {
    id: 'accept/await-yield-in-parameters', direction: 'we-accept', verdict: 'early-error',
    checker: { needs: 'tree', reads: "a parameter list: does it contain a YieldExpression / AwaitExpression outside a nested function" },
    title: 'an `await` / `yield` expression in formal parameters',
    why: 'Early error: FormalParameters Contains YieldExpression / AwaitExpression.',
    match: (t) => says(t, /(Yield|Await)Expression|contains (await|yield)|may not contain the `yield` keyword/i) && says(t, /FormalParameters|parameter/i),
  },
  {
    id: 'accept/regexp-pattern', direction: 'we-accept', verdict: 'early-error',
    checker: { needs: 'tree', reads: "a regular-expression token: its body against the Pattern grammar, its flags against the flag set" },
    title: 'a regular expression\'s pattern or flags',
    why: 'Early error: the body must parse with the Pattern grammar (named groups, quantifiers, class escapes, `u` / `v` rules) and the flags must be known and unique. The token reads any body and flag run.',
    match: (t) => inDir(t, /^test\/language\/literals\/regexp\//) || says(t, /regular expression|RegExp/),
  },
  {
    id: 'accept/assignment-target', direction: 'we-accept', verdict: 'early-error',
    checker: { needs: 'tree', reads: "the left side of an assignment, an update or a for-in/of head: AssignmentTargetType, and the refinement of a literal to an AssignmentPattern" },
    title: 'an invalid assignment target, or a literal that does not cover an AssignmentPattern',
    why: 'Early error: AssignmentTargetType is not simple (`1 = 2`, `a?.b = 1`, `f() += 1`, `++this`), or an ObjectLiteral / ArrayLiteral on the left of `=` / in a for-in/of head does not refine to an AssignmentPattern (`[...a, b] = c`, `({a: 1} = b)`). The parser enforces the LeftHandSideExpression shape only (docs/CORRECTNESS.md).',
    match: (t) => !says(t, /using escape/) && inDir(t, /\/assignmenttargettype\//) || !says(t, /using escape/) && says(t, /AssignmentTargetType|IsValidSimpleAssignmentTarget|assignment target|DestructuringAssignmentTarget|AssignmentRestElement|AssignmentElement|AssignmentPattern|AssignmentProperty|simple assignment|invalid (destructuring )?assignment|valid reference|write context|execution of "[^"]*=[^"]*" fails|non-simple target|Applied to (assignment|a "covered" YieldExpression)|cannot be target of assignment|AssginmentTargetType/i),
  },
  {
    id: 'accept/arguments-in-class-field', direction: 'we-accept', verdict: 'early-error',
    checker: { needs: 'tree', reads: "a field initializer: does it contain `arguments` outside a non-arrow function" },
    title: '`arguments` in a class field initializer',
    why: 'Early error: ContainsArguments of a field\'s Initializer.',
    match: (t) => says(t, /arguments/) && says(t, /class field|field/i),
  },
  {
    id: 'accept/super-new-target', direction: 'we-accept', verdict: 'early-error',
    checker: { needs: 'tree', reads: "a `super` / `new.target` node and its enclosing function and method kinds" },
    title: '`super` and `new.target` outside their contexts',
    why: 'Early error: SuperCall outside a derived constructor, SuperProperty outside a method, `new.target` outside a function.',
    match: (t) => says(t, /\bsuper\b|SuperCall|SuperProperty|HasDirectSuper|new\.target/i),
  },
  {
    id: 'accept/private-names', direction: 'we-accept', verdict: 'early-error',
    checker: { needs: 'scope', reads: "the private names each class declares, resolved through the enclosing classes (duplicates, getter / setter pairing, undeclared uses), plus `delete` of a private reference" },
    title: 'private names',
    why: 'Early error: a `#name` declared twice, used without a declaration in an enclosing class, `#constructor`, `delete this.#x`.',
    match: (t) => !says(t, /`arguments` used|`super(\(\))?` used/) && says(t, /private (instance|static|name|identifier|field|member|environment|getter|setter|method.*(twice|same|duplicate|conflict))|PrivateName|PrivateIdentifier|PrivateBoundIdentifiers|AllPrivateIdentifiersValid|#constructor|delete.*private|\#\w+ (is not|not) (defined|declared)/i) || inDir(t, /early-errors\/(delete|invalid-names)\//),
  },
  {
    id: 'accept/duplicate-bindings', direction: 'we-accept', verdict: 'early-error',
    checker: { needs: 'scope', reads: "the declared names of every block, function, switch and module scope: LexicallyDeclaredNames against themselves and against VarDeclaredNames, and parameter names" },
    title: 'duplicate or conflicting declarations',
    why: 'Early error: LexicallyDeclaredNames with a duplicate, or one that also occurs in VarDeclaredNames (`let a; var a`, `let a; let a`, a `catch (e)` with `let e` in its block, duplicate parameters where they are not allowed).',
    match: (t) => says(t, /redeclar|duplicate|BoundNames|LexicallyDeclaredNames|VarDeclaredNames|already (been )?declared|lexical shadowing|re-declare|lexically-scoped binding and function-scoped binding/i) || inDir(t, /\/redeclaration\//),
  },
  {
    id: 'accept/labels-break-continue', direction: 'we-accept', verdict: 'early-error',
    checker: { needs: 'tree', reads: "a statement and its enclosing labels and iteration / breakable statements, stopping at function and static-block boundaries" },
    title: 'labels, `break` and `continue`',
    why: 'Early error: an undefined or duplicate label, `continue` outside an iteration, `break` outside a breakable statement, IsLabelledFunction.',
    match: (t) => says(t, /label|\bcontinue\b|\bbreak\b|IterationStatement/i) || inDir(t, /^test\/language\/statements\/(break|continue|labeled)\//),
  },
  {
    id: 'accept/class-element-names', direction: 'we-accept', verdict: 'early-error',
    checker: { needs: 'tree', reads: "a class body: element names and kinds (`constructor`, `prototype`, a second constructor)" },
    title: 'class elements named `constructor` / `prototype`',
    why: 'Early error: a special method (getter, setter, generator, async) or field named `constructor`, a static element named `prototype`, two constructors.',
    match: (t) => says(t, /constructor|prototype/i),
  },
  {
    id: 'accept/cover-initialized-name', direction: 'we-accept', verdict: 'early-error',
    checker: { needs: 'tree', reads: "an object literal not refined to an AssignmentPattern: does it contain a CoverInitializedName" },
    title: 'a CoverInitializedName in an object literal',
    why: 'Early error: `({ a = 1 })` is matched by the cover grammar for `({ a = 1 } = b)` and is an error unless it refines to an AssignmentPattern.',
    match: (t) => says(t, /Initialized name is explicitly barred|CoverInitializedName/i),
  },
  {
    id: 'accept/template-escape', direction: 'we-accept', verdict: 'early-error',
    checker: { needs: 'tree', reads: "an untagged template token: does it contain a NotEscapeSequence" },
    title: 'a NotEscapeSequence in an untagged template',
    why: 'Early error: "It is a Syntax Error if the [Tagged] parameter was not set and NotEscapeSequence is matched" (`\\9`, `\\u{`, `\\x0`).',
    match: (t) => inDir(t, /\/template-literal\//) && says(t, /escape/i),
  },
  {
    id: 'accept/optional-chain-template', direction: 'we-accept', verdict: 'early-error',
    checker: { needs: 'tree', reads: "an optional chain: is a template literal applied to it" },
    title: 'a template after an optional chain',
    why: 'Early error: `OptionalChain :: ?. TemplateLiteral` and `OptionalChain TemplateLiteral` are productions with "It is a Syntax Error if any source text is matched by this production" (`a?.b\`x\``).',
    match: (t) => inDir(t, /\/optional-chaining\//) && says(t, /template/i),
  },
  {
    id: 'accept/declaration-without-initializer', direction: 'we-accept', verdict: 'early-error',
    checker: { needs: 'tree', reads: "a `const` / `using` binding: does it have an initializer (outside a for-in/of head)" },
    title: '`const` / `using` without an initializer',
    why: 'Early error: a LexicalBinding without an Initializer when IsConstantDeclaration (`const x;`) or IsUsingDeclaration (`using x;`).',
    match: (t) => says(t, /without (an )?initiali[sz]er|declarations mixed: (with, )?without/i),
  },
  {
    id: 'accept/static-block-contexts', direction: 'we-accept', verdict: 'early-error',
    checker: { needs: 'tree', reads: "a class static block: does it contain `arguments` or an AwaitExpression outside a nested function" },
    title: '`arguments`, `await` and `yield` in a class static block',
    why: 'Early error: ContainsArguments / ContainsAwait of ClassStaticBlockStatementList, and `yield` / `await` reserved there by the block\'s own [~Yield, +Await] context.',
    match: (t) => says(t, /Block cannot use `arguments`|"(Await|Yield)" parsing context does not apply/),
  },
  {
    id: 'accept/using-placement', direction: 'we-accept', verdict: 'early-error',
    checker: { needs: 'tree', reads: "a `using` declaration and its parent: a case / default clause directly" },
    title: 'a `using` declaration directly in a switch clause',
    why: 'Early error: a CaseClause / DefaultClause StatementList may not contain a UsingDeclaration or AwaitUsingDeclaration.',
    match: (t) => has(t, 'explicit-resource-management') && says(t, /switch statement/i),
  },
  {
    id: 'accept/let-as-lexical-name', direction: 'we-accept', verdict: 'early-error',
    checker: { needs: 'tree', reads: "a lexical declaration's bound names: is one of them `let`" },
    title: '`let` as a lexically bound name',
    why: 'Early error: BoundNames of a LexicalDeclaration or ForDeclaration contains "let" (`const let = 1`, `for (let let in o)`).',
    match: (t) => says(t, /binding for `let`|\|const let\||\|let let\|/),
  },
  // Last: what no early-error class above claims and the Module goal alone rejects.
  {
    id: 'accept/module-goal', direction: 'we-accept', verdict: 'needs-parameter',
    title: 'module code',
    why: 'Valid in a script, an error in module code: `await` as an identifier, module code is strict, top-level `new.target` / `super`, import / export / `import.meta` in a Script. Without the script / module goal the grammar accepts the script reading.',
    match: (t) => flag(t, 'module') || says(t, /ScriptBody|goal symbol is Script|top level of a Script/i),
  },
];

// The classes no predicate claims: read the file, then add or widen a class above.
export const UNKNOWN: Record<'we-accept' | 'we-reject', CauseClass> = {
  'we-accept': { id: 'accept/unknown', direction: 'we-accept', verdict: 'unknown', title: 'unclassified', why: 'no class claims these: read them', match: () => true },
  'we-reject': { id: 'reject/unknown', direction: 'we-reject', verdict: 'unknown', title: 'unclassified', why: 'no class claims these: read them', match: () => true },
};

CLASSES.push(...WE_ACCEPT);
for (const c of CLASSES) {
  if ((c.verdict === 'early-error') !== !!c.checker) throw new Error(`${c.id}: an early-error class states its checker, and no other class does`);
}

export const classify = (t: TestInfo, direction: 'we-accept' | 'we-reject'): CauseClass =>
  CLASSES.find((c) => c.direction === direction && c.match(t)) ?? UNKNOWN[direction];
