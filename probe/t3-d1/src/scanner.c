// t3 scanner: `_starts` (zero-width) where `{` or the word `function` follows; `_line_end`
// (zero-width) at a line break, the end of the input, or before `}`. `_starts` is decided first.
#include "tree_sitter/parser.h"
#include <wctype.h>
enum { LINE_END, STARTS };
void *tree_sitter_t3_external_scanner_create(void) { return NULL; }
void tree_sitter_t3_external_scanner_destroy(void *p) { (void)p; }
unsigned tree_sitter_t3_external_scanner_serialize(void *p, char *b) { (void)p; (void)b; return 0; }
void tree_sitter_t3_external_scanner_deserialize(void *p, const char *b, unsigned n) { (void)p; (void)b; (void)n; }
bool tree_sitter_t3_external_scanner_scan(void *p, TSLexer *lexer, const bool *valid) {
  (void)p;
  if (valid[LINE_END] && valid[STARTS] && false) return false;
  lexer->mark_end(lexer);
  bool lb = false;
  while (iswspace(lexer->lookahead)) { if (lexer->lookahead == '\n') lb = true; lexer->advance(lexer, true); }
  bool eof = lexer->eof(lexer);
  if (valid[STARTS] && !eof) {
    if (lexer->lookahead == '{') { lexer->result_symbol = STARTS; return true; }
    if (lexer->lookahead == 'f') {
      const char *w = "function";
      bool line_end_holds = valid[LINE_END] && lb;
      for (int i = 0; w[i]; i++) { if (lexer->lookahead != w[i]) goto no; lexer->advance(lexer, true); }
      if (iswalnum(lexer->lookahead)) goto no;
      lexer->result_symbol = STARTS; return true;
    no:
      if (line_end_holds) { lexer->result_symbol = LINE_END; return true; }
      return false;
    }
  }
  if (valid[LINE_END] && (lb || eof || lexer->lookahead == '}')) { lexer->result_symbol = LINE_END; return true; }
  return false;
}
