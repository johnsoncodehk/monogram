/**
 * Target-neutral data contracts for generated shape recognizers.
 *
 * This module deliberately contains no target runtime. TS, Rust, and Go emitters
 * can share these identities and transaction rules without sharing codegen.
 */

/** Identity path through RD alternatives, nested inline alternatives, and Pratt events. */
export type AltPathPart =
  | { kind: 'rd'; rule: string; alt: number }
  | { kind: 'inline-alt'; branch: number }
  | { kind: 'pratt-nud'; event: 'atom' | 'group' | 'prefix' | 'nudSeq' | 'nudCapped'; index: number }
  | { kind: 'pratt-led'; event: 'binary' | 'postfix' | 'postfixTok' | 'led'; index: number };
export type AltPath = readonly AltPathPart[];

/** A visible value channel. Optional holes retain position instead of disappearing. */
export type VisibleSlot<H = unknown> =
  | { kind: 'slot'; value: H }
  | { kind: 'list'; values: H[] }
  | { kind: 'hole'; value: H | null };

export type PrattEvent<H = unknown> =
  | { kind: 'atom'; value: H }
  | { kind: 'group'; value: H }
  | { kind: 'prefix'; operator: string; argument: H }
  | { kind: 'binary'; left: H; operator: string; right: H }
  | { kind: 'postfix'; left: H; operator: string }
  | { kind: 'postfixTok'; left: H; token: H }
  | { kind: 'led'; left: H; slots: readonly VisibleSlot<H>[] }
  | { kind: 'nudSeq'; slots: readonly VisibleSlot<H>[] }
  | { kind: 'nudCapped'; slots: readonly VisibleSlot<H>[] };

/** Length snapshots are valid only for append-only channels. */
export type AppendOnlyCheckpoint = {
  pos: number;
  kidsLength: number;
  listsLength: number;
  holesLength: number;
  altPathLength: number;
};

/** Prior value for a slot overwritten during a speculative transaction. */
export type UndoEntry<H = unknown> = {
  channel: 'slot' | 'state';
  index: number;
  previous: H;
};

export type ShapeTransaction<H = unknown> = {
  checkpoint: AppendOnlyCheckpoint;
  undo: UndoEntry<H>[];
  status: 'open' | 'committed' | 'rolledBack';
};

/**
 * Transaction contract:
 * - append-only arrays roll back by restoring their checkpointed lengths;
 * - overwrites must be recorded in `undo`, or staged and applied only on commit;
 * - parser position and every mutable Pratt/control flag (`_suppressNext` /
 *   `_suppressCur` / capped) join the same transaction;
 * - function-local `left`/`opText` values need no log when assigned only after success.
 */
export const SHAPE_TRANSACTION_CONTRACT = {
  appendOnly: 'restore-lengths',
  overwrite: 'undo-log-or-commit-on-success',
  prattLocals: 'commit-on-success',
  controlFlags: 'restore-with-checkpoint',
} as const;

/** Local custom context (SH2-0/SH2-2). Full AltPathPart form is deferred to SH2-3. */
export type AstCustomCtx = {
  kids: readonly unknown[];
  altPath: readonly number[];
  src: string;
  off: number;
  end: number;
  left?: unknown;
  opText?: string;
};
export type AstCustom = (ctx: AstCustomCtx) => unknown;
