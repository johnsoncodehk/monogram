// The registered highlighter back ends (src/define-highlighter.ts): TextMate, Monarch and
// tree-sitter's highlight queries. `src/cli.ts` writes what each renders. No construct is under
// the shared context IR yet, so none renders from one and none refuses one.
import { defineHighlighter } from './define-highlighter.ts';
import { generateTmLanguage, generateMarkupInjection, generateAliasGrammar, generateContributes } from './gen-tm.ts';
import { generateMonarch, monarchRefusals } from './gen-monarch.ts';
import { generateTreeSitter } from './gen-treesitter.ts';
import type { CstGrammar } from './types.ts';

const json = (v: unknown) => JSON.stringify(v, null, 2) + '\n';

export const textmate = defineHighlighter({
  name: 'textmate',
  engine: 'TextMate (vscode-textmate, Oniguruma)',
  capabilities: {
    lookbehind: 'bounded', regionEnd: 'regex+backref', while: true, recursion: 'unroll', captures: true,
    embed: true, stateStack: true, unicodeClasses: 'always', treeQuery: false,
  },
  render: ({ grammar, name }) => [
    { path: `${name}.tmLanguage.json`, content: json(generateTmLanguage(grammar)) },
    // Markup injections (Vue directives + interpolation): one thin stub per concern, injected onto
    // the host scopes; the rule bodies live in the main grammar's repository.
    ...generateMarkupInjection(grammar).map(inj => ({ path: `${inj.scopeName}.tmLanguage.json`, content: json(inj) })),
    // Alias grammars: the grammar re-exposed under another scopeName.
    ...(grammar.aliasScopes ?? []).map(alias => ({
      path: `${alias.file}.tmLanguage.json`,
      content: json(generateAliasGrammar(grammar.scopeName ?? `source.${name}`, alias.scope)),
    })),
    // The VS Code `contributes` snippet wiring the grammars above, when the grammar declares a manifest.
    ...((c) => c ? [{ path: `${name}.contributes.json`, content: json({ contributes: c }) }] : [])(generateContributes(grammar)),
  ],
  refusals: () => [],
});

export const monarch = defineHighlighter({
  name: 'monarch',
  engine: 'Monaco Monarch (JavaScript RegExp)',
  capabilities: {
    lookbehind: 'none', regionEnd: 'state-pop', while: false, recursion: 'stack', captures: true,
    embed: true, stateStack: true, unicodeClasses: 'u-mode', treeQuery: false,
  },
  render: ({ grammar, name }) => [{ path: `${name}.monarch.json`, content: json(generateMonarch(grammar)) }],
  refusals: ({ grammar }) => monarchRefusals(grammar),
});

// tree-sitter's generator writes the parser (grammar.js, scanner, package files: the tree-sitter
// lane's, written by src/cli.ts) and the highlight queries in one pass: computed once per grammar.
const treeSitterOf = new WeakMap<CstGrammar, ReturnType<typeof generateTreeSitter>>();
export function treeSitterFiles(grammar: CstGrammar, name: string): ReturnType<typeof generateTreeSitter> {
  let ts = treeSitterOf.get(grammar);
  if (!ts) treeSitterOf.set(grammar, ts = generateTreeSitter(grammar, name));
  return ts;
}

export const treeSitterHighlights = defineHighlighter({
  name: 'treesitter-highlights',
  engine: 'tree-sitter queries',
  capabilities: {
    lookbehind: 'tree', regionEnd: 'tree', while: false, recursion: 'tree', captures: true,
    embed: false, stateStack: false, unicodeClasses: 'tree', treeQuery: true,
  },
  render: ({ grammar, name }) => [{ path: `tree-sitter/${name}/queries/highlights.scm`, content: treeSitterFiles(grammar, name).highlightsScm }],
  refusals: () => [],
});
