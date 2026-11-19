// goTarget emits a library (`package parser`); a gate that compiles it together with a runner or
// harness file into one executable needs the library in `package main`.
export function asGoMain(library: string): string {
  const out = library.replace(/^package parser$/m, 'package main');
  if (out === library) throw new Error('asGoMain: emitted Go source has no `package parser` clause');
  return out;
}
