# Card V2 + Native Streaming Refactor

## Problem

The current implementation uses Lark card JSON v1 structure and a placeholder+edit streaming approach. Both are outdated:

- Card v1 is no longer maintained. v2 is required for streaming, `element_id`, and new components.
- The placeholder+edit streaming (post `"..."`, then throttled `editMessage`) bypasses Lark's native CardKit streaming API, which provides client-side typewriter animation, better rate limits, and a proper lifecycle.

## Scope

Upgrade card output to v2 JSON structure and replace streaming with CardKit native API. No backward compatibility with v1 or pre-7.20 clients.

### Files changed

| File | Change |
|------|--------|
| `src/card-mapper.ts` | Rewrite output to v2 structure |
| `src/api-client.ts` | Add CardKit API methods |
| `src/adapter.ts` | Rewrite `stream()`, update card sending path |
| `src/types.ts` | Add CardKit types |
| `tests/card-mapper.test.ts` | Update all assertions for v2 |
| `tests/api-client.test.ts` | Add CardKit method tests |
| `tests/adapter.test.ts` | Rewrite stream + card tests |
| `tests/integration.test.ts` | Update streaming E2E |

### Files unchanged

- `src/dedup-cache.ts` — internal utility, unaffected
- `src/event-bridge.ts` — event handling, unaffected
- `src/format-converter.ts` — receive-side parsing, already v2 compatible
- `src/factory.ts` — no changes needed

## Design

### 1. card-mapper.ts — v2 structure

Output format changes:

```json
{
  "schema": "2.0",
  "config": { "update_multi": true },
  "header": {
    "title": { "tag": "plain_text", "content": "Title" },
    "template": "blue"
  },
  "body": {
    "elements": [
      { "tag": "markdown", "content": "...", "element_id": "el_0" },
      { "tag": "hr", "element_id": "el_1" },
      { "tag": "img", "img_key": "...", "alt": { "tag": "plain_text", "content": "" }, "element_id": "el_2" },
      { "tag": "button", "text": { "tag": "plain_text", "content": "Click" }, "type": "primary", "element_id": "el_3" }
    ]
  }
}
```

Key changes:

- Top-level `schema: "2.0"` and `config.update_multi: true`.
- Auto-generated `element_id` on every element (`el_0`, `el_1`, ...).
- `actions` wrapper removed — buttons are standalone elements in the `elements` array.
- `section` degrades to `markdown` (unchanged behavior).
- `cardToFallbackText` unchanged.

### 2. api-client.ts — CardKit methods

Three new methods using `client.cardkit.*` from `@larksuiteoapi/node-sdk` v1.60.0:

| Method | SDK call | Purpose |
|--------|----------|---------|
| `createCard(cardJson: string)` | `cardkit.card.create` | Create card entity, return `card_id` |
| `streamUpdateText(cardId, elementId, content, sequence)` | `cardkit.card.element.content` | Push full text for typewriter rendering |
| `updateCardSettings(cardId, settings: string, sequence)` | `cardkit.card.settings` | Toggle `streaming_mode`, update config |

All wrapped in existing `call()` error handler. CardKit-specific error codes (300309, 200740, 200850, etc.) mapped to appropriate adapter errors.

### 3. adapter.ts — streaming and card sending

#### 3a. Card sending via card_id

For card messages in `postMessage`:

1. `cardMapper.cardToLarkInteractive(card)` produces v2 JSON.
2. `api.createCard(JSON.stringify(v2Json))` returns `card_id`.
3. Send message with `content: '{"type":"card","data":{"card_id":"..."}}'`, `msg_type: "interactive"`.

Non-card messages (text, markdown, file) are unaffected.

#### 3b. stream() rewrite

```
async stream(threadId, textStream):
  1. Build v2 card JSON with streaming_mode=true, one markdown element (element_id="stream_md")
  2. api.createCard(json) → card_id
  3. Send card message via card_id → message_id
  4. sequence = 1
  5. for await (chunk of textStream):
       accumulated += chunkToText(chunk)
       api.streamUpdateText(card_id, "stream_md", accumulated, sequence++)
  6. finally:
       api.updateCardSettings(card_id, {streaming_mode: false}, sequence++)
  7. return { id: message_id, ... }
```

Removed: `STREAM_THROTTLE_MS`, `STREAM_PLACEHOLDER`, `throttledEdit()`.

The Lark client handles typewriter animation natively (default 70ms per character). No client-side throttling needed.

#### 3c. editMessage

`im.message.patch` remains for non-streaming card updates. No change needed.

### 4. types.ts

Add:

```ts
interface CardKitCard {
  cardId: string
  elementId: string
}
```

### 5. Testing

- **card-mapper.test.ts**: Assert `schema: "2.0"`, `element_id` presence, buttons not wrapped in `action`.
- **api-client.test.ts**: MSW mocks for `POST /cardkit/v1/cards`, `PUT .../content`, `PATCH .../settings`.
- **adapter.test.ts**: Stream tests rewritten to verify CardKit flow (createCard → send → streamUpdateText → updateCardSettings).
- **integration.test.ts**: Streaming E2E updated.

### 6. Cleanup

Deleted code:

- `STREAM_THROTTLE_MS`, `STREAM_PLACEHOLDER` constants
- `throttledEdit()` method
- `mapActions()` function (v2 deprecates `action` tag)
- placeholder+edit streaming loop

## Permissions

CardKit APIs require the `cardkit:card:write` permission scope. This is a deployment concern for SDK users, documented in README.

## Constraints

- Card entities expire after 14 days.
- Each card entity can only be sent once.
- Max 200 elements per card.
- Streaming mode auto-closes after 10 minutes.
- Max 10 API calls/second per card entity in streaming mode.
