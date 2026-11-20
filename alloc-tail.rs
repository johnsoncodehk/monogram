
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering::Relaxed};
struct Count;
static ALLOCS: AtomicUsize = AtomicUsize::new(0);
static REALLOCS: AtomicUsize = AtomicUsize::new(0);
static BYTES: AtomicUsize = AtomicUsize::new(0);
static LIVE: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);
static BIG: AtomicUsize = AtomicUsize::new(0);
unsafe impl GlobalAlloc for Count {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 { ALLOCS.fetch_add(1, Relaxed); BYTES.fetch_add(l.size(), Relaxed); if l.size() >= 131072 { BIG.fetch_add(1, Relaxed); } let v = LIVE.fetch_add(l.size(), Relaxed) + l.size(); PEAK.fetch_max(v, Relaxed); System.alloc(l) }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) { LIVE.fetch_sub(l.size(), Relaxed); System.dealloc(p, l) }
    unsafe fn realloc(&self, p: *mut u8, l: Layout, n: usize) -> *mut u8 { REALLOCS.fetch_add(1, Relaxed); BYTES.fetch_add(n, Relaxed); if n >= 131072 { BIG.fetch_add(1, Relaxed); } LIVE.fetch_sub(l.size(), Relaxed); let v = LIVE.fetch_add(n, Relaxed) + n; PEAK.fetch_max(v, Relaxed); System.realloc(p, l, n) }
}
#[global_allocator] static A: Count = Count;
fn main() {
    let src = std::fs::read_to_string(std::env::args().nth(1).unwrap()).unwrap();
    let mode = std::env::args().nth(2).unwrap_or_default();
    let n = 25;
    if mode == "scan" {
        let t = std::time::Instant::now(); let mut k = 0; for _ in 0..n { k += scan_meta(&src).len(); } let e = t.elapsed().as_secs_f64() * 1e3 / n as f64;
        println!("scan_meta {:.3} ms/iter ({} toks)", e, k / n); return;
    }
    let d0: Doc = Doc::new(src.clone()); drop(d0);
    let (a0, r0, b0) = (ALLOCS.load(Relaxed), REALLOCS.load(Relaxed), BYTES.load(Relaxed)); BIG.store(0, Relaxed);
    PEAK.store(LIVE.load(Relaxed), Relaxed);
    let mut ts = Vec::new();
    for _ in 0..n { let t = std::time::Instant::now(); let d: Doc = Doc::new(src.clone()); ts.push(t.elapsed().as_secs_f64() * 1e3); drop(d); }
    ts.sort_by(|a, b| a.partial_cmp(b).unwrap());
    println!("Doc::new median {:.3} ms | per call: allocs {} reallocs {} bytes {:.2} MB big(>=128K) {} | peak live {:.2} MB",
        ts[n / 2], (ALLOCS.load(Relaxed) - a0) / n, (REALLOCS.load(Relaxed) - r0) / n, (BYTES.load(Relaxed) - b0) as f64 / n as f64 / 1e6, BIG.load(Relaxed) / n, PEAK.load(Relaxed) as f64 / 1e6);
}
