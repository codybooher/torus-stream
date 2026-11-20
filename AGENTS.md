# Agent Guidelines

This repository runs TypeScript directly on Node.js (`>=22.18`) via type stripping, with no build step and no runtime dependencies.

## TypeScript & Runtime Rules
- Use **erasable TypeScript syntax only** (`erasableSyntaxOnly: true` in `tsconfig.json`): no `enum`, `namespace`, or constructor parameter properties.
- Always include `.ts` extensions on relative imports (e.g. `import { ... } from './rules.ts';`).
- Use `import type` / `export type` for type-only imports and exports (`verbatimModuleSyntax: true`).
- Write strict, well-typed code (`strict: true`).

## Public API & Constraints
- Keep all exports and function signatures in `src/index.ts` compatible with the existing types in `src/types.ts`.
- Never mutate caller-supplied input arrays or `Reading` objects.
- Keep zero runtime dependencies unless explicitly justified in `NOTES.md`.

## Testing & Git Hygiene
- Run `npm test` after changes; every `test/**/*.test.ts` file is picked up automatically by `node --test`.
- Make small, focused commits with clear messages explaining the intent of each change.
- Update `NOTES.md` with architectural decisions, trade-offs, and assumptions as work progresses.
