/**
 * Consumer-facing declarative AST shape schema and normalized codegen IR.
 */

export type FieldBind =
  | { at: number }
  | { label: string }
  | { from: 'list'; of: number | 'rest' }
  | { from: 'opt'; at: number }
  | 'opText';

export type FieldDecl = {
  name: string;
  bind: FieldBind;
  optional?: boolean;
  typeHint?: string | string[];
};

export type NodeShape = {
  kind: 'node';
  type: string;
  fields: FieldDecl[];
  exact?: boolean;
};

export type ListShape = { kind: 'list'; field: string; elemHint?: string };
export type InlineShape = { kind: 'inline' };
export type DropShape = { kind: 'drop' };
export type LeafValueShape = {
  kind: 'leafValue';
  fn: 'identity' | 'number' | 'bigint' | 'string' | 'boolean' | 'ident' | (string & {});
};
/**
 * Generic child-partial fold. A partial-producing custom returns
 * `{ __shapePartial: tag, mode: 'start'|'append', value }`. At parent finish,
 * matching groups are folded before the parent's custom callback runs:
 * `start` opens an output item and `append` pushes into that item's `into`
 * array. No grammar/rule name is embedded in the mechanism.
 */
export type ParentFold = { tag: string; into: string };
export type CustomShape = {
  kind: 'custom';
  fn: string;
  reason: string;
  result?: 'value' | 'partial';
  folds?: ParentFold[];
};
export type KeepShape = { kind: 'keep' };
/** Delegate Pratt atom NUD to an RD rule (e.g. Atom choice → Number|Identifier nodes). */
export type RuleRefShape = { kind: 'rule'; name: string };

export type ChoiceArm = {
  name: string;
  altIndices: number[];
  shape: Exclude<RuleShape, ChoiceShape>;
};
export type ChoiceShape = { kind: 'choice'; arms: ChoiceArm[] };

export type PrattShape = {
  kind: 'pratt';
  atom?: LeafValueShape | KeepShape | DropShape | CustomShape | RuleRefShape;
  /** Unmapped IR brackets default to keep (positional node). */
  group?: InlineShape | NodeShape | CustomShape | KeepShape;
  nudSeq?: RuleShapeAtom;
  nudCapped?: RuleShapeAtom;
  prefix?: NodeShape | CustomShape | InlineShape | KeepShape;
  binary?: NodeShape | CustomShape | KeepShape;
  postfix?: NodeShape | CustomShape | KeepShape | InlineShape;
  led?: RuleShapeAtom;
  postfixTok?: RuleShapeAtom;
  /**
   * Template literal product (subst `$templateHead`… or no-subst Template leaf).
   * Not a new primitive — only custom|keep. Omitted → legacy `$template` keep with
   * portable interpRule holes (CST-parity accept set). Declared → kids are
   * head, expr, optional middle/expr pairs, then tail (or `[leaf]` for no-subst)
   * finished by this slot; hole accept still uses portable interpRule, hole AST
   * uses enclosing Pratt.
   */
  template?: CustomShape | KeepShape;
};

export type RuleShapeAtom =
  | NodeShape | ListShape | InlineShape | DropShape
  | LeafValueShape | CustomShape | KeepShape | PrattShape;
export type RuleShape = RuleShapeAtom | ChoiceShape;

export type TokenLeafPolicy =
  | { action: 'drop' }
  | { action: 'keep' }
  | { action: 'leafValue'; fn: LeafValueShape['fn'] };

export type ShapeSpec = {
  grammar: string;
  spans: 'required' | 'optional' | 'none';
  unmapped: 'default' | 'error';
  leaves: Record<string, TokenLeafPolicy>;
  rules: Record<string, RuleShape>;
};

export type ShapeIRRule = {
  name: string;
  cstName: string;
  kind: 'rd' | 'pratt';
  source: 'exact' | 'cstName' | 'default';
  shape: RuleShape;
};
export type ShapeIR = {
  grammar: string;
  spans: ShapeSpec['spans'];
  leaves: ShapeSpec['leaves'];
  rules: ShapeIRRule[];
  diagnostics: ShapeDiag[];
};
export type ShapeDiag = {
  level: 'error' | 'warn' | 'info';
  rule?: string;
  code: string;
  message: string;
};

export const ADDED_PRIMITIVES: { name: string; reason: string }[] = [
  { name: 'choice', reason: 'RD heterogeneous alternatives need exhaustive product selection.' },
  { name: 'pratt', reason: 'Pratt classes have distinct atom, prefix, binary, and mixfix products.' },
  { name: 'keep', reason: 'Sugar for the adjudicated default positional node.' },
  { name: 'bindOp', reason: 'Dropped Pratt operators must expose their source text.' },
  { name: 'parentFold', reason: 'Explicitly declared child partials may accumulate into a parent field.' },
];

export const ADJUDICATIONS = {
  spans: 'Use unified off/end fields with required, optional, or none injection.',
  unmapped: 'Unmapped rules default to keep; unmapped:error enables strict coverage.',
  altHeterogeneous: 'Choice arms partition every RD alternative exactly once.',
  ruleKeying: 'Exact IR rule names override inherited cstName mappings.',
} as const;

/** Emit-time static coverage of Shape AST step/pratt rendering. */
export type ShapeStepKind =
  | 'lit' | 'tok' | 'rule' | 'ruleBp' | 'star' | 'opt' | 'sep'
  | 'altlit' | 'alt' | 'not' | 'seq' | 'sameLine' | 'suppress';
export type ShapePrattKind =
  | 'atom' | 'group' | 'prefix' | 'binary' | 'postfix' | 'postfixTok'
  | 'led' | 'nudSeq' | 'nudCapped' | 'template';
export type ShapeUnsupported = { rule: string; construct: string };
export type ShapeCoverage = {
  step: Record<ShapeStepKind, number>;
  pratt: Record<ShapePrattKind, number>;
  unsupported: ShapeUnsupported[];
};

export const SHAPE_STEP_KINDS: readonly ShapeStepKind[] = [
  'lit', 'tok', 'rule', 'ruleBp', 'star', 'opt', 'sep',
  'altlit', 'alt', 'not', 'seq', 'sameLine', 'suppress',
] as const;
export const SHAPE_PRATT_KINDS: readonly ShapePrattKind[] = [
  'atom', 'group', 'prefix', 'binary', 'postfix', 'postfixTok',
  'led', 'nudSeq', 'nudCapped', 'template',
] as const;
