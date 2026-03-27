# chat-adapter-lark Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a production-ready Chat SDK adapter for Lark (飞书), enabling Chat SDK bots to send/receive messages, stream responses, handle reactions, and render cards on the Lark platform.

**Architecture:** Thin wrapper around `@larksuiteoapi/node-sdk` for all Lark API communication and event handling. The adapter bridges Lark SDK's `EventDispatcher` + `Client` to Chat SDK's `Adapter` interface. Format conversion handles Lark's JSON-based message types ↔ Chat SDK's mdast AST. Streaming uses the standard editMessage-throttle fallback pattern.

**Tech Stack:** TypeScript, Bun (runtime), vitest (testing), `@larksuiteoapi/node-sdk` (Lark API), `chat` + `@chat-adapter/shared` (Chat SDK), `tsup` (build), `msw` (HTTP mocking), `oxlint` + `oxfmt` (lint + format)

**Reference:** See `docs/lark-adapter-plan.md` for architecture decisions, API mapping table, and full spec.

**Pre-requisite:** Task 0 (Knowledge Preparation) from the spec has been completed — Chat SDK adapter contract, reference adapter patterns, and Lark API mapping are understood.

---

## File Structure

```
src/
  index.ts              -- public re-exports
  types.ts              -- LarkThreadId, LarkAdapterConfig, type aliases
  adapter.ts            -- LarkAdapter implements Adapter<LarkThreadId, LarkRawMessage>
  factory.ts            -- createLarkAdapter() with env var fallback
  api-client.ts         -- LarkApiClient: thin wrapper around lark.Client
  event-bridge.ts       -- bridgeWebhook(): Request → EventDispatcher.invoke()
  format-converter.ts   -- LarkFormatConverter: toAst / fromAst / renderForSend
  card-mapper.ts        -- cardToLarkInteractive(): Chat SDK Card → Lark card JSON
  dedup-cache.ts        -- LRU event-ID dedup cache (FIFO eviction)
tests/
  dedup-cache.test.ts
  api-client.test.ts
  event-bridge.test.ts
  format-converter.test.ts
  card-mapper.test.ts
  adapter.test.ts
  factory.test.ts
  integration.test.ts
  fixtures.ts           -- shared test data (event payloads, messages)
  setup.ts              -- msw server setup
.github/
  workflows/
    ci.yml              -- lint → typecheck → test → build pipeline
```

---

### Task 1: Project Skeleton & Dependencies

**Files:**

- Modify: `package.json`
- Create: `tsup.config.ts`
- Create: `vitest.config.ts`
- Create: `src/index.ts`
- Modify: `tsconfig.json`
- Delete: `index.ts` (root placeholder)
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1.1: Update package.json with dependencies and build scripts**

Add runtime deps, peer deps, dev deps, build/test scripts, and `files` field:

```json
{
  "name": "chat-adapter-lark",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "module": "dist/index.js",
  "types": "dist/index.d.ts",
  "files": ["dist"],
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  },
  "keywords": ["chat-sdk", "chat-adapter", "lark", "feishu"],
  "scripts": {
    "build": "tsup",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage",
    "lint": "oxlint --type-aware --deny-warnings",
    "lint:fix": "oxlint --type-aware --fix",
    "fmt": "oxfmt --write .",
    "fmt:check": "oxfmt --check ."
  },
  "peerDependencies": {
    "chat": "^4.0.0"
  },
  "dependencies": {
    "@chat-adapter/shared": "^4.0.0",
    "@larksuiteoapi/node-sdk": "^1.60.0"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "@types/mdast": "^4.0.0",
    "@vitest/coverage-v8": "^3.1.0",
    "chat": "^4.0.0",
    "msw": "^2.7.0",
    "oxfmt": "^0.42.0",
    "oxlint": "^1.57.0",
    "oxlint-tsgolint": "^0.17.4",
    "tsup": "^8.4.0",
    "typescript": "^5",
    "vitest": "^3.1.0"
  }
}
```

- [ ] **Step 1.2: Create tsup.config.ts**

```typescript
import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
})
```

- [ ] **Step 1.3: Create vitest.config.ts**

```typescript
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/**'],
    },
  },
})
```

- [ ] **Step 1.4: Update tsconfig.json**

```json
{
  "compilerOptions": {
    "lib": ["ESNext"],
    "target": "ES2022",
    "module": "Preserve",
    "moduleDetection": "force",
    "jsx": "react-jsx",
    "jsxImportSource": "chat",
    "allowJs": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "noEmit": true,
    "strict": true,
    "skipLibCheck": true,
    "noFallthroughCasesInSwitch": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noUnusedLocals": false,
    "noUnusedParameters": false,
    "noPropertyAccessFromIndexSignature": false
  },
  "include": ["src/**/*", "tests/**/*"]
}
```

- [ ] **Step 1.5: Create src/index.ts placeholder**

```typescript
// Public API — populated as modules are implemented
export {}
```

- [ ] **Step 1.6: Delete root index.ts placeholder**

Remove the root `index.ts` (currently `console.log('Hello via Bun!')`).

- [ ] **Step 1.7: Create .github/workflows/ci.yml**

```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install
      - run: bun run lint
      - run: bun run typecheck
      - run: bun run test
      - run: bun run build
```

- [ ] **Step 1.8: Install dependencies and verify**

Run: `bun install`
Then: `bun run build && bun run typecheck`
Expected: `dist/index.js` + `dist/index.d.ts` created; typecheck zero errors.

- [ ] **Step 1.9: Investigate Chat SDK exports**

Before proceeding, discover what `chat` and `@chat-adapter/shared` export. Run:

```bash
# Check available exports from both packages
node -e "import('chat').then(m => console.log(Object.keys(m)))"
node -e "import('@chat-adapter/shared').then(m => console.log(Object.keys(m)))"
```

Record: which error classes exist (`AdapterRateLimitError`, `AuthenticationError`, `ResourceNotFoundError`, `NetworkError`), which AST utilities exist (`parseMarkdown`, `stringifyMarkdown`), and the `Adapter` interface shape. Adjust subsequent task code to use real imports.

- [ ] **Step 1.10: Commit**

```bash
git add package.json bun.lock tsup.config.ts vitest.config.ts tsconfig.json src/index.ts .github/workflows/ci.yml
git rm -f index.ts
git commit -m "chore: set up project skeleton with build, test, lint, and CI"
```

---

### Task 2: Types

**Files:**

- Create: `src/types.ts`
- Modify: `src/index.ts`

- [ ] **Step 2.1: Define LarkThreadId and LarkAdapterConfig**

```typescript
// src/types.ts
import type * as lark from '@larksuiteoapi/node-sdk'

/** Thread identifier for Lark — encodes a chat and optional root message (for thread replies). */
export interface LarkThreadId {
  chatId: string
  rootMessageId?: string
}

export interface LarkAdapterConfig {
  /** Lark app ID (or env LARK_APP_ID) */
  appId: string
  /** Lark app secret (or env LARK_APP_SECRET) */
  appSecret: string
  /** Encrypt key for event decryption (or env LARK_ENCRYPT_KEY) */
  encryptKey?: string
  /** Verification token for v1 events (or env LARK_VERIFICATION_TOKEN) */
  verificationToken?: string
  /** API domain — lark.Domain.Feishu (default) or lark.Domain.Lark */
  domain?: lark.Domain | string
  /** Bot display name (defaults to name from bot info API) */
  userName?: string
  /** Disable SDK's internal token cache */
  disableTokenCache?: boolean
}
```

- [ ] **Step 2.2: Define LarkRawMessage**

```typescript
// src/types.ts (append)

/** Raw event data from im.message.receive_v1, as delivered by the SDK's EventDispatcher. */
export interface LarkRawMessage {
  event_id?: string
  sender: {
    sender_id?: {
      union_id?: string
      user_id?: string
      open_id?: string
    }
    sender_type: string
    tenant_key?: string
  }
  message: {
    message_id: string
    root_id?: string
    parent_id?: string
    create_time: string
    update_time?: string
    chat_id: string
    thread_id?: string
    chat_type: string
    message_type: string
    content: string
    mentions?: Array<{
      key: string
      id: { union_id?: string; user_id?: string; open_id?: string }
      name: string
      tenant_key?: string
    }>
  }
}
```

- [ ] **Step 2.3: Export types from index.ts**

```typescript
// src/index.ts
export type { LarkThreadId, LarkAdapterConfig, LarkRawMessage } from './types.ts'
```

- [ ] **Step 2.4: Typecheck**

Run: `bun run typecheck`
Expected: Zero errors.

- [ ] **Step 2.5: Commit**

```bash
git add src/types.ts src/index.ts
git commit -m "feat: define LarkThreadId, LarkAdapterConfig, and LarkRawMessage types"
```

---

### Task 3: Dedup Cache

**Files:**

- Create: `src/dedup-cache.ts`
- Create: `tests/dedup-cache.test.ts`

- [ ] **Step 3.1: Write failing tests**

```typescript
// tests/dedup-cache.test.ts
import { describe, it, expect } from 'vitest'
import { DedupCache } from '../src/dedup-cache.ts'

describe('DedupCache', () => {
  it('returns false for unseen keys', () => {
    const cache = new DedupCache(100)
    expect(cache.has('event-1')).toBe(false)
  })

  it('returns true after adding a key', () => {
    const cache = new DedupCache(100)
    cache.add('event-1')
    expect(cache.has('event-1')).toBe(true)
  })

  it('evicts oldest entry when capacity is exceeded', () => {
    const cache = new DedupCache(3)
    cache.add('a')
    cache.add('b')
    cache.add('c')
    cache.add('d') // evicts "a"
    expect(cache.has('a')).toBe(false)
    expect(cache.has('b')).toBe(true)
    expect(cache.has('d')).toBe(true)
  })

  it('is idempotent — adding the same key twice does not consume capacity', () => {
    const cache = new DedupCache(2)
    cache.add('a')
    cache.add('a')
    cache.add('b')
    expect(cache.has('a')).toBe(true)
    expect(cache.has('b')).toBe(true)
  })

  it('clear removes all entries', () => {
    const cache = new DedupCache(100)
    cache.add('x')
    cache.add('y')
    cache.clear()
    expect(cache.has('x')).toBe(false)
    expect(cache.has('y')).toBe(false)
  })
})
```

- [ ] **Step 3.2: Run tests to verify failure**

Run: `bun run test tests/dedup-cache.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3.3: Implement DedupCache**

```typescript
// src/dedup-cache.ts

/** FIFO dedup cache with fixed capacity. Used to deduplicate Lark event re-deliveries. */
export class DedupCache {
  private readonly capacity: number
  private readonly set = new Set<string>()
  private readonly queue: string[] = []

  constructor(capacity: number) {
    this.capacity = capacity
  }

  has(key: string): boolean {
    return this.set.has(key)
  }

  add(key: string): void {
    if (this.set.has(key)) return
    if (this.queue.length >= this.capacity) {
      const evicted = this.queue.shift()!
      this.set.delete(evicted)
    }
    this.set.add(key)
    this.queue.push(key)
  }

  clear(): void {
    this.set.clear()
    this.queue.length = 0
  }
}
```

- [ ] **Step 3.4: Run tests to verify pass**

Run: `bun run test tests/dedup-cache.test.ts`
Expected: All 5 tests PASS.

- [ ] **Step 3.5: Lint and format**

Run: `bun run fmt && bun run lint`

- [ ] **Step 3.6: Commit**

```bash
git add src/dedup-cache.ts tests/dedup-cache.test.ts
git commit -m "feat: add FIFO dedup cache for event deduplication"
```

---

### Task 4: API Client

**Files:**

- Create: `src/api-client.ts`
- Create: `tests/api-client.test.ts`
- Create: `tests/setup.ts`

> Thin wrapper around `lark.Client`. Maps SDK errors to `@chat-adapter/shared` error classes.

- [ ] **Step 4.1: Create msw test setup**

```typescript
// tests/setup.ts
import { setupServer } from 'msw/node'

export const server = setupServer()
```

- [ ] **Step 4.2: Write failing tests — core methods (send, reply, update, delete)**

```typescript
// tests/api-client.test.ts
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from './setup.ts'
import { LarkApiClient } from '../src/api-client.ts'

const BASE_URL = 'https://open.feishu.cn'

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'bypass' })
  server.use(
    http.post(`${BASE_URL}/open-apis/auth/v3/tenant_access_token/internal`, () =>
      HttpResponse.json({
        code: 0,
        tenant_access_token: 'test-token',
        expire: 7200,
      }),
    ),
  )
})
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

function createClient() {
  return new LarkApiClient({
    appId: 'test-app-id',
    appSecret: 'test-app-secret',
  })
}

describe('LarkApiClient', () => {
  describe('sendMessage', () => {
    it('sends a text message with correct params', async () => {
      let capturedBody: unknown
      server.use(
        http.post(`${BASE_URL}/open-apis/im/v1/messages`, async ({ request }) => {
          capturedBody = await request.json()
          return HttpResponse.json({
            code: 0,
            data: { message_id: 'msg-001' },
          })
        }),
      )

      const client = createClient()
      const result = await client.sendMessage('chat-123', 'text', '{"text":"hello"}')

      expect(capturedBody).toMatchObject({
        receive_id: 'chat-123',
        msg_type: 'text',
        content: '{"text":"hello"}',
      })
      expect(result.message_id).toBe('msg-001')
    })
  })

  describe('replyMessage', () => {
    it('replies to the correct message', async () => {
      server.use(
        http.post(`${BASE_URL}/open-apis/im/v1/messages/:messageId/reply`, () =>
          HttpResponse.json({ code: 0, data: { message_id: 'msg-002' } }),
        ),
      )

      const client = createClient()
      const result = await client.replyMessage('msg-001', 'text', '{"text":"reply"}')
      expect(result.message_id).toBe('msg-002')
    })
  })

  describe('updateMessage', () => {
    it('patches the message content', async () => {
      server.use(
        http.patch(`${BASE_URL}/open-apis/im/v1/messages/:id`, () =>
          HttpResponse.json({ code: 0, data: {} }),
        ),
      )
      const client = createClient()
      await expect(
        client.updateMessage('msg-1', 'text', '{"text":"edited"}'),
      ).resolves.toBeDefined()
    })
  })

  describe('deleteMessage', () => {
    it('deletes the message', async () => {
      server.use(
        http.delete(`${BASE_URL}/open-apis/im/v1/messages/:id`, () =>
          HttpResponse.json({ code: 0 }),
        ),
      )
      const client = createClient()
      await expect(client.deleteMessage('msg-1')).resolves.toBeDefined()
    })
  })
})
```

- [ ] **Step 4.3: Run tests to verify failure**

Run: `bun run test tests/api-client.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4.4: Implement LarkApiClient — core methods + error mapping**

```typescript
// src/api-client.ts
import * as lark from '@larksuiteoapi/node-sdk'
import type { LarkAdapterConfig } from './types.ts'

// Import error classes from @chat-adapter/shared.
// NOTE: If these imports fail, check Step 1.9 output and adjust import paths.
// Fallback: use plain Error with .name override if classes don't exist.
// import { AdapterRateLimitError, AuthenticationError, ResourceNotFoundError, NetworkError } from "@chat-adapter/shared";

export class LarkApiClient {
  readonly client: lark.Client

  constructor(
    config: Pick<LarkAdapterConfig, 'appId' | 'appSecret' | 'domain' | 'disableTokenCache'>,
  ) {
    this.client = new lark.Client({
      appId: config.appId,
      appSecret: config.appSecret,
      domain: config.domain ?? lark.Domain.Feishu,
      appType: lark.AppType.SelfBuild,
      disableTokenCache: config.disableTokenCache,
    })
  }

  async sendMessage(chatId: string, msgType: string, content: string) {
    return this.call(() =>
      this.client.im.message.create({
        data: { receive_id: chatId, msg_type: msgType as any, content },
        params: { receive_id_type: 'chat_id' },
      }),
    )
  }

  async replyMessage(messageId: string, msgType: string, content: string) {
    return this.call(() =>
      this.client.im.message.reply({
        data: { content, msg_type: msgType as any },
        path: { message_id: messageId },
      }),
    )
  }

  async updateMessage(messageId: string, _msgType: string, content: string) {
    return this.call(() =>
      this.client.im.message.patch({
        data: { content },
        path: { message_id: messageId },
      }),
    )
  }

  async deleteMessage(messageId: string) {
    return this.call(() => this.client.im.message.delete({ path: { message_id: messageId } }))
  }

  /** Unified error mapping — wraps all SDK calls. */
  private async call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (error: any) {
      throw this.mapError(error)
    }
  }

  private mapError(error: any): Error {
    const status = error?.response?.status ?? error?.httpCode ?? error?.status
    const code = error?.code ?? error?.response?.data?.code

    if (status === 429) {
      return Object.assign(new Error('Rate limit exceeded'), {
        name: 'AdapterRateLimitError',
      })
    }
    if (status === 401 || status === 403 || code === 99991671 || code === 99991663) {
      return Object.assign(new Error('Authentication failed'), {
        name: 'AuthenticationError',
      })
    }
    if (status === 404) {
      return Object.assign(new Error('Resource not found'), {
        name: 'ResourceNotFoundError',
      })
    }
    if (code === 99991) {
      return Object.assign(new Error('Network error'), {
        name: 'NetworkError',
      })
    }
    return error instanceof Error ? error : new Error(String(error))
  }
}
```

> **Important:** After `bun install` succeeds, check the actual exports from `@chat-adapter/shared`. If error classes like `AdapterRateLimitError` exist, replace `Object.assign(new Error(...), { name: ... })` with proper class instantiation. The tests check `.message` pattern, so both approaches work.

- [ ] **Step 4.5: Run tests to verify pass**

Run: `bun run test tests/api-client.test.ts`
Expected: PASS. If msw can't intercept the Lark SDK's internal axios calls, provide a custom `httpInstance` to `lark.Client`.

- [ ] **Step 4.6: Write failing tests — query methods (get, list, reactions, bot info)**

```typescript
// tests/api-client.test.ts (append inside describe block)

describe('getMessage', () => {
  it('fetches a single message', async () => {
    server.use(
      http.get(`${BASE_URL}/open-apis/im/v1/messages/:id`, () =>
        HttpResponse.json({
          code: 0,
          data: { message_id: 'msg-1', content: '{"text":"hi"}' },
        }),
      ),
    )
    const client = createClient()
    const result = await client.getMessage('msg-1')
    expect(result).toBeDefined()
  })
})

describe('listMessages', () => {
  it('lists messages in a chat with pagination', async () => {
    server.use(
      http.get(`${BASE_URL}/open-apis/im/v1/messages`, () =>
        HttpResponse.json({
          code: 0,
          data: { items: [], has_more: false },
        }),
      ),
    )
    const client = createClient()
    const result = await client.listMessages('chat-1')
    expect(result).toBeDefined()
  })
})

describe('getBotInfo', () => {
  it('returns bot open_id', async () => {
    server.use(
      http.get(`${BASE_URL}/open-apis/bot/v3/info`, () =>
        HttpResponse.json({
          code: 0,
          bot: { open_id: 'ou_bot123', app_name: 'TestBot' },
        }),
      ),
    )
    const client = createClient()
    const info = await client.getBotInfo()
    expect(info.bot?.open_id).toBe('ou_bot123')
  })
})

describe('error mapping', () => {
  it('maps 429 to rate limit error', async () => {
    server.use(
      http.post(
        `${BASE_URL}/open-apis/im/v1/messages`,
        () => new HttpResponse(null, { status: 429 }),
      ),
    )
    const client = createClient()
    await expect(client.sendMessage('chat-1', 'text', '{}')).rejects.toThrow(/rate.limit/i)
  })
})
```

- [ ] **Step 4.7: Implement query methods + utility methods**

Append to the `LarkApiClient` class:

```typescript
  // --- Query methods ---

  async getMessage(messageId: string) {
    return this.call(() =>
      this.client.im.message.get({ path: { message_id: messageId } })
    );
  }

  async listMessages(chatId: string, pageToken?: string, pageSize?: number) {
    return this.call(() =>
      this.client.im.message.list({
        params: {
          container_id_type: "chat",
          container_id: chatId,
          page_size: pageSize ?? 20,
          page_token: pageToken,
        },
      })
    );
  }

  async addReaction(messageId: string, emojiType: string) {
    return this.call(() =>
      this.client.im.messageReaction.create({
        data: { reaction_type: { emoji_type: emojiType } },
        path: { message_id: messageId },
      })
    );
  }

  async removeReaction(messageId: string, reactionId: string) {
    return this.call(() =>
      this.client.im.messageReaction.delete({
        path: { message_id: messageId, reaction_id: reactionId },
      })
    );
  }

  async listReactions(messageId: string) {
    return this.call(() =>
      this.client.im.messageReaction.list({ path: { message_id: messageId } })
    );
  }

  // --- Chat methods ---

  async getChatInfo(chatId: string) {
    return this.call(() =>
      this.client.im.chat.get({ path: { chat_id: chatId } })
    );
  }

  async createP2PChat(userId: string) {
    return this.call(() =>
      this.client.im.chat.create({
        data: { chat_mode: "p2p", user_id_list: [userId] },
        params: { user_id_type: "open_id" },
      })
    );
  }

  // --- File upload ---

  async uploadImage(image: Buffer | ReadableStream) {
    return this.call(() =>
      this.client.im.image.create({
        data: { image_type: "message", image: image as any },
      })
    );
  }

  async uploadFile(file: Buffer | ReadableStream, fileName: string, fileType: string) {
    return this.call(() =>
      this.client.im.file.create({
        data: { file_type: fileType as any, file_name: fileName, file: file as any },
      })
    );
  }

  // --- Bot info ---

  async getBotInfo() {
    const res = await this.call(() =>
      this.client.request({ method: "GET", url: "/open-apis/bot/v3/info" })
    );
    return res as { bot?: { open_id?: string; app_name?: string } };
  }

  // --- Ephemeral ---

  async sendEphemeral(chatId: string, userId: string, content: string) {
    return this.call(() =>
      this.client.request({
        method: "POST",
        url: "/open-apis/ephemeral/v1/send",
        data: { chat_id: chatId, user_id: userId, msg_type: "interactive", card: content },
      })
    );
  }
```

- [ ] **Step 4.8: Run all api-client tests**

Run: `bun run test tests/api-client.test.ts`
Expected: All PASS.

- [ ] **Step 4.9: Export from index.ts**

```typescript
// src/index.ts (add)
export { LarkApiClient } from './api-client.ts'
```

- [ ] **Step 4.10: Lint, format, commit**

```bash
bun run fmt && bun run lint
git add src/api-client.ts tests/api-client.test.ts tests/setup.ts src/index.ts
git commit -m "feat: add LarkApiClient with SDK wrapper and error mapping"
```

---

### Task 5: Event Bridge

**Files:**

- Create: `src/event-bridge.ts`
- Create: `tests/event-bridge.test.ts`
- Create: `tests/fixtures.ts`

> Bridges HTTP requests to the Lark SDK's `EventDispatcher.invoke()`, following the `adaptDefault` pattern.

- [ ] **Step 5.1: Create test fixtures**

```typescript
// tests/fixtures.ts

/** A minimal im.message.receive_v1 event payload (v2 schema). */
export function makeMessageEvent(overrides?: Record<string, unknown>) {
  return {
    schema: '2.0',
    header: {
      event_id: 'ev-001',
      event_type: 'im.message.receive_v1',
      create_time: '1700000000000',
      token: 'test-verification-token',
      app_id: 'test-app-id',
      tenant_key: 'test-tenant',
    },
    event: {
      sender: {
        sender_id: { open_id: 'ou_user1', user_id: 'uid1', union_id: 'un1' },
        sender_type: 'user',
        tenant_key: 'test-tenant',
      },
      message: {
        message_id: 'om_msg001',
        root_id: '',
        parent_id: '',
        create_time: '1700000000000',
        chat_id: 'oc_chat001',
        chat_type: 'group',
        message_type: 'text',
        content: '{"text":"@_user_1 hello bot"}',
        mentions: [
          {
            key: '@_user_1',
            id: { open_id: 'ou_bot001' },
            name: 'TestBot',
          },
        ],
      },
    },
    ...overrides,
  }
}

/** A DM message event. */
export function makeDMEvent() {
  return makeMessageEvent({
    event: {
      sender: {
        sender_id: { open_id: 'ou_user1' },
        sender_type: 'user',
      },
      message: {
        message_id: 'om_dm001',
        chat_id: 'oc_dm001',
        chat_type: 'p2p',
        message_type: 'text',
        content: '{"text":"hi bot"}',
        create_time: '1700000000000',
      },
    },
  })
}

/** Reaction created event. */
export function makeReactionEvent(type: 'created' | 'deleted' = 'created') {
  return {
    schema: '2.0',
    header: {
      event_id: `ev-reaction-${type}`,
      event_type: `im.message.reaction.${type}_v1`,
      create_time: '1700000000000',
      token: 'test-verification-token',
      app_id: 'test-app-id',
      tenant_key: 'test-tenant',
    },
    event: {
      message_id: 'om_msg001',
      reaction_type: { emoji_type: 'THUMBSUP' },
      operator_type: 'user',
      user_id: { open_id: 'ou_user1' },
      action_time: '1700000000000',
    },
  }
}

/** URL verification challenge payload. */
export function makeChallengeEvent(challenge = 'test-challenge-value') {
  return {
    challenge,
    token: 'test-verification-token',
    type: 'url_verification',
  }
}

/** Helper: create a Request from a JSON body. */
export function makeRequest(body: unknown): Request {
  return new Request('http://localhost/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}
```

- [ ] **Step 5.2: Write failing tests for bridgeWebhook**

```typescript
// tests/event-bridge.test.ts
import { describe, it, expect, vi } from 'vitest'
import * as lark from '@larksuiteoapi/node-sdk'
import { bridgeWebhook } from '../src/event-bridge.ts'
import { makeMessageEvent, makeChallengeEvent, makeRequest } from './fixtures.ts'

function createDispatcher() {
  return new lark.EventDispatcher({})
}

describe('bridgeWebhook', () => {
  it('forwards a message event to the registered handler', async () => {
    const dispatcher = createDispatcher()
    const handler = vi.fn()
    dispatcher.register({ 'im.message.receive_v1': handler })

    const req = makeRequest(makeMessageEvent())
    await bridgeWebhook(req, dispatcher)

    expect(handler).toHaveBeenCalledOnce()
  })

  it('handles URL verification challenge', async () => {
    const dispatcher = createDispatcher()
    const req = makeRequest(makeChallengeEvent('abc123'))
    const response = await bridgeWebhook(req, dispatcher)

    expect(response.challenge).toBe('abc123')
  })

  it('throws on invalid JSON body', async () => {
    const dispatcher = createDispatcher()
    const req = new Request('http://localhost/webhook', {
      method: 'POST',
      body: 'not json{{{',
    })
    await expect(bridgeWebhook(req, dispatcher)).rejects.toThrow(/invalid/i)
  })
})
```

- [ ] **Step 5.3: Run tests to verify failure**

Run: `bun run test tests/event-bridge.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 5.4: Implement bridgeWebhook**

```typescript
// src/event-bridge.ts
import type * as lark from '@larksuiteoapi/node-sdk'

/**
 * Bridges a standard Request to the Lark SDK's EventDispatcher.
 * Follows the SDK's adaptDefault pattern: headers on prototype, body data as own properties.
 */
export async function bridgeWebhook(
  request: Request,
  dispatcher: lark.EventDispatcher,
): Promise<any> {
  const body = await request.text()
  let data: Record<string, unknown>
  try {
    data = JSON.parse(body)
  } catch {
    throw new Error('Invalid JSON body')
  }

  const headers: Record<string, string> = {}
  request.headers.forEach((value, key) => {
    headers[key] = value
  })

  const assigned = Object.assign(Object.create({ headers }), data)
  return dispatcher.invoke(assigned)
}
```

- [ ] **Step 5.5: Run tests to verify pass**

Run: `bun run test tests/event-bridge.test.ts`
Expected: PASS.

- [ ] **Step 5.6: Lint, format, commit**

```bash
bun run fmt && bun run lint
git add src/event-bridge.ts tests/event-bridge.test.ts tests/fixtures.ts
git commit -m "feat: add event bridge for SDK dispatcher integration"
```

---

### Task 6: Format Converter & Card Mapper

**Files:**

- Create: `src/format-converter.ts`
- Create: `src/card-mapper.ts`
- Create: `tests/format-converter.test.ts`
- Create: `tests/card-mapper.test.ts`

- [ ] **Step 6.1: Write failing tests for toAst**

```typescript
// tests/format-converter.test.ts
import { describe, it, expect } from 'vitest'
import { LarkFormatConverter } from '../src/format-converter.ts'

const converter = new LarkFormatConverter()

/** Helper: extract plain text from mdast tree. */
function astToPlainText(node: any): string {
  if (node.type === 'text') return node.value ?? ''
  if (node.children) return node.children.map(astToPlainText).join('')
  return node.value ?? ''
}

describe('LarkFormatConverter', () => {
  describe('toAst', () => {
    it('parses a text message JSON', () => {
      const ast = converter.toAst('{"text":"hello world"}')
      expect(ast.type).toBe('root')
      expect(astToPlainText(ast)).toContain('hello world')
    })

    it('handles plain string (non-JSON) as text', () => {
      const ast = converter.toAst('just plain text')
      expect(astToPlainText(ast)).toContain('just plain text')
    })

    it('parses post rich text', () => {
      const post = {
        post: {
          zh_cn: {
            title: 'Post Title',
            content: [
              [
                { tag: 'text', text: 'Hello ' },
                { tag: 'a', text: 'link', href: 'https://example.com' },
              ],
            ],
          },
        },
      }
      const ast = converter.toAst(JSON.stringify(post))
      expect(ast.type).toBe('root')
      const text = astToPlainText(ast)
      expect(text).toContain('Post Title')
      expect(text).toContain('Hello ')
      expect(text).toContain('link')
    })

    it('handles @mention in post content', () => {
      const post = {
        post: {
          zh_cn: {
            title: '',
            content: [[{ tag: 'at', text: 'John' }]],
          },
        },
      }
      const ast = converter.toAst(JSON.stringify(post))
      expect(astToPlainText(ast)).toContain('@John')
    })
  })

  describe('fromAst', () => {
    it('converts AST back to markdown string', () => {
      const ast = converter.toAst('{"text":"**bold** text"}')
      const markdown = converter.fromAst(ast)
      expect(typeof markdown).toBe('string')
      expect(markdown.length).toBeGreaterThan(0)
    })
  })

  describe('renderForSend', () => {
    it('renders plain text as Lark text message', () => {
      const result = converter.renderForSend({ text: 'hello' })
      expect(result.msgType).toBe('text')
      const parsed = JSON.parse(result.content)
      expect(parsed.text).toBe('hello')
    })

    it('renders a card as interactive message', () => {
      const result = converter.renderForSend({ card: { elements: [] } })
      expect(result.msgType).toBe('interactive')
    })
  })
})
```

- [ ] **Step 6.2: Run tests to verify failure**

Run: `bun run test tests/format-converter.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 6.3: Implement LarkFormatConverter**

```typescript
// src/format-converter.ts
import type { Root, RootContent, PhrasingContent } from 'mdast'

// NOTE: If `@chat-adapter/shared` or `chat` export `parseMarkdown` / `stringifyMarkdown`,
// use those instead of the manual AST construction below. Check Step 1.9 output.

/**
 * Converts between Lark message formats and Chat SDK's mdast AST.
 * Handles text, post (rich text), interactive (card), and plain string fallback.
 */
export class LarkFormatConverter {
  toAst(platformText: string): Root {
    let parsed: any
    try {
      parsed = JSON.parse(platformText)
    } catch {
      return this.textToAst(platformText)
    }

    if (typeof parsed.text === 'string') {
      return this.textToAst(parsed.text)
    }

    if (parsed.post) {
      const lang = parsed.post.zh_cn ?? parsed.post.en_us ?? Object.values(parsed.post)[0]
      if (lang?.content) {
        return this.postToAst(lang.title, lang.content)
      }
    }

    if (parsed.elements || parsed.config) {
      return this.interactiveToAst(parsed)
    }

    return this.textToAst(platformText)
  }

  fromAst(ast: Root): string {
    return this.astToMarkdown(ast)
  }

  renderForSend(message: { text?: string; card?: unknown }): {
    msgType: string
    content: string
  } {
    if (message.card) {
      return {
        msgType: 'interactive',
        content: typeof message.card === 'string' ? message.card : JSON.stringify(message.card),
      }
    }
    return {
      msgType: 'text',
      content: JSON.stringify({ text: message.text ?? '' }),
    }
  }

  /** Replace @mention placeholders with readable names. */
  replaceMentions(text: string, mentions: Array<{ key: string; name: string }>): string {
    let result = text
    for (const mention of mentions) {
      result = result.replace(mention.key, `@${mention.name}`)
    }
    return result
  }

  // --- Private ---

  private textToAst(text: string): Root {
    return {
      type: 'root',
      children: [{ type: 'paragraph', children: [{ type: 'text', value: text }] }],
    }
  }

  private postToAst(
    title: string | undefined,
    content: Array<Array<{ tag: string; text?: string; href?: string }>>,
  ): Root {
    const children: RootContent[] = []

    if (title) {
      children.push({
        type: 'heading',
        depth: 3,
        children: [{ type: 'text', value: title }],
      })
    }

    for (const line of content) {
      const inlineChildren: PhrasingContent[] = []
      for (const elem of line) {
        switch (elem.tag) {
          case 'text':
            inlineChildren.push({ type: 'text', value: elem.text ?? '' })
            break
          case 'a':
            inlineChildren.push({
              type: 'link',
              url: elem.href ?? '',
              children: [{ type: 'text', value: elem.text ?? '' }],
            })
            break
          case 'at':
            inlineChildren.push({
              type: 'text',
              value: `@${elem.text ?? 'user'}`,
            })
            break
          default:
            if (elem.text) {
              inlineChildren.push({ type: 'text', value: elem.text })
            }
        }
      }
      if (inlineChildren.length > 0) {
        children.push({ type: 'paragraph', children: inlineChildren })
      }
    }

    return { type: 'root', children }
  }

  private interactiveToAst(card: any): Root {
    const texts: string[] = []
    const elements = card.elements ?? card.body?.elements ?? []
    for (const el of elements) {
      if (el.tag === 'markdown' && el.content) {
        texts.push(el.content)
      } else if (el.tag === 'div' && el.text?.content) {
        texts.push(el.text.content)
      }
    }
    return this.textToAst(texts.join('\n\n') || '[card]')
  }

  private astToMarkdown(node: any): string {
    if (node.type === 'text') return node.value ?? ''
    if (node.type === 'strong') return `**${this.childrenToMd(node)}**`
    if (node.type === 'emphasis') return `*${this.childrenToMd(node)}*`
    if (node.type === 'inlineCode') return `\`${node.value}\``
    if (node.type === 'code') return `\`\`\`${node.lang ?? ''}\n${node.value}\n\`\`\``
    if (node.type === 'link') return `[${this.childrenToMd(node)}](${node.url})`
    if (node.type === 'heading') return `${'#'.repeat(node.depth ?? 1)} ${this.childrenToMd(node)}`
    if (node.type === 'paragraph') return this.childrenToMd(node)
    if (node.type === 'root')
      return node.children?.map((c: any) => this.astToMarkdown(c)).join('\n\n') ?? ''
    if (node.children) return this.childrenToMd(node)
    return node.value ?? ''
  }

  private childrenToMd(node: any): string {
    return node.children?.map((c: any) => this.astToMarkdown(c)).join('') ?? ''
  }
}
```

- [ ] **Step 6.4: Run format-converter tests**

Run: `bun run test tests/format-converter.test.ts`
Expected: PASS.

- [ ] **Step 6.5: Write failing tests for card mapper**

```typescript
// tests/card-mapper.test.ts
import { describe, it, expect } from 'vitest'
import { cardToLarkInteractive, cardToFallbackText } from '../src/card-mapper.ts'

describe('cardToLarkInteractive', () => {
  it('maps a card with text to markdown element', () => {
    const card = {
      type: 'card',
      title: 'Test Card',
      children: [{ type: 'text', content: 'Hello from card' }],
    }
    const result = cardToLarkInteractive(card)
    expect(result.header?.title.content).toBe('Test Card')
    expect(result.elements.length).toBeGreaterThan(0)
    expect(result.elements[0].tag).toBe('markdown')
  })

  it('maps a divider to hr', () => {
    const card = {
      type: 'card',
      children: [{ type: 'divider' }],
    }
    const result = cardToLarkInteractive(card)
    expect(result.elements).toContainEqual({ tag: 'hr' })
  })

  it('maps buttons in actions container', () => {
    const card = {
      type: 'card',
      children: [
        {
          type: 'actions',
          children: [{ type: 'button', label: 'Click me', id: 'btn-1', style: 'primary' }],
        },
      ],
    }
    const result = cardToLarkInteractive(card)
    const action = result.elements.find((e: any) => e.tag === 'action')
    expect(action).toBeDefined()
    expect(action.actions[0].tag).toBe('button')
  })

  it('maps image element', () => {
    const card = {
      type: 'card',
      children: [{ type: 'image', url: 'img_key_123', alt: 'photo' }],
    }
    const result = cardToLarkInteractive(card)
    expect(result.elements[0].tag).toBe('img')
  })

  it('degrades unsupported components to markdown', () => {
    const card = {
      type: 'card',
      children: [{ type: 'custom-widget', content: 'fallback text' }],
    }
    const result = cardToLarkInteractive(card)
    expect(result.elements[0].tag).toBe('markdown')
    expect(result.elements[0].content).toBe('fallback text')
  })
})

describe('cardToFallbackText', () => {
  it('extracts title and text from card', () => {
    const card = {
      type: 'card',
      title: 'Alert',
      children: [{ type: 'text', content: 'Something happened' }],
    }
    const text = cardToFallbackText(card)
    expect(text).toContain('Alert')
    expect(text).toContain('Something happened')
  })
})
```

- [ ] **Step 6.6: Run to verify failure**

Run: `bun run test tests/card-mapper.test.ts`
Expected: FAIL.

- [ ] **Step 6.7: Implement card mapper**

```typescript
// src/card-mapper.ts

/** Maps Chat SDK Card tree to Lark interactive card JSON. */
export function cardToLarkInteractive(card: any): {
  elements: any[]
  header?: { title: { tag: string; content: string } }
} {
  const elements: any[] = []
  const header = card.title ? { title: { tag: 'plain_text', content: card.title } } : undefined

  for (const child of card.children ?? []) {
    const mapped = mapElement(child)
    if (mapped) elements.push(mapped)
  }

  return { ...(header ? { header } : {}), elements }
}

function mapElement(el: any): any {
  switch (el.type) {
    case 'text':
      return { tag: 'markdown', content: el.content ?? '' }
    case 'divider':
      return { tag: 'hr' }
    case 'image':
      return {
        tag: 'img',
        img_key: el.url ?? '',
        alt: { tag: 'plain_text', content: el.alt ?? '' },
      }
    case 'button':
      return {
        tag: 'button',
        text: { tag: 'plain_text', content: el.label ?? '' },
        type: el.style ?? 'default',
        value: { id: el.id ?? '', value: el.value ?? '' },
      }
    case 'actions':
      return {
        tag: 'action',
        actions: (el.children ?? []).map(mapElement).filter(Boolean),
      }
    case 'section':
      return { tag: 'markdown', content: extractTextContent(el) }
    case 'fields': {
      const fields = (el.children ?? []).map((f: any) => ({
        is_short: true,
        text: {
          tag: 'markdown',
          content: `**${f.label ?? ''}**\n${f.value ?? ''}`,
        },
      }))
      return { tag: 'column_set', columns: fields }
    }
    default:
      // Unsupported — degrade to markdown if content exists
      if (el.content || el.label || el.text) {
        return {
          tag: 'markdown',
          content: el.content ?? el.label ?? el.text ?? '',
        }
      }
      return null
  }
}

/** Extract all text content from a component tree for fallback. */
export function cardToFallbackText(card: any): string {
  const parts: string[] = []
  if (card.title) parts.push(card.title)
  for (const child of card.children ?? []) {
    collectText(child, parts)
  }
  return parts.join('\n')
}

function collectText(el: any, parts: string[]): void {
  if (el.content) parts.push(el.content)
  if (el.label) parts.push(el.label)
  if (el.text && typeof el.text === 'string') parts.push(el.text)
  for (const child of el.children ?? []) {
    collectText(child, parts)
  }
}

function extractTextContent(el: any): string {
  const parts: string[] = []
  collectText(el, parts)
  return parts.join('\n')
}
```

- [ ] **Step 6.8: Run card-mapper tests**

Run: `bun run test tests/card-mapper.test.ts`
Expected: PASS.

- [ ] **Step 6.9: Export from index.ts, lint, format, commit**

```typescript
// src/index.ts (add)
export { LarkFormatConverter } from './format-converter.ts'
export { cardToLarkInteractive, cardToFallbackText } from './card-mapper.ts'
```

```bash
bun run fmt && bun run lint
git add src/format-converter.ts src/card-mapper.ts tests/format-converter.test.ts tests/card-mapper.test.ts src/index.ts
git commit -m "feat: add format converter and card mapper for Lark messages"
```

---

### Task 7: Main Adapter Class

**Files:**

- Create: `src/adapter.ts`
- Create: `tests/adapter.test.ts`

> The core adapter class. Assembles all prior modules. **Split into sub-steps with TDD discipline: test before implementation for each feature group.**

#### 7A: Skeleton + Thread ID

- [ ] **Step 7A.1: Write failing tests — thread ID encode/decode**

```typescript
// tests/adapter.test.ts
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from './setup.ts'
import { LarkAdapter } from '../src/adapter.ts'
import type { LarkAdapterConfig } from '../src/types.ts'

const BASE_URL = 'https://open.feishu.cn'

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'bypass' })
  server.use(
    http.post(`${BASE_URL}/open-apis/auth/v3/tenant_access_token/internal`, () =>
      HttpResponse.json({ code: 0, tenant_access_token: 't-token', expire: 7200 }),
    ),
    http.get(`${BASE_URL}/open-apis/bot/v3/info`, () =>
      HttpResponse.json({ code: 0, bot: { open_id: 'ou_bot001', app_name: 'TestBot' } }),
    ),
  )
})
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

const config: LarkAdapterConfig = {
  appId: 'test-app-id',
  appSecret: 'test-secret',
}

describe('LarkAdapter', () => {
  describe('thread ID encoding', () => {
    it('roundtrips a chatId-only thread', () => {
      const adapter = new LarkAdapter(config)
      const encoded = adapter.encodeThreadId({ chatId: 'oc_abc123' })
      expect(encoded).toMatch(/^lark:/)
      const decoded = adapter.decodeThreadId(encoded)
      expect(decoded.chatId).toBe('oc_abc123')
      expect(decoded.rootMessageId).toBeUndefined()
    })

    it('roundtrips chatId + rootMessageId', () => {
      const adapter = new LarkAdapter(config)
      const encoded = adapter.encodeThreadId({
        chatId: 'oc_abc',
        rootMessageId: 'om_root1',
      })
      const decoded = adapter.decodeThreadId(encoded)
      expect(decoded.chatId).toBe('oc_abc')
      expect(decoded.rootMessageId).toBe('om_root1')
    })

    it('throws on invalid prefix', () => {
      const adapter = new LarkAdapter(config)
      expect(() => adapter.decodeThreadId('slack:abc')).toThrow()
    })

    it('handles special characters in chatId', () => {
      const adapter = new LarkAdapter(config)
      const encoded = adapter.encodeThreadId({ chatId: 'oc_test!@#$' })
      const decoded = adapter.decodeThreadId(encoded)
      expect(decoded.chatId).toBe('oc_test!@#$')
    })

    it('throws on missing segments', () => {
      const adapter = new LarkAdapter(config)
      expect(() => adapter.decodeThreadId('lark')).toThrow()
    })
  })
})
```

- [ ] **Step 7A.2: Run to verify failure**

Run: `bun run test tests/adapter.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 7A.3: Implement adapter skeleton + thread ID + lifecycle**

```typescript
// src/adapter.ts
import * as lark from '@larksuiteoapi/node-sdk'
import type { LarkAdapterConfig, LarkThreadId, LarkRawMessage } from './types.ts'
import { LarkApiClient } from './api-client.ts'
import { LarkFormatConverter } from './format-converter.ts'
import { DedupCache } from './dedup-cache.ts'
import { bridgeWebhook } from './event-bridge.ts'
import { cardToLarkInteractive } from './card-mapper.ts'

const DEDUP_CACHE_SIZE = 1000
const STREAM_THROTTLE_MS = 400

export class LarkAdapter {
  readonly name = 'lark'
  userName: string

  private readonly config: LarkAdapterConfig
  readonly apiClient: LarkApiClient
  private readonly converter = new LarkFormatConverter()
  private readonly dedupCache = new DedupCache(DEDUP_CACHE_SIZE)
  private readonly eventDispatcher: lark.EventDispatcher
  private readonly dmCache = new Map<string, boolean>()
  private chat: any
  private botOpenId = ''

  constructor(config: LarkAdapterConfig) {
    this.config = config
    this.userName = config.userName ?? 'Lark Bot'
    this.apiClient = new LarkApiClient(config)
    this.eventDispatcher = new lark.EventDispatcher({
      encryptKey: config.encryptKey,
      verificationToken: config.verificationToken,
    })
    this.registerEventHandlers()
  }

  // --- Thread ID ---

  encodeThreadId(data: LarkThreadId): string {
    const chatPart = toBase64Url(data.chatId)
    if (data.rootMessageId) {
      return `lark:${chatPart}:${toBase64Url(data.rootMessageId)}`
    }
    return `lark:${chatPart}`
  }

  decodeThreadId(threadId: string): LarkThreadId {
    const parts = threadId.split(':')
    if (parts[0] !== 'lark' || parts.length < 2 || !parts[1]) {
      throw new Error(`Invalid Lark thread ID: ${threadId}`)
    }
    const chatId = fromBase64Url(parts[1])
    const rootMessageId = parts[2] ? fromBase64Url(parts[2]) : undefined
    return { chatId, rootMessageId }
  }

  channelIdFromThreadId(threadId: string): string {
    return this.decodeThreadId(threadId).chatId
  }

  // --- Lifecycle ---

  async initialize(chat: any): Promise<void> {
    this.chat = chat
    try {
      const info = await this.apiClient.getBotInfo()
      this.botOpenId = info.bot?.open_id ?? ''
      if (!this.config.userName && info.bot?.app_name) {
        this.userName = info.bot.app_name
      }
    } catch {
      // Non-fatal
    }
  }

  async disconnect(): Promise<void> {
    this.dedupCache.clear()
    this.dmCache.clear()
  }

  // Placeholder methods — implemented in subsequent steps
  async handleWebhook(_request: Request): Promise<Response> {
    return new Response('Not implemented', { status: 501 })
  }

  // --- Event handler registration ---

  private registerEventHandlers(): void {
    // Filled in Step 7C
  }
}

// --- Base64url helpers ---

function toBase64Url(str: string): string {
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(str: string): string {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/')
  return atob(padded)
}
```

- [ ] **Step 7A.4: Run thread ID tests**

Run: `bun run test tests/adapter.test.ts`
Expected: All 5 thread ID tests PASS.

- [ ] **Step 7A.5: Commit**

```bash
git add src/adapter.ts tests/adapter.test.ts
git commit -m "feat: add LarkAdapter skeleton with thread ID encoding"
```

#### 7B: Webhook Handling

- [ ] **Step 7B.1: Write failing tests — webhook handling**

```typescript
// tests/adapter.test.ts (append to describe block)
import { makeMessageEvent, makeChallengeEvent, makeRequest } from './fixtures.ts'

describe('handleWebhook', () => {
  it('responds to URL verification challenge', async () => {
    const adapter = new LarkAdapter(config)
    const req = makeRequest(makeChallengeEvent('test-challenge'))
    const res = await adapter.handleWebhook(req)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.challenge).toBe('test-challenge')
  })

  it('returns 400 for invalid JSON', async () => {
    const adapter = new LarkAdapter(config)
    const req = new Request('http://localhost/webhook', {
      method: 'POST',
      body: 'not json{{{',
    })
    const res = await adapter.handleWebhook(req)
    expect(res.status).toBe(400)
  })

  it('deduplicates events with same event_id', async () => {
    const adapter = new LarkAdapter(config)
    const event = makeMessageEvent()
    const res1 = await adapter.handleWebhook(makeRequest(event))
    const res2 = await adapter.handleWebhook(makeRequest(event))
    expect(res1.status).toBe(200)
    expect(res2.status).toBe(200)
  })

  it('returns 200 for valid message events', async () => {
    const adapter = new LarkAdapter(config)
    const req = makeRequest(makeMessageEvent())
    const res = await adapter.handleWebhook(req)
    expect(res.status).toBe(200)
  })
})
```

- [ ] **Step 7B.2: Implement handleWebhook**

Replace the placeholder `handleWebhook` in `src/adapter.ts`:

```typescript
  async handleWebhook(request: Request): Promise<Response> {
    try {
      const cloned = request.clone();
      const body = await cloned.text();

      let parsed: any;
      try {
        parsed = JSON.parse(body);
      } catch {
        return new Response("Bad Request", { status: 400 });
      }

      // Challenge handling
      if (parsed.type === "url_verification" || parsed.challenge) {
        const result = await bridgeWebhook(request, this.eventDispatcher);
        return Response.json(result ?? { challenge: parsed.challenge });
      }

      // Event deduplication
      const eventId =
        parsed.header?.event_id ?? parsed.event_id ?? parsed.uuid;
      if (eventId) {
        if (this.dedupCache.has(eventId)) {
          return new Response("OK", { status: 200 });
        }
        this.dedupCache.add(eventId);
      }

      // Async bridge — Lark requires 200 within 3 seconds
      bridgeWebhook(request, this.eventDispatcher).catch(() => {});

      return new Response("OK", { status: 200 });
    } catch {
      return new Response("Internal Server Error", { status: 500 });
    }
  }
```

- [ ] **Step 7B.3: Run webhook tests**

Run: `bun run test tests/adapter.test.ts`
Expected: Webhook tests PASS.

- [ ] **Step 7B.4: Commit**

```bash
git add src/adapter.ts tests/adapter.test.ts
git commit -m "feat: add webhook handling with challenge response and dedup"
```

#### 7C: Event Routing & Message Parsing

- [ ] **Step 7C.1: Write failing tests — message parsing**

```typescript
// tests/adapter.test.ts (append)

describe('parseMessage', () => {
  it('parses a text message', () => {
    const adapter = new LarkAdapter(config)
    const raw: LarkRawMessage = {
      sender: {
        sender_id: { open_id: 'ou_user1' },
        sender_type: 'user',
      },
      message: {
        message_id: 'om_msg001',
        chat_id: 'oc_chat001',
        chat_type: 'group',
        message_type: 'text',
        content: '{"text":"hello"}',
        create_time: '1700000000000',
      },
    }
    const msg = adapter.parseMessage(raw)
    expect(msg.text).toBe('hello')
    expect(msg.id).toBe('om_msg001')
    expect(msg.author.isBot).toBe(false)
  })

  it('replaces @mention placeholders with names', () => {
    const adapter = new LarkAdapter(config)
    const raw: LarkRawMessage = {
      sender: {
        sender_id: { open_id: 'ou_user1' },
        sender_type: 'user',
      },
      message: {
        message_id: 'om_msg002',
        chat_id: 'oc_chat001',
        chat_type: 'group',
        message_type: 'text',
        content: '{"text":"@_user_1 hello"}',
        create_time: '1700000000000',
        mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot001' }, name: 'TestBot' }],
      },
    }
    const msg = adapter.parseMessage(raw)
    expect(msg.text).toContain('@TestBot')
    expect(msg.text).not.toContain('@_user_1')
  })

  it('sets isMention=true for DM messages', () => {
    const adapter = new LarkAdapter(config)
    const raw: LarkRawMessage = {
      sender: {
        sender_id: { open_id: 'ou_user1' },
        sender_type: 'user',
      },
      message: {
        message_id: 'om_msg003',
        chat_id: 'oc_dm001',
        chat_type: 'p2p',
        message_type: 'text',
        content: '{"text":"hi"}',
        create_time: '1700000000000',
      },
    }
    const msg = adapter.parseMessage(raw)
    expect(msg.isMention).toBe(true)
  })

  it("detects bot's own messages", async () => {
    const adapter = new LarkAdapter(config)
    // Simulate initialize to set botOpenId
    await adapter.initialize({ processMessage: async () => {} })

    const raw: LarkRawMessage = {
      sender: {
        sender_id: { open_id: 'ou_bot001' },
        sender_type: 'bot',
      },
      message: {
        message_id: 'om_msg004',
        chat_id: 'oc_chat001',
        chat_type: 'group',
        message_type: 'text',
        content: '{"text":"I am bot"}',
        create_time: '1700000000000',
      },
    }
    const msg = adapter.parseMessage(raw)
    expect(msg.author.isBot).toBe(true)
    expect(msg.author.isMe).toBe(true)
  })
})
```

- [ ] **Step 7C.2: Implement parseMessage + event routing**

Add to `src/adapter.ts`:

```typescript
  parseMessage(raw: LarkRawMessage) {
    return this.buildMessage(raw);
  }

  private buildMessage(raw: any) {
    const msg = raw.message ?? raw;
    const sender = raw.sender ?? {};
    const senderOpenId = sender.sender_id?.open_id ?? "";
    const isBot =
      sender.sender_type === "bot" || senderOpenId === this.botOpenId;

    let text = "";
    try {
      const content = JSON.parse(msg.content ?? "{}");
      text = content.text ?? msg.content ?? "";
    } catch {
      text = msg.content ?? "";
    }

    // Replace @mention placeholders
    if (msg.mentions) {
      text = this.converter.replaceMentions(text, msg.mentions);
    }

    const isMention =
      msg.chat_type === "p2p" ||
      (msg.mentions ?? []).some(
        (m: any) => m.id?.open_id === this.botOpenId,
      );

    const ast = this.converter.toAst(msg.content ?? "{}");

    return {
      id: msg.message_id ?? "",
      threadId: this.encodeThreadId({
        chatId: msg.chat_id ?? "",
        rootMessageId: msg.root_id || undefined,
      }),
      text,
      formatted: ast,
      raw,
      author: {
        userId: senderOpenId,
        userName:
          msg.mentions?.find(
            (m: any) => m.id?.open_id === senderOpenId,
          )?.name ?? "",
        fullName: "",
        isBot,
        isMe: senderOpenId === this.botOpenId,
      },
      metadata: {
        dateSent: new Date(Number(msg.create_time ?? "0")),
        edited: false,
      },
      attachments: [],
      links: [],
      isMention,
    };
  }
```

Update `registerEventHandlers()`:

```typescript
  private registerEventHandlers(): void {
    this.eventDispatcher.register({
      "im.message.receive_v1": async (data: any) => {
        if (!this.chat) return;
        const msg: LarkRawMessage = data;
        const chatId = msg.message.chat_id;
        const rootId = msg.message.root_id || undefined;
        const threadId = this.encodeThreadId({ chatId, rootMessageId: rootId });

        // Cache DM status
        if (msg.message.chat_type === "p2p") {
          this.dmCache.set(chatId, true);
        }

        const factory = async () => this.buildMessage(msg);
        this.chat.processMessage(this, threadId, factory);
      },
      "im.message.reaction.created_v1": async (data: any) => {
        // Reaction created — can be handled via Chat SDK's onReaction
        if (this.chat?.onReaction) {
          this.chat.onReaction(this, data);
        }
      },
      "im.message.reaction.deleted_v1": async (data: any) => {
        // Reaction removed
        if (this.chat?.onReactionRemoved) {
          this.chat.onReactionRemoved(this, data);
        }
      },
      "im.chat.member.bot.added_v1": async (_data: any) => {
        // Bot added to group — log only
      },
    } as any);
  }
```

- [ ] **Step 7C.3: Run parsing tests**

Run: `bun run test tests/adapter.test.ts`
Expected: All PASS.

- [ ] **Step 7C.4: Commit**

```bash
git add src/adapter.ts tests/adapter.test.ts
git commit -m "feat: add message parsing with mention replacement and event routing"
```

#### 7D: Message Sending + File Upload

- [ ] **Step 7D.1: Write failing tests — postMessage, editMessage, deleteMessage**

```typescript
// tests/adapter.test.ts (append)

describe('message sending', () => {
  it('sends a text message to a chat', async () => {
    let capturedBody: any
    server.use(
      http.post(`${BASE_URL}/open-apis/im/v1/messages`, async ({ request }) => {
        capturedBody = await request.json()
        return HttpResponse.json({ code: 0, data: { message_id: 'om_sent1' } })
      }),
    )

    const adapter = new LarkAdapter(config)
    const threadId = adapter.encodeThreadId({ chatId: 'oc_chat1' })
    const result = await adapter.postMessage(threadId, 'hello')

    expect(result.id).toBe('om_sent1')
    expect(capturedBody.msg_type).toBe('text')
  })

  it('replies when rootMessageId is present', async () => {
    let replyPath = ''
    server.use(
      http.post(`${BASE_URL}/open-apis/im/v1/messages/:messageId/reply`, async ({ params }) => {
        replyPath = params.messageId as string
        return HttpResponse.json({
          code: 0,
          data: { message_id: 'om_reply1' },
        })
      }),
    )

    const adapter = new LarkAdapter(config)
    const threadId = adapter.encodeThreadId({
      chatId: 'oc_chat1',
      rootMessageId: 'om_root1',
    })
    const result = await adapter.postMessage(threadId, 'reply text')

    expect(result.id).toBe('om_reply1')
    expect(replyPath).toBe('om_root1')
  })

  it('edits a message', async () => {
    server.use(
      http.patch(`${BASE_URL}/open-apis/im/v1/messages/:id`, () =>
        HttpResponse.json({ code: 0, data: {} }),
      ),
    )

    const adapter = new LarkAdapter(config)
    const threadId = adapter.encodeThreadId({ chatId: 'oc_chat1' })
    const result = await adapter.editMessage(threadId, 'om_msg1', 'edited text')
    expect(result.id).toBe('om_msg1')
  })

  it('deletes a message', async () => {
    server.use(
      http.delete(`${BASE_URL}/open-apis/im/v1/messages/:id`, () => HttpResponse.json({ code: 0 })),
    )

    const adapter = new LarkAdapter(config)
    const threadId = adapter.encodeThreadId({ chatId: 'oc_chat1' })
    await expect(adapter.deleteMessage(threadId, 'om_msg1')).resolves.toBeUndefined()
  })
})
```

- [ ] **Step 7D.2: Implement postMessage, editMessage, deleteMessage with file upload**

Add to `src/adapter.ts`:

```typescript
  async postMessage(
    threadId: string,
    message: any,
  ): Promise<{ raw: any; id: string }> {
    const { chatId, rootMessageId } = this.decodeThreadId(threadId);

    // TODO: If @chat-adapter/shared exports extractFiles(), use it here
    // to detect file attachments, upload them, then send typed messages.
    // For now, handle text and card messages.

    const { msgType, content } = this.renderMessage(message);

    let result: any;
    if (rootMessageId) {
      result = await this.apiClient.replyMessage(rootMessageId, msgType, content);
    } else {
      result = await this.apiClient.sendMessage(chatId, msgType, content);
    }

    const messageId = result?.data?.message_id ?? result?.message_id ?? "";
    return { raw: result, id: messageId };
  }

  async editMessage(
    _threadId: string,
    messageId: string,
    message: any,
  ): Promise<{ raw: any; id: string }> {
    const { msgType, content } = this.renderMessage(message);
    const result = await this.apiClient.updateMessage(messageId, msgType, content);
    return { raw: result, id: messageId };
  }

  async deleteMessage(_threadId: string, messageId: string): Promise<void> {
    await this.apiClient.deleteMessage(messageId);
  }

  private renderMessage(message: any): { msgType: string; content: string } {
    if (typeof message === "string") {
      return { msgType: "text", content: JSON.stringify({ text: message }) };
    }
    const card = message?.card;
    if (card) {
      const larkCard = cardToLarkInteractive(card);
      return { msgType: "interactive", content: JSON.stringify(larkCard) };
    }
    const text = message?.text ?? message?.markdown ?? "";
    return this.converter.renderForSend({ text });
  }
```

- [ ] **Step 7D.3: Run message sending tests**

Run: `bun run test tests/adapter.test.ts`
Expected: PASS.

- [ ] **Step 7D.4: Commit**

```bash
git add src/adapter.ts tests/adapter.test.ts
git commit -m "feat: add message sending, editing, and deleting"
```

#### 7E: Reactions

- [ ] **Step 7E.1: Write failing tests — addReaction, removeReaction**

```typescript
// tests/adapter.test.ts (append)

describe('reactions', () => {
  it('adds a reaction by emoji string', async () => {
    let capturedEmojiType = ''
    server.use(
      http.post(`${BASE_URL}/open-apis/im/v1/messages/:id/reactions`, async ({ request }) => {
        const body: any = await request.json()
        capturedEmojiType = body.reaction_type?.emoji_type
        return HttpResponse.json({ code: 0, data: {} })
      }),
    )

    const adapter = new LarkAdapter(config)
    const threadId = adapter.encodeThreadId({ chatId: 'oc_chat1' })
    await adapter.addReaction(threadId, 'om_msg1', 'THUMBSUP')
    expect(capturedEmojiType).toBe('THUMBSUP')
  })

  it('adds a reaction from EmojiValue object', async () => {
    let capturedEmojiType = ''
    server.use(
      http.post(`${BASE_URL}/open-apis/im/v1/messages/:id/reactions`, async ({ request }) => {
        const body: any = await request.json()
        capturedEmojiType = body.reaction_type?.emoji_type
        return HttpResponse.json({ code: 0, data: {} })
      }),
    )

    const adapter = new LarkAdapter(config)
    const threadId = adapter.encodeThreadId({ chatId: 'oc_chat1' })
    await adapter.addReaction(threadId, 'om_msg1', { name: 'HEART' })
    expect(capturedEmojiType).toBe('HEART')
  })

  it('removes a reaction by listing then deleting', async () => {
    let deletedReactionId = ''
    server.use(
      http.get(`${BASE_URL}/open-apis/im/v1/messages/:id/reactions`, () =>
        HttpResponse.json({
          code: 0,
          data: {
            items: [
              {
                reaction_id: 'r-001',
                reaction_type: { emoji_type: 'THUMBSUP' },
              },
            ],
          },
        }),
      ),
      http.delete(
        `${BASE_URL}/open-apis/im/v1/messages/:msgId/reactions/:reactionId`,
        ({ params }) => {
          deletedReactionId = params.reactionId as string
          return HttpResponse.json({ code: 0 })
        },
      ),
    )

    const adapter = new LarkAdapter(config)
    const threadId = adapter.encodeThreadId({ chatId: 'oc_chat1' })
    await adapter.removeReaction(threadId, 'om_msg1', 'THUMBSUP')
    expect(deletedReactionId).toBe('r-001')
  })
})
```

- [ ] **Step 7E.2: Implement addReaction, removeReaction**

Add to `src/adapter.ts`:

```typescript
  async addReaction(
    _threadId: string,
    messageId: string,
    emoji: any,
  ): Promise<void> {
    const emojiType = typeof emoji === "string" ? emoji : emoji?.name ?? emoji;
    await this.apiClient.addReaction(messageId, emojiType);
  }

  async removeReaction(
    _threadId: string,
    messageId: string,
    emoji: any,
  ): Promise<void> {
    const emojiType = typeof emoji === "string" ? emoji : emoji?.name ?? emoji;
    const reactions = await this.apiClient.listReactions(messageId);
    const items = reactions?.data?.items ?? [];
    const target = items.find(
      (r: any) => r.reaction_type?.emoji_type === emojiType,
    );
    if (target?.reaction_id) {
      await this.apiClient.removeReaction(messageId, target.reaction_id);
    }
  }
```

- [ ] **Step 7E.3: Run reaction tests**

Run: `bun run test tests/adapter.test.ts`
Expected: PASS.

- [ ] **Step 7E.4: Commit**

```bash
git add src/adapter.ts tests/adapter.test.ts
git commit -m "feat: add reaction support with list-then-delete pattern"
```

#### 7F: Fetch Methods + DM + Typing + Formatting

- [ ] **Step 7F.1: Write failing tests — fetch, DM, misc**

```typescript
// tests/adapter.test.ts (append)

describe('fetch methods', () => {
  it('fetchMessages returns paginated results', async () => {
    server.use(
      http.get(`${BASE_URL}/open-apis/im/v1/messages`, () =>
        HttpResponse.json({
          code: 0,
          data: {
            items: [
              {
                message_id: 'om_1',
                chat_id: 'oc_chat1',
                content: '{"text":"msg1"}',
                create_time: '1700000000000',
                message_type: 'text',
              },
            ],
            has_more: true,
            page_token: 'next-page',
          },
        }),
      ),
    )

    const adapter = new LarkAdapter(config)
    const threadId = adapter.encodeThreadId({ chatId: 'oc_chat1' })
    const result = await adapter.fetchMessages(threadId)
    expect(result.messages.length).toBe(1)
    expect(result.hasMore).toBe(true)
    expect(result.nextCursor).toBe('next-page')
  })

  it('fetchThread returns chat info', async () => {
    server.use(
      http.get(`${BASE_URL}/open-apis/im/v1/chats/:id`, () =>
        HttpResponse.json({
          code: 0,
          data: { name: 'Test Group', member_count: 5 },
        }),
      ),
    )

    const adapter = new LarkAdapter(config)
    const threadId = adapter.encodeThreadId({ chatId: 'oc_chat1' })
    const info = await adapter.fetchThread(threadId)
    expect(info.name).toBe('Test Group')
  })
})

describe('DM', () => {
  it('openDM creates a P2P chat and returns encoded thread ID', async () => {
    server.use(
      http.post(`${BASE_URL}/open-apis/im/v1/chats`, () =>
        HttpResponse.json({
          code: 0,
          data: { chat_id: 'oc_p2p_new' },
        }),
      ),
    )

    const adapter = new LarkAdapter(config)
    const threadId = await adapter.openDM('ou_user1')
    expect(threadId).toMatch(/^lark:/)

    // isDM should return true for the new chat
    expect(adapter.isDM(threadId)).toBe(true)
  })

  it('isDM returns false for unknown chats', () => {
    const adapter = new LarkAdapter(config)
    const threadId = adapter.encodeThreadId({ chatId: 'oc_unknown' })
    expect(adapter.isDM(threadId)).toBe(false)
  })
})

describe('misc', () => {
  it('startTyping is a no-op', async () => {
    const adapter = new LarkAdapter(config)
    await expect(adapter.startTyping('lark:abc')).resolves.toBeUndefined()
  })

  it('channelIdFromThreadId extracts chatId', () => {
    const adapter = new LarkAdapter(config)
    const threadId = adapter.encodeThreadId({ chatId: 'oc_chat1' })
    expect(adapter.channelIdFromThreadId(threadId)).toBe('oc_chat1')
  })
})
```

- [ ] **Step 7F.2: Implement fetch, DM, misc methods**

Add to `src/adapter.ts`:

```typescript
  // --- Fetch ---

  async fetchMessages(
    threadId: string,
    options?: { cursor?: string; limit?: number },
  ) {
    const { chatId } = this.decodeThreadId(threadId);
    const result = await this.apiClient.listMessages(
      chatId,
      options?.cursor,
      options?.limit,
    );
    const items = result?.data?.items ?? [];
    const messages = items.map((m: any) => this.buildMessage(m));
    return {
      messages,
      nextCursor: result?.data?.page_token,
      hasMore: result?.data?.has_more ?? false,
    };
  }

  async fetchThread(threadId: string) {
    const { chatId } = this.decodeThreadId(threadId);
    const result = await this.apiClient.getChatInfo(chatId);
    return {
      id: threadId,
      name: result?.data?.name ?? "",
      memberCount: result?.data?.member_count,
    };
  }

  async fetchMessage(_threadId: string, messageId: string) {
    const result = await this.apiClient.getMessage(messageId);
    return this.buildMessage(result?.data);
  }

  async fetchChannelInfo(channelId: string) {
    const result = await this.apiClient.getChatInfo(channelId);
    return result?.data;
  }

  // --- DM ---

  async openDM(userId: string): Promise<string> {
    const result = await this.apiClient.createP2PChat(userId);
    const chatId = result?.data?.chat_id;
    if (!chatId) throw new Error("Failed to create P2P chat");
    this.dmCache.set(chatId, true);
    return this.encodeThreadId({ chatId });
  }

  isDM(threadId: string): boolean {
    const { chatId } = this.decodeThreadId(threadId);
    return this.dmCache.get(chatId) ?? false;
  }

  // --- Typing (no-op) ---

  async startTyping(_threadId?: string): Promise<void> {}

  // --- Format ---

  renderFormatted(content: any): string {
    return this.converter.fromAst(content);
  }
```

- [ ] **Step 7F.3: Run all adapter tests**

Run: `bun run test tests/adapter.test.ts`
Expected: All PASS.

- [ ] **Step 7F.4: Commit**

```bash
git add src/adapter.ts tests/adapter.test.ts
git commit -m "feat: add fetch, DM, typing, and channel info methods"
```

#### 7G: Streaming

- [ ] **Step 7G.1: Write failing tests — streaming**

```typescript
// tests/adapter.test.ts (append)

describe('stream', () => {
  it('posts placeholder then edits with accumulated content', async () => {
    const sentMessages: string[] = []
    const editedMessages: string[] = []

    server.use(
      http.post(`${BASE_URL}/open-apis/im/v1/messages`, async ({ request }) => {
        const body: any = await request.json()
        sentMessages.push(body.content)
        return HttpResponse.json({ code: 0, data: { message_id: 'om_stream1' } })
      }),
      http.patch(`${BASE_URL}/open-apis/im/v1/messages/:id`, async ({ request }) => {
        const body: any = await request.json()
        editedMessages.push(body.content)
        return HttpResponse.json({ code: 0, data: {} })
      }),
    )

    const adapter = new LarkAdapter(config)
    const threadId = adapter.encodeThreadId({ chatId: 'oc_chat1' })

    const stream = new ReadableStream<string>({
      start(controller) {
        controller.enqueue('Hello ')
        controller.enqueue('world!')
        controller.close()
      },
    })

    await adapter.stream(threadId, stream)

    expect(sentMessages.length).toBe(1)
    expect(sentMessages[0]).toContain('...')

    const lastEdit = editedMessages[editedMessages.length - 1]
    expect(lastEdit).toContain('Hello world!')
  })

  it('handles stream interruption — final edit still called', async () => {
    const edits: string[] = []
    server.use(
      http.post(`${BASE_URL}/open-apis/im/v1/messages`, () =>
        HttpResponse.json({ code: 0, data: { message_id: 'om_s2' } }),
      ),
      http.patch(`${BASE_URL}/open-apis/im/v1/messages/:id`, async ({ request }) => {
        const body: any = await request.json()
        edits.push(body.content)
        return HttpResponse.json({ code: 0 })
      }),
    )

    const adapter = new LarkAdapter(config)
    const threadId = adapter.encodeThreadId({ chatId: 'oc_chat1' })

    const stream = new ReadableStream<string>({
      start(controller) {
        controller.enqueue('partial')
        controller.error(new Error('stream broke'))
      },
    })

    // Should not throw — adapter handles interruption gracefully
    await adapter.stream(threadId, stream).catch(() => {})

    // Final edit should contain whatever was accumulated
    expect(edits.length).toBeGreaterThan(0)
    const lastEdit = edits[edits.length - 1]
    expect(lastEdit).toContain('partial')
  })
})
```

- [ ] **Step 7G.2: Implement stream**

Add to `src/adapter.ts`:

```typescript
  async stream(
    threadId: string,
    textStream: ReadableStream<string>,
  ): Promise<void> {
    const { chatId, rootMessageId } = this.decodeThreadId(threadId);

    // Post initial placeholder
    const placeholderContent = JSON.stringify({ text: "..." });
    let result: any;
    if (rootMessageId) {
      result = await this.apiClient.replyMessage(
        rootMessageId,
        "text",
        placeholderContent,
      );
    } else {
      result = await this.apiClient.sendMessage(
        chatId,
        "text",
        placeholderContent,
      );
    }
    const messageId = result?.data?.message_id ?? result?.message_id;
    if (!messageId) return;

    // Consume stream with throttled edits
    let accumulated = "";
    let lastEditTime = 0;
    const reader = textStream.getReader();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        accumulated += value;

        const now = Date.now();
        if (now - lastEditTime >= STREAM_THROTTLE_MS) {
          await this.apiClient
            .updateMessage(messageId, "text", JSON.stringify({ text: accumulated }))
            .catch(() => {});
          lastEditTime = now;
        }
      }
    } catch {
      // Stream interrupted — proceed to final edit
    } finally {
      if (accumulated) {
        await this.apiClient
          .updateMessage(messageId, "text", JSON.stringify({ text: accumulated }))
          .catch(() => {});
      }
    }
  }
```

- [ ] **Step 7G.3: Run streaming tests**

Run: `bun run test tests/adapter.test.ts`
Expected: PASS.

- [ ] **Step 7G.4: Commit**

```bash
git add src/adapter.ts tests/adapter.test.ts
git commit -m "feat: add streaming with throttled editMessage fallback"
```

#### 7H: Ephemeral Messages

- [ ] **Step 7H.1: Write failing test**

```typescript
// tests/adapter.test.ts (append)

describe('ephemeral', () => {
  it('sends an ephemeral message to a specific user', async () => {
    let capturedBody: any
    server.use(
      http.post(`${BASE_URL}/open-apis/ephemeral/v1/send`, async ({ request }) => {
        capturedBody = await request.json()
        return HttpResponse.json({ code: 0 })
      }),
    )

    const adapter = new LarkAdapter(config)
    const threadId = adapter.encodeThreadId({ chatId: 'oc_chat1' })
    await adapter.postEphemeral(threadId, 'ou_user1', 'secret message')

    expect(capturedBody.chat_id).toBe('oc_chat1')
    expect(capturedBody.user_id).toBe('ou_user1')
  })
})
```

- [ ] **Step 7H.2: Implement postEphemeral**

Add to `src/adapter.ts`:

```typescript
  async postEphemeral(
    threadId: string,
    userId: string,
    message: any,
  ): Promise<void> {
    const { chatId } = this.decodeThreadId(threadId);
    const { content } = this.renderMessage(message);
    await this.apiClient.sendEphemeral(chatId, userId, content);
  }
```

- [ ] **Step 7H.3: Run test, pass**

Run: `bun run test tests/adapter.test.ts`
Expected: PASS.

- [ ] **Step 7H.4: Export and commit**

```typescript
// src/index.ts (add)
export { LarkAdapter } from './adapter.ts'
```

```bash
bun run fmt && bun run lint
git add src/adapter.ts tests/adapter.test.ts src/index.ts
git commit -m "feat: add ephemeral messages and finalize adapter exports"
```

---

### Task 8: Factory Function & Public Exports

**Files:**

- Create: `src/factory.ts`
- Create: `tests/factory.test.ts`
- Modify: `src/index.ts`

- [ ] **Step 8.1: Write failing tests for createLarkAdapter**

```typescript
// tests/factory.test.ts
import { describe, it, expect, afterEach } from 'vitest'
import { createLarkAdapter } from '../src/factory.ts'

describe('createLarkAdapter', () => {
  const originalEnv = { ...process.env }

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  it('creates adapter with explicit config', () => {
    const adapter = createLarkAdapter({ appId: 'app-123', appSecret: 'secret-456' })
    expect(adapter.name).toBe('lark')
  })

  it('falls back to environment variables', () => {
    process.env.LARK_APP_ID = 'env-app-id'
    process.env.LARK_APP_SECRET = 'env-secret'
    const adapter = createLarkAdapter()
    expect(adapter.name).toBe('lark')
  })

  it('throws when appId is missing', () => {
    delete process.env.LARK_APP_ID
    delete process.env.LARK_APP_SECRET
    expect(() => createLarkAdapter()).toThrow(/LARK_APP_ID/)
  })

  it('throws when appSecret is missing', () => {
    process.env.LARK_APP_ID = 'app-id'
    delete process.env.LARK_APP_SECRET
    expect(() => createLarkAdapter()).toThrow(/LARK_APP_SECRET/)
  })

  it('config overrides environment variables', () => {
    process.env.LARK_APP_ID = 'env-id'
    process.env.LARK_APP_SECRET = 'env-secret'
    const adapter = createLarkAdapter({ appId: 'config-id', appSecret: 'config-secret' })
    expect(adapter.name).toBe('lark')
  })

  it('reads encryptKey from env', () => {
    process.env.LARK_APP_ID = 'id'
    process.env.LARK_APP_SECRET = 'secret'
    process.env.LARK_ENCRYPT_KEY = 'enc-key'
    expect(() => createLarkAdapter()).not.toThrow()
  })

  it("resolves LARK_DOMAIN='lark' to lark domain", () => {
    process.env.LARK_APP_ID = 'id'
    process.env.LARK_APP_SECRET = 'secret'
    process.env.LARK_DOMAIN = 'lark'
    const adapter = createLarkAdapter()
    expect(adapter).toBeDefined()
  })
})
```

- [ ] **Step 8.2: Run to verify failure**

Run: `bun run test tests/factory.test.ts`
Expected: FAIL.

- [ ] **Step 8.3: Implement createLarkAdapter**

```typescript
// src/factory.ts
import * as lark from '@larksuiteoapi/node-sdk'
import { LarkAdapter } from './adapter.ts'
import type { LarkAdapterConfig } from './types.ts'

export function createLarkAdapter(config?: Partial<LarkAdapterConfig>): LarkAdapter {
  const appId = config?.appId ?? process.env.LARK_APP_ID
  const appSecret = config?.appSecret ?? process.env.LARK_APP_SECRET
  const encryptKey = config?.encryptKey ?? process.env.LARK_ENCRYPT_KEY
  const verificationToken = config?.verificationToken ?? process.env.LARK_VERIFICATION_TOKEN

  if (!appId) {
    throw new Error('Lark App ID is required. Pass config.appId or set LARK_APP_ID.')
  }
  if (!appSecret) {
    throw new Error('Lark App Secret is required. Pass config.appSecret or set LARK_APP_SECRET.')
  }

  const domainRaw = config?.domain ?? process.env.LARK_DOMAIN
  let domain: lark.Domain | string | undefined
  if (domainRaw === 'lark') {
    domain = lark.Domain.Lark
  } else if (domainRaw === 'feishu' || domainRaw === undefined) {
    domain = lark.Domain.Feishu
  } else {
    domain = domainRaw
  }

  return new LarkAdapter({
    appId,
    appSecret,
    encryptKey,
    verificationToken,
    domain,
    userName: config?.userName,
    disableTokenCache: config?.disableTokenCache,
  })
}
```

- [ ] **Step 8.4: Run factory tests**

Run: `bun run test tests/factory.test.ts`
Expected: All PASS.

- [ ] **Step 8.5: Finalize src/index.ts**

```typescript
// src/index.ts
export { LarkAdapter } from './adapter.ts'
export { createLarkAdapter } from './factory.ts'
export { LarkApiClient } from './api-client.ts'
export { LarkFormatConverter } from './format-converter.ts'
export { cardToLarkInteractive, cardToFallbackText } from './card-mapper.ts'
export type { LarkThreadId, LarkAdapterConfig, LarkRawMessage } from './types.ts'
```

- [ ] **Step 8.6: Full build + typecheck**

Run: `bun run build && bun run typecheck`
Expected: `dist/` produced, zero type errors.

- [ ] **Step 8.7: Full test suite**

Run: `bun run test`
Expected: All tests PASS.

- [ ] **Step 8.8: Lint, format, commit**

```bash
bun run fmt && bun run lint
git add src/factory.ts tests/factory.test.ts src/index.ts
git commit -m "feat: add createLarkAdapter factory with env var fallback"
```

---

### Task 9: Integration Tests

**Files:**

- Create: `tests/integration.test.ts`

> End-to-end tests using msw to mock all Lark HTTP. Tests the full flow: webhook → adapter → processMessage → handler → API call.

- [ ] **Step 9.1: Write integration test — full send/receive flow**

```typescript
// tests/integration.test.ts
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from './setup.ts'
import { LarkAdapter } from '../src/adapter.ts'
import { createLarkAdapter } from '../src/factory.ts'
import { makeMessageEvent, makeDMEvent, makeReactionEvent, makeRequest } from './fixtures.ts'

const BASE_URL = 'https://open.feishu.cn'

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'bypass' })
  server.use(
    http.post(`${BASE_URL}/open-apis/auth/v3/tenant_access_token/internal`, () =>
      HttpResponse.json({ code: 0, tenant_access_token: 't-token', expire: 7200 }),
    ),
    http.get(`${BASE_URL}/open-apis/bot/v3/info`, () =>
      HttpResponse.json({ code: 0, bot: { open_id: 'ou_bot001', app_name: 'TestBot' } }),
    ),
  )
})
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

function makeAdapter() {
  return createLarkAdapter({ appId: 'test-app', appSecret: 'test-secret' })
}

describe('Integration', () => {
  it('receives a webhook and can post a reply', async () => {
    let capturedSendBody: any
    server.use(
      http.post(`${BASE_URL}/open-apis/im/v1/messages`, async ({ request }) => {
        capturedSendBody = await request.json()
        return HttpResponse.json({ code: 0, data: { message_id: 'om_reply001' } })
      }),
    )

    const adapter = makeAdapter()
    await adapter.initialize({
      processMessage: async (_adapter: any, threadId: string, factory: any) => {
        const msg = await factory()
        await adapter.postMessage(threadId, 'Got it: ' + msg.text)
      },
    })

    const res = await adapter.handleWebhook(makeRequest(makeMessageEvent()))
    expect(res.status).toBe(200)

    // Wait for async processing
    await new Promise((r) => setTimeout(r, 200))

    expect(capturedSendBody).toBeDefined()
    expect(capturedSendBody.msg_type).toBe('text')
  })

  it('handles thread reply flow (rootMessageId)', async () => {
    let replyEndpointHit = false
    server.use(
      http.post(`${BASE_URL}/open-apis/im/v1/messages/:id/reply`, () => {
        replyEndpointHit = true
        return HttpResponse.json({ code: 0, data: { message_id: 'om_reply002' } })
      }),
    )

    const adapter = makeAdapter()
    await adapter.initialize({
      processMessage: async (_adapter: any, threadId: string, factory: any) => {
        await factory()
        await adapter.postMessage(threadId, 'thread reply')
      },
    })

    const event = makeMessageEvent()
    // Set root_id to simulate a thread
    ;(event as any).event.message.root_id = 'om_root001'

    const res = await adapter.handleWebhook(makeRequest(event))
    expect(res.status).toBe(200)
    await new Promise((r) => setTimeout(r, 200))

    expect(replyEndpointHit).toBe(true)
  })

  it('streaming end-to-end: post + multiple edits', async () => {
    const edits: string[] = []
    server.use(
      http.post(`${BASE_URL}/open-apis/im/v1/messages`, () =>
        HttpResponse.json({ code: 0, data: { message_id: 'om_stream1' } }),
      ),
      http.patch(`${BASE_URL}/open-apis/im/v1/messages/:id`, async ({ request }) => {
        const body: any = await request.json()
        edits.push(body.content)
        return HttpResponse.json({ code: 0, data: {} })
      }),
    )

    const adapter = makeAdapter()
    const threadId = adapter.encodeThreadId({ chatId: 'oc_chat1' })
    const stream = new ReadableStream<string>({
      start(controller) {
        controller.enqueue('Thinking')
        controller.enqueue('...')
        controller.enqueue(' Done!')
        controller.close()
      },
    })

    await adapter.stream(threadId, stream)
    const lastEdit = edits[edits.length - 1]!
    expect(lastEdit).toContain('Thinking... Done!')
  })

  it('deduplicates repeated webhook events', async () => {
    let processCount = 0
    const adapter = makeAdapter()
    await adapter.initialize({
      processMessage: async () => {
        processCount++
      },
    })

    const event = makeMessageEvent()
    await adapter.handleWebhook(makeRequest(event))
    await adapter.handleWebhook(makeRequest(event))
    await new Promise((r) => setTimeout(r, 200))

    expect(processCount).toBe(1)
  })

  it('DM flow: p2p message sets isMention=true', async () => {
    let receivedIsMention = false
    const adapter = makeAdapter()
    await adapter.initialize({
      processMessage: async (_adapter: any, _threadId: string, factory: any) => {
        const msg = await factory()
        receivedIsMention = msg.isMention
      },
    })

    const res = await adapter.handleWebhook(makeRequest(makeDMEvent()))
    expect(res.status).toBe(200)
    await new Promise((r) => setTimeout(r, 200))

    expect(receivedIsMention).toBe(true)
  })

  it('handles API rate limit errors gracefully', async () => {
    server.use(
      http.post(
        `${BASE_URL}/open-apis/im/v1/messages`,
        () => new HttpResponse(null, { status: 429 }),
      ),
    )

    const adapter = makeAdapter()
    const threadId = adapter.encodeThreadId({ chatId: 'oc_chat1' })
    await expect(adapter.postMessage(threadId, 'test')).rejects.toThrow(/rate.limit/i)
  })

  it('openDM creates a chat and isDM returns true', async () => {
    server.use(
      http.post(`${BASE_URL}/open-apis/im/v1/chats`, () =>
        HttpResponse.json({ code: 0, data: { chat_id: 'oc_dm_new' } }),
      ),
    )

    const adapter = makeAdapter()
    const threadId = await adapter.openDM('ou_user1')
    expect(adapter.isDM(threadId)).toBe(true)
  })
})
```

- [ ] **Step 9.2: Run integration tests**

Run: `bun run test tests/integration.test.ts`
Expected: All PASS.

- [ ] **Step 9.3: Run full test suite**

Run: `bun run test`
Expected: All tests across all files PASS.

- [ ] **Step 9.4: Lint, format, commit**

```bash
bun run fmt && bun run lint
git add tests/integration.test.ts
git commit -m "test: add integration tests for full webhook-to-reply flow"
```

---

### Task 10: Documentation

**Files:**

- Modify: `README.md`

- [ ] **Step 10.1: Write README.md**

Write a comprehensive README with:

- Installation: `npm install chat-adapter-lark`
- Quick Start code example (import, Chat instance, handler, webhook route)
- Configuration table (all config fields + env vars + required/optional)
- Webhook setup examples: Next.js App Router, Hono, Express
- Lark Open Platform setup steps: create app → permissions → event subscription → URL verification → publish
- Required permissions: `im:message`, `im:message:send_as_bot`, `im:chat:readonly`, `im:resource`, `contact:user.id:readonly`
- Feature support matrix (each feature ✅ or ⚠️ with limits)
- Feishu vs Lark domain switching: `domain: lark.Domain.Lark` or `LARK_DOMAIN=lark`
- Contributing section

- [ ] **Step 10.2: Verify build + test + lint all pass**

```bash
bun run build && bun run test && bun run lint
```

- [ ] **Step 10.3: Commit**

```bash
git add README.md
git commit -m "docs: add comprehensive README with setup guide and examples"
```

---

## Post-Implementation Checklist

After all tasks complete, verify:

- [ ] `bun run typecheck` — zero errors
- [ ] `bun run test` — all tests pass
- [ ] `bun run build` — produces `dist/index.js` + `dist/index.d.ts`
- [ ] `bun run lint` — zero warnings/errors
- [ ] `bun run fmt:check` — all files formatted
- [ ] `npm pack --dry-run` — only `dist/`, `package.json`, `README.md`

---

## Dependency Graph

```
Task 1 (skeleton + CI)
  └── Task 2 (types)
        ├── Task 3 (dedup cache)         ─┐
        ├── Task 4 (API client)          ─┤ parallel
        ├── Task 5 (event bridge)        ─┤
        └── Task 6 (format converter)    ─┘
              └── Task 7 (main adapter: 7A→7B→7C→7D→7E→7F→7G→7H)
                    └── Task 8 (factory + exports)
                          └── Task 9 (integration tests)
                                └── Task 10 (docs)
```

Tasks 3, 4, 5, 6 are independent and can be executed in parallel by separate subagents.
Task 7 is split into 8 sub-tasks (7A-7H), each following strict TDD.
