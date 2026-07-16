
// ── SH3-4 ESTree customs (mirrors shape-typescript.ts) ─────────────────────
// SH3-5: estree_* take AstCustomCtx by value and extract kids via
// mem::take / mem::replace instead of deep-cloning subtrees — AstValue::clone
// survives only where one slot genuinely feeds two output fields (cold arms).
fn ts_obj(typ: &'static str, fields: Vec<(&'static str, AstValue)>) -> AstValue {
    AstValue::Object { typ, fields }
}
fn ts_ident(name: &str) -> AstValue { ts_obj("Identifier", vec![("name", AstValue::String(name.to_owned()))]) }
fn ts_lit_str(s: &str) -> AstValue { AstValue::String(s.to_owned()) }
fn ts_lit_num(n: f64) -> AstValue { AstValue::Number(n) }
fn ts_null() -> AstValue { AstValue::Null }
fn ts_arr(xs: Vec<AstValue>) -> AstValue { AstValue::Array(xs) }
fn ts_bool(b: bool) -> AstValue { AstValue::Bool(b) }
fn shape_partial(tag: &'static str, mode: &'static str, value: AstValue) -> AstValue {
    AstValue::Partial { tag, mode, value: Box::new(value) }
}
fn span_str<'a>(src: &'a str, off: usize, end: usize) -> &'a str {
    src.get(off..end).unwrap_or("")
}
fn prefix<'a>(src: &'a str, off: usize, len: usize) -> &'a str {
    let rest = src.get(off..).unwrap_or("");
    rest.get(..len).unwrap_or(rest)
}
fn unhandled(fn_name: &str, alt_path: &[usize], op_text: Option<&str>, identity: Option<&str>) -> ! {
    let suffix = identity.map(|s| s.to_owned()).unwrap_or_else(|| {
        let op = op_text.map(|o| format!(" opText={:?}", o)).unwrap_or_default();
        format!("altPath={:?}{}", alt_path, op)
    });
    panic!("shape custom {}: unhandled {}", fn_name, suffix);
}
/// Extract kid `i` by value, leaving Null behind (≡ `.get(i).cloned()` without the deep clone).
fn take_opt(kids: &mut Vec<AstValue>, i: usize) -> Option<AstValue> {
    kids.get_mut(i).map(|v| std::mem::replace(v, AstValue::Null))
}
fn take_kid(kids: &mut Vec<AstValue>, i: usize) -> AstValue {
    take_opt(kids, i).unwrap_or(AstValue::Null)
}
fn take_last(kids: &mut Vec<AstValue>) -> AstValue {
    if kids.is_empty() { AstValue::Null } else { take_kid(kids, kids.len() - 1) }
}
fn take_field(fields: &mut Vec<(&'static str, AstValue)>, name: &str) -> AstValue {
    fields.iter_mut().find(|(n, _)| *n == name).map(|(_, v)| std::mem::replace(v, AstValue::Null)).unwrap_or(AstValue::Null)
}
/// Consuming flat_kids — moves array elements instead of cloning them.
fn flat_take(kids: Vec<AstValue>) -> Vec<AstValue> {
    let mut out: Vec<AstValue> = Vec::new();
    for k in kids {
        match k {
            AstValue::Array(xs) => out.extend(xs),
            AstValue::Null => {}
            other => out.push(other),
        }
    }
    out
}
/// Borrowed flat_kids — kept for the cold ImportDeclaration arm that reads one kid twice.
fn flat_kids(kids: &[AstValue]) -> Vec<AstValue> {
    let mut out: Vec<AstValue> = Vec::new();
    for k in kids {
        match k {
            AstValue::Array(xs) => out.extend(xs.clone()),
            AstValue::Null => {}
            other => out.push(other.clone()),
        }
    }
    out
}
/// Like TS `flatKids(x ?? [])[0] ?? null`, but also unwrap one extra single-array pack
/// that rust star/opt sometimes leaves as `[[Heritage]]`.
fn first_flat(v: Option<AstValue>) -> AstValue {
    let mut xs = flat_take(vec![v.unwrap_or_else(|| ts_arr(vec![]))]);
    while xs.len() == 1 {
        match xs.into_iter().next() {
            Some(AstValue::Array(inner)) => xs = inner,
            Some(other) => return other,
            None => return ts_null(),
        }
    }
    xs.into_iter().next().unwrap_or_else(ts_null)
}
/// Approximate JS `String(x)` used by TS keep shapes (Array joins with ',', Object → `[object Object]`).
fn js_string(v: &AstValue) -> String {
    match v {
        AstValue::String(s) => s.clone(),
        AstValue::Number(n) => {
            if n.is_nan() { "NaN".into() }
            else if n.is_infinite() { if n.is_sign_negative() { "-Infinity" } else { "Infinity" }.into() }
            else if *n == 0.0 { "0".into() }
            else { n.to_string() }
        }
        AstValue::Bool(b) => b.to_string(),
        AstValue::Null => "".into(), // JS Array#toString / String(null??'') join slot is empty
        AstValue::Array(xs) => xs.iter().map(js_string).collect::<Vec<_>>().join(","),
        AstValue::Object { .. } | AstValue::Partial { .. } => "[object Object]".into(),
    }
}
fn flat_deep_take(kids: Vec<AstValue>) -> Vec<AstValue> {
    // Fully flatten nested array packs from sep/star/opt (heritage lists, etc.).
    fn walk(v: AstValue, out: &mut Vec<AstValue>) {
        match v {
            AstValue::Null => {}
            AstValue::Array(xs) => for x in xs { walk(x, out); }
            other => out.push(other),
        }
    }
    let mut out = Vec::new();
    for k in kids { walk(k, &mut out); }
    out
}
fn seq_expr(head: Option<AstValue>, tail: Option<AstValue>) -> Option<AstValue> {
    let mut parts = Vec::new();
    if let Some(h) = head { parts.extend(flat_take(vec![h])); }
    if let Some(t) = tail { parts.extend(flat_take(vec![t])); }
    match parts.len() {
        0 => None,
        1 => Some(parts.into_iter().next().unwrap()),
        _ => Some(ts_obj("SequenceExpression", vec![("expressions", ts_arr(parts))])),
    }
}
fn strip_asi(kids: Vec<AstValue>) -> Vec<AstValue> {
    kids.into_iter().filter(|k| !matches!(k, AstValue::Array(xs) if xs.is_empty())).collect()
}
fn member_expr(obj: AstValue, prop: AstValue, computed: bool) -> AstValue {
    let p = match prop {
        AstValue::String(s) => ts_ident(&s),
        other => other,
    };
    ts_obj("MemberExpression", vec![
        ("object", obj), ("property", p), ("computed", ts_bool(computed)), ("optional", ts_bool(false)),
    ])
}
fn call_expr(callee: AstValue, args: Vec<AstValue>) -> AstValue {
    ts_obj("CallExpression", vec![("callee", callee), ("arguments", ts_arr(args))])
}
fn unary_expr(op: &str, arg: AstValue) -> AstValue {
    ts_obj("UnaryExpression", vec![("operator", ts_lit_str(op)), ("argument", arg), ("prefix", ts_bool(true))])
}
fn binary_expr(left: AstValue, op: &str, right: AstValue) -> AstValue {
    ts_obj("BinaryExpression", vec![("left", left), ("operator", ts_lit_str(op)), ("right", right)])
}
fn update_expr(op: &str, arg: AstValue, prefix: bool) -> AstValue {
    ts_obj("UpdateExpression", vec![("operator", ts_lit_str(op)), ("argument", arg), ("prefix", ts_bool(prefix))])
}
fn arrow_fn(params: Vec<AstValue>, body: AstValue, async_: bool) -> AstValue {
    let expression = match &body {
        AstValue::Object { typ, .. } => *typ != "BlockStatement",
        _ => true,
    };
    ts_obj("ArrowFunctionExpression", vec![
        ("params", ts_arr(params)), ("body", body), ("async", ts_bool(async_)), ("expression", ts_bool(expression)),
    ])
}
fn head_is_new(v: &AstValue) -> bool {
    match v {
        AstValue::String(s) => s == "new",
        AstValue::Object { typ, fields, .. } if *typ == "Identifier" => {
            fields.iter().any(|(k, v)| *k == "name" && matches!(v, AstValue::String(s) if s == "new"))
        }
        _ => false,
    }
}
fn tpl_raw(kind: &str, text: &str) -> String {
    let open = "`"; let i_open = "${"; let i_close = "}";
    if kind == "nosubst" {
        return if text.starts_with(open) && text.ends_with(open) {
            text[open.len()..text.len() - open.len()].to_owned()
        } else { text.to_owned() };
    }
    let mut s = text.to_owned();
    if kind == "head" {
        if s.starts_with(open) { s = s[open.len()..].to_owned(); }
        if s.ends_with(i_open) { s = s[..s.len() - i_open.len()].to_owned(); }
        return s;
    }
    if kind == "middle" {
        if s.starts_with(i_close) { s = s[i_close.len()..].to_owned(); }
        if s.ends_with(i_open) { s = s[..s.len() - i_open.len()].to_owned(); }
        return s;
    }
    if s.starts_with(i_close) { s = s[i_close.len()..].to_owned(); }
    if s.ends_with(open) { s = s[..s.len() - open.len()].to_owned(); }
    s
}
fn estree_optional_chain(left: AstValue, kids: Vec<AstValue>) -> AstValue {
    let k0 = kids.into_iter().next();
    match k0 {
        Some(AstValue::Array(mut k0)) => {
            if matches!(k0.first(), Some(AstValue::Array(_))) {
                let inner = match std::mem::replace(&mut k0[0], AstValue::Null) {
                    AstValue::Array(xs) => xs,
                    _ => Vec::new(),
                };
                let args = match k0.get_mut(1) {
                    Some(AstValue::Array(xs)) => std::mem::take(xs),
                    _ => Vec::new(),
                };
                let mut fields = vec![("callee", left), ("arguments", ts_arr(args)), ("optional", ts_bool(true))];
                fields.push(("typeArguments", AstValue::Array(inner)));
                ts_obj("CallExpression", fields)
            } else {
                let mut o = call_expr(left, k0);
                if let AstValue::Object { ref mut fields, .. } = o { fields.push(("optional", ts_bool(true))); }
                o
            }
        }
        Some(AstValue::String(s)) if s.starts_with('`') => {
            ts_obj("TaggedTemplateExpression", vec![("tag", left), ("quasi", AstValue::String(s))])
        }
        Some(v) if matches!(v, AstValue::Object { typ, .. } if typ == "TemplateLiteral") => {
            ts_obj("TaggedTemplateExpression", vec![("tag", left), ("quasi", v)])
        }
        Some(AstValue::String(s)) => {
            let mut o = member_expr(left, AstValue::String(s), false);
            if let AstValue::Object { ref mut fields, .. } = o { fields.push(("optional", ts_bool(true))); }
            o
        }
        other => {
            let mut o = member_expr(left, other.unwrap_or(ts_lit_str("undefined")), true);
            if let AstValue::Object { ref mut fields, .. } = o { fields.push(("optional", ts_bool(true))); }
            o
        }
    }
}
const ASSIGN_OPS: &[&str] = &["=", "+=", "-=", "*=", "/=", "%=", "**=", "<<=", ">>=", ">>>=", "&=", "|=", "^=", "??=", "||=", "&&="];
const LOGICAL_OPS: &[&str] = &["??", "||", "&&"];
const UPDATE_OPS: &[&str] = &["++", "--"];
const BINARY_OPS: &[&str] = &["=", "+=", "-=", "*=", "/=", "%=", "**=", "<<=", ">>=", ">>>=", "&=", "|=", "^=", "??=", "||=", "&&=", "??", "||", "&&", "|", "^", "&", "==", "!=", "===", "!==", "<", ">", "<=", ">=", "<<", ">>", ">>>", "+", "-", "*", "/", "%", "**"];
const PREFIX_OPS: &[&str] = &["!", "~", "+", "-", "typeof", "void", "delete", "await", "yield", "++", "--"];

fn estree_stmt(mut ctx: AstCustomCtx<'_>) -> AstValue {
    let arm = ctx.alt_path.first().copied();
    let src = ctx.src;
    let off = ctx.off;
    let k = &mut ctx.kids;
    match arm {
        Some(0) => {
            if let Some(body) = take_opt(k, 0) {
                if let AstValue::Object { typ, .. } = &body {
                    if *typ == "BlockStatement" { return body; }
                }
                return ts_obj("BlockStatement", vec![("body", ts_arr(flat_take(vec![body])))]);
            }
            ts_obj("BlockStatement", vec![("body", ts_arr(flat_take(std::mem::take(k))))])
        }
        Some(1) => {
            let kind = if prefix(src, off, 5).starts_with("const") { "const" }
                else if prefix(src, off, 3).starts_with("let") { "let" } else { "var" };
            ts_obj("VariableDeclaration", vec![("kind", ts_lit_str(kind)), ("declarations", ts_arr(flat_take(std::mem::take(k))))])
        }
        Some(2) => ts_obj("IfStatement", vec![
            ("test", seq_expr(take_opt(k, 0), take_opt(k, 1)).unwrap_or_else(ts_null)),
            ("consequent", take_kid(k, 2)),
            ("alternate", take_kid(k, 3)),
        ]),
        Some(3) => {
            let body = take_kid(k, 1);
            if let Some(AstValue::Object { mut fields, .. }) = take_opt(k, 0) {
                let kind = take_field(&mut fields, "kind");
                if matches!(&kind, AstValue::String(s) if s == "in") {
                    return ts_obj("ForInStatement", vec![
                        ("left", take_field(&mut fields, "left")),
                        ("right", take_field(&mut fields, "right")),
                        ("body", body),
                    ]);
                }
                if matches!(&kind, AstValue::String(s) if s == "of") {
                    let await_ = fields.iter().any(|(n, v)| *n == "await" && matches!(v, AstValue::Bool(true)));
                    return ts_obj("ForOfStatement", vec![
                        ("left", take_field(&mut fields, "left")),
                        ("right", take_field(&mut fields, "right")),
                        ("body", body), ("await", ts_bool(await_)),
                    ]);
                }
                return ts_obj("ForStatement", vec![
                    ("init", take_field(&mut fields, "init")),
                    ("test", take_field(&mut fields, "test")),
                    ("update", take_field(&mut fields, "update")),
                    ("body", body),
                ]);
            }
            ts_obj("ForStatement", vec![("init", ts_null()), ("test", ts_null()), ("update", ts_null()), ("body", body)])
        }
        Some(4) => ts_obj("WhileStatement", vec![
            ("test", seq_expr(take_opt(k, 1), take_opt(k, 2)).unwrap_or_else(ts_null)),
            ("body", take_kid(k, 3)),
        ]),
        Some(5) => ts_obj("DoWhileStatement", vec![
            ("body", take_kid(k, 0)),
            ("test", seq_expr(take_opt(k, 2), take_opt(k, 3)).unwrap_or_else(ts_null)),
        ]),
        Some(6) => {
            let cases = match take_opt(k, 2) {
                Some(c) => flat_take(vec![c]),
                None => match take_opt(k, 1) {
                    Some(c) => flat_take(vec![c]),
                    None => Vec::new(),
                },
            };
            ts_obj("SwitchStatement", vec![
                ("discriminant", take_kid(k, 0)),
                ("cases", ts_arr(cases)),
            ])
        }
        Some(7) => ts_obj("ReturnStatement", vec![("argument", seq_expr(take_opt(k, 0), take_opt(k, 1)).unwrap_or_else(ts_null))]),
        Some(8) => ts_obj("ThrowStatement", vec![("argument", seq_expr(take_opt(k, 0), take_opt(k, 1)).unwrap_or_else(ts_null))]),
        Some(9) => ts_obj("BreakStatement", vec![("label", take_kid(k, 0))]),
        Some(10) => ts_obj("ContinueStatement", vec![("label", take_kid(k, 0))]),
        Some(11) => ts_obj("TryStatement", vec![
            ("block", take_kid(k, 0)),
            ("handler", take_kid(k, 1)),
            ("finalizer", take_kid(k, 2)),
        ]),
        Some(12) => ts_obj("LabeledStatement", vec![
            ("label", ts_ident(&match take_opt(k, 0) { Some(AstValue::String(s)) => s, _ => String::new() })),
            ("body", take_kid(k, 1)),
        ]),
        Some(13) => ts_obj("EmptyStatement", vec![]),
        Some(14) => ts_obj("DebuggerStatement", vec![]),
        Some(15) => ts_obj("WithStatement", vec![
            ("object", take_kid(k, 1)),
            ("body", take_kid(k, 2)),
        ]),
        Some(16) => ts_obj("VariableDeclaration", vec![("kind", ts_lit_str("using")), ("declarations", ts_arr(flat_take(vec![take_last(k)]))) ]),
        Some(17) => take_opt(k, 0).unwrap_or_else(ts_null),
        Some(18) => {
            let expr = strip_asi(std::mem::take(k)).into_iter().next().unwrap_or_else(ts_null);
            ts_obj("ExpressionStatement", vec![("expression", expr)])
        }
        _ => unhandled("estreeStmt", &ctx.alt_path, ctx.op_text, None),
    }
}

fn estree_decl(mut ctx: AstCustomCtx<'_>) -> AstValue {
    let arm = ctx.alt_path.first().copied();
    let k = &mut ctx.kids;
    match arm {
        Some(17) => ts_obj("ExportNamedDeclaration", vec![("declaration", take_kid(k, 0))]),
        Some(18) => ts_obj("ExportNamedDeclaration", vec![("specifiers", ts_arr(flat_take(std::mem::take(k))))]),
        Some(19) => ts_obj("ExportAllDeclaration", vec![("source", take_kid(k, 0))]),
        Some(20) => ts_obj("ExportDefaultDeclaration", vec![("declaration", take_kid(k, 0))]),
        Some(21) => ts_obj("ImportDeclaration", vec![
            ("specifiers", ts_arr(match k.get(1) {
                Some(v) => flat_kids(&[v.clone()]),
                None => flat_kids(k),
            })),
            ("source", k.get(2).or_else(|| k.get(1)).cloned().unwrap_or_else(ts_null)),
        ]),
        Some(22) => ts_obj("TSImportEqualsDeclaration", vec![("id", take_kid(k, 0)), ("moduleReference", take_kid(k, 1))]),
        Some(23) => ts_obj("TSModuleDeclaration", vec![("id", take_kid(k, 0)), ("body", take_kid(k, 1))]),
        Some(24) => ts_obj("TSModuleDeclaration", vec![("id", take_kid(k, 0)), ("body", take_kid(k, 1)), ("declare", ts_bool(true))]),
        Some(25) => ts_obj("TSNamespaceExportDeclaration", vec![("id", take_kid(k, 0))]),
        Some(26) => ts_obj("TSEnumDeclaration", vec![("id", take_kid(k, 0)), ("members", ts_arr(flat_take(vec![take_kid(k, 1)])))]),
        Some(27) => ts_obj("TSInterfaceDeclaration", vec![("id", take_kid(k, 0)), ("body", take_kid(k, 1))]),
        Some(4) => ts_obj("TSInterfaceDeclaration", vec![
            ("id", take_kid(k, 0)),
            ("typeParameters", take_kid(k, 1)),
            ("extends", ts_arr(flat_deep_take(vec![take_kid(k, 2)]))),
            ("body", ts_obj("TSInterfaceBody", vec![("body", ts_arr(flat_take(vec![take_kid(k, 3)])))])),
        ]),
        Some(5) => ts_obj("TSTypeAliasDeclaration", vec![
            ("id", take_kid(k, 0)),
            ("typeParameters", take_kid(k, 1)),
            ("typeAnnotation", take_kid(k, 2)),
        ]),
        Some(6) => ts_obj("ClassDeclaration", vec![
            ("decorators", ts_arr(flat_take(vec![take_kid(k, 0)]))),
            ("id", take_kid(k, 1)),
            ("superClass", first_flat(take_opt(k, 3))),
            ("body", ts_obj("ClassBody", vec![("body", ts_arr(flat_take(vec![take_kid(k, 4)])))])),
        ]),
        Some(0) | Some(1) | Some(2) | Some(3) => {
            let async_ = arm == Some(1) || arm == Some(3);
            let gen = arm == Some(2) || arm == Some(3);
            ts_obj("FunctionDeclaration", vec![
                ("async", ts_bool(async_)), ("generator", ts_bool(gen)),
                ("id", take_kid(k, 0)),
                ("typeParameters", take_kid(k, 1)),
                ("params", ts_arr(flat_take(vec![take_kid(k, 2)]))),
                ("returnType", take_kid(k, 3)),
                ("body", take_kid(k, 4)),
            ])
        }
        Some(15) | Some(16) => {
            let inner_arm = if arm == Some(15) { 0usize } else { 6 };
            let inner = estree_decl(AstCustomCtx { name: ctx.name, rule: ctx.rule, src: ctx.src, kids: std::mem::take(&mut ctx.kids), alt_path: vec![inner_arm], off: ctx.off, end: ctx.end, left: ctx.left.take(), op_text: ctx.op_text, state: ctx.state.take() });
            ts_obj("ExportNamedDeclaration", vec![("declaration", inner)])
        }
        Some(14) => {
            // In the TS reference `{ type: 'TSDeclareFunction', ...FunctionDeclaration }`,
            // the spread's `type` wins.
            estree_decl(AstCustomCtx { name: ctx.name, rule: ctx.rule, src: ctx.src, kids: std::mem::take(&mut ctx.kids), alt_path: vec![0], off: ctx.off, end: ctx.end, left: ctx.left.take(), op_text: ctx.op_text, state: ctx.state.take() })
        }
        Some(a) if (7..=13).contains(&a) => ts_obj("Declaration", vec![("alt", ts_lit_num(a as f64)), ("children", ts_arr(std::mem::take(&mut ctx.kids)))]),
        _ => unhandled("estreeDecl", &ctx.alt_path, ctx.op_text, None),
    }
}

fn estree_paren_or_comma(mut ctx: AstCustomCtx<'_>) -> AstValue {
    let arm = ctx.alt_path.first().copied();
    if arm.is_none() || arm.unwrap() > 20 { unhandled("estreeParenOrComma", &ctx.alt_path, ctx.op_text, None); }
    if arm == Some(7) { return ts_obj("MetaProperty", vec![("meta", ts_ident("new")), ("property", ts_ident("target"))]); }
    let parts = flat_take(std::mem::take(&mut ctx.kids));
    if parts.len() == 1 { parts.into_iter().next().unwrap() }
    else { ts_obj("SequenceExpression", vec![("expressions", ts_arr(parts))]) }
}

fn estree_expr_binary(mut ctx: AstCustomCtx<'_>) -> AstValue {
    let op = ctx.op_text.unwrap_or("");
    if !BINARY_OPS.contains(&op) { unhandled("estreeExprBinary", &ctx.alt_path, ctx.op_text, None); }
    let right = take_kid(&mut ctx.kids, 0);
    let left = ctx.left.take().unwrap_or_else(ts_null);
    if ASSIGN_OPS.contains(&op) {
        ts_obj("AssignmentExpression", vec![("left", left), ("operator", ts_lit_str(op)), ("right", right)])
    } else if LOGICAL_OPS.contains(&op) {
        ts_obj("LogicalExpression", vec![("left", left), ("operator", ts_lit_str(op)), ("right", right)])
    } else {
        ts_obj("BinaryExpression", vec![("left", left), ("operator", ts_lit_str(op)), ("right", right)])
    }
}

fn estree_expr_prefix(mut ctx: AstCustomCtx<'_>) -> AstValue {
    let op = ctx.op_text.unwrap_or("");
    if !PREFIX_OPS.contains(&op) { unhandled("estreeExprPrefix", &ctx.alt_path, ctx.op_text, None); }
    let argument = take_kid(&mut ctx.kids, 0);
    if UPDATE_OPS.contains(&op) { update_expr(op, argument, true) } else { unary_expr(op, argument) }
}

fn estree_expr_postfix_tok(mut ctx: AstCustomCtx<'_>) -> AstValue {
    let op = ctx.op_text.unwrap_or("");
    if !op.starts_with('`') { unhandled("estreeExprPostfixTok", &ctx.alt_path, ctx.op_text, None); }
    ts_obj("TaggedTemplateExpression", vec![
        ("tag", ctx.left.take().unwrap_or_else(ts_null)),
        ("quasi", take_kid(&mut ctx.kids, 0)),
    ])
}

fn estree_template_literal(mut ctx: AstCustomCtx<'_>) -> AstValue {
    if ctx.kids.len() == 1 {
        if let AstValue::String(ref s) = ctx.kids[0] {
            return ts_obj("TemplateLiteral", vec![
                ("quasis", ts_arr(vec![ts_obj("TemplateElement", vec![
                    ("value", ts_obj("", vec![("raw", ts_lit_str(&tpl_raw("nosubst", s)))])),
                    ("tail", ts_bool(true)),
                ])])),
                ("expressions", ts_arr(vec![])),
            ]);
        }
    }
    if ctx.kids.len() < 3 || ctx.kids.len() % 2 == 0 { unhandled("estreeTemplateLiteral", &ctx.alt_path, ctx.op_text, None); }
    let kids = std::mem::take(&mut ctx.kids);
    let len = kids.len();
    let mut quasis = Vec::new();
    let mut expressions = Vec::new();
    for (i, k) in kids.into_iter().enumerate() {
        if i % 2 == 0 {
            let text = match &k { AstValue::String(s) => s.as_str(), _ => unhandled("estreeTemplateLiteral", &ctx.alt_path, ctx.op_text, None) };
            let is_head = i == 0;
            let is_tail = i == len - 1;
            let kind = if is_head { "head" } else if is_tail { "tail" } else { "middle" };
            quasis.push(ts_obj("TemplateElement", vec![
                ("value", ts_obj("", vec![("raw", ts_lit_str(&tpl_raw(kind, text)))])),
                ("tail", ts_bool(is_tail)),
            ]));
        } else {
            expressions.push(k);
        }
    }
    ts_obj("TemplateLiteral", vec![("quasis", ts_arr(quasis)), ("expressions", ts_arr(expressions))])
}

fn estree_expr_led(mut ctx: AstCustomCtx<'_>) -> AstValue {
    let left = ctx.left.take().unwrap_or_else(ts_null);
    let op = ctx.op_text.unwrap_or("");
    let arm = ctx.alt_path.first().copied();
    if arm == Some(4) { return estree_optional_chain(left, std::mem::take(&mut ctx.kids)); }
    let slots = flat_take(std::mem::take(&mut ctx.kids));
    match arm {
        Some(0) | Some(2) => {
            let args = if slots.len() == 1 {
                match slots.into_iter().next() {
                    Some(AstValue::Array(xs)) => xs,
                    other => other.into_iter().collect(),
                }
            } else { slots };
            call_expr(left, args.into_iter().filter(|x| !matches!(x, AstValue::Null)).collect())
        }
        Some(1) => ts_obj("TSInstantiationExpression", vec![
            ("expression", left),
            ("typeArguments", if slots.is_empty() { ts_arr(slots) } else { slots.into_iter().next().unwrap() }),
        ]),
        Some(3) => member_expr(left, slots.into_iter().next().unwrap_or_else(|| ts_lit_str("undefined")), false),
        Some(5) => member_expr(left, slots.into_iter().next().unwrap_or_else(|| ts_lit_str("undefined")), true),
        Some(6) => ts_obj("TSNonNullExpression", vec![("expression", left)]),
        Some(7) => {
            let mut it = slots.into_iter();
            let consequent = it.next().unwrap_or_else(ts_null);
            let alternate = it.next().unwrap_or_else(ts_null);
            ts_obj("ConditionalExpression", vec![("test", left), ("consequent", consequent), ("alternate", alternate)])
        }
        Some(8) => ts_obj("TSAsExpression", vec![("expression", left), ("typeAnnotation", slots.into_iter().next().unwrap_or_else(ts_null))]),
        Some(9) => binary_expr(left, "instanceof", slots.into_iter().next().unwrap_or_else(ts_null)),
        Some(10) => binary_expr(left, "in", slots.into_iter().next().unwrap_or_else(ts_null)),
        Some(11) => ts_obj("TSSatisfiesExpression", vec![("expression", left), ("typeAnnotation", slots.into_iter().next().unwrap_or_else(ts_null))]),
        _ => unhandled("estreeExprLed", &ctx.alt_path, ctx.op_text, Some(&format!("LED altPath={:?} opText={:?}", ctx.alt_path, op))),
    }
}

fn estree_expr_nud_seq(mut ctx: AstCustomCtx<'_>) -> AstValue {
    let arm = ctx.alt_path.first().copied();
    match arm {
        Some(0) => match take_opt(&mut ctx.kids, 0) {
            Some(AstValue::String(s)) => ts_ident(&s),
            Some(other) => other,
            None => ts_null(),
        },
        Some(1) | Some(2) => {
            let k = &mut ctx.kids;
            let decorators = flat_take(vec![take_kid(k, 0)]);
            let id = take_kid(k, 1);
            let tail = k.split_off(3.min(k.len()));
            ts_obj("ClassExpression", vec![
                ("decorators", ts_arr(decorators)),
                ("id", id),
                ("body", ts_obj("ClassBody", vec![("body", ts_arr(flat_take(tail)))])),
            ])
        }
        _ => unhandled("estreeExprNudSeq", &ctx.alt_path, ctx.op_text, None),
    }
}

fn estree_arrow(mut ctx: AstCustomCtx<'_>) -> AstValue {
    let async_ = span_str(ctx.src, ctx.off, ctx.end).trim_start().starts_with("async");
    let arm = ctx.alt_path.first().copied();
    if arm.is_none() || arm.unwrap() > 3 { unhandled("estreeArrow", &ctx.alt_path, ctx.op_text, None); }
    let len = ctx.kids.len();
    let pidx = if arm == Some(1) || arm == Some(2) { 1usize } else { 0usize };
    let (params, body) = if len > pidx && len - 1 == pidx {
        // One slot feeds both params and body (the original cloned it twice).
        let v = take_kid(&mut ctx.kids, pidx);
        let body = v.clone();
        let params = if pidx == 1 {
            flat_take(vec![v])
        } else {
            vec![match v { AstValue::String(s) => ts_ident(&s), other => other }]
        };
        (params, body)
    } else {
        let body = take_last(&mut ctx.kids);
        let params = if pidx == 1 {
            flat_take(vec![take_opt(&mut ctx.kids, 1).unwrap_or_else(|| ts_arr(vec![]))])
        } else {
            let p = take_opt(&mut ctx.kids, 0).unwrap_or_else(ts_null);
            vec![match p { AstValue::String(s) => ts_ident(&s), other => other }]
        };
        (params, body)
    };
    arrow_fn(params, body, async_)
}

fn ts_type_led(mut ctx: AstCustomCtx<'_>) -> AstValue {
    if ctx.op_text.is_none() {
        let arm = ctx.alt_path.first().copied();
        if arm == Some(7) { return ts_obj("TSTypeLiteral", vec![("members", ts_arr(flat_take(std::mem::take(&mut ctx.kids))))]); }
        if arm.is_none() || arm.unwrap() > 20 {
            unhandled("tsTypeLed", &ctx.alt_path, ctx.op_text, Some(&format!("group altPath={:?}", ctx.alt_path)));
        }
        let head = ctx.kids.first().map(js_string).unwrap_or_default();
        let kids = std::mem::take(&mut ctx.kids);
        return ts_obj("Type", vec![
            ("children", ts_arr(kids)),
            ("headText", ts_lit_str(&head)),
            ("off", ts_lit_num(ctx.off as f64)),
            ("end", ts_lit_num(ctx.end as f64)),
        ]);
    }
    let op = ctx.op_text.unwrap_or("");
    let left = ctx.left.take().unwrap_or_else(ts_null);
    if op == "extends" {
        ts_obj("TSConditionalType", vec![
            ("checkType", left),
            ("extendsType", take_kid(&mut ctx.kids, 0)),
            ("trueType", take_kid(&mut ctx.kids, 1)),
            ("falseType", take_kid(&mut ctx.kids, 2)),
        ])
    } else if op == "[" {
        ts_obj("TSIndexedAccessType", vec![("objectType", left), ("indexType", take_kid(&mut ctx.kids, 0))])
    } else if op == "<" || op == "|" || op == "&" || op == "." || op == "?" || op == "!" {
        ts_obj("TSTypeReference", vec![
            ("typeName", left),
            ("typeParameters", take_kid(&mut ctx.kids, 0)),
            ("meta", ts_obj("", vec![("op", ts_lit_str(op))])),
        ])
    } else {
        unhandled("tsTypeLed", &ctx.alt_path, ctx.op_text, Some(&format!("LED altPath={:?} opText={:?}", ctx.alt_path, op)))
    }
}

fn estree_new_target_led(mut ctx: AstCustomCtx<'_>) -> AstValue {
    let op = ctx.op_text.unwrap_or("");
    let left = ctx.left.take().unwrap_or_else(ts_null);
    let first_is_target = matches!(ctx.kids.first(), Some(AstValue::String(s)) if s == "target");
    if op == "." && first_is_target && head_is_new(&left) {
        return ts_obj("MetaProperty", vec![("meta", ts_ident("new")), ("property", ts_ident("target"))]);
    }
    if op == "." { member_expr(left, take_opt(&mut ctx.kids, 0).unwrap_or_else(|| ts_lit_str("undefined")), false) }
    else if op == "[" { member_expr(left, take_opt(&mut ctx.kids, 0).unwrap_or_else(|| ts_lit_str("undefined")), true) }
    else { unhandled("estreeNewTargetLed", &ctx.alt_path, ctx.op_text, None) }
}

fn estree_array_pattern(mut ctx: AstCustomCtx<'_>) -> AstValue {
    if ctx.alt_path.first().copied() != Some(1) { unhandled("estreeArrayPattern", &ctx.alt_path, ctx.op_text, None); }
    let mut elems = Vec::new();
    for k in std::mem::take(&mut ctx.kids) {
        match k {
            AstValue::Array(xs) => elems.extend(xs),
            other => elems.push(other),
        }
    }
    ts_obj("ArrayPattern", vec![("elements", ts_arr(elems))])
}

fn estree_binding_property(mut ctx: AstCustomCtx<'_>) -> AstValue {
    let arm = ctx.alt_path.first().copied();
    let a = take_kid(&mut ctx.kids, 0);
    let b = take_kid(&mut ctx.kids, 1);
    match arm {
        Some(1) => {
            let name = match &a { AstValue::String(s) => s.clone(), _ => String::new() };
            ts_obj("Property", vec![
                ("key", ts_ident(&name)),
                ("value", ts_ident(&name)),
                ("kind", ts_lit_str("init")), ("method", ts_bool(false)), ("shorthand", ts_bool(true)), ("computed", ts_bool(false)),
            ])
        }
        Some(3) => ts_obj("RestElement", vec![("argument", a)]),
        Some(2) => ts_obj("Property", vec![
            ("key", a), ("value", b), ("kind", ts_lit_str("init")), ("method", ts_bool(false)),
            ("shorthand", ts_bool(false)), ("computed", ts_bool(true)),
        ]),
        Some(0) => ts_obj("Property", vec![
            ("key", match a { AstValue::String(s) => ts_ident(&s), other => other }),
            ("value", b), ("kind", ts_lit_str("init")), ("method", ts_bool(false)),
            ("shorthand", ts_bool(false)), ("computed", ts_bool(false)),
        ]),
        _ => unhandled("estreeBindingProperty", &ctx.alt_path, ctx.op_text, None),
    }
}

fn estree_param(mut ctx: AstCustomCtx<'_>) -> AstValue {
    let arm = ctx.alt_path.first().copied();
    match arm {
        Some(0) => {
            let mut o = ts_obj("Identifier", vec![("name", ts_lit_str("this"))]);
            if let AstValue::Object { ref mut fields, .. } = o {
                fields.push(("typeAnnotation", take_kid(&mut ctx.kids, 0)));
            }
            o
        }
        Some(1) | Some(2) => {
            let len = ctx.kids.len();
            let i = len.saturating_sub(2);
            // len ≤ 2: kids[0] feeds both id and decorators (the original cloned it twice).
            let (id, deco_src) = if i == 0 && len > 0 {
                let v = take_kid(&mut ctx.kids, 0);
                (v.clone(), Some(v))
            } else {
                (take_kid(&mut ctx.kids, i), take_opt(&mut ctx.kids, 0))
            };
            let (typ, mut fields): (&'static str, Vec<(&'static str, AstValue)>) = match id {
                AstValue::String(s) => ("Identifier", vec![("name", ts_lit_str(&s))]),
                AstValue::Object { typ, fields: fs } => (
                    if typ.is_empty() { "Identifier" } else { typ },
                    fs,
                ),
                _ => ("Identifier", vec![("name", ts_lit_str(""))]),
            };
            fields.push(("decorators", ts_arr(flat_take(vec![deco_src.unwrap_or_else(|| ts_arr(vec![]))]))));
            fields.push(("optional", ts_bool(arm == Some(1))));
            AstValue::Object { typ, fields }
        }
        _ => unhandled("estreeParam", &ctx.alt_path, ctx.op_text, None),
    }
}

fn estree_for_head(mut ctx: AstCustomCtx<'_>) -> AstValue {
    let arm = ctx.alt_path.first().copied();
    let src = ctx.src;
    let off = ctx.off;
    let k = &mut ctx.kids;
    match arm {
        Some(0) => ts_obj("ForHead", vec![
            ("kind", ts_lit_str("classic")),
            ("init", take_kid(k, 0)),
            ("test", take_kid(k, 1)),
            ("update", take_kid(k, 2)),
        ]),
        Some(1) => ts_obj("ForHead", vec![
            ("kind", ts_lit_str("classic")),
            ("init", seq_expr(take_opt(k, 0), None).unwrap_or_else(ts_null)),
            ("test", seq_expr(take_opt(k, 1), None).unwrap_or_else(ts_null)),
            ("update", seq_expr(take_opt(k, 2), None).unwrap_or_else(ts_null)),
        ]),
        Some(2) => ts_obj("ForHead", vec![
            ("kind", ts_lit_str("in")),
            ("left", take_kid(k, 0)),
            ("right", take_kid(k, 1)),
        ]),
        Some(3) => ts_obj("ForHead", vec![
            ("kind", ts_lit_str("of")),
            ("left", take_kid(k, 0)),
            ("right", take_kid(k, 1)),
            ("await", ts_bool(prefix(src, off, 5).contains("await"))),
        ]),
        _ => unhandled("estreeForHead", &ctx.alt_path, ctx.op_text, None),
    }
}

fn estree_switch_case(mut ctx: AstCustomCtx<'_>) -> AstValue {
    let arm = ctx.alt_path.first().copied();
    match arm {
        Some(2) => shape_partial("switch-consequent", "append", take_kid(&mut ctx.kids, 0)),
        Some(1) => shape_partial("switch-consequent", "start", ts_obj("SwitchCase", vec![
            ("test", ts_null()), ("consequent", ts_arr(vec![])),
        ])),
        Some(0) => shape_partial("switch-consequent", "start", ts_obj("SwitchCase", vec![
            ("test", seq_expr(take_opt(&mut ctx.kids, 0), take_opt(&mut ctx.kids, 1)).unwrap_or_else(ts_null)),
            ("consequent", ts_arr(vec![])),
        ])),
        _ => unhandled("estreeSwitchCase", &ctx.alt_path, ctx.op_text, None),
    }
}

fn estree_decorator(mut ctx: AstCustomCtx<'_>) -> AstValue {
    let arm = ctx.alt_path.first().copied();
    if arm.is_none() || arm.unwrap() > 1 { unhandled("estreeDecorator", &ctx.alt_path, ctx.op_text, None); }
    let chain = flat_take(std::mem::take(&mut ctx.kids));
    let mut it = chain.into_iter();
    let head = it.next().unwrap_or_else(ts_null);
    let mut expr = match head {
        AstValue::String(s) if s.starts_with('@') => ts_ident(&s[1..]),
        other => other,
    };
    for step in it {
        match step {
            AstValue::Array(xs) => expr = call_expr(expr, xs),
            AstValue::Object { .. } => expr = call_expr(expr, vec![step]),
            other => expr = member_expr(expr, other, false),
        }
    }
    ts_obj("Decorator", vec![("expression", expr)])
}

fn estree_class_member(mut ctx: AstCustomCtx<'_>) -> AstValue {
    let arm = ctx.alt_path.first().copied();
    match arm {
        Some(0) => ts_null(),
        Some(1) => ts_obj("MethodDefinition", vec![
            ("kind", ts_lit_str("constructor")), ("key", ts_ident("constructor")),
            ("value", ts_obj("FunctionExpression", vec![
                ("params", ts_arr(flat_take(vec![take_kid(&mut ctx.kids, 0)]))),
                ("body", take_kid(&mut ctx.kids, 1)),
            ])),
            ("static", ts_bool(false)),
        ]),
        Some(2) => ts_obj("StaticBlock", vec![("body", take_kid(&mut ctx.kids, 0))]),
        Some(4) => ts_obj("PropertyDefinition", vec![
            ("key", take_kid(&mut ctx.kids, 0)),
            ("value", take_kid(&mut ctx.kids, 1)),
            ("static", ts_bool(false)), ("readonly", ts_bool(false)),
        ]),
        Some(3) | Some(5) => {
            let nested = ctx.alt_path.get(1).copied();
            if arm == Some(3) && nested == Some(8) {
                let mut branch = match take_opt(&mut ctx.kids, 1) { Some(AstValue::Array(xs)) => xs, _ => Vec::new() };
                let mut tail = match branch.get_mut(1) { Some(AstValue::Array(xs)) => std::mem::take(xs), _ => Vec::new() };
                return ts_obj("MethodDefinition", vec![
                    ("kind", ts_lit_str("method")),
                    ("key", take_kid(&mut branch, 0)),
                    ("value", ts_obj("FunctionExpression", vec![
                        ("params", ts_arr(flat_take(vec![take_kid(&mut tail, 1)]))),
                        ("body", take_kid(&mut tail, 3)),
                        ("async", ts_bool(false)), ("generator", ts_bool(false)),
                    ])),
                    ("static", ts_bool(false)), ("computed", ts_bool(false)),
                ]);
            }
            if arm == Some(5) {
                return ts_obj("MethodDefinition", vec![
                    ("kind", ts_lit_str("method")),
                    ("key", take_kid(&mut ctx.kids, 0)),
                    ("value", take_kid(&mut ctx.kids, 1)),
                    ("static", ts_bool(true)),
                ]);
            }
            if nested.map(|n| n <= 8).unwrap_or(false) {
                return ts_obj("MethodDefinition", vec![
                    ("kind", ts_lit_str("method")),
                    ("key", take_kid(&mut ctx.kids, 0)),
                    ("value", take_kid(&mut ctx.kids, 1)),
                    ("static", ts_bool(false)),
                ]);
            }
            unhandled("estreeClassMember", &ctx.alt_path, ctx.op_text, None)
        }
        _ => unhandled("estreeClassMember", &ctx.alt_path, ctx.op_text, None),
    }
}

fn ts_interface_member(mut ctx: AstCustomCtx<'_>) -> AstValue {
    let arm = ctx.alt_path.first().copied();
    let src = ctx.src;
    match arm {
        Some(0) => {
            let construct = span_str(src, ctx.off, ctx.end).trim_start().starts_with("new");
            let typ = if construct { "TSConstructSignatureDeclaration" } else { "TSCallSignatureDeclaration" };
            ts_obj(typ, vec![
                ("typeParameters", take_kid(&mut ctx.kids, 0)),
                ("params", ts_arr(flat_take(vec![take_kid(&mut ctx.kids, 1)]))),
                ("returnType", take_kid(&mut ctx.kids, 2)),
            ])
        }
        Some(1) => ts_obj("TSMethodSignature", vec![
            ("kind", ts_lit_str(prefix(src, ctx.off, 3))),
            ("key", take_kid(&mut ctx.kids, 0)),
            ("params", ts_arr(flat_take(vec![take_kid(&mut ctx.kids, 1)]))),
            ("returnType", take_kid(&mut ctx.kids, 2)),
        ]),
        Some(2) => {
            // len ≤ 2: typeAnnotation (last kid) aliases key (len 1) or constraint (len 2).
            let len = ctx.kids.len();
            let key = take_kid(&mut ctx.kids, 0);
            let constraint = take_kid(&mut ctx.kids, 1);
            let ann = if len == 1 { key.clone() } else if len == 2 { constraint.clone() } else { take_last(&mut ctx.kids) };
            ts_obj("TSMappedType", vec![
                ("key", key),
                ("constraint", constraint),
                ("typeAnnotation", ann),
            ])
        }
        Some(3) => ts_obj("TSPropertySignature", vec![
            ("key", take_kid(&mut ctx.kids, 0)),
            ("typeAnnotation", take_kid(&mut ctx.kids, 1)),
            ("optional", ts_bool(src.contains('?'))), ("readonly", ts_bool(true)),
        ]),
        Some(4) => {
            let method = matches!(ctx.kids.get(2), Some(AstValue::Array(_)));
            if method {
                ts_obj("TSMethodSignature", vec![
                    ("key", take_kid(&mut ctx.kids, 0)),
                    ("params", ts_arr(flat_take(vec![take_kid(&mut ctx.kids, 2)]))),
                    ("returnType", take_kid(&mut ctx.kids, 3)),
                    ("optional", ts_bool(src.contains('?'))),
                ])
            } else {
                ts_obj("TSPropertySignature", vec![
                    ("key", take_kid(&mut ctx.kids, 0)),
                    ("typeAnnotation", take_kid(&mut ctx.kids, 1)),
                    ("optional", ts_bool(src.contains('?'))), ("readonly", ts_bool(false)),
                ])
            }
        }
        Some(5) => ts_obj("TSIndexSignature", vec![
            ("parameters", ts_arr(flat_take(vec![take_kid(&mut ctx.kids, 0)]))),
            ("typeAnnotation", take_kid(&mut ctx.kids, 1)),
        ]),
        _ => unhandled("tsInterfaceMember", &ctx.alt_path, ctx.op_text, None),
    }
}

fn ts_type_member(mut ctx: AstCustomCtx<'_>) -> AstValue {
    let arm = ctx.alt_path.first().copied();
    let src = ctx.src;
    match arm {
        Some(0) => {
            let construct = span_str(src, ctx.off, ctx.end).trim_start().starts_with("new");
            let typ = if construct { "TSConstructSignatureDeclaration" } else { "TSCallSignatureDeclaration" };
            ts_obj(typ, vec![
                ("typeParameters", take_kid(&mut ctx.kids, 0)),
                ("params", ts_arr(flat_take(vec![take_kid(&mut ctx.kids, 1)]))),
                ("returnType", take_kid(&mut ctx.kids, 2)),
            ])
        }
        Some(1) => {
            // len == 1: kids[0] feeds both parameters and typeAnnotation.
            let params = take_kid(&mut ctx.kids, 0);
            let ann = if ctx.kids.len() == 1 { params.clone() } else { take_last(&mut ctx.kids) };
            ts_obj("TSIndexSignature", vec![
                ("parameters", ts_arr(flat_take(vec![params]))),
                ("typeAnnotation", ann),
            ])
        }
        Some(2) => ts_obj("TSPropertySignature", vec![
            ("key", take_kid(&mut ctx.kids, 0)),
            ("typeAnnotation", take_kid(&mut ctx.kids, 1)),
            ("optional", ts_bool(src.contains('?'))), ("readonly", ts_bool(true)),
        ]),
        Some(3) => {
            let method = matches!(ctx.kids.get(2), Some(AstValue::Array(_)));
            if method {
                ts_obj("TSMethodSignature", vec![
                    ("key", take_kid(&mut ctx.kids, 0)),
                    ("params", ts_arr(flat_take(vec![take_kid(&mut ctx.kids, 2)]))),
                    ("returnType", take_kid(&mut ctx.kids, 3)),
                    ("optional", ts_bool(src.contains('?'))),
                ])
            } else {
                ts_obj("TSPropertySignature", vec![
                    ("key", take_kid(&mut ctx.kids, 0)),
                    ("typeAnnotation", take_kid(&mut ctx.kids, 1)),
                    ("optional", ts_bool(src.contains('?'))), ("readonly", ts_bool(false)),
                ])
            }
        }
        _ => unhandled("tsTypeMember", &ctx.alt_path, ctx.op_text, None),
    }
}

fn estree_prop(mut ctx: AstCustomCtx<'_>) -> AstValue {
    let arm = ctx.alt_path.first().copied();
    let k = &mut ctx.kids;
    match arm {
        Some(4) | Some(5) => {
            let name = match take_opt(k, 0) { Some(AstValue::String(s)) => s, _ => String::new() };
            ts_obj("Property", vec![
                ("key", ts_ident(&name)),
                ("value", ts_ident(&name)),
                ("kind", ts_lit_str("init")), ("shorthand", ts_bool(true)), ("computed", ts_bool(false)), ("method", ts_bool(false)),
            ])
        }
        Some(8) => ts_obj("SpreadElement", vec![("argument", take_kid(k, 0))]),
        Some(6) | Some(7) => ts_obj("Property", vec![
            ("key", take_kid(k, 0)),
            ("value", take_kid(k, 1)),
            ("kind", ts_lit_str(if arm == Some(6) { "get" } else { "set" })),
            ("shorthand", ts_bool(false)), ("computed", ts_bool(false)), ("method", ts_bool(false)),
        ]),
        Some(2) | Some(3) => ts_obj("Property", vec![
            ("key", take_kid(k, 0)),
            ("value", ts_obj("FunctionExpression", vec![
                ("params", ts_arr(flat_take(vec![take_kid(k, 1)]))),
                ("body", take_kid(k, 2)),
            ])),
            ("kind", ts_lit_str("init")), ("method", ts_bool(true)),
            ("shorthand", ts_bool(false)), ("computed", ts_bool(false)),
        ]),
        Some(0) | Some(1) | Some(9) | Some(10) | Some(11) => ts_obj("Property", vec![
            ("key", match take_opt(k, 0) { Some(AstValue::String(s)) => ts_ident(&s), Some(other) => other, None => ts_null() }),
            ("value", take_kid(k, 1)),
            ("kind", ts_lit_str("init")), ("shorthand", ts_bool(false)),
            ("computed", ts_bool(arm == Some(1))), ("method", ts_bool(false)),
        ]),
        _ => unhandled("estreeProp", &ctx.alt_path, ctx.op_text, None),
    }
}

pub struct TsEstreeCustoms;
impl ShapeCustoms for TsEstreeCustoms {
    /// Match JS `Number(text)`: hex/bin/octal OK; numeric separators → NaN; never panic.
    fn leaf_number(&self, text: &str) -> f64 {
        if text.contains('_') { return f64::NAN; }
        let bytes = text.as_bytes();
        if bytes.len() >= 3 && bytes[0] == b'0' {
            let (radix, rest) = match bytes[1] {
                b'x' | b'X' => (16u32, &text[2..]),
                b'b' | b'B' => (2u32, &text[2..]),
                b'o' | b'O' => (8u32, &text[2..]),
                _ => (0u32, ""),
            };
            if radix != 0 {
                return u64::from_str_radix(rest, radix).map(|n| n as f64).unwrap_or(f64::NAN);
            }
        }
        text.parse::<f64>().unwrap_or(f64::NAN)
    }
    fn ast_custom(&self, name: &str, ctx: AstCustomCtx<'_>) -> AstValue {
        match name {
            "estreeStmt" => estree_stmt(ctx),
            "estreeDecl" => estree_decl(ctx),
            "estreeParenOrComma" => estree_paren_or_comma(ctx),
            "estreeExprBinary" => estree_expr_binary(ctx),
            "estreeExprPrefix" => estree_expr_prefix(ctx),
            "estreeExprPostfixTok" => estree_expr_postfix_tok(ctx),
            "estreeTemplateLiteral" => estree_template_literal(ctx),
            "estreeExprLed" => estree_expr_led(ctx),
            "estreeExprNudSeq" => estree_expr_nud_seq(ctx),
            "estreeArrow" => estree_arrow(ctx),
            "tsTypeLed" => ts_type_led(ctx),
            "estreeNewTargetLed" => estree_new_target_led(ctx),
            "estreeArrayPattern" => estree_array_pattern(ctx),
            "estreeBindingProperty" => estree_binding_property(ctx),
            "estreeParam" => estree_param(ctx),
            "estreeForHead" => estree_for_head(ctx),
            "estreeSwitchCase" => estree_switch_case(ctx),
            "estreeDecorator" => estree_decorator(ctx),
            "estreeClassMember" => estree_class_member(ctx),
            "tsInterfaceMember" => ts_interface_member(ctx),
            "tsTypeMember" => ts_type_member(ctx),
            "estreeProp" => estree_prop(ctx),
            _ => panic!("shape rust: custom {} not provided — SH3-4", name),
        }
    }
}
