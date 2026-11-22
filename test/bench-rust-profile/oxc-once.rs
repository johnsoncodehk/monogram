// Profiled oxc entry point (built inside a copy of test/oxc-parse-bench, same crate and profile):
// one Parser::new(&allocator, src, SourceType::ts()).parse() with a fresh Allocator, then the drop
// of the result and the allocator, as one iteration of test/oxc-parse-bench/src/main.rs. Callgrind
// collects exactly oxc_prof_parse (--collect-atstart=no --toggle-collect=*oxc_prof_parse*).
// Reuse mode (--once-reuse): one Allocator kept across parses, Allocator::reset() before each
// (oxc_allocator 0.126: rewinds the last, biggest chunk and returns the others to the global
// allocator); after one warm parse into it, oxc_prof_parse_reuse collects reset + parse + drop of the result.
//   oxc-once --once F | --once-reuse F | --noop F
use oxc_allocator::Allocator;
use oxc_parser::Parser;
use oxc_span::SourceType;

#[inline(never)]
fn oxc_prof_parse(src: &str) -> (bool, usize) {
    let allocator = Allocator::default();
    let out;
    {
        let ret = Parser::new(&allocator, src, SourceType::ts()).parse();
        out = (ret.errors.is_empty() && !ret.panicked, ret.program.body.len());
        drop(std::hint::black_box(ret));
    }
    drop(std::hint::black_box(allocator));
    out
}

#[inline(never)]
fn oxc_prof_parse_reuse(src: &str, allocator: &mut Allocator) -> (bool, usize) {
    allocator.reset();
    let ret = Parser::new(allocator, src, SourceType::ts()).parse();
    let out = (ret.errors.is_empty() && !ret.panicked, ret.program.body.len());
    drop(std::hint::black_box(ret));
    out
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let (mode, path) = (args[1].as_str(), args[2].as_str());
    let src = std::fs::read_to_string(path).unwrap();
    match mode {
        "--once" => {
            let (ok, n) = oxc_prof_parse(&src);
            println!("{} {} bytes={} top_level_statements={}", if ok { "ACCEPT" } else { "REJECT" }, path, src.len(), n);
        }
        "--once-reuse" => {
            // The warm parse runs outside oxc_prof_parse_reuse, so Callgrind collects only the measured one.
            let mut allocator = Allocator::default();
            drop(std::hint::black_box(Parser::new(&allocator, &src, SourceType::ts()).parse()));
            let (ok, n) = oxc_prof_parse_reuse(&src, &mut allocator);
            println!("{} {} reuse bytes={} top_level_statements={}", if ok { "ACCEPT" } else { "REJECT" }, path, src.len(), n);
        }
        "--noop" => println!("NOOP {} bytes={}", path, src.len()),
        _ => {
            eprintln!("unknown mode");
            std::process::exit(1);
        }
    }
}
