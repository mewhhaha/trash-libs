# @mewhhaha/rolldown-plugin-tailwindcss

Rolldown plugin that compiles CSS files containing `@import "tailwindcss"` with
Tailwind CSS v4 and optionally runs Tailwind's optimizer across the final CSS
output. It is useful when you want Tailwind's file scanning and generated
utility output to happen inside a Rolldown build without a separate CSS step.

## Installation

```bash
pnpm add -D @mewhhaha/rolldown-plugin-tailwindcss rolldown @rolldown/pluginutils tailwindcss @tailwindcss/node @tailwindcss/oxide
```

The package ships TypeScript sources compiled to ESM. The Rolldown and
Tailwind-related dependencies above are peer-style runtime requirements in the
consuming project.

## Quick start

```ts
// rolldown.config.ts
import { defineConfig } from "rolldown";
import tailwindcss from "@mewhhaha/rolldown-plugin-tailwindcss";

export default defineConfig({
  input: "./src/main.ts",
  plugins: [
    tailwindcss(),
  ],
});
```

Then import a CSS file that includes Tailwind:

```css
@import "tailwindcss";
```

During the build the plugin will:

1. Detect CSS modules that import `tailwindcss`.
2. Compile them with `@tailwindcss/node`.
3. Track discovered CSS dependencies as Rolldown watch files.
4. Optionally optimize and minify the final CSS.

## Options

```ts
type TailwindPluginOptions = {
  root?: string;
  minify?: boolean;
  optimize?: boolean;
  filter?: TopLevelFilterExpression | TopLevelFilterExpression[];
};
```

- `root` sets the project root used for content scanning and relative CSS
  resolution. It defaults to the current working directory.
- `minify` controls whether optimized CSS is minified. It defaults to `true`.
- `optimize` controls whether Tailwind's optimizer runs at all. It defaults to
  `true`.
- `filter` appends additional `@rolldown/pluginutils` filters to the default
  CSS-only transform filter.

## Notes

- The plugin only transforms `.css` files.
- CSS files without `@import "tailwindcss"` are still optimized when
  `optimize: true`.
- Virtual ids and CSS files under `node_modules/` are skipped by default.
