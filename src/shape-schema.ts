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
export type CustomShape = { kind: 'custom'; fn: string; reason: string };
export type KeepShape = { kind: 'keep' };

export type ChoiceArm = {
  name: string;
  altIndices: number[];
  shape: Exclude<RuleShape, ChoiceShape>;
};
export type ChoiceShape = { kind: 'choice'; arms: ChoiceArm[] };

export type PrattShape = {
  kind: 'pratt';
  atom?: LeafValueShape | KeepShape | DropShape | CustomShape;
  group?: InlineShape | NodeShape | CustomShape;
  nudSeq?: RuleShapeAtom;
  nudCapped?: RuleShapeAtom;
  prefix?: NodeShape | CustomShape | InlineShape;
  binary?: NodeShape | CustomShape;
  postfix?: NodeShape | CustomShape;
  led?: RuleShapeAtom | CustomShape;
  postfixTok?: RuleShapeAtom;
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
  | 'led' | 'nudSeq' | 'nudCapped';
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
  'led', 'nudSeq', 'nudCapped',
] as const;
