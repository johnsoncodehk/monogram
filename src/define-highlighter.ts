// `defineHighlighter`: how a highlighter back end registers (docs/HIGHLIGHTERS.md).
//
// A highlighter back end turns ONE grammar into the files an editor engine loads (TextMate's JSON,
// Monarch's tokenizer, tree-sitter's highlight queries). It differs from a parser target
// (`defineParserTarget`, src/define-parser-target.ts): a parser target prints one parser over the shared
// algorithm IR; a highlighter renders what is KNOWN about the grammar's tokens (the facts) into an
// engine that sees only text, line by line, with that engine's own means of context. So a back end
// declares what its engine can express (`capabilities`, never faked), renders from the shared facts
// (src/highlight-facts.ts and src/highlight-roles.ts) and, for the constructs moved into it, from
// the shared context IR (`ir`), and lists every construct it declines (`refusals`), each with its
// reason: a refusal is recorded (the agreement record prints them), never a silent omission.
import type { Grammar } from './types.ts';
import { highlightFacts, type HighlightFacts } from './highlight-facts.ts';
import * as roles from './highlight-roles.ts';

/** What an engine can express: the means a renderer has for context. A back end declares its
 *  engine's, and renders a fact only through one of them. */
export interface HighlighterCapabilities {
  /** Look behind the match: bounded alternatives (Oniguruma), none (Monarch matches at the cursor). */
  lookbehind: 'bounded' | 'none' | 'tree';
  /** How a region ends: a regex with backreferences to its begin, a state pop, the tree's node. */
  regionEnd: 'regex+backref' | 'state-pop' | 'tree';
  /** A region continued while each line matches (TextMate's `while`). */
  while: boolean;
  /** Recursion of a nested construct: unrolled to a fixed depth, a state stack, or the tree. */
  recursion: 'unroll' | 'stack' | 'tree';
  /** Per-capture scopes in one match. */
  captures: boolean;
  /** Embedding another language in a region. */
  embed: boolean;
  /** A stack of states the tokenizer pushes and pops. */
  stateStack: boolean;
  /** Unicode property classes in a pattern: always (Oniguruma), in u-mode only (Monarch: every
   *  regex of the language becomes u-mode), or by the tree's lexer. */
  unicodeClasses: 'always' | 'u-mode' | 'tree';
  /** Queries over a syntax tree (tree-sitter). */
  treeQuery: boolean;
}

/** What a renderer reads: the grammar, its highlight facts (computed once per grammar), the role
 *  and classifier tables. */
export interface HighlighterInput {
  grammar: Grammar;
  /** The grammar's name (the file stem when it declares none). */
  name: string;
  facts: HighlightFacts;
  roles: typeof roles;
}

/** The shared context IR, built only for the constructs moved into it (none yet). */
export interface HighlighterIR {
  readonly constructs: readonly never[];
}

/** A construct a back end declines to render, and why (in terms of its capabilities). */
export interface HighlighterRefusal {
  construct: string;
  reason: string;
}

/** One file a back end writes: its path relative to the grammar's directory, and its content. */
export interface HighlighterFile {
  path: string;
  content: string;
}

export interface HighlighterDefinition {
  name: string;
  /** The engine the files are for (for the docs and the ledger). */
  engine: string;
  capabilities: HighlighterCapabilities;
  render(input: HighlighterInput, ir?: HighlighterIR): HighlighterFile[];
  refusals(input: HighlighterInput): HighlighterRefusal[];
}

const registry = new Map<string, HighlighterDefinition>();

/** Register a highlighter back end; a second one under the same name is refused. */
export function defineHighlighter(def: HighlighterDefinition): HighlighterDefinition {
  if (registry.has(def.name)) throw new Error(`defineHighlighter: a highlighter named ${def.name} is already registered`);
  registry.set(def.name, def);
  return def;
}

/** Every registered back end, in registration order. */
export function registeredHighlighters(): HighlighterDefinition[] {
  return [...registry.values()];
}

/** The input every back end of one grammar reads. */
export function highlighterInput(grammar: Grammar, name: string): HighlighterInput {
  return { grammar, name, facts: highlightFacts(grammar), roles };
}
