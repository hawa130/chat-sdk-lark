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
- `disconnect()`: clear the local `channelTypeMap` and return. Keep the method for hygiene.
- Update adapter tests that verify dedup behavior — remove or convert to verify events are forwarded

### 3. User Info Cache (lookupUser)

**Current:** `parseMessage` builds `Author` with `open_id` as both `userId` and `userName`/`fullName`. No user info resolution.

**Target:** Cache user display names in the state adapter. Resolve on message receipt, history fetch, and reaction events. Fill `Author.fullName` and `Author.userName` with real names.

**Files:** `adapter.ts`, `api-client.ts`, `types.ts`

**Permissions:** The `getUser` API requires **two** scopes:
- `contact:contact.base:readonly` — required to call the API at all (without it: error 40001)
- `contact:user.base:readonly` — required to get the `name` field in the response (without it: name field omitted)

Both must be documented in the README permissions table.

**Contact scope limitation:** The user lookup API only works for users within the app's contact permission scope ("通讯录权限范围"). By default this scope is narrow. Users outside the scope (common in cross-tenant groups) will fail to resolve. This must be documented in the README troubleshooting section.

**Cache spec:**
- Key: `lark:user:{openId}`
- Type: `{ name: string }` — always a resolved string (real name or openId fallback), never undefined
- TTL: 8 days (`USER_CACHE_TTL_MS`)
- Failed lookup TTL: 1 day (`FAILED_LOOKUP_TTL_MS`) — prevents repeated API calls for users outside contact scope
- Source API: `GET /open-apis/contact/v3/users/:user_id` with `user_id_type=open_id`

**New API method** in `LarkApiClient`:
```typescript
async getUser(openId: string) {
  return this.call(() =>
    this.client.contact.user.get({
      path: { user_id: openId },
      params: { user_id_type: 'open_id' },
    }),
  )
}
```
Returns the full SDK response (like all other `LarkApiClient` methods). The caller accesses `.data?.user?.name`.

**State adapter guard:** `lookupUser` and `lookupChannel` must handle the case where no state adapter is configured (e.g., dev setup without Redis). Guard with try/catch around state calls. On state error, skip caching and just make the API call (or return fallback). Pattern:
```typescript
private getState(): StateAdapter | null {
  try {
    return this.chat.getState()
  } catch {
    return null
  }
}
```

**New private method** in `LarkAdapter`:
```typescript
private async lookupUser(openId: string): Promise<string> {
  const state = this.getState()
  const cacheKey = `lark:user:${openId}`

  const cached = await state?.get<{ name: string }>(cacheKey)
  if (cached) return cached.name

  try {
    const res = await this.api.getUser(openId)
    const name = res.data?.user?.name ?? openId
    await state?.set(cacheKey, { name }, USER_CACHE_TTL_MS)
    return name
  } catch {
    this.logger.warn('Failed to lookup user', { openId })
    // Cache the fallback with a shorter TTL to avoid repeated failed API calls
    // (e.g., users outside the app's contact permission scope)
    await state?.set(cacheKey, { name: openId }, FAILED_LOOKUP_TTL_MS)
    return openId
  }
}
```

**Mentions as free cache source:** The `im.message.receive_v1` event includes a `mentions` array with `{ name, id: { open_id } }` for every @-mentioned user. The message factory should populate the user cache from mentions without extra API calls:
```typescript
for (const mention of data.message.mentions ?? []) {
  if (mention.name && mention.id?.open_id) {
    void state?.set(`lark:user:${mention.id.open_id}`, { name: mention.name }, USER_CACHE_TTL_MS)
  }
}
```

**Message handling change:**
- `handleMessageEvent` extracts `threadId` synchronously from `data.message.chat_id` / `data.message.root_id` (just `encodeThreadId`), then passes an `async () => Promise<Message>` factory to `chat.processMessage`. Note: `processMessage` accepts `Message | (() => Promise<Message>)` as the third argument — the factory form is already used by the Slack adapter and confirmed in the Chat SDK type definitions.
- The factory first seeds the cache from mentions, then calls `lookupUser(sender.open_id)` to resolve the author name, then calls `parseMessage` and overrides `Author.fullName` / `Author.userName` with the resolved name
- `buildAuthor()` helper remains unchanged — the factory overrides its output after calling `parseMessage`
- `handleReactionEvent`: call `lookupUser` within the existing async chain (inside the `.then()` after `resolveReactionThreadId`), use the result to populate `user.fullName` and `user.userName` instead of the current empty strings

**History fetch paths:** `fetchMessages()` and `fetchMessage()` both call `itemToMessage()`, which builds authors from raw Lark data without name resolution. Make `itemToMessage` async and call `lookupUser` to resolve the sender name:
```typescript
private async itemToMessage(item: LarkMessageItem, threadId: string): Promise<Message<LarkRaw>> {
  const sender = item.sender
  const senderId = sender?.id ?? ''
  const resolvedName = senderId ? await this.lookupUser(senderId) : 'unknown'
  // ... build author with resolvedName as fullName/userName
}
```
Callers (`fetchMessages`, `fetchMessage`, `fetchChannelMessages`) update to `await Promise.all(items.map(...))` for the array case.

**Scope boundary:** Only cache `name`. Do not build reverse indexes or thread participant tracking — Lark's mention system uses `open_id`, not display names, so outgoing mention resolution is not needed.

### 4. Channel Info Cache + DM Persistence

**Current:** `isDM()` and `getChannelVisibility()` rely on an in-memory `Set<string>` (`dmCache`) populated when P2P messages arrive. Lost on cold start in serverless.

**Target:** Cache channel metadata in the state adapter. Populate on message receipt and API fetch. Remove in-memory `dmCache`.

**Files:** `adapter.ts`

**Field declaration:**
```typescript
private readonly channelTypeMap = new Map<string, string>() // chatId → chatType ("p2p" | "group")
```

**chat_type vs chat_mode clarification:** Lark uses two different fields:
- Webhook event `im.message.receive_v1`: `chat_type` field — `"p2p"` for DMs, `"group"` for group chats
- REST API `GET /im/v1/chats/:chat_id`: `chat_type` (e.g., `"group"`) AND `chat_mode` (e.g., `"p2p"`, `"group"`, `"topic"`)

For DM detection, `chat_mode === "p2p"` from the REST API and `chat_type === "p2p"` from webhooks both work. To unify: always store the DM-relevant value as `chatType` in the cache. When populating from REST API responses, use `chat_mode` (more specific). When populating from webhook events, use `chat_type`. Both use `"p2p"` for DMs, so the check `chatType === "p2p"` works in both cases.

**Cache spec:**
- Key: `lark:channel:{chatId}`
- Type: `{ name?: string; chatType?: string }`
- TTL: 8 days
- Source: webhook event `chat_type` field, or REST API `chat_mode` field

**`lookupChannel` usage:** This method is used by `fetchThread()` and `fetchChannelInfo()` as a cache-first wrapper around `getChatInfo()`. It replaces the direct `api.getChatInfo()` calls in those methods, adding state adapter caching and local map write-through:

```typescript
private async lookupChannel(chatId: string): Promise<{ name?: string; chatType?: string }> {
  const state = this.getState()
  const cacheKey = `lark:channel:${chatId}`
  const cached = await state?.get<{ name?: string; chatType?: string }>(cacheKey)
  if (cached) {
    this.channelTypeMap.set(chatId, cached.chatType ?? '')
    return cached
  }

  try {
    const res = await this.api.getChatInfo(chatId)
    // Use chat_mode from REST API (more specific than chat_type)
    const info = { name: res.data?.name, chatType: res.data?.chat_mode ?? res.data?.chat_type }
    await state?.set(cacheKey, info, CHANNEL_CACHE_TTL_MS)
    this.channelTypeMap.set(chatId, info.chatType ?? '')
    return info
  } catch {
    this.logger.warn('Failed to lookup channel', { chatId })
    return {}
  }
}
```

**Changes to existing methods:**
- `fetchThread()`: use `lookupChannel(chatId)` instead of direct `api.getChatInfo()`. Build `ThreadInfo` from the cached result.
- `fetchChannelInfo()`: same — use `lookupChannel(chatId)`.
- `handleMessageEvent` factory: write channel cache from event data:
  ```typescript
  const chatType = data.message.chat_type
  if (chatType) {
    this.channelTypeMap.set(chatId, chatType)
    void state?.set(`lark:channel:${chatId}`, { chatType }, CHANNEL_CACHE_TTL_MS)
  }
  ```
- `isDM(threadId)`: check `channelTypeMap` synchronously, return `chatType === 'p2p'`. If miss, return `false` (conservative).
- `getChannelVisibility(threadId)`: check `channelTypeMap` synchronously, map to visibility. If miss, return `'unknown'`.
- `disconnect()`: call `this.channelTypeMap.clear()`.
- Remove `dmCache: Set<string>`.

**Cold start limitation (accepted):** `isDM()` may return `false` on cold start before the first message arrives from that chat. This is identical to current behavior and acceptable because Chat SDK uses `fetchThread()` / `fetchChannelInfo()` for authoritative DM detection — `isDM()` is a fast hint, not the source of truth.

### 5. Permissions

The `getUser` API requires two scopes:

| Permission | Description |
|---|---|
| `contact:contact.base:readonly` | Call the contacts API (required for any user lookup) |
| `contact:user.base:readonly` | Access the `name` field in user responses |

Both must be added to the README permissions table. A note about contact scope limitations should be added to the troubleshooting section.

## Constants

```typescript
const USER_CACHE_TTL_MS = 8 * 24 * 60 * 60 * 1000      // 8 days
const CHANNEL_CACHE_TTL_MS = 8 * 24 * 60 * 60 * 1000    // 8 days
const FAILED_LOOKUP_TTL_MS = 1 * 24 * 60 * 60 * 1000    // 1 day
```

## Files Changed

| File | Action | Summary |
|------|--------|---------|
| `src/types.ts` | Edit | Add `logger` to config |
| `src/factory.ts` | Edit | Pass logger through |
| `src/adapter.ts` | Edit | Major: remove dedup/dmCache, add logger init, add lookupUser/lookupChannel, message factory pattern, async itemToMessage |
| `src/api-client.ts` | Edit | Add `getUser()` method |
| `src/dedup-cache.ts` | Delete | No longer needed |
| `tests/dedup-cache.test.ts` | Delete | No longer needed |
| `tests/adapter.test.ts` | Edit | Remove dedup tests, add cache tests |
| `README.md` | Edit | Add logger to config table, add contact permissions, add contact scope troubleshooting |

## Testing Strategy

- **lookupUser:** Mock state adapter `get/set`, mock `api.getUser()`. Verify cache hit skips API. Verify cache miss calls API and writes cache. Verify failure falls back to openId and caches with short TTL. Verify mentions seed the cache.
- **lookupChannel:** Same pattern. Verify write-through on message receipt. Verify fetchThread/fetchChannelInfo use lookupChannel.
- **isDM / getChannelVisibility:** Verify they read from local channelTypeMap. Verify map is populated from message events and lookupChannel calls.
- **itemToMessage:** Verify it calls lookupUser and resolves author names.
- **Logger:** Verify config logger is used. Verify default ConsoleLogger when not provided.
- **Dedup removal:** Verify duplicate events are forwarded (no adapter-level filtering). Chat SDK handles dedup.
- **No state adapter:** Verify adapter works without state adapter — lookupUser/lookupChannel skip caching, still resolve via API.

## Not In Scope

- Reverse user name index (Lark uses `open_id` for mentions, not display names)
- Thread participant tracking
- Multi-workspace / ISV token storage (future work)
- User avatar enrichment beyond name
