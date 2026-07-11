// ─────────────────────────────────────────────────────────────────────────────
//  gap-issues.ts — RECONCILE GitHub issues from the gap ledger (docs/KNOWN-GAPS.md).
//
//  The deterministic ledger (test/gap-ledger.ts) is the SOURCE OF TRUTH — a committed,
//  fingerprinted list of valid-input flat-highlighter divergences the generative
//  scope≡role check found. This bot projects it onto GitHub issues, IDEMPOTENTLY:
//
//    • a ledger gap with NO open issue  → OPEN one (body carries `<!-- gap-ledger:<id> -->`,
//      the stable fingerprint key, so re-runs never duplicate).
//    • an open `gap-ledger` issue whose fingerprint is NO LONGER in the ledger → CLOSE it
//      (the gap left the ledger — the highlighter was fixed).
//    • a gap already issued → leave it (no-op).
//
//  Because the fingerprint is content-derived and the ledger is deterministic, this is a
//  pure function of (ledger, open issues) → it never spams and auto-closes on fix — the
//  OSS-Fuzz model. The CI workflow (.github/workflows/gap-issues.yml) runs it on a push
//  that changes docs/KNOWN-GAPS.md (and on manual dispatch).
//
//  Run:  node test/gap-issues.ts            # reconcile live (needs `gh` auth / GH_TOKEN)
//        node test/gap-issues.ts --dry-run  # print the plan, touch nothing
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const DRY = process.argv.includes('--dry-run');
const LEDGER = 'docs/KNOWN-GAPS.md';
const LABEL = 'gap-ledger';
const marker = (id: string) => `<!-- gap-ledger:${id} -->`;
const MARKER_RE = /<!-- gap-ledger:([0-9a-f]+) -->/;

interface Gap { id: string; language: string; kind: string; repro: string; tokenType: string; tokenText: string; expected: string; got: string; gotScope: string }

// ── parse the ledger's machine-readable JSON blocks (the same objects gap-ledger.ts emits) ──
function readGaps(): Gap[] {
  const md = readFileSync(LEDGER, 'utf8');
  const out: Gap[] = [];
  const re = /```json\n([\s\S]*?)\n```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md))) {
    try { const g = JSON.parse(m[1]); if (g && g.id && g.language) out.push(g); } catch { /* skip a malformed block */ }
  }
  return out;
}

function gh(args: string[]): string {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
// `gh issue create --label X` requires the label to EXIST — create it once (idempotent: ignore the
// "already exists" error so re-runs are a no-op).
function ensureLabel(): void {
  try { gh(['label', 'create', LABEL, '--color', 'D4C5F9', '--description', 'A valid-input flat-highlighter divergence found by the generative gap ledger (auto-filed/closed)']); }
  catch (e: any) { if (!/already exists/i.test(e?.stderr ?? e?.message ?? '')) throw e; }
}
// open `gap-ledger`-labelled issues → their fingerprint (from the body marker) → issue number
function openIssues(): Map<string, number> {
  const raw = gh(['issue', 'list', '--label', LABEL, '--state', 'open', '--json', 'number,body', '--limit', '500']);
  const arr: { number: number; body: string }[] = JSON.parse(raw || '[]');
  const byId = new Map<string, number>();
  for (const it of arr) { const mm = MARKER_RE.exec(it.body ?? ''); if (mm) byId.set(mm[1], it.number); }
  return byId;
}

function title(g: Gap): string { return `[gap-ledger] ${g.language}: ${g.repro.replace(/\n/g, '\\n').slice(0, 50)}`; }
function body(g: Gap): string {
  return [
    'Auto-filed by the **gap ledger** (`test/gap-ledger.ts` → `docs/KNOWN-GAPS.md`). The generative scope≡role',
    'check found a flat-highlighter divergence from the Monogram parser on **valid input** — the floor-blind',
    'class the corpus-bound scope-gap metric is blind to. **This issue auto-CLOSES when the gap leaves the',
    'ledger** (i.e. when the highlighter is fixed and the next ledger regen drops it).',
    '',
    `- **Language:** ${g.language}`,
    `- **Minimal repro:** \`${g.repro.replace(/\n/g, '\\n')}\``,
    `- **Divergent token:** \`${g.tokenText.replace(/\n/g, '\\n')}\` (parser token \`${g.tokenType}\`)`,
    `- **Role vs scope:** want **${g.expected}**, got **${g.got}** (highlighter scope \`${g.gotScope}\`)`,
    `- **Fingerprint:** \`${g.id}\``,
    '',
    marker(g.id),
  ].join('\n');
}

// ── reconcile ──
const gaps = readGaps();
const ledgerIds = new Set(gaps.map((g) => g.id));

let existing: Map<string, number>;
try {
  existing = openIssues();
} catch (e: any) {
  if (DRY) { existing = new Map(); console.error('(dry-run: `gh` unavailable/unauthed — assuming no existing issues)'); }
  else { console.error('gap-issues: `gh` is required to reconcile live. Authenticate (`gh auth login`) or run with --dry-run.\n' + (e?.message ?? e)); process.exit(1); }
}

const toOpen = gaps.filter((g) => !existing!.has(g.id));
const toClose = [...existing!.entries()].filter(([id]) => !ledgerIds.has(id));

console.log(`gap ledger: ${gaps.length} gap(s) · open issues: ${existing!.size} · to open: ${toOpen.length} · to close: ${toClose.length}${DRY ? '   [DRY-RUN]' : ''}`);

if (!DRY && toOpen.length) ensureLabel();
for (const g of toOpen) {
  console.log(`  + OPEN  ${g.id}  ${title(g)}`);
  if (!DRY) { const url = gh(['issue', 'create', '--title', title(g), '--body', body(g), '--label', LABEL]).trim(); console.log(`         → ${url}`); }
}
for (const [id, num] of toClose) {
  console.log(`  - CLOSE #${num}  (gap ${id} no longer in the ledger — resolved)`);
  if (!DRY) gh(['issue', 'close', String(num), '--comment', `Resolved — gap \`${id}\` is no longer in the ledger (\`docs/KNOWN-GAPS.md\`); the highlighter no longer diverges here. Auto-closed by \`test/gap-issues.ts\`.`]);
}
if (!toOpen.length && !toClose.length) console.log('  (in sync — nothing to do)');
