// JavaScriptReact (`.jsx`) — JavaScript + JSX.
//
// The JSX counterpart of typescriptreact.ts, applied to the JavaScript base instead
// of TypeScript: javascriptreact reuses javascript.ts's rules verbatim and adds the
// same JSX layer (examples/jsx.ts). Because the JS base has no `Type` rule, the JSX
// tag's generic type-arguments (`<List<string>>`, TS-only) are omitted automatically.
// Scope name `source.js.jsx` matches VS Code's official JavaScriptReact grammar.
import javascript from './javascript.ts';
import { withJsx } from './jsx.ts';

export default withJsx(javascript, { name: 'javascriptreact', scopeName: 'source.js.jsx' });
