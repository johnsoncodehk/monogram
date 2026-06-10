// EXPERIMENT: a real consumer — lower the Monogram TypeScript CST into a tsc-shaped AST
// (node kinds named after ts.SyntaxKind, spans = token spans), to surface the REAL pain
// points of consuming the CST. Every friction met while writing this is tagged PAIN(n)
// at the exact site; test/ts-ast-verify.ts compares the result against the real tsc AST
// node-by-node (kind + start + end, pre-order).
//
// Deliberately NOT complete: unlowered constructs throw Unlowered (the verify driver
// counts them) — the goal is an honest pain inventory, not a shipped frontend.
import type { CstChild, CstLeaf, CstNode } from '../src/gen-parser.ts';
import { matchStmt } from '../typescript.cst-match.ts';

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

// ── Generic CST helpers a consumer has to hand-roll today ──
// PAIN(1): every consumer rebuilds this same toolkit — leaf/node discrimination, leaf
// text via the source, "the i-th child that is a rule R", "skip the structural puncts".
// Nothing grammar-derived helps navigate children; it's all positional re-discovery.
const isLeaf = (n: CstChild): n is CstLeaf => (n as CstLeaf).tokenType !== undefined;
const isNode = (n: CstChild): n is CstNode => (n as CstNode).rule !== undefined;

let SRC = '';
const text = (n: CstChild): string => SRC.slice(n.offset, n.end);
const leafIs = (n: CstChild | undefined, t: string): boolean => n !== undefined && isLeaf(n) && text(n) === t;
const ruleIs = (n: CstChild | undefined, r: string): n is CstNode => n !== undefined && isNode(n) && n.rule === r;
const findRule = (cs: CstChild[], r: string): CstNode | undefined => cs.find((c): c is CstNode => ruleIs(c, r));
const rules = (cs: CstChild[], r: string): CstNode[] => cs.filter((c): c is CstNode => ruleIs(c, r));
const findText = (cs: CstChild[], t: string): number => cs.findIndex((c) => isLeaf(c) && text(c) === t);

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
function lowerExpr(n: CstNode): Ast {
  const c = n.children;

  // Single-child wrapper around a primary (Expr[Number] / Expr[Ident] / Expr[String] …).
  // PAIN(4): every primary is wrapped in an extra Expr node the AST must collapse.
  if (c.length === 1) {
    const k = c[0];
    if (isNode(k)) {
      // PAIN(12): the interpolated-template node's rule is the SYNTHETIC '$template'
      // (not the grammar's token name 'Template') — one more name to know by heart.
      if (k.rule === 'Template' || k.rule === '$template') return lowerTemplate(k);
      if (k.rule === 'Expr') return lowerExpr(k);
      throw new Unlowered(`Expr wrapper of ${k.rule}`, n.offset);
    }
    return lowerPrimaryLeaf(k);
  }

  // Prefix unary: [$operator, Expr]
  if (isLeaf(c[0]) && c[0].tokenType === '$operator' && c.length === 2 && ruleIs(c[1], 'Expr')) {
    const op = text(c[0]);
    if (op === 'await') return ast('AwaitExpression', n.offset, n.end, [lowerExpr(c[1])]);
    if (op === 'typeof') return ast('TypeOfExpression', n.offset, n.end, [lowerExpr(c[1])]);
    if (op === 'void') return ast('VoidExpression', n.offset, n.end, [lowerExpr(c[1])]);
    if (op === 'delete') return ast('DeleteExpression', n.offset, n.end, [lowerExpr(c[1])]);
    if (op === 'yield') return ast('YieldExpression', n.offset, n.end, [lowerExpr(c[1])]);
    return ast('PrefixUnaryExpression', n.offset, n.end, [lowerExpr(c[1])]);
  }

  // led forms: lhs is ALWAYS child 0 (a rule node).
  if (ruleIs(c[0], 'Expr')) {
    const lhs = c[0];
    const k1 = c[1];

    // Postfix: [Expr, '!' | '++' | '--']
    if (c.length === 2 && isLeaf(k1)) {
      const t = text(k1);
      if (t === '!') return ast('NonNullExpression', n.offset, n.end, [lowerExpr(lhs)]);
      if (t === '++' || t === '--') return ast('PostfixUnaryExpression', n.offset, n.end, [lowerExpr(lhs)]);
    }
    // Tagged template: [Expr, Template|$template]
    if (c.length === 2 && (ruleIs(k1, 'Template') || ruleIs(k1, '$template'))) {
      return ast('TaggedTemplateExpression', n.offset, n.end, [lowerExpr(lhs), lowerTemplate(k1)]);
    }

    if (isLeaf(k1)) {
      const t1 = text(k1);
      // Member access: [Expr, '.'|'?.', Ident|PrivateField]
      if ((t1 === '.' || t1 === '?.') && c.length === 3 && isLeaf(c[2])) {
        // PAIN(10): tsc's forEachChild yields TOKEN children irregularly per kind
        // (?. yes, '.' no; '?'/':' of a conditional yes, '(' ')' never) — a consumer
        // matching that shape must encode the irregularity case by case.
        const q = t1 === '?.' ? [ast('QuestionDotToken', k1.offset, k1.end)] : [];
        const nameKind = (c[2] as CstLeaf).tokenType === 'PrivateField' ? 'PrivateIdentifier' : 'Identifier';
        return ast('PropertyAccessExpression', n.offset, n.end, [lowerExpr(lhs), ...q, ast(nameKind, c[2].offset, c[2].end)]);
      }
      // Element access: [Expr, '[', Expr, ']']
      if (t1 === '[' && c.length === 4 && ruleIs(c[2], 'Expr')) {
        return ast('ElementAccessExpression', n.offset, n.end, [lowerExpr(lhs), lowerExpr(c[2])]);
      }
      // Call: [Expr, '(', (Expr (',' Expr)*)?, ')']  (also '?.(' optional call)
      if (t1 === '(' || (t1 === '?.' && leafIs(c[2], '('))) {
        const args = rules(c, 'Expr').slice(1).map(lowerExpr);
        return ast('CallExpression', n.offset, n.end, [lowerExpr(lhs), ...args]);
      }
      // Generic call: [Expr, '<', Type…, '>', '(' … ')'] — the type args led.
      if (t1 === '<') {
        const close = findText(c, '(');
        if (close >= 0) {
          const args = c.slice(close).filter((x): x is CstNode => ruleIs(x, 'Expr')).map(lowerExpr);
          const targs = rules(c.slice(0, close), 'Type').map(lowerType);
          return ast('CallExpression', n.offset, n.end, [lowerExpr(lhs), ...targs, ...args]);
        }
      }
      // Conditional: [Expr, '?', Expr, ':', Expr]
      if (t1 === '?' && c.length === 5 && ruleIs(c[2], 'Expr') && ruleIs(c[4], 'Expr')) {
        return ast('ConditionalExpression', n.offset, n.end, [
          lowerExpr(lhs), ast('QuestionToken', k1.offset, k1.end), lowerExpr(c[2]),
          ast('ColonToken', c[3].offset, c[3].end), lowerExpr(c[4]),
        ]);
      }
      // as / satisfies: [Expr, 'as'|'satisfies', Type]
      if (t1 === 'as' && c.length === 3 && ruleIs(c[2], 'Type')) {
        return ast('AsExpression', n.offset, n.end, [lowerExpr(lhs), lowerType(c[2])]);
      }
      if (t1 === 'satisfies' && c.length === 3 && ruleIs(c[2], 'Type')) {
        return ast('SatisfiesExpression', n.offset, n.end, [lowerExpr(lhs), lowerType(c[2])]);
      }
      // Binary (incl. assignment / 'in' / 'instanceof'): [Expr, $operator|kw, Expr]
      if (c.length === 3 && ruleIs(c[2], 'Expr') && (k1.tokenType === '$operator' || t1 === 'in' || t1 === 'instanceof')) {
        const tok = TOKEN_KIND[t1];
        if (!tok) throw new Unlowered(`binary op ${t1}`, k1.offset);
        return ast('BinaryExpression', n.offset, n.end, [lowerExpr(lhs), ast(tok, k1.offset, k1.end), lowerExpr(c[2])]);
      }
    }
  }

  // nud forms led by a punct/keyword leaf.
  if (isLeaf(c[0])) {
    const t0 = text(c[0]);
    // Spread: ['...', Expr]
    if (t0 === '...' && c.length === 2 && ruleIs(c[1], 'Expr')) {
      return ast('SpreadElement', n.offset, n.end, [lowerExpr(c[1])]);
    }
    // Old-style type assertion: ['<', Type, '>', Expr]
    if (t0 === '<' && c.length === 4 && ruleIs(c[1], 'Type') && ruleIs(c[3], 'Expr')) {
      return ast('TypeAssertionExpression', n.offset, n.end, [lowerType(c[1]), lowerExpr(c[3])]);
    }
    // Parenthesized vs arrow: both arms start '('.
    // PAIN(5): two different grammar ALTERNATIVES with the same first token reach the
    // consumer as child-shape puzzles — '(' Expr ')' vs '(' Param* ')' '=>' …; the
    // discriminant (did the arrow arm match?) is re-derived by scanning for '=>'.
    if (t0 === '(') {
      const arrowIdx = findText(c, '=>');
      if (arrowIdx < 0 && c.length === 3 && ruleIs(c[1], 'Expr')) {
        return ast('ParenthesizedExpression', n.offset, n.end, [lowerExpr(c[1])]);
      }
      if (arrowIdx >= 0) return lowerArrow(n, c, arrowIdx);
    }
    // Single-param arrow: [Ident…?] — actually [Param-less ident '=>' body]
    if (c[0] && isLeaf(c[0]) && c[0].tokenType === 'Ident' && leafIs(c[1], '=>')) {
      const params = [ast('Parameter', c[0].offset, c[0].end, [ast('Identifier', c[0].offset, c[0].end)])];
      const body = c[2];
      const bodyAst = ruleIs(body, 'Expr') ? lowerExpr(body) : ruleIs(body, 'Block') ? lowerBlock(body) : null;
      if (!bodyAst) throw new Unlowered('arrow body', n.offset);
      return ast('ArrowFunction', n.offset, n.end, [...params, ast('EqualsGreaterThanToken', c[1].offset, c[1].end), bodyAst]);
    }
    // Array literal: '[' (Expr | ',')* ']'  (holes = consecutive commas → OmittedExpression)
    if (t0 === '[') {
      const elems: Ast[] = [];
      let expectElem = true;
      let sepEnd = c[0].end;
      for (const k of c.slice(1)) {
        if (isLeaf(k)) {
          const t = text(k);
          if (t === ',') {
            if (expectElem) elems.push(ast('OmittedExpression', sepEnd, sepEnd));
            expectElem = true;
            sepEnd = k.end;
          }
          continue;
        }
        if (ruleIs(k, 'Expr')) { elems.push(lowerExpr(k)); expectElem = false; }
      }
      return ast('ArrayLiteralExpression', n.offset, n.end, elems);
    }
    // Object literal: '{' Prop* '}'
    if (t0 === '{') {
      const props = rules(c, 'Prop').map(lowerProp);
      return ast('ObjectLiteralExpression', n.offset, n.end, props);
    }
    // new: ['new', NewTarget, ('(' args ')')?]
    if (t0 === 'new') {
      // PAIN(6): the operand rule is named 'NewTarget' — which reads as `new.target`
      // but actually means "the thing being constructed"; only reading the grammar
      // reveals that. Rule names are the consumer's API and they leak grammar-internal
      // naming.
      const target = findRule(c, 'NewTarget');
      if (!target) throw new Unlowered('new operand', n.offset);
      const args = rules(c, 'Expr').map(lowerExpr);
      return ast('NewExpression', n.offset, n.end, [lowerNewTarget(target), ...args]);
    }
    if (t0 === 'function') return lowerFunctionLike(n, c, 'FunctionExpression');
    if (t0 === 'class') return lowerClassLike(n, c, 'ClassExpression');
    if (t0 === 'this') return ast('ThisKeyword', n.offset, n.end);
    if (t0 === 'super') return ast('SuperKeyword', n.offset, n.end);
  }

  throw new Unlowered(`Expr shape [${c.map((x) => (isLeaf(x) ? JSON.stringify(text(x)) : x.rule)).join(' ')}]`, n.offset);
}

function lowerPrimaryLeaf(k: CstLeaf): Ast {
  switch (k.tokenType) {
    case 'Ident': return ast('Identifier', k.offset, k.end);
    // (PAIN(19) RESOLVED at the grammar: the keyword-valued literal alternatives now
    // precede the bare-identifier nud, so `this`/`true`/… arrive as $keyword leaves
    // and the $keyword case below handles them — no text re-classification.)
    case 'Number': case 'HexNumber': case 'OctalNumber': case 'BinaryNumber':
      return ast('NumericLiteral', k.offset, k.end);
    case 'BigInt': return ast('BigIntLiteral', k.offset, k.end);
    case 'String': return ast('StringLiteral', k.offset, k.end);
    case 'Regex': return ast('RegularExpressionLiteral', k.offset, k.end);
    case 'Template': return ast('NoSubstitutionTemplateLiteral', k.offset, k.end);
    case 'PrivateField': return ast('PrivateIdentifier', k.offset, k.end);
    case '$keyword': {
      const t = text(k);
      if (t === 'true') return ast('TrueKeyword', k.offset, k.end);
      if (t === 'false') return ast('FalseKeyword', k.offset, k.end);
      if (t === 'null') return ast('NullKeyword', k.offset, k.end);
      if (t === 'this') return ast('ThisKeyword', k.offset, k.end);
      if (t === 'super') return ast('SuperKeyword', k.offset, k.end);
      if (t === 'undefined') return ast('Identifier', k.offset, k.end);   // tsc: undefined is an Identifier
      break;
    }
  }
  throw new Unlowered(`primary leaf ${k.tokenType} ${JSON.stringify(text(k))}`, k.offset);
}

function lowerTemplate(n: CstNode): Ast {
  // $template node: head + (Expr middle)* tail; a no-substitution template is one leaf.
  // PAIN(11): tsc nests each (expression, middle/tail) pair in a TemplateSpan node with
  // a synthesized span — the CST's flat run must be re-grouped pairwise by the consumer.
  const c = n.children;
  if (c.length === 1 && isLeaf(c[0])) return ast('NoSubstitutionTemplateLiteral', n.offset, n.end);
  const head = c[0] as CstLeaf;
  const parts: Ast[] = [ast('TemplateHead', head.offset, head.end)];
  for (let i = 1; i < c.length; i += 2) {
    const expr = c[i];
    const lit = c[i + 1] as CstLeaf | undefined;
    if (!ruleIs(expr, 'Expr') || lit === undefined) break;
    const litKind = lit.tokenType === '$templateTail' ? 'TemplateTail' : 'TemplateMiddle';
    parts.push(ast('TemplateSpan', expr.offset, lit.end, [lowerExpr(expr), ast(litKind, lit.offset, lit.end)]));
  }
  return ast('TemplateExpression', n.offset, n.end, parts);
}

function lowerNewTarget(n: CstNode): Ast {
  const c = n.children;
  if (c.length === 1 && isLeaf(c[0])) return ast('Identifier', c[0].offset, c[0].end);
  if (ruleIs(c[0], 'NewTarget') && c.length === 3 && isLeaf(c[2])) {
    return ast('PropertyAccessExpression', n.offset, n.end, [lowerNewTarget(c[0]), ast('Identifier', c[2].offset, c[2].end)]);
  }
  // index form: NewTarget '[' Expr ']'  (`new benchmarks[i]()`)
  if (ruleIs(c[0], 'NewTarget') && c.length === 4 && leafIs(c[1], '[') && ruleIs(c[2], 'Expr')) {
    return ast('ElementAccessExpression', n.offset, n.end, [lowerNewTarget(c[0]), lowerExpr(c[2])]);
  }
  if (c.length === 1 && ruleIs(c[0], 'Expr')) return lowerExpr(c[0]);
  throw new Unlowered('NewTarget shape', n.offset);
}

function lowerArrow(n: CstNode, c: CstChild[], arrowIdx: number): Ast {
  const params = rules(c.slice(0, arrowIdx), 'Param').map(lowerParam);
  const retT = findRule(c.slice(0, arrowIdx), 'Type');
  const arrowTok = c[arrowIdx];
  const body = c[arrowIdx + 1];
  const bodyAst = ruleIs(body, 'Expr') ? lowerExpr(body) : ruleIs(body, 'Block') ? lowerBlock(body) : null;
  if (!bodyAst) throw new Unlowered('arrow body', n.offset);
  return ast('ArrowFunction', n.offset, n.end, [...params, ...(retT ? [lowerType(retT)] : []),
    ast('EqualsGreaterThanToken', arrowTok.offset, arrowTok.end), bodyAst]);
}

function lowerProp(n: CstNode): Ast {
  const c = n.children;
  // PAIN(7): the Prop rule's arms (shorthand / key:value / method / spread / get/set)
  // again only distinguishable by probing. Spot-checks below are the minimum survival set.
  if (leafIs(c[0], '...')) return ast('SpreadAssignment', n.offset, n.end, [lowerExpr(c[1] as CstNode)]);
  const keyNode = ruleIs(c[0], 'MemberName') ? c[0] : undefined;
  const colon = findText(c, ':');
  if (colon >= 0 && ruleIs(c[colon + 1], 'Expr')) {
    const key = c[0];
    const keyAst = keyNode ? lowerMemberName(keyNode)
      : isLeaf(key)
        ? (key.tokenType === 'String' ? ast('StringLiteral', key.offset, key.end)
          : key.tokenType === 'Number' ? ast('NumericLiteral', key.offset, key.end)
          : ast('Identifier', key.offset, key.end))
        : lowerExpr(key);
    return ast('PropertyAssignment', n.offset, n.end, [keyAst, lowerExpr(c[colon + 1] as CstNode)]);
  }
  if (c.length === 1 && isLeaf(c[0])) {
    return ast('ShorthandPropertyAssignment', n.offset, n.end, [ast('Identifier', c[0].offset, c[0].end)]);
  }
  // method-ish (`m() {}` / get/set/async/*) — find the Param/Block tail.
  if (findRule(c, 'Block')) {
    const params = rules(c, 'Param').map(lowerParam);
    const block = lowerBlock(findRule(c, 'Block')!);
    const name = keyNode ? [lowerMemberName(keyNode)] : [];
    return ast('MethodDeclaration', n.offset, n.end, [...name, ...params, block]);
  }
  throw new Unlowered(`Prop shape`, n.offset);
}

function lowerParam(n: CstNode): Ast {
  const c = n.children;
  const kids: Ast[] = [];
  const PMOD: Record<string, string> = {
    public: 'PublicKeyword', private: 'PrivateKeyword', protected: 'ProtectedKeyword',
    readonly: 'ReadonlyKeyword', override: 'OverrideKeyword',
  };
  let i0 = 0;
  while (i0 < c.length && isLeaf(c[i0]) && PMOD[text(c[i0])] && c[i0 + 1] !== undefined && !leafIs(c[i0 + 1], ':') && !leafIs(c[i0 + 1], ',') && !leafIs(c[i0 + 1], ')')) {
    kids.push(ast(PMOD[text(c[i0])], c[i0].offset, c[i0].end));
    i0++;
  }
  if (leafIs(c[i0], '...')) kids.push(ast('DotDotDotToken', c[i0].offset, c[i0].end));
  for (let i = i0; i < c.length; i++) {
    const k = c[i];
    if (isLeaf(k) && k.tokenType === 'Ident') kids.push(ast('Identifier', k.offset, k.end));
    else if (ruleIs(k, 'BindingPattern')) kids.push(lowerBindingPattern(k));
    else if (ruleIs(k, 'Type') && leafIs(c[i - 1], ':')) kids.push(lowerType(k));
    else if (ruleIs(k, 'Expr')) kids.push(lowerExpr(k));
  }
  return ast('Parameter', n.offset, n.end, kids);
}

// ── Types (minimal): enough to survive annotated code; everything else is opaque ──
function lowerType(n: CstNode): Ast {
  const c = n.children;
  if (c.length === 1 && isLeaf(c[0])) {
    const t = text(c[0]);
    const kw: Record<string, string> = {
      string: 'StringKeyword', number: 'NumberKeyword', boolean: 'BooleanKeyword', any: 'AnyKeyword',
      unknown: 'UnknownKeyword', never: 'NeverKeyword', void: 'VoidKeyword', undefined: 'UndefinedKeyword',
      object: 'ObjectKeyword', symbol: 'SymbolKeyword', bigint: 'BigIntKeyword',
    };
    if (c[0].tokenType === 'Ident' && kw[t]) return ast(kw[t], n.offset, n.end);
    if (c[0].tokenType === 'Ident') return ast('TypeReference', n.offset, n.end, [ast('Identifier', c[0].offset, c[0].end)]);
    if (c[0].tokenType === 'String') return ast('LiteralType', n.offset, n.end, [ast('StringLiteral', c[0].offset, c[0].end)]);
    if (c[0].tokenType === 'Number') return ast('LiteralType', n.offset, n.end, [ast('NumericLiteral', c[0].offset, c[0].end)]);
    if (t === 'null') return ast('LiteralType', n.offset, n.end, [ast('NullKeyword', c[0].offset, c[0].end)]);
  }
  if (c.length === 1 && ruleIs(c[0], 'Type')) return lowerType(c[0]);
  if (ruleIs(c[0], 'Type')) {
    const t1 = c[1];
    if (isLeaf(t1)) {
      const t = text(t1);
      if (t === '[' && c.length === 3) return ast('ArrayType', n.offset, n.end, [lowerType(c[0])]);
      if (t === '|') return ast('UnionType', n.offset, n.end, rules(c, 'Type').map(lowerType));
      if (t === '&') return ast('IntersectionType', n.offset, n.end, rules(c, 'Type').map(lowerType));
      if (t === '<') return ast('TypeReference', n.offset, n.end, rules(c, 'Type').map(lowerType));
      if (t === '.' && isLeaf(c[2])) {
        const left = lowerType(c[0]);
        const leftName = left.kind === 'TypeReference' && left.children.length === 1 ? left.children[0] : left;
        const q = ast('QualifiedName', n.offset, c[2].end, [leftName, ast('Identifier', c[2].offset, c[2].end)]);
        return ast('TypeReference', n.offset, n.end, [q]);
      }
    }
  }
  // Opaque fallback: keep the span, drop the structure (verify counts it as a kind
  // mismatch against tsc — measured, not hidden).
  return ast('UnknownTypeNode', n.offset, n.end);
}

function lowerBindingPattern(n: CstNode): Ast {
  const c = n.children;
  const open = text(c[0]);
  const kind = open === '{' ? 'ObjectBindingPattern' : 'ArrayBindingPattern';
  const elems: Ast[] = [];
  // PAIN(16): array HOLES exist only as consecutive ',' leaves — the consumer must
  // re-derive tsc's OmittedExpression nodes from comma adjacency.
  let expectElem = kind === 'ArrayBindingPattern';
  let sepEnd = c[0].end;
  for (let i = 0; i < c.length; i++) {
    const k = c[i];
    if (isLeaf(k)) {
      const t = text(k);
      if (t === ',') {
        if (expectElem) elems.push(ast('OmittedExpression', sepEnd, sepEnd));
        expectElem = true;
        sepEnd = k.end;
      }
      continue;
    }
    if (ruleIs(k, 'BindingProperty') || ruleIs(k, 'ArrayBindingElement') || ruleIs(k, 'BindingElement')) {
      elems.push(lowerBindingElement(k));
      expectElem = false;
    }
  }
  return ast(kind, n.offset, n.end, elems);
}

// All three CST element rules lower to tsc's one BindingElement
// (children: dotDotDotToken?, propertyName?, name, initializer?).
function lowerBindingElement(n: CstNode): Ast {
  const c = n.children;
  if (n.rule === 'ArrayBindingElement') {
    // ['...'? (BindingElement | Ident)]
    const kids: Ast[] = [];
    if (leafIs(c[0], '...')) kids.push(ast('DotDotDotToken', c[0].offset, c[0].end));
    const inner = findRule(c, 'BindingElement');
    if (inner) {
      const innerAst = lowerBindingElement(inner);
      kids.push(...innerAst.children);
    } else {
      const id = c.find((x) => isLeaf(x) && x.tokenType === 'Ident') as CstLeaf | undefined;
      if (id) kids.push(ast('Identifier', id.offset, id.end));
    }
    return ast('BindingElement', n.offset, n.end, kids);
  }
  if (n.rule === 'BindingProperty') {
    const kids: Ast[] = [];
    if (leafIs(c[0], '...')) {
      kids.push(ast('DotDotDotToken', c[0].offset, c[0].end));
      const id = c.find((x) => isLeaf(x) && x.tokenType === 'Ident') as CstLeaf | undefined;
      if (id) kids.push(ast('Identifier', id.offset, id.end));
      return ast('BindingElement', n.offset, n.end, kids);
    }
    const colon = findText(c, ':');
    if (colon >= 0) {
      // key ':' (BindingElement | …) — key becomes propertyName, the value's parts follow.
      const key = c[0];
      kids.push(isLeaf(key)
        ? (key.tokenType === 'String' ? ast('StringLiteral', key.offset, key.end)
          : key.tokenType === 'Number' ? ast('NumericLiteral', key.offset, key.end)
          : ast('Identifier', key.offset, key.end))
        : ruleIs(key, 'MemberName') ? lowerMemberName(key) : ast('Identifier', key.offset, key.end));
      const value = c[colon + 1];
      if (ruleIs(value, 'BindingElement')) kids.push(...lowerBindingElement(value).children);
      else if (ruleIs(value, 'BindingPattern')) kids.push(lowerBindingPattern(value));
      else if (value !== undefined && isLeaf(value)) kids.push(ast('Identifier', value.offset, value.end));
      return ast('BindingElement', n.offset, n.end, kids);
    }
    // shorthand (with optional default): [Ident ('=' Expr)?]
    const kids2: Ast[] = [];
    for (let i = 0; i < c.length; i++) {
      const k = c[i];
      if (isLeaf(k) && k.tokenType === 'Ident') kids2.push(ast('Identifier', k.offset, k.end));
      else if (ruleIs(k, 'Expr') && leafIs(c[i - 1], '=')) kids2.push(lowerExpr(k));
    }
    return ast('BindingElement', n.offset, n.end, kids2);
  }
  // BindingElement: [(Ident | BindingPattern) ('=' Expr)?]
  const kids: Ast[] = [];
  for (let i = 0; i < c.length; i++) {
    const k = c[i];
    if (isLeaf(k) && k.tokenType === 'Ident') kids.push(ast('Identifier', k.offset, k.end));
    else if (ruleIs(k, 'BindingPattern')) kids.push(lowerBindingPattern(k));
    else if (ruleIs(k, 'Expr') && leafIs(c[i - 1], '=')) kids.push(lowerExpr(k));
  }
  return ast('BindingElement', n.offset, n.end, kids);
}

// ── Statements ──
// lowerStmt consumes the GENERATED per-arm destructurer (typescript.cst-match.ts):
// the arm discrimination and field extraction that the first version of this file
// hand-probed (and got wrong in places — see PAIN 3/5/7) now comes from the grammar.
// A few arms still reach into n.children for the positions of uncaptured structural
// keywords ('catch', the switch '{') — a noted destructurer gap.
function lowerStmt(n: CstNode): Ast {
  const m = matchStmt(n as never, SRC);
  const c = n.children;
  switch (m.arm) {
    case 'block': return lowerBlock(m.block);
    case 'let_': case 'await_': {
      const decls = ('binding' in m ? m.binding : []).map(lowerBinding);
      const list = ast('VariableDeclarationList', n.offset, decls.length ? decls[decls.length - 1].end : n.end, decls);
      return ast('VariableStatement', n.offset, n.end, [list]);
    }
    case 'if_': {
      const kids = [lowerExpr(m.expr), lowerStmt(m.stmt)];
      if (m.stmt2) kids.push(lowerStmt(m.stmt2));
      return ast('IfStatement', n.offset, n.end, kids);
    }
    case 'for_': return lowerFor(n, c);
    case 'while_': return ast('WhileStatement', n.offset, n.end, [lowerExpr(m.expr), lowerStmt(m.stmt)]);
    case 'do_': return ast('DoStatement', n.offset, n.end, [lowerStmt(m.stmt), lowerExpr(m.expr)]);
    case 'switch_': {
      const disc = lowerExpr(m.expr);
      const clauses = groupSwitchClauses(m.switchCase);
      const caseBlockStart = findText(c, '{');
      const cb = ast('CaseBlock', caseBlockStart >= 0 ? c[caseBlockStart].offset : n.offset, n.end, clauses);
      return ast('SwitchStatement', n.offset, n.end, [disc, cb]);
    }
    case 'return_': return ast('ReturnStatement', n.offset, n.end, m.expr ? [lowerExpr(m.expr)] : []);
    case 'throw_': return ast('ThrowStatement', n.offset, n.end, [lowerExpr(m.expr)]);
    case 'break_': return ast('BreakStatement', n.offset, n.end, m.ident ? [ast('Identifier', m.ident.offset, m.ident.end)] : []);
    case 'continue_': return ast('ContinueStatement', n.offset, n.end, m.ident ? [ast('Identifier', m.ident.offset, m.ident.end)] : []);
    case 'try_': {
      const kids: Ast[] = [lowerBlock(m.block)];
      const catchIdx = findText(c, 'catch');
      if (catchIdx >= 0 && m.block2) {
        const catchKids: Ast[] = [];
        if (m.param) catchKids.push(ast('VariableDeclaration', m.param.offset, m.param.end, [lowerBindingTarget(m.param)]));
        catchKids.push(lowerBlock(m.block2));
        kids.push(ast('CatchClause', c[catchIdx].offset, m.block2.end, catchKids));
      }
      const lastBlock = m.block3 ?? (catchIdx < 0 ? m.block2 : undefined);
      if (lastBlock) kids.push(lowerBlock(lastBlock));
      return ast('TryStatement', n.offset, n.end, kids);
    }
    case 'ident': return ast('LabeledStatement', n.offset, n.end, [ast('Identifier', m.ident.offset, m.ident.end), lowerStmt(m.stmt)]);
    case 'semi': return ast('EmptyStatement', n.offset, n.end);
    case 'debugger_': return ast('DebuggerStatement', n.offset, n.end);
    case 'with_': return ast('WithStatement', n.offset, n.end, [lowerExpr(m.expr), lowerStmt(m.stmt)]);
    case 'decl': return lowerDecl(m.decl);
    case 'expr': return ast('ExpressionStatement', n.offset, n.end, [lowerExpr(m.expr)]);
    default: {
      const never_: never = m;
      throw new Unlowered(`Stmt arm ${(never_ as { arm: string }).arm}`, n.offset);
    }
  }
}

// PAIN(15) regrouping, now over the typed SwitchCase nodes from the destructurer.
function groupSwitchClauses(flat: CstNode[]): Ast[] {
  const clauses: Ast[] = [];
  let cur: { kind: string; start: number; openEnd: number; head: Ast[]; stmts: Ast[] } | null = null;
  const flush = () => {
    if (!cur) return;
    const end = cur.stmts.length ? cur.stmts[cur.stmts.length - 1].end : cur.openEnd;
    clauses.push(ast(cur.kind, cur.start, end, [...cur.head, ...cur.stmts]));
    cur = null;
  };
  for (const sc of flat) {
    const scc = sc.children;
    if (leafIs(scc[0], 'case')) {
      flush();
      cur = { kind: 'CaseClause', start: sc.offset, openEnd: sc.end, head: [lowerExpr(findRule(scc, 'Expr')!)], stmts: [] };
      cur.stmts.push(...rules(scc, 'Stmt').map(lowerStmt));
    } else if (leafIs(scc[0], 'default')) {
      flush();
      cur = { kind: 'DefaultClause', start: sc.offset, openEnd: sc.end, head: [], stmts: rules(scc, 'Stmt').map(lowerStmt) };
    } else if (ruleIs(scc[0], 'Stmt')) {
      const st = scc[0];
      const sl = st.children;
      if (isLeaf(sl[0]) && text(sl[0]) === 'default' && leafIs(sl[1], ':') && ruleIs(sl[2], 'Stmt')) {
        flush();
        cur = { kind: 'DefaultClause', start: st.offset, openEnd: st.end, head: [], stmts: [lowerStmt(sl[2])] };
      } else if (cur) {
        cur.stmts.push(lowerStmt(st));
      } else {
        throw new Unlowered('switch statements before any clause', sc.offset);
      }
    } else {
      throw new Unlowered('SwitchCase shape', sc.offset);
    }
  }
  flush();
  return clauses;
}

function lowerBindingTarget(n: CstNode): Ast {
  const f = n.children[0];
  if (isLeaf(f) && f.tokenType === 'Ident') return ast('Identifier', f.offset, f.end);
  if (isNode(f) && f.rule === 'BindingPattern') return lowerBindingPattern(f);
  throw new Unlowered('binding target', n.offset);
}

function lowerBinding(n: CstNode): Ast {
  const c = n.children;
  const kids: Ast[] = [lowerBindingTarget(n)];
  for (let i = 0; i < c.length; i++) {
    const k = c[i];
    if (ruleIs(k, 'Type') && leafIs(c[i - 1], ':')) kids.push(lowerType(k));
    if (ruleIs(k, 'Expr') && leafIs(c[i - 1], '=')) kids.push(lowerExpr(k));
  }
  return ast('VariableDeclaration', n.offset, n.end, kids);
}

function lowerFor(n: CstNode, c: CstChild[]): Ast {
  const head = findRule(c, 'ForHead');
  const body = lowerStmt(findRule(c, 'Stmt')!);
  if (!head) throw new Unlowered('for head', n.offset);
  const hc = head.children;
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
      const decl = ast('VariableDeclaration', target.offset, target.end, [lowerBindingTarget(target)]);
      init = ast('VariableDeclarationList', head.offset, target.end, [decl]);
    } else if (target && target.rule === 'Expr') {
      init = lowerExpr(target);
    } else if (target) {
      init = ast('VariableDeclarationList', head.offset, target.end, [ast('VariableDeclaration', target.offset, target.end, [lowerBindingTarget(target)])]);
    } else throw new Unlowered('for-in/of target', head.offset);
    return ast(kind, n.offset, n.end, [init, lowerExpr(rhs), body]);
  }
  // classic for: [decls? ';' cond? ';' incr?]
  const kids: Ast[] = [];
  if (isLeaf(hc[0]) && ['const', 'let', 'var'].includes(text(hc[0]))) {
    // PAIN(14): the same construct (a `let x = e` declarator) is rule 'Binding' in a
    // statement but rule 'ForBinding' in a for-head — same shape, two names to know.
    const decls = rules(hc, 'ForBinding').map(lowerBinding);
    kids.push(ast('VariableDeclarationList', head.offset, decls.length ? decls[decls.length - 1].end : head.end, decls));
    const exprs = rules(hc, 'Expr').map(lowerExpr);
    kids.push(...exprs);
  } else {
    kids.push(...rules(hc, 'Expr').map(lowerExpr));
  }
  kids.push(body);
  return ast('ForStatement', n.offset, n.end, kids);
}

function lowerBlock(n: CstNode): Ast {
  return ast('Block', n.offset, n.end, rules(n.children, 'Stmt').map(lowerStmt));
}

// ── Declarations ──
function lowerDecl(n: CstNode): Ast {
  const c = n.children;
  // modifiers prefix: export/declare/abstract/async/default …
  let i = 0;
  const mods: Ast[] = [];
  const MOD: Record<string, string> = {
    export: 'ExportKeyword', declare: 'DeclareKeyword', abstract: 'AbstractKeyword',
    async: 'AsyncKeyword', default: 'DefaultKeyword',
  };
  while (i < c.length && isLeaf(c[i]) && MOD[text(c[i])]) {
    mods.push(ast(MOD[text(c[i])], c[i].offset, c[i].end));
    i++;
  }
  const h = c[i];
  if (isNode(h) && h.rule === 'Decl') {
    // ['export'|'declare'… Decl] nesting: lower the inner declaration, then prepend the
    // modifiers and widen the span to include them (tsc spans start at the modifier).
    const inner = lowerDecl(h);
    return ast(inner.kind, n.offset, n.end, [...mods, ...inner.children]);
  }
  if (isLeaf(h)) {
    const t = text(h);
    if (t === 'function') return lowerFunctionLike(n, c.slice(i), 'FunctionDeclaration', mods);
    if (t === 'class') return lowerClassLike(n, c.slice(i), 'ClassDeclaration', mods);
    if (t === 'interface') {
      const name = c[i + 1] as CstLeaf;
      const members = rules(c, 'InterfaceMember').map((m) => ast('PropertySignature', m.offset, m.end));
      return ast('InterfaceDeclaration', n.offset, n.end, [...mods, ast('Identifier', name.offset, name.end), ...members]);
    }
    if (t === 'type') {
      const name = c[i + 1] as CstLeaf;
      const ty = findRule(c, 'Type');
      return ast('TypeAliasDeclaration', n.offset, n.end, [...mods, ast('Identifier', name.offset, name.end), ...(ty ? [lowerType(ty)] : [])]);
    }
    if (t === 'import') return lowerImport(n, c, i, mods);
    if (t === 'enum') {
      const name = c[i + 1] as CstLeaf;
      const members = rules(c, 'EnumMember').map(lowerEnumMember);
      return ast('EnumDeclaration', n.offset, n.end, [...mods, ast('Identifier', name.offset, name.end), ...members]);
    }
    if (t === 'namespace' || t === 'module') {
      // PAIN(17): tsc nests `module A.B.C {}` as ModuleDeclaration(A, ModuleDeclaration(B,
      // ModuleDeclaration(C, ModuleBlock))) with each inner declaration's span starting at
      // ITS name segment — the CST's flat [Ident '.' Ident '.' Ident '{' …] must be
      // re-associated right-to-left and the synthetic spans reconstructed.
      const brace = findText(c, '{');
      const nameLeaves = c.slice(i + 1, brace >= 0 ? brace : undefined).filter((x): x is CstLeaf => isLeaf(x) && (x.tokenType === 'Ident' || x.tokenType === 'String'));
      const body: Ast[] = [];
      for (const k of c) {
        if (ruleIs(k, 'Stmt')) body.push(lowerStmt(k));
        else if (ruleIs(k, 'Decl')) body.push(lowerDecl(k));
      }
      const blockStart = brace >= 0 ? c[brace].offset : n.end;
      const block = ast('ModuleBlock', blockStart, n.end, body);
      const last = nameLeaves[nameLeaves.length - 1];
      const lastName = last.tokenType === 'String' ? ast('StringLiteral', last.offset, last.end) : ast('Identifier', last.offset, last.end);
      let decl = ast('ModuleDeclaration', nameLeaves.length > 1 ? last.offset : n.offset, n.end, [lastName, block]);
      for (let j = nameLeaves.length - 2; j >= 0; j--) {
        const seg = nameLeaves[j];
        decl = ast('ModuleDeclaration', j === 0 ? n.offset : seg.offset, n.end, [ast('Identifier', seg.offset, seg.end), decl]);
      }
      if (mods.length) decl = ast('ModuleDeclaration', n.offset, n.end, [...mods, ...decl.children]);
      return decl;
    }
    if (t === 'export') return lowerExport(n, c, i, mods);
  }
  if (isNode(h) && (h.rule === 'Stmt')) {
    const inner = lowerStmt(h);
    if (mods.length) return ast(inner.kind, n.offset, n.end, [...mods, ...inner.children]);
    return inner;
  }
  throw new Unlowered(`Decl shape [${c.map((x) => (isLeaf(x) ? JSON.stringify(text(x)) : x.rule)).join(' ')}]`, n.offset);
}

function lowerFunctionLike(n: CstNode, c: CstChild[], kind: string, mods: Ast[] = []): Ast {
  const nameLeaf = c.find((x) => isLeaf(x) && x.tokenType === 'Ident') as CstLeaf | undefined;
  const params = rules(c, 'Param').map(lowerParam);
  const block = findRule(c, 'Block');
  let retT: Ast | undefined;
  for (let i = 0; i < c.length; i++) {
    if (ruleIs(c[i], 'Type') && leafIs(c[i - 1], ':')) { retT = lowerType(c[i] as CstNode); break; }
  }
  const kids = [...mods, ...(nameLeaf ? [ast('Identifier', nameLeaf.offset, nameLeaf.end)] : []), ...params, ...(retT ? [retT] : []), ...(block ? [lowerBlock(block)] : [])];
  return ast(kind, n.offset, n.end, kids);
}

function lowerClassLike(n: CstNode, c: CstChild[], kind: string, mods: Ast[] = []): Ast {
  const nameLeaf = c.find((x, i) => isLeaf(x) && x.tokenType === 'Ident' && i <= 2) as CstLeaf | undefined;
  const kids: Ast[] = [...mods];
  if (nameLeaf) kids.push(ast('Identifier', nameLeaf.offset, nameLeaf.end));
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
      if (ruleIs(k, 'ClassHeritage')) types.push(ast('ExpressionWithTypeArguments', k.offset, k.end, [lowerHeritage(k)]));
      else if (ruleIs(k, 'Type')) types.push(ast('ExpressionWithTypeArguments', k.offset, k.end, [lowerTypeAsExpr(k)]));
      else break;
    }
    if (types.length) kids.push(ast('HeritageClause', c[at].offset, types[types.length - 1].end, types));
  }
  kids.push(...rules(c, 'ClassMember').map(lowerClassMember));
  return ast(kind, n.offset, n.end, kids);
}

function lowerTypeAsExpr(n: CstNode): Ast {
  const c = n.children;
  if (c.length === 1 && isLeaf(c[0])) return ast('Identifier', c[0].offset, c[0].end);
  if (ruleIs(c[0], 'Type') && leafIs(c[1], '.') && isLeaf(c[2])) {
    return ast('PropertyAccessExpression', n.offset, n.end, [lowerTypeAsExpr(c[0]), ast('Identifier', c[2].offset, c[2].end)]);
  }
  if (c.length === 1 && ruleIs(c[0], 'Type')) return lowerTypeAsExpr(c[0]);
  return ast('Identifier', n.offset, n.end);
}

function lowerHeritage(n: CstNode): Ast {
  const c = n.children;
  if (c.length === 1 && isLeaf(c[0])) return ast('Identifier', c[0].offset, c[0].end);
  if (ruleIs(c[0], 'Expr')) return lowerExpr(c[0]);
  return ast('Identifier', n.offset, n.end);
}

function lowerClassMember(n: CstNode): Ast {
  const c = n.children;
  const MOD: Record<string, string> = {
    public: 'PublicKeyword', private: 'PrivateKeyword', protected: 'ProtectedKeyword',
    static: 'StaticKeyword', readonly: 'ReadonlyKeyword', abstract: 'AbstractKeyword',
    async: 'AsyncKeyword', override: 'OverrideKeyword', declare: 'DeclareKeyword', accessor: 'AccessorKeyword',
  };
  let i = 0;
  const mods: Ast[] = [];
  while (i < c.length && isLeaf(c[i]) && MOD[text(c[i])] && !(leafIs(c[i + 1], '(') || leafIs(c[i + 1], '=') || leafIs(c[i + 1], ':') || leafIs(c[i + 1], ';') || c[i + 1] === undefined)) {
    mods.push(ast(MOD[text(c[i])], c[i].offset, c[i].end));
    i++;
  }
  const nameNode = findRule(c, 'MemberName');
  const block = findRule(c, 'Block');
  const params = rules(c, 'Param').map(lowerParam);
  const nameAst = nameNode ? lowerMemberName(nameNode) : undefined;
  // PAIN(13): `constructor` appears as a bare $keyword leaf while every other member
  // name is a MemberName node — the same concept surfaces as different child kinds
  // depending on which grammar alternative matched.
  const isCtor = findText(c, 'constructor') >= 0 && nameNode === undefined;
  let retT: Ast | undefined;
  for (let j = 0; j < c.length; j++) {
    if (ruleIs(c[j], 'Type') && leafIs(c[j - 1], ':')) { retT = lowerType(c[j] as CstNode); break; }
  }
  if (block || findText(c, '(') >= 0) {
    if (isCtor) return ast('Constructor', n.offset, n.end, [...mods, ...params, ...(block ? [lowerBlock(block)] : [])]);
    const getIdx = findText(c, 'get');
    const setIdx = findText(c, 'set');
    const kind = getIdx >= 0 && nameNode && c[getIdx].offset < nameNode.offset ? 'GetAccessor'
      : setIdx >= 0 && nameNode && c[setIdx].offset < nameNode.offset ? 'SetAccessor'
      : 'MethodDeclaration';
    return ast(kind, n.offset, n.end, [...mods, ...(nameAst ? [nameAst] : []), ...params, ...(retT ? [retT] : []), ...(block ? [lowerBlock(block)] : [])]);
  }
  // property
  const init = (() => {
    for (let j = 0; j < c.length; j++) if (ruleIs(c[j], 'Expr') && leafIs(c[j - 1], '=')) return lowerExpr(c[j] as CstNode);
    return undefined;
  })();
  return ast('PropertyDeclaration', n.offset, n.end, [...mods, ...(nameAst ? [nameAst] : []), ...(retT ? [retT] : []), ...(init ? [init] : [])]);
}

function lowerMemberName(n: CstNode): Ast {
  // computed FIRST: the '[' is itself a leaf, so the leaf branch would shadow it.
  if (leafIs(n.children[0], '[')) {
    const e = findRule(n.children, 'Expr');
    if (e) return ast('ComputedPropertyName', n.offset, n.end, [lowerExpr(e)]);
  }
  const k = n.children[0];
  if (isLeaf(k)) {
    if (k.tokenType === 'String') return ast('StringLiteral', k.offset, k.end);
    if (k.tokenType === 'Number') return ast('NumericLiteral', k.offset, k.end);
    if (k.tokenType === 'PrivateField') return ast('PrivateIdentifier', k.offset, k.end);
    return ast('Identifier', k.offset, k.end);
  }
  return ast('Identifier', n.offset, n.end);
}

function lowerEnumMember(n: CstNode): Ast {
  const c = n.children;
  const name = c[0];
  const nameAst = isLeaf(name)
    ? (name.tokenType === 'String' ? ast('StringLiteral', name.offset, name.end) : ast('Identifier', name.offset, name.end))
    : lowerMemberName(name);
  const init: Ast[] = [];
  for (let i = 0; i < c.length; i++) if (ruleIs(c[i], 'Expr') && leafIs(c[i - 1], '=')) init.push(lowerExpr(c[i] as CstNode));
  return ast('EnumMember', n.offset, n.end, [nameAst, ...init]);
}

function lowerImportSpecifier(n: CstNode): Ast {
  const c = n.children;
  // [Ident ('as' Ident)?] → ImportSpecifier{ propertyName?, name }
  const ids = c.filter((x): x is CstLeaf => isLeaf(x) && x.tokenType === 'Ident');
  const kids = ids.map((x) => ast('Identifier', x.offset, x.end));
  return ast('ImportSpecifier', n.offset, n.end, kids);
}

function lowerImport(n: CstNode, c: CstChild[], i: number, mods: Ast[]): Ast {
  // 'import' ImportClause? 'from'? String ';'?  |  'import' String  |  import x = require(…)
  const clause = findRule(c, 'ImportClause');
  const spec = c.find((x) => isLeaf(x) && x.tokenType === 'String') as CstLeaf | undefined;
  const kids: Ast[] = [...mods];
  if (clause) {
    const cc = clause.children;
    const ckids: Ast[] = [];
    const star = findText(cc, '*');
    const brace = findText(cc, '{');
    if (isLeaf(cc[0]) && cc[0].tokenType === 'Ident') ckids.push(ast('Identifier', cc[0].offset, cc[0].end));
    if (star >= 0) {
      const ns = cc.find((x, j) => j > star && isLeaf(x) && x.tokenType === 'Ident') as CstLeaf;
      ckids.push(ast('NamespaceImport', cc[star].offset, ns.end, [ast('Identifier', ns.offset, ns.end)]));
    } else if (brace >= 0) {
      const named = rules(cc, 'ImportSpecifier').map(lowerImportSpecifier);
      ckids.push(ast('NamedImports', cc[brace].offset, clause.end, named));
    }
    kids.push(ast('ImportClause', clause.offset, clause.end, ckids));
  }
  if (spec) kids.push(ast('StringLiteral', spec.offset, spec.end));
  return ast('ImportDeclaration', n.offset, n.end, kids);
}

function lowerExport(n: CstNode, c: CstChild[], i: number, mods: Ast[]): Ast {
  // 'export' '{' specifiers '}' | 'export' '*' ('as' Ident)? 'from' String
  const star = findText(c, '*');
  const brace = findText(c, '{');
  const spec = c.find((x) => isLeaf(x) && x.tokenType === 'String') as CstLeaf | undefined;
  const kids: Ast[] = [...mods];
  if (brace >= 0) {
    const named = rules(c, 'ImportSpecifier').map((sp) => {
      const e = lowerImportSpecifier(sp);
      return ast('ExportSpecifier', e.pos, e.end, e.children);
    });
    const close = findText(c, '}');
    kids.push(ast('NamedExports', c[brace].offset, close >= 0 ? c[close].end : n.end, named));
  }
  if (spec) kids.push(ast('StringLiteral', spec.offset, spec.end));
  return ast('ExportDeclaration', n.offset, n.end, kids);
}

// ── Entry ──
export function lowerProgram(cst: CstNode, source: string): Ast {
  SRC = source;
  const stmts: Ast[] = [];
  for (const c of cst.children) {
    if (ruleIs(c, 'Stmt')) stmts.push(lowerStmt(c));
    else if (ruleIs(c, 'Decl')) stmts.push(lowerDecl(c));
    else throw new Unlowered(`top-level ${isNode(c) ? c.rule : text(c)}`, c.offset);
  }
  return ast('SourceFile', cst.offset, cst.end, stmts);
}
