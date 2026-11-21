// Untimed acceptance check for the oxc side: one parse per file as TS (same SourceType as the bench),
// printing whether oxc reported any error or panicked, and the first errors if so.
use oxc_allocator::Allocator;
use oxc_parser::Parser;
use oxc_span::SourceType;

fn main() {
    for path in std::env::args().skip(1) {
        let src = std::fs::read_to_string(&path).unwrap();
        let allocator = Allocator::default();
        let ret = Parser::new(&allocator, &src, SourceType::ts()).parse();
        let ok = ret.errors.is_empty() && !ret.panicked;
        println!(
            "{} {} errors={} panicked={} top_level_statements={}",
            if ok { "ACCEPT" } else { "REJECT" },
            path,
            ret.errors.len(),
            ret.panicked,
            ret.program.body.len()
        );
        for e in ret.errors.iter().take(3) {
            println!("  error: {:?}", e);
        }
    }
}
