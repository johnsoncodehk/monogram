// Witnesses for the tsc built board (test/shape2-oracle.ts runBuilt): inputs the conformance
// corpus does not reach with the emitted shape-building parser. A class EXPRESSION with a heritage
// clause (the corpus's class declarations are outside what the plans build: `modifiers`): its
// clause's `elements` branch begins with a repetition, whose iteration marker sits where a fixed
// read expected the branch's first tag (shape-plan.ts branchCase; built `heritageClauses: [null]`).
(class extends A {});
(class C extends B implements I, J {});
(class extends f().g {});
