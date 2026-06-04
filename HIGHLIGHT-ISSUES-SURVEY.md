# Highlight-Issues Survey — Embedded-Language / Host+Template Formats

**Date:** 2026-06-03 · **Scope:** Slidev · MDX · Astro · Svelte · YAML · Markdown · Ripple · Vue Vine · TSRX
**Method:** 9 parallel research agents, one per target. Each agent identified the canonical highlighting grammar(s), hunted *open* GitHub issues (with minimal repros + links), and analyzed the structural reason each problem is hard. Bias toward **embedded-language / host+template** problems, since that is Monogram's current frontier (HTML→Vue), and toward distinguishing *proven*-from-the-model limits vs merely *asserted* ones.

This is a scouting report, not a plan. It surveys where the *current* highlighters (TextMate, tree-sitter, Monarch, LSP) still fail across formats that share Monogram's shape: a host language with an embedded template and further-embedded sublanguages.

---

## TL;DR

- **One problem dominates four targets:** the overloaded `---` **frontmatter fence** (Slidev / Astro / MDX / YAML-as-frontmatter). A line-based grammar cannot know whether a `---` sits inside a TS string/comment, so it mis-closes frontmatter and corrupts the rest of the file. This is the same *family* as the Vue/HTML same-line-close problem Monogram already solved (#2060).
- **Embedding close-tag leakage** (`:global()` / `@property` bleeding past `</style>` in Svelte) is the exact bug class Monogram beat for Vue/HTML — and the maintainers label it a *fixable upstream bug*, not a ceiling. Low-risk demonstrable win.
- **Two genuine TextMate ceilings** recur and should *not* be over-claimed: (1) **indentation-sensitivity** (YAML block scalars, Markdown container blocks) — TextMate has no indent-column state, tree-sitter solves it with a stateful C scanner; (2) **Markdown emphasis delimiter-run flanking** — pairing needs a stack/counter a line-local regex provably lacks.
- **Magic identifiers** (`$state` runes, `vineProp`/`vineStyle` macros, Ripple `track()`) are lexically ordinary identifiers; no token grammar distinguishes them without a name-list or semantics. Monogram *knows the names from its grammar*, so a partial win exists; full disambiguation needs the LSP.
- **New-framework pain is multi-engine drift, not expressiveness.** Ripple/TSRX ships TextMate + tree-sitter + Volar that disagree and lag the language; Vue Vine has *no* tree-sitter or Monarch at all. This is the cleanest pitch for Monogram's thesis: derive every engine from one grammar so they cannot drift.
- **TSRX is identified with high confidence** = "TypeScript Render Extensions," Dominic Gannaway's JSX-successor language extracted from **Ripple**. TSRX and Ripple **share one grammar** in the `Ripple-TS/ripple` monorepo — treat them as one tooling surface (see [§ TSRX](#tsrx) note).

---

## Cross-cutting structural themes

The same handful of mechanisms explain almost every bug below. "Verdict" marks whether the limit is **proven** from the model, **near-proven**, **asserted/empirical**, or a **fixable bug** (no ceiling claimed).

| # | Pattern | Shows up in | TextMate verdict | Monogram angle |
|---|---|---|---|---|
| 1 | **`---` frontmatter fence overloaded** (slide-separator / YAML delim / `<hr>` / TS content) | Slidev, Astro, MDX, YAML-frontmatter | **Proven**: deciding a `---` requires the embedded TS lexer's state (is it in a string/comment?), which a per-line regex cannot have | Stated next frontier; analogous to the solved Vue/HTML same-line-close (#2060). The Slidev runtime-parser-vs-editor-grammar disagreement *is* the "correctness by construction" pitch |
| 2 | **Embedding close-tag re-detection / scope leak** past `</style>`,`</script>` | Svelte (`:global()`, `@property`), Vue, HTML | **Fixable bug** (labeled "upstream", not a ceiling) | **Already solved** for Vue/HTML same-line-close (#2060) — direct, low-risk strength |
| 3 | **Indentation-sensitivity** vs line-based regex | YAML (block scalars `\|`/`>`), Markdown (containers, lists, lazy continuation) | **Proven/near-proven**: no indent-column state in a line-local matcher; tree-sitter needs a stateful external C scanner | Monogram derives *both* TM and tree-sitter — the GLR path can, TM cannot. Be honest *per engine* |
| 4 | **Nested template-in-template-literal + `${}` collision** | Vue Vine (Vue template in a TS tagged literal; CSS in `vineStyle(css\`…\`)`) | `${}` collision: **asserted unsolvable in the current scheme** (Vine *documents* it; not formally proven). Multiline tags: classic begin/end limit | Genuine soft ceiling for `${}`; **do not over-claim**. Multiline-tag could yield to `while`/balanced matching |
| 5 | **"Magic" identifiers** lexically indistinguishable from ordinary idents | Svelte runes `$state`, Vine macros `vineProp`, Ripple `track()`/`component` | **Proven** beyond a context-free *token* grammar without a hardcoded name-list | Monogram knows the macro/rune names from its grammar → can emit the list (partial win). True same-name disambiguation needs semantics |
| 6 | **Delimiter-run flanking** (context-sensitive inline) | Markdown emphasis `*`/`_`/`**`/`***` | **Near-proven**: pairing needs a stack + run-length `%3` rule across the line; open since 2016 with "help wanted" | Genuine TM ceiling; tree-sitter scanner territory |
| 7 | **Closed-world fenced-code injection** | Markdown (hardcoded lang list), Slidev (build-time *copies* the upstream markdown grammar) | **Fixable but brittle**: unbundled langs silently fail; copied rules desync on upstream change | Monogram could *derive* the injection set; the copy-the-grammar design is an architecture smell |
| 8 | **Multi-engine drift / new-framework immaturity** | Ripple/TSRX (TextMate + tree-sitter + Volar disagree, lag the language), Vue Vine (no tree-sitter/Monarch at all) | N/A — process/architecture problem, not expressiveness | **The thesis pitch**: derive every engine from one grammar → they cannot drift or lag |
| 9 | **JSX vs generic `<…>` ambiguity** inherited by embedders | Astro (routes expressions to `source.tsx`), MDX | Hard in general; Monogram already beat the `.tsx` generic-arrow⇄JSX case | Existing strength carried into any JSX-embedding host |
| 10 | **Retroactive / backward classification** | Markdown setext headings (a `===`/`---` line reclassifies the line *above*), YAML empty-key blocks | **Proven** hard for a forward line scanner without lookahead | tree-sitter scanner can; TM cannot |

### Reading the verdicts (per the "TM-impossible needs proof" rule)

- **Proven (#1, #3 partial, #5, #10):** argued from the regular/line-based model itself — a per-line regex with a bounded state stack provably cannot carry indentation columns, cross-line lexical state, or unbounded counters. These are real ceilings *for TextMate*; several fall to a stateful scanner (tree-sitter) or to the host parser (Monogram's premise).
- **Near-proven (#3 YAML, #6):** strongly argued, repeatedly closed "upstream/by-design," decade-old, but not formally written as an impossibility proof. Treat as "the frontier neither hand-grammar reaches today," not a settled theorem.
- **Asserted/empirical (#4 `${}`):** Vine's docs *show* the broken render and say the IDE "can't highlight" it — but that is the current injection scheme's limit, not a proof. A candidate to *attack* before believing.
- **Fixable bug (#2, #7):** maintainers label these ordinary bugs. #2 is one Monogram already solved.

---

## Implications for Monogram (observations, not a committed plan)

Ranked by leverage × fit with the existing thesis and the HTML→Vue work just shipped:

1. **Frontmatter (`---`) is the single highest-leverage theme** — it is the same problem in Slidev, Astro, and MDX, and the same *family* as the Vue/HTML same-line-close case already solved (#2060). The Slidev finding that the **runtime parser and the editor grammar disagree by construction** (different `---` semantics) is a textbook instance of the correctness-by-construction argument: derive the highlighter from the same grammar the parser uses and the disagreement vanishes.
2. **Markdown + code-fence injection is the gateway** to both Slidev and MDX (both are Markdown-family). It is also where the genuine TM ceilings live (emphasis flanking, containers), so it doubles as an honest test of where the tree-sitter path must take over from the TM path.
3. **Svelte close-tag leak (`:global()`, `@property`) is a quick, demonstrable win** — same bug class as #2060, and explicitly a fixable upstream bug, not a ceiling.
4. **Ripple/TSRX and Vue Vine are "thesis demonstration" targets** — small, in-flux ecosystems whose actual pain is *multi-engine drift and lag*. "Derive once → every engine agrees" is most visibly valuable exactly where hand-maintained engines are drifting.
5. **YAML is foundational** (frontmatter everywhere) but its core difficulty (indentation, block scalars) is a **tree-sitter-path** win, not a TextMate one — useful to scope honestly per engine.

---

# Per-target findings

> Each section preserves the researching agent's structured output: what it is, how it's highlighted, the embedded structure, concrete *open* issues with repros + links, the structural reason it's hard, and surprising findings.

## Slidev

**What it is:** A Markdown-based slide-deck framework (slidevjs/slidev). A deck is one (or several `src:`-imported) Markdown file(s) where each slide is separated by `---`, each slide can carry per-slide YAML frontmatter, and slides freely embed Vue components, UnoCSS classes, code fences (Shiki, with line-highlight ranges / magic-move / magic comments / twoslash), `<<<` external-snippet imports, and LaTeX/MathJax (`$$…$$`). The first frontmatter block is "headmatter" (deck-wide config); subsequent ones are per-slide.

**File extension(s):** `.md` (conventionally `slides.md`; the VS Code extension gates on the `text.html.markdown` scope rather than a unique extension).

**Highlighting approach & key repos:** Two layers, often conflated in the tracker:
1. **Rendered output:** [Shiki](https://shiki.style) inside Slidev's markdown-it pipeline (`packages/slidev/node/plugins/markdown.ts`). Line-highlighting, magic-move, transformers, twoslash live here.
2. **Editor highlighting of `slides.md`:** an **injection TextMate grammar** in `slidevjs/slidev/packages/vscode/syntaxes/` (the standalone `slidevjs/slidev-vscode` is **archived since 2024-05-10**; everything moved into `packages/vscode`, which also ships a Volar language-server). Grammars: `slidev.tmLanguage.json` (`source.slidev`: `slide-frontmatter` + `import-snippet`, embeds `source.yaml`/`source.ts`); `markdown.json` (injects into `text.html.markdown`); `codeblock.json` (fence info-string attrs: `{1,2|3}` ranges, `monaco`, `twoslash`, `{…}` option objects as TS); `codeblock-patch.ts` → at build time **copies every `fenced_code_block_*` rule out of the upstream `tm-grammars` markdown grammar** and re-injects them so `{…}` attributes can sit on the fence line for ~40 languages.

**Embedded languages / structure:** YAML (headmatter + per-slide), TypeScript (frontmatter `src`/option objects, `<script setup>`), Vue/HTML components, `meta.embedded.block.*` for ~40 fenced languages, LaTeX (`$$`). Purely injection-based; suppressed inside `markup.frontmatter.slidev` / `markup.fenced_code.block.markdown` to avoid double-tokenizing.

**Unsolved highlight issues:**
- Standard `---` frontmatter "may lack of highlighting and formatter support" — maintainer-acknowledged; the official **Block Frontmatter** feature (```yaml fenced block) exists *specifically* as a highlighting/Prettier escape hatch — [docs: features/block-frontmatter](https://sli.dev/features/block-frontmatter) — by-design workaround, not a fix
- VS Code 1.92.0 broke all Slidev editor highlighting (upstream markdown grammar changed; the *copied* fenced-code rules diverged) — [slidevjs/slidev#1801](https://github.com/slidevjs/slidev/issues/1801) — closed (#1798), but the brittle copy-the-grammar design persists
- Leading whitespace in a code fence breaks all *subsequent* code blocks on the slide — indented `test` inside a fence — [slidevjs/slidev#1867](https://github.com/slidevjs/slidev/issues/1867) — closed (#1909); illustrates fence-boundary fragility
- Uppercase letters in the project/dir name break code highlighting + Mermaid (pnpm) — deck named e.g. `CodingSlide01` — [slidevjs/slidev#2614](https://github.com/slidevjs/slidev/issues/2614) — **OPEN** (2026-06-02, untriaged)
- No word/span-level (sub-line) code highlighting — `{…}` colors whole lines only — [slidevjs/slidev#2124](https://github.com/slidevjs/slidev/issues/2124) — **OPEN** feature request
- Custom highlighter/transformer config ignored when an explicit entry path is passed — `slidev slides/slide.md` — [slidevjs/slidev#2603](https://github.com/slidevjs/slidev/issues/2603) — **OPEN**
- Shiki Magic-Move ignores transformers from `./setup/shiki.ts` — [slidevjs/slidev#1462](https://github.com/slidevjs/slidev/issues/1462) — open (rendered layer)

**Why it's hard (structural):** `---` is overloaded — simultaneously a slide separator, a YAML frontmatter delimiter, and a Markdown thematic break — and Slidev's *runtime* pre-parser (`packages/parser/src/core.ts`) disambiguates it with **document-global state a line-based grammar cannot have**: it checks whether the next line is blank (`line[3] !== '-' && next?.trim()` → frontmatter vs bare separator), scans forward to the matching close, and **explicitly skips fenced code blocks** (tracking backtick fence level) so a `---` inside a fence is never a separator. The injection grammar can only approximate from local context: `slide-frontmatter` begins on `^---.*$` and **terminates the YAML at the first blank line** (`end: (?=^\s*$)`). Because YAML legitimately permits blank lines, multi-paragraph frontmatter loses highlighting — the reason Block Frontmatter exists. None of this is *proven* TextMate-impossible — it is the limit of the current heuristic grammar — but faithfully reproducing the runtime parser's fence-skipping/`----`-vs-`---` logic statelessly is the genuinely hard part.

**Notable:** The maintainers route around their *own* injection grammar (Block Frontmatter shipped because the canonical `---` form "lacks highlighting"). The editor grammar and the runtime parser **disagree by construction** — a deck can parse correctly yet highlight wrong (and vice-versa). The grammar's own fixture `slidev.example.md` enumerates every construct it's meant to handle (a ready conformance checklist).

**Sources:** [packages/vscode/syntaxes](https://github.com/slidevjs/slidev/tree/main/packages/vscode/syntaxes) · [parser/src/core.ts](https://github.com/slidevjs/slidev/blob/main/packages/parser/src/core.ts) · [block-frontmatter](https://sli.dev/features/block-frontmatter) · [vscode-extension](https://sli.dev/features/vscode-extension) · [config-parser](https://sli.dev/custom/config-parser) · issues [#1801](https://github.com/slidevjs/slidev/issues/1801) [#1867](https://github.com/slidevjs/slidev/issues/1867) [#2614](https://github.com/slidevjs/slidev/issues/2614) [#2124](https://github.com/slidevjs/slidev/issues/2124) [#2603](https://github.com/slidevjs/slidev/issues/2603) [#1462](https://github.com/slidevjs/slidev/issues/1462)

---

## MDX

**What it is:** Markdown + JSX + ESM `import`/`export` in one document (mdx-js/mdx). Compiles to a JS/JSX module, so the highlighter juggles three grammars (Markdown, JSX, ECMAScript/TS) plus YAML frontmatter.

**File extension(s):** `.mdx` (sometimes `.md` configured as MDX in Docusaurus/Astro/Next).

**Highlighting approach & key repos:**
- **TextMate (canonical):** scope `source.mdx`. Shipped at `mdx-js/mdx-analyzer` → `packages/vscode-mdx/syntaxes/source.mdx.tmLanguage`, but it is **generated** — the real source is **`wooorm/markdown-tm-language`** (`build.js` + `grammar.yml`). `mdx-js/vscode-mdx` now redirects to `mdx-js/mdx-analyzer`.
- **LSP semantic tokens:** `@mdx-js/language-service`, but it uses **Acorn** to parse embedded JS → brittle on incomplete code.
- **tree-sitter:** `parmort/tree-sitter-mdx` (self-described as inaccurate; cannot run via WASM). No notable Monarch grammar.

**Embedded languages / structure:** YAML frontmatter (`---`); top-level ESM `import`/`export` (JS/TS); inline JSX elements/fragments; `{…}` expression flows (JS/TS) as block children and as attribute values; fenced code blocks per-language; all standard Markdown constructs coexisting.

**Unsolved highlight issues:**
- Blockquote highlighting bleeds past its end into following JSX — `> **a** _b_` then `<A />` (the `> ` styling extends onto `<A/>`) — [wooorm/markdown-tm-language#14](https://github.com/wooorm/markdown-tm-language/issues/14) — **OPEN** (fix sketch provided)
- Highlighting breaks inside nested ordered lists when indentation isn't 0 (tab-indented `1.` + `##` lose scopes) — [wooorm/markdown-tm-language#13](https://github.com/wooorm/markdown-tm-language/issues/13) — **OPEN**
- Embedded TS in a fence "runs amok" when a `type` decl has no trailing semicolon — `` ```ts `` / `type X = 1` (vs `type X = 1;`) — [wooorm/markdown-tm-language#5](https://github.com/wooorm/markdown-tm-language/issues/5) — **OPEN**, upstream (microsoft/TypeScript-TmLanguage#873)
- Limited set of fenced languages vs VS Code's built-in markdown grammar — [wooorm/markdown-tm-language#15](https://github.com/wooorm/markdown-tm-language/issues/15) / [mdx-js/mdx-analyzer#511](https://github.com/mdx-js/mdx-analyzer/issues/511) — **OPEN**
- No language intelligence/highlighting forwarding for embedded fence & frontmatter langs from the LSP side — [mdx-js/mdx-analyzer#287](https://github.com/mdx-js/mdx-analyzer/issues/287) — **OPEN**
- Loose/invalid JS while typing kills IntelliSense (Acorn hard-fails where the TS server tolerates) — [mdx-js/mdx-analyzer#267](https://github.com/mdx-js/mdx-analyzer/issues/267) — **OPEN** (PR #528 in flight)

**Why it's hard (structural):** The hard cases all live at the **Markdown↔JSX↔expression boundary**, where a line-oriented engine must decide per line whether it is in prose, a JSX subtree, a `{}` expression, or a fence — and one mis-detected boundary corrupts the rest of the document. Classic inline cases (text after `{}`, text between tags on one line, angle brackets in inline code, indented JSX) are now **CLOSED**, fixed when the grammar was rebuilt on markdown-tm-language (~2023). What remains open is the **Markdown block side** (blockquote/list termination interacting with JSX/blank-line semantics) — the inverse of the HTML/Vue raw-text-close problem. None are *claimed* TextMate-impossible (#14 ships a fix sketch).

**Notable:** The MDX team **doesn't own the grammar** — bugs concentrate upstream in `wooorm/markdown-tm-language` (and microsoft's TS-TmLanguage). The most-cited recent breakage (VS Code 1.92 YAML grammar regression, [microsoft/vscode#224862](https://github.com/microsoft/vscode/issues/224862)) was cross-extension and is now fixed. The same-line-close problem that is an *open frontier for Vue/HTML* is *already closed* here — a useful contrast: MDX solved its inline-JSX-boundary cases; its remaining bugs are on the Markdown-block side.

**Sources:** [mdx-analyzer](https://github.com/mdx-js/mdx-analyzer) · [wooorm/markdown-tm-language](https://github.com/wooorm/markdown-tm-language) (issues [#5](https://github.com/wooorm/markdown-tm-language/issues/5) [#13](https://github.com/wooorm/markdown-tm-language/issues/13) [#14](https://github.com/wooorm/markdown-tm-language/issues/14) [#15](https://github.com/wooorm/markdown-tm-language/issues/15)) · mdx-analyzer [#267](https://github.com/mdx-js/mdx-analyzer/issues/267) [#287](https://github.com/mdx-js/mdx-analyzer/issues/287) · [vscode#224862](https://github.com/microsoft/vscode/issues/224862) · [parmort/tree-sitter-mdx](https://github.com/parmort/tree-sitter-mdx) · [mdxjs.com/guides/syntax-highlighting](https://mdxjs.com/guides/syntax-highlighting/)

---

## Astro

**What it is:** A web framework whose `.astro` files combine a `---`-fenced **frontmatter** "component script" (TypeScript), an **HTML-like template** with JSX-style `{…}` expressions and PascalCase components, and embedded `<style>`/`<script>`. Almost identical in shape to Markdown frontmatter + a Vue/Svelte SFC.

**File extension(s):** `.astro` (also `.md`/`.mdx` frontmatter via `@astrojs/yaml2ts`, separate grammars).

**Highlighting approach & key repos:**
- **TextMate (canonical):** `astro.tmLanguage.json`, scope `source.astro`. Originally in **withastro/language-tools** (`packages/vscode/syntaxes`); that repo was **archived 2025-11-17** and moved into **withastro/astro** at `packages/language-tools/vscode/syntaxes/`. Backed by `@astrojs/language-server` adding **semantic tokens**.
- **tree-sitter:** **virchau13/tree-sitter-astro** (needs tree-sitter-typescript/-css/-html). No canonical Monarch grammar.

**Embedded languages / structure:** Frontmatter → `source.tsx`/`source.ts`; template expressions `{…}` → `source.tsx`; `<style>` → css/scss/sass/less/postcss by `lang`; `<script>` → js/ts/json by `type`/`lang`; components (capitalized tags) → `support.class.component.astro`.

**Unsolved highlight issues:**
- Any `---` inside frontmatter (string OR comment) is mistaken for the closing fence → false "Expression expected" for the rest of the file — `---` / `const sep = "---";` / `---` — [language-tools#457](https://github.com/withastro/language-tools/issues/457) — closed-at-archive, **structurally unsolved**
- `---` in a JS comment in frontmatter breaks the close fence (hits the official hello-world docs example) — `// between these "---" fences` — [language-tools#248](https://github.com/withastro/language-tools/issues/248) — closed ("has workaround"); same root cause
- Identical token highlighted differently inside vs outside a JSX expression — `<div>word</div>` vs `{true && <div>word</div>}` — [language-tools#714](https://github.com/withastro/language-tools/issues/714) — **closed as "not planned"** (explicit won't-fix)
- `<script>` inside a JSX conditional loses JS tokenization — `{cond ? (<script>…</script>) : null}` — [astro#15439](https://github.com/withastro/astro/issues/15439) — closed by PR #15602 (LSP/scope bug)
- SASS (indented `lang="sass"`/default) style tags not highlighted; only `lang="scss"` works — [tree-sitter-astro#22](https://github.com/virchau13/tree-sitter-astro/issues/22) — **OPEN** (since 2023-12)
- Astro components not visually distinguished from HTML tags (`<MyComp>` vs `<div>`) — [tree-sitter-astro#34](https://github.com/virchau13/tree-sitter-astro/issues/34) — **OPEN**
- HTML entities (`&amp;`) not highlighted (no `entity` node → can't reuse tree-sitter-html queries) — [tree-sitter-astro#36](https://github.com/virchau13/tree-sitter-astro/issues/36) — **OPEN**

**Why it's hard (structural):**
- **Frontmatter fence disambiguation is the headline problem and is genuinely TextMate-unsolvable, provable from the model.** The grammar opens on `\A(-{3})\s*$` and closes on a line-anchored boundary; a TextMate boundary is a per-line regex with no access to the embedded TS tokenizer's lexical state, so it cannot know whether a leading `---` sits inside a TS comment/string — exactly the #248/#457 failure. Distinguishing requires a real TS lexer for the region (why it's pushed to the LSP and remains a perpetual grammar bug).
- A JSX expression `{…}` is a **full TS/TSX region mid-template**, recursively re-entering HTML (`{cond && <div>…</div>}`); brace-balancing + template↔expression↔embedded-script nesting strains line-based scoping.
- The **same literal text legitimately means different things** in different contexts (#714 closed as won't-fix).
- Embedding by attribute (`lang=`/`type=`) multiplies injection rules; gaps (indented SASS, PostCSS) fall through to no grammar.

**Notable:** The frontmatter-fence bug breaks Astro's **own official "Hello World" docs snippet** (#248). Many language-tools issues now show "Closed" but several were **closed by the archive (read-only)**, not fixed — the fence bugs were never structurally resolved at the TM layer. Astro routes template expressions to full `source.tsx`, inheriting all JSX/generic `<…>` tension on top of its fence/embedding problems. tree-sitter-astro's open issues cluster on **embedding + rule reuse** (#22/#34/#36) — the same "share rules across HTML dialects" theme as Monogram's HTML→Vue work.

**Sources:** [language-tools (archived)](https://github.com/withastro/language-tools) · [current grammar home](https://github.com/withastro/astro/tree/main/packages/language-tools/vscode) · [#457](https://github.com/withastro/language-tools/issues/457) [#248](https://github.com/withastro/language-tools/issues/248) [#714](https://github.com/withastro/language-tools/issues/714) [#780](https://github.com/withastro/language-tools/issues/780) [#92](https://github.com/withastro/language-tools/issues/92) · [astro#15439](https://github.com/withastro/astro/issues/15439) · [tree-sitter-astro](https://github.com/virchau13/tree-sitter-astro) ([#22](https://github.com/virchau13/tree-sitter-astro/issues/22) [#34](https://github.com/virchau13/tree-sitter-astro/issues/34) [#36](https://github.com/virchau13/tree-sitter-astro/issues/36)) · [docs/editor-setup](https://docs.astro.build/en/editor-setup/)

---

## Svelte

**What it is:** A compiler-based framework whose `.svelte` files combine an HTML-derived template, Svelte logic blocks, and embedded `<script>`/`<style>`. Svelte 5 added **runes** (`$state`, `$derived`, `$effect`, `$props`, `$bindable`) — compiler-magic identifiers that look like calls but are keywords — plus snippets (`{#snippet}` / `{@render}`).

**File extension(s):** `.svelte` (plus plain `.svelte.js` / `.svelte.ts` modules, out of scope for the component grammar).

**Highlighting approach & key repos:**
- **Canonical TextMate:** `sveltejs/language-tools` → `packages/svelte-vscode/syntaxes/svelte.tmLanguage.src.yaml` (YAML → JSON). Consumed by the official extension, GitHub/Linguist, Shiki, Zed (TM fallback).
- **LSP semantic tokens:** `svelte-language-server` (via `svelte2tsx`).
- **tree-sitter:** `tree-sitter-grammars/tree-sitter-svelte` (supersedes `Himujjal/tree-sitter-svelte`; Zed migrated in PR #17529). No first-party Monarch.

**Embedded languages / structure:** HTML-like template; logic blocks `{#if}/{:else if}/{#each}/{#await}/{#key}/{#snippet}`; tag-expressions `{@html}/{@render}/{@const}/{@debug}`; mustache `{expr}`; `<script>` and `<script context="module">` / Svelte 5 `<script module>` (JS/TS); `<style>` (CSS/SCSS/LESS/PostCSS via `lang`); directive values (`on:`/`bind:`/`class:`/`style:`/`use:`/`transition:`) containing JS. A single line can transition host → block-keyword → embedded TS and back.

**Unsolved highlight issues:**
- Runes get **no dedicated scope** — `$state`/`$derived`/`$props` are left to the embedded TS grammar (only a generic `$myStore` store-accessor match exists), so runes aren't distinguished from stores or ordinary `$`-idents — `let count = $state(0)` — (no tracking issue; confirmed by reading the grammar) — by-design gap
- `{#each}` without an `as` clause highlights incorrectly — `{#each x as}` (vs `{#each x as _}`) — [language-tools#2829](https://github.com/sveltejs/language-tools/issues/2829) — **OPEN** (filed by Rich-Harris; notes GitHub's highlighter has the same bug)
- `:global()` nested selector keeps lexing as the style language past `</style>`, bleeding LESS/SCSS scopes onto following markup — `<style lang="less"> div { :global(.demo) { … } } </style>` then `<div class="demo">` — [language-tools#2650](https://github.com/sveltejs/language-tools/issues/2650) — **OPEN** (labeled bug + upstream)
- CSS `@property` at-rule breaks highlighting from its closing brace onward, including the `/` in `</style>` — `<style>@property --deg { syntax:"<angle>"; }</style>` — [language-tools#2692](https://github.com/sveltejs/language-tools/issues/2692) — **OPEN** (upstream — VS Code CSS grammar)
- HTML comment inside `<template>` breaks highlighting — `<template><!--<div></div>--></template>` — [language-tools#2663](https://github.com/sveltejs/language-tools/issues/2663) — **OPEN**
- Multi-line attributes on `<style>`/`<script>` (Prettier `singleAttributePerLine`) defeat `lang=` detection → SCSS/TS embedding lost — `<style\n lang="scss"\n global\n>` — [language-tools#1685](https://github.com/sveltejs/language-tools/issues/1685) — **OPEN** (line-anchored TM limit)
- (tree-sitter) `{:else if}` not highlighted like `{#if}` — [tree-sitter-svelte#14](https://github.com/tree-sitter-grammars/tree-sitter-svelte/issues/14) — **OPEN**
- (tree-sitter) `{#snippet foo({ bar })}` params tokenized as a call, not a definition; should defer to TS like `{@render}` does — [tree-sitter-svelte#10](https://github.com/tree-sitter-grammars/tree-sitter-svelte/issues/10) — **OPEN**

**Why it's hard (structural):**
- **Embedding-boundary leakage is the dominant failure mode.** The hard part isn't lexing CSS/TS, it's *re-detecting the close tag* while the sub-grammar is mid-construct. `:global()`/`@property` (#2650/#2692) leak because the style sub-grammar's brace/selector state swallows the `/` of `</style>` — the same class as Monogram's #2060 same-line-close.
- **Snippet generics vs arrow-function lookahead.** The grammar carries an explicit comment: `{#snippet foo<T>(…)}` makes `source.ts` think "function definition," enter arrow parsing, and **scan past the `}` snippet-open** to find `=>`, corrupting the file. The fix is a manual identifier/generics/params pattern split — fragile and construct-specific (tree-sitter hasn't solved it, #10).
- **Runes are magic identifiers, not syntax.** `$state(0)` is lexically ident + call; only the compiler knows it's a keyword — beyond a context-free token grammar without a hardcoded name list.
- **Multi-line tag attributes** repeatedly break because TM rules are line-anchored.

**Notable:** The leak bugs are **labeled fixable** (`upstream`), not declared a TextMate ceiling — concrete attackable targets. The snippet/arrow hazard is documented **in the grammar source with a frank comment**. Maintainers acknowledge the limits: [#2997](https://github.com/sveltejs/language-tools/issues/2997) ("Svelte maintained tree-sitter grammar") and [#1828](https://github.com/sveltejs/language-tools/issues/1828) (HTML comment with `*/` — labeled **limitation + wontfix**). tree-sitter's analogous seam: embedded text must be a valid top-level node, so `T extends string` in an attribute can't be injected as TS (upstream tree-sitter#3625).

**Sources:** [svelte.tmLanguage.src.yaml](https://github.com/sveltejs/language-tools/blob/master/packages/svelte-vscode/syntaxes/svelte.tmLanguage.src.yaml) · [#2829](https://github.com/sveltejs/language-tools/issues/2829) [#2650](https://github.com/sveltejs/language-tools/issues/2650) [#2692](https://github.com/sveltejs/language-tools/issues/2692) [#2663](https://github.com/sveltejs/language-tools/issues/2663) [#1685](https://github.com/sveltejs/language-tools/issues/1685) [#1828](https://github.com/sveltejs/language-tools/issues/1828) [#2997](https://github.com/sveltejs/language-tools/issues/2997) · tree-sitter-svelte [#14](https://github.com/tree-sitter-grammars/tree-sitter-svelte/issues/14) [#10](https://github.com/tree-sitter-grammars/tree-sitter-svelte/issues/10) [#16](https://github.com/tree-sitter-grammars/tree-sitter-svelte/issues/16) · [zed#17529](https://github.com/zed-industries/zed/pull/17529) · [tree-sitter#3625](https://github.com/tree-sitter/tree-sitter/issues/3625)

---

## YAML

**What it is:** A human-readable data-serialization language used heavily for config (GitHub Actions, Kubernetes/Helm, Ansible, Docker Compose, frontmatter). Strongly indentation-sensitive, with a large surface: block vs flow collections, six string-quoting styles, block scalars with chomping/indent indicators, anchors/aliases, merge keys, tags.

**File extension(s):** `.yaml`, `.yml` (plus frontmatter inside `.md`/`.markdown`/`.astro`/`.mdx`).

**Highlighting approach & key repos:** Coloring is TextMate-grammar based. Canonical grammar: `Syntaxes/YAML.tmLanguage` in **textmate/yaml.tmbundle**; VS Code ships a JSON derivative (`extensions/yaml/syntaxes/yaml.tmLanguage.json`). **redhat-developer/vscode-yaml** adds an LSP (validation/completion) but **does not replace coloring** — highlighting still comes from the built-in TextMate grammar. tree-sitter: **ikatyang/tree-sitter-yaml** → **tree-sitter-grammars/tree-sitter-yaml** (actively maintained; ~66% C due to a hand-written external scanner for indentation/block scalars). Monaco has a separate Monarch definition.

**Embedded languages / structure:** Two directions. (1) YAML **as** the embedded language — frontmatter inside Markdown/Astro/MDX/Slidev/Jekyll, injected via TextMate `injections` into `meta.embedded`/`source.yaml`. (2) Other languages **inside** YAML block scalars — shell in GitHub Actions `run: |`, JS/JSON/Bash in config, cloud-init `#cloud-config` (YAML-in-YAML). tree-sitter handles the latter via injection queries on the block-scalar node (often needing `#offset!`); **TextMate largely cannot** route block-scalar contents to another grammar because the content boundary is indentation-defined, not delimiter-defined.

**Unsolved highlight issues:**
- Literal/folded block scalars (`|`, `>`) flag valid verbatim content (backslashes, escapes) as invalid — `testAssemblyVer2: |` then `\*\*\\$(BuildConfiguration)\\\*test\*.dll` — [textmate/yaml.tmbundle#26](https://github.com/textmate/yaml.tmbundle/issues/26) — **OPEN** (dup [vscode#54219](https://github.com/microsoft/vscode/issues/54219))
- Colon inside a block-scalar/multiline value mis-parsed as a key:value separator — `bar: |` / `set_header 'Server: '` — [textmate/yaml.tmbundle#17](https://github.com/textmate/yaml.tmbundle/issues/17) — **OPEN**
- Empty block (`key:` with no child) doesn't terminate, so following non-indented comments are colored as string — `someKey:` / `# comment shown orange` / `nextKey: value` — [textmate/yaml.tmbundle#33](https://github.com/textmate/yaml.tmbundle/issues/33) — **OPEN**
- Plain multiline flow scalar: a continuation line starting with `|` (valid plain text) flagged illegal — [vscode#134264](https://github.com/microsoft/vscode/issues/134264) — closed as upstream-grammar (effectively **unfixed**)
- General string corner cases — [textmate/yaml.tmbundle#29](https://github.com/textmate/yaml.tmbundle/issues/29) — **OPEN**
- Keys colliding with keyword literals colored as keywords, not keys (notably `on:` in GitHub Actions; also `true`/`false`/`null`/`yes`/`no`) — `on: push` — [textmate/yaml.tmbundle#34](https://github.com/textmate/yaml.tmbundle/issues/34) — closed/known-limitation
- No coloring for embedded languages in block scalars (JS/JSON/Bash in `key: |`); request to honor `# yaml-language-server: $language=…` — [redhat-developer/vscode-yaml#943](https://github.com/redhat-developer/vscode-yaml/issues/943) — **OPEN**
- YAML-in-YAML injection (cloud-init in a block scalar) crashes the tree-sitter host with stack overflow — [nvim-treesitter#6850](https://github.com/nvim-treesitter/nvim-treesitter/issues/6850) — closed (injection-config limit)

**Why it's hard (structural):** YAML is **indentation-sensitive and CFG-incomplete for a line/regex engine**. A TextMate grammar tokenizes line-by-line with a small state stack and has **no notion of the current indentation column** — which is exactly what determines (a) where a block scalar ends, (b) whether a `key:`-block is empty, (c) whether a continuation line belongs to a plain multiline scalar or starts a new mapping. Block-scalar bodies = "all following lines indented more than the parent," a count-relative-to-an-earlier-line condition regex cannot express; grammars approximate with fixed-indent `while`/`end`, over/under-matching. **Strongly argued but not formally "proven impossible"** — VS Code closes these as upstream limits. tree-sitter sidesteps via a stateful **external C scanner** (why the maintained grammar is ~66% C and *can* inject into block scalars).

**Notable:** The same root cause (no indent context) manifests as four different-looking bugs — invalid-escape, colon-as-key, pipe-as-illegal, orange-comments-after-empty-key — and MS routes them all to the **immutable tmbundle**, several **open since 2016–2018**. The `on:`-as-keyword bug is striking because YAML has *no reserved words at all* — pure heuristic collision with Actions' most common key. There is **no widely deployed semantic-token YAML highlighter** — TM is the production ceiling everywhere it matters.

**Sources:** tmbundle [#17](https://github.com/textmate/yaml.tmbundle/issues/17) [#26](https://github.com/textmate/yaml.tmbundle/issues/26) [#29](https://github.com/textmate/yaml.tmbundle/issues/29) [#33](https://github.com/textmate/yaml.tmbundle/issues/33) [#34](https://github.com/textmate/yaml.tmbundle/issues/34) · [YAML.tmLanguage](https://github.com/textmate/yaml.tmbundle/blob/master/Syntaxes/YAML.tmLanguage) · vscode [#83709](https://github.com/microsoft/vscode/issues/83709) [#134264](https://github.com/microsoft/vscode/issues/134264) [#54219](https://github.com/microsoft/vscode/issues/54219) · [vscode-yaml#943](https://github.com/redhat-developer/vscode-yaml/issues/943) · [tree-sitter-grammars/tree-sitter-yaml](https://github.com/tree-sitter-grammars/tree-sitter-yaml) · [nvim-treesitter#6850](https://github.com/nvim-treesitter/nvim-treesitter/issues/6850)

---

## Markdown

**What it is:** CommonMark and GitHub-Flavored Markdown (GFM: tables, strikethrough, task lists, autolinks). Its precise tokenization is defined by a multi-pass reference algorithm (block structure first, then inline), not a CFG.

**File extension(s):** `.md`, `.markdown`, `.mdown`, `.mkd` (and `.mdx`, separate grammar).

**Highlighting approach & key repos:**
- **TextMate (canonical for VS Code):** `microsoft/vscode-markdown-tm-grammar` → `syntaxes/markdown.tmLanguage` (scope `text.html.markdown`; it's `text.html.*` because it must handle embedded HTML). Fenced-code highlighting works by **injection**: one `begin/end` rule per bundled language whose info-string matches a hardcoded list.
- **tree-sitter:** `tree-sitter-grammars/tree-sitter-markdown` (orig. `MDeiml/`). Famously **split into a block grammar + an inline grammar** mirroring the CommonMark two-phase algorithm. Cannot inject sub-grammars into fences in WASM (relies on unexported C functions → static linking).
- **Monarch:** Monaco ships a simpler, lower-fidelity tokenizer (no per-language fence injection by default).

**Embedded languages / structure:** (a) **Fenced code blocks** inject a sub-language by info string; (b) **inline + block HTML** embedded directly; (c) GFM inline structure. tree-sitter parses with the block grammar, then re-parses with the inline grammar restricted via `ts_parser_set_included_ranges` — the document is scanned twice.

**Unsolved highlight issues:**
- Adjacent bold/italic leaves the parser stuck in italic mode — `**Abc**_ObjectAction_` — [vscode-markdown-tm-grammar#7](https://github.com/microsoft/vscode-markdown-tm-grammar/issues/7) — **OPEN** since 2016, "help wanted"
- Combined bold+italic doesn't apply both scopes (TM emphasis scopes don't nest) — `***text***` — [#69](https://github.com/microsoft/vscode-markdown-tm-grammar/issues/69) — **OPEN**
- Multiple emphasized spans on one line break highlighting for the rest of the line — `*a*, *b*, *c*` — [#1](https://github.com/microsoft/vscode-markdown-tm-grammar/issues/1), [vscode#9075](https://github.com/microsoft/vscode/issues/9075) — long-standing
- Intraword underscores not italicized — [#45](https://github.com/microsoft/vscode-markdown-tm-grammar/issues/45) — **OPEN**
- Emphasis/strong/code don't continue across a line break — [#36](https://github.com/microsoft/vscode-markdown-tm-grammar/issues/36) — **OPEN**
- Nested ordered-list indentation breaks downstream highlighting of headings/fences/checkboxes — [#172](https://github.com/microsoft/vscode-markdown-tm-grammar/issues/172) — **OPEN**
- Fences inside list items lose highlighting at 4-space indent (3 or 5 work) — [#6](https://github.com/microsoft/vscode-markdown-tm-grammar/issues/6), [vscode#50993](https://github.com/microsoft/vscode/issues/50993) — long-standing
- Markdown highlighting fails immediately after an inline HTML tag — [#85](https://github.com/microsoft/vscode-markdown-tm-grammar/issues/85) — **OPEN**
- Known-but-unbundled fence languages don't highlight unless the grammar is hand-patched — ` ```julia ` — [vscode#71888](https://github.com/microsoft/vscode/issues/71888) — closed "extension-candidate" but limitation persists
- (tree-sitter) HTML block type 4 (`<!`) consumes the rest of the document — [tree-sitter-markdown#233](https://github.com/tree-sitter-grammars/tree-sitter-markdown/issues/233) — **OPEN**
- (tree-sitter) single-tilde strikethrough greedily pairs unrelated tildes — `~a ~b ~c` — [#236](https://github.com/tree-sitter-grammars/tree-sitter-markdown/issues/236) — **OPEN**
- (tree-sitter) pipe-table parsing inconsistent (empty cells, whitespace) — [#242](https://github.com/tree-sitter-grammars/tree-sitter-markdown/issues/242) — **OPEN**

**Why it's hard (structural):** CommonMark is genuinely context-sensitive, beyond a line-oriented regex grammar:
1. **Emphasis is decided by delimiter-run flanking + a global stack-based "process emphasis" pass** (run lengths, `(open+close) % 3`). TextMate has no stack across runs, so #7/#69/#45/#1 are all symptoms of the same missing model. **Near-proven** hard.
2. **Container blocks carry indentation/marker context across many lines** (lazy continuation, render-irrelevant indentation) — a stack the line-based grammar doesn't maintain (#172/#6). tree-sitter needs a hand-written scanner with serialized state.
3. **Setext headings are retroactive** — a line is a paragraph until a following `===`/`---` reclassifies it (backward dependency a forward scanner can't resolve).
4. **HTML blocks have 7 start/end types** (type 4 ends at a blank line); getting the end wrong swallows the document (#233).
5. **Fence injection is closed-world** — unbundled languages silently fail (#71888); info-string variants (`{attr}`, `.lang`, `title=`) defeat lang extraction (#62).

**Notable:** The tree-sitter maintainers **disclaim correctness** ("not recommended where correctness is important") — unusual candor that markdown is at/near the practical ceiling for *both* formalisms. The block/inline split is a direct admission single-pass is insufficient. VS Code closed [vscode#280872](https://github.com/microsoft/vscode/issues/280872) (markdown highlighted *inside* a ` ```markdown ` fence) as **"as-designed"** — the self-injection / host==embedded degenerate case directly relevant here. The worst emphasis bugs (#7/#1, 2016) remain open with "help wanted" — model-limited, not neglect; the CommonMark spec has ~10-year-old open discussions on the same flanking problem ([commonmark-spec#310](https://github.com/commonmark/commonmark-spec/issues/310)).

**Sources:** [vscode-markdown-tm-grammar](https://github.com/microsoft/vscode-markdown-tm-grammar) (issues [#7](https://github.com/microsoft/vscode-markdown-tm-grammar/issues/7) [#69](https://github.com/microsoft/vscode-markdown-tm-grammar/issues/69) [#45](https://github.com/microsoft/vscode-markdown-tm-grammar/issues/45) [#36](https://github.com/microsoft/vscode-markdown-tm-grammar/issues/36) [#172](https://github.com/microsoft/vscode-markdown-tm-grammar/issues/172) [#6](https://github.com/microsoft/vscode-markdown-tm-grammar/issues/6) [#85](https://github.com/microsoft/vscode-markdown-tm-grammar/issues/85) [#56](https://github.com/microsoft/vscode-markdown-tm-grammar/issues/56) [#120](https://github.com/microsoft/vscode-markdown-tm-grammar/issues/120) [#62](https://github.com/microsoft/vscode-markdown-tm-grammar/issues/62) [#1](https://github.com/microsoft/vscode-markdown-tm-grammar/issues/1)) · vscode [#71888](https://github.com/microsoft/vscode/issues/71888) [#9075](https://github.com/microsoft/vscode/issues/9075) [#50993](https://github.com/microsoft/vscode/issues/50993) [#280872](https://github.com/microsoft/vscode/issues/280872) · [tree-sitter-markdown](https://github.com/tree-sitter-grammars/tree-sitter-markdown) ([#233](https://github.com/tree-sitter-grammars/tree-sitter-markdown/issues/233) [#236](https://github.com/tree-sitter-grammars/tree-sitter-markdown/issues/236) [#242](https://github.com/tree-sitter-grammars/tree-sitter-markdown/issues/242)) · [CommonMark spec §6.2](https://spec.commonmark.org/) · [commonmark-spec#310](https://github.com/commonmark/commonmark-spec/issues/310)

---

## Ripple

**What it is:** A fine-grained-reactive TypeScript UI framework by Dominic Gannaway (`@trueadm`, ex-Svelte 5 / React / Inferno / Lexical), first public ~2025. Defines a TS *superset* combining TypeScript + JSX-like templates + reactivity primitives. In 2026 its language layer was rebranded **TSRX** ("TypeScript Render Extensions") and made multi-target (compiles to Ripple/React/Solid). Canonical repo **`Ripple-TS/ripple`** (old `trueadm/ripple` redirects here), ~7.4k stars, actively developed.

**File extension(s):** **`.tsrx`** (current; language id `ripple`, aliases `TSRX`/`tsrx`/`Ripple`). Originally **`.ripple`**, renamed during the 2026 TSRX rebrand.

**Highlighting approach & key repos** (all inside `Ripple-TS/ripple`):
- **VS Code extension** `packages/vscode-plugin` — ships TextMate grammar `syntaxes/tsrx.tmLanguage.json` (scope `source.tsrx`) **plus** a Volar-based **language server** (`packages/language-server`) for semantic tokens/diagnostics/IntelliSense.
- The TextMate grammar is a **fork of `microsoft/TypeScript-TmLanguage`** (~351 KB) re-scoped to `source.tsrx` + Ripple constructs + embedded-language injections.
- **tree-sitter** grammar (`packages/tree-sitter`) consumed by `zed-plugin`/`nvim-plugin` via `.scm` queries. Also IntelliJ/Sublime plugins + a standalone `Ripple.tmbundle`.

**Embedded languages / structure:** `embeddedLanguages` covers exactly the host+template+reactivity case: `source.css` (scoped `<style>`), and many JS/JSX/TSX embeds (`meta.jsx.children.js`→javascriptreact, `meta.tsx.children.js`→typescriptreact, `meta.embedded.expression.js`→javascriptreact). TS host, JSX-like template children, `{ }` expression islands, embedded CSS. Reactivity uses `track()` + a lazy-destructure sigil `let &[count] = track(0)`; older issues show a `component` keyword form (`component Card() { <div>…</div> }`).

**Unsolved highlight issues:**
- `pending`/`catch` keywords of an `AsyncComponent` not highlighted (missing from the grammar); a partial fix landed in the **VS Code** grammar but didn't propagate to Neovim/others — [Ripple-TS/ripple#762](https://github.com/Ripple-TS/ripple/issues/762) — **OPEN**
- No IntelliSense/embedding inside `<script>` tags (a Volar embed exists for `<style>`→CSS but the `ScriptContent` equivalent is unbuilt) — [#615](https://github.com/Ripple-TS/ripple/issues/615) — **OPEN**
- GitHub/Linguist doesn't recognize `.tsrx`, so source renders unhighlighted on GitHub — [#1067](https://github.com/Ripple-TS/ripple/issues/1067) — **OPEN** (workaround: `*.tsrx linguist-language=TSX` in `.gitattributes`)
- No `ast-grep`/structural-search support for `.tsrx` — [#1163](https://github.com/Ripple-TS/ripple/issues/1163) — **OPEN**
- Comments in `jsx.children` mis-tokenized: `Cmd+/` produced `{ /* … */ }` the compiler emitted as broken JS — [#585](https://github.com/Ripple-TS/ripple/issues/585) — CLOSED (host/template comment-context fragility)
- Zed extension shipped with no highlighting (missing tree-sitter `.scm` queries) — [#653](https://github.com/Ripple-TS/ripple/issues/653) — CLOSED

**Why it's hard (structural):** Same frontier as Monogram — a TS superset host with JSX-like template children, `{ }` expression islands, embedded scoped CSS, and reactivity sigils. The TextMate approach is **fork-and-patch of the TS+JSX grammar**, so every Ripple-specific keyword must be hand-added, and #762 shows the classic failure: a keyword missing from the regex grammar **plus drift across editors** (a fix landing in TextMate JSON but not in the tree-sitter `.scm` queries that Zed/Neovim use — *two independent* highlighter implementations). Real highlighting/IntelliSense lives in the Volar LSP, so embedding new sub-languages (#615) needs a new Volar virtual-code embed, not a grammar tweak. **No "impossible in TextMate" claim is made or proven** — the open issues are unimplemented coverage + cross-engine propagation, not expressiveness ceilings.

**Notable:** The `.ripple`→`.tsrx` rename + TSRX rebrand is the key fact (much tooling/docs still say `.ripple`). The grammar is **not bespoke** — Microsoft's TS-TmLanguage forked + re-scoped, inheriting TS/JSX "for free" but carrying Ripple additions by hand. **Two parallel highlighter implementations** (TextMate + tree-sitter) plus a Volar LSP → fixes don't auto-propagate (#762, #653). Despite broad editor coverage, the ecosystem is genuinely immature and in flux (recent rebrand, Linguist not onboarded).

**Sources:** [Ripple-TS/ripple](https://github.com/Ripple-TS/ripple) · `packages/vscode-plugin/package.json` · [Ripple.tmbundle grammar](https://github.com/Ripple-TS/ripple/blob/main/assets/Ripple.tmbundle/Syntaxes/ripple.tmLanguage) · issues [#762](https://github.com/Ripple-TS/ripple/issues/762) [#615](https://github.com/Ripple-TS/ripple/issues/615) [#1067](https://github.com/Ripple-TS/ripple/issues/1067) [#1163](https://github.com/Ripple-TS/ripple/issues/1163) [#585](https://github.com/Ripple-TS/ripple/issues/585) [#653](https://github.com/Ripple-TS/ripple/issues/653) · [ripple-ts.com/docs](https://www.ripple-ts.com/docs/introduction)

---

## Vue Vine

**What it is:** An alternative Vue authoring style where each component is a plain TypeScript function (a "Vine Component Function") that returns its template as a `vine` *tagged template literal*: `return vine\`<template/>\``. Logic, template, styles (`vineStyle(css\`…\`)`), and macros (`vineProp`, `vineEmits`, `vineExpose`, `vineSlots`, `vineOptions`) all live in one TS function; multiple components per file. Backed by a compiler + Volar language server. ~1.4k stars, actively maintained.

**File extension(s):** `*.vine.ts` (the file *is* TypeScript — "any valid TypeScript is valid for Vine"). The `vine`/`vineStyle`/`vineProp` macros are ambient declarations from `vue-vine/macros`, no runtime impl.

**Highlighting approach & key repos:** Hybrid — TextMate **injection** grammars for fast coloring + **Volar/LSP semantic tokens** for accuracy. Repo `vue-vine/vue-vine` (monorepo); extension `packages/vscode-ext` (`shenqingchuan.vue-vine-extension`). The TextMate layer is **four custom grammars** (NOT the official Vue grammar):
- `vine-inject.json` (`injectTo: source.ts`, selector `L:meta.function`/`L:meta.arrow.ts`): matches `vine\`` → embeds `source.vine-vue-template`; matches `vineProp(...)`/`vineStyle...(...)` → embeds `source.ts`/`source.css`(+scss/sass/less/stylus/postcss). The host→template bridge.
- `vine-vue-template.json` (`source.vine-vue-template`): a **forked** Vue-template grammar.
- `vue-interpolations.json` (`{{ }}`) and `vue-directives.json` (`v-`/`:`/`@`), each `injectTo: source.vine-vue-template`.
Semantics live in `packages/language-server` (built on `@volar/language-service`, `volar-service-html`, `@vue/language-core`). Vine is **not** in `vuejs/language-tools`; it's a separate parallel Volar consumer.

**Embedded languages / structure:** Three-deep nesting — **Vue template grammar inside a JS/TS tagged template-literal token inside TypeScript**, and separately **CSS/SCSS/Sass/Less/Stylus/PostCSS inside `vineStyle(...)`** inside TS. Inside the template: `{{ }}` interpolations (TS) and directive values (`:foo="expr"`). Worst case: TS → template → interpolation-TS (host re-entry two levels down).

**Unsolved highlight issues:**
- **Documented IDE limitation: backtick/`${}` interpolation inside a template attribute breaks highlighting** — `vine\`<a :href="/user/${userName}">Profile</a>\`` — [docs: specification/overview](https://vue-vine.dev/specification/overview) — *acknowledged in official docs*: "IDE can't highlight the template part correctly like this." `${}` in `vine` templates is **forbidden by design** (collides with JS template-literal interpolation); recommended fix is to hoist to a variable. The canonical unsolved case.
- **Multiline / non-same-line tag pairs not highlighted as tags** — tags matched with same-line lookahead `(<)([A-Z]…)(?=[^>]*></\2>)` — *inherent TextMate limit*, same class as Vetur [vuejs/vetur#1211](https://github.com/vuejs/vetur/issues/1211)
- **Injection runs in EVERY TS function** → any identifier literally named `vine\`` or `vineStyle(...)` gets template/CSS coloring regardless of import — *structural*; only the language service (which knows real bindings) disambiguates
- **Directive injection had to be carved out of JSX/TSX** — `vue-directives.json` selector ends `… -source.tsx -source.js.jsx` — *latent collision*: evidence injecting a Vue grammar into TS fights TS/JSX; the "fix" is an exclusion list
- **`vineStyle(less\`…\`)` preprocessors historically mishandled** — [vue-vine#138](https://github.com/vue-vine/vue-vine/issues/138) — CLOSED (now via `source.css.less`); each new preprocessor must be hand-added
- **In-template Tailwind/UnoCSS class strings get no class coloring** — `vine\`<div class="h-40 bg-red">\`` — [vue-vine#162](https://github.com/vue-vine/vue-vine/issues/162) — CLOSED (needs UnoCSS ext to target the Vine scope)
- **No standalone tree-sitter or Monarch grammar for `.vine.ts`** — GitHub/Linguist, CodeMirror, Shiki-without-the-custom-grammar fall back to plain TS and show the `vine\`…\`` body as an undifferentiated string — *gap*: highlighting is effectively VS-Code-extension-only

> As of June 2026 the **open** tracker has essentially **no open pure-TextMate-highlighting bugs** — the grammar is actively maintained and most coloring issues get closed. The durable problems are the *inherent* ones above.

**Why it's hard (structural):** The `vine\`…\`` body is one JS template-string token to the host tokenizer; re-entering with a *different* (Vue) grammar requires injection that must (a) find the template with no reliable anchor (only the literal name `vine`, no import awareness), (b) avoid colliding with TS/JSX (hence `-source.tsx` exclusions), (c) stop exactly at the closing backtick. Worse, a Vue template may want JS interpolation, but `${}` is the JS template-literal's *own* interpolation delimiter — inner expression and outer string fight over the same tokens, the case the docs admit can't be highlighted. Multiline tags hit the classic begin/end limit. CSS-in-`vineStyle` is a second parallel tagged-template embed enumerating every preprocessor. **None claimed "impossible in TextMate"** by maintainers; handled pragmatically (custom grammar + exclusion lists), residue offloaded to Volar for semantic tokens — i.e. correctness comes from the language service, not the grammar.

**Notable:** The limitation is **self-documented** — the spec page renders the broken case and says the IDE "can't highlight" it. The TextMate layer **forks** a Vue template grammar under a private scope (`source.vine-vue-template`), so upstream Vue highlighting improvements don't propagate. `vine-inject.json` targets `source.ts` (not `.tsx`) + the directive grammar's `-source.tsx` exclusion are concrete evidence TS+JSX is hostile to this injection — the project *sidesteps* rather than solves it. A correctness-by-construction derived highlighter would face the same `${}`-collision and multiline-tag ceilings unless it can express balanced/`while` matching and import-aware anchoring.

**Sources:** [vue-vine/vue-vine](https://github.com/vue-vine/vue-vine) · [syntaxes](https://github.com/vue-vine/vue-vine/tree/main/packages/vscode-ext/syntaxes) (vine-inject / vine-vue-template / vue-interpolations / vue-directives) · [language-server plugins](https://github.com/vue-vine/vue-vine/tree/main/packages/language-server/src/plugins) · [specification/overview](https://vue-vine.dev/specification/overview) · [#138](https://github.com/vue-vine/vue-vine/issues/138) [#162](https://github.com/vue-vine/vue-vine/issues/162) [#108](https://github.com/vue-vine/vue-vine/issues/108) · [vetur#1211](https://github.com/vuejs/vetur/issues/1211)

---

## TSRX

> **Note:** TSRX and **Ripple** share one grammar and tooling surface in the `Ripple-TS/ripple` monorepo (see [§ Ripple](#ripple)). TSRX is the *language* layer; Ripple is one *framework* that consumes it. Treat them as one tooling surface viewed from two angles, not two independent grammars.

**What it is:** **TSRX = "TypeScript Render Extensions"** — a framework-agnostic TypeScript-superset *language* (a JSX successor) by **Dominic Gannaway (@trueadm)**. Embeds declarative UI in TS but, unlike JSX, makes control flow **statement-based** (native `if`/`else`/`for...of`/`switch`/`try`), with co-located scoped `<style>` and mid-template `const` locals. **Extracted from Ripple** and made multi-target: a single `@tsrx/core` parser/compiler feeds plugins `@tsrx/react`, `@tsrx/preact`, `@tsrx/solid`, `@tsrx/vue`, `@tsrx/ripple`. Status: **active alpha** (announced ~Apr 2026; `@tsrx/core` ~0.0.x), syntax in flux. **Identification confidence: high** (NOT a typo for TSX/RxJS/TresJS; the unrelated dormant `debersonpaula/tsrx` "TS+React" boilerplate is ruled out).

**File extension(s):** `.tsrx`. Tightly tied to `.ripple` — TSRX is the language, Ripple the framework; they share one grammar. Linguist doesn't recognize `.tsrx` (workaround `*.tsrx linguist-language=TSX`).

**Highlighting approach & key repos** (all in the **Ripple monorepo**, not a separate TSRX repo):
- **TextMate:** `grammars/textmate/ripple.tmLanguage.json` — `name: "TSRX"`, `scopeName: source.tsrx`, but `fileTypes: ['ripple']`.
- **tree-sitter:** `grammars/tree-sitter/` (`grammar.js` + handwritten `src/scanner.c` + `queries/{highlights,injections,locals,indents,folds,textobjects}.scm`).
- **VS Code:** extension `Ripple-TS.ripple-ts-vscode-plugin`, branded **"TSRX for VS Code"** — TextMate + **Volar** language server for `.tsrx`. Plus Zed / Neovim / IntelliJ / Sublime plugins.

**Embedded languages / structure** (from `queries/injections.scm`): **CSS** into `<style>` `raw_text` (combined injection); **TypeScript** into `template_substitution` interpolations; **TSX** only for explicit `<tsx:react>` namespaced blocks (bare tags/fragments are native TSRX, not JSX); and a **self-injection** of `ripple` into `jsx_text` so statement-like template code (`const`/`if` among JSX children) highlights consistently. Directives `{html …}`, `{text …}`, `{ref …}`, `{style …}` are first-class.

**Unsolved highlight issues:**
- tree-sitter/Neovim doesn't highlight `pending`/`catch` of an `AsyncComponent` (VS Code path patched via PR#764/#779; tree-sitter path unconfirmed) — `try { … } pending { … } catch (e) { … }` — [Ripple-TS/ripple#762](https://github.com/Ripple-TS/ripple/issues/762) — **OPEN**
- No IntelliSense/embedding inside `<script>` blocks (a `<style>`→CSS Volar embed exists; the `ScriptContent` equivalent is unbuilt) — [#615](https://github.com/Ripple-TS/ripple/issues/615) — **OPEN**
- GitHub source view has no native TSRX highlighting; only a TSX fallback; not yet eligible for a Linguist grammar — [#1067](https://github.com/Ripple-TS/ripple/issues/1067) — **OPEN**
- Grammar scope/naming drift unresolved: the rename `ripple.tmLanguage.json`→`tsrx.tmLanguage.json` + embedded scopes `source.js.embedded.ripple`→`…tsrx` was **closed without merging**, so live scopes stay inconsistent (`source.tsrx` grammar still ships `fileTypes:['ripple']` + `.ripple` embedded scope names) — [PR#1151](https://github.com/Ripple-TS/ripple/pull/1151) — **CLOSED (unmerged)**
- Zed extension failed to detect/highlight when `textobjects.scm`/`indents.scm` were present — [#653](https://github.com/Ripple-TS/ripple/issues/653) — CLOSED (fragile cross-editor query portability)
- ast-grep support for `.tsrx` not yet available — [#1163](https://github.com/Ripple-TS/ripple/issues/1163) — **OPEN**

**Why it's hard (structural):** (1) **Moving target** — pre-1.0, actively redesigned; open PRs propose a `---`-fenced script block + `@`-prefixed flow controls ([#1197](https://github.com/Ripple-TS/ripple/pull/1197)), recent merges removed the `component` keyword, removed `<tsx>`, swapped `#style`→`{style}` — every grammar repeatedly breaks. (2) **Statement-in-template** blurs the JS-statement vs JSX-child boundary, forcing the unusual `jsx_text → ripple` self-injection and bespoke keyword highlighting. (3) **Three-way embedding** (TS host + CSS `<style>` + optional TSX islands) with *bare-tag-is-TSRX-not-JSX* disambiguation. (4) **N-engine parity** — TextMate, tree-sitter+C scanner, and Volar must agree across 5 editors; bugs (#762) and query-portability breaks (#653) recur per engine. (5) Auxiliary tooling (ESLint/Prettier/ast-grep/Linguist) lags the language.

**Notable:** TSRX and Ripple are **distinct yet share one grammar** — the TextMate file is *named* "TSRX"/`source.tsrx` while still bound to `.ripple` and carrying `.ripple` embedded scope names. The maintainers literally **document a syntax-highlighting workaround** (Linguist=TSX) as the supported answer. A grammar **self-injecting its own language** into JSX text is uncommon. If a future Monogram ledger lists "Ripple," **TSRX is largely the same surface** — don't double-count.

**Sources:** [tsrx.dev](https://tsrx.dev/) · [Ripple-TS/ripple](https://github.com/Ripple-TS/ripple) (`grammars/textmate/ripple.tmLanguage.json`, `grammars/tree-sitter/queries/injections.scm`) · issues [#762](https://github.com/Ripple-TS/ripple/issues/762) [#615](https://github.com/Ripple-TS/ripple/issues/615) [#1067](https://github.com/Ripple-TS/ripple/issues/1067) [#653](https://github.com/Ripple-TS/ripple/issues/653) [#1163](https://github.com/Ripple-TS/ripple/issues/1163) · [PR#1151](https://github.com/Ripple-TS/ripple/pull/1151) [PR#1197](https://github.com/Ripple-TS/ripple/pull/1197) · [@tsrx/core](https://www.npmjs.com/package/@tsrx/core)

---

## Appendix — research method & caveats

- **9 parallel agents**, one per target; each used WebSearch + WebFetch against official docs, GitHub issue trackers, and canonical grammar repos, and read grammar source where available.
- **Issue status reflects 2026-06-03.** Several Astro `language-tools` and some other issues show "Closed" but were **closed when their repo was archived (read-only)**, not necessarily fixed — verify per-issue before acting.
- **"Proven vs asserted" was tracked deliberately** (per the project's standard that a TextMate-impossibility must be argued from the model, not guessed). Where a limit is only asserted/empirical (notably Vine's `${}` case), it is flagged as a candidate to *attack* rather than accept.
- This survey deliberately did **not** attempt fixes or measure Monogram against any of these — it is a scouting report to inform target selection.
