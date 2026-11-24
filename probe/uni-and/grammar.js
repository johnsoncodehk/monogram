module.exports = grammar({
  name: "uniand",
  extras: $ => [/\s/],
  word: $ => $.ident,
  rules: {
    source_file: $ => repeat(choice(seq($.ident, ';'), seq($.priv, ';'), seq('if', $.ident, ';'))),
    ident: $ => token(/(?:[a-zA-Z_$][a-zA-Z0-9_$]*)(?:[[$\u200c\u200d\p{ID_Continue}]&&[^\x00-\x7f]][$\u200c\u200d\p{ID_Continue}]*)?|[[$_\p{ID_Start}]&&[^\x00-\x7f]][$\u200c\u200d\p{ID_Continue}]*/),
    priv: $ => token(/#(?:[a-zA-Z_$][a-zA-Z0-9_$]*)(?:[[$\u200c\u200d\p{ID_Continue}]&&[^\x00-\x7f]][$\u200c\u200d\p{ID_Continue}]*)?|#[[$_\p{ID_Start}]&&[^\x00-\x7f]][$\u200c\u200d\p{ID_Continue}]*/),
  }
});
