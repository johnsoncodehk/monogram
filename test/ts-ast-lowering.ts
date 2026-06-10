// EXPERIMENT: a real consumer — lower the Monogram TypeScript CST into a tsc-shaped AST
// (node kinds named after ts.SyntaxKind, spans = token spans), to surface the REAL pain
// points of consuming the CST. Every friction met while writing this is tagged PAIN(n)
// at the exact site; test/ts-ast-verify.ts compares the result against the real tsc AST
// node-by-node (kind + start + end, pre-order).
//
// Deliberately NOT complete: unlowered constructs throw Unlowered (the verify driver
// counts them) — the goal is an honest pain inventory, not a shipped frontend.
import { matchStmt } from '../typescript.cst-match.ts';
import type { ObjTree } from './obj-tree.ts';

export type Ast = { kind: string; pos: number; end: number; children: Ast[] };
const ast = (kind: string, pos: number, end: number, children: Ast[] = []): Ast => ({ kind, pos, end, children });

export class Unlowered extends Error {
  what: string;
  at: number;
  constructor(what: string, at: number) {
    super(`unlowered: ${what} @${at}`);
    this.what = what;
    this.at = at;
  }
}

// ── Generic CST helpers over ARENA ENTRIES ──
// A node is an id (>= 0), a leaf a token-encoded entry (< 0) — read through TreeAccess.
// CAUTION: node id 0 is VALID and FALSY — every optional-entry check must compare
// against undefined, never truthiness.
type E = number;
let SRC = '';
let T!: ObjTree;
const isLeaf = (n: E | undefined): boolean => n !== undefined && n < 0;
const isNode = (n: E | undefined): boolean => n !== undefined && n >= 0;
const off = (n: E): number => T.offsetOf(n);
const end = (n: E): number => T.endOf(n);
const text = (n: E): string => SRC.slice(T.offsetOf(n), T.endOf(n));
const tokTypeOf = (n: E): string => T.leafTokenType(n);
const ruleNameOf = (n: E): string => T.ruleNameOf(n);
const kidsOf = (n: E): E[] => {
  const cc = T.childCount(n);
  const a: E[] = new Array(cc);
  for (let i = 0; i < cc; i++) a[i] = T.childAt(n, i);
  return a;
};
const leafIs = (n: E | undefined, t: string): boolean => n !== undefined && n < 0 && text(n) === t;
const ruleIs = (n: E | undefined, r: string): n is E => n !== undefined && n >= 0 && T.ruleNameOf(n) === r;
const findRule = (cs: E[], r: string): E | undefined => cs.find((c) => ruleIs(c, r));
const rules = (cs: E[], r: string): E[] => cs.filter((c) => ruleIs(c, r));
const findText = (cs: E[], t: string): number => cs.findIndex((c) => c < 0 && text(c) === t);

// PAIN(2): operator/punct leaves carry no token-kind — a consumer mapping to a typed AST
// (tsc SyntaxKind enums) must own a full literal-text → kind table and pay a getText per
// operator. The parser KNEW the literal id (tok.t) and threw it away at the leaf.
const TOKEN_KIND: Record<string, string> = {
  '+': 'PlusToken', '-': 'MinusToken', '*': 'AsteriskToken', '/': 'SlashToken', '%': 'PercentToken',
  '**': 'AsteriskAsteriskToken', '==': 'EqualsEqualsToken', '!=': 'ExclamationEqualsToken',
  '===': 'EqualsEqualsEqualsToken', '!==': 'ExclamationEqualsEqualsToken',
  '<': 'LessThanToken', '>': 'GreaterThanToken', '<=': 'LessThanEqualsToken', '>=': 'GreaterThanEqualsToken',
  '&&': 'AmpersandAmpersandToken', '||': 'BarBarToken', '??': 'QuestionQuestionToken',
  '&': 'AmpersandToken', '|': 'BarToken', '^': 'CaretToken', '<<': 'LessThanLessThanToken',
  '>>': 'GreaterThanGreaterThanToken', '>>>': 'GreaterThanGreaterThanGreaterThanToken',
  '=': 'EqualsToken', '+=': 'PlusEqualsToken', '-=': 'MinusEqualsToken', '*=': 'AsteriskEqualsToken',
  '/=': 'SlashEqualsToken', '%=': 'PercentEqualsToken', '**=': 'AsteriskAsteriskEqualsToken',
  '<<=': 'LessThanLessThanEqualsToken', '>>=': 'GreaterThanGreaterThanEqualsToken',
  '>>>=': 'GreaterThanGreaterThanGreaterThanEqualsToken', '&=': 'AmpersandEqualsToken',
  '|=': 'BarEqualsToken', '^=': 'CaretEqualsToken', '&&=': 'AmpersandAmpersandEqualsToken',
  '||=': 'BarBarEqualsToken', '??=': 'QuestionQuestionEqualsToken',
  ',': 'CommaToken', 'in': 'InKeyword', 'instanceof': 'InstanceOfKeyword',
};
const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '**=', '<<=', '>>=', '>>>=', '&=', '|=', '^=', '&&=', '||=', '??=']);

// ── Expressions ──
// The Expr rule is a Pratt rule: its CST shapes are positional patterns, one per
// nud/led form. PAIN(3): the LOWERER re-derives which form matched by probing child
// counts and leaf texts — the parser's own dispatch decision is not in the tree.
function lowerExpr(n: E): Ast {
  const c = kidsOf(n);

  // Single-child wrapper around a primary (Expr[Number] / Expr[Ident] / Expr[String] …).
  // PAIN(4): every primary is wrapped in an extra Expr node the AST must collapse.
  if (c.length === 1) {
    const k = c[0];
    if (isNode(k)) {
      // PAIN(12): the interpolated-template node's rule is the SYNTHETIC '$template'
      // (not the grammar's token name 'Template') — one more name to know by heart.
      if (ruleNameOf(k) === 'Template' || ruleNameOf(k) === '$template') return lowerTemplate(k);
      if (ruleNameOf(k) === 'Expr') return lowerExpr(k);
      throw new Unlowered(`Expr wrapper of ${ruleNameOf(k)}`, off(n));
    }
    return lowerPrimaryLeaf(k);
  }

  // Prefix unary: [$operator, Expr]
  if (isLeaf(c[0]) && tokTypeOf(c[0]) === '$operator' && c.length === 2 && ruleIs(c[1], 'Expr')) {
    const op = text(c[0]);
    if (op === 'await') return ast('AwaitExpression', off(n), end(n), [lowerExpr(c[1])]);
    if (op === 'typeof') return ast('TypeOfExpression', off(n), end(n), [lowerExpr(c[1])]);
    if (op === 'void') return ast('VoidExpression', off(n), end(n), [lowerExpr(c[1])]);
    if (op === 'delete') return ast('DeleteExpression', off(n), end(n), [lowerExpr(c[1])]);
    if (op === 'yield') return ast('YieldExpression', off(n), end(n), [lowerExpr(c[1])]);
    return ast('PrefixUnaryExpression', off(n), end(n), [lowerExpr(c[1])]);
  }

  // led forms: lhs is ALWAYS child 0 (a rule node).
  if (ruleIs(c[0], 'Expr')) {
    const lhs = c[0];
    const k1 = c[1];

    // Postfix: [Expr, '!' | '++' | '--']
    if (c.length === 2 && isLeaf(k1)) {
      const t = text(k1);
      if (t === '!') return ast('NonNullExpression', off(n), end(n), [lowerExpr(lhs)]);
      if (t === '++' || t === '--') return ast('PostfixUnaryExpression', off(n), end(n), [lowerExpr(lhs)]);
    }
    // Tagged template: [Expr, Template|$template]
    if (c.length === 2 && (ruleIs(k1, 'Template') || ruleIs(k1, '$template'))) {
      return ast('TaggedTemplateExpression', off(n), end(n), [lowerExpr(lhs), lowerTemplate(k1)]);
    }

    if (isLeaf(k1)) {
      const t1 = text(k1);
      // Member access: [Expr, '.'|'?.', Ident|PrivateField]
      if ((t1 === '.' || t1 === '?.') && c.length === 3 && isLeaf(c[2])) {
        // PAIN(10): tsc's forEachChild yields TOKEN children irregularly per kind
        // (?. yes, '.' no; '?'/':' of a conditional yes, '(' ')' never) — a consumer
        // matching that shape must encode the irregularity case by case.
        const q = t1 === '?.' ? [ast('QuestionDotToken', off(k1), end(k1))] : [];
        const nameKind = tokTypeOf(c[2]) === 'PrivateField' ? 'PrivateIdentifier' : 'Identifier';
        return ast('PropertyAccessExpression', off(n), end(n), [lowerExpr(lhs), ...q, ast(nameKind, off(c[2]), end(c[2]))]);
      }
      // Element access: [Expr, '[', Expr, ']']
      if (t1 === '[' && c.length === 4 && ruleIs(c[2], 'Expr')) {
        return ast('ElementAccessExpression', off(n), end(n), [lowerExpr(lhs), lowerExpr(c[2])]);
      }
      // Call: [Expr, '(', (Expr (',' Expr)*)?, ')']  (also '?.(' optional call)
      if (t1 === '(' || (t1 === '?.' && leafIs(c[2], '('))) {
        const args = rules(c, 'Expr').slice(1).map(lowerExpr);
        return ast('CallExpression', off(n), end(n), [lowerExpr(lhs), ...args]);
      }
      // Generic call: [Expr, '<', Type…, '>', '(' … ')'] — the type args led.
      if (t1 === '<') {
        const close = findText(c, '(');
        if (close >= 0) {
          const args = c.slice(close).filter((x): x is E => ruleIs(x, 'Expr')).map(lowerExpr);
          const targs = rules(c.slice(0, close), 'Type').map(lowerType);
          return ast('CallExpression', off(n), end(n), [lowerExpr(lhs), ...targs, ...args]);
        }
      }
      // Conditional: [Expr, '?', Expr, ':', Expr]
      if (t1 === '?' && c.length === 5 && ruleIs(c[2], 'Expr') && ruleIs(c[4], 'Expr')) {
        return ast('ConditionalExpression', off(n), end(n), [
          lowerExpr(lhs), ast('QuestionToken', off(k1), end(k1)), lowerExpr(c[2]),
          ast('ColonToken', off(c[3]), end(c[3])), lowerExpr(c[4]),
        ]);
      }
      // as / satisfies: [Expr, 'as'|'satisfies', Type]
      if (t1 === 'as' && c.length === 3 && ruleIs(c[2], 'Type')) {
        return ast('AsExpression', off(n), end(n), [lowerExpr(lhs), lowerType(c[2])]);
      }
      if (t1 === 'satisfies' && c.length === 3 && ruleIs(c[2], 'Type')) {
        return ast('SatisfiesExpression', off(n), end(n), [lowerExpr(lhs), lowerType(c[2])]);
      }
      // Binary (incl. assignment / 'in' / 'instanceof'): [Expr, $operator|kw, Expr]
      if (c.length === 3 && ruleIs(c[2], 'Expr') && (tokTypeOf(k1) === '$operator' || t1 === 'in' || t1 === 'instanceof')) {
        const tok = TOKEN_KIND[t1];
        if (!tok) throw new Unlowered(`binary op ${t1}`, off(k1));
        return ast('BinaryExpression', off(n), end(n), [lowerExpr(lhs), ast(tok, off(k1), end(k1)), lowerExpr(c[2])]);
      }
    }
  }

  // nud forms led by a punct/keyword leaf.
  if (isLeaf(c[0])) {
    const t0 = text(c[0]);
    // Spread: ['...', Expr]
    if (t0 === '...' && c.length === 2 && ruleIs(c[1], 'Expr')) {
      return ast('SpreadElement', off(n), end(n), [lowerExpr(c[1])]);
    }
    // Old-style type assertion: ['<', Type, '>', Expr]
    if (t0 === '<' && c.length === 4 && ruleIs(c[1], 'Type') && ruleIs(c[3], 'Expr')) {
      return ast('TypeAssertionExpression', off(n), end(n), [lowerType(c[1]), lowerExpr(c[3])]);
    }
    // Parenthesized vs arrow: both arms start '(' (or 'async' '(' for an async arrow).
    // PAIN(5): two different grammar ALTERNATIVES with the same first token reach the
    // consumer as child-shape puzzles — '(' Expr ')' vs '(' Param* ')' '=>' …; the
    // discriminant (did the arrow arm match?) is re-derived by scanning for '=>'.
    if (t0 === '(' || (t0 === 'async' && leafIs(c[1], '('))) {
      const arrowIdx = findText(c, '=>');
      if (arrowIdx < 0 && c.length === 3 && ruleIs(c[1], 'Expr')) {
        return ast('ParenthesizedExpression', off(n), end(n), [lowerExpr(c[1])]);
      }
      if (arrowIdx >= 0) return lowerArrow(n, c, arrowIdx);
    }
    // Async single-param arrow: ['async' Ident '=>' body] — tsc: ArrowFunction with
    // an AsyncKeyword modifier, then the bare parameter.
    if (t0 === 'async' && c[1] && isLeaf(c[1]) && tokTypeOf(c[1]) === 'Ident' && leafIs(c[2], '=>')) {
      const params = [ast('Parameter', off(c[1]), end(c[1]), [ast('Identifier', off(c[1]), end(c[1]))])];
      const body = c[3];
      const bodyAst = ruleIs(body, 'Expr') ? lowerExpr(body) : ruleIs(body, 'Block') ? lowerBlock(body) : null;
      if (!bodyAst) throw new Unlowered('arrow body', off(n));
      return ast('ArrowFunction', off(n), end(n), [ast('AsyncKeyword', off(c[0]), end(c[0])), ...params, ast('EqualsGreaterThanToken', off(c[2]), end(c[2])), bodyAst]);
    }
    // Single-param arrow: [Ident…?] — actually [Param-less ident '=>' body]
    if (c[0] && isLeaf(c[0]) && tokTypeOf(c[0]) === 'Ident' && leafIs(c[1], '=>')) {
      const params = [ast('Parameter', off(c[0]), end(c[0]), [ast('Identifier', off(c[0]), end(c[0]))])];
      const body = c[2];
      const bodyAst = ruleIs(body, 'Expr') ? lowerExpr(body) : ruleIs(body, 'Block') ? lowerBlock(body) : null;
      if (!bodyAst) throw new Unlowered('arrow body', off(n));
      return ast('ArrowFunction', off(n), end(n), [...params, ast('EqualsGreaterThanToken', off(c[1]), end(c[1])), bodyAst]);
    }
    // Array literal: '[' (Expr | ',')* ']'  (holes = consecutive commas → OmittedExpression)
    if (t0 === '[') {
      const elems: Ast[] = [];
      let expectElem = true;
      let sepEnd = end(c[0]);
      for (const k of c.slice(1)) {
        if (isLeaf(k)) {
          const t = text(k);
          if (t === ',') {
            if (expectElem) elems.push(ast('OmittedExpression', sepEnd, sepEnd));
            expectElem = true;
            sepEnd = end(k);
          }
          continue;
        }
        if (ruleIs(k, 'Expr')) { elems.push(lowerExpr(k)); expectElem = false; }
      }
      return ast('ArrayLiteralExpression', off(n), end(n), elems);
    }
    // Object literal: '{' Prop* '}'
    if (t0 === '{') {
      const props = rules(c, 'Prop').map(lowerProp);
      return ast('ObjectLiteralExpression', off(n), end(n), props);
    }
    // new: ['new', NewTarget, ('(' args ')')?]
    if (t0 === 'new') {
      // PAIN(6): the operand rule is named 'NewTarget' — which reads as `new.target`
      // but actually means "the thing being constructed"; only reading the grammar
      // reveals that. Rule names are the consumer's API and they leak grammar-internal
      // naming.
      const target = findRule(c, 'NewTarget');
      if (target === undefined) throw new Unlowered('new operand', off(n));
      const args = rules(c, 'Expr').map(lowerExpr);
      return ast('NewExpression', off(n), end(n), [lowerNewTarget(target), ...args]);
    }
    if (t0 === 'function') return lowerFunctionLike(n, c, 'FunctionExpression');
    if (t0 === 'class') return lowerClassLike(n, c, 'ClassExpression');
    if (t0 === 'this') return ast('ThisKeyword', off(n), end(n));
    if (t0 === 'super') return ast('SuperKeyword', off(n), end(n));
  }

  throw new Unlowered(`Expr shape [${c.map((x) => (isLeaf(x) ? JSON.stringify(text(x)) : ruleNameOf(x))).join(' ')}]`, off(n));
}

function lowerPrimaryLeaf(k: E): Ast {
  switch (tokTypeOf(k)) {
    case 'Ident': return ast('Identifier', off(k), end(k));
    // (PAIN(19) RESOLVED at the grammar: the keyword-valued literal alternatives now
    // precede the bare-identifier nud, so `this`/`true`/… arrive as $keyword leaves
    // and the $keyword case below handles them — no text re-classification.)
    case 'Number': case 'HexNumber': case 'OctalNumber': case 'BinaryNumber':
      return ast('NumericLiteral', off(k), end(k));
    case 'BigInt': return ast('BigIntLiteral', off(k), end(k));
    case 'String': return ast('StringLiteral', off(k), end(k));
    case 'Regex': return ast('RegularExpressionLiteral', off(k), end(k));
    case 'Template': return ast('NoSubstitutionTemplateLiteral', off(k), end(k));
    case 'PrivateField': return ast('PrivateIdentifier', off(k), end(k));
    case '$keyword': {
      const t = text(k);
      if (t === 'true') return ast('TrueKeyword', off(k), end(k));
      if (t === 'false') return ast('FalseKeyword', off(k), end(k));
      if (t === 'null') return ast('NullKeyword', off(k), end(k));
      if (t === 'this') return ast('ThisKeyword', off(k), end(k));
      if (t === 'super') return ast('SuperKeyword', off(k), end(k));
      if (t === 'undefined') return ast('Identifier', off(k), end(k));   // tsc: undefined is an Identifier
      break;
    }
  }
  throw new Unlowered(`primary leaf ${tokTypeOf(k)} ${JSON.stringify(text(k))}`, off(k));
}

function lowerTemplate(n: E): Ast {
  // $template node: head + (Expr middle)* tail; a no-substitution template is one leaf.
  // PAIN(11): tsc nests each (expression, middle/tail) pair in a TemplateSpan node with
  // a synthesized span — the CST's flat run must be re-grouped pairwise by the consumer.
  const c = kidsOf(n);
  if (c.length === 1 && isLeaf(c[0])) return ast('NoSubstitutionTemplateLiteral', off(n), end(n));
  const head = c[0] as E;
  const parts: Ast[] = [ast('TemplateHead', off(head), end(head))];
  for (let i = 1; i < c.length; i += 2) {
    const expr = c[i];
    const lit = c[i + 1] as E | undefined;
    if (!ruleIs(expr, 'Expr') || lit === undefined) break;
    const litKind = tokTypeOf(lit) === '$templateTail' ? 'TemplateTail' : 'TemplateMiddle';
    parts.push(ast('TemplateSpan', off(expr), end(lit), [lowerExpr(expr), ast(litKind, off(lit), end(lit))]));
  }
  return ast('TemplateExpression', off(n), end(n), parts);
}

function lowerNewTarget(n: E): Ast {
  const c = kidsOf(n);
  if (c.length === 1 && isLeaf(c[0])) return ast('Identifier', off(c[0]), end(c[0]));
  if (ruleIs(c[0], 'NewTarget') && c.length === 3 && isLeaf(c[2])) {
    return ast('PropertyAccessExpression', off(n), end(n), [lowerNewTarget(c[0]), ast('Identifier', off(c[2]), end(c[2]))]);
  }
  // index form: NewTarget '[' Expr ']'  (`new benchmarks[i]()`)
  if (ruleIs(c[0], 'NewTarget') && c.length === 4 && leafIs(c[1], '[') && ruleIs(c[2], 'Expr')) {
    return ast('ElementAccessExpression', off(n), end(n), [lowerNewTarget(c[0]), lowerExpr(c[2])]);
  }
  if (c.length === 1 && ruleIs(c[0], 'Expr')) return lowerExpr(c[0]);
  throw new Unlowered('NewTarget shape', off(n));
}

function lowerArrow(n: E, c: E[], arrowIdx: number): Ast {
  const asyncMod = isLeaf(c[0]) && text(c[0]) === 'async'
    ? [ast('AsyncKeyword', off(c[0]), end(c[0]))] : [];
  const params = rules(c.slice(0, arrowIdx), 'Param').map(lowerParam);
  const retT = findRule(c.slice(0, arrowIdx), 'Type');
  const arrowTok = c[arrowIdx];
  const body = c[arrowIdx + 1];
  const bodyAst = ruleIs(body, 'Expr') ? lowerExpr(body) : ruleIs(body, 'Block') ? lowerBlock(body) : null;
  if (!bodyAst) throw new Unlowered('arrow body', off(n));
  return ast('ArrowFunction', off(n), end(n), [...asyncMod, ...params, ...(retT !== undefined ? [lowerType(retT)] : []),
    ast('EqualsGreaterThanToken', off(arrowTok), end(arrowTok)), bodyAst]);
}

function lowerProp(n: E): Ast {
  const c = kidsOf(n);
  // PAIN(7): the Prop rule's arms (shorthand / key:value / method / spread / get/set)
  // again only distinguishable by probing. Spot-checks below are the minimum survival set.
  if (leafIs(c[0], '...')) return ast('SpreadAssignment', off(n), end(n), [lowerExpr(c[1] as E)]);
  const keyNode = ruleIs(c[0], 'MemberName') ? c[0] : undefined;
  const colon = findText(c, ':');
  if (colon >= 0 && ruleIs(c[colon + 1], 'Expr')) {
    const key = c[0];
    const keyAst = keyNode !== undefined ? lowerMemberName(keyNode)
      : isLeaf(key)
        ? (tokTypeOf(key) === 'String' ? ast('StringLiteral', off(key), end(key))
          : tokTypeOf(key) === 'Number' ? ast('NumericLiteral', off(key), end(key))
          : ast('Identifier', off(key), end(key)))
        : lowerExpr(key);
    return ast('PropertyAssignment', off(n), end(n), [keyAst, lowerExpr(c[colon + 1] as E)]);
  }
  if (c.length === 1 && isLeaf(c[0])) {
    return ast('ShorthandPropertyAssignment', off(n), end(n), [ast('Identifier', off(c[0]), end(c[0]))]);
  }
  // method-ish (`m() {}` / get/set/async/*) — find the Param/Block tail.
  if (findRule(c, 'Block') !== undefined) {
    const params = rules(c, 'Param').map(lowerParam);
    const block = lowerBlock(findRule(c, 'Block')!);
    const name = keyNode !== undefined ? [lowerMemberName(keyNode)] : [];
    return ast('MethodDeclaration', off(n), end(n), [...name, ...params, block]);
  }
  throw new Unlowered(`Prop shape`, off(n));
}

function lowerParam(n: E): Ast {
  const c = kidsOf(n);
  const kids: Ast[] = [];
  const PMOD: Record<string, string> = {
    public: 'PublicKeyword', private: 'PrivateKeyword', protected: 'ProtectedKeyword',
    readonly: 'ReadonlyKeyword', override: 'OverrideKeyword',
  };
  let i0 = 0;
  while (i0 < c.length && isLeaf(c[i0]) && PMOD[text(c[i0])] && c[i0 + 1] !== undefined && !leafIs(c[i0 + 1], ':') && !leafIs(c[i0 + 1], ',') && !leafIs(c[i0 + 1], ')')) {
    kids.push(ast(PMOD[text(c[i0])], off(c[i0]), end(c[i0])));
    i0++;
  }
  if (leafIs(c[i0], '...')) kids.push(ast('DotDotDotToken', off(c[i0]), end(c[i0])));
  for (let i = i0; i < c.length; i++) {
    const k = c[i];
    if (isLeaf(k) && tokTypeOf(k) === 'Ident') kids.push(ast('Identifier', off(k), end(k)));
    else if (ruleIs(k, 'BindingPattern')) kids.push(lowerBindingPattern(k));
    else if (ruleIs(k, 'Type') && leafIs(c[i - 1], ':')) kids.push(lowerType(k));
    else if (ruleIs(k, 'Expr')) kids.push(lowerExpr(k));
  }
  return ast('Parameter', off(n), end(n), kids);
}

// ── Types (minimal): enough to survive annotated code; everything else is opaque ──
function lowerType(n: E): Ast {
  const c = kidsOf(n);
  if (c.length === 1 && isLeaf(c[0])) {
    const t = text(c[0]);
    const kw: Record<string, string> = {
      string: 'StringKeyword', number: 'NumberKeyword', boolean: 'BooleanKeyword', any: 'AnyKeyword',
      unknown: 'UnknownKeyword', never: 'NeverKeyword', void: 'VoidKeyword', undefined: 'UndefinedKeyword',
      object: 'ObjectKeyword', symbol: 'SymbolKeyword', bigint: 'BigIntKeyword',
    };
    if (tokTypeOf(c[0]) === 'Ident' && kw[t]) return ast(kw[t], off(n), end(n));
    if (tokTypeOf(c[0]) === 'Ident') return ast('TypeReference', off(n), end(n), [ast('Identifier', off(c[0]), end(c[0]))]);
    if (tokTypeOf(c[0]) === 'String') return ast('LiteralType', off(n), end(n), [ast('StringLiteral', off(c[0]), end(c[0]))]);
    if (tokTypeOf(c[0]) === 'Number') return ast('LiteralType', off(n), end(n), [ast('NumericLiteral', off(c[0]), end(c[0]))]);
    if (t === 'null') return ast('LiteralType', off(n), end(n), [ast('NullKeyword', off(c[0]), end(c[0]))]);
  }
  if (c.length === 1 && ruleIs(c[0], 'Type')) return lowerType(c[0]);
  if (ruleIs(c[0], 'Type')) {
    const t1 = c[1];
    if (isLeaf(t1)) {
      const t = text(t1);
      if (t === '[' && c.length === 3) return ast('ArrayType', off(n), end(n), [lowerType(c[0])]);
      if (t === '|') return ast('UnionType', off(n), end(n), rules(c, 'Type').map(lowerType));
      if (t === '&') return ast('IntersectionType', off(n), end(n), rules(c, 'Type').map(lowerType));
      if (t === '<') return ast('TypeReference', off(n), end(n), rules(c, 'Type').map(lowerType));
      if (t === '.' && isLeaf(c[2])) {
        const left = lowerType(c[0]);
        const leftName = left.kind === 'TypeReference' && left.children.length === 1 ? left.children[0] : left;
        const q = ast('QualifiedName', off(n), end(c[2]), [leftName, ast('Identifier', off(c[2]), end(c[2]))]);
        return ast('TypeReference', off(n), end(n), [q]);
      }
    }
  }
  // Opaque fallback: keep the span, drop the structure (verify counts it as a kind
  // mismatch against tsc — measured, not hidden).
  return ast('UnknownTypeNode', off(n), end(n));
}

function lowerBindingPattern(n: E): Ast {
  const c = kidsOf(n);
  const open = text(c[0]);
  const kind = open === '{' ? 'ObjectBindingPattern' : 'ArrayBindingPattern';
  const elems: Ast[] = [];
  // PAIN(16): array HOLES exist only as consecutive ',' leaves — the consumer must
  // re-derive tsc's OmittedExpression nodes from comma adjacency.
  let expectElem = kind === 'ArrayBindingPattern';
  let sepEnd = end(c[0]);
  for (let i = 0; i < c.length; i++) {
    const k = c[i];
    if (isLeaf(k)) {
      const t = text(k);
      if (t === ',') {
        if (expectElem) elems.push(ast('OmittedExpression', sepEnd, sepEnd));
        expectElem = true;
        sepEnd = end(k);
      }
      continue;
    }
    if (ruleIs(k, 'BindingProperty') || ruleIs(k, 'ArrayBindingElement') || ruleIs(k, 'BindingElement')) {
      elems.push(lowerBindingElement(k));
      expectElem = false;
    }
  }
  return ast(kind, off(n), end(n), elems);
}

// All three CST element rules lower to tsc's one BindingElement
// (children: dotDotDotToken?, propertyName?, name, initializer?).
function lowerBindingElement(n: E): Ast {
  const c = kidsOf(n);
  if (ruleNameOf(n) === 'ArrayBindingElement') {
    // ['...'? (BindingElement | Ident)]
    const kids: Ast[] = [];
    if (leafIs(c[0], '...')) kids.push(ast('DotDotDotToken', off(c[0]), end(c[0])));
    const inner = findRule(c, 'BindingElement');
    if (inner !== undefined) {
      const innerAst = lowerBindingElement(inner);
      kids.push(...innerAst.children);
    } else {
      const id = c.find((x) => isLeaf(x) && tokTypeOf(x) === 'Ident') as E | undefined;
      if (id) kids.push(ast('Identifier', off(id), end(id)));
    }
    return ast('BindingElement', off(n), end(n), kids);
  }
  if (ruleNameOf(n) === 'BindingProperty') {
    const kids: Ast[] = [];
    if (leafIs(c[0], '...')) {
      kids.push(ast('DotDotDotToken', off(c[0]), end(c[0])));
      const id = c.find((x) => isLeaf(x) && tokTypeOf(x) === 'Ident') as E | undefined;
      if (id) kids.push(ast('Identifier', off(id), end(id)));
      return ast('BindingElement', off(n), end(n), kids);
    }
    const colon = findText(c, ':');
    if (colon >= 0) {
      // key ':' (BindingElement | …) — key becomes propertyName, the value's parts follow.
      const key = c[0];
      kids.push(isLeaf(key)
        ? (tokTypeOf(key) === 'String' ? ast('StringLiteral', off(key), end(key))
          : tokTypeOf(key) === 'Number' ? ast('NumericLiteral', off(key), end(key))
          : ast('Identifier', off(key), end(key)))
        : ruleIs(key, 'MemberName') ? lowerMemberName(key) : ast('Identifier', off(key), end(key)));
      const value = c[colon + 1];
      if (ruleIs(value, 'BindingElement')) kids.push(...lowerBindingElement(value).children);
      else if (ruleIs(value, 'BindingPattern')) kids.push(lowerBindingPattern(value));
      else if (value !== undefined && isLeaf(value)) kids.push(ast('Identifier', off(value), end(value)));
      return ast('BindingElement', off(n), end(n), kids);
    }
    // shorthand (with optional default): [Ident ('=' Expr)?]
    const kids2: Ast[] = [];
    for (let i = 0; i < c.length; i++) {
      const k = c[i];
      if (isLeaf(k) && tokTypeOf(k) === 'Ident') kids2.push(ast('Identifier', off(k), end(k)));
      else if (ruleIs(k, 'Expr') && leafIs(c[i - 1], '=')) kids2.push(lowerExpr(k));
    }
    return ast('BindingElement', off(n), end(n), kids2);
  }
  // BindingElement: [(Ident | BindingPattern) ('=' Expr)?]
  const kids: Ast[] = [];
  for (let i = 0; i < c.length; i++) {
    const k = c[i];
    if (isLeaf(k) && tokTypeOf(k) === 'Ident') kids.push(ast('Identifier', off(k), end(k)));
    else if (ruleIs(k, 'BindingPattern')) kids.push(lowerBindingPattern(k));
    else if (ruleIs(k, 'Expr') && leafIs(c[i - 1], '=')) kids.push(lowerExpr(k));
  }
  return ast('BindingElement', off(n), end(n), kids);
}

// ── Statements ──
// lowerStmt consumes the GENERATED per-arm destructurer (typescript.cst-match.ts):
// the arm discrimination and field extraction that the first version of this file
// hand-probed (and got wrong in places — see PAIN 3/5/7) now comes from the grammar.
// A few arms still reach into kidsOf(n) for the positions of uncaptured structural
// keywords ('catch', the switch '{') — a noted destructurer gap.
function lowerStmt(n: E): Ast {
  const m = matchStmt(T as never, n as never, 0, SRC);
  const c = kidsOf(n);
  switch (m.arm) {
    case 'block': return lowerBlock(m.block);
    case 'let_': case 'await_': {
      const decls = ('binding' in m ? m.binding : []).map(lowerBinding);
      const list = ast('VariableDeclarationList', off(n), decls.length ? decls[decls.length - 1].end : end(n), decls);
      return ast('VariableStatement', off(n), end(n), [list]);
    }
    case 'if_': {
      const kids = [lowerExpr(m.expr), lowerStmt(m.stmt)];
      if (m.stmt2 !== undefined) kids.push(lowerStmt(m.stmt2));
      return ast('IfStatement', off(n), end(n), kids);
    }
    case 'for_': return lowerFor(n, c);
    case 'while_': return ast('WhileStatement', off(n), end(n), [lowerExpr(m.expr), lowerStmt(m.stmt)]);
    case 'do_': return ast('DoStatement', off(n), end(n), [lowerStmt(m.stmt), lowerExpr(m.expr)]);
    case 'switch_': {
      const disc = lowerExpr(m.expr);
      const clauses = groupSwitchClauses(m.switchCase);
      const caseBlockStart = findText(c, '{');
      const cb = ast('CaseBlock', caseBlockStart >= 0 ? off(c[caseBlockStart]) : off(n), end(n), clauses);
      return ast('SwitchStatement', off(n), end(n), [disc, cb]);
    }
    case 'return_': return ast('ReturnStatement', off(n), end(n), m.expr !== undefined ? [lowerExpr(m.expr)] : []);
    case 'throw_': return ast('ThrowStatement', off(n), end(n), [lowerExpr(m.expr)]);
    case 'break_': return ast('BreakStatement', off(n), end(n), m.ident !== undefined ? [ast('Identifier', off(m.ident), end(m.ident))] : []);
    case 'continue_': return ast('ContinueStatement', off(n), end(n), m.ident !== undefined ? [ast('Identifier', off(m.ident), end(m.ident))] : []);
    case 'try_': {
      // catchTok/finallyTok carry the keyword anchors (no children scan), and the
      // catch binding arrives as a tagged sub-union instead of flattened optionals.
      const kids: Ast[] = [lowerBlock(m.block)];
      if (m.catchTok !== undefined && m.block2 !== undefined) {
        const catchKids: Ast[] = [];
        const target = m.alt?.branch === 'param' ? m.alt.param : m.alt?.branch === 'bindingPattern' ? m.alt.bindingPattern : undefined;
        if (target !== undefined) {
          const t = ruleIs(target, 'BindingPattern') ? lowerBindingPattern(target) : lowerBindingTarget(target);
          catchKids.push(ast('VariableDeclaration', off(target), end(target), [t]));
        }
        catchKids.push(lowerBlock(m.block2));
        kids.push(ast('CatchClause', off(m.catchTok), end(m.block2), catchKids));
      }
      if (m.finallyTok !== undefined) kids.push(lowerBlock(m.block3 ?? m.block2!));   // finally block: block3 with a catch, block2 without
      return ast('TryStatement', off(n), end(n), kids);
    }
    case 'ident': return ast('LabeledStatement', off(n), end(n), [ast('Identifier', off(m.ident), end(m.ident)), lowerStmt(m.stmt)]);
    case 'semi': return ast('EmptyStatement', off(n), end(n));
    case 'debugger_': return ast('DebuggerStatement', off(n), end(n));
    case 'with_': return ast('WithStatement', off(n), end(n), [lowerExpr(m.expr), lowerStmt(m.stmt)]);
    case 'decl': return lowerDecl(m.decl);
    case 'expr': return ast('ExpressionStatement', off(n), end(n), [lowerExpr(m.expr)]);
    default: {
      const never_: never = m;
      throw new Unlowered(`Stmt arm ${(never_ as { arm: string }).arm}`, off(n));
    }
  }
}

// PAIN(15) regrouping, now over the typed SwitchCase nodes from the destructurer.
function groupSwitchClauses(flat: E[]): Ast[] {
  const clauses: Ast[] = [];
  let cur: { kind: string; start: number; openEnd: number; head: Ast[]; stmts: Ast[] } | null = null;
  const flush = () => {
    if (!cur) return;
    const clauseEnd = cur.stmts.length ? cur.stmts[cur.stmts.length - 1].end : cur.openEnd;
    clauses.push(ast(cur.kind, cur.start, clauseEnd, [...cur.head, ...cur.stmts]));
    cur = null;
  };
  for (const sc of flat) {
    const scc = kidsOf(sc);
    if (leafIs(scc[0], 'case')) {
      flush();
      cur = { kind: 'CaseClause', start: off(sc), openEnd: end(sc), head: [lowerExpr(findRule(scc, 'Expr')!)], stmts: [] };
      cur.stmts.push(...rules(scc, 'Stmt').map(lowerStmt));
    } else if (leafIs(scc[0], 'default')) {
      flush();
      cur = { kind: 'DefaultClause', start: off(sc), openEnd: end(sc), head: [], stmts: rules(scc, 'Stmt').map(lowerStmt) };
    } else if (ruleIs(scc[0], 'Stmt')) {
      const st = scc[0];
      const sl = kidsOf(st);
      if (isLeaf(sl[0]) && text(sl[0]) === 'default' && leafIs(sl[1], ':') && ruleIs(sl[2], 'Stmt')) {
        flush();
        cur = { kind: 'DefaultClause', start: off(st), openEnd: end(st), head: [], stmts: [lowerStmt(sl[2])] };
      } else if (cur) {
        cur.stmts.push(lowerStmt(st));
      } else {
        throw new Unlowered('switch statements before any clause', off(sc));
      }
    } else {
      throw new Unlowered('SwitchCase shape', off(sc));
    }
  }
  flush();
  return clauses;
}

function lowerBindingTarget(n: E): Ast {
  const f = kidsOf(n)[0];
  if (isLeaf(f) && tokTypeOf(f) === 'Ident') return ast('Identifier', off(f), end(f));
  if (isNode(f) && ruleNameOf(f) === 'BindingPattern') return lowerBindingPattern(f);
  throw new Unlowered('binding target', off(n));
}

function lowerBinding(n: E): Ast {
  const c = kidsOf(n);
  const kids: Ast[] = [lowerBindingTarget(n)];
  for (let i = 0; i < c.length; i++) {
    const k = c[i];
    if (ruleIs(k, 'Type') && leafIs(c[i - 1], ':')) kids.push(lowerType(k));
    if (ruleIs(k, 'Expr') && leafIs(c[i - 1], '=')) kids.push(lowerExpr(k));
  }
  return ast('VariableDeclaration', off(n), end(n), kids);
}

function lowerFor(n: E, c: E[]): Ast {
  const head = findRule(c, 'ForHead');
  const body = lowerStmt(findRule(c, 'Stmt')!);
  if (head === undefined) throw new Unlowered('for head', off(n));
  const hc = kidsOf(head);
  const inIdx = findText(hc, 'in');
  const ofIdx = findText(hc, 'of');
  if (inIdx >= 0 || ofIdx >= 0) {
    // PAIN(9): for-in/of initializer — tsc again nests VariableDeclarationList around the
    // ForBinding while the CST is flat; and `for (x of …)` (no decl keyword) lowers the
    // bare target to an Expr-equivalent instead. Two shapes, one tsc kind family.
    const kind = ofIdx >= 0 ? 'ForOfStatement' : 'ForInStatement';
    const sep = ofIdx >= 0 ? ofIdx : inIdx;
    const declKw = isLeaf(hc[0]) && ['const', 'let', 'var'].includes(text(hc[0]));
    const target = findRule(hc.slice(0, sep), 'ForBinding') ?? findRule(hc.slice(0, sep), 'Expr');
    const rhs = findRule(hc.slice(sep), 'Expr')!;
    let init: Ast;
    if (declKw && target) {
      const decl = ast('VariableDeclaration', off(target), end(target), [lowerBindingTarget(target)]);
      init = ast('VariableDeclarationList', off(head), end(target), [decl]);
    } else if (target !== undefined && ruleNameOf(target) === 'Expr') {
      init = lowerExpr(target);
    } else if (target !== undefined) {
      init = ast('VariableDeclarationList', off(head), end(target), [ast('VariableDeclaration', off(target), end(target), [lowerBindingTarget(target)])]);
    } else throw new Unlowered('for-in/of target', off(head));
    return ast(kind, off(n), end(n), [init, lowerExpr(rhs), body]);
  }
  // classic for: [decls? ';' cond? ';' incr?]
  const kids: Ast[] = [];
  if (isLeaf(hc[0]) && ['const', 'let', 'var'].includes(text(hc[0]))) {
    // PAIN(14): the same construct (a `let x = e` declarator) is rule 'Binding' in a
    // statement but rule 'ForBinding' in a for-head — same shape, two names to know.
    const decls = rules(hc, 'ForBinding').map(lowerBinding);
    kids.push(ast('VariableDeclarationList', off(head), decls.length ? decls[decls.length - 1].end : end(head), decls));
    const exprs = rules(hc, 'Expr').map(lowerExpr);
    kids.push(...exprs);
  } else {
    kids.push(...rules(hc, 'Expr').map(lowerExpr));
  }
  kids.push(body);
  return ast('ForStatement', off(n), end(n), kids);
}

function lowerBlock(n: E): Ast {
  return ast('Block', off(n), end(n), rules(kidsOf(n), 'Stmt').map(lowerStmt));
}

// ── Declarations ──
function lowerDecl(n: E): Ast {
  const c = kidsOf(n);
  // modifiers prefix: export/declare/abstract/async/default …
  let i = 0;
  const mods: Ast[] = [];
  const MOD: Record<string, string> = {
    export: 'ExportKeyword', declare: 'DeclareKeyword', abstract: 'AbstractKeyword',
    async: 'AsyncKeyword', default: 'DefaultKeyword',
  };
  while (i < c.length && isLeaf(c[i]) && MOD[text(c[i])]) {
    mods.push(ast(MOD[text(c[i])], off(c[i]), end(c[i])));
    i++;
  }
  const h = c[i];
  if (isNode(h) && ruleNameOf(h) === 'Decl') {
    // ['export'|'declare'… Decl] nesting: lower the inner declaration, then prepend the
    // modifiers and widen the span to include them (tsc spans start at the modifier).
    const inner = lowerDecl(h);
    return ast(inner.kind, off(n), end(n), [...mods, ...inner.children]);
  }
  if (isLeaf(h)) {
    const t = text(h);
    if (t === 'function') return lowerFunctionLike(n, c.slice(i), 'FunctionDeclaration', mods);
    if (t === 'class') return lowerClassLike(n, c.slice(i), 'ClassDeclaration', mods);
    if (t === 'interface') {
      const name = c[i + 1] as E;
      const members = rules(c, 'InterfaceMember').map((m) => ast('PropertySignature', off(m), end(m)));
      return ast('InterfaceDeclaration', off(n), end(n), [...mods, ast('Identifier', off(name), end(name)), ...members]);
    }
    if (t === 'type') {
      const name = c[i + 1] as E;
      const ty = findRule(c, 'Type');
      return ast('TypeAliasDeclaration', off(n), end(n), [...mods, ast('Identifier', off(name), end(name)), ...(ty !== undefined ? [lowerType(ty)] : [])]);
    }
    if (t === 'import') return lowerImport(n, c, i, mods);
    if (t === 'enum') {
      const name = c[i + 1] as E;
      const members = rules(c, 'EnumMember').map(lowerEnumMember);
      return ast('EnumDeclaration', off(n), end(n), [...mods, ast('Identifier', off(name), end(name)), ...members]);
    }
    if (t === 'namespace' || t === 'module') {
      // PAIN(17): tsc nests `module A.B.C {}` as ModuleDeclaration(A, ModuleDeclaration(B,
      // ModuleDeclaration(C, ModuleBlock))) with each inner declaration's span starting at
      // ITS name segment — the CST's flat [Ident '.' Ident '.' Ident '{' …] must be
      // re-associated right-to-left and the synthetic spans reconstructed.
      const brace = findText(c, '{');
      const nameLeaves = c.slice(i + 1, brace >= 0 ? brace : undefined).filter((x): x is E => isLeaf(x) && (tokTypeOf(x) === 'Ident' || tokTypeOf(x) === 'String'));
      const body: Ast[] = [];
      for (const k of c) {
        if (ruleIs(k, 'Stmt')) body.push(lowerStmt(k));
        else if (ruleIs(k, 'Decl')) body.push(lowerDecl(k));
      }
      const blockStart = brace >= 0 ? off(c[brace]) : end(n);
      const block = ast('ModuleBlock', blockStart, end(n), body);
      const last = nameLeaves[nameLeaves.length - 1];
      const lastName = tokTypeOf(last) === 'String' ? ast('StringLiteral', off(last), end(last)) : ast('Identifier', off(last), end(last));
      let decl = ast('ModuleDeclaration', nameLeaves.length > 1 ? off(last) : off(n), end(n), [lastName, block]);
      for (let j = nameLeaves.length - 2; j >= 0; j--) {
        const seg = nameLeaves[j];
        decl = ast('ModuleDeclaration', j === 0 ? off(n) : off(seg), end(n), [ast('Identifier', off(seg), end(seg)), decl]);
      }
      if (mods.length) decl = ast('ModuleDeclaration', off(n), end(n), [...mods, ...decl.children]);
      return decl;
    }
    if (t === 'export') return lowerExport(n, c, i, mods);
  }
  if (isNode(h) && (ruleNameOf(h) === 'Stmt')) {
    const inner = lowerStmt(h);
    if (mods.length) return ast(inner.kind, off(n), end(n), [...mods, ...inner.children]);
    return inner;
  }
  throw new Unlowered(`Decl shape [${c.map((x) => (isLeaf(x) ? JSON.stringify(text(x)) : ruleNameOf(x))).join(' ')}]`, off(n));
}

function lowerFunctionLike(n: E, c: E[], kind: string, mods: Ast[] = []): Ast {
  const nameLeaf = c.find((x) => isLeaf(x) && tokTypeOf(x) === 'Ident') as E | undefined;
  const params = rules(c, 'Param').map(lowerParam);
  const block = findRule(c, 'Block');
  let retT: Ast | undefined;
  for (let i = 0; i < c.length; i++) {
    if (ruleIs(c[i], 'Type') && leafIs(c[i - 1], ':')) { retT = lowerType(c[i] as E); break; }
  }
  const kids = [...mods, ...(nameLeaf ? [ast('Identifier', off(nameLeaf), end(nameLeaf))] : []), ...params, ...(retT ? [retT] : []), ...(block !== undefined ? [lowerBlock(block)] : [])];
  return ast(kind, off(n), end(n), kids);
}

function lowerClassLike(n: E, c: E[], kind: string, mods: Ast[] = []): Ast {
  const nameLeaf = c.find((x, i) => isLeaf(x) && tokTypeOf(x) === 'Ident' && i <= 2) as E | undefined;
  const kids: Ast[] = [...mods];
  if (nameLeaf) kids.push(ast('Identifier', off(nameLeaf), end(nameLeaf)));
  for (const kw of ['extends', 'implements'] as const) {
    const at = findText(c, kw);
    if (at < 0) continue;
    // PAIN(18): `implements A, B` — the clause's types are a flat run after the keyword
    // (ClassHeritage for extends, Type nodes for implements), ended only by the next
    // structural token; the consumer re-collects the run and rebuilds tsc's
    // HeritageClause + ExpressionWithTypeArguments wrappers (two levels that don't
    // exist in the CST).
    const types: Ast[] = [];
    for (let j = at + 1; j < c.length; j++) {
      const k = c[j];
      if (isLeaf(k)) {
        if (text(k) === ',') continue;
        break;
      }
      if (ruleIs(k, 'ClassHeritage')) types.push(ast('ExpressionWithTypeArguments', off(k), end(k), [lowerHeritage(k)]));
      else if (ruleIs(k, 'Type')) types.push(ast('ExpressionWithTypeArguments', off(k), end(k), [lowerTypeAsExpr(k)]));
      else break;
    }
    if (types.length) kids.push(ast('HeritageClause', off(c[at]), types[types.length - 1].end, types));
  }
  kids.push(...rules(c, 'ClassMember').map(lowerClassMember));
  return ast(kind, off(n), end(n), kids);
}

function lowerTypeAsExpr(n: E): Ast {
  const c = kidsOf(n);
  if (c.length === 1 && isLeaf(c[0])) return ast('Identifier', off(c[0]), end(c[0]));
  if (ruleIs(c[0], 'Type') && leafIs(c[1], '.') && isLeaf(c[2])) {
    return ast('PropertyAccessExpression', off(n), end(n), [lowerTypeAsExpr(c[0]), ast('Identifier', off(c[2]), end(c[2]))]);
  }
  if (c.length === 1 && ruleIs(c[0], 'Type')) return lowerTypeAsExpr(c[0]);
  return ast('Identifier', off(n), end(n));
}

function lowerHeritage(n: E): Ast {
  const c = kidsOf(n);
  if (c.length === 1 && isLeaf(c[0])) return ast('Identifier', off(c[0]), end(c[0]));
  if (ruleIs(c[0], 'Expr')) return lowerExpr(c[0]);
  return ast('Identifier', off(n), end(n));
}

function lowerClassMember(n: E): Ast {
  const c = kidsOf(n);
  const MOD: Record<string, string> = {
    public: 'PublicKeyword', private: 'PrivateKeyword', protected: 'ProtectedKeyword',
    static: 'StaticKeyword', readonly: 'ReadonlyKeyword', abstract: 'AbstractKeyword',
    async: 'AsyncKeyword', override: 'OverrideKeyword', declare: 'DeclareKeyword', accessor: 'AccessorKeyword',
  };
  let i = 0;
  const mods: Ast[] = [];
  while (i < c.length && isLeaf(c[i]) && MOD[text(c[i])] && !(leafIs(c[i + 1], '(') || leafIs(c[i + 1], '=') || leafIs(c[i + 1], ':') || leafIs(c[i + 1], ';') || c[i + 1] === undefined)) {
    mods.push(ast(MOD[text(c[i])], off(c[i]), end(c[i])));
    i++;
  }
  const nameNode = findRule(c, 'MemberName');
  const block = findRule(c, 'Block');
  const params = rules(c, 'Param').map(lowerParam);
  const nameAst = nameNode !== undefined ? lowerMemberName(nameNode) : undefined;
  // PAIN(13): `constructor` appears as a bare $keyword leaf while every other member
  // name is a MemberName node — the same concept surfaces as different child kinds
  // depending on which grammar alternative matched.
  const isCtor = findText(c, 'constructor') >= 0 && nameNode === undefined;
  let retT: Ast | undefined;
  for (let j = 0; j < c.length; j++) {
    if (ruleIs(c[j], 'Type') && leafIs(c[j - 1], ':')) { retT = lowerType(c[j] as E); break; }
  }
  if (block !== undefined || findText(c, '(') >= 0) {
    if (isCtor) return ast('Constructor', off(n), end(n), [...mods, ...params, ...(block !== undefined ? [lowerBlock(block)] : [])]);
    const getIdx = findText(c, 'get');
    const setIdx = findText(c, 'set');
    const kind = getIdx >= 0 && nameNode && off(c[getIdx]) < off(nameNode) ? 'GetAccessor'
      : setIdx >= 0 && nameNode && off(c[setIdx]) < off(nameNode) ? 'SetAccessor'
      : 'MethodDeclaration';
    return ast(kind, off(n), end(n), [...mods, ...(nameAst ? [nameAst] : []), ...params, ...(retT ? [retT] : []), ...(block !== undefined ? [lowerBlock(block)] : [])]);
  }
  // property
  const init = (() => {
    for (let j = 0; j < c.length; j++) if (ruleIs(c[j], 'Expr') && leafIs(c[j - 1], '=')) return lowerExpr(c[j] as E);
    return undefined;
  })();
  return ast('PropertyDeclaration', off(n), end(n), [...mods, ...(nameAst ? [nameAst] : []), ...(retT ? [retT] : []), ...(init ? [init] : [])]);
}

function lowerMemberName(n: E): Ast {
  // computed FIRST: the '[' is itself a leaf, so the leaf branch would shadow it.
  if (leafIs(kidsOf(n)[0], '[')) {
    const e = findRule(kidsOf(n), 'Expr');
    if (e !== undefined) return ast('ComputedPropertyName', off(n), end(n), [lowerExpr(e)]);
  }
  const k = kidsOf(n)[0];
  if (isLeaf(k)) {
    if (tokTypeOf(k) === 'String') return ast('StringLiteral', off(k), end(k));
    if (tokTypeOf(k) === 'Number') return ast('NumericLiteral', off(k), end(k));
    if (tokTypeOf(k) === 'PrivateField') return ast('PrivateIdentifier', off(k), end(k));
    return ast('Identifier', off(k), end(k));
  }
  return ast('Identifier', off(n), end(n));
}

function lowerEnumMember(n: E): Ast {
  const c = kidsOf(n);
  const name = c[0];
  const nameAst = isLeaf(name)
    ? (tokTypeOf(name) === 'String' ? ast('StringLiteral', off(name), end(name)) : ast('Identifier', off(name), end(name)))
    : lowerMemberName(name);
  const init: Ast[] = [];
  for (let i = 0; i < c.length; i++) if (ruleIs(c[i], 'Expr') && leafIs(c[i - 1], '=')) init.push(lowerExpr(c[i] as E));
  return ast('EnumMember', off(n), end(n), [nameAst, ...init]);
}

function lowerImportSpecifier(n: E): Ast {
  const c = kidsOf(n);
  // [Ident ('as' Ident)?] → ImportSpecifier{ propertyName?, name }
  const ids = c.filter((x): x is E => isLeaf(x) && tokTypeOf(x) === 'Ident');
  const kids = ids.map((x) => ast('Identifier', off(x), end(x)));
  return ast('ImportSpecifier', off(n), end(n), kids);
}

function lowerImport(n: E, c: E[], i: number, mods: Ast[]): Ast {
  // 'import' ImportClause? 'from'? String ';'?  |  'import' String  |  import x = require(…)
  const clause = findRule(c, 'ImportClause');
  const spec = c.find((x) => isLeaf(x) && tokTypeOf(x) === 'String') as E | undefined;
  const kids: Ast[] = [...mods];
  if (clause !== undefined) {
    const cc = kidsOf(clause);
    const ckids: Ast[] = [];
    const star = findText(cc, '*');
    const brace = findText(cc, '{');
    if (isLeaf(cc[0]) && tokTypeOf(cc[0]) === 'Ident') ckids.push(ast('Identifier', off(cc[0]), end(cc[0])));
    if (star >= 0) {
      const ns = cc.find((x, j) => j > star && isLeaf(x) && tokTypeOf(x) === 'Ident') as E;
      ckids.push(ast('NamespaceImport', off(cc[star]), end(ns), [ast('Identifier', off(ns), end(ns))]));
    } else if (brace >= 0) {
      const named = rules(cc, 'ImportSpecifier').map(lowerImportSpecifier);
      ckids.push(ast('NamedImports', off(cc[brace]), end(clause), named));
    }
    kids.push(ast('ImportClause', off(clause), end(clause), ckids));
  }
  if (spec) kids.push(ast('StringLiteral', off(spec), end(spec)));
  return ast('ImportDeclaration', off(n), end(n), kids);
}

function lowerExport(n: E, c: E[], i: number, mods: Ast[]): Ast {
  // 'export' '{' specifiers '}' | 'export' '*' ('as' Ident)? 'from' String
  const star = findText(c, '*');
  const brace = findText(c, '{');
  const spec = c.find((x) => isLeaf(x) && tokTypeOf(x) === 'String') as E | undefined;
  const kids: Ast[] = [...mods];
  if (brace >= 0) {
    const named = rules(c, 'ImportSpecifier').map((sp) => {
      const { pos: ePos, end: eEnd, children: eKids } = lowerImportSpecifier(sp);
      return ast('ExportSpecifier', ePos, eEnd, eKids);
    });
    const close = findText(c, '}');
    kids.push(ast('NamedExports', off(c[brace]), close >= 0 ? end(c[close]) : end(n), named));
  }
  if (spec) kids.push(ast('StringLiteral', off(spec), end(spec)));
  return ast('ExportDeclaration', off(n), end(n), kids);
}

// ── Entry ──
export function lowerProgram(t: ObjTree, root: E, source: string): Ast {
  T = t;
  SRC = source;
  const stmts: Ast[] = [];
  for (const c of kidsOf(root)) {
    if (ruleIs(c, 'Stmt')) stmts.push(lowerStmt(c));
    else if (ruleIs(c, 'Decl')) stmts.push(lowerDecl(c));
    else throw new Unlowered(`top-level ${isNode(c) ? ruleNameOf(c) : text(c)}`, off(c));
  }
  return ast('SourceFile', off(root), end(root), stmts);
}
