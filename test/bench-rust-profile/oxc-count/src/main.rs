// oxc-count F: for one parse as in the bench (default config, fresh Allocator): malloc/realloc/free
// calls and bytes (counting global allocator armed around the parse and the drop), the arena's
// used and allocated bytes; then, in separate parses, the token count (TokensParserConfig) and the
// AST node count (every enter_node of oxc_ast_visit::Visit).
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering::Relaxed};

use oxc_allocator::Allocator;
use oxc_ast::AstKind;
use oxc_ast_visit::Visit;
use oxc_parser::Parser;
use oxc_parser::config::TokensParserConfig;
use oxc_span::SourceType;

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

fn main() {
    let path = std::env::args().nth(1).unwrap();
    let src = std::fs::read_to_string(&path).unwrap();
    ARMED.store(true, Relaxed);
    let allocator = Allocator::default();
    let (ok, used, cap) = {
        let ret = Parser::new(&allocator, &src, SourceType::ts()).parse();
        (ret.errors.is_empty() && !ret.panicked, allocator.used_bytes(), allocator.capacity())
    };
    let retained = A_LIVE.load(Relaxed);
    drop(allocator);
    ARMED.store(false, Relaxed);
    let tokens = {
        let allocator = Allocator::default();
        let ret = Parser::new(&allocator, &src, SourceType::ts()).with_config(TokensParserConfig).parse();
        ret.tokens.len()
    };
    let nodes = {
        let allocator = Allocator::default();
        let ret = Parser::new(&allocator, &src, SourceType::ts()).parse();
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
