
// ---- bench driver (appended to the emitted library; mirrors test/oxc-parse-bench/src/main.rs) ----
// Timed work per iteration: parse_with(src, &mut CstBuilder) = lex + parse into the CST arena
// (nodes, kids, toks), with a fresh builder each iteration (as oxc gets a fresh Allocator) and the
// builder dropped at the end of the iteration (as oxc drops its Allocator). Nothing is serialized.
// BENCH_MODE=reuse: one builder for the warm-up and every timed iteration (parse_with empties and
// reuses it), as oxc then keeps one Allocator and reset()s it before each parse.

fn mono_bench_one(path: &str, src: &str) {
    let reuse = std::env::var("BENCH_MODE").map_or(false, |m| m == "reuse");
    let mut kept = CstBuilder::default();
    let mut once = |kept: &mut CstBuilder| {
        if reuse {
            let r = parse_with(src, kept);
            std::hint::black_box(r);
        } else {
            let mut b = CstBuilder::default();
            let r = parse_with(src, &mut b);
            std::hint::black_box(r);
            std::hint::black_box(b);
        }
    };
    // warmup (JIT/allocator/cache)
    for _ in 0..3 { once(&mut kept); }

    // timed: run until >= 1s elapsed, min 5 iters
    let mut n = 0u64;
    let start = std::time::Instant::now();
    loop {
        once(&mut kept);
        n += 1;
        if n >= 5 && start.elapsed().as_millis() >= 1000 {
            break;
        }
    }
    let ms = start.elapsed().as_secs_f64() * 1000.0 / n as f64;
    let mb = src.len() as f64 / 1_000_000.0;
    let mbps = mb / (ms / 1000.0);
    println!(
        "{:30} {:7.0}KB  {:8.3} ms/parse  {:8.1} MB/s  (n={})",
        path,
        src.len() as f64 / 1024.0,
        ms,
        mbps,
        n
    );
}

// --check: one untimed parse; prints whether the input is accepted and the size of what was built.
fn mono_check_one(path: &str, src: &str) {
    let mut b = CstBuilder::default();
    let r = parse_with(src, &mut b);
    println!(
        "{} {} rule_nodes={} kid_slots={} tokens={}",
        if r.is_some() { "ACCEPT" } else { "REJECT" },
        path,
        b.nodes.len(),
        b.kids.len(),
        b.toks.len()
    );
}

fn mono_main() {
    let args: Vec<String> = std::env::args().collect();
    let check = args.len() > 1 && args[1] == "--check";
    let files = if check { &args[2..] } else { &args[1..] };
    if files.is_empty() {
        eprintln!("usage: mono-bench [--check] <file.ts>...");
        std::process::exit(1);
    }
    for path in files {
        let src = match std::fs::read_to_string(path) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("read {}: {}", path, e);
                continue;
            }
        };
        if check { mono_check_one(path, &src) } else { mono_bench_one(path, &src) }
    }
}

fn main() {
    // The recursive-descent parser recurses per nesting level; run on a thread with a large stack so
    // deeply nested inputs do not overflow the 8 MB main-thread default. Stack size is reserved
    // address space only; it does not change the work timed.
    std::thread::Builder::new()
        .stack_size(1 << 30)
        .spawn(mono_main)
        .unwrap()
        .join()
        .unwrap();
}
