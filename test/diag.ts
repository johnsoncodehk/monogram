import { createParser } from '../src/gen-parser.ts';
import { readFileSync } from 'fs';
const grammar = (await import('../typescript.ts')).default;
const { parse } = createParser(grammar);
for (const f of process.argv.slice(2)) {
  const code = readFileSync(f, 'utf-8');
  try { parse(code); console.log(f.split('/').pop(), 'OK'); }
  catch (e: any) {
    console.log(f.split('/').pop(), '\n  ', e.message);
    const m = e.message.match(/farthest: offset (\d+)/);
    if (m) { const o = +m[1]; console.log('   CTX:', JSON.stringify(code.slice(Math.max(0, o - 70), o + 30))); }
  }
}
