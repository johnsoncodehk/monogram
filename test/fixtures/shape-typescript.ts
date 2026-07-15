/**
 * typescript grammar — ESTree-ish declarative shape sample.
 *
 * Aligns with test/ast-builder.ts demoBuilder where that demo has an opinion
 * (drop punct/keyword/ops; Program.body; BlockStatement; ExpressionStatement;
 * BinaryExpression heuristics). Rules the demo never touches get a reasoned
 * mapping (node/list/choice/pratt/keep/custom) — NEVER silent custom without
 * a why-primitives-fail argument.
 *
 * Keys are cstNames → forks inherit (validator expands to 117 IR rules).
 */
import type { ShapeSpec, CustomShape } from '../../src/shape-schema.ts';

const custom = (fn: string, reason: string): CustomShape => ({ kind: 'custom', fn, reason });

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
  Template: { action: 'leafValue', fn: 'string' }, // no-subst; interp assembled by $template node
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
    Stmt: custom('estreeStmt',
      'Stmt has 19 RD alts (if/for/while/do/switch/return/throw/try/break/continue/' +
      'labeled/empty/debugger/with/using/Decl/ExprStmt/…) each a distinct ESTree Statement ' +
      'subtype. Several alts embed `Expr star(, Expr)` (comma expression) and ASI-terminator ' +
      'alts (`;` | not sameLine | not not `}`) that are zero-width-or-punct and collapse ' +
      'differently per arm. choice()+node() can name the products but cannot express ' +
      '“fold trailing comma-seq into SequenceExpression” or “ASI alt is not a kid” without ' +
      'a runtime fold — that fold IS a handwritten builder. demoBuilder itself special-cases ' +
      'Stmt → ExpressionStatement; a faithful ESTree Stmt map stays custom.'),

    // Decl (28 alts) — same class of problem, worse.
    Decl: custom('estreeDecl',
      'Decl has 28 RD alts covering function*/async/interface/type/class/enum/declare/' +
      'namespace/module/export-default/export-star/import/… with deep nested alts ' +
      '(export default alone inlines 8 function/class forms). Product types differ per arm; ' +
      'several arms WRAP another Decl/Stmt (`export Decl`, `declare Decl`) needing unwrap/' +
      'flag injection. choice() would need ≥20 arms each with multi-optional field binds ' +
      'that still cannot derive `async`/`generator`/`declare` boolean flags from dropped ' +
      'keyword leaves (keywords are dropped globally — their presence must be recovered ' +
      'from which alt matched, i.e. builder logic). Primitives lack alt-identity → flag ' +
      'mapping.'),

    // ─── Expr (Pratt) — demo BinaryExpression heuristics; real ESTree needs more ─
    Expr: {
      kind: 'pratt',
      atom: { kind: 'keep' },
      // `( Expr )` grouping-ish nudBracket first="(" also covers comma-seq — not pure group.
      group: custom('estreeParenOrComma',
        'nudBracket "(" steps are `Expr star(, Expr)` — after punct drop the kid list is ' +
        '1..N expressions. Pure inline is only correct for N=1; N>1 must become ' +
        'SequenceExpression. Distinguishing N at shape-spec time needs a runtime arity ' +
        'branch — custom.'),
      prefix: {
        kind: 'node',
        type: 'UnaryExpression',
        fields: [{ name: 'argument', bind: { at: 0 }, typeHint: 'Expression' }],
      },
      binary: {
        kind: 'node',
        type: 'BinaryExpression',
        fields: [
          { name: 'left', bind: { at: 0 }, typeHint: 'Expression' },
          { name: 'right', bind: { at: 1 }, typeHint: 'Expression' },
        ],
      },
      postfix: {
        kind: 'node',
        type: 'UpdateExpression',
        fields: [{ name: 'argument', bind: { at: 0 }, typeHint: 'Expression' }],
      },
      // leds: call / member / index / optional-chain / non-null / typed call — all different
      led: custom('estreeExprLed',
        'Expr has ≥7 mixfix LED shapes (type-args+call, type-args, call, member `.`, ' +
        'optional `?.`, index `[]`, non-null `!`) plus postfix Template. Each LED yields a ' +
        'different ESTree node (CallExpression / MemberExpression / ChainExpression / ' +
        'TSNonNullExpression / TaggedTemplateExpression) with different field layouts. ' +
        'A single pratt.led node(fields) cannot branch on connector text; needs custom.'),
      nudSeq: custom('estreeExprNudSeq',
        'nudSeq covers bare Ident + decorated class expressions — product types Ident vs ' +
        'ClassExpression; class arm has star(Decorator) + many opt type-params/heritage/' +
        'members. Not a fixed field bind.'),
      nudCapped: custom('estreeArrow',
        'nudCapped are ArrowFunctionExpression forms (async/params/return-type/body). ' +
        'Params are sep(Param) and body is Block|Expr alt; flag async from leading keyword ' +
        '(dropped). Requires handwritten assembly.'),
      postfixTok: { kind: 'keep' },
    },

    // Type system Pratt — no demo coverage; ESTree/TS uses different node set
    Type: {
      kind: 'pratt',
      atom: { kind: 'keep' },
      // IR encodes `| Type` / `& Type` as nudBrackets (not binary ops) — verified via dump.
      group: { kind: 'keep' },
      led: custom('tsTypeLed',
        'Type LEDs include conditional/indexed/keyof-style continuations with ' +
        'heterogeneous field shapes; keep covers atoms only. LED connector→node ' +
        'dispatch needs custom (same argument as Expr.led).'),
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
      led: custom('estreeNewTargetLed',
        'NewTarget LEDs (`.` Ident / `[` Expr `]`) produce MemberExpression vs ' +
        'the `new.target` meta special-case when the left root is the `new` `.` `target` ' +
        'NUD — detecting that root requires looking at left leaf text, not a fixed field bind.'),
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
      kind: 'node',
      type: 'VariableDeclarator',
      // IR: alt(Ident|Pattern) opt(: Type) opt(= Expr)
      // After drops/zero-width: [idOrPattern, opt type, opt init] — but alt+opt nesting
      // means slots are [alt, opt, opt]. Bind positionally with optional trailing.
      fields: [
        { name: 'id', bind: { at: 0 }, typeHint: ['Identifier', 'BindingPattern'] },
        { name: 'typeAnnotation', bind: { from: 'opt', at: 1 }, optional: true, typeHint: 'Type' },
        { name: 'init', bind: { from: 'opt', at: 2 }, optional: true, typeHint: 'Expression' },
      ],
    },
    ForBinding: {
      kind: 'node',
      type: 'VariableDeclarator',
      fields: [
        { name: 'id', bind: { at: 0 }, typeHint: ['Identifier', 'BindingPattern'] },
        { name: 'typeAnnotation', bind: { from: 'opt', at: 1 }, optional: true, typeHint: 'Type' },
        { name: 'init', bind: { from: 'opt', at: 2 }, optional: true, typeHint: 'Expression' },
      ],
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
            'a builder that preserves missing opts as null entries.'),
        },
      ],
    },
    BindingProperty: custom('estreeBindingProperty',
      '4 alts: key:value, shorthand Ident, computed/literal key, rest `...`. ' +
      'Shorthand vs key:value share leading Ident but differ by presence of `:`; after ' +
      'keyword/punct drop the alt identity is the only way to set `shorthand:true`. ' +
      'Primitives have no “which alt matched → boolean flag” form.'),
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
      'for choice+node without a flag-from-alt primitive.'),
    ForHead: custom('estreeForHead',
      '4 alts (for-let/const/var/using ; for(;;) ; for-in ; for-of) are three different ' +
      'ESTree parents (ForStatement / ForInStatement / ForOfStatement) assembled at Stmt ' +
      'level — ForHead alone is not a single node. Mapping it to one node type lies; ' +
      'inlining into Stmt is what ESTree does. Shape for the helper rule is therefore custom ' +
      '(returns a tagged tuple the Stmt builder consumes).'),
    SwitchCase: custom('estreeSwitchCase',
      'SwitchCase alts are Case / Default / bare Stmt. Case is `case Expr star(, Expr) :` — ' +
      'the star encodes a comma expression on the test; Default has zero kids after drops; ' +
      'Stmt alts are consequents that ESTree nests under the PRECEDING case (not a sibling ' +
      'SwitchCase node). inline() for the Stmt arm is correct in isolation but the parent ' +
      'Block/Switch must fold inline stmts into `consequent[]` of the prior case — that ' +
      'cross-rule accumulation is outside any single-rule primitive. custom.'),

    ImportSpecifier: {
      kind: 'choice',
      arms: [
        {
          // opt(type) Ident opt(as Ident) → after drops: Ident, opt(Ident)
          name: 'ident',
          altIndices: [0],
          shape: {
            kind: 'node',
            type: 'ImportSpecifier',
            fields: [
              { name: 'imported', bind: { at: 0 }, typeHint: 'Identifier' },
              { name: 'local', bind: { from: 'opt', at: 1 }, optional: true, typeHint: 'Identifier' },
            ],
          },
        },
        {
          // opt(type) String as Ident → String, Ident (as dropped)
          name: 'stringAs',
          altIndices: [1],
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

    DecoratorExpr: custom('estreeDecorator',
      'alt[0] is `Decorator star(call|typeargs|!|.|?.|Template)` — the star is a ' +
      'left-recursive member/call chain on the decorator expression, not a list field of ' +
      'the Decorator node. list() would mis-type it; node with at:0 ignores the chain. ' +
      'Need a Pratt-like fold over the star — custom (or would need a recursive inline ' +
      'fold primitive we deliberately do not have).'),

    // ─── Class / interface / enum members ──────────────────────────────
    ClassMember: custom('estreeClassMember',
      '6 alts spanning empty/ctor/static-block/decorated-method-field-soup/field. ' +
      'alt[3] alone is a giant nested alt of async/generator/get/set/index/constructor/' +
      'method/field — tens of ESTree ClassBody element types. choice() would need recursive ' +
      'nested choice (forbidden) or an explosion of arms; custom is the honest escape.'),
    InterfaceMember: custom('tsInterfaceMember',
      '6 alts (call/construct signature, get/set, mapped type member, readonly prop, ' +
      'method/prop, index signature) — each a different TS-ESTree node. Same argument as ' +
      'ClassMember: heterogeneous products + dropped modifier keywords.'),
    EnumMember: {
      kind: 'node',
      type: 'TSEnumMember',
      fields: [
        { name: 'id', bind: { at: 0 }, typeHint: 'MemberName' },
        { name: 'initializer', bind: { from: 'opt', at: 1 }, optional: true, typeHint: 'Expression' },
      ],
    },
    TypeMember: custom('tsTypeMember',
      '4 alts of object-type members (prop/call/construct/index-like). Heterogeneous ' +
      'TS-ESTree products + optional modifiers; choice would work for naming but field ' +
      'binds fight optional `?`/`readonly` dropped leaves — custom recovers flags.'),
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
      '12 alts covering object literal props (key:value, method, get/set, spread, ' +
      'shorthand, computed). Shorthand vs keyed distinguished only by alt; spread is ' +
      '`...` Expr. Same “alt → flag / product type” gap as BindingProperty.'),
  },
};

/** Helper: assert we listed all 30 cstNames (used by runner). */
export const EXPECTED_CST_NAMES = [
  'Type', 'TypeMember', 'DecoratorExpr', 'TypeofRef', 'Expr', 'Prop', 'MemberName',
  'NewTarget', 'ClassHeritage', 'Stmt', 'Block', 'BindingProperty', 'BindingElement',
  'ArrayBindingElement', 'BindingPattern', 'Binding', 'ForBinding', 'Param', 'ForHead',
  'SwitchCase', 'TypeParams', 'TypeParam', 'Decl', 'InterfaceMember', 'ClassMember',
  'EnumMember', 'ImportClause', 'ImportSpecifier', 'ExportSpecifier', 'Program',
] as const;


/** Positional stub customs — SH2-2 acceptance parity only (ESTree fidelity → SH2-3). */
export type TsAstCustomCtx = {
  kids: readonly unknown[];
  altPath: readonly number[];
  src: string;
  off: number;
  end: number;
  left?: unknown;
};
export type TsAstCustoms = Record<string, (ctx: TsAstCustomCtx) => unknown>;

const stub = (name: string) => (ctx: TsAstCustomCtx) => ({
  type: `Stub_${name}`,
  children: ctx.kids,
  altPath: ctx.altPath,
  ...(ctx.left !== undefined ? { left: ctx.left } : {}),
});

export const typescriptStubCustoms: TsAstCustoms = {
  estreeStmt: stub('Stmt'),
  estreeDecl: stub('Decl'),
  estreeParenOrComma: stub('ParenOrComma'),
  estreeExprLed: stub('ExprLed'),
  estreeExprNudSeq: stub('ExprNudSeq'),
  estreeArrow: stub('Arrow'),
  tsTypeLed: stub('TypeLed'),
  estreeNewTargetLed: stub('NewTargetLed'),
  estreeArrayPattern: stub('ArrayPattern'),
  estreeBindingProperty: stub('BindingProperty'),
  estreeParam: stub('Param'),
  estreeForHead: stub('ForHead'),
  estreeSwitchCase: stub('SwitchCase'),
  estreeDecorator: stub('Decorator'),
  estreeClassMember: stub('ClassMember'),
  tsInterfaceMember: stub('InterfaceMember'),
  tsTypeMember: stub('TypeMember'),
  estreeProp: stub('Prop'),
};
