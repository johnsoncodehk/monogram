
// ---- count driver (appended to the emitted library after patch-count.ts; NOT the profiled build) ----
// Work counts for one parse_with(src, &mut CstBuilder::default()): builder pushes (patched into
// CstBuilder's finish/node/leaf/checkpoint/restore and Parser::peek), nodes discarded by restore,
// nodes left in the arena but unreachable from the root, and heap traffic through a counting
// global allocator armed only around the parse and the drop of what it built.
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering::Relaxed};

struct CountAlloc;
static ARMED: AtomicBool = AtomicBool::new(false);
static A_MALLOC: AtomicU64 = AtomicU64::new(0);
static A_REALLOC: AtomicU64 = AtomicU64::new(0);
static A_FREE: AtomicU64 = AtomicU64::new(0);
static A_BYTES: AtomicU64 = AtomicU64::new(0); // bytes requested by alloc + bytes of growth by realloc
static A_LIVE: AtomicI64 = AtomicI64::new(0);
static A_PEAK: AtomicI64 = AtomicI64::new(0);
fn a_live(d: i64) {
    let v = A_LIVE.fetch_add(d, Relaxed) + d;
    A_PEAK.fetch_max(v, Relaxed);
}
unsafe impl GlobalAlloc for CountAlloc {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        if ARMED.load(Relaxed) { A_MALLOC.fetch_add(1, Relaxed); A_BYTES.fetch_add(l.size() as u64, Relaxed); a_live(l.size() as i64); }
        System.alloc(l)
    }
    unsafe fn alloc_zeroed(&self, l: Layout) -> *mut u8 {
        if ARMED.load(Relaxed) { A_MALLOC.fetch_add(1, Relaxed); A_BYTES.fetch_add(l.size() as u64, Relaxed); a_live(l.size() as i64); }
        System.alloc_zeroed(l)
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        if ARMED.load(Relaxed) { A_FREE.fetch_add(1, Relaxed); a_live(-(l.size() as i64)); }
        System.dealloc(p, l)
    }
    unsafe fn realloc(&self, p: *mut u8, l: Layout, n: usize) -> *mut u8 {
        if ARMED.load(Relaxed) {
            A_REALLOC.fetch_add(1, Relaxed);
            if n > l.size() { A_BYTES.fetch_add((n - l.size()) as u64, Relaxed); }
            a_live(n as i64 - l.size() as i64);
        }
        System.realloc(p, l, n)
    }
}
#[global_allocator]
static GLOBAL: CountAlloc = CountAlloc;

const C_NODE: usize = 0; // nodes pushed (finish + node)
const C_KID: usize = 1; // kid slots pushed
const C_LEAF: usize = 2; // leaf handles pushed onto scratch
const C_CKPT: usize = 3; // checkpoint() calls
const C_RESTORE: usize = 4; // restore() calls
const C_RESTORE_HIT: usize = 5; // restore() calls that discarded >= 1 node or kid
const C_DNODE: usize = 6; // nodes discarded by restore
const C_DKID: usize = 7; // kid slots discarded by restore
const C_MAXN: usize = 8; // arena high-water mark (nodes)
const C_PEEK: usize = 9; // Parser::peek calls
static CNT: [AtomicU64; 10] = [const { AtomicU64::new(0) }; 10];
static DISC_BY_RULE: [AtomicU64; 64] = [const { AtomicU64::new(0) }; 64];
#[inline(always)]
fn cnt_add(i: usize, n: u64) { CNT[i].fetch_add(n, Relaxed); }
#[inline(always)]
fn cnt_node(kids: usize, new_len: usize) {
    cnt_add(C_NODE, 1);
    cnt_add(C_KID, kids as u64);
    CNT[C_MAXN].fetch_max(new_len as u64, Relaxed);
}
fn cnt_restore(nodes: &[Node], ck0: usize, klen: usize, ck1: usize) {
    cnt_add(C_RESTORE, 1);
    let dn = nodes.len().saturating_sub(ck0);
    let dk = klen.saturating_sub(ck1);
    if dn + dk > 0 { cnt_add(C_RESTORE_HIT, 1); }
    cnt_add(C_DNODE, dn as u64);
    cnt_add(C_DKID, dk as u64);
    for nd in &nodes[ck0.min(nodes.len())..] { DISC_BY_RULE[(nd.rule_id as usize).min(63)].fetch_add(1, Relaxed); }
}

fn count_main() {
    let args: Vec<String> = std::env::args().collect();
    let path = &args[1];
    let src = std::fs::read_to_string(path).unwrap();
    // lex alone, armed: its allocation traffic
    ARMED.store(true, Relaxed);
    let t = lex(&src);
    let ntok = t.len();
    drop(t);
    ARMED.store(false, Relaxed);
    let lex_alloc = (A_MALLOC.swap(0, Relaxed), A_REALLOC.swap(0, Relaxed), A_FREE.swap(0, Relaxed), A_BYTES.swap(0, Relaxed), A_PEAK.swap(0, Relaxed));
    A_LIVE.store(0, Relaxed);
    // the parse, armed
    ARMED.store(true, Relaxed);
    let mut b = CstBuilder::default();
    let r = parse_with(&src, &mut b);
    ARMED.store(false, Relaxed);
    let retained = A_LIVE.load(Relaxed);
    let (nodes, kids, toks) = (b.nodes.len(), b.kids.len(), b.toks.len());
    let cap_bytes = b.nodes.capacity() * std::mem::size_of::<Node>() + b.kids.capacity() * 4 + b.toks.capacity() * std::mem::size_of::<Tok>();
    // reachable rule nodes from the root
    let mut seen = vec![false; nodes];
    let mut reach = 0usize;
    let mut reach_leaves = 0usize;
    let mut stack: Vec<i32> = r.into_iter().collect();
    while let Some(h) = stack.pop() {
        if h < 0 { reach_leaves += 1; continue; }
        let i = h as usize;
        if seen[i] { continue; }
        seen[i] = true;
        reach += 1;
        let nd = &b.nodes[i];
        for k in 0..nd.kid_count as usize { stack.push(b.kids[nd.kid_start as usize + k]); }
    }
    let mut orphan_by_rule = [0u64; 64];
    for (i, nd) in b.nodes.iter().enumerate() { if !seen[i] { orphan_by_rule[(nd.rule_id as usize).min(63)] += 1; } }
    ARMED.store(true, Relaxed);
    drop(b);
    ARMED.store(false, Relaxed);
    let c: Vec<u64> = CNT.iter().map(|x| x.load(Relaxed)).collect();
    println!(
        "COUNT {} accept={} bytes={} tokens={} lex_tokens={} final_nodes={} final_kids={} reachable_nodes={} reachable_leaves={} \
         pushed_nodes={} pushed_kids={} leaf_pushes={} checkpoints={} restores={} restores_discarding={} discarded_nodes={} discarded_kids={} \
         arena_high_water_nodes={} peeks={} \
         malloc={} realloc={} free={} alloc_bytes={} peak_live_bytes={} retained_after_parse_bytes={} arena_capacity_bytes={} \
         lex_malloc={} lex_realloc={} lex_free={} lex_alloc_bytes={} lex_peak_live_bytes={}",
        path, r.is_some(), src.len(), toks, ntok, nodes, kids, reach, reach_leaves,
        c[C_NODE], c[C_KID], c[C_LEAF], c[C_CKPT], c[C_RESTORE], c[C_RESTORE_HIT], c[C_DNODE], c[C_DKID],
        c[C_MAXN], c[C_PEEK],
        A_MALLOC.load(Relaxed), A_REALLOC.load(Relaxed), A_FREE.load(Relaxed), A_BYTES.load(Relaxed), A_PEAK.load(Relaxed), retained, cap_bytes,
        lex_alloc.0, lex_alloc.1, lex_alloc.2, lex_alloc.3, lex_alloc.4,
    );
    let mut line = String::from("DISCARDED_BY_RULE");
    for (i, x) in DISC_BY_RULE.iter().enumerate() {
        let v = x.load(Relaxed);
        if v > 0 { line.push_str(&format!(" {}={}", RULE_NAMES.get(i).copied().unwrap_or("?"), v)); }
    }
    println!("{}", line);
    let mut line = String::from("ORPHANED_BY_RULE");
    for (i, v) in orphan_by_rule.iter().enumerate() {
        if *v > 0 { line.push_str(&format!(" {}={}", RULE_NAMES.get(i).copied().unwrap_or("?"), v)); }
    }
    println!("{}", line);
}

fn main() {
    std::thread::Builder::new().stack_size(1 << 30).spawn(count_main).unwrap().join().unwrap();
}
