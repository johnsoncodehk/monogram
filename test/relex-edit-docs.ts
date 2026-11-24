// The documents of the exhaustive one-character relex edits, shared by the portable Doc's gate
// (test/portable-targets.ts) and the interpreter's lexer's (test/incremental-grammars.ts): every
// edit's relexed stream and parse ≡ a fresh one.

export const HOLE_EDIT_DOCS = [
  'f(a, `x${b + c}`);',
  'let q = 1;\nf(`x${(b)}y${c}`);',
  'g(`a${`b${c}d`}e`, 1);',
  'h(`${ {a: "}"}.a }${\'`\'}`);',
  'k(`${a // c\n}`);',
  // A `/` whose kind (regex or division) is decided by text after it: a regex attempt that
  // fails falls back to division, so an edit later on can change it.
  'let m = f() < / 2;',
  'x = y / z / w;',
  'if (f() < /re/.test(s)) g();',
  // Whether `/` after `)` is a regex or a division depends on the keyword before the matching `(`:
  // an edit to the keyword changes how text to its right lexes.
  'if (q) /r/.test(s);',
  'ifx (q) / r / 2;',
  'while (a) /re/;',
];
// Documents whose tokens are decided by reading past their end + 1, each with the texts inserted
// at every offset (and every character deleted): a number that tried a longer form and backed
// up (`1._x`), a run of such tries (`1._1_1_x`), an insertion right after the last unit such a
// read cannot pass (`x = 1.` + `_5`, `a = 0` + `xF`), an identifier escape, a block comment left
// open (its attempt reads to the end of the source and falls back to `/`).
export const LOOK_EDIT_DOCS: { doc: string; ins: string[] }[] = [
  { doc: 'x = 1._x;', ins: ['5', '_', 'x', '.'] },
  { doc: 'x = 1._1_1_x;', ins: ['5', '_'] },
  // `1._` backs up to `1` (its fraction tried `._`); inserting a digit after `_` makes one number.
  { doc: 'x = 1._ ;', ins: ['5', '1'] },
  { doc: 'x = 1._1_ ;', ins: ['5'] },
  { doc: 'x = 1.', ins: ['_5', '_', '5', 'e'] },
  { doc: 'a = 0', ins: ['xF', 'x', 'F', 'n'] },
  { doc: 'a = 1', ins: ['e+5', 'e5', 'e+'] },
  { doc: 'x = a\\u0041;', ins: ['b', '{', '}', '\\', 'u'] },
  { doc: 'x = y /* c', ins: ['*/', '*', '/'] },
  { doc: 'x = y / 2; /* c\nz', ins: ['*/', '/'] },
  // A document that does not lex (an unterminated template): a Doc exists for it all the same,
  // and an edit that closes the template (or deletes its opener) makes it parse.
  { doc: 'x = `a;', ins: ['`', '$'] },
];
