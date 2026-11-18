// The token-id intern config an emitted jsTarget parser baked, read back from its source, so a
// gate can build the reference createLexer with exactly the same ids.
import type { LexerIntern } from '../src/gen-lexer.ts';

export function internOf(emittedSource: string): LexerIntern {
  const table = (name: string) => {
    const m = emittedSource.match(new RegExp(`const ${name} = new Map(?:<[^>]*>)?\\((.*)\\);`));
    if (!m) throw new Error(`emitted parser has no ${name} table`);
    return new Map<string, number>(JSON.parse(m[1]));
  };
  const int = (name: string) => {
    const m = emittedSource.match(new RegExp(`const ${name} = (\\d+);`));
    if (!m) throw new Error(`emitted parser has no ${name} constant`);
    return Number(m[1]);
  };
  return {
    typeKind: table('TYPE_KIND'), kwLit: table('LIT_KW'), puLit: table('LIT_PU'),
    punctKind: int('K_PUNCT'), namedFallback: int('K_NAMED_FALLBACK'),
  };
}
