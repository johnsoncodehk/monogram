// node synth-nonascii.ts <out>: a deterministic ~128 KiB TypeScript file heavy in non-ASCII text:
// identifiers in CJK and accented Latin, non-ASCII whitespace, and CJK in strings, templates,
// comments and regex literals. Every statement is valid TypeScript.
import { writeFileSync } from 'node:fs';
const out = process.argv[2]!;
const units = [
  (i: number) => `const 変数${i} = 関数名(引数, 値${i});\n`,
  (i: number) => `let café${i} = naïve + résumé${i};\n`,
  (i: number) => `x${i}　= y + z;\n`,
  (i: number) => `const s${i} = "日本語の文字列 ${i}" + 'émoji 😀';\n`,
  (i: number) => `const t${i} = \`日本\${x}語 ${i}\`;\n`,
  (i: number) => `// 日本語のコメント ${i}\n/* 注釈 😀 */\n`,
  (i: number) => `const r${i} = /日本語${i}/u.test(s);\n`,
  (i: number) => `function 処理${i}(入力: 型, ñ: number): 結果 { return 入力.値 + ñ; }\n`,
];
let s = 'declare const 関数名: any, 引数: any, naïve: any, résumé0: any, x: any, y: any, z: any, s: string;\ntype 型 = any; type 結果 = any;\n';
for (let i = 0; Buffer.byteLength(s) < 128 * 1024; i++) s += units[i % units.length]!(i);
writeFileSync(out, s);
console.log(`${out}: ${Buffer.byteLength(s)} bytes, ${s.length} UTF-16 units`);
