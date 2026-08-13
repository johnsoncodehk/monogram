use std::fs;
use std::hint::black_box;
use std::time::Instant;

use oxc_allocator::Allocator;
use oxc_parser::Parser;
use oxc_span::SourceType;

fn bench_one(path: &str, src: &str) {
    // warmup (JIT/allocator/cache)
    for _ in 0..3 {
        let allocator = Allocator::default();
        let ret = Parser::new(&allocator, src, SourceType::ts()).parse();
        black_box(ret.program);
    }

    // timed: run until >= 1s elapsed, min 5 iters
    let mut n = 0u64;
    let start = Instant::now();
    loop {
        let allocator = Allocator::default();
        let ret = Parser::new(&allocator, src, SourceType::ts()).parse();
        black_box(ret.program);
        black_box(ret.errors);
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
