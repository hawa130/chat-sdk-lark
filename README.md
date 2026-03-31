# chat-adapter-lark

[![npm version](https://img.shields.io/npm/v/chat-adapter-lark)](https://www.npmjs.com/package/chat-adapter-lark)
[![npm downloads](https://img.shields.io/npm/dm/chat-adapter-lark)](https://www.npmjs.com/package/chat-adapter-lark)

Lark (飞书) adapter for [Chat SDK](https://chat-sdk.dev/docs). Supports both Feishu (China) and Lark (International) domains.

## Installation

```bash
pnpm add chat chat-adapter-lark
```

## Usage

The adapter auto-detects `LARK_APP_ID` and `LARK_APP_SECRET` from environment variables:

```typescript
import { Chat } from 'chat'
import { createLarkAdapter } from 'chat-adapter-lark'

const bot = new Chat({
  adapters: {
    lark: createLarkAdapter(),
  },
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

**Express:**

```typescript
app.post('/webhook/lark', async (req, res) => {
  const response = await bot.webhooks.lark(req)
  res.status(response.status).send(await response.text())
})
```

## Lark app setup

### 1. Create application

1. Go to [open.feishu.cn](https://open.feishu.cn) (or [open.larksuite.com](https://open.larksuite.com) for international)
2. Create a **Custom App**
3. Add the **Bot** capability under Features

### 2. Configure events

1. Set the event subscription URL to your webhook endpoint
2. URL verification is handled automatically — no extra setup needed
3. Subscribe to the following events:
   - `im.message.receive_v1` — Receive messages
   - `im.message.reaction.created_v1` — Reaction added
   - `im.message.reaction.deleted_v1` — Reaction removed
   - `card.action.trigger` — Card button/form interactions

### 3. Add permissions

Add the following scopes to your app:

| Permission                         | Description                                      |
| ---------------------------------- | ------------------------------------------------ |
| `im:message`                       | Read, send, edit, and delete messages            |
| `im:message.group_at_msg:readonly` | Receive @bot messages in group chats             |
| `im:message.p2p_msg:readonly`      | Receive direct messages                          |
| `im:message.reactions:read`        | Receive reaction events                          |
| `im:chat:readonly`                 | Read chat info                                   |
| `im:chat:create`                   | Create DM conversations (for `openDM`)           |
| `im:resource`                      | Upload and download images and files             |
| `contact:contact.base:readonly`    | Call the contacts API (for user name resolution) |
| `contact:user.base:readonly`       | Access user display names                        |
| `contact:user.id:readonly`         | Read user IDs                                    |

### 4. Publish

Publish the app to make it available in your workspace.

## Feishu vs Lark

The `domain` option controls which API endpoint is used. Use `"feishu"` for mainland China and `"lark"` for international:

```typescript
import { Domain } from '@larksuiteoapi/node-sdk'

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
