// t3: option D on a mini JavaScript: the statement-level `{` / `function` reading as a block /
// declaration behind an optional zero-width external `_starts` (emitted when `{` / `function` follows).
// D=0 renders the master shape (no marker).
const D = false;
module.exports = grammar({
  name: 't3',
  externals: $ => [$._line_end, $._starts],
  extras: $ => [/\s/],
  word: $ => $.ident,
  conflicts: $ => [[$.block, $.object], [$.func_decl, $.func_expr], [$.expr, $.prop]],
  rules: {
    program: $ => repeat($.stmt),
    stmt: $ => choice(D ? seq(optional($._starts), $.block) : $.block, D ? seq(optional($._starts), $.func_decl) : $.func_decl, $.expr_stmt, seq('do', $.stmt, 'while', '(', $.expr, ')')),
    block: $ => seq('{', repeat($.stmt), '}'),
    func_decl: $ => seq('function', $.ident, '(', ')', $.block),
    expr_stmt: $ => seq($.expr, choice(';', $._line_end)),
    expr: $ => choice($.object, $.func_expr, $.ident, $.arrow,
      prec.left(2, seq($.expr, '(', optional($.expr), ')')),
      prec.left(2, seq($.expr, '.', $.ident)),
      prec.right(1, seq($.expr, '=', $.expr)),
      seq('(', $.expr, ')')),
    object: $ => seq('{', optional(seq($.prop, repeat(seq(',', $.prop)))), '}'),
    prop: $ => choice(seq($.ident, ':', $.expr), seq($.ident, '(', ')', $.block)),
    func_expr: $ => seq('function', optional($.ident), '(', ')', $.block),
    arrow: $ => prec.right(seq('(', ')', '=>', choice(D ? seq(optional($._starts), $.block) : $.block, $.expr))),
    ident: $ => /[a-z]+/,
  }
});
