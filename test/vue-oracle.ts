// ─────────────────────────────────────────────────────────────────────────────
//  vue-oracle.ts — a NEUTRAL, parser-derived per-token ROLE oracle for a Vue SFC,
//  the answer key for the unified scope-gap harness (scope-gap.ts) applied to Vue.
//
//  A Vue SFC has NO single parser. We compose the maintained, authoritative parsers
//  the rest of the bench already trusts, splitting the file into its embedded
//  languages and running each block's parser offset-shifted into the SFC:
//
//    • block split           — @vue/compiler-sfc (descriptor + byte offsets)
//    • <template> markup      — parse5 (html-oracle.ts) → tag names + PLAIN attr names
//    • <script[ setup]>       — tsc (oracle.ts) → the full TS/JS token-role set
//    • {{ expr }} / dir vals  — tsc over the expression text, offset-shifted (optional;
//                               gated by SFC parse success — see `interpolations`)
//
//  COVERAGE (honest, bounded — this is a first version):
//    GRADED: template tag names (R.tagName), PLAIN HTML attribute names (R.attrName),
//      every <script> body token at full TS/JS fidelity (all of oracle.ts's roles),
//      and {{…}} / directive-value EXPRESSION tokens as TS (also full fidelity).
//    SKIPPED, by design:
//      • Vue DIRECTIVE names (`v-if`, `:href`, `@click`, `#slot`). parse5 sees them as
//        attributes, but BOTH grammars (correctly) paint the directive prefix as a
//        keyword / shorthand-punctuation `*.vue` scope, NOT `entity.other.attribute-name`.
//        Grading them as R.attrName would mark BOTH grammars wrong on a token they
//        actually render correctly — a false penalty — and the frozen role table has no
//        "directive" role (we are told NOT to add one). So directive NAMES are excluded
//        from the answer key; their VALUES (TS expressions) ARE graded. See REPORT.
//      • <style> / CSS bodies — no role table for CSS in scope-roles.ts (would need new
//        roles). Skipped; reported.
//      • the `<template lang="pug">` / `lang="md">` dialects — out of scope.
//
//  REUSE: html-oracle.ts (parse5→roles) for the template, oracle.ts (tsc→roles) for the
//  script + expressions, scope-roles.ts (R.*) for the role names. NOTHING new is added
//  to scope-roles.ts. Shared by test/scope-gap-vue.ts.
// ─────────────────────────────────────────────────────────────────────────────
import sfcCompiler from '@vue/compiler-sfc';
import * as dom from '@vue/compiler-dom';
import ts from 'typescript';
import { parseFragment } from 'parse5';
import { R } from './scope-roles.ts';
import { oracle as tsOracle } from './oracle.ts';
import type { GoldToken } from './scope-gap.ts';

// A Vue directive shorthand or `v-`-prefixed attribute name. parse5 reports these as plain
// attributes, but they are NOT `entity.other.attribute-name` to a highlighter (they render as
// keyword / shorthand punctuation), so we DON'T grade their NAME as R.attrName. (Their value
// expression is graded as TS separately, via @vue/compiler-dom.)
const isDirectiveName = (name: string): boolean =>
  name.startsWith('v-') || name.startsWith(':') || name.startsWith('@') ||
  name.startsWith('#') || name.startsWith('.');

// ── template markup → roles (parse5), offset-shifted into the SFC ──────────────
// Mirrors html-oracle.ts's tag/attr emission, but: (a) shifts every offset by `base`
// (the template body's start in the SFC), and (b) emits R.attrName ONLY for PLAIN
// attributes (directives handled above). Attribute VALUES are left to the expression
// pass / lexical floor (a directive value is TS; a plain attr value is just a string the
// HTML embed already gets — we don't double-grade markup string values here).
function templateRoles(content: string, base: number): GoldToken[] {
  const out: GoldToken[] = [];
  let doc: any;
  try { doc = parseFragment(content, { sourceCodeLocationInfo: true }); } catch { return out; }
  const visit = (node: any): void => {
    const loc = node.sourceCodeLocation;
    if (node.nodeName === '#comment' && loc) {
      out.push({ start: base + loc.startOffset, end: base + loc.endOffset, text: content.slice(loc.startOffset, loc.endOffset), role: R.comment });
    } else if (node.tagName && loc) {
      if (loc.startTag) {
        const tn = loc.startTag.startOffset + 1;                       // after '<'
        out.push({ start: base + tn, end: base + tn + node.tagName.length, text: node.tagName, role: R.tagName });
        const attrLocs = loc.startTag.attrs ?? {};
        for (const attr of node.attrs ?? []) {
          if (isDirectiveName(attr.name)) continue;                    // directive → not R.attrName (see note)
          const al = attrLocs[attr.name] ?? attrLocs[attr.name.toLowerCase()];
          if (!al) continue;
          out.push({ start: base + al.startOffset, end: base + al.startOffset + attr.name.length, text: attr.name, role: R.attrName });
        }
      }
      if (loc.endTag) {
        const tn = loc.endTag.startOffset + 2;                         // after '</'
        out.push({ start: base + tn, end: base + tn + node.tagName.length, text: node.tagName, role: R.tagName });
      }
    }
    for (const c of node.childNodes ?? []) visit(c);
  };
  for (const c of doc.childNodes ?? []) visit(c);
  return out;
}

// ── a TS/JS expression or block → roles (tsc), offset-shifted ──────────────────
// `text` is the expression/script body; every emitted token offset is shifted by `base`,
// the body's start offset in the SFC. Used for <script> bodies AND for {{…}} / directive
// expressions (which the grammars embed as source.ts).
function tsRoles(text: string, base: number, kind: ts.ScriptKind): GoldToken[] {
  let toks;
  try { toks = tsOracle(text, kind); } catch { return []; }
  return toks.map((t) => ({ start: base + t.start, end: base + t.end, text: t.text, role: t.role }));
}

const scriptKind = (lang?: string): ts.ScriptKind =>
  lang === 'ts' || lang === 'tsx' ? ts.ScriptKind.TS
  : lang === 'jsx' ? ts.ScriptKind.JSX
  : ts.ScriptKind.JS;

export interface VueOracleOptions {
  // Grade {{…}} interpolations and directive VALUES as TS expressions (default true).
  // These rely on @vue/compiler-dom parsing the template; if it throws (an intentionally
  // over-permissive showcase, e.g. `{{ const z = 1 }}`), expressions are silently skipped.
  interpolations?: boolean;
}

/**
 * vueOracle — a Vue SFC → neutral per-token roles, by composing the maintained parsers
 * (@vue/compiler-sfc for the split, parse5 for the template, tsc for code). See file header.
 */
export function vueOracle(sfc: string, opts: VueOracleOptions = {}): GoldToken[] {
  const withExpr = opts.interpolations ?? true;
  const out: GoldToken[] = [];
  let descriptor: any;
  try { descriptor = sfcCompiler.parse(sfc).descriptor; } catch { return out; }

  // <template> → parse5 over the body, offset-shifted.
  const tmpl = descriptor.template;
  if (tmpl && tmpl.loc.end.offset > tmpl.loc.start.offset) {
    out.push(...templateRoles(tmpl.content, tmpl.loc.start.offset));
  }

  // <script> + <script setup> → tsc over each body, offset-shifted.
  for (const block of [descriptor.script, descriptor.scriptSetup]) {
    if (!block || block.loc.end.offset <= block.loc.start.offset) continue;
    out.push(...tsRoles(block.content, block.loc.start.offset, scriptKind(block.lang)));
  }

  // {{ expr }} interpolations + directive VALUES → tsc over the expression text. These are
  // embedded as source.ts by BOTH grammars, so a TS-fidelity answer key is fair. The offsets
  // come from @vue/compiler-dom's AST (loc.start.offset is relative to the template body).
  if (withExpr && tmpl) {
    const base = tmpl.loc.start.offset;
    try {
      const walk = (n: any): void => {
        if (n.type === 5 && n.content?.loc) {        // interpolation node {{ … }}
          const e = n.content.loc;
          out.push(...tsRoles(e.source, base + e.start.offset, ts.ScriptKind.TS));
        }
        if (n.type === 1) for (const p of n.props ?? []) {   // element → directives
          if (p.type === 7 && p.exp?.loc) {          // directive with an expression value
            const e = p.exp.loc;
            out.push(...tsRoles(e.source, base + e.start.offset, ts.ScriptKind.TS));
          }
        }
        for (const c of n.children ?? []) walk(c);
      };
      walk(dom.parse(tmpl.content));
    } catch { /* over-permissive / invalid template expression — expressions skipped */ }
  }

  // de-dup (a directive value can be reached via both the parse5 attr pass — skipped there —
  // and the compiler-dom expr pass) and sort by start, like the other oracles.
  const seen = new Set<string>();
  const dedup = out.filter((t) => {
    const k = `${t.start}:${t.end}:${t.role}`;
    if (seen.has(k)) return false; seen.add(k); return true;
  });
  dedup.sort((a, b) => a.start - b.start || a.end - b.end);
  return dedup;
}
