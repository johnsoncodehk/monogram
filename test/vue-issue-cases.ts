// vue-issue-cases.ts — REAL highlighting issues reported against vuejs/language-tools'
// vue.tmLanguage.json, as DATA (no side effects on import). Single source shared by
// test/vue-issues.ts (the snapshot-gated bench) and test/issue-table.ts (the README
// cross-language ✓ table). Each id is the tracker #issue. See vue-issues.ts for the
// fetch/triage and the harness.

export const familyOf = (s: string): string =>
  s.includes('source.ts') ? 'ts' : s.includes('source.js') ? 'js'
    : s.includes('source.css') ? 'css' : s.includes('text.html') ? 'html' : 'other';
export const embedded = (s: string) => s.includes('source.ts') || s.includes('source.js');
export const htmlText = (s: string) => familyOf(s) === 'html';   // recovered to HTML (didn't leak into the embed)
export const DONE = '\n  <b>DONE</b>\n</template>';              // downstream marker — must recover to HTML

export interface Check { at: string; nth?: number; want: (s: string) => boolean; desc: string }
// `monoGap`: an honest REPORTED bug the DERIVED grammar does NOT solve yet (only-official, or
// both-miss). It still appears in the cross-language README table (graded honestly by
// issue-table.ts), but the Monogram-self-test gates (vue-issues.ts / vue-dropin.ts) skip it —
// they assert Monogram's known-good behaviour, not the full honest comparison corpus.
export interface Case { id: string; title: string; src: string; checks: Check[]; monoGap?: boolean }

export const cases: Case[] = [
  // ── TS operators inside template expressions — Monogram embeds proven TS, gets these free ──
  { id: '#3400', title: '`instanceof` in {{ }}', src: `<template>\n  <div>{{ err instanceof Error }}</div>${DONE}`,
    checks: [{ at: 'instanceof', want: embedded, desc: 'instanceof embeds as TS' }, { at: 'DONE', want: htmlText, desc: 'downstream recovers to HTML' }] },
  { id: '#5370', title: '`typeof x !==` in v-if', src: `<template>\n  <p v-if="typeof x !== 'number'">a</p>${DONE}`,
    checks: [{ at: 'typeof', want: embedded, desc: 'typeof embeds as TS' }, { at: 'DONE', want: htmlText, desc: 'downstream recovers' }] },
  { id: '#5118', title: '`?.` / `??` in {{ }}', src: `<template>\n  <div>{{ a?.b ?? c }}</div>${DONE}`,
    checks: [{ at: '??', want: embedded, desc: 'nullish embeds as TS' }, { at: 'DONE', want: htmlText, desc: 'downstream recovers' }] },
  { id: '#1675', title: 'arrow `=>` in {{ }}', src: `<template>\n  <div>{{ items.map(i => i.id) }}</div>${DONE}`,
    checks: [{ at: '=>', want: embedded, desc: 'arrow embeds as TS' }, { at: 'DONE', want: htmlText, desc: 'downstream recovers' }] },
  { id: '#6039/#4741', title: '`<` operator in {{ }} (not a tag!)', src: `<template>\n  <div>{{ a < b }}</div>${DONE}`,
    checks: [{ at: 'DONE', want: htmlText, desc: 'the `<` is not mistaken for a tag — downstream recovers' }] },
  { id: '#5722', title: 'negated ternary + quotes in {{ }}', src: `<template>\n  <div>{{ !ok ? 'yes' : 'no' }}</div>${DONE}`,
    checks: [{ at: 'DONE', want: htmlText, desc: 'downstream recovers' }] },
  // ── `as` type assertion (the #5012 intra-line ceiling family) ──
  { id: '#6007/#2096/#520', title: '`as` type assertion in directive value', src: `<template>\n  <Foo :schema="x as JSONSchema" />${DONE}`,
    checks: [{ at: 'as', want: embedded, desc: '`as` embeds as TS' }, { at: 'DONE', want: htmlText, desc: 'downstream recovers (begin/while bounds it)' }] },
  // ── script / boundary family ──
  { id: '#5538/#2060', title: 'trailing `export type` before `</script>`', src: `<script lang="ts">\nexport type T = number\n</script>\n<template>\n  <p>hi</p>${DONE}`,
    checks: [{ at: 'hi', want: htmlText, desc: '</script> ends the embed — template is HTML' }, { at: 'DONE', want: htmlText, desc: 'downstream recovers' }] },
  { id: '#3999', title: 'multi-line `<script>` start tag doesn\'t break the code after it', src: `<script\n  lang="ts"\n>\nconst x = 1\n</script>`,
    checks: [{ at: 'const', want: embedded, desc: 'body still embeds as TS across the multi-line tag' }] },
  // ── tag / interpolation edge cases ──
  { id: '#4769', title: 'tag name starting with `template`', src: `<template>\n  <templatex>{{ y }}</templatex>${DONE}`,
    checks: [{ at: 'y', want: embedded, desc: 'interpolation inside a template-prefixed tag works' }, { at: 'DONE', want: htmlText, desc: 'downstream recovers' }] },
  { id: '#5701', title: '`{{` inside a `<script>` string', src: `<script>\nconst s = "{{ not interp }}"\n</script>\n<template>\n  <p>{{ real }}</p>${DONE}`,
    checks: [{ at: 'real', want: embedded, desc: 'the real interpolation still embeds as TS' }, { at: 'DONE', want: htmlText, desc: 'downstream recovers' }] },
  { id: '#6070', title: 'capitalized component then a `<style>` block', src: `<template>\n  <MyComp @click="f">x</MyComp>\n</template>\n<style>\n.a { color: red }\n</style>`,
    checks: [{ at: 'color', want: s => familyOf(s) === 'css', desc: '<style> after a capitalized tag still embeds as CSS' }] },

  // ── more of the `as`-cast leak family (the #5012 intra-line ceiling) — Monogram wins ──
  { id: '#5660', title: '`as const` cast in a v-for value', src: `<template>\n  <div v-for="i in [0,1,2] as const">{{ i }}</div>${DONE}`,
    checks: [{ at: 'as', want: embedded, desc: '`as const` embeds as TS' },
      { at: '{{', want: htmlText, desc: 'the interpolation opener is HTML — the cast did NOT leak past the closing quote' },
      { at: 'DONE', want: htmlText, desc: 'downstream recovers to HTML (the official\'s cast context leaks all the way to EOF)' }] },
  { id: '#4716/#5571', title: '`as` cast followed by another attribute', src: `<template>\n  <some-comp :value="foo as boolean" :other="bar" />${DONE}`,
    checks: [{ at: 'as', want: embedded, desc: '`as` embeds as TS' },
      { at: 'bar', want: embedded, desc: 'the NEXT directive value still embeds as TS — the cast can\'t eat the closing quote (the official mis-scopes `bar` as a plain attribute name)' },
      { at: 'DONE', want: htmlText, desc: 'downstream recovers' }] },
  // ── block-language attribute — Monogram embeds tsx as code, the official drops the embed ──
  { id: '#4291', title: '`<script lang="tsx">` body is embedded code', src: `<script setup lang="tsx">\nconst n = 1\n</script>\n<template>\n  <p>x</p>${DONE}`,
    checks: [{ at: 'n = 1', want: embedded, desc: 'the tsx script body embeds as code (the official leaves the whole body as plain HTML text)' },
      { at: 'DONE', want: htmlText, desc: 'downstream recovers' }] },

  // ── dynamic directive args + `.prop` shorthand — Monogram now splits the bracketed arg and
  //    embeds its expression (the official's arg shape, config-driven); both pass ──
  { id: '#4410', title: 'dynamic directive argument `:[attr]`', src: `<template>\n  <a :[attr]="url">x</a>${DONE}`,
    checks: [{ at: 'attr', want: embedded, desc: 'the `[attr]` dynamic argument is itself a JS expression — embeds as TS (the `[`/`]` are punctuation, the inner re-tokenizes as source.ts)' },
      { at: 'url', want: embedded, desc: 'the value embeds as TS' }, { at: 'DONE', want: htmlText, desc: 'downstream recovers' }] },
  { id: '#3727', title: '`.prop` modifier shorthand', src: `<template>\n  <my-comp .prop="value" />${DONE}`,
    checks: [{ at: 'value', want: embedded, desc: '`.prop` is `v-bind:prop.prop` shorthand — `.` is a bind shorthand, so its value embeds as TS' },
      { at: 'DONE', want: htmlText, desc: 'downstream recovers' }] },
  { id: '#2666', title: 'dynamic slot name from a template literal', src: '<template>\n  <Comp v-slot:[`item-${idx}`]="props">{{ props }}</Comp>' + DONE,
    checks: [{ at: 'idx', want: embedded, desc: 'the `${idx}` inside the template-literal slot name embeds as TS — the dynamic `[…]` arg is re-tokenized as an expression' },
      { at: 'props }}', want: embedded, desc: 'the slot-props value embeds as TS' }, { at: 'DONE', want: htmlText, desc: 'downstream recovers' }] },

  // ── v-for loop var named after a TS keyword — the old `type`-in-v-for trap; both handle it now ──
  { id: '#2560/#1290', title: '`type` as a v-for loop variable', src: `<template>\n  <div v-for="type in items">{{ type }}</div>${DONE}`,
    checks: [{ at: 'type }}', want: embedded, desc: 'the loop variable named `type` embeds as TS — no keyword-trap break' },
      { at: 'DONE', want: htmlText, desc: 'downstream recovers' }] },
];
