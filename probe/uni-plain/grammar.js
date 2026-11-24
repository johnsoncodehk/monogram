module.exports = grammar({
  name: "uniplain",
  extras: $ => [/\s/],
  word: $ => $.ident,
  rules: {
    source_file: $ => repeat(choice(seq($.ident, ';'), seq($.priv, ';'), seq('if', $.ident, ';'))),
    ident: $ => token(/(?:[a-zA-Z_$]|[$_\p{ID_Start}])(?:[a-zA-Z0-9_$]|[$\u200c\u200d\p{ID_Continue}])*/),
    priv: $ => token(/#(?:[a-zA-Z_$]|[$_\p{ID_Start}])(?:[a-zA-Z0-9_$]|[$\u200c\u200d\p{ID_Continue}])*/),
  }
});
