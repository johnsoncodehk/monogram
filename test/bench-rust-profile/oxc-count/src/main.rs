// oxc-count F: for one parse as in the bench (default config, fresh Allocator): malloc/realloc/free
// calls and bytes (counting global allocator armed around the parse and the drop), the arena's
// used and allocated bytes; then, in separate parses, the token count (TokensParserConfig) and the
// AST node count (every enter_node of oxc_ast_visit::Visit).
// oxc-count --faults fresh|reuse F: 3 warm-up parses, then the mean of 10: minor faults (getrusage),
// allocator calls (malloc + realloc) and bytes per parse. fresh = a new Allocator per parse, dropped
// after it (the bench loop); reuse = one Allocator, reset() before each parse.
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering::Relaxed};

use oxc_allocator::Allocator;
use oxc_ast::AstKind;
use oxc_ast_visit::Visit;
use oxc_parser::Parser;
use oxc_parser::config::TokensParserConfig;
use oxc_span::SourceType;

// The source type the input's extension names, as the monogram side picks its grammar
// (test/bench-rust-profile/run.sh grammar_of): .tsx -> TSX (typescriptreact), .jsx -> JSX
// (javascriptreact), anything else -> TypeScript (the typescript grammar also reads the .js inputs).
fn source_type_of(path: &str) -> SourceType {
    if path.ends_with(".tsx") { SourceType::tsx() } else if path.ends_with(".jsx") { SourceType::jsx() } else { SourceType::ts() }
}

struct CountAlloc;
static ARMED: AtomicBool = AtomicBool::new(false);
static A_MALLOC: AtomicU64 = AtomicU64::new(0);
static A_REALLOC: AtomicU64 = AtomicU64::new(0);
static A_FREE: AtomicU64 = AtomicU64::new(0);
static A_BYTES: AtomicU64 = AtomicU64::new(0);
static A_LIVE: AtomicI64 = AtomicI64::new(0);
static A_PEAK: AtomicI64 = AtomicI64::new(0);
fn a_live(d: i64) {
    let v = A_LIVE.fetch_add(d, Relaxed) + d;
    A_PEAK.fetch_max(v, Relaxed);
}
unsafe impl GlobalAlloc for CountAlloc {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        if ARMED.load(Relaxed) {
            A_MALLOC.fetch_add(1, Relaxed);
            A_BYTES.fetch_add(l.size() as u64, Relaxed);
            a_live(l.size() as i64);
        }
        System.alloc(l)
    }
    unsafe fn alloc_zeroed(&self, l: Layout) -> *mut u8 {
        if ARMED.load(Relaxed) {
            A_MALLOC.fetch_add(1, Relaxed);
            A_BYTES.fetch_add(l.size() as u64, Relaxed);
            a_live(l.size() as i64);
        }
        System.alloc_zeroed(l)
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        if ARMED.load(Relaxed) {
            A_FREE.fetch_add(1, Relaxed);
            a_live(-(l.size() as i64));
        }
        System.dealloc(p, l)
    }
    unsafe fn realloc(&self, p: *mut u8, l: Layout, n: usize) -> *mut u8 {
        if ARMED.load(Relaxed) {
            A_REALLOC.fetch_add(1, Relaxed);
            if n > l.size() {
                A_BYTES.fetch_add((n - l.size()) as u64, Relaxed);
            }
            a_live(n as i64 - l.size() as i64);
        }
        System.realloc(p, l, n)
    }
}
#[global_allocator]
static GLOBAL: CountAlloc = CountAlloc;

struct NodeCount(usize);
impl<'a> Visit<'a> for NodeCount {
    fn enter_node(&mut self, _kind: AstKind<'a>) {
        self.0 += 1;
    }
}

#[repr(C)]
struct Rusage { ut: [i64; 2], st: [i64; 2], maxrss: i64, ixrss: i64, idrss: i64, isrss: i64, minflt: i64, majflt: i64, rest: [i64; 8] }
extern "C" { fn getrusage(who: i32, u: *mut Rusage) -> i32; }
fn rusage() -> (i64, i64) {
    let mut u = Rusage { ut: [0; 2], st: [0; 2], maxrss: 0, ixrss: 0, idrss: 0, isrss: 0, minflt: 0, majflt: 0, rest: [0; 8] };
    unsafe { getrusage(0, &mut u); }
    (u.minflt, u.maxrss)
}

fn faults_main(mode: &str, path: &str) {
    let src = std::fs::read_to_string(path).unwrap();
    let mut keep = Allocator::default();
    let mut once = |reuse: bool| {
        if reuse {
            keep.reset();
            let ret = Parser::new(&keep, &src, source_type_of(path)).parse();
            drop(std::hint::black_box(ret));
        } else {
            let allocator = Allocator::default();
            let ret = Parser::new(&allocator, &src, source_type_of(&path)).parse();
            drop(std::hint::black_box(ret));
            drop(std::hint::black_box(allocator));
        }
    };
    let reuse = mode == "reuse";
    for _ in 0..3 { once(reuse); }
    let (f0, _) = rusage();
    let (m0, r0, b0) = (A_MALLOC.load(Relaxed), A_REALLOC.load(Relaxed), A_BYTES.load(Relaxed));
    ARMED.store(true, Relaxed);
    for _ in 0..10 { once(reuse); }
    ARMED.store(false, Relaxed);
    let (f1, rss) = rusage();
    let calls = (A_MALLOC.load(Relaxed) - m0) + (A_REALLOC.load(Relaxed) - r0);
    println!("OXCFAULTS {} {} minflt_per_parse={:.1} maxrss_kb={} allocs_per_parse={:.1} alloc_bytes_per_parse={:.0}", mode, path,
        (f1 - f0) as f64 / 10.0, rss, calls as f64 / 10.0, (A_BYTES.load(Relaxed) - b0) as f64 / 10.0);
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() == 4 && args[1] == "--faults" {
        let (m, p) = (args[2].clone(), args[3].clone());
        // A large stack, as the monogram count build has: the measured work is the same either way.
        std::thread::Builder::new().stack_size(1 << 30).spawn(move || faults_main(&m, &p)).unwrap().join().unwrap();
        return;
    }
    let path = std::env::args().nth(1).unwrap();
    let src = std::fs::read_to_string(&path).unwrap();
    ARMED.store(true, Relaxed);
    let allocator = Allocator::default();
    let (ok, used, cap) = {
        let ret = Parser::new(&allocator, &src, source_type_of(&path)).parse();
        (ret.errors.is_empty() && !ret.panicked, allocator.used_bytes(), allocator.capacity())
    };
    let retained = A_LIVE.load(Relaxed);
    drop(allocator);
    ARMED.store(false, Relaxed);
    let tokens = {
        let allocator = Allocator::default();
        let ret = Parser::new(&allocator, &src, source_type_of(&path)).with_config(TokensParserConfig).parse();
        ret.tokens.len()
    };
    let nodes = {
        let allocator = Allocator::default();
        let ret = Parser::new(&allocator, &src, source_type_of(&path)).parse();
        let mut v = NodeCount(0);
        v.visit_program(&ret.program);
        v.0
    };
    println!(
        "OXCCOUNT {} accept={} bytes={} tokens={} ast_nodes={} arena_used_bytes={} arena_capacity_bytes={} malloc={} realloc={} free={} alloc_bytes={} peak_live_bytes={} retained_after_parse_bytes={}",
        path, ok, src.len(), tokens, nodes, used, cap,
        A_MALLOC.load(Relaxed), A_REALLOC.load(Relaxed), A_FREE.load(Relaxed), A_BYTES.load(Relaxed), A_PEAK.load(Relaxed), retained
    );
}
