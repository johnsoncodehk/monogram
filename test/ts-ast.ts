import ts from 'typescript';
const code = process.argv[2] ?? `x ? y => ({ y }) : z => ({ z })`;
const sf = ts.createSourceFile('t.ts', code, ts.ScriptTarget.Latest, true);
function show(n: ts.Node, d=0){
  console.log('  '.repeat(d) + ts.SyntaxKind[n.kind] + (n.kind===ts.SyntaxKind.Identifier?`(${(n as any).text})`:''));
  n.forEachChild(c=>show(c,d+1));
}
show(sf);
console.log('parseDiagnostics:', (sf as any).parseDiagnostics?.length ?? 0);
