/**
 * typescript grammar — ESTree-ish declarative shape sample.
 *
 * Aligns with the demoBuilder in test/shape-parity.ts where that demo has an opinion
 * (drop punct/keyword/ops; Program.body; BlockStatement; ExpressionStatement;
 * BinaryExpression heuristics). Rules the demo never touches get a reasoned
 * mapping (node/list/choice/pratt/keep/custom) — NEVER silent custom without
 * a why-primitives-fail argument.
 *
 * Keys are the IR rule names: one per grammar rule.
 */
import type { ShapeSpec, CustomShape, StreamType } from '../../src/shape-schema.ts';

const custom = (fn: string, reason: string, extra?: { types?: StreamType[]; opMap?: Record<string, string> }): CustomShape => ({ kind: 'custom', fn, reason, ...extra });

/** Shared leaf policy ≈ demoBuilder DROP_LEAF + payload leafValues. */
const leaves: ShapeSpec['leaves'] = {
  $punct: { action: 'drop' },
  $keyword: { action: 'drop' },
  $operator: { action: 'drop' },
  $templateHead: { action: 'drop' },
  $templateMiddle: { action: 'drop' },
  $templateTail: { action: 'drop' },
  Ident: { action: 'leafValue', fn: 'ident' },
  PrivateField: { action: 'leafValue', fn: 'ident' },
  Number: { action: 'leafValue', fn: 'number' },
  HexNumber: { action: 'leafValue', fn: 'number' },
  OctalNumber: { action: 'leafValue', fn: 'number' },
  BinaryNumber: { action: 'leafValue', fn: 'number' },
  BigInt: { action: 'leafValue', fn: 'bigint' },
  String: { action: 'leafValue', fn: 'string' },
  Template: { action: 'leafValue', fn: 'string' }, // no-subst → pratt.template slot when declared
  Regex: { action: 'leafValue', fn: 'string' },
  Decorator: { action: 'leafValue', fn: 'ident' },
  Shebang: { action: 'drop' },
  JSDoc: { action: 'drop' },
  TripleSlash: { action: 'drop' },
  LineComment: { action: 'drop' },
  BlockComment: { action: 'drop' },
};

export const typescriptShape: ShapeSpec = {
  grammar: 'typescript',
  spans: 'optional',
  unmapped: 'error',
  leaves,
  rules: {
    // ─── Entry / containers (demo-aligned) ─────────────────────────────
    Program: {
      kind: 'node',
      type: 'Program',
      // IR: star(alt(Decl|Stmt)) → single list slot
      fields: [{ name: 'body', bind: { from: 'list', of: 0 }, typeHint: 'Statement' }],
    },
    Block: {
      kind: 'node',
      type: 'BlockStatement',
      // IR: `{` star(Stmt) `}` → after punct drop: star
      fields: [{ name: 'body', bind: { from: 'list', of: 0 }, typeHint: 'Statement' }],
    },

    // ─── Stmt (19 alts) — demo maps most to ExpressionStatement heuristically;
    // full ESTree needs per-alt product types + comma-expr folding.
    Stmt: {
      kind: 'custom',
      fn: 'estreeStmt',
      types: [
        'BlockStatement', 'VariableDeclaration', 'IfStatement', 'ForStatement',
        'WhileStatement', 'DoWhileStatement', 'SwitchStatement', 'ReturnStatement',
        'ThrowStatement', 'BreakStatement', 'ContinueStatement', 'TryStatement',
        'LabeledStatement', 'EmptyStatement', 'DebuggerStatement', 'WithStatement',
        'VariableDeclaration', { passthrough: true }, 'ExpressionStatement',
      ],
      folds: [{ tag: 'switch-consequent', into: 'consequent' }],
      reason:
      'Stmt has 19 RD alts (if/for/while/do/switch/return/throw/try/break/continue/' +
      'labeled/empty/debugger/with/using/Decl/ExprStmt/…) each a distinct ESTree Statement ' +
      'subtype. Several alts embed `Expr star(, Expr)` (comma expression) and ASI-terminator ' +
      'alts (`;` | not sameLine | not not `}`) that are zero-width-or-punct and collapse ' +
      'differently per arm. choice()+node() can name the products but cannot express ' +
      '“fold trailing comma-seq into SequenceExpression” or “ASI alt is not a kid” without ' +
      'a runtime fold — that fold IS a handwritten builder. demoBuilder itself special-cases ' +
      'Stmt → ExpressionStatement; a faithful ESTree Stmt map stays custom.',
    },

    // Decl (26 alts) — same class of problem, worse.
    Decl: custom('estreeDecl',
      'Decl has 26 RD alts covering function*/async/interface/type/class/enum/declare/' +
      'namespace/module/export-default/export-star/import/… with deep nested alts ' +
      '(export default alone inlines 8 function/class forms). Product types differ per arm; ' +
      'several arms WRAP another Decl/Stmt (`export Decl`, `declare Decl`) needing unwrap/' +
      'flag injection. choice() would need ≥20 arms each with multi-optional field binds ' +
      'that still cannot derive `async`/`generator`/`declare` boolean flags from dropped ' +
      'keyword leaves (keywords are dropped globally — their presence must be recovered ' +
      'from which alt matched, i.e. builder logic). Primitives lack alt-identity → flag ' +
      'mapping.', {
        types: [
          'FunctionDeclaration', 'FunctionDeclaration', 'FunctionDeclaration', 'FunctionDeclaration',
          'TSInterfaceDeclaration', 'TSTypeAliasDeclaration', 'ClassDeclaration',
          'Declaration', 'Declaration', 'Declaration', 'Declaration', 'Declaration', 'Declaration', 'Declaration',
          'FunctionDeclaration', 'ExportNamedDeclaration', 'ExportNamedDeclaration', 'ExportNamedDeclaration', 'ExportNamedDeclaration',
          'ExportDefaultDeclaration', 'ImportDeclaration', 'TSImportEqualsDeclaration',
          'TSModuleDeclaration', 'TSModuleDeclaration', 'TSNamespaceExportDeclaration', 'TSEnumDeclaration',
        ],
      }),

    // ─── Expr (Pratt) — demo BinaryExpression heuristics; real ESTree needs more ─
    Expr: {
      kind: 'pratt',
      atom: { kind: 'keep' },
      // `( Expr )` grouping-ish nudBracket first="(" also covers comma-seq — not pure group.
      group: custom('estreeParenOrComma',
        'nudBracket "(" steps are `Expr star(, Expr)` — after punct drop the kid list is ' +
        '1..N expressions. Pure inline is only correct for N=1; N>1 must become ' +
        'SequenceExpression. Distinguishing N at shape-spec time needs a runtime arity ' +
        'branch — custom.', { types: [{ parenOrComma: true }] }),
      prefix: custom('estreeExprPrefix',
        'Prefix ++/-- must be UpdateExpression(prefix:true); other ops stay UnaryExpression. ' +
        'A single declarative UnaryExpression node cannot branch on opText.', {
        opMap: {
          '!': 'UnaryExpression', '~': 'UnaryExpression', '+': 'UnaryExpression', '-': 'UnaryExpression',
          'typeof': 'UnaryExpression', 'void': 'UnaryExpression', 'delete': 'UnaryExpression',
          'await': 'UnaryExpression', 'yield': 'UnaryExpression', '++': 'UpdateExpression', '--': 'UpdateExpression',
        },
      }),
      binary: custom('estreeExprBinary',
        'Expr binary covers assignment (= += … ??= ||= &&=), logical (?? || &&), and relational/' +
        'arithmetic ops — three ESTree families (AssignmentExpression / LogicalExpression / ' +
        'BinaryExpression). Declarative BinaryExpression alone mis-types assignments and logicals.', {
        opMap: {
          '=': 'AssignmentExpression', '+=': 'AssignmentExpression', '-=': 'AssignmentExpression', '*=': 'AssignmentExpression',
          '/=': 'AssignmentExpression', '%=': 'AssignmentExpression', '**=': 'AssignmentExpression', '<<=': 'AssignmentExpression',
          '>>=': 'AssignmentExpression', '>>>=': 'AssignmentExpression', '&=': 'AssignmentExpression', '|=': 'AssignmentExpression',
          '^=': 'AssignmentExpression', '??=': 'AssignmentExpression', '||=': 'AssignmentExpression', '&&=': 'AssignmentExpression',
          '??': 'LogicalExpression', '||': 'LogicalExpression', '&&': 'LogicalExpression',
          '|': 'BinaryExpression', '^': 'BinaryExpression', '&': 'BinaryExpression', '==': 'BinaryExpression',
          '!=': 'BinaryExpression', '===': 'BinaryExpression', '!==': 'BinaryExpression', '<': 'BinaryExpression',
          '>': 'BinaryExpression', '<=': 'BinaryExpression', '>=': 'BinaryExpression', '<<': 'BinaryExpression',
          '>>': 'BinaryExpression', '>>>': 'BinaryExpression', '+': 'BinaryExpression', '-': 'BinaryExpression',
          '*': 'BinaryExpression', '/': 'BinaryExpression', '%': 'BinaryExpression', '**': 'BinaryExpression',
        },
      }),
      postfix: {
        kind: 'node',
        type: 'UpdateExpression',
        fields: [
          { name: 'operator', bind: 'opText', typeHint: 'string' },
          { name: 'argument', bind: { at: 0 }, typeHint: 'Expression' },
        ],
      },
      // leds: typed call / instantiation / call / member / optional / index / non-null /
      // ternary / as / instanceof / in / satisfies — all different product types
      led: custom('estreeExprLed',
        'Expr has 12 mixfix LED shapes (typed call/tag, bare instantiation, call, member `.`, ' +
        'optional `?.`, index `[]`, non-null `!`, ternary `?`, `as`, `instanceof`, `in`, ' +
        '`satisfies`) plus assignment/logical family on binary and optional Template postfixTok. ' +
        'Each LED yields a different ESTree node (CallExpression / MemberExpression / ' +
        'ConditionalExpression / TSAsExpression / TSSatisfiesExpression / BinaryExpression / ' +
        'TSNonNullExpression / TaggedTemplateExpression) with different field layouts. ' +
        'A single pratt.led node(fields) cannot branch on connector/alt; needs custom.', {
        types: [
          'CallExpression', 'TSInstantiationExpression', 'CallExpression', 'MemberExpression', { optionalChain: true },
          'MemberExpression', 'TSNonNullExpression', 'ConditionalExpression', 'TSAsExpression', 'BinaryExpression',
          'BinaryExpression', 'TSSatisfiesExpression',
        ],
      }),
      nudSeq: custom('estreeExprNudSeq',
        'nudSeq covers bare Ident + decorated class expressions — product types Ident vs ' +
        'ClassExpression; class arm has star(Decorator) + many opt type-params/heritage/' +
        'members. Not a fixed field bind.', { types: [{ passthrough: true }, 'ClassExpression', 'ClassExpression'] }),
      nudCapped: custom('estreeArrow',
        'nudCapped are ArrowFunctionExpression forms (async/params/return-type/body). ' +
        'Params are sep(Param) and body is Block|Expr alt; flag async from leading keyword ' +
        '(dropped). Requires handwritten assembly.', { types: ['ArrowFunctionExpression', 'ArrowFunctionExpression', 'ArrowFunctionExpression', 'ArrowFunctionExpression', 'UnaryExpression'] }),
      postfixTok: custom('estreeExprPostfixTok',
        'postfixTok Template on Expr is TaggedTemplateExpression (tag=left, quasi=TemplateLiteral); ' +
        'keep would leave a raw Expr children pair.', { types: ['TaggedTemplateExpression'] }),
      template: custom('estreeTemplateLiteral',
        'Template literal kids are head, expr, optional middle/expr pairs, then tail ' +
        '(or a lone no-subst leaf). ESTree needs TemplateLiteral with quasis and ' +
        'expressions; keep would leave raw $template children. Hole accept/AST both ' +
        'use the rule the template reference declares (≡ CST).', { types: ['TemplateLiteral'] })
    },

    // Type system Pratt — no demo coverage; ESTree/TS uses different node set
    Type: {
      kind: 'pratt',
      atom: { kind: 'keep' },
      // IR encodes `| Type` / `& Type` as nudBrackets (not binary ops) — verified via dump.
      group: custom('tsTypeLed',
        'Type group identities are heterogeneous; object-type group 7 lowers to TSTypeLiteral and ' +
        'mapped-type group 24 to TSMappedType, ' +
        'while other groups retain their explicit Type wrapper. C7 dispatches group vs LED ' +
        'by whether opText is present.', {
        types: ['Type', 'Type', 'Type', 'Type', 'Type', 'Type', 'Type', 'Type', 'Type', 'Type', 'Type', 'Type',
                'Type', 'Type', 'Type', 'Type', 'Type', 'Type', 'Type', 'Type', 'Type', 'Type', 'Type', 'Type',
                'Type'],
      }),
      led: custom('tsTypeLed',
        'Type LEDs include conditional/indexed/keyof-style continuations with ' +
        'heterogeneous field shapes; keep covers atoms only. LED connector→node ' +
        'dispatch needs custom (same argument as Expr.led).', {
        types: ['Type', 'Type', 'Type', 'Type', 'Type', 'Type', 'Type', 'Type', 'Type', 'Type'],
      }),
      nudSeq: { kind: 'keep' },
    },
    TypeofRef: {
      kind: 'pratt',
      atom: { kind: 'keep' },
      led: { kind: 'keep' },
      group: { kind: 'inline' },
    },
    NewTarget: {
      kind: 'pratt',
      atom: { kind: 'keep' },
      group: { kind: 'inline' },
      // The callee's identifier is reserved-guarded as Expr's is (`new if()` has no derivation),
      // so it is a nudSeq slot: inlined, the identifier as the atom was.
      nudSeq: { kind: 'inline' },
      led: custom('estreeNewTargetLed',
        'NewTarget LEDs (`.` Ident / `[` Expr `]`) produce MemberExpression vs ' +
        'the `new.target` meta special-case when the left root is the `new` `.` `target` ' +
        'NUD — detecting that root requires looking at left leaf text, not a fixed field bind. ' +
        'The typed tag `<T>` Template is a TaggedTemplateExpression with typeArguments.', {
        types: ['MemberExpression', 'MemberExpression', 'TaggedTemplateExpression'],
      }),
      // A template in the callee is the same product as in Expr: `new tag`x`()` constructs a
      // TaggedTemplateExpression, `new `x`()` a TemplateLiteral.
      postfixTok: custom('estreeExprPostfixTok',
        'postfixTok Template on NewTarget is TaggedTemplateExpression (tag=left, quasi=TemplateLiteral), ' +
        'as on Expr.', { types: ['TaggedTemplateExpression'] }),
      template: custom('estreeTemplateLiteral',
        'A template callee is a TemplateLiteral with quasis and expressions, as on Expr.', { types: ['TemplateLiteral'] }),
    },
    ClassHeritage: {
      kind: 'pratt',
      atom: { kind: 'keep' },
      led: { kind: 'keep' },
      group: { kind: 'inline' },
      nudSeq: { kind: 'keep' },
    },

    // ─── Type params (declarative) ─────────────────────────────────────
    TypeParams: {
      kind: 'node',
      type: 'TSTypeParameterDeclaration',
      // `<` sep(TypeParam) `>` → list after drops
      fields: [{ name: 'params', bind: { from: 'list', of: 0 }, typeHint: 'TSTypeParameter' }],
    },
    TypeParam: {
      kind: 'choice',
      arms: [
        {
          name: 'withModifiers',
          altIndices: [0, 1], // modifiers sequence variants — same product
          shape: {
            kind: 'node',
            type: 'TSTypeParameter',
            fields: [
              { name: 'name', bind: { at: 0 }, typeHint: 'Identifier' },
              { name: 'constraint', bind: { from: 'opt', at: 1 }, optional: true, typeHint: 'Type' },
              { name: 'default', bind: { from: 'opt', at: 2 }, optional: true, typeHint: 'Type' },
            ],
          },
        },
        {
          name: 'plain',
          altIndices: [2],
          shape: {
            kind: 'node',
            type: 'TSTypeParameter',
            fields: [
              { name: 'name', bind: { at: 0 }, typeHint: 'Identifier' },
              { name: 'constraint', bind: { from: 'opt', at: 1 }, optional: true, typeHint: 'Type' },
              { name: 'default', bind: { from: 'opt', at: 2 }, optional: true, typeHint: 'Type' },
            ],
          },
        },
      ],
    },

    // ─── Bindings ──────────────────────────────────────────────────────
    Binding: {
      kind: 'custom',
      fn: 'estreeVariableDeclarator',
      types: ['VariableDeclarator'],
      reason:
        'M2 typed direct-emit: VariableDeclarator is a plain typed struct in the customs arena ' +
        '(id, typeAnnotation, init, off, end) — routing via custom lets it bypass DynObj.',
    },
    ForBinding: {
      kind: 'custom',
      fn: 'estreeVariableDeclarator',
      types: ['VariableDeclarator'],
      reason:
        'M2 typed direct-emit: VariableDeclarator is a plain typed struct in the customs arena ' +
        '(id, typeAnnotation, init, off, end) — routing via custom lets it bypass DynObj.',
    },
    BindingElement: {
      kind: 'node',
      type: 'AssignmentPatternOrId',
      fields: [
        { name: 'id', bind: { at: 0 }, typeHint: ['Identifier', 'BindingPattern'] },
        { name: 'init', bind: { from: 'opt', at: 1 }, optional: true, typeHint: 'Expression' },
      ],
    },
    BindingPattern: {
      kind: 'choice',
      arms: [
        {
          name: 'ObjectPattern',
          altIndices: [0], // `{` sep(BindingProperty) `}`
          shape: {
            kind: 'node',
            type: 'ObjectPattern',
            fields: [{ name: 'properties', bind: { from: 'list', of: 0 }, typeHint: 'BindingProperty' }],
          },
        },
        {
          name: 'ArrayPattern',
          altIndices: [1],
          // `[` opt(elem) star(, opt(elem)) `]` — holes + rest; not a pure list bind
          shape: custom('estreeArrayPattern',
            'ArrayBindingPattern IR is `opt(elem) star(, opt(elem))` — optional elements ' +
            'encode ELISION holes (sparse array pattern). list() would drop holes; node with ' +
            'positional fields cannot represent variable-length with embedded nulls. Needs ' +
            'a builder that preserves missing opts as null entries.', {
            types: ['ArrayPattern'],
          }),
        },
      ],
    },
    BindingProperty: custom('estreeBindingProperty',
      '4 alts: key:value, shorthand Ident, computed/literal key, rest `...`. ' +
      'Shorthand vs key:value share leading Ident but differ by presence of `:`; after ' +
      'keyword/punct drop the alt identity is the only way to set `shorthand:true`. ' +
      'Primitives have no “which alt matched → boolean flag” form.', { types: ['Property', 'Property', 'Property', 'RestElement'] }),
    ArrayBindingElement: {
      kind: 'choice',
      arms: [
        { name: 'elem', altIndices: [0], shape: { kind: 'inline' } }, // just BindingElement
        {
          name: 'rest',
          altIndices: [1],
          shape: {
            kind: 'node',
            type: 'RestElement',
            fields: [{ name: 'argument', bind: { at: 0 }, typeHint: ['Identifier', 'BindingPattern'] }],
          },
        },
      ],
    },

    // ─── Params / for / switch ─────────────────────────────────────────
    Param: custom('estreeParam',
      '3 alts: `this` annotation, decorated+modifiers+complex, undecorated complex. ' +
      'Modifier keywords are dropped leaves; accessibility/readonly/optional/`...`rest ' +
      'flags must be recovered from alt structure + remaining kids. Excessively branched ' +
      'for choice+node without a flag-from-alt primitive.', { types: ['Identifier', 'Identifier', 'Identifier'] }),
    CatchParameter: custom('estreeCatchParam',
      '2 alts: a binding identifier or a binding pattern, each with an optional type annotation. ' +
      'Lowered to ESTree\'s CatchClause param: the Identifier, or the pattern itself.', { types: ['Identifier', 'Identifier'] }),
    ForHead: custom('estreeForHead',
      '4 alts (for-let/const/var/using ; for(;;) ; for-in ; for-of) are three different ' +
      'ESTree parents (ForStatement / ForInStatement / ForOfStatement) assembled at Stmt ' +
      'level — ForHead alone is not a single node. Mapping it to one node type lies; ' +
      'inlining into Stmt is what ESTree does. Shape for the helper rule is therefore custom ' +
      '(returns a tagged tuple the Stmt builder consumes).', { types: ['ForHead', 'ForHead', 'ForHead', 'ForHead'] }),
    ForAwaitHead: custom('estreeForAwaitHead',
      'The `for await` head: the `of` alts of ForHead (a declaration, a left-hand side), lowered ' +
      'like those (same tagged tuple, same reason as ForHead).', { types: ['ForAwaitHead', 'ForAwaitHead'] }),
    SwitchCase: {
      ...custom('estreeSwitchCase',
      'SwitchCase alts are Case / Default / bare Stmt. Case is `case Expr star(, Expr) :` — ' +
      'the star encodes a comma expression on the test; Default has zero kids after drops; ' +
      'Stmt alts are consequents that ESTree nests under the PRECEDING case (not a sibling ' +
      'SwitchCase node). inline() for the Stmt arm is correct in isolation but the parent ' +
      'Block/Switch must fold inline stmts into `consequent[]` of the prior case — that ' +
      'cross-rule accumulation is outside any single-rule primitive. custom.', { types: ['SwitchCase', 'SwitchCase', 'SwitchCase'] }),
      result: 'partial',
    },

    ImportSpecifier: {
      kind: 'choice',
      arms: [
        {
          // opt(type) Ident as Ident → after drops: Ident, Ident
          name: 'identAs',
          altIndices: [0],
          shape: {
            kind: 'node',
            type: 'ImportSpecifier',
            fields: [
              { name: 'imported', bind: { at: 0 }, typeHint: 'Identifier' },
              { name: 'local', bind: { at: 1 }, typeHint: 'Identifier' },
            ],
          },
        },
        {
          // opt(type) Ident → Ident (the local name alone)
          name: 'ident',
          altIndices: [1],
          shape: {
            kind: 'node',
            type: 'ImportSpecifier',
            fields: [
              { name: 'imported', bind: { at: 0 }, typeHint: 'Identifier' },
            ],
          },
        },
        {
          // opt(type) String as Ident → String, Ident (as dropped)
          name: 'stringAs',
          altIndices: [2],
          shape: {
            kind: 'node',
            type: 'ImportSpecifier',
            fields: [
              { name: 'imported', bind: { at: 0 }, typeHint: 'Literal' },
              { name: 'local', bind: { at: 1 }, typeHint: 'Identifier' },
            ],
          },
        },
      ],
    },
    ExportSpecifier: { kind: 'keep' },
    ModuleReference: { kind: 'keep' },
    // read only inside the `T?` lookahead, so it is in no tree
    TypeStart: { kind: 'keep' },

    DecoratorExpr: custom('estreeDecorator',
      'alt[0] is `Decorator star(call|typeargs|!|.|?.|Template)` — the star is a ' +
      'left-recursive member/call chain on the decorator expression, not a list field of ' +
      'the Decorator node. list() would mis-type it; node with at:0 ignores the chain. ' +
      'Need a Pratt-like fold over the star — custom (or would need a recursive inline ' +
      'fold primitive we deliberately do not have).', { types: ['Decorator', 'Decorator'] }),

    // ─── Class / interface / enum members ──────────────────────────────
    ClassMember: custom('estreeClassMember',
      '3 alts spanning empty/static-block/decorated-method-field-soup. ' +
      'alt[2] alone is a giant nested alt of async/generator/get/set/index/constructor/' +
      'method/field — tens of ESTree ClassBody element types. choice() would need recursive ' +
      'nested choice (forbidden) or an explosion of arms; custom is the honest escape.', { types: ['UnknownClassMember', 'StaticBlock', 'MethodDefinition'] }),
    EnumMember: {
      kind: 'node',
      type: 'TSEnumMember',
      fields: [
        { name: 'id', bind: { at: 0 }, typeHint: 'MemberName' },
        { name: 'initializer', bind: { from: 'opt', at: 1 }, optional: true, typeHint: 'Expression' },
      ],
    },
    TypeMember: custom('tsTypeMember',
      '4 alts of object-type members, in interfaces and type literals alike (call/construct ' +
      'signature, get/set, method/prop, index signature) — each a different TS-ESTree node. ' +
      'Same argument as ClassMember: heterogeneous products + dropped modifier keywords; ' +
      'custom recovers the `?` / `readonly` flags.', { types: ['TSCallSignatureDeclaration', 'TSMethodSignature', 'TSPropertySignature', 'TSIndexSignature'] }),
    MemberName: {
      kind: 'choice',
      arms: [
        // 9 alts: Ident / String / Number / Private / computed / etc. — many are leaf wraps
        {
          name: 'passthrough',
          altIndices: [0, 1, 2, 3, 4, 5, 6, 7, 8],
          shape: { kind: 'keep' }, // keep positional kids; codegen later refines to Identifier/Literal
        },
      ],
    },

    // ─── Import / export / decorator (ImportSpecifier+ExportSpecifier+DecoratorExpr
    //     defined above near SwitchCase) ─────────────────────────────────
    ImportClause: {
      kind: 'choice',
      arms: [
        { name: 'deferNamespace', altIndices: [0], shape: { kind: 'keep' } },
        { name: 'defaultEtc', altIndices: [1, 2, 3], shape: { kind: 'keep' } },
      ],
    },

    // ─── Prop ─────────────────────────────────────────────────────────
    Prop: custom('estreeProp',
      '2 alts covering object literal props (spread; a modifier run then accessor / `*` method / ' +
      'method / key:value / shorthand). Shorthand vs keyed distinguished only by the branch; ' +
      'spread is `...` Expr. Same “alt → flag / product type” gap as BindingProperty. The second ' +
      'arm streams as `ObjectMember`, so the Rust rebuild does not take its members for ' +
      'BindingProperty\'s second arm (a shorthand), whose text a shorthand member shares.', { types: ['Property', 'ObjectMember'] }),
  },
};

/** Helper: assert we listed all 30 cstNames (used by runner). */
export const EXPECTED_CST_NAMES = [
  'Type', 'TypeMember', 'DecoratorExpr', 'TypeofRef', 'Expr', 'Prop', 'MemberName',
  'NewTarget', 'ClassHeritage', 'Stmt', 'Block', 'BindingProperty', 'BindingElement',
  'ArrayBindingElement', 'BindingPattern', 'Binding', 'ForBinding', 'Param', 'CatchParameter', 'ForHead', 'ForAwaitHead',
  'SwitchCase', 'TypeParams', 'TypeParam', 'Decl', 'ClassMember',
  'EnumMember', 'ImportClause', 'ImportSpecifier', 'ExportSpecifier', 'ModuleReference', 'TypeStart', 'Program',
] as const;


/** ESTree-ish custom builders — SH2-3 (handwritten, not parseAst backfill). */
export type TsAstCustomCtx = {
  src: string;
  kids: readonly unknown[];
  altPath: readonly number[];
  off: number;
  end: number;
  opText?: string;
  left?: unknown;
  state?: unknown;
};
export type TsAstCustoms = Record<string, (ctx: TsAstCustomCtx) => unknown>;

export const SHAPE_PARTIAL = '__shapePartial' as const;
export type ShapePartial = {
  [SHAPE_PARTIAL]: string;
  mode: 'start' | 'append';
  value: unknown;
};
export function shapePartial(tag: string, mode: 'start' | 'append', value: unknown): ShapePartial {
  return { [SHAPE_PARTIAL]: tag, mode, value };
}

const I = (name: string) => ({ type: 'Identifier', name });
const L = (value: string | number | boolean | bigint) => ({ type: 'Literal', value });

function firstKid(kids: readonly unknown[]): unknown {
  return kids.length ? kids[0] : undefined;
}

/** First expression of an opt product `[expr, commaMany]` (arm-1) or the packed
 *  nested-alt cTail `[[testOpt,[]],[updateOpt,[]]]` (arm-0) — the test slot.
 *  Mirrors the Rust streaming schema's pool-last expr pick for classic ForHead. */
function optFirst(v: unknown): unknown {
  if (Array.isArray(v) && v.length > 0) return optFirst(v[0]);
  return v ?? null;
}

function flatKids(kids: readonly unknown[] | unknown): unknown[] {
  if (!Array.isArray(kids)) {
    if (kids === null || kids === undefined) return [];
    return [kids];
  }
  const out: unknown[] = [];
  for (const k of kids) {
    if (Array.isArray(k)) out.push(...k);
    else if (k !== null && k !== undefined) out.push(k);
  }
  return out;
}

function seqExpr(head: unknown, tail: unknown): unknown {
  const parts = flatKids([head, tail]);
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0];
  return { type: 'SequenceExpression', expressions: parts };
}

function stripAsi(kids: readonly unknown[]): unknown[] {
  return kids.filter((k) => !(Array.isArray(k) && k.length === 0));
}

function memberExpr(obj: unknown, prop: unknown, computed = false): unknown {
  const p = typeof prop === 'string' ? I(prop) : prop;
  return { type: 'MemberExpression', object: obj, property: p, computed, optional: false };
}

function callExpr(callee: unknown, args: unknown[]): unknown {
  return { type: 'CallExpression', callee, arguments: args };
}

function unaryExpr(op: string, arg: unknown): unknown {
  return { type: 'UnaryExpression', operator: op, argument: arg, prefix: true };
}

function binaryExpr(left: unknown, op: string, right: unknown): unknown {
  return { type: 'BinaryExpression', left, operator: op, right };
}

function updateExpr(op: string, arg: unknown, prefix: boolean): unknown {
  return { type: 'UpdateExpression', operator: op, argument: arg, prefix };
}

function arrowFn(params: unknown, body: unknown, async = false): unknown {
  const ps = Array.isArray(params) ? params : params ? [params] : [];
  return { type: 'ArrowFunctionExpression', params: ps, body, async, expression: typeof body !== 'object' || body === null || (body as any).type !== 'BlockStatement' };
}

function unhandledCustom(fn: string, ctx: TsAstCustomCtx, identity = ''): never {
  const suffix = identity || `altPath=${JSON.stringify(ctx.altPath)}${ctx.opText === undefined ? '' : ` opText=${JSON.stringify(ctx.opText)}`}`;
  throw new Error(`shape custom ${fn}: unhandled ${suffix}`);
}

function estreeStmt(ctx: TsAstCustomCtx): unknown {
  const arm = ctx.altPath[0];
  const k = Array.isArray(ctx.kids) ? ctx.kids : [ctx.kids];
  switch (arm) {
    case 0: {
      const body = firstKid(k);
      if (body && typeof body === 'object' && (body as { type?: string }).type === 'BlockStatement') return body;
      return { type: 'BlockStatement', body: flatKids(body ?? k) };
    }
    case 1: {
      const kind = ctx.src.slice(ctx.off, ctx.off + 5).startsWith('const') ? 'const'
        : ctx.src.slice(ctx.off, ctx.off + 3).startsWith('let') ? 'let' : 'var';
      return { type: 'VariableDeclaration', kind, declarations: flatKids(k) };
    }
    case 2: return { type: 'IfStatement', test: seqExpr(k[0], k[1]), consequent: k[2], alternate: k[3] ?? null };
    case 3: {
      const head = k[0] as { kind?: string; init?: unknown; test?: unknown; update?: unknown; left?: unknown; right?: unknown; await?: boolean } | undefined;
      const body = k[1];
      if (head?.kind === 'in') return { type: 'ForInStatement', left: head.left, right: head.right, body };
      if (head?.kind === 'of') return { type: 'ForOfStatement', left: head.left, right: head.right, body, await: !!head.await };
      return {
        type: 'ForStatement',
        init: head?.init ?? null,
        test: head?.test ?? null,
        update: head?.update ?? null,
        body,
      };
    }
    case 4: return { type: 'WhileStatement', test: seqExpr(k[1], k[2]), body: k[3] };
    case 5: return { type: 'DoWhileStatement', body: k[0], test: seqExpr(k[2], k[3]) };
    case 6: return { type: 'SwitchStatement', discriminant: k[0], cases: flatKids(Array.isArray(k[2]) ? k[2] : Array.isArray(k[1]) ? k[1] : []) };
    case 7: return { type: 'ReturnStatement', argument: seqExpr(k[0], k[1]) ?? null };
    case 8: return { type: 'ThrowStatement', argument: seqExpr(k[0], k[1]) };
    case 9: return { type: 'BreakStatement', label: k[0] ?? null };
    case 10: return { type: 'ContinueStatement', label: k[0] ?? null };
    case 11: return { type: 'TryStatement', block: k[0], handler: k[1] ?? null, finalizer: k[2] ?? null };
    case 12: return { type: 'LabeledStatement', label: I(String(k[0])), body: k[1] };
    case 13: return { type: 'EmptyStatement' };
    case 14: return { type: 'DebuggerStatement' };
    case 15: return { type: 'WithStatement', object: seqExpr(k[1], k[2]), body: k[3] };
    case 16: return { type: 'VariableDeclaration', kind: 'using', declarations: flatKids(k) };
    case 17: return firstKid(k) ?? k[0];
    case 18: {
      const expr = stripAsi(k)[0];
      return { type: 'ExpressionStatement', expression: expr };
    }
    default: return unhandledCustom('estreeStmt', ctx);
  }
}

function estreeVariableDeclarator(ctx: TsAstCustomCtx): unknown {
  const k = Array.isArray(ctx.kids) ? ctx.kids : [ctx.kids];
  return { type: 'VariableDeclarator', id: k[0] ?? null, typeAnnotation: k[1] ?? null, init: k[2] ?? null, off: ctx.off, end: ctx.end };
}

function estreeDecl(ctx: TsAstCustomCtx): unknown {
  const arm = ctx.altPath[0];
  const k = Array.isArray(ctx.kids) ? ctx.kids : [ctx.kids];
  if (arm === 17) return { type: 'ExportNamedDeclaration', declaration: k[0] };
  if (arm === 18) return { type: 'ExportNamedDeclaration', specifiers: flatKids(k) };
  if (arm === 19) return { type: 'ExportDefaultDeclaration', declaration: k[0] };
  if (arm === 20) return { type: 'ImportDeclaration', specifiers: flatKids(k[1] ?? k), source: k[2] ?? k[1] };
  if (arm === 21) return { type: 'TSImportEqualsDeclaration', id: k[0], moduleReference: k[1] };
  if (arm === 22) return { type: 'TSModuleDeclaration', id: k[0], body: k[1] };
  if (arm === 23) return { type: 'TSModuleDeclaration', id: k[0], body: k[1], declare: true };
  if (arm === 24) return { type: 'TSNamespaceExportDeclaration', id: k[0] };
  if (arm === 25) return { type: 'TSEnumDeclaration', id: k[0], members: flatKids(k[1] ?? []) };
  if (arm === 4) return {
    type: 'TSInterfaceDeclaration',
    id: k[0],
    typeParameters: k[1] ?? null,
    extends: flatKids(k[2] ?? []),
    body: { type: 'TSInterfaceBody', body: flatKids(k[3] ?? []) },
  };
  if (arm === 5) return { type: 'TSTypeAliasDeclaration', id: k[0], typeParameters: k[1] ?? null, typeAnnotation: k[2] };
  // A named class: arm 6 bare, or arm 13's first branch after its decorator / modifier prefix
  // (k[0]: the prefix's decorators; the modifier words leave no kid).
  const classDecl = (decorators: unknown, c: unknown[]) => ({
    type: 'ClassDeclaration',
    decorators: flatKids(decorators ?? []),
    id: c[0] ?? null,
    superClass: flatKids(c[2] ?? [])[0] ?? null,
    body: { type: 'ClassBody', body: flatKids(c[3] ?? []) },
  });
  if (arm === 6) return classDecl([], k);
  if (arm === 13 && ctx.altPath[2] === 0) return classDecl(k[0], k[1] as unknown[]);
  if (arm === 0 || arm === 1 || arm === 2 || arm === 3) {
    const async = arm === 1 || arm === 3;
    const gen = arm === 2 || arm === 3;
    return {
      type: 'FunctionDeclaration',
      async,
      generator: gen,
      id: k[0] ?? null,
      typeParameters: k[1] ?? null,
      params: flatKids(k[2] ?? []),
      returnType: k[3] ?? null,
      body: k[4] ?? null,
    };
  }
  if (arm === 15 || arm === 16) return { type: 'ExportNamedDeclaration', declaration: estreeDecl({ ...ctx, altPath: [arm === 15 ? 0 : 6], kids: k }) };
  if (arm === 14) return { type: 'TSDeclareFunction', ...estreeDecl({ ...ctx, altPath: [0], kids: k }) as object };
  if (arm !== undefined && arm >= 7 && arm <= 13) return { type: 'Declaration', alt: arm, children: ctx.kids };
  return unhandledCustom('estreeDecl', ctx);
}

function estreeParenOrComma(ctx: TsAstCustomCtx): unknown {
  const arm = ctx.altPath[0];
  if (arm === undefined || arm < 0 || arm > 20) return unhandledCustom('estreeParenOrComma', ctx);
  if (arm === 6) return { type: 'MetaProperty', meta: I('new'), property: I('target') };
  const parts = flatKids(ctx.kids);
  if (parts.length === 1) return parts[0];
  return { type: 'SequenceExpression', expressions: parts };
}

const ASSIGN_OPS = new Set([
  '=', '+=', '-=', '*=', '/=', '%=', '**=', '<<=', '>>=', '>>>=',
  '&=', '|=', '^=', '??=', '||=', '&&=',
]);
const LOGICAL_OPS = new Set(['??', '||', '&&']);
const UPDATE_OPS = new Set(['++', '--']);
const BINARY_OPS = new Set([
  ...ASSIGN_OPS, ...LOGICAL_OPS,
  '|', '^', '&', '==', '!=', '===', '!==', '<', '>', '<=', '>=',
  '<<', '>>', '>>>', '+', '-', '*', '/', '%', '**',
]);
const PREFIX_OPS = new Set(['!', '~', '+', '-', 'typeof', 'void', 'delete', 'await', 'yield', '++', '--']);

function estreeExprBinary(ctx: TsAstCustomCtx): unknown {
  const op = ctx.opText ?? '';
  if (!BINARY_OPS.has(op)) return unhandledCustom('estreeExprBinary', ctx);
  const right = ctx.kids[0];
  if (ASSIGN_OPS.has(op)) {
    return { type: 'AssignmentExpression', left: ctx.left, operator: op, right };
  }
  if (LOGICAL_OPS.has(op)) {
    return { type: 'LogicalExpression', left: ctx.left, operator: op, right };
  }
  return { type: 'BinaryExpression', left: ctx.left, operator: op, right };
}

function estreeExprPrefix(ctx: TsAstCustomCtx): unknown {
  const op = ctx.opText ?? '';
  if (!PREFIX_OPS.has(op)) return unhandledCustom('estreeExprPrefix', ctx);
  const argument = ctx.kids[0];
  if (UPDATE_OPS.has(op)) return updateExpr(op, argument, true);
  return unaryExpr(op, argument);
}

function estreeExprPostfixTok(ctx: TsAstCustomCtx): unknown {
  if (ctx.opText === undefined || !ctx.opText.startsWith('`')) return unhandledCustom('estreeExprPostfixTok', ctx);
  return { type: 'TaggedTemplateExpression', tag: ctx.left, quasi: ctx.kids[0] };
}

/** Strip lexer span markers (` / ${ / }) from template leaf texts for TemplateElement.raw. */
function tplRaw(kind: 'head' | 'middle' | 'tail' | 'nosubst', text: string): string {
  const open = '`', iOpen = '${', iClose = '}';
  if (kind === 'nosubst') {
    return text.startsWith(open) && text.endsWith(open)
      ? text.slice(open.length, text.length - open.length)
      : text;
  }
  let s = text;
  if (kind === 'head') {
    if (s.startsWith(open)) s = s.slice(open.length);
    if (s.endsWith(iOpen)) s = s.slice(0, s.length - iOpen.length);
    return s;
  }
  if (kind === 'middle') {
    if (s.startsWith(iClose)) s = s.slice(iClose.length);
    if (s.endsWith(iOpen)) s = s.slice(0, s.length - iOpen.length);
    return s;
  }
  if (s.startsWith(iClose)) s = s.slice(iClose.length);
  if (s.endsWith(open)) s = s.slice(0, s.length - open.length);
  return s;
}

/**
 * pratt.template product. Kids are either `[noSubstLeaf]` or
 * `[head, expr0, middle?, expr?, ..., tail]` with leaf strings still carrying delimiters.
 */
function estreeTemplateLiteral(ctx: TsAstCustomCtx): unknown {
  const kids = ctx.kids;
  if (kids.length === 1 && typeof kids[0] === 'string') {
    return {
      type: 'TemplateLiteral',
      quasis: [{ type: 'TemplateElement', value: { raw: tplRaw('nosubst', kids[0]) }, tail: true }],
      expressions: [],
    };
  }
  if (kids.length < 3 || kids.length % 2 === 0) {
    return unhandledCustom('estreeTemplateLiteral', ctx);
  }
  const quasis: { type: 'TemplateElement'; value: { raw: string }; tail: boolean }[] = [];
  const expressions: unknown[] = [];
  for (let i = 0; i < kids.length; i++) {
    if (i % 2 === 0) {
      const text = kids[i];
      if (typeof text !== 'string') return unhandledCustom('estreeTemplateLiteral', ctx);
      const isHead = i === 0;
      const isTail = i === kids.length - 1;
      const kind = isHead ? 'head' : isTail ? 'tail' : 'middle';
      quasis.push({
        type: 'TemplateElement',
        value: { raw: tplRaw(kind, text) },
        tail: isTail,
      });
    } else {
      expressions.push(kids[i]);
    }
  }
  return { type: 'TemplateLiteral', quasis, expressions };
}

/** Optional-chain LED arm 4 — distinguish by kid shape (altPath is only [4]). */
function estreeOptionalChain(left: unknown, kids: readonly unknown[]): unknown {
  const k0 = kids[0];
  if (Array.isArray(k0)) {
    // a?.() → [[]] ; a?.<T>() → [[[types],[args]]]
    if (Array.isArray(k0[0])) {
      const args = Array.isArray(k0[1]) ? k0[1] as unknown[] : [];
      return {
        type: 'CallExpression',
        callee: left,
        arguments: args,
        optional: true,
        typeArguments: k0[0],
      };
    }
    return { type: 'CallExpression', callee: left, arguments: k0 as unknown[], optional: true };
  }
  if (typeof k0 === 'string' && k0.startsWith('`')) {
    return { type: 'TaggedTemplateExpression', tag: left, quasi: k0 };
  }
  if (k0 !== null && typeof k0 === 'object' && (k0 as { type?: string }).type === 'TemplateLiteral') {
    return { type: 'TaggedTemplateExpression', tag: left, quasi: k0 };
  }
  if (typeof k0 === 'string') {
    return { ...memberExpr(left, k0), optional: true };
  }
  // a?.[b] → object kid → computed MemberExpression
  return { ...memberExpr(left, k0 ?? 'undefined', true), optional: true };
}

function estreeExprLed(ctx: TsAstCustomCtx): unknown {
  const left = ctx.left;
  const op = ctx.opText ?? '';
  const arm = ctx.altPath[0];
  const slots = flatKids(ctx.kids);
  if (arm === 0 || arm === 2) {
    const args = slots.length === 1 && Array.isArray(slots[0]) ? slots[0] as unknown[] : slots;
    return callExpr(left, args.filter((x) => x !== null && x !== undefined));
  }
  if (arm === 1) return { type: 'TSInstantiationExpression', expression: left, typeArguments: slots[0] ?? slots };
  if (arm === 3) return memberExpr(left, slots[0] ?? 'undefined');
  if (arm === 4) return estreeOptionalChain(left, ctx.kids);
  if (arm === 5) return memberExpr(left, slots[0], true);
  if (arm === 6) return { type: 'TSNonNullExpression', expression: left };
  if (arm === 7) {
    return {
      type: 'ConditionalExpression',
      test: left,
      consequent: slots[0],
      alternate: slots[1],
    };
  }
  if (arm === 8) return { type: 'TSAsExpression', expression: left, typeAnnotation: slots[0] };
  if (arm === 9) return binaryExpr(left, 'instanceof', slots[0]);
  if (arm === 10) return binaryExpr(left, 'in', slots[0]);
  if (arm === 11) return { type: 'TSSatisfiesExpression', expression: left, typeAnnotation: slots[0] };
  return unhandledCustom('estreeExprLed', ctx, `LED altPath=${JSON.stringify(ctx.altPath)} opText=${JSON.stringify(op)}`);
}

function estreeExprNudSeq(ctx: TsAstCustomCtx): unknown {
  const arm = ctx.altPath[0];
  if (arm === 0) {
    const name = ctx.kids[0];
    return typeof name === 'string' ? I(name) : name;
  }
  if (arm !== 1 && arm !== 2) return unhandledCustom('estreeExprNudSeq', ctx);
  return { type: 'ClassExpression', decorators: flatKids(ctx.kids[0] ?? []), id: ctx.kids[1] ?? null, body: { type: 'ClassBody', body: flatKids(ctx.kids.slice(3)) } };
}

function estreeArrow(ctx: TsAstCustomCtx): unknown {
  const async = ctx.src.slice(ctx.off, ctx.end).trimStart().startsWith('async');
  const arm = ctx.altPath[0];
  // v1 binds the capped arms by index: #4 is the `yield` arm (capped since it is an
  // AssignmentExpression form). It keeps v1's former output for `yield e` (the prefix operator's
  // UnaryExpression), which the Rust rebuild's SC_UNARY reproduces; its operand is the one kid left
  // after the keyword and `*` drop.
  if (arm === 4) return unaryExpr('yield', ctx.kids[0] ?? null);
  if (arm === undefined || arm < 0 || arm > 3) return unhandledCustom('estreeArrow', ctx);
  const params = arm === 1 || arm === 2
    ? flatKids(ctx.kids[1] ?? [])
    : [typeof ctx.kids[0] === 'string' ? I(ctx.kids[0]) : ctx.kids[0]];
  const body = ctx.kids[ctx.kids.length - 1];
  return arrowFn(params, body, async);
}

function tsTypeLed(ctx: TsAstCustomCtx): unknown {
  if (ctx.opText === undefined) {
    const arm = ctx.altPath[0];
    if (arm === 7) return { type: 'TSTypeLiteral', members: flatKids(ctx.kids) };
    // the mapped type (the last group): its key, then its constraint, `as` type, annotation and
    // trailing members, in order
    if (arm === 24) return { type: 'TSMappedType', key: ctx.kids[0], parts: flatKids(ctx.kids.slice(1)) };
    if (arm === undefined || arm < 0 || arm > 20) {
      return unhandledCustom('tsTypeLed', ctx, `group altPath=${JSON.stringify(ctx.altPath)}`);
    }
    return {
      type: 'Type',
      children: ctx.kids,
      headText: ctx.kids.length ? String(ctx.kids[0] ?? '') : '',
      off: ctx.off,
      end: ctx.end,
    };
  }
  const op = ctx.opText ?? '';
  if (op === 'extends') return { type: 'TSConditionalType', checkType: ctx.left, extendsType: ctx.kids[0], trueType: ctx.kids[1], falseType: ctx.kids[2] };
  if (op === '[') return { type: 'TSIndexedAccessType', objectType: ctx.left, indexType: ctx.kids[0] };
  if (op === '<' || op === '|' || op === '&' || op === '.' || op === '?' || op === '!') {
    return { type: 'TSTypeReference', typeName: ctx.left, typeParameters: ctx.kids[0] ?? null, meta: { op } };
  }
  return unhandledCustom('tsTypeLed', ctx, `LED altPath=${JSON.stringify(ctx.altPath)} opText=${JSON.stringify(op)}`);
}

function estreeNewTargetLed(ctx: TsAstCustomCtx): unknown {
  const op = ctx.opText ?? '';
  if (op === '.' && ctx.kids[0] === 'target' && _headIsNew(ctx.left)) {
    return { type: 'MetaProperty', meta: I('new'), property: I('target') };
  }
  if (op === '.') return memberExpr(ctx.left, ctx.kids[0]);
  if (op === '[') return memberExpr(ctx.left, ctx.kids[0], true);
  if (op === '<') {   // typed tag: kids are the type arguments, then the template
    const slots = flatKids(ctx.kids);
    return { type: 'TaggedTemplateExpression', tag: ctx.left, quasi: slots[slots.length - 1], typeArguments: slots.slice(0, -1) };
  }
  return unhandledCustom('estreeNewTargetLed', ctx);
}

function _headIsNew(v: unknown): boolean {
  if (typeof v === 'string') return v === 'new';
  if (v && typeof v === 'object' && (v as any).type === 'Identifier') return (v as any).name === 'new';
  return false;
}

function estreeArrayPattern(ctx: TsAstCustomCtx): unknown {
  if (ctx.altPath[0] !== 1) return unhandledCustom('estreeArrayPattern', ctx);
  const elems: unknown[] = [];
  for (const k of ctx.kids) {
    if (Array.isArray(k)) elems.push(...k.map((x) => x ?? null));
    else elems.push(k ?? null);
  }
  return { type: 'ArrayPattern', elements: elems };
}

function estreeBindingProperty(ctx: TsAstCustomCtx): unknown {
  const arm = ctx.altPath[0];
  const [a, b] = ctx.kids;
  if (arm === 1) return { type: 'Property', key: I(String(a)), value: I(String(a)), kind: 'init', method: false, shorthand: true, computed: false };
  if (arm === 3) return { type: 'RestElement', argument: a };
  if (arm === 2) return { type: 'Property', key: a, value: b, kind: 'init', method: false, shorthand: false, computed: true };
  if (arm === 0) return { type: 'Property', key: typeof a === 'string' ? I(a) : a, value: b, kind: 'init', method: false, shorthand: false, computed: false };
  return unhandledCustom('estreeBindingProperty', ctx);
}

function estreeParam(ctx: TsAstCustomCtx): unknown {
  const arm = ctx.altPath[0];
  if (arm === 0) return { type: 'Identifier', name: 'this', typeAnnotation: ctx.kids[0] };
  if (arm !== 1 && arm !== 2) return unhandledCustom('estreeParam', ctx);
  const k = ctx.kids;
  const id = k[k.length - 2] ?? k[0];
  return { type: 'Identifier', ...(typeof id === 'string' ? { name: id } : id as object), decorators: flatKids(k[0] ?? []), optional: arm === 1 };
}

// A catch parameter: arm 0 a name, arm 1 a pattern, each with an optional type annotation.
function estreeCatchParam(ctx: TsAstCustomCtx): unknown {
  const arm = ctx.altPath[0];
  if (arm !== 0 && arm !== 1) return unhandledCustom('estreeCatchParam', ctx);
  // ESTree's CatchClause param: the Identifier or the pattern itself.
  const id = ctx.kids[0];
  return typeof id === 'string' ? { type: 'Identifier', name: id } : id;
}

function estreeForHead(ctx: TsAstCustomCtx): unknown {
  const arm = ctx.altPath[0];
  // Classic heads (arms 0/1) mirror the Rust streaming SC_FORSTATEMENT schema:
  // init = declarator kid list (arm 0) or null (arm 1); test = the test
  // expression (optFirst unwraps the `[expr, commaMany]` / packed-cTail opt
  // products); update = null (Rust's VSpec::Raw("null")).
  if (arm === 0) return declaredForHead(ctx, true);
  if (arm === 1) return { type: 'ForHead', kind: 'classic', init: null, test: optFirst(ctx.kids[1]), update: null };
  if (arm === 2) return { type: 'ForHead', kind: 'in', left: ctx.kids[0], right: ctx.kids[1] };
  if (arm === 3) return { type: 'ForHead', kind: 'of', left: ctx.kids[0], right: ctx.kids[1], await: ctx.src.slice(ctx.off, ctx.off + 5).includes('await') };
  return unhandledCustom('estreeForHead', ctx);
}

// A declared head (`forDeclaration`): its first binding, then what follows it, by the tail alt
// (altPath[2]): ForHead's C-style tail (alt 0) holds the further bindings, then the test and the
// update; a `for await` head has no C-style tail.
function declaredForHead(ctx: TsAstCustomCtx, cStyle: boolean): unknown {
  const [first, tail] = ctx.kids[0] as [unknown, unknown[]];
  if (!cStyle || ctx.altPath[2] !== 0) return { type: 'ForHead', kind: 'classic', init: kDecl(first), test: optFirst(tail), update: null };
  const more = flatKids(tail[0]);
  return { type: 'ForHead', kind: 'classic', init: kDecl(more.length ? [first, ...more] : first), test: optFirst(tail.slice(1)), update: null };
}

// The `for await` head's alts are ForHead's declared (0) and left-hand-side `of` (3) alts.
function estreeForAwaitHead(ctx: TsAstCustomCtx): unknown {
  const arm = ctx.altPath[0];
  if (arm === 0) return declaredForHead(ctx, false);
  if (arm === 1) return { type: 'ForHead', kind: 'of', left: ctx.kids[0], right: ctx.kids[1], await: true };
  return unhandledCustom('estreeForAwaitHead', ctx);
}

function kDecl(v: unknown): unknown {
  return v;
}

function estreeSwitchCase(ctx: TsAstCustomCtx): unknown {
  const arm = ctx.altPath[0];
  if (arm === 2) {
    const stmt = firstKid(ctx.kids);
    return shapePartial('switch-consequent', 'append', stmt);
  }
  if (arm === 1) {
    return shapePartial('switch-consequent', 'start', { type: 'SwitchCase', test: null, consequent: [] });
  }
  if (arm === 0) {
    return shapePartial('switch-consequent', 'start', {
      type: 'SwitchCase',
      test: seqExpr(ctx.kids[0], ctx.kids[1]),
      consequent: [],
    });
  }
  return unhandledCustom('estreeSwitchCase', ctx);
}

function estreeDecorator(ctx: TsAstCustomCtx): unknown {
  const arm = ctx.altPath[0];
  if (arm === undefined || arm < 0 || arm > 1) return unhandledCustom('estreeDecorator', ctx);
  // `@` is its own leaf: the name follows it
  const chain = flatKids(ctx.kids);
  if (chain[0] === '@') chain.shift();
  const head = chain[0];
  let expr: unknown = typeof head === 'string' ? I(head.startsWith('@') ? head.slice(1) : head) : head;
  for (let i = 1; i < chain.length; i++) {
    const step = chain[i];
    if (Array.isArray(step)) expr = callExpr(expr, step as unknown[]);
    else if (step && typeof step === 'object') expr = callExpr(expr, [step]);
    else expr = memberExpr(expr, step);
  }
  return { type: 'Decorator', expression: expr };
}

function estreeClassMember(ctx: TsAstCustomCtx): unknown {
  const arm = ctx.altPath[0];
  // An empty class element (`;`, also the one after a block-bodied member) has no ESTree
  // node: an empty kid list, which the ClassBody's flatKids drops (null would fail the member).
  if (arm === 0) return [];
  if (arm === 1) return { type: 'StaticBlock', body: ctx.kids[0] };
  if (arm !== 2) return unhandledCustom('estreeClassMember', ctx);
  const nested = ctx.altPath[1];
  // The `constructor` branch (7) with no decorator, modifier, type parameters or return type and
  // a block body (`altPath` [2, 7, 0]): a constructor definition.
  if (nested === 7 && ctx.altPath.length === 3 && ctx.altPath[2] === 0 && flatKids(ctx.kids[0] ?? []).length === 0) {
    const tail = Array.isArray(ctx.kids[1]) ? ctx.kids[1] as unknown[] : [];
    if (tail[0] == null && tail[2] == null) return { type: 'MethodDefinition', kind: 'constructor', key: I('constructor'), value: { type: 'FunctionExpression', params: flatKids(tail[1] ?? []), body: tail[3] }, static: false };
  }
  if (nested === 8) {
    const branch = Array.isArray(ctx.kids[1]) ? ctx.kids[1] as unknown[] : [];
    const tail = Array.isArray(branch[1]) ? branch[1] as unknown[] : [];
    return {
      type: 'MethodDefinition',
      kind: 'method',
      key: branch[0],
      value: {
        type: 'FunctionExpression',
        params: flatKids(tail[1] ?? []),
        body: tail[3] ?? null,
        async: false,
        generator: false,
      },
      static: false,
      computed: false,
    };
  }
  if (nested !== undefined && nested >= 0 && nested <= 9) {
    return { type: 'MethodDefinition', kind: 'method', key: ctx.kids[0], value: ctx.kids[1], static: false };
  }
  return unhandledCustom('estreeClassMember', ctx);
}

// A type member's modifier words: the words its text starts with, but the last when it is the
// member's name (followed by `?`, `:`, `(`, `<`, a separator or the end).
function typeMemberModifiers(text: string): string[] {
  const toks = text.match(/[A-Za-z_$][\w$]*|\S/g) ?? [];
  let i = 0;
  while (i < toks.length && /^[A-Za-z_$]/.test(toks[i]!)) i++;
  const nameIsWord = i > 0 && (i === toks.length || '?:(<,;}'.includes(toks[i]![0]!));
  return toks.slice(0, nameIsWord ? i - 1 : i);
}

function tsTypeMember(ctx: TsAstCustomCtx): unknown {
  const arm = ctx.altPath[0];
  if (arm === 0) {
    const construct = ctx.src.slice(ctx.off, ctx.end).trimStart().startsWith('new');
    return {
      type: construct ? 'TSConstructSignatureDeclaration' : 'TSCallSignatureDeclaration',
      typeParameters: ctx.kids[0] ?? null,
      params: flatKids(ctx.kids[1] ?? []),
      returnType: ctx.kids[2] ?? null,
    };
  }
  // get / set: [name, type params?, params, return type?, body?]
  if (arm === 1) return { type: 'TSMethodSignature', kind: ctx.src.slice(ctx.off, ctx.off + 3), key: ctx.kids[0], params: flatKids(ctx.kids[2] ?? []), returnType: ctx.kids[3] ?? null };
  if (arm === 2) {
    const method = Array.isArray(ctx.kids[2]);
    const readonly = typeMemberModifiers(ctx.src.slice(ctx.off, ctx.end)).includes('readonly');
    // a property's tail (inner branch 1): an optional `: T`, then an optional `= initializer`
    if (ctx.altPath[1] === 1) {
      const [typeAnnotation, initializer] = ctx.kids[1] as unknown[];
      return { type: 'TSPropertySignature', key: ctx.kids[0], typeAnnotation: typeAnnotation ?? null, initializer: initializer ?? null, optional: ctx.src.includes('?'), readonly };
    }
    return method
      ? { type: 'TSMethodSignature', key: ctx.kids[0], params: flatKids(ctx.kids[2]), returnType: ctx.kids[3] ?? null, optional: ctx.src.includes('?') }
      : { type: 'TSPropertySignature', key: ctx.kids[0], typeAnnotation: ctx.kids[1], optional: ctx.src.includes('?'), readonly };
  }
  if (arm === 3) return { type: 'TSIndexSignature', parameters: flatKids(ctx.kids[0] ?? []), typeAnnotation: ctx.kids[1] ?? null };
  return unhandledCustom('tsTypeMember', ctx);
}

// Prop's arms: 0 spread, 1 a modifier run (perhaps empty), then an accessor | `*` method |
// method | value | shorthand. Arm 1 holds its run's slots, then its member's kids as one pack, told apart by
// its shape: a shorthand's starts with its name's text; a method's or value's is 2 (the name,
// then a method's 4-kid tail or the value); an accessor's and a `*` method's are 5 (name, type
// parameters, parameters, return type, body), and a `*` method is the one whose modifier words
// (and comments) are followed by a `*`. Owed: these products are not ESTree's (a getter is a
// computed init, a method a `set`, a generator a `get`, a shorthand a keyed property); they are
// kept as they were before the arms were merged, the unmodified form's where a modified and an
// unmodified arm merged.
const GENERATOR_MEMBER = /^(?:\s+|\/\*[\s\S]*?\*\/|\/\/[^\n]*|[A-Za-z_$][\w$]*)*\*/;
function estreeProp(ctx: TsAstCustomCtx): unknown {
  const arm = ctx.altPath[0];
  const k = ctx.kids;
  const keyed = (kk: readonly unknown[], computed: boolean) => ({ type: 'Property', key: typeof kk[0] === 'string' ? I(kk[0]) : kk[0], value: kk[1], kind: 'init', shorthand: false, computed, method: false });
  if (arm === 0) return keyed(k, false);
  // The run's slots (a list of its decorators, or a `null` for an absent `static`) come first, at
  // every level of the run's nesting; the member's pack is what is left.
  const runSlot = (x: unknown) => x === null || (Array.isArray(x) && x.every(d => (d as { type?: string })?.type === 'Decorator'));
  const unwrap = (a: unknown): unknown => Array.isArray(a) && a.length >= 2 && a.slice(0, -1).every(runSlot) ? unwrap(a[a.length - 1]) : a;
  const inner = arm === 1 ? unwrap(k) : null;
  const pack = Array.isArray(inner) ? inner as unknown[] : null;
  if (pack && typeof pack[0] === 'string') return keyed(pack, false);
  if (pack && pack.length === 5) {
    return GENERATOR_MEMBER.test(ctx.src.slice(ctx.off, ctx.end))
      ? { type: 'Property', key: pack[0], value: pack[1], kind: 'get', shorthand: false, computed: false, method: false }
      : keyed([pack[0], pack[2]], true);
  }
  if (pack && pack.length === 2) {
    const tail = pack[1];
    return Array.isArray(tail) && tail.length === 4 && Array.isArray(tail[1])
      ? { type: 'Property', key: pack[0], value: tail[0], kind: 'set', shorthand: false, computed: false, method: false }
      : keyed(pack, false);
  }
  return unhandledCustom('estreeProp', ctx);
}

/** Back-compat alias used by shape-parity acceptance gate. */
export const typescriptEstreeCustoms: TsAstCustoms = {
  estreeStmt,
  estreeDecl,
  estreeParenOrComma,
  estreeVariableDeclarator,
  estreeExprBinary,
  estreeExprPrefix,
  estreeExprPostfixTok,
  estreeTemplateLiteral,
  estreeExprLed,
  estreeExprNudSeq,
  estreeArrow,
  tsTypeLed,
  estreeNewTargetLed,
  estreeArrayPattern,
  estreeBindingProperty,
  estreeParam,
  estreeCatchParam,
  estreeForHead,
  estreeForAwaitHead,
  estreeSwitchCase,
  estreeDecorator,
  estreeClassMember,
  tsTypeMember,
  estreeProp,
};

/** @deprecated SH2-2 stub name — parity imports this alias. */
export const typescriptStubCustoms = typescriptEstreeCustoms;
