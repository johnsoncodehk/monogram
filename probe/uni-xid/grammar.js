module.exports = grammar({
  name: "unixid",
  extras: $ => [/\s/],
  word: $ => $.ident,
  rules: {
    source_file: $ => repeat(choice(seq($.ident, ';'), seq($.priv, ';'), seq('if', $.ident, ';'))),
    ident: $ => token(/[_\p{XID_Start}][\p{XID_Continue}]*/),
    priv: $ => token(/#[_\p{XID_Start}][\p{XID_Continue}]*/),
  }
});
