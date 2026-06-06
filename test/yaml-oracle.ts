// yaml-oracle.ts — the `yaml` package (eemeli; maintained, spec-compliant) → per-token
// structural ROLE, the neutral answer key for the unified scope-gap harness. The official VS
// Code YAML grammar is the UNMAINTAINED textmate/yaml.tmbundle (vscode#203212), so the parser
// is the arbiter. Emits: mapping keys (entity.name.tag, the YAML convention), scalar VALUES by
// resolved type (string / number / boolean·null), comments, AND the structural constructs the
// coarse key/value/comment oracle used to miss (issue #12): anchors (&a), aliases (*a), document
// markers (--- / ...), and string escapes (\n) inside double-quoted scalars.
import { parseAllDocuments, isScalar, isMap, isSeq } from 'yaml';
import { R } from './scope-roles.ts';
import type { GoldToken } from './scope-gap.ts';
import type { RoleName } from './scope-roles.ts';

const valueRole = (v: unknown): RoleName =>
  typeof v === 'number' ? R.litNumber
  : (typeof v === 'boolean' || v === null) ? R.constBuiltin
  : R.litString;

// YAML double-quoted escape set (§5.7): a `\` + one escape char, or \xNN / \uNNNN / \UNNNNNNNN.
const ESCAPE = /\\(?:[0abtnvfre"/\\N_LP \t]|x[0-9A-Fa-f]{2}|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8})/g;

export function yamlOracle(text: string): GoldToken[] {
  const out: GoldToken[] = [];
  let docs: any[];
  try { docs = parseAllDocuments(text); } catch { return out; }

  const push = (node: any, role: RoleName): void => {
    const r = node?.range;
    if (r && r[1] > r[0]) out.push({ start: r[0], end: r[1], text: text.slice(r[0], r[1]), role });
  };
  // A double-quoted scalar's escape sequences each get their own escape token (a KEY or a VALUE —
  // #7 is escapes in a quoted KEY). The whole-scalar key/value token stays; escapes overlay it.
  const pushEscapes = (node: any): void => {
    const r = node?.range;
    if (!r || node.type !== 'QUOTE_DOUBLE') return;
    const seg = text.slice(r[0], r[1]);
    let m: RegExpExecArray | null;
    ESCAPE.lastIndex = 0;
    while ((m = ESCAPE.exec(seg))) out.push({ start: r[0] + m.index, end: r[0] + m.index + m[0].length, text: m[0], role: R.escape });
  };
  // A VALUE-position block scalar (`|`/`>`): split the introducer (a structural control sigil) from
  // the verbatim body. introducer = `|`/`>` + chomping/indent on the header line; body = the lines
  // below. (A block scalar in KEY position stays ONE tagName token — the whole scalar is the key name.)
  const isBlockScalar = (n: any) => n?.type === 'BLOCK_LITERAL' || n?.type === 'BLOCK_FOLDED';
  const pushBlockScalar = (node: any): void => {
    const r = node?.range;
    if (!r || r[1] <= r[0]) return;
    const introLen = /^[|>][-+0-9]*/.exec(text.slice(r[0], r[1]))?.[0].length ?? 1;
    out.push({ start: r[0], end: r[0] + introLen, text: text.slice(r[0], r[0] + introLen), role: R.blockIndicator });
    // content body = the first NON-BLANK char after the header line (skip leading indent + blank
    // lines — they are structural whitespace; grading them would test the INDENT's scope, not the
    // scalar content, and whitespace is visually colourless either way).
    const nl = text.indexOf('\n', r[0]);
    let contentStart = nl >= 0 ? nl + 1 : r[0] + introLen;
    while (contentStart < r[1] && (text[contentStart] === ' ' || text[contentStart] === '\t' || text[contentStart] === '\n')) contentStart++;
    if (r[1] > contentStart) out.push({ start: contentStart, end: r[1], text: text.slice(contentStart, r[1]), role: R.litString });
  };
  const walk = (node: any, isKey: boolean): void => {
    if (!node) return;
    if (isScalar(node)) {
      if (!isKey && isBlockScalar(node)) pushBlockScalar(node);
      else { push(node, isKey ? R.tagName : valueRole(node.value)); pushEscapes(node); }
    }
    else if (isMap(node)) for (const p of node.items) { walk(p.key, true); walk(p.value, false); }
    else if (isSeq(node)) for (const it of node.items) walk(it, false);
  };
  for (const doc of docs) walk(doc?.contents, false);

  // The scalar spans collected so far bound the regex passes below: a `&`/`*`/`#`/`---` that falls
  // INSIDE a scalar is content, not a sigil (e.g. `a & b` is one plain scalar).
  const spans = out.map((t) => [t.start, t.end] as const);
  const inSpan = (i: number): boolean => spans.some(([s, e]) => i >= s && i < e);

  // Anchors (&a) and aliases (*a): the NAME after the sigil — graded so the official `&`-split
  // (punctuation.definition.anchor + variable.other.anchor) and Monogram's single `&a` token both
  // land on the name. The sigil sits at a node boundary (line start / whitespace / flow open).
  for (const [re, role] of [
    [/(?<=^|[\s[{,])&[^\s[\]{}",]+/gm, R.anchor],
    [/(?<=^|[\s[{,])\*[^\s[\]{}",]+/gm, R.alias],
  ] as const) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      if (inSpan(m.index)) continue;
      out.push({ start: m.index + 1, end: m.index + m[0].length, text: m[0].slice(1), role });
    }
  }

  // Document markers (--- / ...) — line-start, followed by whitespace or EOL.
  {
    const re = /^(?:---|\.\.\.)(?=[ \t]|$)/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      if (inSpan(m.index)) continue;
      out.push({ start: m.index, end: m.index + 3, text: m[0], role: R.docMarker });
    }
  }

  // Comments: a `#` at line start or after whitespace, to EOL — unless it falls inside a scalar
  // span (a `#` with no preceding space is plain-scalar content, e.g. `a#b`).
  const re = /#[^\n]*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const before = m.index === 0 ? '\n' : text[m.index - 1];
    if (before !== ' ' && before !== '\t' && before !== '\n') continue;
    if (inSpan(m.index)) continue;
    out.push({ start: m.index, end: m.index + m[0].length, text: m[0], role: R.comment });
  }

  // Node tags (!!str / !foo / !<verbatim> / ! non-specific): the sigil + handle/suffix at a node
  // boundary (line start / whitespace / flow open). A `!` inside a scalar span is content, not a tag.
  for (const tm of text.matchAll(/(?<=^|[\s[{,])!(?:<[^>\n]*>|[^\s[\]{},]*)/gm)) {
    if (tm.index === undefined || inSpan(tm.index)) continue;
    out.push({ start: tm.index, end: tm.index + tm[0].length, text: tm[0], role: R.tagType });
  }
  // Directives (%YAML / %TAG / %FOO): the directive NAME after `%`, line-start only (a directive
  // owns its line). A `%`-led line folded into a plain scalar body sits in a span → inSpan skips it.
  for (const dm of text.matchAll(/^%(\w[\w-]*)/gm)) {
    if (dm.index === undefined || inSpan(dm.index)) continue;
    out.push({ start: dm.index + 1, end: dm.index + 1 + dm[1].length, text: dm[1], role: R.directive });
  }
  // Flow punctuation ([ ] { } ,): structural only OUTSIDE a scalar span — a `,` inside a plain scalar
  // is content (`a, b` is one plain scalar), and `[`/`{` cannot start a plain scalar, so a bare one
  // always opens a flow collection. inSpan excludes the in-scalar occurrences.
  for (const fm of text.matchAll(/[[\]{},]/g)) {
    if (fm.index === undefined || inSpan(fm.index)) continue;
    out.push({ start: fm.index, end: fm.index + 1, text: fm[0], role: R.flowPunct });
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}
