# @mewhhaha/rolldown-plugin-use-client

Rolldown plugin that lifts inline `"use client"` handlers into standalone client
bundles. It emits one client chunk per handler, rewrites the server module to
reference the generated file URL, and prunes any imports that are now
client-only. Use it when you need to keep server modules lean while still
shipping small, on-demand client scripts.

## Installation

```bash
pnpm add -D @mewhhaha/rolldown-plugin-use-client rolldown @rolldown/pluginutils typescript
```

The package ships TypeScript sources compiled to ESM. All dependencies listed
above are peer dependencies and must exist in the consuming project.

## Quick start

Add the plugin to your `rolldown` config. The default filter covers common JS/TS
entrypoints while skipping `node_modules`, so most projects can start with the
zero-config setup below.

```ts
// rolldown.config.ts
import { defineConfig } from "rolldown";
import useClient from "@mewhhaha/rolldown-plugin-use-client";

export default defineConfig({
  plugins: [
    useClient(),
  ],
});
```

### What the transform does

Given a server component that embeds a client handler:

```ts
const LoginForm = () => {
  const handleSubmit = (event) => {
    "use client";
    event.preventDefault();
    queueMicrotask(() => {
      window.alert("Submitted!");
    });
  };

  return <form on={handleSubmit}>...</form>;
};
```

The plugin will:

1. Hoist the handler into its own module that starts with `"use client";`.
2. Copy any imports and top-level declarations the handler uses into that
   module.
3. Emit the module as a chunk with `moduleSideEffects === false`.
4. Replace the inline function with
   `new URL(import.meta.ROLLUP_FILE_URL_<ref>).pathname`, giving you the final
   asset path at runtime.

You can stash that path, send it down to the client, or map it to a
`<script type="module">` tag—whatever your application framework expects.

## Options

```ts
type UseClientPluginOptions = {
  /**
   * Extra @rolldown/pluginutils filter expressions
   * appended to the default include/exclude set.
   */
  filter?: TopLevelFilterExpression | TopLevelFilterExpression[];
  /**
   * Enable debug logging or supply a custom logger.
   */
  debug?: boolean | ((message: string) => void);
  /**
   * How to handle references that cannot be bundled into the client chunk.
   */
  unresolved?: "error" | "warn" | "ignore";
};
```

- `filter` &mdash; Additional filter expressions that refine which source files
  are scanned. The defaults include `**/*.js`, `**/*.jsx`, `**/*.ts`, and
  `**/*.tsx`, while excluding anything under `node_modules/`. Supply one or more
  expressions from `@rolldown/pluginutils` to widen or narrow the search.
- `debug` &mdash; Enable debug logging or provide a custom logger callback.
- `unresolved` &mdash; How to handle references that cannot be bundled into the
  client chunk (`ignore` by default).

## ESLint support

This package also exposes linting helpers under
`@mewhhaha/rolldown-plugin-use-client/eslint-plugin`. Register the plugin and
select the rules you want:

```js
// eslint.config.js
import useclient from "@mewhhaha/rolldown-plugin-use-client/eslint-plugin";

export default [
  useclient.configs.recommended,
];
```

Available rules:

- `no-invalid-inline-client-closure` &mdash; Ensures inline handlers do not
  capture variables that disappear from the generated client bundle (e.g.,
  component props or local state).
- `require-use-client-directive` &mdash; Requires handlers passed to the `on`
  JSX attribute to start with a `"use client"` directive so they qualify for
  extraction.

## Tips and limitations

- Only block-bodied arrow or function expressions with a literal `"use client"`
  as their first statement qualify for extraction.
- Inline handlers may only reference globals, imports, or top-level
  declarations; anything else is ignored by default (see `unresolved`).
- Side-effect-only imports (e.g. `import "./reset.css"`) are not allowed in
  files that contain inline handlers.
- The replacement uses `new URL(import.meta.ROLLUP_FILE_URL_ref).pathname`. If
  you need the full `href` (or another format), wrap the helper
  yourself—`new URL(import.meta.ROLLUP_FILE_URL_ref, import.meta.url).href`
  mirrors Rollup's recommended pattern.
- Client chunk hashes derive from the source file contents and handler position,
  so any edit to the file invalidates the emitted asset.
- Client modules are stored in an in-memory registry during the build. Restart
  the build or trigger a fresh incremental run if you edit inline handlers and
  the output looks stale.
