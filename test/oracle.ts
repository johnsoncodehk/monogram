// ─────────────────────────────────────────────────────────────────────────────
//  oracle.ts — the NEUTRAL answer key. Walk tsc's own parse tree and assign each
//  leaf token a structural ROLE (scope-roles.ts), independent of any highlighter.
//  Parameterised by ScriptKind so the SAME classification serves both TypeScript
//  and JavaScript scope-gap adapters — share the
//  analysis, never duplicate it.
// ─────────────────────────────────────────────────────────────────────────────
import ts from 'typescript';
import { R } from './scope-roles.ts';
import type { RoleName } from './scope-roles.ts';

export interface GoldToken {
  start: number;
  end: number;
  text: string;
  role: RoleName;
  cat: 'id' | 'lit' | 'kw' | 'punct' | 'comment';
  parentKind: string;
  grandKind: string;
}

const KW_CONTROL = new Set(['if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default', 'break', 'continue', 'return', 'throw', 'try', 'catch', 'finally', 'with', 'debugger']);
const KW_OPERATOR = new Set(['typeof', 'instanceof', 'in', 'of', 'keyof', 'new', 'delete', 'void', 'as', 'satisfies', 'is', 'infer', 'await', 'yield', 'unique', 'asserts']);
const KW_STORAGE = new Set(['var', 'let', 'const', 'function', 'class', 'interface', 'enum', 'namespace', 'module', 'import', 'export', 'from', 'declare', 'abstract', 'public', 'private', 'protected', 'static', 'readonly', 'get', 'set', 'async', 'extends', 'implements', 'type', 'override', 'accessor', 'out', 'using', 'global']);
const KW_TYPE_BUILTIN = new Set(['string', 'number', 'boolean', 'any', 'unknown', 'never', 'object', 'symbol', 'bigint']);
const KW_CONST_BUILTIN = new Set(['true', 'false', 'null']);
const KW_THIS_SUPER = new Set(['this', 'super']);

const STRUCTURAL_PUNCT = new Set<number>([
  ts.SyntaxKind.OpenParenToken, ts.SyntaxKind.CloseParenToken,
  ts.SyntaxKind.OpenBraceToken, ts.SyntaxKind.CloseBraceToken,
  ts.SyntaxKind.OpenBracketToken, ts.SyntaxKind.CloseBracketToken,
  ts.SyntaxKind.SemicolonToken, ts.SyntaxKind.CommaToken,
  ts.SyntaxKind.DotToken, ts.SyntaxKind.DotDotDotToken,
  ts.SyntaxKind.AtToken, ts.SyntaxKind.ColonToken,
]);

function kwRole(text: string, node: ts.Node): RoleName {
  // `void` is dual-use: the `void expr` operator vs the `: void` type.
  if (text === 'void') return node.parent?.kind === ts.SyntaxKind.VoidExpression ? R.kwOperator : R.typeBuiltin;
  // `undefined` in TYPE position is lexed as UndefinedKeyword (in VALUE position it is an
  // Identifier, handled in identRole). Like `string`/`number`, official paints it support.type,
  // which R.kwOther rejects — so role it typeBuiltin. (`null` as a type is a LiteralType whose
  // NullKeyword → R.constBuiltin, whose family already accepts support.type, so it needs no change.)
  if (text === 'undefined') return R.typeBuiltin;
  if (KW_CONST_BUILTIN.has(text)) return R.constBuiltin;
  if (KW_THIS_SUPER.has(text)) return R.thisSuper;
  if (KW_TYPE_BUILTIN.has(text)) return R.typeBuiltin;
  if (KW_CONTROL.has(text)) return R.kwControl;
  if (KW_OPERATOR.has(text)) return R.kwOperator;
  if (KW_STORAGE.has(text)) return R.kwStorage;
  return R.kwOther;
}

// A JSX intrinsic (host) element name uses the React/TS convention: a simple tag
// whose first character is a lowercase ASCII letter (`div`, `span`, `my-widget`) is a
// host element scoped `entity.name.tag` by both grammars; an uppercase-initial tag
// (`Foo`) is a COMPONENT = a genuine value reference and must NOT be reclassified.
const isIntrinsicTagName = (text: string): boolean => /^[a-z]/.test(text);

// Classify an identifier by its structural position in the parse tree.
function identRole(node: ts.Node): RoleName {
  const p = node.parent;
  if (!p) return R.valueRef;
  const is = (fn: (n: ts.Node) => boolean) => fn(p);
  const hasName = (n: any) => n.name === node;

  // ── JSX markup roles ──────────────────────────────────────────────────────────
  // The simple-Identifier tagName of an opening/closing/self-closing element. A
  // lowercase-initial name is an INTRINSIC/host element → entity.name.tag (R.tagName);
  // an uppercase-initial name is a COMPONENT = a value reference → falls through to
  // R.valueRef below (do NOT touch — Monogram's value scope legitimately beats
  // official's support.class.component there). Dotted (`<Foo.Bar>`, a
  // PropertyAccessExpression) and namespaced (`<svg:rect>`, a JsxNamespacedName) tag
  // names are compound nodes, not the element's direct Identifier tagName, so they
  // are unaffected — handled as their own node kinds, like member access.
  if ((is(ts.isJsxOpeningElement) || is(ts.isJsxClosingElement) || is(ts.isJsxSelfClosingElement)) &&
      (p as ts.JsxOpeningLikeElement | ts.JsxClosingElement).tagName === node &&
      isIntrinsicTagName((node as ts.Identifier).text)) {
    return R.tagName;
  }
  // A JSX attribute NAME (`className=`, `data-x=`) — both grammars scope it
  // entity.other.attribute-name (R.attrName). The `name === node` guard excludes the
  // attribute's VALUE; namespaced attr names (`xml:lang`) are a JsxNamespacedName, not
  // an Identifier child of JsxAttribute, so they are unaffected.
  if (is(ts.isJsxAttribute) && hasName(p)) return R.attrName;

  if (is(ts.isFunctionDeclaration) && hasName(p)) return R.funcDecl;
  if (is(ts.isFunctionExpression) && hasName(p)) return R.funcDecl;
  if (is(ts.isMethodDeclaration) && hasName(p)) return R.funcDecl;
  if (is(ts.isMethodSignature) && hasName(p)) return R.funcDecl;
  if (is(ts.isGetAccessorDeclaration) && hasName(p)) return R.funcDecl;
  if (is(ts.isSetAccessorDeclaration) && hasName(p)) return R.funcDecl;

  if (is(ts.isParameter) && hasName(p)) return R.parameter;
  if (is(ts.isTypeParameterDeclaration) && hasName(p)) return R.typeParam;

  if (is(ts.isVariableDeclaration) && hasName(p)) return R.varDecl;
  // statement labels: the `loop:` of a LabeledStatement and the target of `break loop` /
  // `continue loop`. tsc stores all three as a `.label` Identifier; official paints them
  // entity.name.label (a value reference scope is too generic), so give them their own role.
  if (is(ts.isLabeledStatement) && (p as ts.LabeledStatement).label === node) return R.label;
  if ((is(ts.isBreakStatement) || is(ts.isContinueStatement)) && (p as ts.BreakOrContinueStatement).label === node) return R.label;
  if (is(ts.isBindingElement)) {
    if ((p as ts.BindingElement).propertyName === node) return R.propAccess;
    return R.varDecl;
  }

  if (is(ts.isPropertyDeclaration) && hasName(p)) return R.propDecl;
  if (is(ts.isPropertySignature) && hasName(p)) return R.propDecl;
  if (is(ts.isPropertyAssignment) && hasName(p)) return R.propDecl;
  if (is(ts.isShorthandPropertyAssignment)) return R.valueRef;
  if (is(ts.isEnumMember) && hasName(p)) return R.enumMember;

  if (is(ts.isClassDeclaration) && hasName(p)) return R.typeDecl;
  if (is(ts.isClassExpression) && hasName(p)) return R.typeDecl;
  if (is(ts.isInterfaceDeclaration) && hasName(p)) return R.typeDecl;
  if (is(ts.isTypeAliasDeclaration) && hasName(p)) return R.typeDecl;
  if (is(ts.isEnumDeclaration) && hasName(p)) return R.typeDecl;
  if (is(ts.isModuleDeclaration) && hasName(p)) return R.namespace;

  if (is(ts.isTypeReferenceNode)) return R.typeRef;
  if (is(ts.isTypeQueryNode)) return R.typeRef;
  if (is(ts.isExpressionWithTypeArguments)) return R.typeRef;
  if (is(ts.isQualifiedName)) return R.typeRef;
  if (is(ts.isImportTypeNode)) return R.typeRef;
  if (is(ts.isTypePredicateNode)) return R.typeRef;

  if (is(ts.isPropertyAccessExpression)) {
    const pa = p as ts.PropertyAccessExpression;
    if (pa.name === node) {
      const gp = p.parent;
      if (gp && ts.isCallExpression(gp) && gp.expression === p) return R.methodCall;
      return R.propAccess;
    }
    return R.valueRef; // the object (LHS)
  }
  if (is(ts.isCallExpression) && (p as ts.CallExpression).expression === node) return R.methodCall;
  if (is(ts.isNewExpression) && (p as ts.NewExpression).expression === node) return R.classRef;
  if (is(ts.isDecorator)) return R.classRef;

  if (is(ts.isImportSpecifier) || is(ts.isExportSpecifier)) return R.importBinding;
  if (is(ts.isImportClause) || is(ts.isNamespaceImport) || is(ts.isNamespaceExport)) return R.importBinding;

  if (node.kind === ts.SyntaxKind.Identifier && (node as ts.Identifier).text === 'undefined') return R.constBuiltin;

  return R.valueRef;
}

function leafRole(node: ts.Node, text: string): { role: RoleName; cat: GoldToken['cat'] } {
  const k = node.kind;
  if (k === ts.SyntaxKind.Identifier || k === ts.SyntaxKind.PrivateIdentifier) return { role: identRole(node), cat: 'id' };
  if (k === ts.SyntaxKind.StringLiteral) return { role: R.litString, cat: 'lit' };
  if (k === ts.SyntaxKind.NumericLiteral) return { role: R.litNumber, cat: 'lit' };
  if (k === ts.SyntaxKind.BigIntLiteral) return { role: R.litBigint, cat: 'lit' };
  if (k === ts.SyntaxKind.RegularExpressionLiteral) return { role: R.litRegex, cat: 'lit' };
  if (k === ts.SyntaxKind.NoSubstitutionTemplateLiteral || k === ts.SyntaxKind.TemplateHead || k === ts.SyntaxKind.TemplateMiddle || k === ts.SyntaxKind.TemplateTail) return { role: R.litTemplate, cat: 'lit' };
  if (k >= ts.SyntaxKind.FirstKeyword && k <= ts.SyntaxKind.LastKeyword) return { role: kwRole(text, node), cat: 'kw' };
  // the ambiguity fork: < > / are operators here iff tsc parsed them into a binary
  // expression (vs a generic bracket / regex). This is the source token of #978/#853.
  if ((k === ts.SyntaxKind.LessThanToken || k === ts.SyntaxKind.GreaterThanToken || k === ts.SyntaxKind.SlashToken) &&
      node.parent?.kind === ts.SyntaxKind.BinaryExpression) {
    return { role: R.opCompare, cat: 'punct' };
  }
  if (k >= ts.SyntaxKind.FirstPunctuation && k <= ts.SyntaxKind.LastPunctuation) {
    return { role: STRUCTURAL_PUNCT.has(k) ? R.punct : R.op, cat: 'punct' };
  }
  return { role: R.punct, cat: 'punct' }; // unknown stray token → lexical floor
}

// ts.SyntaxKind has duplicate values (FirstNode===QualifiedName, …); its reverse
// map returns the alias. Build a canonical name map that prefers the real name.
const KIND_NAME: Record<number, string> = {};
for (const name of Object.keys(ts.SyntaxKind)) {
  const v = (ts.SyntaxKind as any)[name];
  if (typeof v === 'number' && !/^(First|Last)/.test(name) && !(v in KIND_NAME)) KIND_NAME[v] = name;
}
const kindName = (k: number): string => KIND_NAME[k] ?? (ts.SyntaxKind[k] as string) ?? String(k);

const isJSDoc = (k: number): boolean => k >= ts.SyntaxKind.FirstJSDocNode && k <= ts.SyntaxKind.LastJSDocNode;

/**
 * tsc's own parse tree → neutral per-token roles. `scriptKind` selects the parser
 * dialect: ScriptKind.TS (default) for TypeScript, ScriptKind.JS for JavaScript.
 */
export function oracle(text: string, scriptKind: ts.ScriptKind = ts.ScriptKind.TS): GoldToken[] {
  const sf = ts.createSourceFile('bench.ts', text, ts.ScriptTarget.Latest, /*setParentNodes*/ true, scriptKind);
  const out: GoldToken[] = [];

  const visit = (node: ts.Node): void => {
    if (isJSDoc(node.kind)) return; // doc comments are graded as comment trivia, not as code
    const kids = node.getChildren(sf);
    if (kids.length === 0) {
      const start = node.getStart(sf);
      const end = node.getEnd();
      if (end <= start) return; // skip zero-width (EOF, missing) tokens
      if (node.kind === ts.SyntaxKind.EndOfFileToken) return;
      const tkText = text.slice(start, end);
      const { role, cat } = leafRole(node, tkText);
      const gp = node.parent?.parent;
      out.push({
        start, end, text: tkText, role, cat,
        parentKind: node.parent ? kindName(node.parent.kind) : 'none',
        grandKind: gp ? kindName(gp.kind) : 'none',
      });
      return;
    }
    for (const k of kids) visit(k);
  };
  visit(sf);

  // comments are trivia (not in the AST) — scan them in separately
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, /*skipTrivia*/ false, ts.LanguageVariant.Standard, text);
  let tok = scanner.scan();
  while (tok !== ts.SyntaxKind.EndOfFileToken) {
    if (tok === ts.SyntaxKind.SingleLineCommentTrivia || tok === ts.SyntaxKind.MultiLineCommentTrivia) {
      const start = scanner.getTokenStart();
      const end = scanner.getTokenEnd();
      out.push({ start, end, text: text.slice(start, end), role: R.comment, cat: 'comment', parentKind: 'Comment', grandKind: 'none' });
    }
    tok = scanner.scan();
  }

  out.sort((a, b) => a.start - b.start);
  return out;
}
