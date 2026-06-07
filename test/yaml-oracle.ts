// yaml-oracle.ts — the `yaml` package (eemeli; maintained, spec-compliant) → per-token structural
// ROLE, the neutral answer key for the unified scope-gap harness. YAML has no neutral *highlighting*
// oracle the way TS has tsc, so the closest INDEPENDENT authority is this parser — but the data-model
// AST (`parseAllDocuments`) alone can't see presentation-only tokens (comments, directives, flow
// punctuation, block-scalar boundaries), which is where the johnsoncodehk/monogram#12 bugs live.
//
// So this oracle is a HYBRID over two layers of the SAME independent package:
//   • the low-level CST (`new Parser().parse()`) for PRESENTATION tokens — comment / directive /
//     anchor / alias / tag / flow punctuation / block-scalar (header vs body), each with exact
//     offsets. The CST is error-tolerant (it tokenizes invalid input the AST would reject), so the
//     oracle now grades malformed YAML too — closing the old "valid-only" blind spot.
//   • the AST (`parseAllDocuments`) for the DATA MODEL — scalar value typing (a plain scalar that
//     resolves to a number/bool/null vs a string), mapping-key detection (entity.name.tag), and
//     escapes inside double-quoted scalars.
//
// Why this is the fix for the bench's blind spots: the OLD oracle hand-rolled the presentation layer
// with regexes that reproduced the very bugs (a `,` in a `%TAG` prefix → flow.punct; a `!` inside a
// comment → tag; the `#…` after `%YAML 1.1` → comment), so it BLESSED them. The CST is written by a
// different author than Monogram's grammar, so it cannot share those blind spots — it is the same
// independence property that makes tsc a fair oracle for TS.
import { Parser, parseAllDocuments, isScalar, isMap, isSeq } from 'yaml';
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
  const add = (start: number, end: number, role: RoleName): void => {
    if (end > start) out.push({ start, end, text: text.slice(start, end), role });
  };

  // ── layer 1: CST presentation tokens (independent, error-tolerant) ──────────────────────────
  const visit = (n: any): void => {
    if (!n || typeof n !== 'object') return;
    const ty = n.type, off = n.offset, src = n.source;
    if (typeof ty === 'string' && typeof off === 'number' && typeof src === 'string') {
      switch (ty) {
        case 'comment': add(off, off + src.length, R.comment); break;
        case 'doc-start': case 'doc-end': add(off, off + src.length, R.docMarker); break;   // --- / ...
        // A directive owns its whole line; its interior (name, handle, tag-prefix, version) is NEVER
        // a comment or flow punctuation — grading the full span (see scope-gap.ts) catches a `#…`
        // mis-read as a comment (#8) or a `,` mis-read as a flow separator (#1).
        case 'directive': add(off, off + src.length, R.directive); break;
        case 'anchor': add(off + 1, off + src.length, R.anchor); break;   // name after &
        case 'alias': add(off + 1, off + src.length, R.alias); break;     // name after *
        case 'tag': add(off, off + src.length, R.tagType); break;
        case 'flow-map-start': case 'flow-map-end':
        case 'flow-seq-start': case 'flow-seq-end':
        case 'comma': add(off, off + src.length, R.flowPunct); break;
        case 'block-scalar': {
          // CST quirk: a block-scalar node's `offset` is the header start but its `source` is the
          // BODY only; the header (|/> + chomp/indent) and the header-line newline live in `props`.
          const props: any[] = n.props ?? [];
          const header = props.find((p) => p.type === 'block-scalar-header');
          if (header) add(header.offset, header.offset + header.source.length, R.blockIndicator);
          const last = props[props.length - 1];
          const bodyStart = last ? last.offset + last.source.length : off;
          add(bodyStart, bodyStart + src.length, R.litString);
          break;
        }
        // quoted scalars are typed (key/value) + escape-split by the AST layer below; the CST emits
        // no role for them here, so there is nothing to dedupe against.
      }
    }
    for (const k of Object.keys(n)) { const v = n[k]; if (Array.isArray(v)) v.forEach(visit); else if (v && typeof v === 'object') visit(v); }
  };
  try { for (const t of new Parser().parse(text)) visit(t); } catch { /* CST best-effort */ }

  // ── layer 2: AST data model — scalar value typing, key detection, escapes ───────────────────
  let docs: any[] = [];
  try { docs = parseAllDocuments(text); } catch { docs = []; }
  const walk = (node: any, isKey: boolean): void => {
    if (!node) return;
    if (isScalar(node)) {
      const r = node.range;
      if (!r || r[1] <= r[0]) return;
      // block scalars are owned by the CST layer (header vs body split); skip them here.
      if (node.type === 'BLOCK_LITERAL' || node.type === 'BLOCK_FOLDED') return;
      add(r[0], r[1], isKey ? R.tagName : valueRole(node.value));
      if (node.type === 'QUOTE_DOUBLE') {
        const seg = text.slice(r[0], r[1]);
        ESCAPE.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = ESCAPE.exec(seg))) add(r[0] + m.index, r[0] + m.index + m[0].length, R.escape);
      }
    } else if (isMap(node)) for (const p of node.items) { walk(p.key, true); walk(p.value, false); }
    else if (isSeq(node)) for (const it of node.items) walk(it, false);
  };
  for (const doc of docs) walk(doc?.contents, false);

  // outermost-first at a shared start so the harness's coarse→fine walk sees the widest span first
  out.sort((a, b) => a.start - b.start || b.end - a.end);
  return out;
}
