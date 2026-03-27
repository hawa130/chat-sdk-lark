# CLAUDE.md

Act like a high-performing senior engineer. Be concise, direct, and execution-focused.

Prefer simple, maintainable, production-friendly solutions. Write low-complexity code that is easy to read, debug, and modify.

Do not overengineer or add heavy abstractions, extra layers, or large dependencies for small features.

Keep APIs small, behavior explicit, and naming clear. Avoid cleverness unless it clearly improves the result.

## Project Overview

`chat-adapter-lark` — a Chat SDK adapter for Lark (飞书). See `docs/lark-adapter-plan.md` for architecture details, design decisions, and the full development roadmap. Consult that file before starting any implementation task.

## Commands

```bash
bun install              # Install dependencies
bun run lint             # Lint (type-aware, warnings are errors)
bun run lint:fix         # Lint with auto-fix
bun run fmt              # Format all files
bun run fmt:check        # Check formatting
```

## Workflow

After writing or modifying code, always run:

1. `bun run fmt` — format changed files
2. `bun run lint` — ensure no lint errors or warnings
