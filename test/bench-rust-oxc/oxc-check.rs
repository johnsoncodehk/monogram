// Untimed acceptance check for the oxc side: one parse per file (the source type of its extension, as the bench),
// printing whether oxc reported any error or panicked, and the first errors if so.
use oxc_allocator::Allocator;
use oxc_parser::Parser;
use oxc_span::SourceType;

// The source type the input's extension names, as the monogram side picks its grammar
// (test/bench-rust-profile/run.sh grammar_of): .tsx -> TSX (typescriptreact), .jsx -> JSX
// (javascriptreact), anything else -> TypeScript (the typescript grammar also reads the .js inputs).
fn source_type_of(path: &str) -> SourceType {
    if path.ends_with(".tsx") { SourceType::tsx() } else if path.ends_with(".jsx") { SourceType::jsx() } else { SourceType::ts() }
}

fn main() {
    for path in std::env::args().skip(1) {
        let src = std::fs::read_to_string(&path).unwrap();
        let allocator = Allocator::default();
        let ret = Parser::new(&allocator, &src, source_type_of(&path)).parse();
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
