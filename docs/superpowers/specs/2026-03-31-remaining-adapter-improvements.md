# Remaining Adapter Improvements

**Date:** 2026-03-31
**Goal:** Address 4 remaining gaps vs official Chat SDK adapter patterns: attachment parsing, export cleanup, webhook context isolation, ephemeral documentation.

## 1. Incoming Message Attachment Parsing

**Problem:** `parseMessage` and `itemToMessage` always return `attachments: []`. Image, file, audio, and video messages are treated as text (the raw JSON content string becomes the message text).

**Solution:** Detect `message_type` and populate `Attachment[]` with lazy `fetchData` closures.

### New types in `types.ts`

```typescript
interface LarkImageContent { image_key: string }
interface LarkFileContent { file_key: string; file_name: string }
interface LarkAudioContent { file_key: string; duration: number }
interface LarkMediaContent { file_key: string; image_key: string; file_name: string; duration: number }
```

### New API method in `api-client.ts`

```typescript
async downloadResource(messageId: string, fileKey: string, type: 'image' | 'file') {
  return this.call(() =>
    this.client.im.messageResource.get({
      path: { message_id: messageId, file_key: fileKey },
      params: { type },
    }),
  )
}
```

### Changes to `adapter.ts`

Add a private method to build attachments from message content:

```typescript
private buildAttachments(messageId: string, messageType: string, content: string): Attachment[] {
  try {
    const parsed = JSON.parse(content)
    switch (messageType) {
      case 'image': {
        const { image_key } = parsed as LarkImageContent
        return [{
          type: 'image',
          fetchData: () => this.downloadResourceBuffer(messageId, image_key, 'image'),
        }]
      }
      case 'file': {
        const { file_key, file_name } = parsed as LarkFileContent
        return [{
          type: 'file',
          name: file_name,
          fetchData: () => this.downloadResourceBuffer(messageId, file_key, 'file'),
        }]
      }
      case 'audio': {
        const { file_key } = parsed as LarkAudioContent
        return [{
          type: 'audio',
          fetchData: () => this.downloadResourceBuffer(messageId, file_key, 'file'),
        }]
      }
      case 'media': {
        const { file_key, file_name } = parsed as LarkMediaContent
        return [{
          type: 'video',
          name: file_name,
          fetchData: () => this.downloadResourceBuffer(messageId, file_key, 'file'),
        }]
      }
      default:
        return []
    }
  } catch {
    return []
  }
}
```

`downloadResourceBuffer` wraps `api.downloadResource` and converts the response stream to Buffer.

Update `parseMessage` and `itemToMessage` to call `buildAttachments` and pass result to `Message` constructor instead of `[]`.

For `extractText`: when `message_type` is image/file/audio/media, return empty string instead of the raw JSON content.

### Permissions

Requires `im:resource` scope (already documented in README).

## 2. Remove Internal Exports

**Problem:** `index.ts` exports `LarkApiClient`, `LarkFormatConverter`, and `cardMapper` — these are internal implementation details. Official adapters only export the adapter class, factory, and user-facing types.

**Solution:** Remove from `index.ts`:

```typescript
// REMOVE:
export { LarkApiClient } from './api-client.ts'
export { LarkFormatConverter } from './format-converter.ts'
export { cardMapper } from './card-mapper.ts'
```

Keep:
```typescript
export type { LarkThreadId, LarkAdapterConfig, LarkRawMessage, LarkRaw } from './types.ts'
export { LarkAdapter } from './adapter.ts'
export { createLarkAdapter } from './factory.ts'
```

This is a **breaking change** for anyone importing these internals. Bump minor version since we're pre-1.0.

## 3. AsyncLocalStorage for Webhook Context

**Problem:** `pendingWebhookOptions` is a mutable instance variable shared across concurrent webhook requests. If two webhooks arrive simultaneously, the second overwrites the first's options — a race condition.

**Solution:** Replace with `AsyncLocalStorage` from `node:async_hooks`, following the Slack adapter pattern.

### Changes to `adapter.ts`

```typescript
import { AsyncLocalStorage } from 'node:async_hooks'

// In class:
private readonly webhookContext = new AsyncLocalStorage<WebhookOptions | undefined>()

// Remove: private pendingWebhookOptions?: WebhookOptions
```

Update `handleEvent`:
```typescript
private handleEvent(body: LarkWebhookBody, options?: WebhookOptions): Response {
  if (body.header?.event_type === 'card.action.trigger') {
    this.webhookContext.run(options, () => {
      this.handleCardAction(body as LarkCardActionBody)
    })
  } else {
    this.webhookContext.run(options, () => {
      this.dispatchEvent(body)
    })
  }
  return new Response('ok', { status: 200 })
}
```

Update `dispatchEvent` — remove `options` parameter:
```typescript
private dispatchEvent(body: LarkWebhookBody): void {
  void (this.dispatcher.invoke(body as Record<string, unknown>) as Promise<unknown>)
    .catch((err: unknown) => {
      this.logger.error('Event processing error', err)
    })
}
```

All handlers retrieve options from context:
```typescript
private handleMessageEvent(data: EventData<'im.message.receive_v1'>): void {
  const options = this.webhookContext.getStore()
  // ...
}
```

Same for `handleReactionEvent`, `handleCardAction`.

## 4. Ephemeral Documentation

**Problem:** `postEphemeral` returns `id: ''` with no explanation. Lark's ephemeral API is fire-and-forget — it does not return a message ID.

**Solution:** No code changes. Add documentation:

In README Features table, change:
```
| Ephemeral messages | Interactive cards only |
```
to:
```
| Ephemeral messages | Yes (fire-and-forget, cannot edit/delete) |
```

Add inline code comment in `postEphemeral`:
```typescript
// Lark ephemeral API does not return a message ID — messages cannot be edited or deleted
```

## Files Changed

| File | Action | Summary |
|------|--------|---------|
| `src/types.ts` | Edit | Add LarkImageContent, LarkFileContent, LarkAudioContent, LarkMediaContent |
| `src/api-client.ts` | Edit | Add downloadResource method |
| `src/adapter.ts` | Edit | Add buildAttachments, downloadResourceBuffer, AsyncLocalStorage, update parseMessage/itemToMessage/handleEvent/handlers |
| `src/index.ts` | Edit | Remove LarkApiClient, LarkFormatConverter, cardMapper exports |
| `tests/adapter.test.ts` | Edit | Add attachment tests, update webhook context tests |
| `README.md` | Edit | Update ephemeral description |

## Testing

- **Attachments:** Mock MSW handler for `/im/v1/messages/:id/resources/:key`, test image/file/audio/media message types produce correct Attachment objects with working fetchData
- **AsyncLocalStorage:** Verify concurrent webhook handling delivers correct options to each handler (send two webhooks, verify each gets its own options)
- **Exports:** Verify only public API types are accessible (compile-time check)
