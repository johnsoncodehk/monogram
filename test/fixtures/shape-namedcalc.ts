// The shape docs/SHAPE.md shows ("Writing a shape with defineShape"): the gate shape2-eval checks
// that the document holds this file verbatim and that it evaluates to the value shown there.
import grammar from './namedcalc.ts';
import { defineShape, child, cook, node, text, typeByText } from 'monogram/shape';

export default defineShape(grammar, {
  name: 'calc-ast',
  total: true,   // every arm of a mapped rule must be mapped: a left-out arm is a load error
  rules: {
    Program: { program: node('Program', { body: child('statement') }) },
    Stmt: {
      letDeclaration: node('Let', { name: text('binding'), init: child('initializer') }),
      expression: node('ExpressionStatement', { expression: child('expression') }),
    },
    Expr: {
      number: node('Num', { value: cook('numberValue', 'number') }),
      name: node('Name', { name: text('ident') }),
      parenthesized: child('expression'),   // pass-through: written, never implied
      binaryOp: node(typeByText('op', { '+': 'Add', '-': 'Sub', '*': 'Mul', '/': 'Div' }), { left: child('left'), right: child('right') }),
      prefixOp: node('Neg', { operand: child('operand') }),
      postfixOp: child('operand'),   // calc has no postfix operator: the arm never occurs
    },
  },
});
