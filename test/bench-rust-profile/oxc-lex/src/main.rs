// oxc-lex --once F: oxc's Lexer over the whole file without the parser (as oxc's own lexer
// benchmark does: next_token_for_benchmarks until Eof). Without the parser, `/` is always lexed as
// division and templates/regexes are not re-lexed, so this is oxc's lexing cost to within those
// re-lexes, and its token count is close to, not exactly, the parser's.
use oxc_allocator::Allocator;
use oxc_parser::config::NoTokensLexerConfig;
use oxc_parser::lexer::{Kind, Lexer};
use oxc_span::SourceType;

#[inline(never)]
fn oxc_prof_lex(src: &str) -> usize {
    let allocator = Allocator::default();
    let mut n = 0usize;
    {
        let mut lexer = Lexer::new_for_benchmarks(&allocator, src, SourceType::ts(), NoTokensLexerConfig);
        let mut t = lexer.first_token();
        while t.kind() != Kind::Eof {
            n += 1;
            t = lexer.next_token_for_benchmarks();
        }
    }
    drop(std::hint::black_box(allocator));
    n
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let src = std::fs::read_to_string(&args[2]).unwrap();
    println!("OXCLEX {} bytes={} tokens={}", args[2], src.len(), oxc_prof_lex(&src));
}
