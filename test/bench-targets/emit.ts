// node emit.ts <monogram source tree> <out dir> [grammar=typescript]: the TS target, the emitted JS
// parser and the Go target of <grammar> from that tree, laid out for run.sh: <out>/ts.mts,
// <out>/js.mts, <out>/go/{go.mod, parser/parser.go, main.go, vg_*} (main.go = this directory's
// go-main.go, vg_* its Valgrind client request).
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const [root, out, name = 'typescript'] = process.argv.slice(2);
const { emitParser, tsTarget, jsTarget, goTarget } = await import(root + '/src/emit.ts');
const grammar = (await import(root + '/' + name + '.ts')).default;
mkdirSync(join(out!, 'go', 'parser'), { recursive: true });
writeFileSync(join(out!, 'ts.mts'), emitParser(grammar, tsTarget));
writeFileSync(join(out!, 'js.mts'), emitParser(grammar, jsTarget));
writeFileSync(join(out!, 'go', 'go.mod'), 'module consumer\n\ngo 1.21\n');
writeFileSync(join(out!, 'go', 'parser', 'parser.go'), emitParser(grammar, goTarget));
copyFileSync(new URL('./go-main.go', import.meta.url), join(out!, 'go', 'main.go'));
for (const f of ['vg_amd64.go', 'vg_amd64.s', 'vg_other.go']) copyFileSync(new URL('./' + f, import.meta.url), join(out!, 'go', f));
