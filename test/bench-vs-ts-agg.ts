import { createParser } from '../src/gen-parser.ts';
import { readdir } from 'fs/promises';
import { readFileSync } from 'fs';
import { join } from 'path';
import ts from 'typescript';
const grammar = (await import('../examples/typescript.ts')).default;
const { parse } = createParser(grammar);
const base = '/tmp/ts-repo/tests/cases/conformance';
async function all(d: string): Promise<string[]> { const o:string[]=[]; for(const e of await readdir(d,{withFileTypes:true})){const f=join(d,e.name); if(e.isDirectory())o.push(...await all(f)); else if(e.name.endsWith('.ts')&&!e.name.endsWith('.d.ts'))o.push(f);} return o; }
const files = (await all(base)).map(f => readFileSync(f,'utf-8'));
const totalKB = files.reduce((s,c)=>s+c.length,0)/1024;
// warm up
for(const c of files.slice(0,200)){ try{parse(c);}catch{} ts.createSourceFile('t.ts',c,ts.ScriptTarget.Latest,false,ts.ScriptKind.TS); }
let t0=process.hrtime.bigint(); for(const c of files){ try{parse(c);}catch{} } const ours=Number(process.hrtime.bigint()-t0)/1e6;
t0=process.hrtime.bigint(); for(const c of files){ ts.createSourceFile('t.ts',c,ts.ScriptTarget.Latest,false,ts.ScriptKind.TS); } const tsms=Number(process.hrtime.bigint()-t0)/1e6;
console.log(`${files.length} files, ${totalKB.toFixed(0)} KB total`);
console.log(`  ours: ${ours.toFixed(0)} ms  (${(totalKB/1024/(ours/1000)).toFixed(1)} MB/s)`);
console.log(`  ts:   ${tsms.toFixed(0)} ms  (${(totalKB/1024/(tsms/1000)).toFixed(1)} MB/s)`);
console.log(`  ours/ts: ×${(ours/tsms).toFixed(1)}`);
