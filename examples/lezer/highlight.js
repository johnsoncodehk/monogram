import { styleTags, tags as t } from "@lezer/highlight";

// Contextual definition-name positions (give these their own node names):
//   after "class" → name node should be styled t.typeName (entity.name.type)
//   after "interface" → name node should be styled t.typeName (entity.name.type)
//   after "type" → name node should be styled t.typeName (entity.name.type)
//   after "enum" → name node should be styled t.typeName (entity.name.type)
//   after "namespace" → name node should be styled t.typeName (entity.name.type)

export const highlighting = styleTags({
  "Shebang": t.lineComment,
  "JSDoc": t.docComment,
  "TripleSlash": t.lineComment,
  "LineComment": t.lineComment,
  "BlockComment": t.blockComment,
  "HexNumber": t.number,
  "OctalNumber": t.number,
  "BinaryNumber": t.number,
  "BigInt": t.number,
  "Number": t.number,
  "String": t.string,
  "Template": t.special(t.string),
  "Regex": t.regexp,
  "Decorator": t.meta,
  "PrivateField": t.propertyName,
  "Ident": t.variableName,
  "kw_as/kw_asserts/kw_delete/kw_infer/kw_instanceof/kw_is/kw_keyof/kw_new/kw_satisfies/kw_typeof/kw_void": t.operatorKeyword,
  "kw_abstract/kw_accessor/kw_async/kw_declare/kw_override/kw_private/kw_protected/kw_public/kw_readonly/kw_static": t.modifier,
  "kw_extends/kw_implements/kw_meta/kw_out/kw_unique": t.keyword,
  "kw_false/kw_true": t.bool,
  "kw_null/kw_undefined": t.null,
  "kw_super/kw_this": t.special(t.variableName),
  "kw_any/kw_bigint/kw_boolean/kw_never/kw_number/kw_object/kw_string/kw_symbol/kw_unknown": t.standard(t.typeName),
  "kw_export/kw_from/kw_import": t.moduleKeyword,
  "kw_await/kw_break/kw_case/kw_catch/kw_continue/kw_debugger/kw_default/kw_do/kw_else/kw_finally/kw_for/kw_if/kw_in/kw_of/kw_return/kw_switch/kw_throw/kw_try/kw_while/kw_with/kw_yield": t.controlKeyword,
  "kw_class/kw_const/kw_constructor/kw_enum/kw_function/kw_get/kw_interface/kw_let/kw_module/kw_namespace/kw_set/kw_type/kw_using/kw_var": t.definitionKeyword,
  "kw_Array/kw_Date/kw_Error/kw_Function/kw_Map/kw_Object/kw_Promise/kw_RegExp/kw_Set/kw_Symbol/kw_WeakMap/kw_WeakSet": t.standard(t.className),
  "kw_console/kw_document/kw_exports/kw_global/kw_globalThis/kw_process/kw_require/kw_window": t.standard(t.variableName),
  "Comma": t.separator,
  "BracketL/BracketR": t.squareBracket,
  "Op_26/Op_3c3c/Op_3e3e/Op_3e3e3e/Op_5e/Op_7c": t.bitwiseOperator,
  "ParenL/ParenR": t.paren,
  "Arrow": t.function(t.punctuation),
  "BraceL/BraceR": t.brace,
  "Semi": t.punctuation,
  "Op_25/Op_2a/Op_2a2a/Op_2b/Op_2d/Op_2f": t.arithmeticOperator,
  "QuestionDot": t.derefOperator,
  "Op_21/Op_2626/Op_3f3f/Op_7c7c/Op_7e": t.logicOperator,
  "Op_253d/Op_26263d/Op_263d/Op_2a2a3d/Op_2a3d/Op_2b3d/Op_2d3d/Op_2f3d/Op_3c3c3d/Op_3d/Op_3e3e3d/Op_3e3e3e3d/Op_3f3f3d/Op_5e3d/Op_7c3d/Op_7c7c3d": t.definitionOperator,
  "Op_213d/Op_213d3d/Op_3d3d/Op_3d3d3d": t.compareOperator,
  "Op_2b2b/Op_2d2d": t.operator,
});
