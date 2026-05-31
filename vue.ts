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
import html from './html.ts';

const vue = {
  ...html,
  name: 'vue',
  scopeName: 'text.html.vue',
  markup: {
    ...html.markup!,
    rawText: {
      tags: ['template', 'script', 'style'],
      token: 'RawText',
      embed: {
        template: 'text.html.basic',   // Monogram's own HTML grammar
        script: 'source.js',           // Monogram's own JS/TS grammar (source.ts when lang="ts" — next step)
        style: 'source.css',           // delegated CSS (the official grammar embeds source.css too)
      },
    },
  },
};

export default vue;
