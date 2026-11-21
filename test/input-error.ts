// The parse engine rejects input by throwing a plain Error that names an offset (the parser's
// "Parse error at offset N", the lexer's "Unexpected character at offset N", "Unterminated
// template literal at offset N", ...). Anything else it throws is a crash, not a verdict, and an
// accept/reject harness must report it as one instead of counting it as a rejection.
export const isInputError = (e: unknown): boolean =>
  e instanceof Error && e.constructor === Error && / at offset \d+/.test(e.message);
