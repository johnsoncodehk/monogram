// The units a target's strings are measured in, and a text's length in them.
//
// Go and Rust index their strings by UTF-8 byte; the TS target (like the interpreter and the
// emitted JS parser) by UTF-16 code unit. A character beyond ASCII is one or two UTF-16 units but
// two to four UTF-8 bytes. Every length or offset the generator prints into a target (how far a
// lexer advances past a literal, a literal's length in a lookup key) is the text's length in that
// target's units, from `unitLen`: a JavaScript `.length` is the length in UTF-16 units only.
//
// A decision made once for every target (whether a literal is one unit, so that a scanner may step
// over it as one) holds only where every target's units agree: `oneUnit`.

export type TextUnits = 'utf8' | 'utf16';
export const TEXT_UNITS: readonly TextUnits[] = ['utf8', 'utf16'];

/** The length of `text` in `units`. */
export function unitLen(text: string, units: TextUnits): number {
  return units === 'utf16' ? text.length : Buffer.byteLength(text, 'utf8');
}

/** The first unit of a non-empty `text` in `units`: its first UTF-16 code unit or UTF-8 byte. */
export function firstUnit(text: string, units: TextUnits): number {
  return units === 'utf16' ? text.charCodeAt(0) : Buffer.from(text, 'utf8')[0]!;
}

/** Whether `text` is exactly one unit in every target's units (one ASCII character). */
export function oneUnit(text: string): boolean {
  return TEXT_UNITS.every((u) => unitLen(text, u) === 1);
}

/** The UTF-8 bytes of `text`. */
export function utf8Of(text: string): number[] {
  return [...Buffer.from(text, 'utf8')];
}
