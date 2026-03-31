# chat-adapter-lark

[![npm version](https://img.shields.io/npm/v/chat-adapter-lark)](https://www.npmjs.com/package/chat-adapter-lark)
[![npm downloads](https://img.shields.io/npm/dm/chat-adapter-lark)](https://www.npmjs.com/package/chat-adapter-lark)

Lark (飞书) adapter for [Chat SDK](https://chat-sdk.dev/docs). Supports both Feishu (China) and Lark (International) domains.

## Installation

```bash
npm install chat chat-adapter-lark @chat-adapter/state-memory
```

## Usage

The adapter auto-detects `LARK_APP_ID` and `LARK_APP_SECRET` from environment variables:

```typescript
import { Chat } from 'chat'
import { createLarkAdapter } from 'chat-adapter-lark'
import { createMemoryState } from '@chat-adapter/state-memory'

const bot = new Chat({
  userName: 'my-bot',
  adapters: {
    lark: createLarkAdapter(),
  },
  state: createMemoryState(),
})

bot.onNewMention(async (thread, message) => {
  await thread.post(`You said: ${message.text}`)
})
```

## Webhook setup

Point your Lark event subscription URL to your deployed endpoint:

**Next.js App Router:**

```typescript
// app/api/webhook/lark/route.ts
export async function POST(request: Request) {
  return bot.webhooks.lark(request)
}
```

**Hono:**

```typescript
app.post('/webhook/lark', (c) => bot.webhooks.lark(c.req.raw))
```

Webhook handlers use the standard [Fetch API](https://developer.mozilla.org/en-US/docs/Web/API/Request) `Request`/`Response` types. Frameworks that don't natively provide a Fetch `Request` (e.g. Express) need a conversion step — see your framework's docs for how to adapt incoming requests.

## Lark app setup

### 1. Create application

1. Go to [open.feishu.cn](https://open.feishu.cn) (or [open.larksuite.com](https://open.larksuite.com) for international)
2. Create a **Custom App**
3. Add the **Bot** capability under Features

### 2. Configure events and callbacks

1. Set the event subscription URL to your webhook endpoint
2. URL verification is handled automatically — no extra setup needed
3. Under **Event configuration**, subscribe to the following events:
   - `im.message.receive_v1` — Receive messages (required)
   - `im.message.reaction.created_v1` — Reaction added (if using reactions)
   - `im.message.reaction.deleted_v1` — Reaction removed (if using reactions)
4. Under **Callback configuration**, add the following callback:
   - `card.action.trigger` — Card button/form interactions (if using interactive cards)

### 3. Add permissions

Add the following scopes to your app. The table maps each permission to the adapter functionality that requires it.

**Core — required for basic messaging:**

| Permission                         | Lark API                                      | Adapter feature                      |
| ---------------------------------- | --------------------------------------------- | ------------------------------------ |
| `im:message:send_as_bot`           | Send, reply, edit, delete messages            | Post, edit, delete messages          |
| `im:message:readonly`              | Get, list messages; get message resources     | Fetch messages and message history   |
| `im:message.group_at_msg:readonly` | `im.message.receive_v1` event (group @bot)    | Receive @bot messages in group chats |
| `im:message.p2p_msg:readonly`      | `im.message.receive_v1` event (DM)            | Receive direct messages              |
| `im:chat:readonly`                 | `GET /im/v1/chats/:chat_id`                   | `fetchChannelInfo`                   |
| `contact:user.base:readonly`       | `GET /contact/v3/users/:user_id` (name field) | Resolve user display names           |

**Feature-specific — add based on the features you use:**

| Permission                        | Lark API                                           | Adapter feature                    |
| --------------------------------- | -------------------------------------------------- | ---------------------------------- |
| `im:message.reactions:write_only` | Add/remove reactions                               | `addReaction`, `removeReaction`    |
| `im:resource`                     | `POST /im/v1/images`, `POST /im/v1/files`          | File and image uploads             |
| `cardkit:card:write`              | `POST /cardkit/v1/cards`, element/settings updates | Card streaming                     |
| `im:chat:create`                  | `POST /im/v1/chats`                                | Create DM conversations (`openDM`) |

> **Note:** `im:message:readonly` also covers reaction events (`im.message.reaction.created/deleted_v1`) and listing reactions, so no additional permission is needed for receiving reaction events.

### 4. Publish

Publish the app to make it available in your workspace.

## Feishu vs Lark

The `domain` option controls which API endpoint is used. Use `"feishu"` for mainland China and `"lark"` for international:

```typescript
import { createLarkAdapter, Domain } from 'chat-adapter-lark'

// China (Feishu, default)
createLarkAdapter({ domain: Domain.Feishu })

// International (Lark)
createLarkAdapter({ domain: Domain.Lark })
```

Or set `LARK_DOMAIN=lark` in your environment variables.

## Configuration

All options are auto-detected from environment variables when not provided. You can call `createLarkAdapter()` with no arguments if the env vars are set.

| Option              | Type           | Default                   | Description                                             |
| ------------------- | -------------- | ------------------------- | ------------------------------------------------------- |
| `appId`             | `string`       | `LARK_APP_ID`             | Lark App ID                                             |
| `appSecret`         | `string`       | `LARK_APP_SECRET`         | Lark App Secret                                         |
| `encryptKey`        | `string`       | `LARK_ENCRYPT_KEY`        | Encrypt key for event decryption                        |
| `verificationToken` | `string`       | `LARK_VERIFICATION_TOKEN` | Verification token for v1 events                        |
| `domain`            | `Domain`       | `Domain.Feishu`           | API domain (`Domain.Feishu` or `Domain.Lark`)           |
| `userName`          | `string`       | Bot name from API         | Bot display name override                               |
| `disableTokenCache` | `boolean`      | `false`                   | Disable SDK's internal token caching                    |
| `logger`            | `Logger`       | `ConsoleLogger`           | Custom logger instance (from `chat` package)            |
| `appType`           | `AppType`      | `AppType.SelfBuild`       | App type (`AppType.SelfBuild` or `AppType.ISV`)         |
| `cache`             | `Cache`        | SDK default               | Custom token cache (e.g. Redis) for distributed deploys |
| `httpInstance`      | `HttpInstance` | SDK default               | Custom HTTP client for proxy, timeout, or interceptors  |

`appId` and `appSecret` are required — either via config or environment variables. `Domain`, `AppType`, `Cache`, and `HttpInstance` types are re-exported from `@larksuiteoapi/node-sdk`.

## Environment variables

```bash
LARK_APP_ID=cli_xxxx
LARK_APP_SECRET=xxxx
LARK_ENCRYPT_KEY=xxxx            # Optional, for event decryption
LARK_VERIFICATION_TOKEN=xxxx     # Optional, for v1 event verification
LARK_DOMAIN=feishu               # Optional, "feishu" (default) or "lark"
```

## Features

### Messaging

| Feature        | Supported      |
| -------------- | -------------- |
| Post message   | Yes            |
| Edit message   | Yes            |
| Delete message | Yes            |
| File uploads   | Yes            |
| Streaming      | Card streaming |

### Rich content

| Feature         | Supported                              |
| --------------- | -------------------------------------- |
| Card format     | Interactive Cards                      |
| Buttons         | Yes                                    |
| Link buttons    | Yes                                    |
| Select menus    | Yes                                    |
| Tables          | Yes                                    |
| Fields          | Yes                                    |
| Images in cards | Yes                                    |
| Modals          | Yes (emulated via form container card) |

### Conversations

| Feature            | Supported                                 |
| ------------------ | ----------------------------------------- |
| Mentions           | Yes                                       |
| Add reactions      | Yes                                       |
| Remove reactions   | Yes                                       |
| Typing indicator   | No                                        |
| DMs                | Yes                                       |
| Ephemeral messages | Yes (fire-and-forget, cannot edit/delete) |

### Message history

| Feature                | Supported |
| ---------------------- | --------- |
| Fetch messages         | Yes       |
| Fetch single message   | Yes       |
| Fetch thread info      | Yes       |
| Fetch channel messages | Yes       |
| List threads           | No        |
| Fetch channel info     | Yes       |
| Post channel message   | Yes       |

## Troubleshooting

### Bot not responding to messages

1. Verify the event subscription URL is correct and accessible
2. Check that the bot has been added to the group
3. Ensure required permissions are granted and the app is published

### Events received but not processed

1. Check `encryptKey` if event encryption is enabled in the Lark console
2. Verify `verificationToken` for v1 event format

### User names showing as IDs

The adapter resolves user display names via the contacts API. If names show as `ou_xxxxx` IDs:

1. Add `contact:contact.base:readonly` and `contact:user.base:readonly` permissions
2. Expand the app's contact scope (通讯录权限范围) in the Lark admin console to include the users you need

## Contributing

Contributions are welcome. Please open an issue to discuss significant changes before submitting a pull request.

## License

MIT
