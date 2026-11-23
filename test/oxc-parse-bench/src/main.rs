use std::fs;
use std::hint::black_box;
use std::time::Instant;

use oxc_allocator::Allocator;
use oxc_parser::Parser;
use oxc_span::SourceType;

// The source type the input's extension names, as the monogram side picks its grammar
// (test/bench-rust-profile/run.sh grammar_of): .tsx -> TSX (typescriptreact), .jsx -> JSX
// (javascriptreact), anything else -> TypeScript (the typescript grammar also reads the .js inputs).
fn source_type_of(path: &str) -> SourceType {
    if path.ends_with(".tsx") { SourceType::tsx() } else if path.ends_with(".jsx") { SourceType::jsx() } else { SourceType::ts() }
}

// BENCH_MODE=reuse: one Allocator for the warm-up and every timed iteration, reset() before each
// parse (oxc_allocator 0.126: rewinds its last, biggest chunk and frees the others). Default fresh:
// a new Allocator per iteration, dropped at its end.
fn bench_one(path: &str, src: &str) {
    let reuse = std::env::var("BENCH_MODE").map_or(false, |m| m == "reuse");
    let mut kept = Allocator::default();
    let mut once = |kept: &mut Allocator| {
        if reuse {
            kept.reset();
            let ret = Parser::new(kept, src, source_type_of(path)).parse();
            black_box(ret.program);
            black_box(ret.errors);
        } else {
            let allocator = Allocator::default();
            let ret = Parser::new(&allocator, src, source_type_of(path)).parse();
            black_box(ret.program);
            black_box(ret.errors);
        }
    };
    // warmup (JIT/allocator/cache)
    for _ in 0..3 { once(&mut kept); }

    // timed: run until >= 1s elapsed, min 5 iters
    let mut n = 0u64;
    let start = Instant::now();
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

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 {
        eprintln!("usage: oxc-parse-bench <file.ts>...");
        std::process::exit(1);
    }
    for path in &args[1..] {
        let src = match fs::read_to_string(path) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("read {}: {}", path, e);
                continue;
            }
        };
        bench_one(path, &src);
    }
}
