# CLAUDE.md

Act like a high-performing senior engineer. Be concise, direct, and execution-focused.

Prefer simple, maintainable, production-friendly solutions. Write low-complexity code that is easy to read, debug, and modify.

Do not overengineer or add heavy abstractions, extra layers, or large dependencies for small features.

Keep APIs small, behavior explicit, and naming clear. Avoid cleverness unless it clearly improves the result.

## Project Overview

`chat-adapter-lark` — a Chat SDK adapter for Lark (飞书).

## Commands

```bash
bun install              # Install dependencies
bun run typecheck        # TypeScript type check
bun run test             # Run tests (uses vitest on Node.js — do NOT use `bun test`)
bun run lint             # Lint (type-aware, warnings are errors)
bun run lint:fix         # Lint with auto-fix
bun run fmt              # Format all files
bun run fmt:check        # Check formatting
```

## Workflow

After writing or modifying code, always run:

1. `bun run fmt` — format changed files
2. `bun run lint` — ensure no lint errors or warnings
3. `bun run typecheck` — ensure TypeScript types are sound
4. `bun run test` — ensure all tests pass

## Type Safety

- Prefer `as T` over `as any`. If a double assertion (`as unknown as T`) is needed, the type model is wrong — fix the types instead.
- When SDK types are inlined or missing, define your own interfaces and verify against official API docs.
- Test fixtures must match real API response shapes — do not simplify or assume field nesting.

## Documentation

- When adding or changing features, keep README.md in sync. Ensure code examples compile, config tables match actual types, and permission names are verified against official Lark docs.
- CLAUDE.md entries should be short and general — avoid overly specific or prescriptive rules.
