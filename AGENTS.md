# Repository Guidelines

## Project Structure & Module Organization
- Root config: `deno.json`, `deno.lock`, `tsconfig.json`. Workspace includes `packages/rolldown-plugin-use-client` and `packages/rolldown-plugin-tailwindcss`.
- Source: `packages/*/src/**`. Plugin code lives in `packages/rolldown-plugin-use-client/src/rolldown/`.
- Tests: colocated under `packages/*/src/**`, run with Deno.
- Scripts/config: plugin docs in `README.md`; registry helpers in `src/rolldown/inline-client-registry.ts`.

## Build, Test, and Development Commands
- Run all tests: `deno test --config deno.json -A`.
- Focused tests for the use-client plugin:  
  `deno test --config deno.json -A packages/rolldown-plugin-use-client/src/rolldown/inline-client-rolldown.test.ts`
- Lint (repo default): `deno lint` (inherits config from `deno.json` in each package).
- Example consumer build (from downstream app): `pnpm run build` or `rolldown -c rolldown.config.ts` (uses the plugin).

## Coding Style & Naming Conventions
- Language: TypeScript/TSX; prefer ESM imports. SWC parse target is ES2024; output assets use `.js`.
- Indentation: 2 spaces; keep lines concise; favor named exports for utilities.
- Filenames: kebab- or snake-case; inline client chunks use pattern `<basename>.<hash>.client.js`.
- Add brief comments only for non-obvious logic; avoid restating code.

## Testing Guidelines
- Framework: Deno test runner. Keep tests short and specific; add regressions before fixes.
- Name tests by behavior (“sequential inline handlers keep separators intact”).
- When touching the use-client plugin, add cases that mirror real rolldown usage and validate emitted chunk code (registry + output).

## Commit & Pull Request Guidelines
- Commits: concise, present-tense summaries (e.g., “Fix SWC span offset handling”).
- PRs: describe behavior changes, note added/updated tests, and mention any build impact. Include reproduction steps for regressions and before/after CLI output when relevant.

## Agent-Specific Tips
- Respect the existing workspace: prefer `deno` commands; avoid global installs. Do not remove user changes.
- When debugging spans or emitted code, use local helpers/console logging and keep added logs temporary.
