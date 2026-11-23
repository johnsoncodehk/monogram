// The public entry for writing a SHAPE: the map from a grammar's CST to your AST (docs/SHAPE.md,
// "Writing a shape with defineShape"). A shape is plain data in a closed calculus (the term
// constructors below; src/shape2-schema.ts defines them), checked against its grammar once, by
// `defineShape`. Today a shape is EVALUATED over the interpreter's CST (`evaluateShape`); emitted
// parsers that build the AST directly are not there yet.
//
// Its own entry, not src/api.ts: the term constructors (`not`, `list`, `map`, ...) are a second
// vocabulary beside the grammar combinators, and `not` is in both.
export { defineShape, evaluateShape, ShapeSpecError, ShapeUnmapped, type Shape, type ShapeNode, type ShapeValue } from './shape2-eval.ts';
export { shapeCoverage, type ArmCoverage, type ShapeCoverage } from './shape-coverage.ts';
export {
  absent, and, armOf, branch, c, child, cook, dropLastIf, fold, get, iff, inh, let_, list, map, match, node, not, or, orElse,
  present, record, spread, syn, text, thread, typeByText, v, wrapIf,
  type CookFn, type InhAttr, type Scalar, type ShapeSpec, type Span, type SynAttr, type Term,
} from './shape2-schema.ts';
