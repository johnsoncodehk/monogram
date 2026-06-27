// Native oxc parse bench — same stdin + N-arg protocol as Monogram rustTarget emitRunner.
use std::io::Read;

use oxc_allocator::Allocator;
use oxc_parser::{ParseOptions, Parser};
use oxc_span::SourceType;

fn parse(src: &str, allocator: &Allocator) {
    let ret = Parser::new(allocator, src, SourceType::mjs())
        .with_options(ParseOptions {
            parse_regular_expression: true,
            ..ParseOptions::default()
        })
        .parse();
    std::hint::black_box(ret.program);
}

fn main() {
    let mut src = String::new();
    std::io::stdin().read_to_string(&mut src).unwrap();
    let mut allocator = Allocator::default();

    if let Some(iters) = std::env::args().nth(1).and_then(|a| a.parse::<u64>().ok()) {
        for _ in 0..3 {
            allocator.reset();
            parse(&src, &allocator);
        }
        let t = std::time::Instant::now();
        for _ in 0..iters {
            allocator.reset();
            parse(&src, &allocator);
        }
        println!("{:.4}", t.elapsed().as_secs_f64() * 1000.0 / iters as f64);
        return;
    }

    parse(&src, &allocator);
}
