// Vue Single-File Components — a markup language built by REUSING html.ts. A .vue file
// is a set of top-level blocks (<template>, <script>, <style>, custom) whose bodies embed
// a sub-language. That is exactly HTML's raw-text-element mechanism, with a per-block
// `embed` map: <template> embeds Monogram's OWN HTML grammar, <script> embeds Monogram's
// OWN proven JS/TS grammar (the headline — more correct than VS Code's TS), <style>
// embeds CSS (delegated, like the official grammar does). The tokens + rules are html.ts's;
// only the markup config (block tags + embeds) and the scope name differ.
//
// Increment 1: the SFC block skeleton + block-level embeds. Vue template directives
// (v-if / :bind / @event / #slot) and {{ }} interpolation are the next increment.
// Oracle: vuejs/language-tools' hand-written vue.tmLanguage.json (scopeName text.html.vue).
//
// Vue is a DIALECT of html.ts: it reuses html's tokens/rules/scopes verbatim (a .vue file
// is HTML's raw-text mechanism with a per-block embed map) and only swaps the markup config
// + scope name. We import those reusable pieces and build through `defineGrammar` — the same
// API every other grammar uses — instead of spreading html's already-built grammar object.
import { defineGrammar } from './src/api.ts';
import { tokens, rules, scopes, markup as htmlMarkup } from './html.ts';

export default defineGrammar({
  name: 'vue',
  scopeName: 'text.html.vue',
  tokens,
  rules,
  entry: rules.Document,
  scopes,
  markup: {
    ...htmlMarkup,
    rawText: {
      tags: ['template', 'script', 'style'],
      token: 'RawText',
      embed: {
        template: 'text.html.basic',   // Monogram's own HTML grammar
        // <script lang="ts"> embeds Monogram's OWN proven TS grammar (more correct than VS Code's).
        script: { default: 'source.js', lang: { ts: 'source.ts', tsx: 'source.tsx', jsx: 'source.js.jsx' } },
        style: { default: 'source.css', lang: { scss: 'source.css.scss', less: 'source.css.less', stylus: 'source.stylus', postcss: 'source.postcss' } },
      },
    },
    // Directives + {{ }} interpolation, INJECTED onto the embedded HTML's scopes (Vue
    // syntax can't be baked into the reused HTML grammar — it injects on top). Values and
    // interpolation embed Monogram's OWN TS grammar (source.ts). Scopes match the official.
    inject: {
      into: ['text.html.basic'],
      exprEmbed: 'source.ts.embedded.html.vue',
      // `{{ }}` and directive values are EXPRESSIONS, not programs — embed the derived
      // expression-only sub-grammar so `{{ const x }}`/`{{ for(…) }}` don't mis-highlight
      // statement keywords (a nested block still re-enters the full grammar via $self).
      exprInclude: 'source.ts#expression',
      interpolation: {
        open: '{{', close: '}}',
        beginScope: 'punctuation.definition.interpolation.begin.html.vue',
        endScope: 'punctuation.definition.interpolation.end.html.vue',
      },
      directives: {
        control: [
          { match: 'v-for', scope: 'keyword.control.loop.vue' },
          { match: 'v-if|v-else-if|v-else', scope: 'keyword.control.conditional.vue' },
        ],
        shorthand: [
          { char: ':', scope: 'punctuation.attribute-shorthand.bind.html.vue' },
          { char: '@', scope: 'punctuation.attribute-shorthand.event.html.vue' },
          { char: '#', scope: 'punctuation.attribute-shorthand.slot.html.vue' },
        ],
        prefix: 'v-',
        nameScope: 'entity.other.attribute-name.html.vue',
        eqScope: 'punctuation.separator.key-value.html.vue',
        // The quotes around a directive value — string punctuation, matching the official.
        valueString: { begin: 'punctuation.definition.string.begin.html.vue', end: 'punctuation.definition.string.end.html.vue' },
      },
    },
  },
});
