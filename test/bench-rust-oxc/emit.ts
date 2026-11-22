// node emit.ts <monogram source tree> <out.rs> [grammar=typescript]: emitParser(<grammar>.ts, rustTarget)
// from that tree (run.sh passes BENCH_GRAMMAR, e.g. `javascript`).
import { writeFileSync } from 'node:fs';
const [root, out, name = 'typescript'] = process.argv.slice(2);
const { emitParser, rustTarget } = await import(root + '/src/emit.ts');
const grammar = (await import(root + '/' + name + '.ts')).default;
writeFileSync(out, emitParser(grammar, rustTarget));
