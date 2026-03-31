# Align with Official Adapter Patterns

**Date:** 2026-03-31
**Status:** Draft
**Goal:** Make chat-adapter-lark follow the same infrastructure patterns as Vercel-maintained adapters (Slack reference).

## Background

The Lark adapter works correctly but diverges from official adapter patterns in several areas: logger injection, event deduplication ownership, user/channel caching, and DM state persistence. These divergences cause problems in serverless deployments and make the adapter behave differently from what Chat SDK users expect.

## Changes

### 1. Logger Injection

**Current:** Logger is obtained from `chat.getLogger('lark')` in `initialize()`. No logging before init. Users cannot inject a custom logger.

**Target:** Accept `logger?: Logger` in `LarkAdapterConfig`. Default to `new ConsoleLogger("info").child("lark")`. Use this logger for the entire adapter lifecycle, including construction. Do not override in `initialize()`.

**Files:** `types.ts`, `factory.ts`, `adapter.ts`, `api-client.ts`

**Details:**
- Add `logger?: Logger` to `LarkAdapterConfig`
- Import `ConsoleLogger` and `Logger` from `chat`
- Constructor: `this.logger = config.logger ?? new ConsoleLogger("info").child("lark")`
- `initialize()`: remove `this.logger = chat.getLogger(ADAPTER_NAME)` — keep the config-provided logger
- `LarkApiClient` constructor already accepts an `ApiLogger` — no change needed there
- `factory.ts`: pass `config.logger` through to `LarkAdapter`

### 2. Remove DedupCache

**Current:** Adapter maintains an in-memory `DedupCache` (LRU, capacity 500) that deduplicates webhook events by `event_id` before calling `chat.processMessage`. The `disconnect()` method clears this cache.

**Target:** Remove entirely. Chat SDK core handles deduplication via the state adapter. Adapter-level dedup is redundant, not serverless-friendly, and not how official adapters work.

**Files:** `adapter.ts`, `dedup-cache.ts` (delete), `tests/dedup-cache.test.ts` (delete), `tests/adapter.test.ts`

**Details:**
- Delete `src/dedup-cache.ts` and `tests/dedup-cache.test.ts`
- Remove from `adapter.ts`:
  - `import { DedupCache }` and the `dedup` field
  - `DEDUP_CAPACITY` constant
  - `extractEventId` helper function
  - The dedup check in `handleEvent()` (`if (eventId && this.dedup.has(eventId))` block)
  - `this.dedup.clear()` in `disconnect()`
- `disconnect()` becomes empty or removed
- Update adapter tests that verify dedup behavior — remove or convert to verify events are forwarded

### 3. User Info Cache (lookupUser)

**Current:** `parseMessage` builds `Author` with `open_id` as both `userId` and `userName`/`fullName`. No user info resolution.

**Target:** Cache user display names in the state adapter. Resolve on message receipt. Fill `Author.fullName` and `Author.userName` with real names.

**Files:** `adapter.ts`, `api-client.ts`, `types.ts`

**Cache spec:**
- Key: `lark:user:{openId}`
- Type: `{ name: string }`
- TTL: 8 days (`8 * 24 * 60 * 60 * 1000`)
- Source API: `GET /open-apis/contact/v3/users/:user_id` with `user_id_type=open_id`

**New API method** in `LarkApiClient`:
```typescript
async getUser(openId: string): Promise<{ name?: string }> {
  return this.call(() =>
    this.client.contact.user.get({
      path: { user_id: openId },
      params: { user_id_type: 'open_id' },
    }),
  ) as Promise<{ data?: { user?: { name?: string } } }>
}
```

**New private method** in `LarkAdapter`:
```typescript
private async lookupUser(openId: string): Promise<string> {
  const state = this.chat.getState()
  const cacheKey = `lark:user:${openId}`
  const cached = await state.get<{ name: string }>(cacheKey)
  if (cached) return cached.name

  try {
    const res = await this.api.getUser(openId)
    const name = res.data?.user?.name ?? openId
    await state.set(cacheKey, { name }, USER_CACHE_TTL_MS)
    return name
  } catch {
    this.logger.warn('Failed to lookup user', { openId })
    return openId
  }
}
```

**Message handling change:**
- `handleMessageEvent` switches from passing a `Message` directly to passing a factory `async () => Promise<Message>` (already supported by `chat.processMessage`)
- The factory calls `lookupUser(sender.open_id)` to resolve the author name
- Same pattern for `handleReactionEvent` — resolve user name before building the reaction event

**Scope boundary:** Only cache `name`. Do not build reverse indexes or thread participant tracking — Lark's mention system uses `open_id`, not display names, so outgoing mention resolution is not needed.

### 4. Channel Info Cache + DM Persistence

**Current:** `isDM()` and `getChannelVisibility()` rely on an in-memory `Set<string>` (`dmCache`) populated when P2P messages arrive. Lost on cold start in serverless.

**Target:** Cache channel metadata in the state adapter. Populate on message receipt and API fetch. Remove in-memory `dmCache`.

**Files:** `adapter.ts`

**Cache spec:**
- Key: `lark:channel:{chatId}`
- Type: `{ name?: string; chatType?: string }`
- TTL: 8 days
- Source: message event `chat_type` field, or `GET /im/v1/chats/:chat_id` on cache miss

**New private method** in `LarkAdapter`:
```typescript
private async lookupChannel(chatId: string): Promise<{ name?: string; chatType?: string }> {
  const state = this.chat.getState()
  const cacheKey = `lark:channel:${chatId}`
  const cached = await state.get<{ name?: string; chatType?: string }>(cacheKey)
  if (cached) return cached

  try {
    const res = await this.api.getChatInfo(chatId)
    const info = { name: res.data?.name, chatType: res.data?.chat_type }
    await state.set(cacheKey, info, CHANNEL_CACHE_TTL_MS)
    return info
  } catch {
    this.logger.warn('Failed to lookup channel', { chatId })
    return {}
  }
}
```

**Changes to existing methods:**
- `handleMessageEvent` factory: after parsing message, write channel cache from event data (`msg.chat_type`, `msg.chat_id`)
- `isDM(threadId)`: call `lookupChannel`, return `chatType === 'p2p'`. Method signature changes to `async`.
  - **Note:** The Chat SDK `Adapter` interface defines `isDM` as synchronous (`isDM?(threadId: string): boolean`). We cannot make it async. Instead, write channel info to state on every message receipt, and in `isDM()`, check a synchronous in-memory map that is populated from state on `initialize()`. OR: keep the simpler approach — write to state on message receipt, read synchronously from a local map that mirrors state writes during the current process lifetime. This is what we'll do: maintain a local `Map<string, string>` as a write-through mirror, and also persist to state adapter for cross-invocation durability.
- `getChannelVisibility(threadId)`: same approach — check local map, map `chat_type` to visibility
- Remove `dmCache: Set<string>`

**Write-through pattern:**
```
message arrives → extract chatId + chatType → write to state adapter + local map
isDM() → check local map (sync) → if miss, return false (conservative)
getChannelVisibility() → check local map (sync) → if miss, return 'unknown'
```

This gives serverless durability (state adapter) while keeping `isDM()` synchronous. On cold start, the first message from each chat populates the map. `fetchThread()` and `fetchChannelInfo()` also populate the cache as a side effect.

### 5. Permissions

The `getUser` API requires `contact:user.base:readonly` scope. This should be documented in the README permissions table as a new required permission.

## Constants

```typescript
const USER_CACHE_TTL_MS = 8 * 24 * 60 * 60 * 1000   // 8 days
const CHANNEL_CACHE_TTL_MS = 8 * 24 * 60 * 60 * 1000 // 8 days
```

## Files Changed

| File | Action | Summary |
|------|--------|---------|
| `src/types.ts` | Edit | Add `logger` to config |
| `src/factory.ts` | Edit | Pass logger through |
| `src/adapter.ts` | Edit | Major: remove dedup/dmCache, add logger init, add lookupUser/lookupChannel, message factory pattern |
| `src/api-client.ts` | Edit | Add `getUser()` method |
| `src/dedup-cache.ts` | Delete | No longer needed |
| `tests/dedup-cache.test.ts` | Delete | No longer needed |
| `tests/adapter.test.ts` | Edit | Remove dedup tests, add cache tests |
| `README.md` | Edit | Add logger to config table, add contact permission |

## Testing Strategy

- **lookupUser:** Mock state adapter `get/set`, mock `api.getUser()`. Verify cache hit skips API. Verify cache miss calls API and writes cache. Verify failure falls back to openId.
- **lookupChannel:** Same pattern. Verify write-through on message receipt.
- **isDM / getChannelVisibility:** Verify they read from local map. Verify map is populated from message events and fetchThread/fetchChannelInfo.
- **Logger:** Verify config logger is used. Verify default ConsoleLogger when not provided.
- **Dedup removal:** Verify duplicate events are forwarded (no adapter-level filtering). Chat SDK handles dedup.

## Not In Scope

- Reverse user name index (Lark uses `open_id` for mentions, not display names)
- Thread participant tracking
- Multi-workspace / ISV token storage (future work)
- User avatar enrichment beyond name
