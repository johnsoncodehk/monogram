// The recovered-tree contract (recovery-1/DESIGN.md section 1), checked on one parseTotal outcome of
// a rejected input, and its measurements. Used by the recovery class (test/portable-recovery.ts).
//   P1 a root; P4 lossless: leaves in order, non-overlapping, each a token, every non-punctuation
//   token a leaf (the CST keeps no punctuation leaf outside an `$error`); a `$missing` is zero-width
//   with no children; a node's span is its children's; P5 one diagnostic per repair node, in tree
//   order, at its span (`expected …` for a `$missing`, `unexpected …` for an `$error`);
//   P10 repair validity: each `$missing` replaced by its literal (or a sample token of its kind)
//   right after the token before it, each `$error` span blanked (its white space kept, so no
//   token's line-break flag moves), the strict parser accepts the text.
export type Tok = { off: number; end: number; kind: string; text: string };
type Node = { rule?: string; tokenType?: string; children?: Node[]; offset: number; end: number };
export type ContractRow = {
  missing: number; errors: number; fallbacks: number; errSpans: number[]; errShare: number[]; attempts: number; steps: number; strictSteps: number;
  p10: 'missing-only' | 'with-error' | 'unchecked'; p10ok: boolean;
};
const at = (src: string) => JSON.stringify(src.length > 90 ? src.slice(0, 90) + '…' : src);

export function checkContract(src: string, toks: Tok[], root: Node | null, errors: [number, number, string][], steps: number, attempts: number, strictSteps: number,
  samples: Map<string, string>, accepts: (s: string) => boolean, bad: string[], p10Gate: (k: ContractRow['p10']) => boolean = () => true): ContractRow | null {
  if (root === null) { bad.push(`P1: no root — ${at(src)}`); return null; }
  const leaves: Node[] = [], reps: Node[] = [];
  const walk = (x: Node): void => {
    if (x.tokenType !== undefined) { leaves.push(x); return; }
    const ks = x.children ?? [];
    if (x.rule === '$missing' || x.rule === '$error') reps.push(x);
    if (x.rule === '$missing' && (ks.length !== 0 || x.offset !== x.end)) bad.push(`P4: a $missing with children or a width — ${at(src)}`);
    if (ks.length && (x.offset !== ks[0]!.offset || x.end !== ks[ks.length - 1]!.end)) bad.push(`P4: ${x.rule}'s span [${x.offset}, ${x.end}) is not its children's — ${at(src)}`);
    ks.forEach(walk);
  };
  walk(root);
  const byOff = new Map(toks.map((t) => [t.off, t]));
  let last = -1;
  for (const l of leaves) {
    const t = byOff.get(l.offset);
    if (!t || t.end !== l.end) { bad.push(`P4: a leaf [${l.offset}, ${l.end}) is no token — ${at(src)}`); break; }
    if (l.offset < last) { bad.push(`P4: leaves out of order at ${l.offset} — ${at(src)}`); break; }
    last = l.end;
  }
  const leafAt = new Set(leaves.map((l) => l.offset));
  const lost = toks.filter((t) => t.kind !== '' && !leafAt.has(t.off));
  if (lost.length) bad.push(`P4: token ${JSON.stringify(lost[0]!.text)} at ${lost[0]!.off} is no leaf — ${at(src)}`);
  // P5
  if (reps.length !== errors.length) bad.push(`P5: ${reps.length} repair nodes, ${errors.length} diagnostics — ${at(src)}`);
  else reps.forEach((r, i) => {
    const [o, e, msg] = errors[i]!;
    const want = r.rule === '$missing' ? 'expected ' : 'unexpected ';
    if (o !== r.offset || e !== r.end || !msg.startsWith(want)) bad.push(`P5: ${r.rule} [${r.offset}, ${r.end}) has the diagnostic ${JSON.stringify(errors[i])} — ${at(src)}`);
  });
  // P10
  let text = src, checkable = true;
  const nMiss = reps.filter((r) => r.rule === '$missing').length;
  for (let i = reps.length - 1; i >= 0; i--) {
    const r = reps[i]!;
    if (r.rule === '$error') { text = text.slice(0, r.offset) + text.slice(r.offset, r.end).replace(/\S/g, ' ') + text.slice(r.end); continue; }
    const msg = errors[i]?.[2] ?? '';
    const lit = /^expected '([\s\S]*)'$/.exec(msg);
    const kind = lit ? undefined : /^expected (\S+)$/.exec(msg)?.[1];
    const ins = lit ? lit[1]! : kind !== undefined ? samples.get(kind) : undefined;
    if (ins === undefined) { checkable = false; break; }
    const prev = toks.filter((t) => t.end <= r.offset).pop();
    const p = prev ? prev.end : 0;
    text = `${text.slice(0, p)} ${ins} ${text.slice(p)}`;
  }
  const p10: ContractRow['p10'] = !checkable ? 'unchecked' : nMiss === reps.length ? 'missing-only' : 'with-error';
  const p10ok = checkable && accepts(text);
  if (checkable && !p10ok && p10Gate(p10)) bad.push(`P10: the repaired text is rejected: ${at(text)} — ${at(src)}`);
  // The totality fallback's `$error` nodes are top-level entries (children of the root); a skip
  // inside an entry is a local repair. The measurements are the fallback's.
  const errs = (root.children ?? []).filter((r) => r.rule === '$error');
  const span = (r: Node) => toks.filter((t) => t.off >= r.offset && t.end <= r.end).length;
  return {
    missing: nMiss, errors: reps.length - nMiss, fallbacks: errs.length, errSpans: errs.map(span), errShare: errs.map((r) => span(r) / Math.max(1, toks.length)),
    attempts, steps, strictSteps, p10, p10ok,
  };
}

const q = (xs: number[], p: number): number => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]!; };
const mpm = (xs: number[], f = (x: number) => String(x)) => `median ${f(q(xs, 0.5))}, p90 ${f(q(xs, 0.9))}, max ${f(q(xs, 1))}`;
/** The measurements over the rejected inputs (the coordinator's (a)-(c)). */
export function summarize(label: string, rows: (ContractRow | null)[]): string {
  const rs = rows.filter((r): r is ContractRow => r !== null);
  const fb = rs.filter((r) => r.fallbacks > 0).length;
  const spans = rs.flatMap((r) => r.errSpans), shares = rs.flatMap((r) => r.errShare);
  const pct = (a: number, b: number) => `${(100 * a / Math.max(1, b)).toFixed(1)}%`;
  const mo = rs.filter((r) => r.p10 === 'missing-only'), we = rs.filter((r) => r.p10 === 'with-error'), un = rs.filter((r) => r.p10 === 'unchecked');
  return [
    `${label}: ${rs.length} rejected inputs recovered; repairs: $missing ${rs.reduce((s, r) => s + r.missing, 0)}, $error ${rs.reduce((s, r) => s + r.errors, 0)} (of them the fallback's ${spans.length})`,
    `  the fallback on ${fb} (${pct(fb, rs.length)}); its $error spans in tokens ${mpm(spans)}; as a share of the input's tokens ${mpm(shares, (x) => pct(x, 1))}`,
    `  attempts per input ${mpm(rs.map((r) => r.attempts))}; recovered / strict interpreted steps ${mpm(rs.map((r) => r.steps / Math.max(1, r.strictSteps)), (x) => x.toFixed(2))}`,
    `  P10 checkable on ${mo.length + we.length} (${pct(mo.length + we.length, rs.length)}): $missing only ${mo.length} (holds ${mo.filter((r) => r.p10ok).length}), with $error ${we.length} (holds ${we.filter((r) => r.p10ok).length}); unchecked ${un.length}`,
  ].join('\n');
}
