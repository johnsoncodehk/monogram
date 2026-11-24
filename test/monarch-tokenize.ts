// tokenize: the Monarch rule subset gen-monarch emits, run as Monaco's lexer runs it (see
// test/monarch-dialect.ts's header). Shared by test/monarch-dialect.ts's rows and its --agreement mode.
import type { MonarchLanguage, MonarchAction } from '../src/gen-monarch.ts';

export interface Tok { start: number; text: string; token: string }

export function tokenize(mon: MonarchLanguage, src: string): Tok[] {
  const out: Tok[] = [];
  const stack: string[] = ['root'];
  const flags = (mon.ignoreCase ? 'i' : '') + (mon.unicode ? 'u' : '');
  const cache = new Map<string, RegExp>();
  // a rule's regex as Monaco's compiler reads it: `@@` is a literal `@`, `@name` the language
  // attribute `name` (a string), else the compile throws
  const monacoRegex = (s: string) => s.replace(/@@|@(\w+)/g, (m, a?: string) => {
    if (m === '@@') return '@';
    const v = (mon as unknown as Record<string, unknown>)[a!];
    if (typeof v !== 'string') throw new Error(`/${s}/: the language has no attribute @${a}`);
    return v ? `(?:${v})` : '';
  });
  const re = (s: string) => { let r = cache.get(s); if (!r) { r = new RegExp(`^(?:${monacoRegex(s)})`, flags); cache.set(s, r); } return r; };
  const rulesOf = (state: string, seen = new Set<string>()): [string, MonarchAction, string?][] => {
    const rs = mon.tokenizer[state];
    if (!rs) throw new Error(`no state \`${state}\``);
    const flat: [string, MonarchAction, string?][] = [];
    for (const r of rs) {
      if (!Array.isArray(r)) {
        const inc = (r as { include: string }).include.replace(/^@/, '');
        if (seen.has(inc)) throw new Error(`include cycle at \`${inc}\``);
        flat.push(...rulesOf(inc, new Set([...seen, inc])));
      } else flat.push(r as [string, MonarchAction, string?]);
    }
    return flat;
  };
  // a `cases` key as Monaco's compiler reads it: `@default`, a word (exact text), else a regex
  // over the whole text
  const caseMatches = (key: string, text: string) =>
    key === '@default' || (/^\w*$/.test(key) ? key === text : new RegExp(`^(?:${key})$`, flags).test(text));
  const resolve = (a: MonarchAction, text: string): MonarchAction => {
    if (typeof a === 'object' && !Array.isArray(a) && 'cases' in a) {
      const k = Object.keys(a.cases).find(k => caseMatches(k, text));
      return resolve(k === undefined ? '' : a.cases[k], text);
    }
    return a;
  };
  // An embedded language (`nextEmbedded`) as Monaco runs it: the text up to the first match, on
  // the line, of a rule of the current state whose action has `nextEmbedded: '@pop'` is the
  // embedded language's (one token `embedded.<language>` here); there the outer rules go on.
  let embedded: string | null = null;
  const popOffset = (state: string, rest: string): number => {
    let best = -1, found = false;
    for (const [reSrc, a] of rulesOf(state)) {
      if (typeof a !== 'object' || Array.isArray(a) || (a as { nextEmbedded?: string }).nextEmbedded !== '@pop') continue;
      found = true;
      const at = rest.search(new RegExp(monacoRegex(reSrc), flags));
      if (at >= 0 && (best < 0 || at < best)) best = at;
    }
    if (!found) throw new Error(`no rule containing nextEmbedded: "@pop" in tokenizer embedded state: ${state}`);
    return best;
  };
  let base = 0;
  for (const line of src.split('\n')) {
    let pos = 0;
    let guard = 0;
    while (pos < line.length) {
      if (++guard > 100000) throw new Error('Monarch runaway');
      const state = stack[stack.length - 1];
      if (embedded !== null) {
        const off = popOffset(state, line.slice(pos));
        const end = off < 0 ? line.length : pos + off;
        if (end > pos) out.push({ start: base + pos, text: line.slice(pos, end), token: `embedded.${embedded}` });
        pos = end;
        if (pos >= line.length) break;
      }
      let matched = false;
      for (const [reSrc, action0, third] of rulesOf(state)) {
        const m = re(reSrc).exec(line.slice(pos));
        if (!m) continue;
        let text = m[0];
        const action = resolve(action0, text);
        if (Array.isArray(action)) {
          if (m.length - 1 !== action.length) throw new Error(`rule /${reSrc}/: ${m.length - 1} groups, ${action.length} actions`);
          if (m.slice(1).join('') !== text) throw new Error(`rule /${reSrc}/: the groups do not cover the match`);
          let p = pos;
          for (let i = 0; i < action.length; i++) {
            const g = m[i + 1] ?? '';
            const a = resolve(action[i], g);
            if (g) out.push({ start: base + p, text: g, token: typeof a === 'string' ? a : (a as { token: string }).token });
            p += g.length;
          }
        } else {
          const token = typeof action === 'string' ? action : (action as { token: string }).token;
          const emb = typeof action === 'object' ? (action as { nextEmbedded?: string }).nextEmbedded : undefined;
          if (emb === '@pop') embedded = null;
          else if (emb !== undefined) {
            if (embedded !== null) throw new Error('cannot enter embedded language from within an embedded language');
            embedded = emb;
          }
          // `@rematch`: nothing consumed; the state change applies and the text is matched again
          if (token === '@rematch') text = '';
          if (text) out.push({ start: base + pos, text, token });
          const next = (typeof action === 'object' && ((action as { next?: string }).next)) || third;
          const sw = typeof action === 'object' ? (action as { switchTo?: string }).switchTo : undefined;
          const depth = stack.length;
          if (sw) stack[stack.length - 1] = sw.replace(/^@/, '');
          else if (next === '@pop') { if (stack.length > 1) stack.pop(); }
          else if (next === '@popall') stack.splice(1);
          else if (next) stack.push(next.replace(/^@/, ''));
          if (!text && depth === stack.length && stack[stack.length - 1] === state) throw new Error(`no progress in state \`${state}\` at ${JSON.stringify(line.slice(pos, pos + 20))} (rule /${reSrc}/)`);
        }
        pos += text.length;
        matched = true;
        break;
      }
      if (!matched) { out.push({ start: base + pos, text: line[pos], token: mon.defaultToken }); pos++; }
    }
    base += line.length + 1;
  }
  return out;
}
