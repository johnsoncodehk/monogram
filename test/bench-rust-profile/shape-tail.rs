// ---- shape profile driver (appended to a typed shape-building parser, src/rust-shape.ts) ----
// The `shape` row of the profile (run.sh, phase shape): one parse that builds the shape's AST,
// against the CST parse of the same input by the same tree's CST parser (prof-tail.rs).
//   --once F         one parse_shape(src) (lex + parse + typed AST), then drop
//   --once-reuse F   one parse into an Ast that has already parsed this input once (its arenas,
//                    slab and scratch keep their capacity)
//   --check F        whether the root's value is built (not missing): the input is covered

#[inline(never)]
fn mono_prof_shape(src: &str) -> (bool, usize) {
    let r = parse_shape(src);
    let out = match &r { Ok(a) => (true, a.node_count()), Err(_) => (false, 0) };
    drop(std::hint::black_box(r));
    out
}

#[inline(never)]
fn mono_prof_shape_reuse<'s>(src: &'s str, a: &mut Ast<'s>) -> (bool, usize) {
    let ok = parse_shape_into(src, a).is_ok();
    (ok, a.node_count())
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let (mode, path) = (args[1].as_str(), args[2].as_str());
    let src = std::fs::read_to_string(path).expect("read input");
    match mode {
        "--once" => { let (ok, n) = mono_prof_shape(&src); println!("{} {} shape bytes={} nodes={}", if ok { "BUILT" } else { "MISSING" }, path, src.len(), n); }
        "--once-reuse" => {
            let mut a = Ast::default();
            let _ = parse_shape_into(&src, &mut a);
            let (ok, n) = mono_prof_shape_reuse(&src, &mut a);
            println!("{} {} shape-reuse bytes={} nodes={}", if ok { "BUILT" } else { "MISSING" }, path, src.len(), n);
        }
        "--check" => match parse_shape(&src) { Ok(_) => println!("BUILT {}", path), Err(e) => println!("MISSING {} {}", path, e) },
        _ => { eprintln!("usage: shape-prof --once|--once-reuse|--check <file>"); std::process::exit(2); }
    }
}
