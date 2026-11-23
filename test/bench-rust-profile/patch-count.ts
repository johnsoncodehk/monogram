// node patch-count.ts <parser.rs> <out.rs>: the emitted library with work counters patched into
// CstBuilder (finish/node/leaf/checkpoint/restore) and Parser::peek, for the separate count build.
// Each replacement must match exactly once inside its region, or this fails.
import { readFileSync, writeFileSync } from 'node:fs';
const [inp, out] = process.argv.slice(2);
let src = readFileSync(inp, 'utf8');
const r0 = src.indexOf('impl Builder for CstBuilder {');
const r1 = src.indexOf('pub struct SlimBuilder');
if (r0 < 0 || r1 < r0) throw new Error('CstBuilder region not found');
let region = src.slice(r0, r1);
function sub(from: string, to: string, times: number) {
  const n = region.split(from).length - 1;
  if (n !== times) throw new Error(`expected ${times}× ${JSON.stringify(from)} in CstBuilder, found ${n}`);
  region = region.split(from).join(to);
}
const kidCopy = region.includes('copy_kids(&mut self.kids, &scratch[sb..nn]);') ? 'copy_kids(&mut self.kids, &scratch[sb..nn]);' : 'self.kids.extend(scratch[sb..nn].iter().copied());';
sub(kidCopy, 'cnt_node(nn - sb, self.nodes.len() + 1); ' + kidCopy, 2);
sub('scratch.push(encode_leaf(tok_idx, tt_id as u8));', 'cnt_add(C_LEAF, 1); scratch.push(encode_leaf(tok_idx, tt_id as u8));', 1);
sub('fn checkpoint(&self) -> (usize, usize) { (self.nodes.len(), self.kids.len()) }', 'fn checkpoint(&self) -> (usize, usize) { cnt_add(C_CKPT, 1); (self.nodes.len(), self.kids.len()) }', 1);
sub('fn restore(&mut self, ck: (usize, usize)) { self.nodes.truncate(ck.0);', 'fn restore(&mut self, ck: (usize, usize)) { cnt_restore(&self.nodes, ck.0, self.kids.len(), ck.1); self.nodes.truncate(ck.0);', 1);
src = src.slice(0, r0) + region + src.slice(r1);
const peek = 'fn peek(&mut self) -> Option<Tok> {\n';
if (src.split(peek).length !== 2) throw new Error('Parser::peek not found exactly once');
src = src.replace(peek, peek + '        cnt_add(C_PEEK, 1);\n');
// Buffer lengths and capacities left in the Parser by parse_with (scratch, top-level entries).
// Two shapes of parse_with: the Parser's buffers moved back into the builder by hand (`*b = p.b;`),
// or by a drop guard after `root` (a builder carrying a Workspace); the stores go right before either.
const pbStore = '    PB[0].store(p.scratch.len() as u64, Relaxed); PB[1].store(p.scratch.capacity() as u64, Relaxed); PB[2].store(p.entries.len() as u64, Relaxed); PB[3].store(p.entries.capacity() as u64, Relaxed);\n';
const pw = '    *b = p.b;\n    if let Some(t) = b.toks_mut() { *t = p.toks; }\n';
const pwGuard = '    };\n    root\n}\n\n/// Returns a parse\'s buffers';
if (src.split(pw).length === 2) src = src.replace(pw, pbStore + pw);
else if (src.split(pwGuard).length === 2) src = src.replace(pwGuard, '    };\n' + pbStore + '    root\n}\n\n/// Returns a parse\'s buffers');
else throw new Error('parse_with tail not found exactly once');
writeFileSync(out, src);
