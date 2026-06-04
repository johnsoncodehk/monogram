// scope-gap-html.ts — HTML adapter for the unified scope-gap harness. The FIRST real
// vscode#203212 comparative gap: VS Code's HTML grammar is the unmaintained textmate/html.tmbundle;
// the oracle is parse5 (maintained, authoritative). Run (bare node): node test/scope-gap-html.ts
//   Override the official grammar: MONOGRAM_OFFICIAL_HTML=/path/to/html.tmLanguage.json
import { run } from './scope-gap.ts';
import { htmlOracle } from './html-oracle.ts';
import { cases as htmlIssueCases } from './html-issue-cases.ts';

const OFFICIAL = process.env.MONOGRAM_OFFICIAL_HTML
  ?? '/Applications/Visual Studio Code.app/Contents/Resources/app/extensions/html/syntaxes/html.tmLanguage.json';

// Realistic HTML (baseline) — tags, quoted/unquoted/boolean attrs, nesting, comments, voids.
const GENERAL: string[] = [
  '<div class="container" id="main"><p>Hello <a href="/x">world</a>.</p></div>',
  '<ul><li>one</li><li>two</li><li>three</li></ul>',
  '<img src="a.png" alt="a picture" width="100" height="80">',
  '<input type="text" name="q" placeholder="Search" disabled>',
  '<button type="submit" class="btn btn-primary" data-id="42">Go</button>',
  '<section><h1>Title</h1><p>Body with <strong>bold</strong> and <em>italic</em>.</p></section>',
  '<nav><a href="/">Home</a> | <a href="/about">About</a></nav>',
  '<form action="/submit" method="post"><label for="n">Name</label><input id="n"></form>',
  '<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>',
  '<!-- a comment --><div><!-- inline --><span>x</span></div>',
  '<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
  '<br><hr>',
  '<select><option value="1">One</option><option value="2" selected>Two</option></select>',
  '<video controls width="320"><source src="m.mp4" type="video/mp4"></video>',
  '<article data-index=3 hidden><header>H</header><footer>F</footer></article>',
  '<span class="a b c" title="x y z">text</span>',
  '<div\n  class="multi-line"\n  id="tag"\n  data-x="1">body</div>',
  '<a href="https://example.com?a=1&b=2" target="_blank" rel="noopener">link</a>',
  '<label>Email <input type="email" required></label>',
  '<figure><img src="p.jpg" alt="photo"><figcaption>cap</figcaption></figure>',
];

const corpus = [
  ...GENERAL.map((text, i) => ({ name: `general#${i}`, text })),
  ...htmlIssueCases.map((c: any, i: number) => ({ name: `issue:${c.title ?? i}`, text: c.src as string })),
];

await run({
  name: 'HTML',
  scopeName: 'text.html.basic',
  officialPath: OFFICIAL,
  monogramPath: 'html.tmLanguage.json',
  loadCorpus: () => corpus,
  roleOracle: htmlOracle,
});
