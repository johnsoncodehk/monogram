module.exports = grammar({
  name: "toybase",
  extras: $ => [/\s/],
  word: $ => $.ident,
  
  conflicts: $ => [[$.expr, $.type], [$.type]],
  rules: {
    program: $ => repeat(choice(seq($.expr, ';'), seq('type', $.ident, '=', $.type, ';'))),
    expr: $ => choice($.ident, prec.left(5, seq($.expr, '|', $.expr)), prec.left(10, seq($.expr, '<', $.expr)),
      seq(prec.left(10, seq($.expr, 'as')), $.type), prec.right(30, seq('-', $.expr)),
      seq(prec.left(2, seq($.expr, '?', $.expr, ':')), $.expr), prec.right(1, seq($.expr, '=', $.expr))),
    type: $ => choice($.ident, seq('|', $.type), seq($.type, '|', $.type), seq('keyof', $.type),
      seq($.type, '[', ']'), seq($.type, '<', $.type, '>'), seq($.type, '.', $.ident), seq($.type, '?'),
      seq($.type, 'extends', $.type, '?', $.type, ':', $.type)),
    ident: $ => /[a-zA-Z_]+/,
  }
});
