// The cooking functions: the reference definitions of COOK_FNS (src/shape2-schema.ts), each a pure
// function of one leaf's source text. The evaluator (src/shape2-eval.ts) calls them, and the
// TypeScript printer of a shape-building parser embeds cookTable's source as its cooking
// functions, so the two cannot differ. Self-contained: it reads nothing outside itself but the
// types CookFn and Scalar.
import type { CookFn, Scalar } from './shape2-schema.ts';

export function cookTable(): Record<CookFn, (raw: string) => Scalar | undefined> {
  // Built once (no closure per call); a name without an escape is its own text.
  const codePoint = (_: string, a: string | undefined, b: string | undefined): string => String.fromCodePoint(parseInt(a ?? b!, 16));
  const unescapeCodePoints = (s: string): string =>
    (s.includes('\\') ? s.replace(/\\u\{([0-9a-fA-F]+)\}|\\u([0-9a-fA-F]{4})/g, codePoint) : s);

  function stringValue(raw: string): string {
    const body = raw.slice(1, -1);
    if (!body.includes('\\')) return body;
    let out = '';
    for (let i = 0; i < body.length; i++) {
      const ch = body[i];
      if (ch !== '\\') { out += ch; continue; }
      const n = body[++i];
      switch (n) {
        case 'n': out += '\n'; break;
        case 't': out += '\t'; break;
        case 'r': out += '\r'; break;
        case 'b': out += '\b'; break;
        case 'f': out += '\f'; break;
        case 'v': out += '\v'; break;
        case '\r': if (body[i + 1] === '\n') i++; break;   // line continuation
        case '\n': case ' ': case ' ': break;
        case 'x': out += String.fromCharCode(parseInt(body.slice(i + 1, i + 3), 16)); i += 2; break;
        case 'u': {
          if (body[i + 1] === '{') {
            const close = body.indexOf('}', i);
            out += String.fromCodePoint(parseInt(body.slice(i + 2, close), 16));
            i = close;
          } else { out += String.fromCharCode(parseInt(body.slice(i + 1, i + 5), 16)); i += 4; }
          break;
        }
        default: {
          if (n >= '0' && n <= '7') {
            // \0 (not followed by a digit) and the legacy octal escapes (Annex B.1.2).
            const m = /^[0-3][0-7]{0,2}|^[4-7][0-7]?/.exec(body.slice(i))![0];
            out += String.fromCharCode(parseInt(m, 8));
            i += m.length - 1;
          } else out += n;   // \8, \9 and every other escaped character stand for themselves
        }
      }
    }
    return out;
  }

  function numberValue(raw: string): number {
    const t = raw.replace(/_/g, '');
    if (/^0[xX]/.test(t)) return parseInt(t.slice(2), 16);
    if (/^0[oO]/.test(t)) return parseInt(t.slice(2), 8);
    if (/^0[bB]/.test(t)) return parseInt(t.slice(2), 2);
    if (/^0[0-7]+$/.test(t)) return parseInt(t.slice(1), 8);   // legacy octal (Annex B.1.1)
    return Number(t);
  }

  /** tsc's TokenFlags of a numeric literal's spelling (Scientific 16, Octal 32, HexSpecifier 64,
   * BinarySpecifier 128, OctalSpecifier 256, ContainsSeparator 512, ContainsLeadingZero 8192). */
  function tsNumericLiteralFlags(raw: string): number | undefined {
    let f = 0;
    if (/^0[xX]/.test(raw)) f |= 64;
    else if (/^0[bB]/.test(raw)) f |= 128;
    else if (/^0[oO]/.test(raw)) f |= 256;
    else if (/^0[0-7]+$/.test(raw)) f |= 32;
    else {
      if (/^0[0-9]/.test(raw)) f |= 8192;
      if (/[eE]/.test(raw)) f |= 16;
    }
    if (raw.includes('_')) f |= 512;
    return f === 0 ? undefined : f;
  }

  /** A template part's body: its token without the delimiters (`` ` `` or `}` before it, `${` or
   * `` ` `` after it). */
  const templateBody = (raw: string): string => raw.slice(1, raw.length - (raw.endsWith('${') ? 2 : 1));
  /** One scan of a template body: the TV (null when an escape is invalid), tsc's text (an invalid
   * escape keeps its backslash; what follows it is read as ordinary text, as tsc's scanner does) and
   * tsc's TokenFlags of its escapes. A CR or CRLF is one LF in both texts (ECMA-262 12.9.6 TV / TRV);
   * a backslash before a line terminator is a line continuation (nothing). */
  function scanTemplate(raw: string): { cooked: string | null; tsText: string; flags: number } {
    return scanEscapes(templateBody(raw));
  }
  function scanEscapes(body: string): { cooked: string | null; tsText: string; flags: number } {
    let out = '', valid = true, flags = 0;
    const hex = /[0-9a-fA-F]/;
    for (let i = 0; i < body.length; i++) {
      const ch = body[i];
      if (ch === '\r') { out += '\n'; if (body[i + 1] === '\n') i++; continue; }
      if (ch !== '\\') { out += ch; continue; }
      const c = body[i + 1];
      if (c === '\r') { i++; if (body[i + 1] === '\n') i++; continue; }
      if (c === '\n' || c === '\u2028' || c === '\u2029') { i++; continue; }
      const single: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v' };
      let val: string | undefined, len = 1;
      if (c in single) val = single[c];
      else if (c === '0' && !/[0-9]/.test(body[i + 2] ?? '')) val = '\0';
      else if (c >= '0' && c <= '9') val = undefined;
      else if (c === 'x') {
        if (hex.test(body[i + 2] ?? '') && hex.test(body[i + 3] ?? '')) { val = String.fromCharCode(parseInt(body.slice(i + 2, i + 4), 16)); len = 3; flags |= 4096; }
      } else if (c === 'u') {
        const braced = /^\{([0-9a-fA-F]+)\}/.exec(body.slice(i + 2));
        const four = /^[0-9a-fA-F]{4}/.exec(body.slice(i + 2));
        if (braced && parseInt(braced[1], 16) <= 0x10ffff) { val = String.fromCodePoint(parseInt(braced[1], 16)); len = 1 + braced[0].length; flags |= 8; }
        else if (!braced && four) { val = String.fromCharCode(parseInt(four[0], 16)); len = 5; flags |= 1024; }
      } else val = c;
      if (val === undefined) { valid = false; flags |= 2048; out += '\\'; continue; }
      out += val;
      i += len;
    }
    return { cooked: valid ? out : null, tsText: out, flags };
  }

  const COOK: Record<CookFn, (raw: string) => Scalar | undefined> = {
    templateCooked: (raw) => scanTemplate(raw).cooked,
    templateRaw: (raw) => templateBody(raw).replace(/\r\n?/g, '\n'),
    tsTemplateText: (raw) => scanTemplate(raw).tsText,
    tsTemplateRawText: templateBody,
    tsTemplateFlags: (raw) => scanTemplate(raw).flags || undefined,
    tsNumericText: (raw) => String(numberValue(raw)),
    tsNumericLiteralFlags,
    tsBigIntText: (raw) => raw.replace(/_/g, ''),
    // A VALID `\u{…}` escape (tsc's TokenFlags.ExtendedUnicodeEscape) in a string or a template part.
    hasExtendedUnicodeEscape: (raw) => (scanEscapes(raw.startsWith('"') || raw.startsWith("'") ? raw.slice(1, -1) : templateBody(raw)).flags & 8) !== 0,
    identifierName: unescapeCodePoints,
    stringValue,
    numberValue,
    bigintValue: (raw) => `${BigInt(raw.slice(0, -1).replace(/_/g, ''))}n`,
    bigintText: (raw) => raw.slice(0, -1).replace(/_/g, ''),
    privateName: (raw) => unescapeCodePoints(raw.slice(1)),
    regexPattern: (raw) => raw.slice(1, raw.lastIndexOf('/')),
    regexFlags: (raw) => raw.slice(raw.lastIndexOf('/') + 1),
    stringBody: (raw) => raw.slice(1, -1),
  };
  return COOK;
}
export const COOK = cookTable();
