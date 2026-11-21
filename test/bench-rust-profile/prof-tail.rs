
// ---- profile driver (appended to the emitted library; the profiled build) ----
// Each measured entry point is an #[inline(never)] function so Callgrind can collect exactly it
// (--collect-atstart=no --toggle-collect=*mono_prof_parse*): what it counts is one parse and the
// drop of what the parse built, as one bench iteration in test/bench-rust-oxc/bench-tail.rs does.
//   --once F           one parse_with(src, &mut CstBuilder::default()) (lex + parse + CST), then drop
//   --lex-once F       one lex(src) alone (the token array parse_with builds first), then drop
//   --tokenize-once F  one public tokenize(src) (lex + mapping to the public Token), then drop
//   --noop F           read the file only (baseline for whole-process counters such as perf stat)
//   --time F           ms per parse_with (bench loop, as in bench-tail.rs)
//   --time-lex F       ms per lex alone (same loop)

#[inline(never)]
fn mono_prof_parse(src: &str) -> (bool, usize, usize, usize) {
    let mut b = CstBuilder::default();
    let r = parse_with(src, &mut b);
    let out = (r.is_some(), b.nodes.len(), b.kids.len(), b.toks.len());
    drop(std::hint::black_box(b));
    out
}

#[inline(never)]
fn mono_prof_lex(src: &str) -> usize {
    let t = lex(src);
    let n = t.len();
    drop(std::hint::black_box(t));
    n
}

#[inline(never)]
fn mono_prof_tokenize(src: &str) -> usize {
    let t = tokenize(src);
    let n = t.len();
    drop(std::hint::black_box(t));
    n
}

fn mono_time<F: FnMut()>(path: &str, src: &str, what: &str, mut f: F) {
    for _ in 0..3 { f(); }
    let mut n = 0u64;
    let start = std::time::Instant::now();
    loop {
        f();
        n += 1;
        if n >= 5 && start.elapsed().as_millis() >= 1000 { break; }
    }
    let ms = start.elapsed().as_secs_f64() * 1000.0 / n as f64;
    println!("TIME {} {} bytes={} ms={:.3} n={}", what, path, src.len(), ms, n);
}

fn mono_main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 3 {
        eprintln!("usage: mono-prof --once|--lex-once|--tokenize-once|--noop|--time|--time-lex <file.ts>");
        std::process::exit(1);
    }
    let (mode, path) = (args[1].as_str(), args[2].as_str());
    let src = std::fs::read_to_string(path).unwrap();
    match mode {
        "--once" => {
            let (ok, nodes, kids, toks) = mono_prof_parse(&src);
            println!("{} {} bytes={} rule_nodes={} kid_slots={} tokens={}", if ok { "ACCEPT" } else { "REJECT" }, path, src.len(), nodes, kids, toks);
        }
        "--lex-once" => println!("LEX {} bytes={} tokens={}", path, src.len(), mono_prof_lex(&src)),
        "--tokenize-once" => println!("TOKENIZE {} bytes={} tokens={}", path, src.len(), mono_prof_tokenize(&src)),
        "--noop" => println!("NOOP {} bytes={}", path, src.len()),
        "--time" => mono_time(path, &src, "parse", || { std::hint::black_box(mono_prof_parse(&src)); }),
        "--time-lex" => mono_time(path, &src, "lex", || { std::hint::black_box(mono_prof_lex(&src)); }),
        _ => { eprintln!("unknown mode {}", mode); std::process::exit(1); }
    }
}

fn main() {
    // As in bench-tail.rs: a large reserved stack for the recursive-descent parser.
    std::thread::Builder::new().stack_size(1 << 30).spawn(mono_main).unwrap().join().unwrap();
}
