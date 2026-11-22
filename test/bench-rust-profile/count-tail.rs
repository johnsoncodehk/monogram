
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
// Copy model of realloc: the new buffer is allocated while the old one is alive (old + new), and
// the old size is copied. A_PEAK above counts a realloc as growing in place.
static A_PEAK_COPY: AtomicI64 = AtomicI64::new(0);
static A_COPIED: AtomicU64 = AtomicU64::new(0);
fn a_live(d: i64) {
    let v = A_LIVE.fetch_add(d, Relaxed) + d;
    A_PEAK.fetch_max(v, Relaxed);
    A_PEAK_COPY.fetch_max(v, Relaxed);
}
// Buffer lengths and capacities the parse leaves behind in the Parser (patched into parse_with).
static PB: [AtomicU64; 4] = [const { AtomicU64::new(0) }; 4]; // scratch len, scratch cap, entries len, entries cap
// Minor / major page faults and max RSS of this process (getrusage, RUSAGE_SELF).
#[repr(C)]
struct Rusage { ut: [i64; 2], st: [i64; 2], maxrss: i64, ixrss: i64, idrss: i64, isrss: i64, minflt: i64, majflt: i64, rest: [i64; 8] }
extern "C" { fn getrusage(who: i32, u: *mut Rusage) -> i32; }
fn rusage() -> (i64, i64, i64) {
    let mut u = Rusage { ut: [0; 2], st: [0; 2], maxrss: 0, ixrss: 0, idrss: 0, isrss: 0, minflt: 0, majflt: 0, rest: [0; 8] };
    unsafe { getrusage(0, &mut u); }
    (u.minflt, u.majflt, u.maxrss)
}
// One parse_with + drop of what it built, as one bench iteration in bench-tail.rs.
fn fault_parse(src: &str) -> usize {
    let mut b = CstBuilder::default();
    let r = parse_with(src, &mut b);
    let n = b.nodes.len() + r.map_or(0, |_| 1);
    drop(std::hint::black_box(b));
    n
}
// --faults-cold: the first parse in a fresh process (nothing allocated before it but the source);
// --faults-warm: 3 warm-up parses, then the mean of 10 (each drops its buffers, as the bench loop does).
fn faults_main(mode: &str, path: &str) {
    let src = std::fs::read_to_string(path).unwrap();
    if mode == "--faults-cold" {
        let (f0, m0, _) = rusage();
        std::hint::black_box(fault_parse(&src));
        let (f1, m1, rss) = rusage();
        println!("FAULTS cold {} minflt={} majflt={} maxrss_kb={}", path, f1 - f0, m1 - m0, rss);
    } else {
        for _ in 0..3 { std::hint::black_box(fault_parse(&src)); }
        let (f0, m0, _) = rusage();
        for _ in 0..10 { std::hint::black_box(fault_parse(&src)); }
        let (f1, m1, rss) = rusage();
        println!("FAULTS warm {} minflt_per_parse={:.1} majflt={} maxrss_kb={}", path, (f1 - f0) as f64 / 10.0, m1 - m0, rss);
    }
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
            if n > l.size() { A_BYTES.fetch_add((n - l.size()) as u64, Relaxed); A_COPIED.fetch_add(l.size() as u64, Relaxed); }
            A_PEAK_COPY.fetch_max(A_LIVE.load(Relaxed) + n as i64, Relaxed);
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
    let lex_copy = (A_PEAK_COPY.swap(0, Relaxed), A_COPIED.swap(0, Relaxed));
    A_LIVE.store(0, Relaxed);
    // the parse, armed
    ARMED.store(true, Relaxed);
    let mut b = CstBuilder::default();
    let r = parse_with(&src, &mut b);
    ARMED.store(false, Relaxed);
    let retained = A_LIVE.load(Relaxed);
    let parse_copy = (A_PEAK_COPY.load(Relaxed), A_COPIED.load(Relaxed));
    println!(
        "BUFS {} toks_len={} toks_cap={} tok_size={} nodes_len={} nodes_cap={} node_size={} kids_len={} kids_cap={} scratch_len={} scratch_cap={} entries_len={} entries_cap={} entry_size={} \
         peak_live_copy_bytes={} realloc_copied_bytes={} lex_peak_live_copy_bytes={} lex_realloc_copied_bytes={}",
        path, b.toks.len(), b.toks.capacity(), std::mem::size_of::<Tok>(), b.nodes.len(), b.nodes.capacity(), std::mem::size_of::<Node>(),
        b.kids.len(), b.kids.capacity(), PB[0].load(Relaxed), PB[1].load(Relaxed), PB[2].load(Relaxed), PB[3].load(Relaxed), std::mem::size_of::<EntryMeta>(),
        parse_copy.0, parse_copy.1, lex_copy.0, lex_copy.1,
    );
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
    let args: Vec<String> = std::env::args().collect();
    if args.len() == 3 && args[1].starts_with("--faults-") {
        let (m, p) = (args[1].clone(), args[2].clone());
        std::thread::Builder::new().stack_size(1 << 30).spawn(move || faults_main(&m, &p)).unwrap().join().unwrap();
        return;
    }
    std::thread::Builder::new().stack_size(1 << 30).spawn(count_main).unwrap().join().unwrap();
}
