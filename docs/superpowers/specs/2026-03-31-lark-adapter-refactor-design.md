# Lark Adapter Refactor — Design Spec

**Date:** 2026-03-31
**Scope:** Interface completion, integration test rewrite, unit test coverage

## Context

The Lark adapter implements all 15 required `Adapter` interface methods and passes 106 tests. However, an audit against Chat SDK documentation (`testing.mdx`, `building.mdx`) and the `@chat-adapter/shared` API surface revealed gaps in optional method coverage and test architecture.

## Authority sources

- **Chat SDK**: `node_modules/chat/docs/contributing/testing.mdx` — integration test patterns
- **Chat SDK**: `node_modules/chat/dist/index.d.ts` — Adapter interface contract
- **Lark API**: Feishu open platform docs — API capability confirmation
- **@chat-adapter/shared**: `dist/index.d.ts` — shared error classes and utilities

## Changes

### 1. Interface completion

#### 1.1 `botUserId` property

Set `botUserId` from the `botOpenId` already fetched in `initialize()`. Chat SDK uses this for mention matching (`author.isMe` checks).

```typescript
// adapter.ts — in initialize()
this.botUserId = this.botOpenId
```

Requires changing from a plain field to a public property on the class.

#### 1.2 `postChannelMessage(channelId, message)`

Send a message directly to a channel (chat) without thread context. Uses the existing `api.sendMessage(chatId, msgType, content)`.

```typescript
async postChannelMessage(channelId, message) {
  // render message, handle files and cards
  // call api.sendMessage(channelId, ...)
}
```

Lark API: `POST /open-apis/im/v1/messages` with `receive_id_type=chat_id`.

#### 1.3 `fetchChannelMessages(channelId, options?)`

Fetch messages from a channel by `chatId`. Uses the existing `api.listMessages(chatId, pageToken, pageSize)`.

```typescript
async fetchChannelMessages(channelId, options?) {
  const res = await this.api.listMessages(channelId, options?.cursor, options?.limit)
  // map items to Message[]
}
```

Lark API: `GET /open-apis/im/v1/messages` with `container_id_type=chat`.

#### 1.4 `getChannelVisibility(threadId)`

Map Lark's `chat_type` to Chat SDK's `ChannelVisibility`. Uses the existing `api.getChatInfo(chatId)`.

```typescript
async getChannelVisibility(threadId) {
  const { chatId } = this.decodeThreadId(threadId)
  const res = await this.api.getChatInfo(chatId)
  return res.data?.chat_type === 'public' ? 'public' : 'private'
}
```

Lark API: `GET /open-apis/im/v1/chats/:chat_id` returns `chat_type: "private" | "public"`.

#### 1.5 Update `stream` method signature

Add the `options?: StreamOptions` parameter to match the Adapter interface. The current implementation doesn't use options, but the signature must be present for type compliance.

### 2. Integration test rewrite

Current integration tests bypass the `Chat` instance, calling `adapter.handleWebhook()` and `adapter.initialize(mockChat as never)` directly. This misses the SDK routing layer.

#### 2.1 Install `@chat-adapter/state-memory`

Add as devDependency for integration tests.

#### 2.2 Create `tests/test-utils.ts`

Factory function per Chat SDK `testing.mdx` pattern:

```typescript
export function createLarkTestContext(handlers) {
  const adapter = createLarkAdapter({ appId, appSecret })
  const state = createMemoryState()
  const chat = new Chat({
    userName: 'test-bot',
    adapters: { lark: adapter },
    state,
    logger: 'error',
  })

  // Wire handlers (onNewMention, onSubscribedMessage, onAction, onReaction)
  // Create waitUntil tracker
  // Return { chat, adapter, state, tracker, captured, sendWebhook }
}
```

`sendWebhook` must go through `chat.webhooks.lark(request, { waitUntil })`, not `adapter.handleWebhook()`.

#### 2.3 Rewrite `tests/integration.test.ts`

Cover all flows required by testing.mdx:

| Flow | What to verify |
|------|----------------|
| Mention | Bot detects @mention, `onNewMention` fires |
| Subscribe + follow-up | After `thread.subscribe()`, subsequent messages trigger `onSubscribedMessage` |
| Self-message filtering | Messages from bot itself are ignored |
| DM flow | Direct messages detected and routed correctly |
| Reactions | Emoji reactions fire `onReaction` with correct emoji and message ID |
| Rate limit | API 429 → `AdapterRateLimitError` propagates correctly |

MSW handlers remain for mocking Lark API responses. The real `Chat` + `createMemoryState()` handles SDK routing.

### 3. Unit test additions

#### 3.1 Error mapping tests (api-client.test.ts)

Add tests for:
- HTTP 403 → `PermissionError`
- HTTP 404 → `ResourceNotFoundError`
- HTTP 401 → `AuthenticationError`
- Lark code 99991400 → `AdapterRateLimitError`

#### 3.2 New method tests (adapter.test.ts)

- `postChannelMessage` — sends to channel, handles files and cards
- `fetchChannelMessages` — fetches with pagination
- `getChannelVisibility` — maps private/public
- `botUserId` — set after initialization

## Out of scope

| Item | Reason |
|------|--------|
| `scheduleMessage()` | Lark has no scheduled message API |
| `listThreads()` | Lark has no thread listing API |
| `onThreadSubscribe()` | Lark has no thread subscription mechanism |
| `lockScope` property | Default `"thread"` is correct for Lark |
| `persistMessageHistory` | Lark has server-side message history |
| Use `cardToFallbackText` from shared | `PlatformName` excludes `"lark"` |
| Use `mapButtonStyle` from shared | `PlatformName` excludes `"lark"` |

## File changes

| File | Action |
|------|--------|
| `src/adapter.ts` | Add `botUserId`, `postChannelMessage`, `fetchChannelMessages`, `getChannelVisibility`; update `stream` signature |
| `tests/test-utils.ts` | New: `createLarkTestContext` factory |
| `tests/integration.test.ts` | Rewrite using real `Chat` + `createMemoryState()` |
| `tests/api-client.test.ts` | Add error mapping tests |
| `tests/adapter.test.ts` | Add new method tests |
| `package.json` | Add `@chat-adapter/state-memory` devDependency |
