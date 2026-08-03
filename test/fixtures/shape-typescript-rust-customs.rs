
// ── SH3-4 ESTree customs (mirrors shape-typescript.ts) ─────────────────────
// SH3-6: ported to the arena value API (SVal/AstArena). kids arrive as a
// borrowed slice (SVal is Copy — no mem::take/replace; every old double-feed
// clone site now just copies the SVal); all construction goes through the
// arena (mk_obj/mk_list/mk_own_str/mk_partial). Field order and output
// strings are preserved exactly — the gate diffs JSON byte-for-byte.
// ── SH3-6 M2: typed ESTree nodes (customs-owned arena) ─────────────────────
// M11 measured-and-rejected (inlining 擾動 −0.7ms，回退 RefCell): the typed
// arena stays behind RefCell inside TsEstreeCustoms; handlers borrow per site.
// Typed direct-emit milestone 1: BinaryExpression. SVal::TNode(tag, idx)
// references this arena; JSON via ShapeCustoms::write_tnode_json. Arena is
// append-only (speculative entries on failed branches are just unused — same
// trade as the DynObj ck watermark, minus the watermark for now).
#[derive(Default)]
pub struct TnodesArena<'a> {
    bin_exprs: Vec<TBinExpr<'a>>,
    var_declarators: Vec<TVarDeclarator<'a>>,
    switch_cases: Vec<TSwitchCase<'a>>,
    idents: Vec<TIdentifier>,
    expr_stmts: Vec<TExprStmt<'a>>,
    call_exprs: Vec<TCallExpr>,
    member_exprs: Vec<TMemberExpr>,
    var_decls: Vec<TVarDecl>,
    block_stmts: Vec<TBlockStmt<'a>>,
    properties: Vec<TProperty<'a>>,
    func_decls: Vec<TFuncDecl<'a>>,
    arrow_fns: Vec<TArrowFn>,
    template_lits: Vec<TTemplateLit>,
    template_els: Vec<TTemplateEl>,
    // ── batch 4: statement family ──
    if_stmts: Vec<TIfStmt>,
    for_stmts: Vec<TForStmt<'a>>,
    for_in_stmts: Vec<TForInStmt<'a>>,
    for_of_stmts: Vec<TForOfStmt<'a>>,
    while_stmts: Vec<TWhileStmt>,
    do_while_stmts: Vec<TDoWhileStmt>,
    switch_stmts: Vec<TSwitchStmt>,
    return_stmts: Vec<TReturnStmt>,
    throw_stmts: Vec<TThrowStmt>,
    break_stmts: Vec<TBreakStmt<'a>>,
    continue_stmts: Vec<TContinueStmt<'a>>,
    try_stmts: Vec<TTryStmt<'a>>,
    labeled_stmts: Vec<TLabeledStmt>,
    units: Vec<TUnit>,
    with_stmts: Vec<TWithStmt>,
    seq_exprs: Vec<TSeqExpr>,
    cond_exprs: Vec<TCondExpr>,
    assign_exprs: Vec<TAssignExpr<'a>>,
    logical_exprs: Vec<TLogicalExpr<'a>>,
    unary_exprs: Vec<TUnaryExpr<'a>>,
    update_exprs: Vec<TUpdateExpr<'a>>,
    // ── batch 4: module/class family ──
    export_nameds: Vec<TExportNamed<'a>>,
    export_alls: Vec<TExportAll<'a>>,
    export_defaults: Vec<TExportDefault<'a>>,
    import_decls: Vec<TImportDecl<'a>>,
    class_decls: Vec<TClassDecl<'a>>,
    class_bodys: Vec<TClassBody>,
    class_exprs: Vec<TClassExpr>,
    method_defs: Vec<TMethodDef<'a>>,
    static_blocks: Vec<TStaticBlock>,
    property_defs: Vec<TPropertyDef<'a>>,
    decorators: Vec<TDecorator>,
    meta_props: Vec<TMetaProperty>,
    function_exprs: Vec<TFunctionExpr>,
    rest_elements: Vec<TRestElement>,
    spread_elements: Vec<TSpreadElement>,
    // ── batch 4: TS family + misc ──
    ts_interface_decls: Vec<TTSInterfaceDecl<'a>>,
    ts_interface_bodys: Vec<TTSInterfaceBody<'a>>,
    ts_property_sigs: Vec<TTSPropertySig<'a>>,
    ts_mapped_types: Vec<TTSMappedType>,
    ts_index_sigs: Vec<TTSIndexSig<'a>>,
    ts_method_sigs: Vec<TTSMethodSig<'a>>,
    ts_type_refs: Vec<TTSTypeRef<'a>>,
    ts_type_literals: Vec<TTSTypeLiteral<'a>>,
    ts_type_aliases: Vec<TTSTypeAlias<'a>>,
    ts_cond_types: Vec<TTSCondType<'a>>,
    ts_indexed_accesses: Vec<TTSIndexedAccess<'a>>,
    ts_non_nulls: Vec<TTSNonNull<'a>>,
    ts_as_exprs: Vec<TTSAsExpr<'a>>,
    ts_satisfies_exprs: Vec<TTSSatisfiesExpr<'a>>,
    ts_instantiation_exprs: Vec<TTSInstantiationExpr<'a>>,
    ts_namespace_exports: Vec<TTSNamespaceExport<'a>>,
    ts_module_decls: Vec<TTSModuleDecl<'a>>,
    ts_import_equals: Vec<TTSImportEquals<'a>>,
    ts_enum_decls: Vec<TTSEnumDecl<'a>>,
    types: Vec<TType>,
    for_heads: Vec<TForHead<'a>>,
    declarations: Vec<TDeclaration<'a>>,
    tagged_templates: Vec<TTaggedTemplate>,
    array_patterns: Vec<TArrayPattern>,
    ts_call_sigs: Vec<TTSCallSig>,
    type_keeps: Vec<TTypeKeep>,
    block_stmt_sps: Vec<TBlockStmtSp>,
    member_names: Vec<TMemberName>,
    ts_type_params: Vec<TTSTypeParam>,
    ts_type_param_decls: Vec<TTSTypeParamDecl>,
    raw_vals: Vec<TRawVal<'a>>,
    meta_ops: Vec<TMetaOp<'a>>,
    param_idents: Vec<TParamIdent<'a>>,
    numbers: Vec<f64>,
    spans: Vec<(u32, u32)>,
}
#[derive(Clone, Copy)]
struct TBinExpr<'a> { left: LeanSVal, operator: SVal<'a>, right: LeanSVal }
const TN_BINEXPR: u16 = 1;
/// M2 typed: VariableDeclarator (Binding/ForBinding route via estreeVariableDeclarator).
#[derive(Clone, Copy)]
struct TVarDeclarator<'a> { id: SVal<'a>, type_annotation: ChildRef, init: LeanSVal, off: u32, end: u32 }
const TN_VARDECLARATOR: u16 = 75;
/// M2 typed: SwitchCase — fold protocol goes through tnode_fold_append.
#[derive(Clone, Copy)]
struct TSwitchCase<'a> { test: SVal<'a>, consequent: SVal<'a> }
const TN_SWITCHCASE: u16 = 76;
/// Identifier; type_annotation present only for the estreeParam this-param arm.
#[derive(Clone, Copy)]
struct TIdentifier { name: LeanSVal, type_annotation: ChildRef }
const TN_IDENT: u16 = 2;
#[derive(Clone, Copy)]
struct TExprStmt<'a> { expression: SVal<'a> }
const TN_EXPRSTMT: u16 = 3;
/// CallExpression — optional/typeArguments appended (in that order) only when Some.
#[derive(Clone, Copy)]
struct TCallExpr { callee: LeanSVal, arguments: (u32, u32), optional: Option<bool>, type_arguments: Option<(u32, u32)> }
const TN_CALL: u16 = 4;
/// MemberExpression — all four fields always present. dup_optional reproduces the
/// legacy `"optional":false,"optional":true` duplicate key of the optional-chain arms.
#[derive(Clone, Copy)]
struct TMemberExpr { object: LeanSVal, property: LeanSVal, computed: bool, optional: bool, dup_optional: bool }
const TN_MEMBER: u16 = 5;
/// VariableDeclaration (kind/declarations). VariableDeclarator stays parser-side
/// (built by emitted mk_obj_raw in p-ts.rs — not reachable from customs).
#[derive(Clone, Copy)]
struct TVarDecl { kind: LeanSVal, declarations: (u32, u32) }
const TN_VARDECL: u16 = 6;
#[derive(Clone, Copy)]
struct TBlockStmt<'a> { body: SVal<'a> }
const TN_BLOCKSTMT: u16 = 7;
/// Property — the three trailing bools swap order by arm: method_first=true writes
/// method,shorthand,computed (binding arms + prop method arm 2|3); false writes
/// shorthand,computed,method (prop shorthand/getset/plain arms).
#[derive(Clone, Copy)]
struct TProperty<'a> { key: LeanSVal, value: SVal<'a>, kind: LeanSVal, method: bool, shorthand: bool, computed: bool, method_first: bool }
const TN_PROPERTY: u16 = 8;
/// FunctionDeclaration — fixed field order async,generator,id,typeParameters,params,returnType,body.
#[derive(Clone, Copy)]
struct TFuncDecl<'a> { async_: bool, generator: bool, id: SVal<'a>, type_parameters: SVal<'a>, params: (u32, u32), return_type: SVal<'a>, body: ChildRef }
const TN_FUNCDECL: u16 = 9;
/// ArrowFunctionExpression — fixed order params,body,async,expression.
#[derive(Clone, Copy)]
struct TArrowFn { params: (u32, u32), body: LeanSVal, async_: bool, expression: bool }
const TN_ARROWFN: u16 = 10;
#[derive(Clone, Copy)]
struct TTemplateLit { quasis: (u32, u32), expressions: (u32, u32) }
const TN_TEMPLATELIT: u16 = 11;
/// TemplateElement — value is the typed TRawVal `{"raw":X}` wrapper (no "type" key; M14b).
#[derive(Clone, Copy)]
struct TTemplateEl { value: u32, tail: bool }
const TN_TEMPLATEEL: u16 = 12;
// ── batch 4: statement family (fixed field orders) ──
#[derive(Clone, Copy)]
struct TIfStmt { test: LeanSVal, consequent: ChildRef, alternate: ChildRef }
const TN_IF: u16 = 13;
#[derive(Clone, Copy)]
struct TForStmt<'a> { init: SVal<'a>, test: LeanSVal, update: LeanSVal, body: ChildRef }
const TN_FOR: u16 = 14;
#[derive(Clone, Copy)]
struct TForInStmt<'a> { left: SVal<'a>, right: SVal<'a>, body: SVal<'a> }
const TN_FORIN: u16 = 15;
#[derive(Clone, Copy)]
struct TForOfStmt<'a> { left: SVal<'a>, right: SVal<'a>, body: SVal<'a>, await_: bool }
const TN_FOROF: u16 = 16;
#[derive(Clone, Copy)]
struct TWhileStmt { test: LeanSVal, body: ChildRef }
const TN_WHILE: u16 = 17;
/// DoWhileStatement — order is body,test (not test,body).
#[derive(Clone, Copy)]
struct TDoWhileStmt { body: ChildRef, test: LeanSVal }
const TN_DOWHILE: u16 = 18;
#[derive(Clone, Copy)]
struct TSwitchStmt { discriminant: LeanSVal, cases: (u32, u32) }
const TN_SWITCH: u16 = 19;
#[derive(Clone, Copy)]
struct TReturnStmt { argument: LeanSVal }
const TN_RETURN: u16 = 20;
#[derive(Clone, Copy)]
struct TThrowStmt { argument: LeanSVal }
const TN_THROW: u16 = 21;
#[derive(Clone, Copy)]
struct TBreakStmt<'a> { label: SVal<'a> }
const TN_BREAK: u16 = 22;
#[derive(Clone, Copy)]
struct TContinueStmt<'a> { label: SVal<'a> }
const TN_CONTINUE: u16 = 23;
#[derive(Clone, Copy)]
struct TTryStmt<'a> { block: ChildRef, handler: SVal<'a>, finalizer: ChildRef }
const TN_TRY: u16 = 24;
#[derive(Clone, Copy)]
struct TLabeledStmt { label: ChildRef, body: ChildRef }
const TN_LABELED: u16 = 25;
/// Field-less marker shared by EmptyStatement/DebuggerStatement (tag picks the name).
#[derive(Clone, Copy)]
struct TUnit;
const TN_EMPTY: u16 = 26;
const TN_DEBUGGER: u16 = 27;
#[derive(Clone, Copy)]
struct TWithStmt { object: LeanSVal, body: ChildRef }
const TN_WITH: u16 = 28;
#[derive(Clone, Copy)]
struct TSeqExpr { expressions: (u32, u32) }
const TN_SEQ: u16 = 29;
#[derive(Clone, Copy)]
struct TCondExpr { test: LeanSVal, consequent: LeanSVal, alternate: LeanSVal }
const TN_COND: u16 = 30;
#[derive(Clone, Copy)]
struct TAssignExpr<'a> { left: LeanSVal, operator: SVal<'a>, right: LeanSVal }
const TN_ASSIGN: u16 = 31;
#[derive(Clone, Copy)]
struct TLogicalExpr<'a> { left: LeanSVal, operator: SVal<'a>, right: LeanSVal }
const TN_LOGICAL: u16 = 32;
#[derive(Clone, Copy)]
struct TUnaryExpr<'a> { operator: SVal<'a>, argument: LeanSVal, prefix: bool }
const TN_UNARY: u16 = 33;
#[derive(Clone, Copy)]
struct TUpdateExpr<'a> { operator: SVal<'a>, argument: SVal<'a>, prefix: bool }
const TN_UPDATE: u16 = 34;
// ── batch 4: module/class family ──
/// ExportNamedDeclaration — exactly one of declaration/specifiers per site.
#[derive(Clone, Copy)]
struct TExportNamed<'a> { declaration: Option<SVal<'a>>, specifiers: Option<SVal<'a>> }
const TN_EXPORTNAMED: u16 = 35;
#[derive(Clone, Copy)]
struct TExportAll<'a> { source: SVal<'a> }
const TN_EXPORTALL: u16 = 36;
#[derive(Clone, Copy)]
struct TExportDefault<'a> { declaration: SVal<'a> }
const TN_EXPORTDEFAULT: u16 = 37;
#[derive(Clone, Copy)]
struct TImportDecl<'a> { specifiers: (u32, u32), source: SVal<'a> }
const TN_IMPORT: u16 = 38;
#[derive(Clone, Copy)]
struct TClassDecl<'a> { decorators: (u32, u32), id: SVal<'a>, super_class: SVal<'a>, body: u32 }
const TN_CLASSDECL: u16 = 39;
#[derive(Clone, Copy)]
struct TClassBody { body: (u32, u32) }
const TN_CLASSBODY: u16 = 40;
#[derive(Clone, Copy)]
struct TClassExpr { decorators: (u32, u32), id: ChildRef, body: ChildRef }
const TN_CLASSEXPR: u16 = 41;
/// MethodDefinition — order kind,key,value,static; computed appended only when Some (nested-8 arm).
#[derive(Clone, Copy)]
struct TMethodDef<'a> { kind: LeanSVal, key: SVal<'a>, value: SVal<'a>, static_: bool, computed: Option<bool> }
const TN_METHODDEF: u16 = 42;
#[derive(Clone, Copy)]
struct TStaticBlock { body: (u32, u32) }
const TN_STATICBLOCK: u16 = 43;
#[derive(Clone, Copy)]
struct TPropertyDef<'a> { key: SVal<'a>, value: SVal<'a>, static_: bool, readonly: bool }
const TN_PROPDEF: u16 = 44;
#[derive(Clone, Copy)]
struct TDecorator { expression: LeanSVal }
const TN_DECORATOR: u16 = 45;
#[derive(Clone, Copy)]
struct TMetaProperty { meta: LeanSVal, property: LeanSVal }
const TN_METAPROP: u16 = 46;
/// FunctionExpression — async,generator appended (in that order) only when Some (nested-8 arm).
#[derive(Clone, Copy)]
struct TFunctionExpr { params: (u32, u32), body: ChildRef, async_: Option<bool>, generator: Option<bool> }
const TN_FUNCEXPR: u16 = 47;
#[derive(Clone, Copy)]
struct TRestElement { argument: LeanSVal }
const TN_REST: u16 = 48;
#[derive(Clone, Copy)]
struct TSpreadElement { argument: LeanSVal }
const TN_SPREAD: u16 = 49;
// ── batch 4: TS family + misc ──
/// TSInterfaceDeclaration — arm 27 [id,body]; arm 4 [id,typeParameters,extends,body].
#[derive(Clone, Copy)]
struct TTSInterfaceDecl<'a> { id: SVal<'a>, type_parameters: Option<SVal<'a>>, extends: Option<SVal<'a>>, body: ChildRef }
const TN_TSINTERFACEDECL: u16 = 50;
#[derive(Clone, Copy)]
struct TTSInterfaceBody<'a> { body: SVal<'a> }
const TN_TSINTERFACEBODY: u16 = 51;
#[derive(Clone, Copy)]
struct TTSPropertySig<'a> { key: LeanSVal, type_annotation: SVal<'a>, optional: bool, readonly: bool }
const TN_TSPROPSIG: u16 = 52;
#[derive(Clone, Copy)]
struct TTSMappedType { key: LeanSVal, constraint: ChildRef, type_annotation: ChildRef }
const TN_TSMAPPED: u16 = 53;
#[derive(Clone, Copy)]
struct TTSIndexSig<'a> { parameters: (u32, u32), type_annotation: SVal<'a> }
const TN_TSINDEXSIG: u16 = 54;
/// TSMethodSignature — arm 1 [kind,key,params,returnType]; arm 4/3 [key,params,returnType,optional].
#[derive(Clone, Copy)]
struct TTSMethodSig<'a> { kind: Option<SVal<'a>>, key: SVal<'a>, params: (u32, u32), return_type: ChildRef, optional: Option<bool> }
const TN_TSMETHODSIG: u16 = 55;
#[derive(Clone, Copy)]
struct TTSTypeRef<'a> { type_name: SVal<'a>, type_parameters: SVal<'a>, meta: ChildRef }
const TN_TSTYPEREF: u16 = 56;
#[derive(Clone, Copy)]
struct TTSTypeLiteral<'a> { members: SVal<'a> }
const TN_TSTYPELIT: u16 = 57;
#[derive(Clone, Copy)]
struct TTSTypeAlias<'a> { id: SVal<'a>, type_parameters: SVal<'a>, type_annotation: ChildRef }
const TN_TSALIAS: u16 = 58;
#[derive(Clone, Copy)]
struct TTSCondType<'a> { check_type: SVal<'a>, extends_type: SVal<'a>, true_type: SVal<'a>, false_type: SVal<'a> }
const TN_TSCONDTYPE: u16 = 59;
#[derive(Clone, Copy)]
struct TTSIndexedAccess<'a> { object_type: SVal<'a>, index_type: SVal<'a> }
const TN_TSINDEXED: u16 = 60;
#[derive(Clone, Copy)]
struct TTSNonNull<'a> { expression: SVal<'a> }
const TN_TSNONNULL: u16 = 61;
#[derive(Clone, Copy)]
struct TTSAsExpr<'a> { expression: SVal<'a>, type_annotation: SVal<'a> }
const TN_TSAS: u16 = 62;
#[derive(Clone, Copy)]
struct TTSSatisfiesExpr<'a> { expression: SVal<'a>, type_annotation: SVal<'a> }
const TN_TSSATISFIES: u16 = 63;
#[derive(Clone, Copy)]
struct TTSInstantiationExpr<'a> { expression: SVal<'a>, type_arguments: SVal<'a> }
const TN_TSINSTANTIATION: u16 = 64;
#[derive(Clone, Copy)]
struct TTSNamespaceExport<'a> { id: SVal<'a> }
const TN_TSNAMESPACE: u16 = 65;
/// TSModuleDeclaration — declare appended only when Some (arm 24).
#[derive(Clone, Copy)]
struct TTSModuleDecl<'a> { id: SVal<'a>, body: ChildRef, declare: Option<bool> }
const TN_TSMODULE: u16 = 66;
#[derive(Clone, Copy)]
struct TTSImportEquals<'a> { id: ChildRef, module_reference: SVal<'a> }
const TN_TSIMPORTEQUALS: u16 = 67;
#[derive(Clone, Copy)]
struct TTSEnumDecl<'a> { id: SVal<'a>, members: (u32, u32) }
const TN_TSENUM: u16 = 68;
/// The "Type" keep wrapper — children,headText,off,end (off/end as f64, ≡ SVal::Number).
#[derive(Clone, Copy)]
struct TType { children: (u32, u32), head_text: LeanSVal, off: u32, end: u32 }
const TN_TYPE: u16 = 69;
/// ForHead — classic [kind,init,test,update] | in [kind,left,right] | of [kind,left,right,await].
/// Writer emits in canonical order kind,init?,test?,update?,left?,right?,await? which
/// matches each arm's order exactly (field sets are disjoint after kind).
#[derive(Clone, Copy)]
struct TForHead<'a> { kind: LeanSVal, init: Option<SVal<'a>>, test: Option<SVal<'a>>, update: Option<SVal<'a>>, left: Option<SVal<'a>>, right: Option<SVal<'a>>, await_: Option<bool> }
const TN_FORHEAD: u16 = 70;
/// Passthrough Declaration debug node — alt as f64 (≡ SVal::Number).
#[derive(Clone, Copy)]
struct TDeclaration<'a> { alt: f64, children: SVal<'a> }
const TN_DECLARATION: u16 = 71;
#[derive(Clone, Copy)]
struct TTaggedTemplate { tag: LeanSVal, quasi: ChildRef }
const TN_TAGGEDTPL: u16 = 72;
#[derive(Clone, Copy)]
struct TArrayPattern { elements: (u32, u32) }
const TN_ARRAYPAT: u16 = 73;
/// TSConstructSignatureDeclaration (construct=true) / TSCallSignatureDeclaration (false).
#[derive(Clone, Copy)]
struct TTSCallSig { type_parameters: ChildRef, params: (u32, u32), return_type: ChildRef, construct: bool }
const TN_TSCALLSIG: u16 = 74;
/// M14: generated keep-wrapper "Type" node (children, headText — no off/end,
/// unlike TType which carries f64 spans). JSON must stay byte-identical to
/// the old DynObj {type, children, headText}.
#[derive(Clone, Copy)]
struct TTypeKeep { children: (u32, u32), head_text: LeanSVal }
const TN_TYPEKEEP: u16 = 77;
/// M14b: finish_obj typed conversions for emitter-generated node() finishes.
/// Field layouts mirror the declarative finishes exactly (byte-locked JSON).
#[derive(Clone, Copy)]
struct TBlockStmtSp { body: (u32, u32), off: u32, end: u32 }
const TN_BLOCKSTMT_SP: u16 = 78;
#[derive(Clone, Copy)]
struct TMemberName { children: (u32, u32), arm: LeanSVal, alt: u32 }
const TN_MEMBERNAME: u16 = 79;
#[derive(Clone, Copy)]
struct TTSTypeParam { name: LeanSVal, constraint: ChildRef, default: ChildRef, off: u32, end: u32 }
const TN_TSTYPEPARAM: u16 = 80;
#[derive(Clone, Copy)]
struct TTSTypeParamDecl { params: (u32, u32), off: u32, end: u32 }
const TN_TSTPARAMDECL: u16 = 81;
/// M14b: empty-typ single-field wrappers ({raw:X} TemplateElement value,
/// {op:X} type meta) — no "type" key in JSON.
#[derive(Clone, Copy)]
struct TRawVal<'a> { raw: SVal<'a> }
const TN_RAWVAL: u16 = 82;
#[derive(Clone, Copy)]
struct TMetaOp<'a> { op: SVal<'a> }
const TN_METAOP: u16 = 83;
/// M16 typed: estreeParam Identifier fallback (arms 1|2) — mirrors the old
/// DynObj field order name [,typeAnnotation] ,decorators,optional.
#[derive(Clone, Copy)]
struct TParamIdent<'a> { name: SVal<'a>, type_annotation: ChildRef, decorators: SVal<'a>, optional: bool }
const TN_PARAMIDENT: u16 = 84;

/// M27: (start, len) range from a List SVal — narrows list fields 16B→8B.
/// NodeList ranges carry the high-bit flag so write_list_range picks the slab.
const NL_FLAG: u32 = 0x8000_0000;
fn list_range(v: SVal) -> (u32, u32) {
    match v {
        SVal::List(s, l) => (s, l),
        SVal::NodeList(s, l) => (s | NL_FLAG, l),
        _ => panic!("list_range: expected List"),
    }
}
/// M27-B3: mk_list equivalent with NodeList fast path — all-TNode items pack
/// into node_lists (4B/elem); anything else falls back to the generic lists slab.
fn mk_fast<'a>(ar: &mut AstArena<'a>, items: &[SVal<'a>]) -> SVal<'a> {
    if items.iter().all(|v| matches!(v, SVal::TNode(..))) {
        let st = ar.node_lists.len() as u32;
        for v in items { if let SVal::TNode(t, i) = *v { ar.node_lists.push((t as u32) << 24 | i); } }
        SVal::NodeList(st, items.len() as u32)
    } else {
        let st = ar.lists.len() as u32;
        ar.lists.extend_from_slice(items);
        SVal::List(st, items.len() as u32)
    }
}
/// M27: {tag, idx} child ref — narrows child-node fields 16B→8B, keeps the tag
/// so any node type can be referenced (statements, types, idents).
#[derive(Clone, Copy)]
struct ChildRef { tag: u8, idx: u32 }
const CR_NULL: ChildRef = ChildRef { tag: 0, idx: u32::MAX };
fn child_ref(v: SVal) -> ChildRef {
    match v { SVal::TNode(t, i) => ChildRef { tag: t as u8, idx: i }, SVal::Null => CR_NULL, _ => panic!("child_ref: expected node or null") }
}
fn write_list_range<'a, C: ShapeCustoms<'a>>(ar: &AstArena<'a>, customs: &C, s: u32, l: u32, out: &mut String) {
    let nl = s & NL_FLAG != 0;
    let s = s & !NL_FLAG;
    out.push('[');
    if nl {
        for (i, e) in ar.node_lists[s as usize..(s + l) as usize].iter().enumerate() {
            if i > 0 { out.push(','); }
            write_sval_json(ar, customs, SVal::TNode((e >> 24) as u16, e & 0xFFFFFF), out);
        }
    } else {
        for (i, v) in ar.lists[s as usize..(s + l) as usize].iter().enumerate() { if i > 0 { out.push(','); } write_sval_json(ar, customs, *v, out); }
    }
    out.push(']');
}
fn write_child_ref<'a, C: ShapeCustoms<'a>>(ar: &AstArena<'a>, customs: &C, cr: ChildRef, out: &mut String) {
    if cr.idx == u32::MAX { out.push_str("null"); } else { write_sval_json(ar, customs, SVal::TNode(cr.tag as u16, cr.idx), out); }
}
/// M27-B2: 8B tagged union for expression/string tnode fields. TNode payload is
/// {tag u8, idx u32} = 5B; Rust packs the discriminant into the padding → 8B.
#[derive(Clone, Copy)]
pub enum LeanSVal {
    Null,
    Bool(bool),
    Num(u32),   // index into TnodesArena.numbers (Vec<f64>)
    Span(u32),  // index into TnodesArena.spans (Vec<(u32,u32)>) = (off,len) into src
    Own(u32),   // index into AstArena.strings
    TNode(u8, u32),
}
fn to_lean(v: SVal, t: &mut TnodesArena) -> LeanSVal {
    match v {
        SVal::Null => LeanSVal::Null,
        SVal::Bool(b) => LeanSVal::Bool(b),
        SVal::Number(n) => { let i = t.numbers.len() as u32; t.numbers.push(n); LeanSVal::Num(i) }
        SVal::Str(o, l) => { let i = t.spans.len() as u32; t.spans.push((o, l)); LeanSVal::Span(i) }
        SVal::OwnStr(i) => LeanSVal::Own(i),
        SVal::TNode(tag, idx) => LeanSVal::TNode(tag as u8, idx),
        _ => panic!("to_lean: unexpected SVal"),
    }
}
fn from_lean<'a>(ls: LeanSVal, t: &TnodesArena) -> SVal<'a> {
    match ls {
        LeanSVal::Null => SVal::Null,
        LeanSVal::Bool(b) => SVal::Bool(b),
        LeanSVal::Num(i) => SVal::Number(t.numbers[i as usize]),
        LeanSVal::Span(i) => { let (o, l) = t.spans[i as usize]; SVal::Str(o, l) }
        LeanSVal::Own(i) => SVal::OwnStr(i),
        LeanSVal::TNode(tag, idx) => SVal::TNode(tag as u16, idx),
    }
}
fn write_lean_json<'a>(ar: &AstArena<'a>, customs: &TsEstreeCustoms<'a>, ls: LeanSVal, out: &mut String) {
    match ls {
        LeanSVal::Null => out.push_str("null"),
        LeanSVal::Bool(b) => out.push_str(if b { "true" } else { "false" }),
        LeanSVal::Num(i) => write_sval_json(ar, customs, SVal::Number(customs.0.borrow().numbers[i as usize]), out),
        LeanSVal::Span(i) => { let (o, l) = customs.0.borrow().spans[i as usize]; write_sval_json(ar, customs, SVal::Str(o, l), out) }
        LeanSVal::Own(i) => write_sval_json(ar, customs, SVal::OwnStr(i), out),
        LeanSVal::TNode(tag, idx) => customs.write_tnode_json(ar, tag as u16, idx, out),
    }
}

// ── M15: customs literal strings — prefilled into the OwnStr slab once per
// parse by prime(); indices follow the emitter's SHAPE_STATIC_STRS arm names.
// "" is NOT here: the empty string is SVal::Str(0, 0) (zero-cost span).
const S_INIT: u32 = SHAPE_STATIC_STRS + 0;
const S_UNDEFINED: u32 = SHAPE_STATIC_STRS + 1;
const S_METHOD: u32 = SHAPE_STATIC_STRS + 2;
const S_CLASSIC: u32 = SHAPE_STATIC_STRS + 3;
const S_USING: u32 = SHAPE_STATIC_STRS + 4;
const S_THIS: u32 = SHAPE_STATIC_STRS + 5;
const S_OF: u32 = SHAPE_STATIC_STRS + 6;
const S_IN: u32 = SHAPE_STATIC_STRS + 7;
const S_CTOR: u32 = SHAPE_STATIC_STRS + 8;
const S_GET: u32 = SHAPE_STATIC_STRS + 9;
const S_SET: u32 = SHAPE_STATIC_STRS + 10;
const S_INSTANCEOF: u32 = SHAPE_STATIC_STRS + 11;

/// M15: build a Str-span SVal from a slice that points into `src` (op/kind
/// text threaded through handlers always originates from src tokens).
fn sval_str<'a>(src: &str, s: &str) -> SVal<'a> {
    let off = s.as_ptr() as usize - src.as_ptr() as usize;
    debug_assert!(off + s.len() <= src.len());
    SVal::Str(off as u32, s.len() as u32)
}

fn ts_obj<'a, const N: usize>(ar: &mut AstArena<'a>, typ: &'static str, fields: [(&'static str, SVal<'a>); N]) -> SVal<'a> {
    let fbase = ar.fields.len();
    ar.fields.extend(fields);
    ar.mk_obj_raw(typ, fbase)
}
/// Identifier from derived/literal text (owned copy ≡ old ts_ident's to_owned()) — M2 typed.
fn ts_ident<'a>(customs: &TsEstreeCustoms<'a>, ar: &mut AstArena<'a>, name: &str) -> SVal<'a> {
    let s = ar.mk_own_str(name);

    let mut t = customs.0.borrow_mut();
    let nm = to_lean(s, &mut *t);
    t.idents.push(TIdentifier { name: nm, type_annotation: CR_NULL });
    SVal::TNode(TN_IDENT, (t.idents.len() - 1) as u32)
}
/// Identifier reusing an existing string SVal (zero-copy ≡ ts_ident on the same text) — M2 typed.
fn ident_of<'a>(customs: &TsEstreeCustoms<'a>, name: SVal<'a>) -> SVal<'a> {

    let mut t = customs.0.borrow_mut();
    let nm = to_lean(name, &mut *t);
    t.idents.push(TIdentifier { name: nm, type_annotation: CR_NULL });
    SVal::TNode(TN_IDENT, (t.idents.len() - 1) as u32)
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
/// ≡ old take_kid: Null when the slot is absent.
fn take_kid<'a>(k: &[SVal<'a>], i: usize) -> SVal<'a> { k.get(i).copied().unwrap_or(SVal::Null) }
fn take_last<'a>(k: &[SVal<'a>]) -> SVal<'a> { k.last().copied().unwrap_or(SVal::Null) }
/// One-level flatten written straight into the lists slab — zero temp Vec.
/// Same result as `mk_list(&flat_take(ar, kids))` (extend_from_within handles self-overlap).
/// M24: when exactly one non-Null kid is itself a List, the flatten IS that list —
/// return the original SVal (same range, same elements, same order). Slab consumers
/// are read-only (list_of / write_tnode_json / first_flat / extend_from_within), the
/// fast path appends nothing so txn-rollback truncation is unaffected, and fold-append
/// targets are handler-created lists, never kids. All-Null / multi-NonNull / single
/// non-List kids keep the original copy behavior.
fn flat_list<'a>(ar: &mut AstArena<'a>, kids: &[SVal<'a>]) -> SVal<'a> {
    let mut only: Option<SVal<'a>> = None;
    for &k in kids {
        if !matches!(k, SVal::Null) {
            if only.is_some() { only = None; break; }
            only = Some(k);
        }
    }
    if let Some(v @ SVal::List(..)) = only { return v; }
    if let Some(v @ SVal::NodeList(..)) = only { return v; }
    // Fast path: every kid is a TNode (no nested List, no Null) → pack 4B/elem.
    if kids.iter().all(|k| matches!(k, SVal::TNode(..))) {
        let st = ar.node_lists.len() as u32;
        for &k in kids { if let SVal::TNode(t, i) = k { ar.node_lists.push((t as u32) << 24 | i); } }
        return SVal::NodeList(st, kids.len() as u32);
    }
    let start = ar.lists.len();
    for &k in kids {
        match k {
            SVal::Null => {}
            SVal::List(s, l) => ar.lists.extend_from_within(s as usize..(s + l) as usize),
            other => ar.lists.push(other),
        }
    }
    SVal::List(start as u32, (ar.lists.len() - start) as u32)
}
/// Like TS `flatKids(x ?? [])[0] ?? null`, but also unwrap one extra single-array pack
/// that rust star/opt sometimes leaves as `[[Heritage]]`. Slice-based — no temp Vec.
fn first_flat<'a>(ar: &AstArena<'a>, v: Option<SVal<'a>>) -> SVal<'a> {
    let (mut xs, single): (&[SVal<'a>], Option<SVal<'a>>) = match v {
        Some(SVal::Null) | None => (&[], None),
        Some(v @ SVal::List(_, _)) => (ar.list_of(v), None),
        Some(v @ SVal::NodeList(s, l)) => {
            if l == 0 { return SVal::Null; }
            let e = ar.node_lists[s as usize];
            return SVal::TNode((e >> 24) as u16, e & 0xFFFFFF);
        }
        Some(other) => (&[], Some(other)),
    };
    if let Some(other) = single { return other; }
    while xs.len() == 1 {
        match xs[0] {
            SVal::List(_, _) => xs = ar.list_of(xs[0]),
            other => return other,
        }
    }
    xs.first().copied().unwrap_or(SVal::Null)
}
/// Approximate JS `String(x)` used by TS keep shapes (Array joins with ',', Object → `[object Object]`).
fn js_string<'a>(ar: &AstArena<'a>, v: SVal<'a>) -> String {
    match v {
        SVal::Str(o, l) => ar.src[o as usize..(o + l) as usize].to_owned(),
        SVal::OwnStr(_) => ar.str_of(v).to_owned(),
        SVal::Number(n) => {
            if n.is_nan() { "NaN".into() }
            else if n.is_infinite() { if n.is_sign_negative() { "-Infinity" } else { "Infinity" }.into() }
            else if n == 0.0 { "0".into() }
            else { n.to_string() }
        }
        SVal::Bool(b) => b.to_string(),
        SVal::Null => "".into(), // JS Array#toString / String(null??'') join slot is empty
        SVal::List(_, _) => ar.list_of(v).iter().map(|&x| js_string(ar, x)).collect::<Vec<_>>().join(","),
        SVal::NodeList(s, l) => (0..l).map(|_| "[object Object]").collect::<Vec<_>>().join(","),
        SVal::Node(_) | SVal::Partial(_) | SVal::TNode(..) => "[object Object]".into(),
        SVal::_Marker(_) => "".into(),
    }
}
fn flat_deep_take<'a>(ar: &AstArena<'a>, kids: &[SVal<'a>]) -> Vec<SVal<'a>> {
    // Fully flatten nested list packs from sep/star/opt (heritage lists, etc.).
    fn walk<'a>(ar: &AstArena<'a>, v: SVal<'a>, out: &mut Vec<SVal<'a>>) {
        match v {
            SVal::Null => {}
            SVal::List(_, _) => for &x in ar.list_of(v) { walk(ar, x, out); },
            SVal::NodeList(s, l) => for j in 0..l {
                let e = ar.node_lists[(s + j) as usize];
                walk(ar, SVal::TNode((e >> 24) as u16, e & 0xFFFFFF), out);
            },
            other => out.push(other),
        }
    }
    let mut out = Vec::new();
    for &k in kids { walk(ar, k, &mut out); }
    out
}
fn seq_expr<'a>(customs: &TsEstreeCustoms<'a>, ar: &mut AstArena<'a>, head: Option<SVal<'a>>, tail: Option<SVal<'a>>) -> Option<SVal<'a>> {
    /// Elements one slot contributes after one-level flatten (Null → 0, List → len, other → 1).
    fn plen<'a>(v: Option<SVal<'a>>) -> usize {
        match v {
            None | Some(SVal::Null) => 0,
            Some(SVal::List(_, l)) | Some(SVal::NodeList(_, l)) => l as usize,
            Some(_) => 1,
        }
    }
    match plen(head) + plen(tail) {
        0 => None,
        1 => {
            // The single surviving element (a 1-element List is spliced, ≡ old flat).
            for v in [head, tail] {
                match v {
                    Some(SVal::List(s, l)) if l > 0 => return Some(ar.lists[s as usize]),
                    Some(SVal::NodeList(s, l)) if l > 0 => return Some(SVal::TNode((ar.node_lists[s as usize] >> 24) as u16, ar.node_lists[s as usize] & 0xFFFFFF)),
                    Some(SVal::List(_, _)) | Some(SVal::NodeList(_, _)) | Some(SVal::Null) | None => {}
                    Some(other) => return Some(other),
                }
            }
            unreachable!("seq_expr: counted 1 part but found none")
        }
        _ => {
            // flat_list over the two slots (Null dropped, Lists spliced), then SequenceExpression.
            let start = ar.lists.len();
            for v in [head, tail] {
                match v {
                    Some(SVal::List(s, l)) => ar.lists.extend_from_within(s as usize..(s + l) as usize),
                    Some(SVal::Null) | None => {}
                    Some(other) => ar.lists.push(other),
                }
            }
            let xs = SVal::List(start as u32, (ar.lists.len() - start) as u32);

            let mut t = customs.0.borrow_mut();
            t.seq_exprs.push(TSeqExpr { expressions: list_range(xs) });
            Some(SVal::TNode(TN_SEQ, (t.seq_exprs.len() - 1) as u32))
        }
    }
}
fn member_expr<'a>(customs: &TsEstreeCustoms<'a>, ar: &mut AstArena<'a>, obj: SVal<'a>, prop: SVal<'a>, computed: bool) -> SVal<'a> {
    let p = match prop {
        SVal::Str(..) | SVal::OwnStr(_) => ident_of(customs, prop),
        other => other,
    };

    let mut t = customs.0.borrow_mut();
    let l_obj = to_lean(obj, &mut *t);
    let l_p = to_lean(p, &mut *t);
    t.member_exprs.push(TMemberExpr { object: l_obj, property: l_p, computed, optional: false, dup_optional: false });
    SVal::TNode(TN_MEMBER, (t.member_exprs.len() - 1) as u32)
}
fn unary_expr<'a>(customs: &TsEstreeCustoms<'a>, ar: &mut AstArena<'a>, op: SVal<'a>, arg: SVal<'a>) -> SVal<'a> {

    let mut t = customs.0.borrow_mut();
    let l_arg = to_lean(arg, &mut *t);
    t.unary_exprs.push(TUnaryExpr { operator: op, argument: l_arg, prefix: true });
    SVal::TNode(TN_UNARY, (t.unary_exprs.len() - 1) as u32)
}
fn binary_expr<'a>(customs: &TsEstreeCustoms<'a>, ar: &mut AstArena<'a>, left: SVal<'a>, op: SVal<'a>, right: SVal<'a>) -> SVal<'a> {

    let mut t = customs.0.borrow_mut();
    let l_l = to_lean(left, &mut *t);
    let l_r = to_lean(right, &mut *t);
    t.bin_exprs.push(TBinExpr { left: l_l, operator: op, right: l_r });
    SVal::TNode(TN_BINEXPR, (t.bin_exprs.len() - 1) as u32)
}
fn update_expr<'a>(customs: &TsEstreeCustoms<'a>, ar: &mut AstArena<'a>, op: SVal<'a>, arg: SVal<'a>, prefix: bool) -> SVal<'a> {

    let mut t = customs.0.borrow_mut();
    t.update_exprs.push(TUpdateExpr { operator: op, argument: arg, prefix });
    SVal::TNode(TN_UPDATE, (t.update_exprs.len() - 1) as u32)
}
/// BlockStatement check across DynObj typ and typed-node tag (M2 batch 3, M14b +spanned).
fn is_block_stmt<'a>(ar: &AstArena<'a>, v: SVal<'a>) -> bool {
    match v {
        SVal::Node(_) => ar.typ_of(v) == "BlockStatement",
        SVal::TNode(tag, _) => tag == TN_BLOCKSTMT || tag == TN_BLOCKSTMT_SP,
        _ => false,
    }
}
fn arrow_fn<'a>(customs: &TsEstreeCustoms<'a>, ar: &mut AstArena<'a>, params: SVal<'a>, body: SVal<'a>, async_: bool) -> SVal<'a> {
    let expression = !is_block_stmt(ar, body);

    let mut t = customs.0.borrow_mut();
    let l_params = list_range(params);
    let l_body = to_lean(body, &mut *t);
    t.arrow_fns.push(TArrowFn { params: l_params, body: l_body, async_, expression });
    SVal::TNode(TN_ARROWFN, (t.arrow_fns.len() - 1) as u32)
}
fn head_is_new<'a>(customs: &TsEstreeCustoms<'a>, ar: &AstArena<'a>, v: SVal<'a>) -> bool {
    match v {
        SVal::Str(o, l) => &ar.src[o as usize..(o + l) as usize] == "new",
        SVal::OwnStr(_) => ar.str_of(v) == "new",
        SVal::Node(_) if ar.typ_of(v) == "Identifier" => {
            ar.fields_of(v).iter().any(|(k, fv)| {
                *k == "name" && matches!(fv, SVal::Str(..) | SVal::OwnStr(_)) && ar.str_of(*fv) == "new"
            })
        }
        SVal::TNode(tag, idx) if tag == TN_IDENT => {
            let n = customs.0.borrow().idents[idx as usize];
            let name = from_lean(n.name, &customs.0.borrow());
            matches!(name, SVal::Str(..) | SVal::OwnStr(_)) && ar.str_of(name) == "new"
        }
        _ => false,
    }
}
fn tpl_raw<'s>(kind: &str, text: &'s str) -> &'s str {
    let open = "`"; let i_open = "${"; let i_close = "}";
    if kind == "nosubst" {
        return if text.starts_with(open) && text.ends_with(open) {
            &text[open.len()..text.len() - open.len()]
        } else { text };
    }
    let mut s = text;
    if kind == "head" {
        if s.starts_with(open) { s = &s[open.len()..]; }
        if s.ends_with(i_open) { s = &s[..s.len() - i_open.len()]; }
        return s;
    }
    if kind == "middle" {
        if s.starts_with(i_close) { s = &s[i_close.len()..]; }
        if s.ends_with(i_open) { s = &s[..s.len() - i_open.len()]; }
        return s;
    }
    if s.starts_with(i_close) { s = &s[i_close.len()..]; }
    if s.ends_with(open) { s = &s[..s.len() - open.len()]; }
    s
}
fn estree_optional_chain<'a>(customs: &TsEstreeCustoms<'a>, ar: &mut AstArena<'a>, left: SVal<'a>, kids: &[SVal<'a>]) -> SVal<'a> {
    let k0 = kids.first().copied();
    match k0 {
        Some(v @ SVal::List(s0, l0)) => {
            if l0 > 0 && matches!(ar.lists[s0 as usize], SVal::List(_, _)) {
                let (si, li) = match ar.lists[s0 as usize] { SVal::List(s, l) => (s, l), _ => unreachable!() };
                let (sa, la) = match ar.lists.get(s0 as usize + 1).copied() { Some(SVal::List(s, l)) => (s, l), _ => (0u32, 0u32) };
                // extend_from_within copies the source range to the slab tail — no temp Vec.
                let args_l = { let st = ar.lists.len() as u32; ar.lists.extend_from_within(sa as usize..(sa + la) as usize); SVal::List(st, la) };
                let inner_l = { let st = ar.lists.len() as u32; ar.lists.extend_from_within(si as usize..(si + li) as usize); SVal::List(st, li) };

                let mut t = customs.0.borrow_mut();
                let l_callee = to_lean(left, &mut *t);
                t.call_exprs.push(TCallExpr { callee: l_callee, arguments: list_range(args_l), optional: Some(true), type_arguments: Some(list_range(inner_l)) });
                SVal::TNode(TN_CALL, (t.call_exprs.len() - 1) as u32)
            } else {
                let st = ar.lists.len() as u32;
                ar.lists.extend_from_within(s0 as usize..(s0 + l0) as usize);
                let args = SVal::List(st, l0);

                let mut t = customs.0.borrow_mut();
                let l_callee = to_lean(left, &mut *t);
                t.call_exprs.push(TCallExpr { callee: l_callee, arguments: list_range(args), optional: Some(true), type_arguments: None });
                SVal::TNode(TN_CALL, (t.call_exprs.len() - 1) as u32)
            }
        }
        // Packed all-TNode args (no nested List possible) — same as the List else-branch.
        Some(v @ SVal::NodeList(s0, l0)) => {
            let args = { let st = ar.node_lists.len() as u32; ar.node_lists.extend_from_within(s0 as usize..(s0 + l0) as usize); SVal::NodeList(st, l0) };
            let mut t = customs.0.borrow_mut();
            let l_callee = to_lean(left, &mut *t);
            t.call_exprs.push(TCallExpr { callee: l_callee, arguments: list_range(args), optional: Some(true), type_arguments: None });
            SVal::TNode(TN_CALL, (t.call_exprs.len() - 1) as u32)
        }
        Some(v) if matches!(v, SVal::Str(..) | SVal::OwnStr(_)) && ar.str_of(v).starts_with('`') => {

            let mut t = customs.0.borrow_mut();
            let l_tag = to_lean(left, &mut *t);
            t.tagged_templates.push(TTaggedTemplate { tag: l_tag, quasi: child_ref(v) });
            SVal::TNode(TN_TAGGEDTPL, (t.tagged_templates.len() - 1) as u32)
        }
        Some(v) if ar.typ_of(v) == "TemplateLiteral" || matches!(v, SVal::TNode(tag, _) if tag == TN_TEMPLATELIT) => {

            let mut t = customs.0.borrow_mut();
            let l_tag = to_lean(left, &mut *t);
            t.tagged_templates.push(TTaggedTemplate { tag: l_tag, quasi: child_ref(v) });
            SVal::TNode(TN_TAGGEDTPL, (t.tagged_templates.len() - 1) as u32)
        }
        Some(v) if matches!(v, SVal::Str(..) | SVal::OwnStr(_)) => {
            // member_expr + push optional (the old code appended a second "optional"
            // field — the duplicate key is part of the byte-exact output contract).
            let p = ident_of(customs, v);

            let mut t = customs.0.borrow_mut();
            let l_obj = to_lean(left, &mut *t);
            let l_p = to_lean(p, &mut *t);
            t.member_exprs.push(TMemberExpr { object: l_obj, property: l_p, computed: false, optional: false, dup_optional: true });
            SVal::TNode(TN_MEMBER, (t.member_exprs.len() - 1) as u32)
        }
        other => {
            let raw = other.unwrap_or(SVal::OwnStr(S_UNDEFINED));
            let prop = match raw {
                SVal::Str(..) | SVal::OwnStr(_) => ident_of(customs, raw),
                v => v,
            };

            let mut t = customs.0.borrow_mut();
            let l_obj = to_lean(left, &mut *t);
            let l_p = to_lean(prop, &mut *t);
            t.member_exprs.push(TMemberExpr { object: l_obj, property: l_p, computed: true, optional: false, dup_optional: true });
            SVal::TNode(TN_MEMBER, (t.member_exprs.len() - 1) as u32)
        }
    }
}
const ASSIGN_OPS: &[&str] = &["=", "+=", "-=", "*=", "/=", "%=", "**=", "<<=", ">>=", ">>>=", "&=", "|=", "^=", "??=", "||=", "&&="];
const LOGICAL_OPS: &[&str] = &["??", "||", "&&"];
const UPDATE_OPS: &[&str] = &["++", "--"];
const BINARY_OPS: &[&str] = &["=", "+=", "-=", "*=", "/=", "%=", "**=", "<<=", ">>=", ">>>=", "&=", "|=", "^=", "??=", "||=", "&&=", "??", "||", "&&", "|", "^", "&", "==", "!=", "===", "!==", "<", ">", "<=", ">=", "<<", ">>", ">>>", "+", "-", "*", "/", "%", "**"];
const PREFIX_OPS: &[&str] = &["!", "~", "+", "-", "typeof", "void", "delete", "await", "yield", "++", "--"];

fn estree_stmt<'a>(customs: &TsEstreeCustoms<'a>, ar: &mut AstArena<'a>, src: &'a str, kids: &[SVal<'a>], alt_path: &[usize], off: usize, end: usize, left: Option<SVal<'a>>, op_text: Option<&'a str>, state: Option<Vec<(&'static str, AstFoldCounts)>>) -> SVal<'a> {
    let arm = alt_path.first().copied();
    let src = src;
    let off = off;
    let k = kids;
    match arm {
        Some(0) => {
            if let Some(&body) = k.get(0) {
                if is_block_stmt(ar, body) { return body; }
                let l = flat_list(ar, &[body]);

                let mut t = customs.0.borrow_mut();
                t.block_stmts.push(TBlockStmt { body: l });
                return SVal::TNode(TN_BLOCKSTMT, (t.block_stmts.len() - 1) as u32);
            }
            let l = flat_list(ar, k);

            let mut t = customs.0.borrow_mut();
            t.block_stmts.push(TBlockStmt { body: l });
            SVal::TNode(TN_BLOCKSTMT, (t.block_stmts.len() - 1) as u32)
        }
        Some(1) => {
            // The declaration keyword sits at the statement offset — span it (M15).
            let kind = if prefix(src, off, 5).starts_with("const") { SVal::Str(off as u32, 5) }
                else if prefix(src, off, 3).starts_with("let") { SVal::Str(off as u32, 3) } else { SVal::Str(off as u32, 3) };
            let l = flat_list(ar, k);

            let mut t = customs.0.borrow_mut();
            let l_kind = to_lean(kind, &mut *t);
            t.var_decls.push(TVarDecl { kind: l_kind, declarations: list_range(l) });
            SVal::TNode(TN_VARDECL, (t.var_decls.len() - 1) as u32)
        }
        Some(2) => {
            let test = seq_expr(customs, ar, k.get(0).copied(), k.get(1).copied()).unwrap_or(SVal::Null);

            let mut t = customs.0.borrow_mut();
            let l_test = to_lean(test, &mut *t);
            t.if_stmts.push(TIfStmt { test: l_test, consequent: child_ref(take_kid(k, 2)), alternate: child_ref(take_kid(k, 3)) });
            SVal::TNode(TN_IF, (t.if_stmts.len() - 1) as u32)
        }
        Some(3) => {
            let body = take_kid(k, 1);
            let head = k.get(0).copied().unwrap_or(SVal::Null);
            // ForHead field pack — DynObj (obj_field ≡ Null when absent) or typed (TN_FORHEAD).
            let (fkind, finit, ftest, fupdate, fleft, fright, fawait) = match head {
                SVal::Node(_) => (
                    ar.obj_field(head, "kind"),
                    ar.obj_field(head, "init"), ar.obj_field(head, "test"), ar.obj_field(head, "update"),
                    ar.obj_field(head, "left"), ar.obj_field(head, "right"),
                    ar.fields_of(head).iter().any(|(n, v)| *n == "await" && matches!(v, SVal::Bool(true))),
                ),
                SVal::TNode(tag, idx) if tag == TN_FORHEAD => {
                    let n = customs.0.borrow().for_heads[idx as usize];
                    (from_lean(n.kind, &customs.0.borrow()),
                     n.init.unwrap_or(SVal::Null), n.test.unwrap_or(SVal::Null), n.update.unwrap_or(SVal::Null),
                     n.left.unwrap_or(SVal::Null), n.right.unwrap_or(SVal::Null),
                     n.await_ == Some(true))
                }
                _ => (SVal::Null, SVal::Null, SVal::Null, SVal::Null, SVal::Null, SVal::Null, false),
            };
            let kind_is_str = matches!(fkind, SVal::Str(..) | SVal::OwnStr(_));
            if kind_is_str && ar.str_of(fkind) == "in" {

                let mut t = customs.0.borrow_mut();
                t.for_in_stmts.push(TForInStmt { left: fleft, right: fright, body });
                return SVal::TNode(TN_FORIN, (t.for_in_stmts.len() - 1) as u32);
            }
            if kind_is_str && ar.str_of(fkind) == "of" {

                let mut t = customs.0.borrow_mut();
                t.for_of_stmts.push(TForOfStmt { left: fleft, right: fright, body, await_: fawait });
                return SVal::TNode(TN_FOROF, (t.for_of_stmts.len() - 1) as u32);
            }

            let mut t = customs.0.borrow_mut();
            let l_test = to_lean(ftest, &mut *t);
            let l_update = to_lean(fupdate, &mut *t);
            t.for_stmts.push(TForStmt { init: finit, test: l_test, update: l_update, body: child_ref(body) });
            SVal::TNode(TN_FOR, (t.for_stmts.len() - 1) as u32)
        }
        Some(4) => {
            let test = seq_expr(customs, ar, k.get(1).copied(), k.get(2).copied()).unwrap_or(SVal::Null);

            let mut t = customs.0.borrow_mut();
            let l_test = to_lean(test, &mut *t);
            t.while_stmts.push(TWhileStmt { test: l_test, body: child_ref(take_kid(k, 3)) });
            SVal::TNode(TN_WHILE, (t.while_stmts.len() - 1) as u32)
        }
        Some(5) => {
            let test = seq_expr(customs, ar, k.get(2).copied(), k.get(3).copied()).unwrap_or(SVal::Null);

            let mut t = customs.0.borrow_mut();
            let l_test = to_lean(test, &mut *t);
            t.do_while_stmts.push(TDoWhileStmt { body: child_ref(take_kid(k, 0)), test: l_test });
            SVal::TNode(TN_DOWHILE, (t.do_while_stmts.len() - 1) as u32)
        }
        Some(6) => {
            let cl = match k.get(2).copied() {
                Some(c) => flat_list(ar, &[c]),
                None => match k.get(1).copied() {
                    Some(c) => flat_list(ar, &[c]),
                    None => ar.mk_list(&[]),
                },
            };

            let mut t = customs.0.borrow_mut();
            let l_disc = to_lean(take_kid(k, 0), &mut *t);
            t.switch_stmts.push(TSwitchStmt { discriminant: l_disc, cases: list_range(cl) });
            SVal::TNode(TN_SWITCH, (t.switch_stmts.len() - 1) as u32)
        }
        Some(7) => {
            let arg = seq_expr(customs, ar, k.get(0).copied(), k.get(1).copied()).unwrap_or(SVal::Null);

            let mut t = customs.0.borrow_mut();
            let l_arg = to_lean(arg, &mut *t);
            t.return_stmts.push(TReturnStmt { argument: l_arg });
            SVal::TNode(TN_RETURN, (t.return_stmts.len() - 1) as u32)
        }
        Some(8) => {
            let arg = seq_expr(customs, ar, k.get(0).copied(), k.get(1).copied()).unwrap_or(SVal::Null);

            let mut t = customs.0.borrow_mut();
            let l_arg = to_lean(arg, &mut *t);
            t.throw_stmts.push(TThrowStmt { argument: l_arg });
            SVal::TNode(TN_THROW, (t.throw_stmts.len() - 1) as u32)
        }
        Some(9) => {

            let mut t = customs.0.borrow_mut();
            t.break_stmts.push(TBreakStmt { label: take_kid(k, 0) });
            SVal::TNode(TN_BREAK, (t.break_stmts.len() - 1) as u32)
        }
        Some(10) => {

            let mut t = customs.0.borrow_mut();
            t.continue_stmts.push(TContinueStmt { label: take_kid(k, 0) });
            SVal::TNode(TN_CONTINUE, (t.continue_stmts.len() - 1) as u32)
        }
        Some(11) => {

            let mut t = customs.0.borrow_mut();
            t.try_stmts.push(TTryStmt { block: child_ref(take_kid(k, 0)), handler: take_kid(k, 1), finalizer: child_ref(take_kid(k, 2)) });
            SVal::TNode(TN_TRY, (t.try_stmts.len() - 1) as u32)
        }
        Some(12) => {
            let name = match k.get(0).copied() {
                Some(v) if matches!(v, SVal::Str(..) | SVal::OwnStr(_)) => v,
                _ => SVal::Str(0, 0),
            };
            let label = ident_of(customs, name);

            let mut t = customs.0.borrow_mut();
            t.labeled_stmts.push(TLabeledStmt { label: child_ref(label), body: child_ref(take_kid(k, 1)) });
            SVal::TNode(TN_LABELED, (t.labeled_stmts.len() - 1) as u32)
        }
        Some(13) => {

            let mut t = customs.0.borrow_mut();
            t.units.push(TUnit);
            SVal::TNode(TN_EMPTY, (t.units.len() - 1) as u32)
        }
        Some(14) => {

            let mut t = customs.0.borrow_mut();
            t.units.push(TUnit);
            SVal::TNode(TN_DEBUGGER, (t.units.len() - 1) as u32)
        }
        Some(15) => {

            let mut t = customs.0.borrow_mut();
            let l_obj = to_lean(take_kid(k, 1), &mut *t);
            t.with_stmts.push(TWithStmt { object: l_obj, body: child_ref(take_kid(k, 2)) });
            SVal::TNode(TN_WITH, (t.with_stmts.len() - 1) as u32)
        }
        Some(16) => {
            let l = flat_list(ar, &[take_last(k)]);

            let mut t = customs.0.borrow_mut();
            let l_kind = to_lean(SVal::OwnStr(S_USING), &mut *t);
            t.var_decls.push(TVarDecl { kind: l_kind, declarations: list_range(l) });
            SVal::TNode(TN_VARDECL, (t.var_decls.len() - 1) as u32)
        }
        Some(17) => k.get(0).copied().unwrap_or(SVal::Null),
        Some(18) => {
            // First kid that isn't an empty-Array ASI artifact (≡ strip_asi(...)[0]).
            let expr = k.iter().copied().find(|x| !(matches!(x, SVal::List(_, _)) && ar.list_of(*x).is_empty())).unwrap_or(SVal::Null);

            let mut t = customs.0.borrow_mut();
            t.expr_stmts.push(TExprStmt { expression: expr });
            SVal::TNode(TN_EXPRSTMT, (t.expr_stmts.len() - 1) as u32)
        }
        _ => unhandled("estreeStmt", alt_path, op_text, None),
    }
}

fn estree_variable_declarator<'a>(customs: &TsEstreeCustoms<'a>, _ar: &mut AstArena<'a>, src: &'a str, kids: &[SVal<'a>], alt_path: &[usize], off: usize, end: usize, left: Option<SVal<'a>>, op_text: Option<&'a str>, state: Option<Vec<(&'static str, AstFoldCounts)>>) -> SVal<'a> {
    let k = kids;

    let mut t = customs.0.borrow_mut();
    let l_init = to_lean(k.get(2).copied().unwrap_or(SVal::Null), &mut *t);
    t.var_declarators.push(TVarDeclarator {
        id: k.first().copied().unwrap_or(SVal::Null),
        type_annotation: child_ref(k.get(1).copied().unwrap_or(SVal::Null)),
        init: l_init,
        off: off as u32,
        end: end as u32,
    });
    SVal::TNode(TN_VARDECLARATOR, (t.var_declarators.len() - 1) as u32)
}

fn estree_decl<'a>(customs: &TsEstreeCustoms<'a>, ar: &mut AstArena<'a>, src: &'a str, kids: &[SVal<'a>], alt_path: &[usize], off: usize, end: usize, left: Option<SVal<'a>>, op_text: Option<&'a str>, state: Option<Vec<(&'static str, AstFoldCounts)>>) -> SVal<'a> {
    let arm = alt_path.first().copied();
    let k = kids;
    match arm {
        Some(17) => {

            let mut t = customs.0.borrow_mut();
            t.export_nameds.push(TExportNamed { declaration: Some(take_kid(k, 0)), specifiers: None });
            SVal::TNode(TN_EXPORTNAMED, (t.export_nameds.len() - 1) as u32)
        }
        Some(18) => {
            let l = flat_list(ar, k);

            let mut t = customs.0.borrow_mut();
            t.export_nameds.push(TExportNamed { declaration: None, specifiers: Some(l) });
            SVal::TNode(TN_EXPORTNAMED, (t.export_nameds.len() - 1) as u32)
        }
        Some(19) => {

            let mut t = customs.0.borrow_mut();
            t.export_alls.push(TExportAll { source: take_kid(k, 0) });
            SVal::TNode(TN_EXPORTALL, (t.export_alls.len() - 1) as u32)
        }
        Some(20) => {

            let mut t = customs.0.borrow_mut();
            t.export_defaults.push(TExportDefault { declaration: take_kid(k, 0) });
            SVal::TNode(TN_EXPORTDEFAULT, (t.export_defaults.len() - 1) as u32)
        }
        Some(21) => {
            let sl = match k.get(1).copied() {
                Some(v) => flat_list(ar, &[v]),
                None => flat_list(ar, k),
            };
            let source = k.get(2).copied().or_else(|| k.get(1).copied()).unwrap_or(SVal::Null);

            let mut t = customs.0.borrow_mut();
            t.import_decls.push(TImportDecl { specifiers: list_range(sl), source });
            SVal::TNode(TN_IMPORT, (t.import_decls.len() - 1) as u32)
        }
        Some(22) => {

            let mut t = customs.0.borrow_mut();
            t.ts_import_equals.push(TTSImportEquals { id: child_ref(take_kid(k, 0)), module_reference: take_kid(k, 1) });
            SVal::TNode(TN_TSIMPORTEQUALS, (t.ts_import_equals.len() - 1) as u32)
        }
        Some(23) => {

            let mut t = customs.0.borrow_mut();
            t.ts_module_decls.push(TTSModuleDecl { id: take_kid(k, 0), body: child_ref(take_kid(k, 1)), declare: None });
            SVal::TNode(TN_TSMODULE, (t.ts_module_decls.len() - 1) as u32)
        }
        Some(24) => {

            let mut t = customs.0.borrow_mut();
            t.ts_module_decls.push(TTSModuleDecl { id: take_kid(k, 0), body: child_ref(take_kid(k, 1)), declare: Some(true) });
            SVal::TNode(TN_TSMODULE, (t.ts_module_decls.len() - 1) as u32)
        }
        Some(25) => {

            let mut t = customs.0.borrow_mut();
            t.ts_namespace_exports.push(TTSNamespaceExport { id: take_kid(k, 0) });
            SVal::TNode(TN_TSNAMESPACE, (t.ts_namespace_exports.len() - 1) as u32)
        }
        Some(26) => {
            let l = flat_list(ar, &[take_kid(k, 1)]);

            let mut t = customs.0.borrow_mut();
            t.ts_enum_decls.push(TTSEnumDecl { id: take_kid(k, 0), members: list_range(l) });
            SVal::TNode(TN_TSENUM, (t.ts_enum_decls.len() - 1) as u32)
        }
        Some(27) => {

            let mut t = customs.0.borrow_mut();
            t.ts_interface_decls.push(TTSInterfaceDecl { id: take_kid(k, 0), type_parameters: None, extends: None, body: child_ref(take_kid(k, 1)) });
            SVal::TNode(TN_TSINTERFACEDECL, (t.ts_interface_decls.len() - 1) as u32)
        }
        Some(4) => {
            let ext = flat_deep_take(ar, &[take_kid(k, 2)]);
            let el = ar.mk_list(&ext);
            let bl = flat_list(ar, &[take_kid(k, 3)]);
            let body = {

                let mut t = customs.0.borrow_mut();
                t.ts_interface_bodys.push(TTSInterfaceBody { body: bl });
                SVal::TNode(TN_TSINTERFACEBODY, (t.ts_interface_bodys.len() - 1) as u32)
            };

            let mut t = customs.0.borrow_mut();
            t.ts_interface_decls.push(TTSInterfaceDecl {
                id: take_kid(k, 0),
                type_parameters: Some(take_kid(k, 1)),
                extends: Some(el),
                body: child_ref(body),
            });
            SVal::TNode(TN_TSINTERFACEDECL, (t.ts_interface_decls.len() - 1) as u32)
        }
        Some(5) => {

            let mut t = customs.0.borrow_mut();
            t.ts_type_aliases.push(TTSTypeAlias {
                id: take_kid(k, 0),
                type_parameters: take_kid(k, 1),
                type_annotation: child_ref(take_kid(k, 2)),
            });
            SVal::TNode(TN_TSALIAS, (t.ts_type_aliases.len() - 1) as u32)
        }
        Some(6) => {
            let dl = flat_list(ar, &[take_kid(k, 0)]);
            let sup = first_flat(ar, k.get(3).copied());
            let bl = flat_list(ar, &[take_kid(k, 4)]);
            let body_idx = {

                let mut t = customs.0.borrow_mut();
                t.class_bodys.push(TClassBody { body: list_range(bl) });
                (t.class_bodys.len() - 1) as u32
            };

            let mut t = customs.0.borrow_mut();
            t.class_decls.push(TClassDecl {
                decorators: list_range(dl),
                id: take_kid(k, 1),
                super_class: sup,
                body: body_idx,
            });
            SVal::TNode(TN_CLASSDECL, (t.class_decls.len() - 1) as u32)
        }
        Some(0) | Some(1) | Some(2) | Some(3) => {
            let async_ = arm == Some(1) || arm == Some(3);
            let gen = arm == Some(2) || arm == Some(3);
            let pl = flat_list(ar, &[take_kid(k, 2)]);

            let mut t = customs.0.borrow_mut();
            t.func_decls.push(TFuncDecl {
                async_, generator: gen,
                id: take_kid(k, 0),
                type_parameters: take_kid(k, 1),
                params: list_range(pl),
                return_type: take_kid(k, 3),
                body: child_ref(take_kid(k, 4)),
            });
            SVal::TNode(TN_FUNCDECL, (t.func_decls.len() - 1) as u32)
        }
        Some(15) | Some(16) => {
            let inner_arm = if arm == Some(15) { 0usize } else { 6 };
            let inner = estree_decl(customs, ar, src, k, &[inner_arm], off, end, left, op_text, state);

            let mut t = customs.0.borrow_mut();
            t.export_nameds.push(TExportNamed { declaration: Some(inner), specifiers: None });
            SVal::TNode(TN_EXPORTNAMED, (t.export_nameds.len() - 1) as u32)
        }
        Some(14) => {
            // In the TS reference `{ type: 'TSDeclareFunction', ...FunctionDeclaration }`,
            // the spread's `type` wins.
            estree_decl(customs, ar, src, k, &[0], off, end, left, op_text, state)
        }
        Some(a) if (7..=13).contains(&a) => {
            let children = ar.mk_list(k);

            let mut t = customs.0.borrow_mut();
            t.declarations.push(TDeclaration { alt: a as f64, children });
            SVal::TNode(TN_DECLARATION, (t.declarations.len() - 1) as u32)
        }
        _ => unhandled("estreeDecl", alt_path, op_text, None),
    }
}

fn estree_paren_or_comma<'a>(customs: &TsEstreeCustoms<'a>, ar: &mut AstArena<'a>, src: &'a str, kids: &[SVal<'a>], alt_path: &[usize], off: usize, end: usize, left: Option<SVal<'a>>, op_text: Option<&'a str>, state: Option<Vec<(&'static str, AstFoldCounts)>>) -> SVal<'a> {
    let arm = alt_path.first().copied();
    if arm.is_none() || arm.unwrap() > 20 { unhandled("estreeParenOrComma", alt_path, op_text, None); }
    if arm == Some(7) {
        let meta = ts_ident(customs, ar, "new");
        let prop = ts_ident(customs, ar, "target");

        let mut t = customs.0.borrow_mut();
        let l_meta = to_lean(meta, &mut *t);
        let l_prop = to_lean(prop, &mut *t);
        t.meta_props.push(TMetaProperty { meta: l_meta, property: l_prop });
        return SVal::TNode(TN_METAPROP, (t.meta_props.len() - 1) as u32);
    }
    // Flatten into the slab directly — no temp Vec (≡ flat_take + optional unwrap).
    // All-TNode kids pack into node_lists; otherwise the generic lists slab.
    if kids.iter().all(|k| matches!(k, SVal::TNode(..))) {
        if kids.len() == 1 { return kids[0]; }
        let l = mk_fast(ar, kids);

        let mut t = customs.0.borrow_mut();
        t.seq_exprs.push(TSeqExpr { expressions: list_range(l) });
        return SVal::TNode(TN_SEQ, (t.seq_exprs.len() - 1) as u32);
    }
    let start = ar.lists.len();
    for &k in kids {
        match k {
            SVal::Null => {}
            SVal::List(s, l) => ar.lists.extend_from_within(s as usize..(s + l) as usize),
            SVal::NodeList(s, l) => {
                for j in 0..l {
                    let e = ar.node_lists[(s + j) as usize];
                    ar.lists.push(SVal::TNode((e >> 24) as u16, e & 0xFFFFFF));
                }
            }
            other => ar.lists.push(other),
        }
    }
    let n = ar.lists.len() - start;
    if n == 1 { ar.lists[start] }
    else {
        let l = SVal::List(start as u32, n as u32);

        let mut t = customs.0.borrow_mut();
        t.seq_exprs.push(TSeqExpr { expressions: list_range(l) });
        SVal::TNode(TN_SEQ, (t.seq_exprs.len() - 1) as u32)
    }
}

fn estree_expr_binary<'a>(customs: &TsEstreeCustoms<'a>, ar: &mut AstArena<'a>, src: &'a str, kids: &[SVal<'a>], alt_path: &[usize], off: usize, end: usize, left: Option<SVal<'a>>, op_text: Option<&'a str>, state: Option<Vec<(&'static str, AstFoldCounts)>>) -> SVal<'a> {
    let op = op_text.unwrap_or("");
    if !BINARY_OPS.contains(&op) { unhandled("estreeExprBinary", alt_path, op_text, None); }
    let opv = sval_str(src, op);
    let right = take_kid(kids, 0);
    let left = left.unwrap_or(SVal::Null);
    if ASSIGN_OPS.contains(&op) {

        let mut t = customs.0.borrow_mut();
        let l_left = to_lean(left, &mut *t);
        let l_right = to_lean(right, &mut *t);
        t.assign_exprs.push(TAssignExpr { left: l_left, operator: opv, right: l_right });
        SVal::TNode(TN_ASSIGN, (t.assign_exprs.len() - 1) as u32)
    } else if LOGICAL_OPS.contains(&op) {

        let mut t = customs.0.borrow_mut();
        let l_left = to_lean(left, &mut *t);
        let l_right = to_lean(right, &mut *t);
        t.logical_exprs.push(TLogicalExpr { left: l_left, operator: opv, right: l_right });
        SVal::TNode(TN_LOGICAL, (t.logical_exprs.len() - 1) as u32)
    } else {
        // M2 typed path: direct struct into the typed arena — no DynObj, no field keys.

        let mut t = customs.0.borrow_mut();
        let l_left = to_lean(left, &mut *t);
        let l_right = to_lean(right, &mut *t);
        t.bin_exprs.push(TBinExpr { left: l_left, operator: opv, right: l_right });
        SVal::TNode(TN_BINEXPR, (t.bin_exprs.len() - 1) as u32)
    }
}

fn estree_expr_prefix<'a>(customs: &TsEstreeCustoms<'a>, ar: &mut AstArena<'a>, src: &'a str, kids: &[SVal<'a>], alt_path: &[usize], off: usize, end: usize, left: Option<SVal<'a>>, op_text: Option<&'a str>, state: Option<Vec<(&'static str, AstFoldCounts)>>) -> SVal<'a> {
    let op = op_text.unwrap_or("");
    if !PREFIX_OPS.contains(&op) { unhandled("estreeExprPrefix", alt_path, op_text, None); }
    let argument = take_kid(kids, 0);
    if UPDATE_OPS.contains(&op) { update_expr(customs, ar, sval_str(src, op), argument, true) } else { unary_expr(customs, ar, sval_str(src, op), argument) }
}

fn estree_expr_postfix_tok<'a>(customs: &TsEstreeCustoms<'a>, ar: &mut AstArena<'a>, src: &'a str, kids: &[SVal<'a>], alt_path: &[usize], off: usize, end: usize, left: Option<SVal<'a>>, op_text: Option<&'a str>, state: Option<Vec<(&'static str, AstFoldCounts)>>) -> SVal<'a> {
    let op = op_text.unwrap_or("");
    if !op.starts_with('`') { unhandled("estreeExprPostfixTok", alt_path, op_text, None); }

    let mut t = customs.0.borrow_mut();
    let l_tag = to_lean(left.unwrap_or(SVal::Null), &mut *t);
    t.tagged_templates.push(TTaggedTemplate {
        tag: l_tag,
        quasi: child_ref(take_kid(kids, 0)),
    });
    SVal::TNode(TN_TAGGEDTPL, (t.tagged_templates.len() - 1) as u32)
}

fn estree_template_literal<'a>(customs: &TsEstreeCustoms<'a>, ar: &mut AstArena<'a>, src: &'a str, kids: &[SVal<'a>], alt_path: &[usize], off: usize, end: usize, left: Option<SVal<'a>>, op_text: Option<&'a str>, state: Option<Vec<(&'static str, AstFoldCounts)>>) -> SVal<'a> {
    let k = kids;
    if k.len() == 1 {
        let v = k[0];
        if matches!(v, SVal::Str(..) | SVal::OwnStr(_)) {
            let raw = match v {
                SVal::Str(o, l) => sval_str(ar.src, tpl_raw("nosubst", ar.str_span(o, l))),
                _ => { let t = ar.str_of(v).to_owned(); ar.mk_own_str(&tpl_raw("nosubst", &t)) }
            };
            let raw_idx = {
                let mut t = customs.0.borrow_mut();
                t.raw_vals.push(TRawVal { raw });
                (t.raw_vals.len() - 1) as u32
            };
            let quasi = {

                let mut t = customs.0.borrow_mut();
                t.template_els.push(TTemplateEl { value: raw_idx, tail: true });
                SVal::TNode(TN_TEMPLATEEL, (t.template_els.len() - 1) as u32)
            };
            let quasis = ar.mk_list(&[quasi]);
            let exprs = ar.mk_list(&[]);

            let mut t = customs.0.borrow_mut();
            t.template_lits.push(TTemplateLit { quasis: list_range(quasis), expressions: list_range(exprs) });
            return SVal::TNode(TN_TEMPLATELIT, (t.template_lits.len() - 1) as u32);
        }
    }
    if k.len() < 3 || k.len() % 2 == 0 { unhandled("estreeTemplateLiteral", alt_path, op_text, None); }
    let len = k.len();
    // Quasis are all TNode(TN_TEMPLATEEL) — pack into node_lists; expressions
    // route through mk_fast (mixed kid types possible).
    let qstart = ar.node_lists.len() as u32;
    for (i, &kid) in k.iter().enumerate() {
        if i % 2 == 0 {
            if !matches!(kid, SVal::Str(..) | SVal::OwnStr(_)) {
                unhandled("estreeTemplateLiteral", alt_path, op_text, None);
            }
            let is_head = i == 0;
            let is_tail = i == len - 1;
            let kind = if is_head { "head" } else if is_tail { "tail" } else { "middle" };
            let raw = match kid {
                SVal::Str(o, l) => sval_str(ar.src, tpl_raw(kind, ar.str_span(o, l))),
                _ => {
                    let t = ar.str_of(kid).to_owned();
                    ar.mk_own_str(&tpl_raw(kind, &t))
                }
            };
            let raw_idx = {
                let mut t = customs.0.borrow_mut();
                t.raw_vals.push(TRawVal { raw });
                (t.raw_vals.len() - 1) as u32
            };
            let el = {

                let mut t = customs.0.borrow_mut();
                t.template_els.push(TTemplateEl { value: raw_idx, tail: is_tail });
                SVal::TNode(TN_TEMPLATEEL, (t.template_els.len() - 1) as u32)
            };
            if let SVal::TNode(et, eidx) = el { ar.node_lists.push((et as u32) << 24 | eidx); }
        }
    }
    let ql = SVal::NodeList(qstart, ((len + 1) / 2) as u32);
    let mut odd: Vec<SVal<'a>> = Vec::with_capacity(len / 2);
    for (i, &kid) in k.iter().enumerate() {
        if i % 2 == 1 { odd.push(kid); }
    }
    let el = mk_fast(ar, &odd);

    let mut t = customs.0.borrow_mut();
    t.template_lits.push(TTemplateLit { quasis: list_range(ql), expressions: list_range(el) });
    SVal::TNode(TN_TEMPLATELIT, (t.template_lits.len() - 1) as u32)
}

fn estree_expr_led<'a>(customs: &TsEstreeCustoms<'a>, ar: &mut AstArena<'a>, src: &'a str, kids: &[SVal<'a>], alt_path: &[usize], off: usize, end: usize, left: Option<SVal<'a>>, op_text: Option<&'a str>, state: Option<Vec<(&'static str, AstFoldCounts)>>) -> SVal<'a> {
    let left = left.unwrap_or(SVal::Null);
    let op = op_text.unwrap_or("");
    let arm = alt_path.first().copied();
    if arm == Some(4) { return estree_optional_chain(customs, ar, left, kids); }
    // Allocation-free slot access: flatten one level lazily (List → its
    // elements, Null → skip, other → itself) without materializing a Vec.
    let flat_first = |ar: &AstArena<'a>, kids: &[SVal<'a>]| -> Option<SVal<'a>> {
        for &k in kids {
            match k {
                SVal::Null => {}
                SVal::List(_, _) => {
                    if let Some(&f) = ar.list_of(k).first() { return Some(f); }
                }
                SVal::NodeList(s, l) => {
                    if l > 0 { return Some(SVal::TNode((ar.node_lists[s as usize] >> 24) as u16, ar.node_lists[s as usize] & 0xFFFFFF)); }
                }
                other => return Some(other),
            }
        }
        None
    };
    let flat_nth = |ar: &AstArena<'a>, kids: &[SVal<'a>], n: usize| -> SVal<'a> {
        let mut i = 0usize;
        for &k in kids {
            match k {
                SVal::Null => {}
                SVal::List(_, _) => {
                    for &x in ar.list_of(k) {
                        if i == n { return x; }
                        i += 1;
                    }
                }
                SVal::NodeList(s, l) => {
                    for j in 0..l {
                        if i == n { let e = ar.node_lists[(s + j) as usize]; return SVal::TNode((e >> 24) as u16, e & 0xFFFFFF); }
                        i += 1;
                    }
                }
                other => {
                    if i == n { return other; }
                    i += 1;
                }
            }
        }
        SVal::Null
    };
    match arm {
        Some(0) | Some(2) => {
            // Call args: all-TNode kids pack straight into node_lists; otherwise
            // flatten + drop Null holes into the generic lists slab.
            let args = if kids.iter().all(|k| matches!(k, SVal::TNode(..))) {
                mk_fast(ar, kids)
            } else {
                let start = ar.lists.len();
                for &k in kids {
                    match k {
                        SVal::Null => {}
                        SVal::List(s, l) => {
                            for i in 0..l {
                                let x = ar.lists[(s + i) as usize];
                                if !matches!(x, SVal::Null) { ar.lists.push(x); }
                            }
                        }
                        other => ar.lists.push(other),
                    }
                }
                SVal::List(start as u32, (ar.lists.len() - start) as u32)
            };

            let mut t = customs.0.borrow_mut();
            let l_callee = to_lean(left, &mut *t);
            t.call_exprs.push(TCallExpr { callee: l_callee, arguments: list_range(args), optional: None, type_arguments: None });
            SVal::TNode(TN_CALL, (t.call_exprs.len() - 1) as u32)
        }
        Some(1) => {
            let ta = match flat_first(ar, kids) { Some(v) => v, None => ar.mk_list(&[]) };

            let mut t = customs.0.borrow_mut();
            t.ts_instantiation_exprs.push(TTSInstantiationExpr { expression: left, type_arguments: ta });
            SVal::TNode(TN_TSINSTANTIATION, (t.ts_instantiation_exprs.len() - 1) as u32)
        }
        Some(3) => member_expr(customs, ar, left, flat_first(ar, kids).unwrap_or(SVal::OwnStr(S_UNDEFINED)), false),
        Some(5) => member_expr(customs, ar, left, flat_first(ar, kids).unwrap_or(SVal::OwnStr(S_UNDEFINED)), true),
        Some(6) => {

            let mut t = customs.0.borrow_mut();
            t.ts_non_nulls.push(TTSNonNull { expression: left });
            SVal::TNode(TN_TSNONNULL, (t.ts_non_nulls.len() - 1) as u32)
        }
        Some(7) => {
            let consequent = flat_nth(ar, kids, 0);
            let alternate = flat_nth(ar, kids, 1);

            let mut t = customs.0.borrow_mut();
            let l_t = to_lean(left, &mut *t);
            let l_c = to_lean(consequent, &mut *t);
            let l_a = to_lean(alternate, &mut *t);
            t.cond_exprs.push(TCondExpr { test: l_t, consequent: l_c, alternate: l_a });
            SVal::TNode(TN_COND, (t.cond_exprs.len() - 1) as u32)
        }
        Some(8) => {

            let mut t = customs.0.borrow_mut();
            t.ts_as_exprs.push(TTSAsExpr { expression: left, type_annotation: flat_first(ar, kids).unwrap_or(SVal::Null) });
            SVal::TNode(TN_TSAS, (t.ts_as_exprs.len() - 1) as u32)
        }
        Some(9) => binary_expr(customs, ar, left, SVal::OwnStr(S_INSTANCEOF), flat_first(ar, kids).unwrap_or(SVal::Null)),
        Some(10) => binary_expr(customs, ar, left, SVal::OwnStr(S_IN), flat_first(ar, kids).unwrap_or(SVal::Null)),
        Some(11) => {

            let mut t = customs.0.borrow_mut();
            t.ts_satisfies_exprs.push(TTSSatisfiesExpr { expression: left, type_annotation: flat_first(ar, kids).unwrap_or(SVal::Null) });
            SVal::TNode(TN_TSSATISFIES, (t.ts_satisfies_exprs.len() - 1) as u32)
        }
        _ => unhandled("estreeExprLed", alt_path, op_text, Some(&format!("LED altPath={:?} opText={:?}", alt_path, op))),
    }
}

fn estree_expr_nud_seq<'a>(customs: &TsEstreeCustoms<'a>, ar: &mut AstArena<'a>, src: &'a str, kids: &[SVal<'a>], alt_path: &[usize], off: usize, end: usize, left: Option<SVal<'a>>, op_text: Option<&'a str>, state: Option<Vec<(&'static str, AstFoldCounts)>>) -> SVal<'a> {
    let arm = alt_path.first().copied();
    let k = kids;
    match arm {
        Some(0) => match k.get(0).copied() {
            Some(v) if matches!(v, SVal::Str(..) | SVal::OwnStr(_)) => ident_of(customs, v),
            Some(other) => other,
            None => SVal::Null,
        },
        Some(1) | Some(2) => {
            let dl = flat_list(ar, &[take_kid(k, 0)]);
            let id = take_kid(k, 1);
            let tail = &k[3.min(k.len())..];
            let bl = flat_list(ar, tail);
            let body = {

                let mut t = customs.0.borrow_mut();
                t.class_bodys.push(TClassBody { body: list_range(bl) });
                SVal::TNode(TN_CLASSBODY, (t.class_bodys.len() - 1) as u32)
            };

            let mut t = customs.0.borrow_mut();
            t.class_exprs.push(TClassExpr {
                decorators: list_range(dl),
                id: child_ref(id),
                body: child_ref(body),
            });
            SVal::TNode(TN_CLASSEXPR, (t.class_exprs.len() - 1) as u32)
        }
        _ => unhandled("estreeExprNudSeq", alt_path, op_text, None),
    }
}

fn estree_arrow<'a>(customs: &TsEstreeCustoms<'a>, ar: &mut AstArena<'a>, src: &'a str, kids: &[SVal<'a>], alt_path: &[usize], off: usize, end: usize, left: Option<SVal<'a>>, op_text: Option<&'a str>, state: Option<Vec<(&'static str, AstFoldCounts)>>) -> SVal<'a> {
    let async_ = span_str(src, off, end).trim_start().starts_with("async");
    let arm = alt_path.first().copied();
    if arm.is_none() || arm.unwrap() > 3 { unhandled("estreeArrow", alt_path, op_text, None); }
    let k = kids;
    let len = k.len();
    let pidx = if arm == Some(1) || arm == Some(2) { 1usize } else { 0usize };
    let (params, body) = if len > pidx && len - 1 == pidx {
        // One slot feeds both params and body (the original cloned it twice; SVal is Copy).
        let v = take_kid(k, pidx);
        let body = v;
        let params = if pidx == 1 {
            flat_list(ar, &[v])
        } else {
            let pv = match v { SVal::Str(..) | SVal::OwnStr(_) => ident_of(customs, v), other => other };
            ar.mk_list(&[pv])
        };
        (params, body)
    } else {
        let body = take_last(k);
        let params = if pidx == 1 {
            // SVal::List(0, 0): empty-list sentinel (list_of yields [] for a 0-len range).
            flat_list(ar, &[k.get(1).copied().unwrap_or(SVal::List(0, 0))])
        } else {
            let p = k.get(0).copied().unwrap_or(SVal::Null);
            let pv = match p { SVal::Str(..) | SVal::OwnStr(_) => ident_of(customs, p), other => other };
            ar.mk_list(&[pv])
        };
        (params, body)
    };
    arrow_fn(customs, ar, params, body, async_)
}

fn ts_type_led<'a>(customs: &TsEstreeCustoms<'a>, ar: &mut AstArena<'a>, src: &'a str, kids: &[SVal<'a>], alt_path: &[usize], off: usize, end: usize, left: Option<SVal<'a>>, op_text: Option<&'a str>, state: Option<Vec<(&'static str, AstFoldCounts)>>) -> SVal<'a> {
    if op_text.is_none() {
        let arm = alt_path.first().copied();
        if arm == Some(7) {
            let l = flat_list(ar, kids);

            let mut t = customs.0.borrow_mut();
            t.ts_type_literals.push(TTSTypeLiteral { members: l });
            return SVal::TNode(TN_TSTYPELIT, (t.ts_type_literals.len() - 1) as u32);
        }
        if arm.is_none() || arm.unwrap() > 20 {
            unhandled("tsTypeLed", alt_path, op_text, Some(&format!("group altPath={:?}", alt_path)));
        }
        let ht = match kids.first() {
            // Str/OwnStr pass through borrowed — no js_string round-trip String.
            Some(&v @ (SVal::Str(..) | SVal::OwnStr(_))) => v,
            Some(&v) => ar.mk_own_str(&js_string(ar, v)),
            None => ar.mk_own_str(""),
        };
        let children = ar.mk_list(kids);

        let mut t = customs.0.borrow_mut();
        let l_ht = to_lean(ht, &mut *t);
        t.types.push(TType {
            children: list_range(children),
            head_text: l_ht,
            off: off as u32,
            end: end as u32,
        });
        SVal::TNode(TN_TYPE, (t.types.len() - 1) as u32)
    } else {
        let op = op_text.unwrap_or("");
        let left = left.unwrap_or(SVal::Null);
        if op == "extends" {

            let mut t = customs.0.borrow_mut();
            t.ts_cond_types.push(TTSCondType {
                check_type: left,
                extends_type: take_kid(kids, 0),
                true_type: take_kid(kids, 1),
                false_type: take_kid(kids, 2),
            });
            SVal::TNode(TN_TSCONDTYPE, (t.ts_cond_types.len() - 1) as u32)
        } else if op == "[" {

            let mut t = customs.0.borrow_mut();
            t.ts_indexed_accesses.push(TTSIndexedAccess { object_type: left, index_type: take_kid(kids, 0) });
            SVal::TNode(TN_TSINDEXED, (t.ts_indexed_accesses.len() - 1) as u32)
        } else if op == "<" || op == "|" || op == "&" || op == "." || op == "?" || op == "!" {
            let meta = {
                let mut t = customs.0.borrow_mut();
                t.meta_ops.push(TMetaOp { op: sval_str(src, op) });
                SVal::TNode(TN_METAOP, (t.meta_ops.len() - 1) as u32)
            };

            let mut t = customs.0.borrow_mut();
            t.ts_type_refs.push(TTSTypeRef {
                type_name: left,
                type_parameters: take_kid(kids, 0),
                meta: child_ref(meta),
            });
            SVal::TNode(TN_TSTYPEREF, (t.ts_type_refs.len() - 1) as u32)
        } else {
            unhandled("tsTypeLed", alt_path, op_text, Some(&format!("LED altPath={:?} opText={:?}", alt_path, op)))
        }
    }
}

fn estree_new_target_led<'a>(customs: &TsEstreeCustoms<'a>, ar: &mut AstArena<'a>, src: &'a str, kids: &[SVal<'a>], alt_path: &[usize], off: usize, end: usize, left: Option<SVal<'a>>, op_text: Option<&'a str>, state: Option<Vec<(&'static str, AstFoldCounts)>>) -> SVal<'a> {
    let op = op_text.unwrap_or("");
    let left = left.unwrap_or(SVal::Null);
    let first_is_target = match kids.first() {
        Some(&v) => matches!(v, SVal::Str(..) | SVal::OwnStr(_)) && ar.str_of(v) == "target",
        None => false,
    };
    if op == "." && first_is_target && head_is_new(customs, ar, left) {
        let meta = ts_ident(customs, ar, "new");
        let prop = ts_ident(customs, ar, "target");

        let mut t = customs.0.borrow_mut();
        let l_meta = to_lean(meta, &mut *t);
        let l_prop = to_lean(prop, &mut *t);
        t.meta_props.push(TMetaProperty { meta: l_meta, property: l_prop });
        return SVal::TNode(TN_METAPROP, (t.meta_props.len() - 1) as u32);
    }
    if op == "." { member_expr(customs, ar, left, kids.get(0).copied().unwrap_or(SVal::OwnStr(S_UNDEFINED)), false) }
    else if op == "[" { member_expr(customs, ar, left, kids.get(0).copied().unwrap_or(SVal::OwnStr(S_UNDEFINED)), true) }
    else { unhandled("estreeNewTargetLed", alt_path, op_text, None) }
}

fn estree_array_pattern<'a>(customs: &TsEstreeCustoms<'a>, ar: &mut AstArena<'a>, src: &'a str, kids: &[SVal<'a>], alt_path: &[usize], off: usize, end: usize, left: Option<SVal<'a>>, op_text: Option<&'a str>, state: Option<Vec<(&'static str, AstFoldCounts)>>) -> SVal<'a> {
    if alt_path.first().copied() != Some(1) { unhandled("estreeArrayPattern", alt_path, op_text, None); }
    // All-TNode kids pack into node_lists; otherwise flatten with holes
    // preserved (Null elements stay) into the generic lists slab.
    if kids.iter().all(|k| matches!(k, SVal::TNode(..))) {
        let l = mk_fast(ar, kids);

        let mut t = customs.0.borrow_mut();
        t.array_patterns.push(TArrayPattern { elements: list_range(l) });
        return SVal::TNode(TN_ARRAYPAT, (t.array_patterns.len() - 1) as u32);
    }
    let start = ar.lists.len();
    for &kid in kids {
        match kid {
            SVal::List(s, l) => ar.lists.extend_from_within(s as usize..(s + l) as usize),
            SVal::NodeList(s, l) => {
                for j in 0..l {
                    let e = ar.node_lists[(s + j) as usize];
                    ar.lists.push(SVal::TNode((e >> 24) as u16, e & 0xFFFFFF));
                }
            }
            other => ar.lists.push(other),
        }
    }
    let l = SVal::List(start as u32, (ar.lists.len() - start) as u32);

    let mut t = customs.0.borrow_mut();
    t.array_patterns.push(TArrayPattern { elements: list_range(l) });
    SVal::TNode(TN_ARRAYPAT, (t.array_patterns.len() - 1) as u32)
}

fn estree_binding_property<'a>(customs: &TsEstreeCustoms<'a>, ar: &mut AstArena<'a>, src: &'a str, kids: &[SVal<'a>], alt_path: &[usize], off: usize, end: usize, left: Option<SVal<'a>>, op_text: Option<&'a str>, state: Option<Vec<(&'static str, AstFoldCounts)>>) -> SVal<'a> {
    let arm = alt_path.first().copied();
    let a = take_kid(kids, 0);
    let b = take_kid(kids, 1);
    match arm {
        Some(1) => {
            let name = if matches!(a, SVal::Str(..) | SVal::OwnStr(_)) { a } else { SVal::Str(0, 0) };
            let key = ident_of(customs, name);
            let val = ident_of(customs, name);

            let mut t = customs.0.borrow_mut();
            let l_key = to_lean(key, &mut *t);
            let l_kind = to_lean(SVal::OwnStr(S_INIT), &mut *t);
            t.properties.push(TProperty { key: l_key, value: val, kind: l_kind, method: false, shorthand: true, computed: false, method_first: true });
            SVal::TNode(TN_PROPERTY, (t.properties.len() - 1) as u32)
        }
        Some(3) => {

            let mut t = customs.0.borrow_mut();
            let l_arg = to_lean(a, &mut *t);
            t.rest_elements.push(TRestElement { argument: l_arg });
            SVal::TNode(TN_REST, (t.rest_elements.len() - 1) as u32)
        }
        Some(2) => {

            let mut t = customs.0.borrow_mut();
            let l_key = to_lean(a, &mut *t);
            let l_kind = to_lean(SVal::OwnStr(S_INIT), &mut *t);
            t.properties.push(TProperty { key: l_key, value: b, kind: l_kind, method: false, shorthand: false, computed: true, method_first: true });
            SVal::TNode(TN_PROPERTY, (t.properties.len() - 1) as u32)
        }
        Some(0) => {
            let key = match a { SVal::Str(..) | SVal::OwnStr(_) => ident_of(customs, a), other => other };

            let mut t = customs.0.borrow_mut();
            let l_key = to_lean(key, &mut *t);
            let l_kind = to_lean(SVal::OwnStr(S_INIT), &mut *t);
            t.properties.push(TProperty { key: l_key, value: b, kind: l_kind, method: false, shorthand: false, computed: false, method_first: true });
            SVal::TNode(TN_PROPERTY, (t.properties.len() - 1) as u32)
        }
        _ => unhandled("estreeBindingProperty", alt_path, op_text, None),
    }
}

fn estree_param<'a>(customs: &TsEstreeCustoms<'a>, ar: &mut AstArena<'a>, src: &'a str, kids: &[SVal<'a>], alt_path: &[usize], off: usize, end: usize, left: Option<SVal<'a>>, op_text: Option<&'a str>, state: Option<Vec<(&'static str, AstFoldCounts)>>) -> SVal<'a> {
    let arm = alt_path.first().copied();
    let k = kids;
    match arm {
        Some(0) => {

            let mut t = customs.0.borrow_mut();
            let l_name = to_lean(SVal::OwnStr(S_THIS), &mut *t);
            t.idents.push(TIdentifier { name: l_name, type_annotation: child_ref(take_kid(k, 0)) });
            SVal::TNode(TN_IDENT, (t.idents.len() - 1) as u32)
        }
        Some(1) | Some(2) => {
            let len = k.len();
            let i = len.saturating_sub(2);
            // len ≤ 2: kids[0] feeds both id and decorators (the original cloned it twice).
            let (id, deco_src) = if i == 0 && len > 0 {
                let v = take_kid(k, 0);
                (v, Some(v))
            } else {
                (take_kid(k, i), k.get(0).copied())
            };
            let dl = flat_list(ar, &[deco_src.unwrap_or(SVal::List(0, 0))]);
            let optional = arm == Some(1);
            // M16: Identifier fallback → typed TN_PARAMIDENT (name [+ typeAnnotation]).
            // Other node types keep the legacy DynObj path (fields copied verbatim).
            match id {
                SVal::Str(..) | SVal::OwnStr(_) => {
                    let mut t = customs.0.borrow_mut();
                    t.param_idents.push(TParamIdent { name: id, type_annotation: CR_NULL, decorators: dl, optional });
                    SVal::TNode(TN_PARAMIDENT, (t.param_idents.len() - 1) as u32)
                }
                SVal::Node(_) => {
                    let t = ar.typ_of(id);
                    let typ = if t.is_empty() { "Identifier" } else { t };
                    let (fs, fl) = ar.fields_range_of(id);
                    if typ == "Identifier" {
                        // Only name [+ typeAnnotation] fields qualify for typed.
                        let mut name = None;
                        let mut type_annotation = None;
                        let mut ok = true;
                        for &(fname, fval) in &ar.fields[fs..fs + fl] {
                            match fname {
                                "name" => name = Some(fval),
                                "typeAnnotation" => type_annotation = Some(fval),
                                _ => { ok = false; break; }
                            }
                        }
                        if ok {
                            if let Some(name) = name {
                                let mut t = customs.0.borrow_mut();
                                t.param_idents.push(TParamIdent { name, type_annotation: type_annotation.map(child_ref).unwrap_or(CR_NULL), decorators: dl, optional });
                                return SVal::TNode(TN_PARAMIDENT, (t.param_idents.len() - 1) as u32);
                            }
                        }
                    }
                    // Non-Identifier type or extra fields → legacy DynObj fallback.
                    let fbase = ar.fields.len();
                    ar.fields.extend_from_within(fs..(fs + fl));
                    ar.fields.push(("decorators", dl));
                    ar.fields.push(("optional", SVal::Bool(optional)));
                    ar.mk_obj_raw(typ, fbase)
                }
                // Typed Identifier — mirror the old Node field copy (name [+ typeAnnotation]).
                SVal::TNode(tag, idx) if tag == TN_IDENT => {
                    let n = customs.0.borrow().idents[idx as usize];
                    let name = from_lean(n.name, &customs.0.borrow());
                    let mut t = customs.0.borrow_mut();
                    t.param_idents.push(TParamIdent { name, type_annotation: n.type_annotation, decorators: dl, optional });
                    SVal::TNode(TN_PARAMIDENT, (t.param_idents.len() - 1) as u32)
                }
                _ => {
                    let mut t = customs.0.borrow_mut();
                    t.param_idents.push(TParamIdent { name: SVal::Str(0, 0), type_annotation: CR_NULL, decorators: dl, optional });
                    SVal::TNode(TN_PARAMIDENT, (t.param_idents.len() - 1) as u32)
                }
            }
        }
        _ => unhandled("estreeParam", alt_path, op_text, None),
    }
}

fn estree_for_head<'a>(customs: &TsEstreeCustoms<'a>, ar: &mut AstArena<'a>, src: &'a str, kids: &[SVal<'a>], alt_path: &[usize], off: usize, end: usize, left: Option<SVal<'a>>, op_text: Option<&'a str>, state: Option<Vec<(&'static str, AstFoldCounts)>>) -> SVal<'a> {
    let arm = alt_path.first().copied();
    let src = src;
    let off = off;
    let k = kids;
    match arm {
        Some(0) => {

            let mut t = customs.0.borrow_mut();
            let l_kind = to_lean(SVal::OwnStr(S_CLASSIC), &mut *t);
            t.for_heads.push(TForHead {
                kind: l_kind,
                init: Some(take_kid(k, 0)), test: Some(take_kid(k, 1)), update: Some(take_kid(k, 2)),
                left: None, right: None, await_: None,
            });
            SVal::TNode(TN_FORHEAD, (t.for_heads.len() - 1) as u32)
        }
        Some(1) => {
            let init = seq_expr(customs, ar, k.get(0).copied(), None).unwrap_or(SVal::Null);
            let test = seq_expr(customs, ar, k.get(1).copied(), None).unwrap_or(SVal::Null);
            let update = seq_expr(customs, ar, k.get(2).copied(), None).unwrap_or(SVal::Null);

            let mut t = customs.0.borrow_mut();
            let l_kind = to_lean(SVal::OwnStr(S_CLASSIC), &mut *t);
            t.for_heads.push(TForHead {
                kind: l_kind,
                init: Some(init), test: Some(test), update: Some(update),
                left: None, right: None, await_: None,
            });
            SVal::TNode(TN_FORHEAD, (t.for_heads.len() - 1) as u32)
        }
        Some(2) => {

            let mut t = customs.0.borrow_mut();
            let l_kind = to_lean(SVal::OwnStr(S_IN), &mut *t);
            t.for_heads.push(TForHead {
                kind: l_kind,
                init: None, test: None, update: None,
                left: Some(take_kid(k, 0)), right: Some(take_kid(k, 1)), await_: None,
            });
            SVal::TNode(TN_FORHEAD, (t.for_heads.len() - 1) as u32)
        }
        Some(3) => {

            let mut t = customs.0.borrow_mut();
            let l_kind = to_lean(SVal::OwnStr(S_OF), &mut *t);
            t.for_heads.push(TForHead {
                kind: l_kind,
                init: None, test: None, update: None,
                left: Some(take_kid(k, 0)), right: Some(take_kid(k, 1)),
                await_: Some(prefix(src, off, 5).contains("await")),
            });
            SVal::TNode(TN_FORHEAD, (t.for_heads.len() - 1) as u32)
        }
        _ => unhandled("estreeForHead", alt_path, op_text, None),
    }
}

fn estree_switch_case<'a>(customs: &TsEstreeCustoms<'a>, ar: &mut AstArena<'a>, src: &'a str, kids: &[SVal<'a>], alt_path: &[usize], off: usize, end: usize, left: Option<SVal<'a>>, op_text: Option<&'a str>, state: Option<Vec<(&'static str, AstFoldCounts)>>) -> SVal<'a> {
    let arm = alt_path.first().copied();
    match arm {
        Some(2) => ar.mk_partial("switch-consequent", "append", take_kid(kids, 0)),
        Some(1) => {
            let empty = ar.mk_list(&[]);
            // M2 typed SwitchCase — the fold goes through tnode_fold_append.
            let idx = {

                let mut t = customs.0.borrow_mut();
                t.switch_cases.push(TSwitchCase { test: SVal::Null, consequent: empty });
                (t.switch_cases.len() - 1) as u32
            };
            ar.mk_partial("switch-consequent", "start", SVal::TNode(TN_SWITCHCASE, idx))
        }
        Some(0) => {
            let test = seq_expr(customs, ar, kids.get(0).copied(), kids.get(1).copied()).unwrap_or(SVal::Null);
            let empty = ar.mk_list(&[]);
            let idx = {

                let mut t = customs.0.borrow_mut();
                t.switch_cases.push(TSwitchCase { test, consequent: empty });
                (t.switch_cases.len() - 1) as u32
            };
            ar.mk_partial("switch-consequent", "start", SVal::TNode(TN_SWITCHCASE, idx))
        }
        _ => unhandled("estreeSwitchCase", alt_path, op_text, None),
    }
}

fn deco_step<'a>(customs: &TsEstreeCustoms<'a>, ar: &mut AstArena<'a>, seen: &mut bool, expr: &mut SVal<'a>, x: SVal<'a>) {
    if !*seen {
        *seen = true;
        *expr = match x {
            SVal::Str(o, l) if ar.str_span(o, l).starts_with('@') => ident_of(customs, SVal::Str(o + 1, l - 1)),
            SVal::OwnStr(_) if ar.str_of(x).starts_with('@') => {
                let txt = ar.str_of(x)[1..].to_owned();
                ts_ident(customs, ar, &txt)
            }
            other => other,
        };
        return;
    }
    match x {
        SVal::List(s, l) => {
            let st = ar.lists.len();
            ar.lists.extend_from_within(s as usize..(s + l) as usize);
            let args = SVal::List(st as u32, (ar.lists.len() - st) as u32);

            let mut t = customs.0.borrow_mut();
            let l_callee = to_lean(*expr, &mut *t);
            t.call_exprs.push(TCallExpr { callee: l_callee, arguments: list_range(args), optional: None, type_arguments: None });
            *expr = SVal::TNode(TN_CALL, (t.call_exprs.len() - 1) as u32);
        }
        // Packed all-TNode args — copy the packed range to the node_lists tail.
        SVal::NodeList(s, l) => {
            let st = ar.node_lists.len() as u32;
            ar.node_lists.extend_from_within(s as usize..(s + l) as usize);
            let args = SVal::NodeList(st, l);

            let mut t = customs.0.borrow_mut();
            let l_callee = to_lean(*expr, &mut *t);
            t.call_exprs.push(TCallExpr { callee: l_callee, arguments: list_range(args), optional: None, type_arguments: None });
            *expr = SVal::TNode(TN_CALL, (t.call_exprs.len() - 1) as u32);
        }
        // Node or typed node — single-argument call (≡ old Node arm, now tag-agnostic).
        SVal::Node(_) | SVal::TNode(..) => {
            let args = ar.mk_list(&[x]);

            let mut t = customs.0.borrow_mut();
            let l_callee = to_lean(*expr, &mut *t);
            t.call_exprs.push(TCallExpr { callee: l_callee, arguments: list_range(args), optional: None, type_arguments: None });
            *expr = SVal::TNode(TN_CALL, (t.call_exprs.len() - 1) as u32);
        }
        other => *expr = member_expr(customs, ar, *expr, other, false),
    }
}

fn estree_decorator<'a>(customs: &TsEstreeCustoms<'a>, ar: &mut AstArena<'a>, src: &'a str, kids: &[SVal<'a>], alt_path: &[usize], off: usize, end: usize, left: Option<SVal<'a>>, op_text: Option<&'a str>, state: Option<Vec<(&'static str, AstFoldCounts)>>) -> SVal<'a> {
    let arm = alt_path.first().copied();
    if arm.is_none() || arm.unwrap() > 1 { unhandled("estreeDecorator", alt_path, op_text, None); }
    let mut expr = SVal::Null;
    let mut seen = false;
    for &kid in kids {
        match kid {
            SVal::Null => {}
            SVal::List(s, l) => {
                for i in 0..l {
                    let x = ar.lists[(s + i) as usize];
                    deco_step(customs, ar, &mut seen, &mut expr, x);
                }
            }
            SVal::NodeList(s, l) => {
                for j in 0..l {
                    let e = ar.node_lists[(s + j) as usize];
                    deco_step(customs, ar, &mut seen, &mut expr, SVal::TNode((e >> 24) as u16, e & 0xFFFFFF));
                }
            }
            other => deco_step(customs, ar, &mut seen, &mut expr, other),
        }
    }

    let mut t = customs.0.borrow_mut();
    let l_expr = to_lean(expr, &mut *t);
    t.decorators.push(TDecorator { expression: l_expr });
    SVal::TNode(TN_DECORATOR, (t.decorators.len() - 1) as u32)
}

fn estree_class_member<'a>(customs: &TsEstreeCustoms<'a>, ar: &mut AstArena<'a>, src: &'a str, kids: &[SVal<'a>], alt_path: &[usize], off: usize, end: usize, left: Option<SVal<'a>>, op_text: Option<&'a str>, state: Option<Vec<(&'static str, AstFoldCounts)>>) -> SVal<'a> {
    let arm = alt_path.first().copied();
    let k = kids;
    match arm {
        Some(0) => SVal::Null,
        Some(1) => {
            let pl = flat_list(ar, &[take_kid(k, 0)]);
            let fexpr = {

                let mut t = customs.0.borrow_mut();
                t.function_exprs.push(TFunctionExpr {
                    params: list_range(pl),
                    body: child_ref(take_kid(k, 1)),
                    async_: None, generator: None,
                });
                SVal::TNode(TN_FUNCEXPR, (t.function_exprs.len() - 1) as u32)
            };
            let key = ts_ident(customs, ar, "constructor");

            let mut t = customs.0.borrow_mut();
            let l_kind = to_lean(SVal::OwnStr(S_CTOR), &mut *t);
            t.method_defs.push(TMethodDef {
                kind: l_kind, key,
                value: fexpr,
                static_: false, computed: None,
            });
            SVal::TNode(TN_METHODDEF, (t.method_defs.len() - 1) as u32)
        }
        Some(2) => {

            let mut t = customs.0.borrow_mut();
            t.static_blocks.push(TStaticBlock { body: list_range(take_kid(k, 0)) });
            SVal::TNode(TN_STATICBLOCK, (t.static_blocks.len() - 1) as u32)
        }
        Some(4) => {

            let mut t = customs.0.borrow_mut();
            t.property_defs.push(TPropertyDef {
                key: take_kid(k, 0),
                value: take_kid(k, 1),
                static_: false, readonly: false,
            });
            SVal::TNode(TN_PROPDEF, (t.property_defs.len() - 1) as u32)
        }
        Some(3) | Some(5) => {
            let nested = alt_path.get(1).copied();
            if arm == Some(3) && nested == Some(8) {
                // Slice reads into nested lists, values copied out before mutation — no temp Vec.
                // Branch/tail slots may be packed NodeList — unroll to SVal first.
                let (b0, t1, t3) = {
                    let branch: Vec<SVal<'a>> = match k.get(1).copied() {
                        Some(v @ SVal::List(_, _)) => ar.list_of(v).to_vec(),
                        Some(v @ SVal::NodeList(s, l)) => ar.node_lists[s as usize..(s + l) as usize].iter().map(|&e| SVal::TNode((e >> 24) as u16, e & 0xFFFFFF)).collect(),
                        Some(_) | None => Vec::new(),
                    };
                    let tail: Vec<SVal<'a>> = match branch.get(1).copied() {
                        Some(v @ SVal::List(_, _)) => ar.list_of(v).to_vec(),
                        Some(v @ SVal::NodeList(s, l)) => ar.node_lists[s as usize..(s + l) as usize].iter().map(|&e| SVal::TNode((e >> 24) as u16, e & 0xFFFFFF)).collect(),
                        Some(_) | None => Vec::new(),
                    };
                    (take_kid(&branch, 0), take_kid(&tail, 1), take_kid(&tail, 3))
                };
                let pl = flat_list(ar, &[t1]);
                let fexpr = {

                    let mut t = customs.0.borrow_mut();
                    t.function_exprs.push(TFunctionExpr {
                        params: list_range(pl),
                        body: child_ref(t3),
                        async_: Some(false), generator: Some(false),
                    });
                    SVal::TNode(TN_FUNCEXPR, (t.function_exprs.len() - 1) as u32)
                };

                let mut t = customs.0.borrow_mut();
                let l_kind = to_lean(SVal::OwnStr(S_METHOD), &mut *t);
                t.method_defs.push(TMethodDef {
                    kind: l_kind,
                    key: b0,
                    value: fexpr,
                    static_: false, computed: Some(false),
                });
                return SVal::TNode(TN_METHODDEF, (t.method_defs.len() - 1) as u32);
            }
            if arm == Some(5) {

                let mut t = customs.0.borrow_mut();
                let l_kind = to_lean(SVal::OwnStr(S_METHOD), &mut *t);
                t.method_defs.push(TMethodDef {
                    kind: l_kind,
                    key: take_kid(k, 0),
                    value: take_kid(k, 1),
                    static_: true, computed: None,
                });
                return SVal::TNode(TN_METHODDEF, (t.method_defs.len() - 1) as u32);
            }
            if nested.map(|n| n <= 8).unwrap_or(false) {

                let mut t = customs.0.borrow_mut();
                let l_kind = to_lean(SVal::OwnStr(S_METHOD), &mut *t);
                t.method_defs.push(TMethodDef {
                    kind: l_kind,
                    key: take_kid(k, 0),
                    value: take_kid(k, 1),
                    static_: false, computed: None,
                });
                return SVal::TNode(TN_METHODDEF, (t.method_defs.len() - 1) as u32);
            }
            unhandled("estreeClassMember", alt_path, op_text, None)
        }
        _ => unhandled("estreeClassMember", alt_path, op_text, None),
    }
}

fn ts_interface_member<'a>(customs: &TsEstreeCustoms<'a>, ar: &mut AstArena<'a>, src: &'a str, kids: &[SVal<'a>], alt_path: &[usize], off: usize, end: usize, left: Option<SVal<'a>>, op_text: Option<&'a str>, state: Option<Vec<(&'static str, AstFoldCounts)>>) -> SVal<'a> {
    let arm = alt_path.first().copied();
    let src = src;
    let k = kids;
    match arm {
        Some(0) => {
            let construct = span_str(src, off, end).trim_start().starts_with("new");
            let pl = flat_list(ar, &[take_kid(k, 1)]);

            let mut t = customs.0.borrow_mut();
            t.ts_call_sigs.push(TTSCallSig {
                type_parameters: child_ref(take_kid(k, 0)),
                params: list_range(pl),
                return_type: child_ref(take_kid(k, 2)),
                construct,
            });
            SVal::TNode(TN_TSCALLSIG, (t.ts_call_sigs.len() - 1) as u32)
        }
        Some(1) => {
            // ≡ prefix(src, off, 3) as a span (clamped at EOF) — M15.
            let kind = if off <= src.len() { SVal::Str(off as u32, (src.len() - off).min(3) as u32) } else { SVal::Str(0, 0) };
            let pl = flat_list(ar, &[take_kid(k, 1)]);

            let mut t = customs.0.borrow_mut();
            t.ts_method_sigs.push(TTSMethodSig {
                kind: Some(kind),
                key: take_kid(k, 0),
                params: list_range(pl),
                return_type: child_ref(take_kid(k, 2)),
                optional: None,
            });
            SVal::TNode(TN_TSMETHODSIG, (t.ts_method_sigs.len() - 1) as u32)
        }
        Some(2) => {
            // len ≤ 2: typeAnnotation (last kid) aliases key (len 1) or constraint (len 2).
            let len = k.len();
            let key = take_kid(k, 0);
            let constraint = take_kid(k, 1);
            let ann = if len == 1 { key } else if len == 2 { constraint } else { take_last(k) };

            let mut t = customs.0.borrow_mut();
            let l_key = to_lean(key, &mut *t);
            t.ts_mapped_types.push(TTSMappedType {
                key: l_key,
                constraint: child_ref(constraint),
                type_annotation: child_ref(ann),
            });
            SVal::TNode(TN_TSMAPPED, (t.ts_mapped_types.len() - 1) as u32)
        }
        Some(3) => {

            let mut t = customs.0.borrow_mut();
            let l_key = to_lean(take_kid(k, 0), &mut *t);
            t.ts_property_sigs.push(TTSPropertySig {
                key: l_key,
                type_annotation: take_kid(k, 1),
                optional: src.contains('?'), readonly: true,
            });
            SVal::TNode(TN_TSPROPSIG, (t.ts_property_sigs.len() - 1) as u32)
        }
        Some(4) => {
            let method = matches!(k.get(2), Some(SVal::List(_, _)));
            if method {
                let pl = flat_list(ar, &[take_kid(k, 2)]);

                let mut t = customs.0.borrow_mut();
                t.ts_method_sigs.push(TTSMethodSig {
                    kind: None,
                    key: take_kid(k, 0),
                    params: list_range(pl),
                    return_type: child_ref(take_kid(k, 3)),
                    optional: Some(src.contains('?')),
                });
                SVal::TNode(TN_TSMETHODSIG, (t.ts_method_sigs.len() - 1) as u32)
            } else {

                let mut t = customs.0.borrow_mut();
                let l_key = to_lean(take_kid(k, 0), &mut *t);
                t.ts_property_sigs.push(TTSPropertySig {
                    key: l_key,
                    type_annotation: take_kid(k, 1),
                    optional: src.contains('?'), readonly: false,
                });
                SVal::TNode(TN_TSPROPSIG, (t.ts_property_sigs.len() - 1) as u32)
            }
        }
        Some(5) => {
            let pl = flat_list(ar, &[take_kid(k, 0)]);

            let mut t = customs.0.borrow_mut();
            t.ts_index_sigs.push(TTSIndexSig {
                parameters: list_range(pl),
                type_annotation: take_kid(k, 1),
            });
            SVal::TNode(TN_TSINDEXSIG, (t.ts_index_sigs.len() - 1) as u32)
        }
        _ => unhandled("tsInterfaceMember", alt_path, op_text, None),
    }
}

fn ts_type_member<'a>(customs: &TsEstreeCustoms<'a>, ar: &mut AstArena<'a>, src: &'a str, kids: &[SVal<'a>], alt_path: &[usize], off: usize, end: usize, left: Option<SVal<'a>>, op_text: Option<&'a str>, state: Option<Vec<(&'static str, AstFoldCounts)>>) -> SVal<'a> {
    let arm = alt_path.first().copied();
    let src = src;
    let k = kids;
    match arm {
        Some(0) => {
            let construct = span_str(src, off, end).trim_start().starts_with("new");
            let pl = flat_list(ar, &[take_kid(k, 1)]);

            let mut t = customs.0.borrow_mut();
            t.ts_call_sigs.push(TTSCallSig {
                type_parameters: child_ref(take_kid(k, 0)),
                params: list_range(pl),
                return_type: child_ref(take_kid(k, 2)),
                construct,
            });
            SVal::TNode(TN_TSCALLSIG, (t.ts_call_sigs.len() - 1) as u32)
        }
        Some(1) => {
            // len == 1: kids[0] feeds both parameters and typeAnnotation.
            let params = take_kid(k, 0);
            let ann = if k.len() == 1 { params } else { take_last(k) };
            let pl = flat_list(ar, &[params]);

            let mut t = customs.0.borrow_mut();
            t.ts_index_sigs.push(TTSIndexSig {
                parameters: list_range(pl),
                type_annotation: ann,
            });
            SVal::TNode(TN_TSINDEXSIG, (t.ts_index_sigs.len() - 1) as u32)
        }
        Some(2) => {

            let mut t = customs.0.borrow_mut();
            let l_key = to_lean(take_kid(k, 0), &mut *t);
            t.ts_property_sigs.push(TTSPropertySig {
                key: l_key,
                type_annotation: take_kid(k, 1),
                optional: src.contains('?'), readonly: true,
            });
            SVal::TNode(TN_TSPROPSIG, (t.ts_property_sigs.len() - 1) as u32)
        }
        Some(3) => {
            let method = matches!(k.get(2), Some(SVal::List(_, _)));
            if method {
                let pl = flat_list(ar, &[take_kid(k, 2)]);

                let mut t = customs.0.borrow_mut();
                t.ts_method_sigs.push(TTSMethodSig {
                    kind: None,
                    key: take_kid(k, 0),
                    params: list_range(pl),
                    return_type: child_ref(take_kid(k, 3)),
                    optional: Some(src.contains('?')),
                });
                SVal::TNode(TN_TSMETHODSIG, (t.ts_method_sigs.len() - 1) as u32)
            } else {

                let mut t = customs.0.borrow_mut();
                let l_key = to_lean(take_kid(k, 0), &mut *t);
                t.ts_property_sigs.push(TTSPropertySig {
                    key: l_key,
                    type_annotation: take_kid(k, 1),
                    optional: src.contains('?'), readonly: false,
                });
                SVal::TNode(TN_TSPROPSIG, (t.ts_property_sigs.len() - 1) as u32)
            }
        }
        _ => unhandled("tsTypeMember", alt_path, op_text, None),
    }
}

fn estree_prop<'a>(customs: &TsEstreeCustoms<'a>, ar: &mut AstArena<'a>, src: &'a str, kids: &[SVal<'a>], alt_path: &[usize], off: usize, end: usize, left: Option<SVal<'a>>, op_text: Option<&'a str>, state: Option<Vec<(&'static str, AstFoldCounts)>>) -> SVal<'a> {
    let arm = alt_path.first().copied();
    let k = kids;
    match arm {
        Some(4) | Some(5) => {
            let name = match k.get(0).copied() {
                Some(v) if matches!(v, SVal::Str(..) | SVal::OwnStr(_)) => v,
                _ => SVal::Str(0, 0),
            };
            let key = ident_of(customs, name);
            let val = ident_of(customs, name);

            let mut t = customs.0.borrow_mut();
            let l_key = to_lean(key, &mut *t);
            let l_kind = to_lean(SVal::OwnStr(S_INIT), &mut *t);
            t.properties.push(TProperty { key: l_key, value: val, kind: l_kind, method: false, shorthand: true, computed: false, method_first: false });
            SVal::TNode(TN_PROPERTY, (t.properties.len() - 1) as u32)
        }
        Some(8) => {

            let mut t = customs.0.borrow_mut();
            let l_arg = to_lean(take_kid(k, 0), &mut *t);
            t.spread_elements.push(TSpreadElement { argument: l_arg });
            SVal::TNode(TN_SPREAD, (t.spread_elements.len() - 1) as u32)
        }
        Some(6) | Some(7) => {

            let mut t = customs.0.borrow_mut();
            let l_key = to_lean(take_kid(k, 0), &mut *t);
            let l_kind = to_lean(SVal::OwnStr(if arm == Some(6) { S_GET } else { S_SET }), &mut *t);
            t.properties.push(TProperty {
                key: l_key,
                value: take_kid(k, 1),
                kind: l_kind,
                method: false, shorthand: false, computed: false, method_first: false,
            });
            SVal::TNode(TN_PROPERTY, (t.properties.len() - 1) as u32)
        }
        Some(2) | Some(3) => {
            let pl = flat_list(ar, &[take_kid(k, 1)]);
            let fexpr = {

                let mut t = customs.0.borrow_mut();
                t.function_exprs.push(TFunctionExpr {
                    params: list_range(pl),
                    body: child_ref(take_kid(k, 2)),
                    async_: None, generator: None,
                });
                SVal::TNode(TN_FUNCEXPR, (t.function_exprs.len() - 1) as u32)
            };

            let mut t = customs.0.borrow_mut();
            let l_key = to_lean(take_kid(k, 0), &mut *t);
            let l_kind = to_lean(SVal::OwnStr(S_INIT), &mut *t);
            t.properties.push(TProperty {
                key: l_key,
                value: fexpr,
                kind: l_kind, method: true, shorthand: false, computed: false, method_first: true,
            });
            SVal::TNode(TN_PROPERTY, (t.properties.len() - 1) as u32)
        }
        Some(0) | Some(1) | Some(9) | Some(10) | Some(11) => {
            let key = match k.get(0).copied() {
                Some(v) if matches!(v, SVal::Str(..) | SVal::OwnStr(_)) => ident_of(customs, v),
                Some(other) => other,
                None => SVal::Null,
            };

            let mut t = customs.0.borrow_mut();
            let l_key = to_lean(key, &mut *t);
            let l_kind = to_lean(SVal::OwnStr(S_INIT), &mut *t);
            t.properties.push(TProperty {
                key: l_key,
                value: take_kid(k, 1),
                kind: l_kind, method: false, shorthand: false,
                computed: arm == Some(1), method_first: false,
            });
            SVal::TNode(TN_PROPERTY, (t.properties.len() - 1) as u32)
        }
        _ => unhandled("estreeProp", alt_path, op_text, None),
    }
}

pub struct TsEstreeCustoms<'a>(std::cell::RefCell<TnodesArena<'a>>);
impl<'a> Default for TsEstreeCustoms<'a> {
    fn default() -> Self { Self(std::cell::RefCell::new(TnodesArena::default())) }
}
impl<'a> ShapeCustoms<'a> for TsEstreeCustoms<'a> {
    /// Match JS `Number(text)`: hex/bin/octal OK; numeric separators → NaN; never panic.
    /// Fast path: plain integers take a digit loop, skipping f64::from_str's
    /// correct-rounding cost (the majority of literals in real code).
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
        if !bytes.is_empty() && bytes.len() <= 19 && bytes.iter().all(|c| c.is_ascii_digit()) {
            let mut v: u64 = 0;
            for &c in bytes { v = v * 10 + (c - b'0') as u64; }
            return v as f64;
        }
        text.parse::<f64>().unwrap_or(f64::NAN)
    }
    /// M17: pre-size every typed Vec from the token count. Counts measured on
    /// the 2MB bench corpus (n = 865,440 tokens); divisor = round(865440/c).
    /// One batch reserve per parse replaces the 1-by-1 push growth that would
    /// otherwise realloc-churn every vector via RawVec::finish_grow. Vecs
    /// measured at zero count are skipped — Vec::new allocates nothing, so
    /// small inputs waste zero memory. Slight under-reserve is fine (tail
    /// growth is amortized O(1)); the /22, /45, /13 entries land within ~2%
    /// of exact (see trailing comment: measured count).
    fn reserve(&self, n: usize) {
        let mut t = self.0.borrow_mut();
        // ── expression/core ──
        t.idents.reserve(n / 10);            // 86,544
        t.bin_exprs.reserve(n / 90);         // 9,616
        t.var_declarators.reserve(n / 22);   // 38,464
        t.call_exprs.reserve(n / 30);        // 28,848
        t.expr_stmts.reserve(n / 30);        // 28,848
        t.var_decls.reserve(n / 30);         // 28,848
        t.seq_exprs.reserve(n / 45);         // 19,232
        t.func_decls.reserve(n / 90);        // 9,616
        t.arrow_fns.reserve(n / 90);         // 9,616
        t.template_lits.reserve(n / 90);     // 9,616
        t.template_els.reserve(n / 45);      // 19,232
        // ── statements ──
        t.if_stmts.reserve(n / 90);          // 9,616
        t.for_stmts.reserve(n / 90);         // 9,616
        t.return_stmts.reserve(n / 45);      // 19,232
        // ── module/class ──
        t.class_decls.reserve(n / 90);       // 9,616
        t.class_bodys.reserve(n / 90);       // 9,616
        t.method_defs.reserve(n / 90);       // 9,616
        t.function_exprs.reserve(n / 90);    // 9,616
        // ── TS family + misc ──
        t.ts_type_refs.reserve(n / 90);      // 9,616
        t.ts_type_aliases.reserve(n / 90);   // 9,616
        t.for_heads.reserve(n / 90);         // 9,616
        // ── M14/M15/M16 typed keep/custom nodes ──
        t.type_keeps.reserve(n / 13);        // 67,312
        t.block_stmt_sps.reserve(n / 30);    // 28,848
        t.member_names.reserve(n / 90);      // 9,616
        t.ts_type_params.reserve(n / 90);    // 9,616
        t.ts_type_param_decls.reserve(n / 90); // 9,616
        t.raw_vals.reserve(n / 45);          // 19,232
        t.meta_ops.reserve(n / 90);          // 9,616
        t.param_idents.reserve(n / 45);      // 19,232
        // ── M27-B2: LeanSVal slabs ──
        t.numbers.reserve(n / 32);           // ~27,045
        t.spans.reserve(n / 32);             // ~27,045
    }
    /// M15: prefill the customs literal strings (S_* consts) into the OwnStr
    /// slab — one small batch per parse instead of per-node String allocs.
    fn prime(&self, ar: &mut AstArena<'a>) {
        ar.strings.extend(["init", "undefined", "method", "classic", "using", "this", "of", "in", "constructor", "get", "set", "instanceof"].iter().map(|s| s.to_string()));
    }
    /// M14: generated keep-wrapper "Type" nodes go typed (children + headText
    /// only); every other keep-wrapper type keeps the default DynObj path.
    fn keep_node(&self, ar: &mut AstArena<'a>, typ: &'static str, children: SVal<'a>, head_text: SVal<'a>) -> SVal<'a> {
        if typ == "Type" {
            let mut t = self.0.borrow_mut();
            let l_ht = to_lean(head_text, &mut *t);
            t.type_keeps.push(TTypeKeep { children: list_range(children), head_text: l_ht });
            return SVal::TNode(TN_TYPEKEEP, (t.type_keeps.len() - 1) as u32);
        }
        let _fbase = ar.fields.len();
        ar.fields.push(("children", children));
        ar.fields.push(("headText", head_text));
        ar.mk_obj_raw(typ, _fbase)
    }
    /// M14b: typed conversion of emitter node() finishes whose layout is known.
    /// The transient fields are read back then truncated (they never reach the
    /// slab); unknown layouts fall through to the DynObj default.
    fn finish_obj(&self, ar: &mut AstArena<'a>, typ: &'static str, fbase: usize) -> SVal<'a> {
        let flen = ar.fields.len() - fbase;
        let num = |i: usize| -> Option<f64> { if let SVal::Number(n) = ar.fields[fbase + i].1 { Some(n) } else { None } };
        match (typ, flen) {
            ("BlockStatement", 3) if ar.fields[fbase].0 == "body" && num(1).is_some() && num(2).is_some() => {
                let (body, off, end) = (ar.fields[fbase].1, num(1).unwrap(), num(2).unwrap());
                ar.fields.truncate(fbase);
                let mut t = self.0.borrow_mut();
                t.block_stmt_sps.push(TBlockStmtSp { body: list_range(body), off: off as u32, end: end as u32 });
                SVal::TNode(TN_BLOCKSTMT_SP, (t.block_stmt_sps.len() - 1) as u32)
            }
            ("MemberName", 3) if ar.fields[fbase].0 == "children" && num(2).is_some() => {
                let (children, arm, alt) = (ar.fields[fbase].1, ar.fields[fbase + 1].1, num(2).unwrap());
                ar.fields.truncate(fbase);
                let mut t = self.0.borrow_mut();
                let l_arm = to_lean(arm, &mut *t);
                t.member_names.push(TMemberName { children: list_range(children), arm: l_arm, alt: alt as u32 });
                SVal::TNode(TN_MEMBERNAME, (t.member_names.len() - 1) as u32)
            }
            ("TSTypeParameter", 5) if ar.fields[fbase].0 == "name" && num(3).is_some() && num(4).is_some() => {
                let (name, constraint, default, off, end) = (ar.fields[fbase].1, ar.fields[fbase + 1].1, ar.fields[fbase + 2].1, num(3).unwrap(), num(4).unwrap());
                ar.fields.truncate(fbase);
                let mut t = self.0.borrow_mut();
                let l_name = to_lean(name, &mut *t);
                t.ts_type_params.push(TTSTypeParam { name: l_name, constraint: child_ref(constraint), default: child_ref(default), off: off as u32, end: end as u32 });
                SVal::TNode(TN_TSTYPEPARAM, (t.ts_type_params.len() - 1) as u32)
            }
            ("TSTypeParameterDeclaration", 3) if ar.fields[fbase].0 == "params" && num(1).is_some() && num(2).is_some() => {
                let (params, off, end) = (ar.fields[fbase].1, num(1).unwrap(), num(2).unwrap());
                ar.fields.truncate(fbase);
                let mut t = self.0.borrow_mut();
                t.ts_type_param_decls.push(TTSTypeParamDecl { params: list_range(params), off: off as u32, end: end as u32 });
                SVal::TNode(TN_TSTPARAMDECL, (t.ts_type_param_decls.len() - 1) as u32)
            }
            _ => ar.mk_obj_raw(typ, fbase),
        }
    }
    /// M14: head-text for typed keep wrappers — mirrors the DynObj "headText"
    /// field read shape_head_text used to do on these nodes.
    fn tnode_head_text(&self, tag: u16, idx: u32) -> SVal<'a> {
        if tag == TN_TYPEKEEP { return from_lean(self.0.borrow().type_keeps[idx as usize].head_text, &self.0.borrow()); }
        SVal::Str(0, 0)
    }
    /// Legacy ctx dispatch — kept for the fail-loud harness; forwards positionally
    /// to the GrammarCustoms methods (state cloned: &ctx can't move it out).
    fn ast_custom<'c>(&self, ctx: &AstCustomCtx<'a, 'c>, arena: &'c mut AstArena<'a>) -> SVal<'a> {
        match ctx.fn_id {
            FN_estreeStmt => self.estreeStmt(arena, ctx.src, ctx.kids, ctx.alt_path, ctx.off, ctx.end, ctx.left, ctx.op_text, ctx.state.clone()),
            FN_estreeDecl => self.estreeDecl(arena, ctx.src, ctx.kids, ctx.alt_path, ctx.off, ctx.end, ctx.left, ctx.op_text, ctx.state.clone()),
            FN_estreeVariableDeclarator => self.estreeVariableDeclarator(arena, ctx.src, ctx.kids, ctx.alt_path, ctx.off, ctx.end, ctx.left, ctx.op_text, ctx.state.clone()),
            FN_estreeParenOrComma => self.estreeParenOrComma(arena, ctx.src, ctx.kids, ctx.alt_path, ctx.off, ctx.end, ctx.left, ctx.op_text, ctx.state.clone()),
            FN_estreeExprBinary => self.estreeExprBinary(arena, ctx.src, ctx.kids, ctx.alt_path, ctx.off, ctx.end, ctx.left, ctx.op_text, ctx.state.clone()),
            FN_estreeExprPrefix => self.estreeExprPrefix(arena, ctx.src, ctx.kids, ctx.alt_path, ctx.off, ctx.end, ctx.left, ctx.op_text, ctx.state.clone()),
            FN_estreeExprPostfixTok => self.estreeExprPostfixTok(arena, ctx.src, ctx.kids, ctx.alt_path, ctx.off, ctx.end, ctx.left, ctx.op_text, ctx.state.clone()),
            FN_estreeTemplateLiteral => self.estreeTemplateLiteral(arena, ctx.src, ctx.kids, ctx.alt_path, ctx.off, ctx.end, ctx.left, ctx.op_text, ctx.state.clone()),
            FN_estreeExprLed => self.estreeExprLed(arena, ctx.src, ctx.kids, ctx.alt_path, ctx.off, ctx.end, ctx.left, ctx.op_text, ctx.state.clone()),
            FN_estreeExprNudSeq => self.estreeExprNudSeq(arena, ctx.src, ctx.kids, ctx.alt_path, ctx.off, ctx.end, ctx.left, ctx.op_text, ctx.state.clone()),
            FN_estreeArrow => self.estreeArrow(arena, ctx.src, ctx.kids, ctx.alt_path, ctx.off, ctx.end, ctx.left, ctx.op_text, ctx.state.clone()),
            FN_tsTypeLed => self.tsTypeLed(arena, ctx.src, ctx.kids, ctx.alt_path, ctx.off, ctx.end, ctx.left, ctx.op_text, ctx.state.clone()),
            FN_estreeNewTargetLed => self.estreeNewTargetLed(arena, ctx.src, ctx.kids, ctx.alt_path, ctx.off, ctx.end, ctx.left, ctx.op_text, ctx.state.clone()),
            FN_estreeArrayPattern => self.estreeArrayPattern(arena, ctx.src, ctx.kids, ctx.alt_path, ctx.off, ctx.end, ctx.left, ctx.op_text, ctx.state.clone()),
            FN_estreeBindingProperty => self.estreeBindingProperty(arena, ctx.src, ctx.kids, ctx.alt_path, ctx.off, ctx.end, ctx.left, ctx.op_text, ctx.state.clone()),
            FN_estreeParam => self.estreeParam(arena, ctx.src, ctx.kids, ctx.alt_path, ctx.off, ctx.end, ctx.left, ctx.op_text, ctx.state.clone()),
            FN_estreeForHead => self.estreeForHead(arena, ctx.src, ctx.kids, ctx.alt_path, ctx.off, ctx.end, ctx.left, ctx.op_text, ctx.state.clone()),
            FN_estreeSwitchCase => self.estreeSwitchCase(arena, ctx.src, ctx.kids, ctx.alt_path, ctx.off, ctx.end, ctx.left, ctx.op_text, ctx.state.clone()),
            FN_estreeDecorator => self.estreeDecorator(arena, ctx.src, ctx.kids, ctx.alt_path, ctx.off, ctx.end, ctx.left, ctx.op_text, ctx.state.clone()),
            FN_estreeClassMember => self.estreeClassMember(arena, ctx.src, ctx.kids, ctx.alt_path, ctx.off, ctx.end, ctx.left, ctx.op_text, ctx.state.clone()),
            FN_tsInterfaceMember => self.tsInterfaceMember(arena, ctx.src, ctx.kids, ctx.alt_path, ctx.off, ctx.end, ctx.left, ctx.op_text, ctx.state.clone()),
            FN_tsTypeMember => self.tsTypeMember(arena, ctx.src, ctx.kids, ctx.alt_path, ctx.off, ctx.end, ctx.left, ctx.op_text, ctx.state.clone()),
            FN_estreeProp => self.estreeProp(arena, ctx.src, ctx.kids, ctx.alt_path, ctx.off, ctx.end, ctx.left, ctx.op_text, ctx.state.clone()),
            _ => panic!("shape rust: custom {} not provided — SH3-4", ctx.name),
        }
    }
    /// M2 typed-node JSON — byte-identical to the DynObj/ts_obj field order.
    fn write_tnode_json(&self, ar: &AstArena<'a>, tag: u16, idx: u32, out: &mut String) {
        match tag {
            TN_BINEXPR => {
                let n = self.0.borrow().bin_exprs[idx as usize];
                out.push_str("{\"type\":\"BinaryExpression\",\"left\":");
                write_lean_json(ar, self, n.left, out);
                out.push_str(",\"operator\":");
                write_sval_json(ar, self, n.operator, out);
                out.push_str(",\"right\":");
                write_lean_json(ar, self, n.right, out);
                out.push('}');
            }
            TN_VARDECLARATOR => {
                let n = self.0.borrow().var_declarators[idx as usize];
                out.push_str("{\"type\":\"VariableDeclarator\",\"id\":");
                write_sval_json(ar, self, n.id, out);
                out.push_str(",\"typeAnnotation\":");
                write_child_ref(ar, self, n.type_annotation, out);
                out.push_str(",\"init\":");
                write_lean_json(ar, self, n.init, out);
                out.push_str(",\"off\":");
                out.push_str(&n.off.to_string());
                out.push_str(",\"end\":");
                out.push_str(&n.end.to_string());
                out.push('}');
            }
            TN_SWITCHCASE => {
                let n = self.0.borrow().switch_cases[idx as usize];
                out.push_str("{\"type\":\"SwitchCase\",\"test\":");
                write_sval_json(ar, self, n.test, out);
                out.push_str(",\"consequent\":");
                write_sval_json(ar, self, n.consequent, out);
                out.push('}');
            }
            TN_IDENT => {
                let n = self.0.borrow().idents[idx as usize];
                out.push_str("{\"type\":\"Identifier\",\"name\":");
                write_lean_json(ar, self, n.name, out);
                if n.type_annotation.idx != u32::MAX {
                    out.push_str(",\"typeAnnotation\":");
                    write_child_ref(ar, self, n.type_annotation, out);
                }
                out.push('}');
            }
            TN_EXPRSTMT => {
                let n = self.0.borrow().expr_stmts[idx as usize];
                out.push_str("{\"type\":\"ExpressionStatement\",\"expression\":");
                write_sval_json(ar, self, n.expression, out);
                out.push('}');
            }
            TN_CALL => {
                let n = self.0.borrow().call_exprs[idx as usize];
                out.push_str("{\"type\":\"CallExpression\",\"callee\":");
                write_lean_json(ar, self, n.callee, out);
                out.push_str(",\"arguments\":");
                write_list_range(ar, self, n.arguments.0, n.arguments.1, out);
                if let Some(o) = n.optional {
                    out.push_str(",\"optional\":");
                    out.push_str(if o { "true" } else { "false" });
                }
                if let Some((s, l)) = n.type_arguments {
                    out.push_str(",\"typeArguments\":");
                    write_list_range(ar, self, s, l, out);
                }
                out.push('}');
            }
            TN_MEMBER => {
                let n = self.0.borrow().member_exprs[idx as usize];
                out.push_str("{\"type\":\"MemberExpression\",\"object\":");
                write_lean_json(ar, self, n.object, out);
                out.push_str(",\"property\":");
                write_lean_json(ar, self, n.property, out);
                out.push_str(",\"computed\":");
                out.push_str(if n.computed { "true" } else { "false" });
                out.push_str(",\"optional\":");
                out.push_str(if n.optional { "true" } else { "false" });
                // Legacy duplicate key from the optional-chain member arms.
                if n.dup_optional { out.push_str(",\"optional\":true"); }
                out.push('}');
            }
            TN_VARDECL => {
                let n = self.0.borrow().var_decls[idx as usize];
                out.push_str("{\"type\":\"VariableDeclaration\",\"kind\":");
                write_lean_json(ar, self, n.kind, out);
                out.push_str(",\"declarations\":");
                write_list_range(ar, self, n.declarations.0, n.declarations.1, out);
                out.push('}');
            }
            TN_BLOCKSTMT => {
                let n = self.0.borrow().block_stmts[idx as usize];
                out.push_str("{\"type\":\"BlockStatement\",\"body\":");
                write_sval_json(ar, self, n.body, out);
                out.push('}');
            }
            TN_PROPERTY => {
                let n = self.0.borrow().properties[idx as usize];
                out.push_str("{\"type\":\"Property\",\"key\":");
                write_lean_json(ar, self, n.key, out);
                out.push_str(",\"value\":");
                write_sval_json(ar, self, n.value, out);
                out.push_str(",\"kind\":");
                write_lean_json(ar, self, n.kind, out);
                let (m, s, c) = (
                    if n.method { "true" } else { "false" },
                    if n.shorthand { "true" } else { "false" },
                    if n.computed { "true" } else { "false" },
                );
                if n.method_first {
                    out.push_str(",\"method\":"); out.push_str(m);
                    out.push_str(",\"shorthand\":"); out.push_str(s);
                    out.push_str(",\"computed\":"); out.push_str(c);
                } else {
                    out.push_str(",\"shorthand\":"); out.push_str(s);
                    out.push_str(",\"computed\":"); out.push_str(c);
                    out.push_str(",\"method\":"); out.push_str(m);
                }
                out.push('}');
            }
            TN_FUNCDECL => {
                let n = self.0.borrow().func_decls[idx as usize];
                out.push_str("{\"type\":\"FunctionDeclaration\",\"async\":");
                out.push_str(if n.async_ { "true" } else { "false" });
                out.push_str(",\"generator\":");
                out.push_str(if n.generator { "true" } else { "false" });
                out.push_str(",\"id\":");
                write_sval_json(ar, self, n.id, out);
                out.push_str(",\"typeParameters\":");
                write_sval_json(ar, self, n.type_parameters, out);
                out.push_str(",\"params\":");
                write_list_range(ar, self, n.params.0, n.params.1, out);
                out.push_str(",\"returnType\":");
                write_sval_json(ar, self, n.return_type, out);
                out.push_str(",\"body\":");
                write_child_ref(ar, self, n.body, out);
                out.push('}');
            }
            TN_ARROWFN => {
                let n = self.0.borrow().arrow_fns[idx as usize];
                out.push_str("{\"type\":\"ArrowFunctionExpression\",\"params\":");
                write_list_range(ar, self, n.params.0, n.params.1, out);
                out.push_str(",\"body\":");
                write_lean_json(ar, self, n.body, out);
                out.push_str(",\"async\":");
                out.push_str(if n.async_ { "true" } else { "false" });
                out.push_str(",\"expression\":");
                out.push_str(if n.expression { "true" } else { "false" });
                out.push('}');
            }
            TN_TEMPLATELIT => {
                let n = self.0.borrow().template_lits[idx as usize];
                out.push_str("{\"type\":\"TemplateLiteral\",\"quasis\":");
                write_list_range(ar, self, n.quasis.0, n.quasis.1, out);
                out.push_str(",\"expressions\":");
                write_list_range(ar, self, n.expressions.0, n.expressions.1, out);
                out.push('}');
            }
            TN_TEMPLATEEL => {
                let n = self.0.borrow().template_els[idx as usize];
                out.push_str("{\"type\":\"TemplateElement\",\"value\":");
                write_sval_json(ar, self, SVal::TNode(TN_RAWVAL, n.value), out);
                out.push_str(",\"tail\":");
                out.push_str(if n.tail { "true" } else { "false" });
                out.push('}');
            }
            // ── batch 4: statement family ──
            TN_IF => {
                let n = self.0.borrow().if_stmts[idx as usize];
                out.push_str("{\"type\":\"IfStatement\",\"test\":");
                write_lean_json(ar, self, n.test, out);
                out.push_str(",\"consequent\":");
                write_child_ref(ar, self, n.consequent, out);
                out.push_str(",\"alternate\":");
                write_child_ref(ar, self, n.alternate, out);
                out.push('}');
            }
            TN_FOR => {
                let n = self.0.borrow().for_stmts[idx as usize];
                out.push_str("{\"type\":\"ForStatement\",\"init\":");
                write_sval_json(ar, self, n.init, out);
                out.push_str(",\"test\":");
                write_lean_json(ar, self, n.test, out);
                out.push_str(",\"update\":");
                write_lean_json(ar, self, n.update, out);
                out.push_str(",\"body\":");
                write_child_ref(ar, self, n.body, out);
                out.push('}');
            }
            TN_FORIN => {
                let n = self.0.borrow().for_in_stmts[idx as usize];
                out.push_str("{\"type\":\"ForInStatement\",\"left\":");
                write_sval_json(ar, self, n.left, out);
                out.push_str(",\"right\":");
                write_sval_json(ar, self, n.right, out);
                out.push_str(",\"body\":");
                write_sval_json(ar, self, n.body, out);
                out.push('}');
            }
            TN_FOROF => {
                let n = self.0.borrow().for_of_stmts[idx as usize];
                out.push_str("{\"type\":\"ForOfStatement\",\"left\":");
                write_sval_json(ar, self, n.left, out);
                out.push_str(",\"right\":");
                write_sval_json(ar, self, n.right, out);
                out.push_str(",\"body\":");
                write_sval_json(ar, self, n.body, out);
                out.push_str(",\"await\":");
                out.push_str(if n.await_ { "true" } else { "false" });
                out.push('}');
            }
            TN_WHILE => {
                let n = self.0.borrow().while_stmts[idx as usize];
                out.push_str("{\"type\":\"WhileStatement\",\"test\":");
                write_lean_json(ar, self, n.test, out);
                out.push_str(",\"body\":");
                write_child_ref(ar, self, n.body, out);
                out.push('}');
            }
            TN_DOWHILE => {
                let n = self.0.borrow().do_while_stmts[idx as usize];
                out.push_str("{\"type\":\"DoWhileStatement\",\"body\":");
                write_child_ref(ar, self, n.body, out);
                out.push_str(",\"test\":");
                write_lean_json(ar, self, n.test, out);
                out.push('}');
            }
            TN_SWITCH => {
                let n = self.0.borrow().switch_stmts[idx as usize];
                out.push_str("{\"type\":\"SwitchStatement\",\"discriminant\":");
                write_lean_json(ar, self, n.discriminant, out);
                out.push_str(",\"cases\":");
                write_list_range(ar, self, n.cases.0, n.cases.1, out);
                out.push('}');
            }
            TN_RETURN => {
                let n = self.0.borrow().return_stmts[idx as usize];
                out.push_str("{\"type\":\"ReturnStatement\",\"argument\":");
                write_lean_json(ar, self, n.argument, out);
                out.push('}');
            }
            TN_THROW => {
                let n = self.0.borrow().throw_stmts[idx as usize];
                out.push_str("{\"type\":\"ThrowStatement\",\"argument\":");
                write_lean_json(ar, self, n.argument, out);
                out.push('}');
            }
            TN_BREAK => {
                let n = self.0.borrow().break_stmts[idx as usize];
                out.push_str("{\"type\":\"BreakStatement\",\"label\":");
                write_sval_json(ar, self, n.label, out);
                out.push('}');
            }
            TN_CONTINUE => {
                let n = self.0.borrow().continue_stmts[idx as usize];
                out.push_str("{\"type\":\"ContinueStatement\",\"label\":");
                write_sval_json(ar, self, n.label, out);
                out.push('}');
            }
            TN_TRY => {
                let n = self.0.borrow().try_stmts[idx as usize];
                out.push_str("{\"type\":\"TryStatement\",\"block\":");
                write_child_ref(ar, self, n.block, out);
                out.push_str(",\"handler\":");
                write_sval_json(ar, self, n.handler, out);
                out.push_str(",\"finalizer\":");
                write_child_ref(ar, self, n.finalizer, out);
                out.push('}');
            }
            TN_LABELED => {
                let n = self.0.borrow().labeled_stmts[idx as usize];
                out.push_str("{\"type\":\"LabeledStatement\",\"label\":");
                write_child_ref(ar, self, n.label, out);
                out.push_str(",\"body\":");
                write_child_ref(ar, self, n.body, out);
                out.push('}');
            }
            TN_EMPTY => { out.push_str("{\"type\":\"EmptyStatement\"}"); }
            TN_DEBUGGER => { out.push_str("{\"type\":\"DebuggerStatement\"}"); }
            TN_WITH => {
                let n = self.0.borrow().with_stmts[idx as usize];
                out.push_str("{\"type\":\"WithStatement\",\"object\":");
                write_lean_json(ar, self, n.object, out);
                out.push_str(",\"body\":");
                write_child_ref(ar, self, n.body, out);
                out.push('}');
            }
            TN_SEQ => {
                let n = self.0.borrow().seq_exprs[idx as usize];
                out.push_str("{\"type\":\"SequenceExpression\",\"expressions\":");
                write_list_range(ar, self, n.expressions.0, n.expressions.1, out);
                out.push('}');
            }
            TN_COND => {
                let n = self.0.borrow().cond_exprs[idx as usize];
                out.push_str("{\"type\":\"ConditionalExpression\",\"test\":");
                write_lean_json(ar, self, n.test, out);
                out.push_str(",\"consequent\":");
                write_lean_json(ar, self, n.consequent, out);
                out.push_str(",\"alternate\":");
                write_lean_json(ar, self, n.alternate, out);
                out.push('}');
            }
            TN_ASSIGN => {
                let n = self.0.borrow().assign_exprs[idx as usize];
                out.push_str("{\"type\":\"AssignmentExpression\",\"left\":");
                write_lean_json(ar, self, n.left, out);
                out.push_str(",\"operator\":");
                write_sval_json(ar, self, n.operator, out);
                out.push_str(",\"right\":");
                write_lean_json(ar, self, n.right, out);
                out.push('}');
            }
            TN_LOGICAL => {
                let n = self.0.borrow().logical_exprs[idx as usize];
                out.push_str("{\"type\":\"LogicalExpression\",\"left\":");
                write_lean_json(ar, self, n.left, out);
                out.push_str(",\"operator\":");
                write_sval_json(ar, self, n.operator, out);
                out.push_str(",\"right\":");
                write_lean_json(ar, self, n.right, out);
                out.push('}');
            }
            TN_UNARY => {
                let n = self.0.borrow().unary_exprs[idx as usize];
                out.push_str("{\"type\":\"UnaryExpression\",\"operator\":");
                write_sval_json(ar, self, n.operator, out);
                out.push_str(",\"argument\":");
                write_lean_json(ar, self, n.argument, out);
                out.push_str(",\"prefix\":");
                out.push_str(if n.prefix { "true" } else { "false" });
                out.push('}');
            }
            TN_UPDATE => {
                let n = self.0.borrow().update_exprs[idx as usize];
                out.push_str("{\"type\":\"UpdateExpression\",\"operator\":");
                write_sval_json(ar, self, n.operator, out);
                out.push_str(",\"argument\":");
                write_sval_json(ar, self, n.argument, out);
                out.push_str(",\"prefix\":");
                out.push_str(if n.prefix { "true" } else { "false" });
                out.push('}');
            }
            // ── batch 4: module/class family ──
            TN_EXPORTNAMED => {
                let n = self.0.borrow().export_nameds[idx as usize];
                out.push_str("{\"type\":\"ExportNamedDeclaration\"");
                if let Some(d) = n.declaration {
                    out.push_str(",\"declaration\":");
                    write_sval_json(ar, self, d, out);
                }
                if let Some(s) = n.specifiers {
                    out.push_str(",\"specifiers\":");
                    write_sval_json(ar, self, s, out);
                }
                out.push('}');
            }
            TN_EXPORTALL => {
                let n = self.0.borrow().export_alls[idx as usize];
                out.push_str("{\"type\":\"ExportAllDeclaration\",\"source\":");
                write_sval_json(ar, self, n.source, out);
                out.push('}');
            }
            TN_EXPORTDEFAULT => {
                let n = self.0.borrow().export_defaults[idx as usize];
                out.push_str("{\"type\":\"ExportDefaultDeclaration\",\"declaration\":");
                write_sval_json(ar, self, n.declaration, out);
                out.push('}');
            }
            TN_IMPORT => {
                let n = self.0.borrow().import_decls[idx as usize];
                out.push_str("{\"type\":\"ImportDeclaration\",\"specifiers\":");
                write_list_range(ar, self, n.specifiers.0, n.specifiers.1, out);
                out.push_str(",\"source\":");
                write_sval_json(ar, self, n.source, out);
                out.push('}');
            }
            TN_CLASSDECL => {
                let n = self.0.borrow().class_decls[idx as usize];
                out.push_str("{\"type\":\"ClassDeclaration\",\"decorators\":");
                write_list_range(ar, self, n.decorators.0, n.decorators.1, out);
                out.push_str(",\"id\":");
                write_sval_json(ar, self, n.id, out);
                out.push_str(",\"superClass\":");
                write_sval_json(ar, self, n.super_class, out);
                out.push_str(",\"body\":");
                write_sval_json(ar, self, SVal::TNode(TN_CLASSBODY, n.body), out);
                out.push('}');
            }
            TN_CLASSBODY => {
                let n = self.0.borrow().class_bodys[idx as usize];
                out.push_str("{\"type\":\"ClassBody\",\"body\":");
                write_list_range(ar, self, n.body.0, n.body.1, out);
                out.push('}');
            }
            TN_CLASSEXPR => {
                let n = self.0.borrow().class_exprs[idx as usize];
                out.push_str("{\"type\":\"ClassExpression\",\"decorators\":");
                write_list_range(ar, self, n.decorators.0, n.decorators.1, out);
                out.push_str(",\"id\":");
                write_child_ref(ar, self, n.id, out);
                out.push_str(",\"body\":");
                write_child_ref(ar, self, n.body, out);
                out.push('}');
            }
            TN_METHODDEF => {
                let n = self.0.borrow().method_defs[idx as usize];
                out.push_str("{\"type\":\"MethodDefinition\",\"kind\":");
                write_lean_json(ar, self, n.kind, out);
                out.push_str(",\"key\":");
                write_sval_json(ar, self, n.key, out);
                out.push_str(",\"value\":");
                write_sval_json(ar, self, n.value, out);
                out.push_str(",\"static\":");
                out.push_str(if n.static_ { "true" } else { "false" });
                if let Some(c) = n.computed {
                    out.push_str(",\"computed\":");
                    out.push_str(if c { "true" } else { "false" });
                }
                out.push('}');
            }
            TN_STATICBLOCK => {
                let n = self.0.borrow().static_blocks[idx as usize];
                out.push_str("{\"type\":\"StaticBlock\",\"body\":");
                write_list_range(ar, self, n.body.0, n.body.1, out);
                out.push('}');
            }
            TN_PROPDEF => {
                let n = self.0.borrow().property_defs[idx as usize];
                out.push_str("{\"type\":\"PropertyDefinition\",\"key\":");
                write_sval_json(ar, self, n.key, out);
                out.push_str(",\"value\":");
                write_sval_json(ar, self, n.value, out);
                out.push_str(",\"static\":");
                out.push_str(if n.static_ { "true" } else { "false" });
                out.push_str(",\"readonly\":");
                out.push_str(if n.readonly { "true" } else { "false" });
                out.push('}');
            }
            TN_DECORATOR => {
                let n = self.0.borrow().decorators[idx as usize];
                out.push_str("{\"type\":\"Decorator\",\"expression\":");
                write_lean_json(ar, self, n.expression, out);
                out.push('}');
            }
            TN_METAPROP => {
                let n = self.0.borrow().meta_props[idx as usize];
                out.push_str("{\"type\":\"MetaProperty\",\"meta\":");
                write_lean_json(ar, self, n.meta, out);
                out.push_str(",\"property\":");
                write_lean_json(ar, self, n.property, out);
                out.push('}');
            }
            TN_FUNCEXPR => {
                let n = self.0.borrow().function_exprs[idx as usize];
                out.push_str("{\"type\":\"FunctionExpression\",\"params\":");
                write_list_range(ar, self, n.params.0, n.params.1, out);
                out.push_str(",\"body\":");
                write_child_ref(ar, self, n.body, out);
                if let Some(a) = n.async_ {
                    out.push_str(",\"async\":");
                    out.push_str(if a { "true" } else { "false" });
                }
                if let Some(g) = n.generator {
                    out.push_str(",\"generator\":");
                    out.push_str(if g { "true" } else { "false" });
                }
                out.push('}');
            }
            TN_REST => {
                let n = self.0.borrow().rest_elements[idx as usize];
                out.push_str("{\"type\":\"RestElement\",\"argument\":");
                write_lean_json(ar, self, n.argument, out);
                out.push('}');
            }
            TN_SPREAD => {
                let n = self.0.borrow().spread_elements[idx as usize];
                out.push_str("{\"type\":\"SpreadElement\",\"argument\":");
                write_lean_json(ar, self, n.argument, out);
                out.push('}');
            }
            // ── batch 4: TS family + misc ──
            TN_TSINTERFACEDECL => {
                let n = self.0.borrow().ts_interface_decls[idx as usize];
                out.push_str("{\"type\":\"TSInterfaceDeclaration\",\"id\":");
                write_sval_json(ar, self, n.id, out);
                if let Some(tp) = n.type_parameters {
                    out.push_str(",\"typeParameters\":");
                    write_sval_json(ar, self, tp, out);
                }
                if let Some(e) = n.extends {
                    out.push_str(",\"extends\":");
                    write_sval_json(ar, self, e, out);
                }
                out.push_str(",\"body\":");
                write_child_ref(ar, self, n.body, out);
                out.push('}');
            }
            TN_TSINTERFACEBODY => {
                let n = self.0.borrow().ts_interface_bodys[idx as usize];
                out.push_str("{\"type\":\"TSInterfaceBody\",\"body\":");
                write_sval_json(ar, self, n.body, out);
                out.push('}');
            }
            TN_TSPROPSIG => {
                let n = self.0.borrow().ts_property_sigs[idx as usize];
                out.push_str("{\"type\":\"TSPropertySignature\",\"key\":");
                write_lean_json(ar, self, n.key, out);
                out.push_str(",\"typeAnnotation\":");
                write_sval_json(ar, self, n.type_annotation, out);
                out.push_str(",\"optional\":");
                out.push_str(if n.optional { "true" } else { "false" });
                out.push_str(",\"readonly\":");
                out.push_str(if n.readonly { "true" } else { "false" });
                out.push('}');
            }
            TN_TSMAPPED => {
                let n = self.0.borrow().ts_mapped_types[idx as usize];
                out.push_str("{\"type\":\"TSMappedType\",\"key\":");
                write_lean_json(ar, self, n.key, out);
                out.push_str(",\"constraint\":");
                write_child_ref(ar, self, n.constraint, out);
                out.push_str(",\"typeAnnotation\":");
                write_child_ref(ar, self, n.type_annotation, out);
                out.push('}');
            }
            TN_TSINDEXSIG => {
                let n = self.0.borrow().ts_index_sigs[idx as usize];
                out.push_str("{\"type\":\"TSIndexSignature\",\"parameters\":");
                write_list_range(ar, self, n.parameters.0, n.parameters.1, out);
                out.push_str(",\"typeAnnotation\":");
                write_sval_json(ar, self, n.type_annotation, out);
                out.push('}');
            }
            TN_TSMETHODSIG => {
                let n = self.0.borrow().ts_method_sigs[idx as usize];
                out.push_str("{\"type\":\"TSMethodSignature\"");
                if let Some(k) = n.kind {
                    out.push_str(",\"kind\":");
                    write_sval_json(ar, self, k, out);
                }
                out.push_str(",\"key\":");
                write_sval_json(ar, self, n.key, out);
                out.push_str(",\"params\":");
                write_list_range(ar, self, n.params.0, n.params.1, out);
                out.push_str(",\"returnType\":");
                write_child_ref(ar, self, n.return_type, out);
                if let Some(o) = n.optional {
                    out.push_str(",\"optional\":");
                    out.push_str(if o { "true" } else { "false" });
                }
                out.push('}');
            }
            TN_TSTYPEREF => {
                let n = self.0.borrow().ts_type_refs[idx as usize];
                out.push_str("{\"type\":\"TSTypeReference\",\"typeName\":");
                write_sval_json(ar, self, n.type_name, out);
                out.push_str(",\"typeParameters\":");
                write_sval_json(ar, self, n.type_parameters, out);
                out.push_str(",\"meta\":");
                write_child_ref(ar, self, n.meta, out);
                out.push('}');
            }
            TN_TSTYPELIT => {
                let n = self.0.borrow().ts_type_literals[idx as usize];
                out.push_str("{\"type\":\"TSTypeLiteral\",\"members\":");
                write_sval_json(ar, self, n.members, out);
                out.push('}');
            }
            TN_TSALIAS => {
                let n = self.0.borrow().ts_type_aliases[idx as usize];
                out.push_str("{\"type\":\"TSTypeAliasDeclaration\",\"id\":");
                write_sval_json(ar, self, n.id, out);
                out.push_str(",\"typeParameters\":");
                write_sval_json(ar, self, n.type_parameters, out);
                out.push_str(",\"typeAnnotation\":");
                write_child_ref(ar, self, n.type_annotation, out);
                out.push('}');
            }
            TN_TSCONDTYPE => {
                let n = self.0.borrow().ts_cond_types[idx as usize];
                out.push_str("{\"type\":\"TSConditionalType\",\"checkType\":");
                write_sval_json(ar, self, n.check_type, out);
                out.push_str(",\"extendsType\":");
                write_sval_json(ar, self, n.extends_type, out);
                out.push_str(",\"trueType\":");
                write_sval_json(ar, self, n.true_type, out);
                out.push_str(",\"falseType\":");
                write_sval_json(ar, self, n.false_type, out);
                out.push('}');
            }
            TN_TSINDEXED => {
                let n = self.0.borrow().ts_indexed_accesses[idx as usize];
                out.push_str("{\"type\":\"TSIndexedAccessType\",\"objectType\":");
                write_sval_json(ar, self, n.object_type, out);
                out.push_str(",\"indexType\":");
                write_sval_json(ar, self, n.index_type, out);
                out.push('}');
            }
            TN_TSNONNULL => {
                let n = self.0.borrow().ts_non_nulls[idx as usize];
                out.push_str("{\"type\":\"TSNonNullExpression\",\"expression\":");
                write_sval_json(ar, self, n.expression, out);
                out.push('}');
            }
            TN_TSAS => {
                let n = self.0.borrow().ts_as_exprs[idx as usize];
                out.push_str("{\"type\":\"TSAsExpression\",\"expression\":");
                write_sval_json(ar, self, n.expression, out);
                out.push_str(",\"typeAnnotation\":");
                write_sval_json(ar, self, n.type_annotation, out);
                out.push('}');
            }
            TN_TSSATISFIES => {
                let n = self.0.borrow().ts_satisfies_exprs[idx as usize];
                out.push_str("{\"type\":\"TSSatisfiesExpression\",\"expression\":");
                write_sval_json(ar, self, n.expression, out);
                out.push_str(",\"typeAnnotation\":");
                write_sval_json(ar, self, n.type_annotation, out);
                out.push('}');
            }
            TN_TSINSTANTIATION => {
                let n = self.0.borrow().ts_instantiation_exprs[idx as usize];
                out.push_str("{\"type\":\"TSInstantiationExpression\",\"expression\":");
                write_sval_json(ar, self, n.expression, out);
                out.push_str(",\"typeArguments\":");
                write_sval_json(ar, self, n.type_arguments, out);
                out.push('}');
            }
            TN_TSNAMESPACE => {
                let n = self.0.borrow().ts_namespace_exports[idx as usize];
                out.push_str("{\"type\":\"TSNamespaceExportDeclaration\",\"id\":");
                write_sval_json(ar, self, n.id, out);
                out.push('}');
            }
            TN_TSMODULE => {
                let n = self.0.borrow().ts_module_decls[idx as usize];
                out.push_str("{\"type\":\"TSModuleDeclaration\",\"id\":");
                write_sval_json(ar, self, n.id, out);
                out.push_str(",\"body\":");
                write_child_ref(ar, self, n.body, out);
                if let Some(d) = n.declare {
                    out.push_str(",\"declare\":");
                    out.push_str(if d { "true" } else { "false" });
                }
                out.push('}');
            }
            TN_TSIMPORTEQUALS => {
                let n = self.0.borrow().ts_import_equals[idx as usize];
                out.push_str("{\"type\":\"TSImportEqualsDeclaration\",\"id\":");
                write_child_ref(ar, self, n.id, out);
                out.push_str(",\"moduleReference\":");
                write_sval_json(ar, self, n.module_reference, out);
                out.push('}');
            }
            TN_TSENUM => {
                let n = self.0.borrow().ts_enum_decls[idx as usize];
                out.push_str("{\"type\":\"TSEnumDeclaration\",\"id\":");
                write_sval_json(ar, self, n.id, out);
                out.push_str(",\"members\":");
                write_list_range(ar, self, n.members.0, n.members.1, out);
                out.push('}');
            }
            TN_TYPE => {
                let n = self.0.borrow().types[idx as usize];
                out.push_str("{\"type\":\"Type\",\"children\":");
                write_list_range(ar, self, n.children.0, n.children.1, out);
                out.push_str(",\"headText\":");
                write_lean_json(ar, self, n.head_text, out);
                out.push_str(",\"off\":");
                out.push_str(&n.off.to_string());
                out.push_str(",\"end\":");
                out.push_str(&n.end.to_string());
                out.push('}');
            }
            TN_FORHEAD => {
                let n = self.0.borrow().for_heads[idx as usize];
                out.push_str("{\"type\":\"ForHead\",\"kind\":");
                write_lean_json(ar, self, n.kind, out);
                if let Some(v) = n.init {
                    out.push_str(",\"init\":");
                    write_sval_json(ar, self, v, out);
                }
                if let Some(v) = n.test {
                    out.push_str(",\"test\":");
                    write_sval_json(ar, self, v, out);
                }
                if let Some(v) = n.update {
                    out.push_str(",\"update\":");
                    write_sval_json(ar, self, v, out);
                }
                if let Some(v) = n.left {
                    out.push_str(",\"left\":");
                    write_sval_json(ar, self, v, out);
                }
                if let Some(v) = n.right {
                    out.push_str(",\"right\":");
                    write_sval_json(ar, self, v, out);
                }
                if let Some(a) = n.await_ {
                    out.push_str(",\"await\":");
                    out.push_str(if a { "true" } else { "false" });
                }
                out.push('}');
            }
            TN_DECLARATION => {
                let n = self.0.borrow().declarations[idx as usize];
                out.push_str("{\"type\":\"Declaration\",\"alt\":");
                out.push_str(&n.alt.to_string());
                out.push_str(",\"children\":");
                write_sval_json(ar, self, n.children, out);
                out.push('}');
            }
            TN_TAGGEDTPL => {
                let n = self.0.borrow().tagged_templates[idx as usize];
                out.push_str("{\"type\":\"TaggedTemplateExpression\",\"tag\":");
                write_lean_json(ar, self, n.tag, out);
                out.push_str(",\"quasi\":");
                write_child_ref(ar, self, n.quasi, out);
                out.push('}');
            }
            TN_ARRAYPAT => {
                let n = self.0.borrow().array_patterns[idx as usize];
                out.push_str("{\"type\":\"ArrayPattern\",\"elements\":");
                write_list_range(ar, self, n.elements.0, n.elements.1, out);
                out.push('}');
            }
            TN_TSCALLSIG => {
                let n = self.0.borrow().ts_call_sigs[idx as usize];
                out.push_str(if n.construct { "{\"type\":\"TSConstructSignatureDeclaration\"" } else { "{\"type\":\"TSCallSignatureDeclaration\"" });
                out.push_str(",\"typeParameters\":");
                write_child_ref(ar, self, n.type_parameters, out);
                out.push_str(",\"params\":");
                write_list_range(ar, self, n.params.0, n.params.1, out);
                out.push_str(",\"returnType\":");
                write_child_ref(ar, self, n.return_type, out);
                out.push('}');
            }
            TN_TYPEKEEP => {
                let n = self.0.borrow().type_keeps[idx as usize];
                out.push_str("{\"type\":\"Type\",\"children\":");
                write_list_range(ar, self, n.children.0, n.children.1, out);
                out.push_str(",\"headText\":");
                write_lean_json(ar, self, n.head_text, out);
                out.push('}');
            }
            TN_BLOCKSTMT_SP => {
                let n = self.0.borrow().block_stmt_sps[idx as usize];
                out.push_str("{\"type\":\"BlockStatement\",\"body\":");
                write_list_range(ar, self, n.body.0, n.body.1, out);
                out.push_str(",\"off\":");
                out.push_str(&n.off.to_string());
                out.push_str(",\"end\":");
                out.push_str(&n.end.to_string());
                out.push('}');
            }
            TN_MEMBERNAME => {
                let n = self.0.borrow().member_names[idx as usize];
                out.push_str("{\"type\":\"MemberName\",\"children\":");
                write_list_range(ar, self, n.children.0, n.children.1, out);
                out.push_str(",\"arm\":");
                write_lean_json(ar, self, n.arm, out);
                out.push_str(",\"alt\":");
                out.push_str(&n.alt.to_string());
                out.push('}');
            }
            TN_TSTYPEPARAM => {
                let n = self.0.borrow().ts_type_params[idx as usize];
                out.push_str("{\"type\":\"TSTypeParameter\",\"name\":");
                write_lean_json(ar, self, n.name, out);
                out.push_str(",\"constraint\":");
                write_child_ref(ar, self, n.constraint, out);
                out.push_str(",\"default\":");
                write_child_ref(ar, self, n.default, out);
                out.push_str(",\"off\":");
                out.push_str(&n.off.to_string());
                out.push_str(",\"end\":");
                out.push_str(&n.end.to_string());
                out.push('}');
            }
            TN_TSTPARAMDECL => {
                let n = self.0.borrow().ts_type_param_decls[idx as usize];
                out.push_str("{\"type\":\"TSTypeParameterDeclaration\",\"params\":");
                write_list_range(ar, self, n.params.0, n.params.1, out);
                out.push_str(",\"off\":");
                out.push_str(&n.off.to_string());
                out.push_str(",\"end\":");
                out.push_str(&n.end.to_string());
                out.push('}');
            }
            TN_RAWVAL => {
                let n = self.0.borrow().raw_vals[idx as usize];
                out.push_str("{\"raw\":");
                write_sval_json(ar, self, n.raw, out);
                out.push('}');
            }
            TN_METAOP => {
                let n = self.0.borrow().meta_ops[idx as usize];
                out.push_str("{\"op\":");
                write_sval_json(ar, self, n.op, out);
                out.push('}');
            }
            TN_PARAMIDENT => {
                let n = self.0.borrow().param_idents[idx as usize];
                out.push_str("{\"type\":\"Identifier\",\"name\":");
                write_sval_json(ar, self, n.name, out);
                if n.type_annotation.idx != u32::MAX {
                    out.push_str(",\"typeAnnotation\":");
                    write_child_ref(ar, self, n.type_annotation, out);
                }
                out.push_str(",\"decorators\":");
                write_sval_json(ar, self, n.decorators, out);
                out.push_str(",\"optional\":");
                out.push_str(if n.optional { "true" } else { "false" });
                out.push('}');
            }
            _ => panic!("shape rust: unknown tnode tag {}", tag),
        }
    }
    /// M2 typed fold append — SwitchCase's `consequent` list slot.
    fn tnode_fold_append(&self, ar: &mut AstArena<'a>, tag: u16, idx: u32, into: &'static str, value: SVal<'a>) {
        match tag {
            TN_SWITCHCASE => {
                if into != "consequent" { panic!("shape: tnode_fold_append unknown field {}", into); }
                let cur = self.0.borrow().switch_cases[idx as usize].consequent;
                let next = match cur {
                    SVal::List(s, l) => {
                        if (s + l) as usize == ar.lists.len() {
                            ar.lists.push(value);
                            SVal::List(s, l + 1)
                        } else {
                            let start = ar.lists.len() as u32;
                            ar.lists.extend_from_within(s as usize..(s + l) as usize);
                            ar.lists.push(value);
                            SVal::List(start, l + 1)
                        }
                    }
                    _ => {
                        let start = ar.lists.len() as u32;
                        ar.lists.push(value);
                        SVal::List(start, 1)
                    }
                };
                self.0.borrow_mut().switch_cases[idx as usize].consequent = next;
            }
            _ => panic!("shape rust: tnode_fold_append unknown tag {}", tag),
        }
    }
}

// ── M12: per-grammar positional dispatch ─────────────────────────────────────
// The parser calls these 23 methods directly (no AstCustomCtx materialization);
// each forwards positionally to the same free-fn handler the legacy ctx
// dispatch uses — one logic body per custom, two entry points.
impl<'a> GrammarCustoms<'a> for TsEstreeCustoms<'a> {
    #[inline(always)]
    fn estreeStmt<'c>(&self, ar: &'c mut AstArena<'a>, src: &'a str, kids: &'c [SVal<'a>], alt_path: &'c [usize], off: usize, end: usize, left: Option<SVal<'a>>, op_text: Option<&'a str>, state: Option<Vec<(&'static str, AstFoldCounts)>>) -> SVal<'a> {
        estree_stmt(self, ar, src, kids, alt_path, off, end, left, op_text, state)
    }
    #[inline(always)]
    fn estreeDecl<'c>(&self, ar: &'c mut AstArena<'a>, src: &'a str, kids: &'c [SVal<'a>], alt_path: &'c [usize], off: usize, end: usize, left: Option<SVal<'a>>, op_text: Option<&'a str>, state: Option<Vec<(&'static str, AstFoldCounts)>>) -> SVal<'a> {
        estree_decl(self, ar, src, kids, alt_path, off, end, left, op_text, state)
    }
    #[inline(always)]
    fn estreeVariableDeclarator<'c>(&self, ar: &'c mut AstArena<'a>, src: &'a str, kids: &'c [SVal<'a>], alt_path: &'c [usize], off: usize, end: usize, left: Option<SVal<'a>>, op_text: Option<&'a str>, state: Option<Vec<(&'static str, AstFoldCounts)>>) -> SVal<'a> {
        estree_variable_declarator(self, ar, src, kids, alt_path, off, end, left, op_text, state)
    }
    #[inline(always)]
    fn estreeParenOrComma<'c>(&self, ar: &'c mut AstArena<'a>, src: &'a str, kids: &'c [SVal<'a>], alt_path: &'c [usize], off: usize, end: usize, left: Option<SVal<'a>>, op_text: Option<&'a str>, state: Option<Vec<(&'static str, AstFoldCounts)>>) -> SVal<'a> {
        estree_paren_or_comma(self, ar, src, kids, alt_path, off, end, left, op_text, state)
    }
    #[inline(always)]
    fn estreeExprBinary<'c>(&self, ar: &'c mut AstArena<'a>, src: &'a str, kids: &'c [SVal<'a>], alt_path: &'c [usize], off: usize, end: usize, left: Option<SVal<'a>>, op_text: Option<&'a str>, state: Option<Vec<(&'static str, AstFoldCounts)>>) -> SVal<'a> {
        estree_expr_binary(self, ar, src, kids, alt_path, off, end, left, op_text, state)
    }
    #[inline(always)]
    fn estreeExprPrefix<'c>(&self, ar: &'c mut AstArena<'a>, src: &'a str, kids: &'c [SVal<'a>], alt_path: &'c [usize], off: usize, end: usize, left: Option<SVal<'a>>, op_text: Option<&'a str>, state: Option<Vec<(&'static str, AstFoldCounts)>>) -> SVal<'a> {
        estree_expr_prefix(self, ar, src, kids, alt_path, off, end, left, op_text, state)
    }
    #[inline(always)]
    fn estreeExprPostfixTok<'c>(&self, ar: &'c mut AstArena<'a>, src: &'a str, kids: &'c [SVal<'a>], alt_path: &'c [usize], off: usize, end: usize, left: Option<SVal<'a>>, op_text: Option<&'a str>, state: Option<Vec<(&'static str, AstFoldCounts)>>) -> SVal<'a> {
        estree_expr_postfix_tok(self, ar, src, kids, alt_path, off, end, left, op_text, state)
    }
    #[inline(always)]
    fn estreeTemplateLiteral<'c>(&self, ar: &'c mut AstArena<'a>, src: &'a str, kids: &'c [SVal<'a>], alt_path: &'c [usize], off: usize, end: usize, left: Option<SVal<'a>>, op_text: Option<&'a str>, state: Option<Vec<(&'static str, AstFoldCounts)>>) -> SVal<'a> {
        estree_template_literal(self, ar, src, kids, alt_path, off, end, left, op_text, state)
    }
    #[inline(always)]
    fn estreeExprLed<'c>(&self, ar: &'c mut AstArena<'a>, src: &'a str, kids: &'c [SVal<'a>], alt_path: &'c [usize], off: usize, end: usize, left: Option<SVal<'a>>, op_text: Option<&'a str>, state: Option<Vec<(&'static str, AstFoldCounts)>>) -> SVal<'a> {
        estree_expr_led(self, ar, src, kids, alt_path, off, end, left, op_text, state)
    }
    #[inline(always)]
    fn estreeExprNudSeq<'c>(&self, ar: &'c mut AstArena<'a>, src: &'a str, kids: &'c [SVal<'a>], alt_path: &'c [usize], off: usize, end: usize, left: Option<SVal<'a>>, op_text: Option<&'a str>, state: Option<Vec<(&'static str, AstFoldCounts)>>) -> SVal<'a> {
        estree_expr_nud_seq(self, ar, src, kids, alt_path, off, end, left, op_text, state)
    }
    #[inline(always)]
    fn estreeArrow<'c>(&self, ar: &'c mut AstArena<'a>, src: &'a str, kids: &'c [SVal<'a>], alt_path: &'c [usize], off: usize, end: usize, left: Option<SVal<'a>>, op_text: Option<&'a str>, state: Option<Vec<(&'static str, AstFoldCounts)>>) -> SVal<'a> {
        estree_arrow(self, ar, src, kids, alt_path, off, end, left, op_text, state)
    }
    #[inline(always)]
    fn tsTypeLed<'c>(&self, ar: &'c mut AstArena<'a>, src: &'a str, kids: &'c [SVal<'a>], alt_path: &'c [usize], off: usize, end: usize, left: Option<SVal<'a>>, op_text: Option<&'a str>, state: Option<Vec<(&'static str, AstFoldCounts)>>) -> SVal<'a> {
        ts_type_led(self, ar, src, kids, alt_path, off, end, left, op_text, state)
    }
    #[inline(always)]
    fn estreeNewTargetLed<'c>(&self, ar: &'c mut AstArena<'a>, src: &'a str, kids: &'c [SVal<'a>], alt_path: &'c [usize], off: usize, end: usize, left: Option<SVal<'a>>, op_text: Option<&'a str>, state: Option<Vec<(&'static str, AstFoldCounts)>>) -> SVal<'a> {
        estree_new_target_led(self, ar, src, kids, alt_path, off, end, left, op_text, state)
    }
    #[inline(always)]
    fn estreeArrayPattern<'c>(&self, ar: &'c mut AstArena<'a>, src: &'a str, kids: &'c [SVal<'a>], alt_path: &'c [usize], off: usize, end: usize, left: Option<SVal<'a>>, op_text: Option<&'a str>, state: Option<Vec<(&'static str, AstFoldCounts)>>) -> SVal<'a> {
        estree_array_pattern(self, ar, src, kids, alt_path, off, end, left, op_text, state)
    }
    #[inline(always)]
    fn estreeBindingProperty<'c>(&self, ar: &'c mut AstArena<'a>, src: &'a str, kids: &'c [SVal<'a>], alt_path: &'c [usize], off: usize, end: usize, left: Option<SVal<'a>>, op_text: Option<&'a str>, state: Option<Vec<(&'static str, AstFoldCounts)>>) -> SVal<'a> {
        estree_binding_property(self, ar, src, kids, alt_path, off, end, left, op_text, state)
    }
    #[inline(always)]
    fn estreeParam<'c>(&self, ar: &'c mut AstArena<'a>, src: &'a str, kids: &'c [SVal<'a>], alt_path: &'c [usize], off: usize, end: usize, left: Option<SVal<'a>>, op_text: Option<&'a str>, state: Option<Vec<(&'static str, AstFoldCounts)>>) -> SVal<'a> {
        estree_param(self, ar, src, kids, alt_path, off, end, left, op_text, state)
    }
    #[inline(always)]
    fn estreeForHead<'c>(&self, ar: &'c mut AstArena<'a>, src: &'a str, kids: &'c [SVal<'a>], alt_path: &'c [usize], off: usize, end: usize, left: Option<SVal<'a>>, op_text: Option<&'a str>, state: Option<Vec<(&'static str, AstFoldCounts)>>) -> SVal<'a> {
        estree_for_head(self, ar, src, kids, alt_path, off, end, left, op_text, state)
    }
    #[inline(always)]
    fn estreeSwitchCase<'c>(&self, ar: &'c mut AstArena<'a>, src: &'a str, kids: &'c [SVal<'a>], alt_path: &'c [usize], off: usize, end: usize, left: Option<SVal<'a>>, op_text: Option<&'a str>, state: Option<Vec<(&'static str, AstFoldCounts)>>) -> SVal<'a> {
        estree_switch_case(self, ar, src, kids, alt_path, off, end, left, op_text, state)
    }
    #[inline(always)]
    fn estreeDecorator<'c>(&self, ar: &'c mut AstArena<'a>, src: &'a str, kids: &'c [SVal<'a>], alt_path: &'c [usize], off: usize, end: usize, left: Option<SVal<'a>>, op_text: Option<&'a str>, state: Option<Vec<(&'static str, AstFoldCounts)>>) -> SVal<'a> {
        estree_decorator(self, ar, src, kids, alt_path, off, end, left, op_text, state)
    }
    #[inline(always)]
    fn estreeClassMember<'c>(&self, ar: &'c mut AstArena<'a>, src: &'a str, kids: &'c [SVal<'a>], alt_path: &'c [usize], off: usize, end: usize, left: Option<SVal<'a>>, op_text: Option<&'a str>, state: Option<Vec<(&'static str, AstFoldCounts)>>) -> SVal<'a> {
        estree_class_member(self, ar, src, kids, alt_path, off, end, left, op_text, state)
    }
    #[inline(always)]
    fn tsInterfaceMember<'c>(&self, ar: &'c mut AstArena<'a>, src: &'a str, kids: &'c [SVal<'a>], alt_path: &'c [usize], off: usize, end: usize, left: Option<SVal<'a>>, op_text: Option<&'a str>, state: Option<Vec<(&'static str, AstFoldCounts)>>) -> SVal<'a> {
        ts_interface_member(self, ar, src, kids, alt_path, off, end, left, op_text, state)
    }
    #[inline(always)]
    fn tsTypeMember<'c>(&self, ar: &'c mut AstArena<'a>, src: &'a str, kids: &'c [SVal<'a>], alt_path: &'c [usize], off: usize, end: usize, left: Option<SVal<'a>>, op_text: Option<&'a str>, state: Option<Vec<(&'static str, AstFoldCounts)>>) -> SVal<'a> {
        ts_type_member(self, ar, src, kids, alt_path, off, end, left, op_text, state)
    }
    #[inline(always)]
    fn estreeProp<'c>(&self, ar: &'c mut AstArena<'a>, src: &'a str, kids: &'c [SVal<'a>], alt_path: &'c [usize], off: usize, end: usize, left: Option<SVal<'a>>, op_text: Option<&'a str>, state: Option<Vec<(&'static str, AstFoldCounts)>>) -> SVal<'a> {
        estree_prop(self, ar, src, kids, alt_path, off, end, left, op_text, state)
    }
}
