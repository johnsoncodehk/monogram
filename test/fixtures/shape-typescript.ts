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
    Stmt: {
      kind: 'custom',
      fn: 'estreeStmt',
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
      prefix: custom('estreeExprPrefix',
        'Prefix ++/-- must be UpdateExpression(prefix:true); other ops stay UnaryExpression. ' +
        'A single declarative UnaryExpression node cannot branch on opText.'),
      binary: custom('estreeExprBinary',
        'Expr binary covers assignment (= += … ??= ||= &&=), logical (?? || &&), and relational/' +
        'arithmetic ops — three ESTree families (AssignmentExpression / LogicalExpression / ' +
        'BinaryExpression). Declarative BinaryExpression alone mis-types assignments and logicals.'),
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
        'A single pratt.led node(fields) cannot branch on connector/alt; needs custom.'),
      nudSeq: custom('estreeExprNudSeq',
        'nudSeq covers bare Ident + decorated class expressions — product types Ident vs ' +
        'ClassExpression; class arm has star(Decorator) + many opt type-params/heritage/' +
        'members. Not a fixed field bind.'),
      nudCapped: custom('estreeArrow',
        'nudCapped are ArrowFunctionExpression forms (async/params/return-type/body). ' +
        'Params are sep(Param) and body is Block|Expr alt; flag async from leading keyword ' +
        '(dropped). Requires handwritten assembly.'),
      postfixTok: custom('estreeExprPostfixTok',
        'postfixTok Template on Expr is TaggedTemplateExpression (tag=left, quasi=leaf); ' +
        'keep would leave a raw Expr children pair.'),
    },

    // Type system Pratt — no demo coverage; ESTree/TS uses different node set
    Type: {
      kind: 'pratt',
      atom: { kind: 'keep' },
      // IR encodes `| Type` / `& Type` as nudBrackets (not binary ops) — verified via dump.
      group: custom('tsTypeLed',
        'Type group identities are heterogeneous; object-type group 7 lowers to TSTypeLiteral, ' +
        'while other groups retain their explicit Type wrapper. C7 dispatches group vs LED ' +
        'by whether opText is present.'),
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
    SwitchCase: {
      ...custom('estreeSwitchCase',
      'SwitchCase alts are Case / Default / bare Stmt. Case is `case Expr star(, Expr) :` — ' +
      'the star encodes a comma expression on the test; Default has zero kids after drops; ' +
      'Stmt alts are consequents that ESTree nests under the PRECEDING case (not a sibling ' +
      'SwitchCase node). inline() for the Stmt arm is correct in isolation but the parent ' +
      'Block/Switch must fold inline stmts into `consequent[]` of the prior case — that ' +
      'cross-rule accumulation is outside any single-rule primitive. custom.'),
      result: 'partial',
    },

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
    case 15: return { type: 'WithStatement', object: k[1], body: k[2] };
    case 16: return { type: 'VariableDeclaration', kind: 'using', declarations: flatKids(k.slice(-1)) };
    case 17: return firstKid(k) ?? k[0];
    case 18: {
      const expr = stripAsi(k)[0];
      return { type: 'ExpressionStatement', expression: expr };
    }
    default: return unhandledCustom('estreeStmt', ctx);
  }
}

function estreeDecl(ctx: TsAstCustomCtx): unknown {
  const arm = ctx.altPath[0];
  const k = Array.isArray(ctx.kids) ? ctx.kids : [ctx.kids];
  if (arm === 17) return { type: 'ExportNamedDeclaration', declaration: k[0] };
  if (arm === 18) return { type: 'ExportNamedDeclaration', specifiers: flatKids(k) };
  if (arm === 19) return { type: 'ExportAllDeclaration', source: k[0] };
  if (arm === 20) return { type: 'ExportDefaultDeclaration', declaration: k[0] };
  if (arm === 21) return { type: 'ImportDeclaration', specifiers: flatKids(k[1] ?? k), source: k[2] ?? k[1] };
  if (arm === 22) return { type: 'TSImportEqualsDeclaration', id: k[0], moduleReference: k[1] };
  if (arm === 23) return { type: 'TSModuleDeclaration', id: k[0], body: k[1] };
  if (arm === 24) return { type: 'TSModuleDeclaration', id: k[0], body: k[1], declare: true };
  if (arm === 25) return { type: 'TSNamespaceExportDeclaration', id: k[0] };
  if (arm === 26) return { type: 'TSEnumDeclaration', id: k[0], members: flatKids(k[1] ?? []) };
  if (arm === 27) return { type: 'TSInterfaceDeclaration', id: k[0], body: k[1] };
  if (arm === 4) return {
    type: 'TSInterfaceDeclaration',
    id: k[0],
    typeParameters: k[1] ?? null,
    extends: flatKids(k[2] ?? []),
    body: { type: 'TSInterfaceBody', body: flatKids(k[3] ?? []) },
  };
  if (arm === 5) return { type: 'TSTypeAliasDeclaration', id: k[0], typeParameters: k[1] ?? null, typeAnnotation: k[2] };
  if (arm === 6) return {
    type: 'ClassDeclaration',
    decorators: flatKids(k[0] ?? []),
    id: k[1] ?? null,
    superClass: flatKids(k[3] ?? [])[0] ?? null,
    body: { type: 'ClassBody', body: flatKids(k[4] ?? []) },
  };
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
  if (arm === 7) return { type: 'MetaProperty', meta: I('new'), property: I('target') };
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

function estreeForHead(ctx: TsAstCustomCtx): unknown {
  const arm = ctx.altPath[0];
  if (arm === 0) return { type: 'ForHead', kind: 'classic', init: kDecl(ctx.kids[0]), test: ctx.kids[1] ?? null, update: ctx.kids[2] ?? null };
  if (arm === 1) return {
    type: 'ForHead',
    kind: 'classic',
    init: seqExpr(ctx.kids[0], null),
    test: seqExpr(ctx.kids[1], null),
    update: seqExpr(ctx.kids[2], null),
  };
  if (arm === 2) return { type: 'ForHead', kind: 'in', left: ctx.kids[0], right: ctx.kids[1] };
  if (arm === 3) return { type: 'ForHead', kind: 'of', left: ctx.kids[0], right: ctx.kids[1], await: ctx.src.slice(ctx.off, ctx.off + 5).includes('await') };
  return unhandledCustom('estreeForHead', ctx);
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
  const chain = flatKids(ctx.kids);
  const head = chain[0];
  let expr: unknown = typeof head === 'string' && head.startsWith('@') ? I(head.slice(1)) : head;
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
  if (arm === 0) return null;
  if (arm === 1) return { type: 'MethodDefinition', kind: 'constructor', key: I('constructor'), value: { type: 'FunctionExpression', params: flatKids(ctx.kids[0] ?? []), body: ctx.kids[1] }, static: false };
  if (arm === 2) return { type: 'StaticBlock', body: ctx.kids[0] };
  if (arm === 4) return { type: 'PropertyDefinition', key: ctx.kids[0], value: ctx.kids[1] ?? null, static: false, readonly: false };
  if (arm !== 3 && arm !== 5) return unhandledCustom('estreeClassMember', ctx);
  const nested = ctx.altPath[1];
  if (arm === 3 && nested === 8) {
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
  if (arm === 5) return { type: 'MethodDefinition', kind: 'method', key: ctx.kids[0], value: ctx.kids[1], static: true };
  if (nested !== undefined && nested >= 0 && nested <= 8) {
    return { type: 'MethodDefinition', kind: 'method', key: ctx.kids[0], value: ctx.kids[1], static: false };
  }
  return unhandledCustom('estreeClassMember', ctx);
}

function tsInterfaceMember(ctx: TsAstCustomCtx): unknown {
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
  if (arm === 1) return { type: 'TSMethodSignature', kind: ctx.src.slice(ctx.off, ctx.off + 3), key: ctx.kids[0], params: flatKids(ctx.kids[1] ?? []), returnType: ctx.kids[2] ?? null };
  if (arm === 2) return { type: 'TSMappedType', key: ctx.kids[0], constraint: ctx.kids[1], typeAnnotation: ctx.kids[ctx.kids.length - 1] };
  if (arm === 3) return { type: 'TSPropertySignature', key: ctx.kids[0], typeAnnotation: ctx.kids[1], optional: ctx.src.includes('?'), readonly: true };
  if (arm === 4) {
    const method = Array.isArray(ctx.kids[2]);
    return method
      ? { type: 'TSMethodSignature', key: ctx.kids[0], params: flatKids(ctx.kids[2]), returnType: ctx.kids[3] ?? null, optional: ctx.src.includes('?') }
      : { type: 'TSPropertySignature', key: ctx.kids[0], typeAnnotation: ctx.kids[1], optional: ctx.src.includes('?'), readonly: false };
  }
  if (arm === 5) return { type: 'TSIndexSignature', parameters: flatKids(ctx.kids[0] ?? []), typeAnnotation: ctx.kids[1] ?? null };
  return unhandledCustom('tsInterfaceMember', ctx);
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
  if (arm === 1) return { type: 'TSIndexSignature', parameters: ctx.kids[0], typeAnnotation: ctx.kids[ctx.kids.length - 1] ?? null };
  if (arm === 2) return { type: 'TSPropertySignature', key: ctx.kids[0], typeAnnotation: ctx.kids[1], optional: ctx.src.includes('?'), readonly: true };
  if (arm === 3) {
    const method = Array.isArray(ctx.kids[2]);
    return method
      ? { type: 'TSMethodSignature', key: ctx.kids[0], params: flatKids(ctx.kids[2]), returnType: ctx.kids[3] ?? null, optional: ctx.src.includes('?') }
      : { type: 'TSPropertySignature', key: ctx.kids[0], typeAnnotation: ctx.kids[1], optional: ctx.src.includes('?'), readonly: false };
  }
  return unhandledCustom('tsTypeMember', ctx);
}

function estreeProp(ctx: TsAstCustomCtx): unknown {
  const arm = ctx.altPath[0];
  const k = ctx.kids;
  if (arm === 4 || arm === 5) return { type: 'Property', key: I(String(k[0])), value: I(String(k[0])), kind: 'init', shorthand: true, computed: false, method: false };
  if (arm === 8) return { type: 'SpreadElement', argument: k[0] };
  if (arm === 6 || arm === 7) return { type: 'Property', key: k[0], value: k[1], kind: arm === 6 ? 'get' : 'set', shorthand: false, computed: false, method: false };
  if (arm === 2 || arm === 3) return { type: 'Property', key: k[0], value: { type: 'FunctionExpression', params: flatKids(k[1] ?? []), body: k[2] }, kind: 'init', method: true, shorthand: false, computed: false };
  if (arm === 0 || arm === 1 || (arm >= 9 && arm <= 11)) {
    return { type: 'Property', key: typeof k[0] === 'string' ? I(k[0]) : k[0], value: k[1], kind: 'init', shorthand: false, computed: arm === 1, method: false };
  }
  return unhandledCustom('estreeProp', ctx);
}

/** Back-compat alias used by shape-parity acceptance gate. */
export const typescriptEstreeCustoms: TsAstCustoms = {
  estreeStmt,
  estreeDecl,
  estreeParenOrComma,
  estreeExprBinary,
  estreeExprPrefix,
  estreeExprPostfixTok,
  estreeExprLed,
  estreeExprNudSeq,
  estreeArrow,
  tsTypeLed,
  estreeNewTargetLed,
  estreeArrayPattern,
  estreeBindingProperty,
  estreeParam,
  estreeForHead,
  estreeSwitchCase,
  estreeDecorator,
  estreeClassMember,
  tsInterfaceMember,
  tsTypeMember,
  estreeProp,
};

/** @deprecated SH2-2 stub name — parity imports this alias. */
export const typescriptStubCustoms = typescriptEstreeCustoms;
