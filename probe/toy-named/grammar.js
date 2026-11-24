module.exports = grammar({
  name: "toynamed",
  extras: $ => [/\s/],
  word: $ => $.ident,
  precedences: $ => [['type_operand', 'type_refusable']],
  conflicts: $ => [[$.expr, $.type], [$.type]],
  rules: {
    program: $ => repeat(choice(seq($.expr, ';'), seq('type', $.ident, '=', $.type, ';'))),
    expr: $ => choice($.ident, prec.left(5, seq($.expr, '|', $.expr)), prec.left(10, seq($.expr, '<', $.expr)),
      seq(prec.left(10, seq($.expr, 'as')), $.type), prec.right(30, seq('-', $.expr)),
      seq(prec.left(2, seq($.expr, '?', $.expr, ':')), $.expr), prec.right(1, seq($.expr, '=', $.expr))),
    type: $ => choice($.ident, prec.right('type_operand', seq('|', $.type)), prec.right('type_operand', seq($.type, '|', $.type)), prec.right('type_operand', seq('keyof', $.type)),
      seq($.type, '[', ']'), seq($.type, '<', $.type, '>'), seq($.type, '.', $.ident), prec.left('type_refusable', seq($.type, '?')),
      prec.right('type_operand', seq($.type, 'extends', $.type, '?', $.type, ':', $.type))),
    ident: $ => /[a-zA-Z_]+/,
  }
});
