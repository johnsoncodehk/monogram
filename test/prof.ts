import { readFileSync } from 'fs';
import { createParser } from '../src/gen-parser.ts';
const grammar = (await import('../typescript.ts')).default;
process.env.PROF = '1';
const p: any = createParser(grammar);
const code = readFileSync('/tmp/ts-repo/tests/cases/conformance/parser/ecmascript5/RealWorld/parserharness.ts','utf-8');
try { p.parse(code); } catch {}
const g = (k:string)=>p.profCounts.get(k)??0;
console.log('memo hit/miss:', g('$memoHit'), '/', g('$memoMiss'), '=> hit rate', (100*g('$memoHit')/(g('$memoHit')+g('$memoMiss'))).toFixed(0)+'%');
console.log('LED loop: tries', g('$ledTry'), ' hits', g('$ledHit'), '=> wasted', (100*(1-g('$ledHit')/g('$ledTry'))).toFixed(0)+'% of led matchSeq attempts fail fast');
