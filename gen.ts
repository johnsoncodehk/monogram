// node gen.ts <monogram source tree> <out dir>: the exact emitParser(typescript.ts, target) outputs packaged here.
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
const [root, out] = process.argv.slice(2);
const here = new URL('.', import.meta.url).pathname;
const { emitParser, goTarget, rustTarget, tsTarget } = await import(root + '/src/emit.ts');
const grammar = (await import(root + '/typescript.ts')).default;
mkdirSync(out, { recursive: true });
writeFileSync(`${out}/parser.go`, emitParser(grammar, goTarget));
writeFileSync(`${out}/bench.rs`, emitParser(grammar, rustTarget) + readFileSync(here + 'bench-tail.rs', 'utf8'));
writeFileSync(`${out}/parser.ts`, emitParser(grammar, tsTarget));
