/** calc grammar — declarative AST shape (full coverage, unmapped:error). */
import type { ShapeSpec } from './shape-schema.ts';

export const calcShape: ShapeSpec = {
  grammar: 'calc',
  spans: 'optional',
  unmapped: 'error',
  leaves: {
    $punct: { action: 'drop' },
    $keyword: { action: 'drop' },
    Number: { action: 'leafValue', fn: 'number' },
    Ident: { action: 'leafValue', fn: 'ident' },
  },
  rules: {
    Expr: {
      kind: 'pratt',
      atom: { kind: 'keep' },
      group: { kind: 'inline' },
      prefix: {
        kind: 'node',
        type: 'UnaryExpression',
        fields: [
          { name: 'operator', bind: 'opText' },
          { name: 'argument', bind: { at: 0 }, typeHint: 'Expression' },
        ],
      },
      binary: {
        kind: 'node',
        type: 'BinaryExpression',
        fields: [
          { name: 'left', bind: { at: 0 }, typeHint: 'Expression' },
          { name: 'operator', bind: 'opText' },
          { name: 'right', bind: { at: 1 }, typeHint: 'Expression' },
        ],
      },
    },
    Stmt: {
      kind: 'choice',
      arms: [
        {
          name: 'LetStatement',
          altIndices: [0],
          shape: {
            kind: 'node',
            type: 'LetStatement',
            fields: [
              { name: 'id', bind: { at: 0 }, typeHint: 'Identifier' },
              { name: 'init', bind: { at: 1 }, typeHint: 'Expression' },
            ],
          },
        },
        {
          name: 'ExpressionStatement',
          altIndices: [1],
          shape: {
            kind: 'node',
            type: 'ExpressionStatement',
            fields: [
              { name: 'expression', bind: { at: 0 }, typeHint: 'Expression' },
            ],
          },
        },
      ],
    },
    Program: {
      kind: 'node',
      type: 'Program',
      fields: [
        { name: 'body', bind: { from: 'list', of: 0 }, typeHint: 'Statement' },
      ],
    },
  },
};
