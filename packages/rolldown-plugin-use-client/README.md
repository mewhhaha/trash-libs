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

Current `@mewhhaha/ruwuter` uses `client.scope()` plus `scope.mount(...)` /
`scope.unmount(...)` for client behavior. Inline `"use client"` functions fit
that shape directly:

```ts
import { Client, client, on } from "@mewhhaha/ruwuter/components";

export default function LoginForm() {
  const scope = client.scope();
  const form = scope.ref("form", null as HTMLFormElement | null);
  const status = scope.ref("status", "idle");

  scope.mount(function (_event: Event, signal: AbortSignal) {
    "use client";
    on(this.form).submit((event) => {
      event.preventDefault();
      this.status.set("submitted");
      window.alert("Submitted!");
    }, { signal });
  });

  return (
    <html>
      <body>
        <form ref={form}>
          <button type="submit">Sign in</button>
        </form>
        <p>{status}</p>
        <Client />
      </body>
    </html>
  );
}
```

The plugin will:

1. Hoist the inline mount handler into its own module that starts with
   `"use client";`.
2. Copy any imports and top-level declarations the handler uses into that
   module.
3. Emit the module as a chunk with `moduleSideEffects === false`.
4. Replace the inline function with
   `new URL(import.meta.ROLLUP_FILE_URL_<ref>, import.meta.url).pathname`,
   giving `scope.mount(...)` the final client module URL at runtime.

That matches the latest `ruwuter` runtime contract: `client.scope()` is the
primary interaction API, `scope.mount(...)` / `scope.unmount(...)` expect
client-module URLs, and legacy `on={...}` event props are no longer the main
integration path.

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
  /**
   * Enable strict behavior for transform-time safety checks.
   */
  strict?: boolean;
};
```

- `filter` &mdash; Additional filter expressions that refine which source files
  are scanned. The defaults include `**/*.js`, `**/*.jsx`, `**/*.ts`, and
  `**/*.tsx`, while excluding anything under `node_modules/`. Supply one or more
  expressions from `@rolldown/pluginutils` to widen or narrow the search.
- `debug` &mdash; Enable debug logging or provide a custom logger callback.
- `unresolved` &mdash; How to handle references that cannot be bundled into the
  client chunk (`warn` by default, `error` in strict mode unless overridden).
- `strict` &mdash; Turns parse failures and unresolved references into hard
  errors by default.

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
  extraction. This mainly helps legacy JSX event-prop patterns; current
  `ruwuter` code typically wires behavior through `client.scope()`.

## Tips and limitations

- Only block-bodied arrow functions, function expressions, and function
  declarations with a literal `"use client"` as their first statement qualify
  for extraction.
- Inline handlers may only reference globals, imports, or top-level
  declarations; anything else warns by default (see `unresolved`).
- Inline arrow handlers cannot use `arguments` after extraction. The plugin
  warns by default (or errors when `unresolved: "error"`).
- For current `@mewhhaha/ruwuter`, prefer `scope.mount(function (...) { "use client"; ... })`
  or `scope.unmount(function (...) { "use client"; ... })`. Use a `function`
  when you need the scope bind object as `this`; arrow functions do not get the
  runtime `this` binding.
- Extracted handlers are rewritten to URL string bindings. Calling those
  bindings as functions is invalid and rejected at build time.
- Side-effect-only imports (e.g. `import "./reset.css"`) are not allowed in
  files that contain inline handlers.
- The replacement uses
  `new URL(import.meta.ROLLUP_FILE_URL_ref, import.meta.url).pathname`. If you
  need the full `href` (or another format), wrap the helper yourself.
- Client chunk hashes derive from source file path, file contents, and handler
  position, so edits or moving the file invalidate the emitted asset.
- Client modules are stored in an in-memory registry during the build. Restart
  the build or trigger a fresh incremental run if you edit inline handlers and
  the output looks stale.
