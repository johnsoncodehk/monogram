// html-oracle.ts — parse5 → per-token structural ROLE (the neutral HTML answer key for the
// unified scope-gap harness). parse5 is the authoritative, maintained HTML parser; the official
// VS Code HTML grammar is the UNMAINTAINED textmate/html.tmbundle (vscode#203212), so parse5 is
// the arbiter. Emits the roles a highlighter must get right: tag names, attribute names,
// attribute values (strings), and comments. Punctuation/text are left to the lexical floor.
import { parseFragment } from 'parse5';
import { R } from './scope-roles.ts';
import type { GoldToken } from './scope-gap.ts';

export function htmlOracle(html: string): GoldToken[] {
  const out: GoldToken[] = [];
  let doc: any;
  try { doc = parseFragment(html, { sourceCodeLocationInfo: true }); } catch { return out; }

  const visit = (node: any): void => {
    const loc = node.sourceCodeLocation;
    if (node.nodeName === '#comment' && loc) {
      out.push({ start: loc.startOffset, end: loc.endOffset, text: html.slice(loc.startOffset, loc.endOffset), role: R.comment });
    } else if (node.tagName && loc) {
      if (loc.startTag) {
        const tn = loc.startTag.startOffset + 1;                       // after '<'
        out.push({ start: tn, end: tn + node.tagName.length, text: node.tagName, role: R.tagName });
        const attrLocs = loc.startTag.attrs ?? {};
        for (const attr of node.attrs ?? []) {
          const al = attrLocs[attr.name] ?? attrLocs[attr.name.toLowerCase()];
          if (!al) continue;
          out.push({ start: al.startOffset, end: al.startOffset + attr.name.length, text: attr.name, role: R.attrName });
          const seg = html.slice(al.startOffset, al.endOffset);
          const eq = seg.indexOf('=');
          if (eq >= 0) {                                                // has a value → string (quoted or not)
            let v = al.startOffset + eq + 1;
            while (v < al.endOffset && /\s/.test(html[v])) v++;
            if (v < al.endOffset) out.push({ start: v, end: al.endOffset, text: html.slice(v, al.endOffset), role: R.litString });
          }
        }
      }
      if (loc.endTag) {
        const tn = loc.endTag.startOffset + 2;                         // after '</'
        out.push({ start: tn, end: tn + node.tagName.length, text: node.tagName, role: R.tagName });
      }
    }
    for (const c of node.childNodes ?? []) visit(c);
  };
  for (const c of doc.childNodes ?? []) visit(c);
  out.sort((a, b) => a.start - b.start);
  return out;
}
