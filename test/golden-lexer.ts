// The frozen lexer baseline (test/golden/lexer/, see lexer-verify.ts) as an oracle: the
// expected token stream — [type, offset, length, flags] per token — or the lex error message
// for an input the golden recorded.
import { readdirSync, readFileSync } from 'node:fs';

type Golden = { spec: { name: string | null }; types: string[]; cases: [string, number[] | string][] };
type Tok = { type: string; text: string; offset: number; newlineBefore: boolean; commentBefore: boolean; multilineFlowBefore: boolean };
export type Stream = [string, number, number, number][] | { error: string };

const DIR = new URL('./golden/lexer/', import.meta.url);
const byName = new Map<string, Golden[]>();
for (const f of readdirSync(DIR).filter((f) => f.endsWith('.json'))) {
  const g = JSON.parse(readFileSync(new URL(f, DIR), 'utf8')) as Golden;
  const k = g.spec.name ?? '';
  byName.set(k, [...(byName.get(k) ?? []), g]);
}

export function goldenStream(grammarName: string, src: string): Stream | undefined {
  const gs = byName.get(grammarName) ?? [];
  if (gs.length !== 1) throw new Error(`expected one lexer golden for ${grammarName}, found ${gs.length}`);
  const hit = gs[0].cases.find(([s]) => s === src);
  if (!hit) return undefined;
  const want = hit[1];
  if (typeof want === 'string') return { error: want };
  const out: [string, number, number, number][] = [];
  for (let i = 0; i < want.length; i += 4) out.push([gs[0].types[want[i]], want[i + 1], want[i + 2], want[i + 3]]);
  return out;
}

export function streamOf(toks: Tok[] | { error: string }): Stream {
  if (!Array.isArray(toks)) return toks;
  return toks.map((t) => [t.type, t.offset, t.text.length,
    (t.newlineBefore ? 1 : 0) | (t.commentBefore ? 2 : 0) | (t.multilineFlowBefore ? 4 : 0)] as [string, number, number, number]);
}
