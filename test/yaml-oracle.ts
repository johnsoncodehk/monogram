// yaml-oracle.ts — the `yaml` package (eemeli; maintained, spec-compliant) → per-token
// structural ROLE, the neutral answer key for the unified scope-gap harness. The official VS
// Code YAML grammar is the UNMAINTAINED textmate/yaml.tmbundle (vscode#203212), so the parser
// is the arbiter. Emits: mapping keys (entity.name.tag, the YAML convention), scalar VALUES by
// resolved type (string / number / boolean·null), and comments.
import { parseAllDocuments, isScalar, isMap, isSeq } from 'yaml';
import { R } from './scope-roles.ts';
import type { GoldToken } from './scope-gap.ts';
import type { RoleName } from './scope-roles.ts';

const valueRole = (v: unknown): RoleName =>
  typeof v === 'number' ? R.litNumber
  : (typeof v === 'boolean' || v === null) ? R.constBuiltin
  : R.litString;

export function yamlOracle(text: string): GoldToken[] {
  const out: GoldToken[] = [];
  let docs: any[];
  try { docs = parseAllDocuments(text); } catch { return out; }

  const push = (node: any, role: RoleName): void => {
    const r = node?.range;
    if (r && r[1] > r[0]) out.push({ start: r[0], end: r[1], text: text.slice(r[0], r[1]), role });
  };
  const walk = (node: any, isKey: boolean): void => {
    if (!node) return;
    if (isScalar(node)) push(node, isKey ? R.tagName : valueRole(node.value));
    else if (isMap(node)) for (const p of node.items) { walk(p.key, true); walk(p.value, false); }
    else if (isSeq(node)) for (const it of node.items) walk(it, false);
  };
  for (const doc of docs) walk(doc?.contents, false);

  // Comments: a `#` at line start or after whitespace, to EOL — unless it falls inside a scalar
  // span (a `#` with no preceding space is plain-scalar content, e.g. `a#b`).
  const scalarSpans = out.map((t) => [t.start, t.end] as const);
  const re = /#[^\n]*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const before = m.index === 0 ? '\n' : text[m.index - 1];
    if (before !== ' ' && before !== '\t' && before !== '\n') continue;
    if (scalarSpans.some(([s, e]) => m!.index >= s && m!.index < e)) continue;
    out.push({ start: m.index, end: m.index + m[0].length, text: m[0], role: R.comment });
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}
