// Python's three target contexts in miniature (Grammar.assignTargets; api.ts assignTarget): the portable
// proof of several declared contexts in one grammar (docs/SECOND-LANGUAGE.md, M5). A statement's
// head is parsed once, as expressions, and checked where its tail is taken: `=` takes STAR targets
// (a name, an attribute, a subscript, and tuples, lists, parenthesized and starred ones of them),
// `+=` a SINGLE target (no tuple, list or star), `del` DEL targets (no star). `a + b = x;`,
// `f() = x;`, `[a, b] += x;`, `*a += x;`, `del *a;`, `a = f() = x;` have no parse.
import {
  token, rule, defineGrammar, left, op, assignTarget, arm,
  seq, oneOf, range, star, many, opt, sep, alt,
} from '../../src/api.ts';

const identStart = oneOf(range('a', 'z'), range('A', 'Z'), '_');
const identPart = oneOf(range('a', 'z'), range('A', 'Z'), range('0', '9'), '_');
const Ident = token(seq(identStart, star(identPart)), { identifier: true, scope: 'variable' });
const Num = token(seq(range('0', '9'), star(range('0', '9'))), { scope: 'constant.numeric' });

const Expr = rule(($) => [
  arm('name', Ident),
  arm('num', Num),
  arm('paren', '(', Exprs, ')'),
  arm('list', '[', opt(sep(Item, ',')), opt(','), ']'),
  [$, op, $],
  arm('attr', $, '.', Ident),
  arm('sub', $, '[', Exprs, ']'),
  arm('call', $, '(', ')'),
]);

const Item = rule(() => [
  arm('starred', '*', Expr),
  arm('plain', Expr),
]);

const Exprs = rule(() => [
  arm('tuple', Item, ',', opt(sep(Item, ',')), opt(',')),
  arm('one', Item),
]);

// One arm for the expression statement and both assignments, as python.ts writes it: each target
// check opens a branch of the tail and reads the head before it (through the `=` of a chain too).
const Value = rule(($) => [[Exprs, opt('=', assignTarget('star'), $)]]);
const Stmt = rule(() => [
  arm('simple', Exprs, opt(alt(['=', assignTarget('star'), Value], ['+=', assignTarget('single'), Exprs])), ';'),
  arm('del', 'del', Exprs, assignTarget('del'), ';'),
]);

const Program = rule(() => [many(Stmt)]);

export default defineGrammar({
  name: 'startargets',
  scopeName: 'source.startargets',
  tokens: { Ident, Num },
  prec: [left('+')],
  rules: { Expr, Item, Exprs, Value, Stmt, Program },
  assignTargets: {
    star: { leaves: ['name', 'attr', 'sub'], containers: { paren: 'all', list: 'all', tuple: 'all', starred: 'all' } },
    single: { leaves: ['name', 'attr', 'sub'], containers: { paren: 'all' } },
    del: { leaves: ['name', 'attr', 'sub'], containers: { paren: 'all', list: 'all', tuple: 'all' } },
  },
});
