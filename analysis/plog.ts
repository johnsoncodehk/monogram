// node plog.ts <wasm> <src> [lines]: tree, then the parse log (lex + parse lines; ALL=1 keeps char lines).
const W = process.env.W ?? '/home/linuxuser/projects/monogram/.claude/worktrees/agent-ae44134f2ffcb618c';
const { Parser, Language } = await import(`${W}/node_modules/web-tree-sitter/web-tree-sitter.js`);
await Parser.init();
const [wasm, src, n] = process.argv.slice(2);
const p = new Parser(); p.setLanguage(await Language.load(wasm));
const logs: string[] = [];
p.setLogger((m: string, _x: any, t: string) => { if (process.env.ALL || !/^(skip|consume) character/.test(m)) logs.push(`${t === 'lex' ? 'L' : 'P'} ${m}`); });
const t = p.parse(src)!;
console.log(t.rootNode.toString());
console.log(logs.slice(0, Number(n ?? 200)).join('\n'));
