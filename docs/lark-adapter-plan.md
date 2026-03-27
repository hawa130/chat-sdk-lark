# 飞书 (Lark) Chat SDK 社区适配器 — 生产就绪开发计划

## 总体原则

- **测试伴生**：每个实现任务自带测试要求，不存在独立的"测试阶段"
- **一次成型**：直接按生产标准实现全部功能，不做 MVP 裁剪
- **Agent 友好**：每个任务明确标注「检索什么」和「做什么」，可直接分派

---

## 任务 0 — 知识准备

> 所有后续任务的前置依赖。不写一行代码，只读文档、产出速查表。

### 0.1 Chat SDK 适配器合约

**检索**：

- `https://chat-sdk.dev/docs/contributing/building` — 完整通读，这是适配器接口的权威定义
- `https://chat-sdk.dev/docs/contributing/testing` — 测试规范和测试工具
- `https://chat-sdk.dev/docs/contributing/documenting` — 文档规范
- `https://chat-sdk.dev/docs/contributing/publishing` — 发布清单
- `https://chat-sdk.dev/docs/api` — API 参考首页，从这里跳转到 Chat / Thread / Message / PostableMessage / Cards / Markdown / Modals 各子页
- `https://chat-sdk.dev/docs/streaming` — 流式输出文档
- `https://chat-sdk.dev/docs/cards` — Card JSX 组件体系
- `https://chat-sdk.dev/docs/modals` — Modal 对话框（了解限制：目前仅 Slack 支持）
- `https://chat-sdk.dev/docs/direct-messages` — DM 行为约定（如 isMention 自动 true）
- `https://chat-sdk.dev/docs/handling-events` — 事件处理流程
- `https://chat-sdk.dev/docs/concurrency` — 并发与消息重叠处理

**产出**：

- Adapter 接口必须方法 + 可选方法 的完整清单（含方法签名）
- `Message` 构造字段速查表（注意 `author.isBot: boolean | "unknown"`、`metadata.dateSent`、`metadata.edited`）
- `@chat-adapter/shared` 所有导出的工具函数和错误类列表

### 0.2 官方适配器参考实现

**检索**：

- `https://github.com/vercel/chat/tree/main/packages/adapter-telegram/src` — 重点参考，与飞书最相似（webhook 驱动、token 鉴权、非 Slack 平台的 streaming 降级）
- `https://github.com/vercel/chat/tree/main/packages/adapter-discord/src` — 参考其 `markdown.ts`（平台特有 mention 语法处理）
- `https://github.com/vercel/chat/tree/main/packages/adapter-whatsapp/src` — 参考社区 PR → 官方适配器的演进路径
- `https://github.com/beeper/chat-adapter-matrix` — 唯一 vendor-official 社区适配器，参考包结构、README 格式
- `https://github.com/vercel/chat/tree/main/packages/integration-tests/src` — 官方集成测试的写法和组织方式

**重点关注**：

- Telegram 适配器的 `stream()` 方法如何用 `editMessage` 做 fallback streaming
- Telegram 适配器的 `handleWebhook` 如何处理不同事件类型的路由
- Discord 适配器如何做卡片到 embed 的映射和降级
- 集成测试中 `MemoryStateAdapter` 的使用模式
- 各适配器的 `format-converter` 如何在 `toAst`/`fromAst` 中处理平台特有语法

### 0.3 飞书开放平台 API 全景

**检索**：

- IM v1 API 总览：`https://open.larksuite.com/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1`
- 发送消息：`https://open.larksuite.com/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/create`
- 接收消息事件：`https://open.larksuite.com/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/events/receive`
- 消息内容格式（text / post / image / interactive 的 JSON schema）：搜索 "larksuite message content types"
- 飞书消息卡片组件文档：搜索 "larksuite interactive card components json"
- 事件订阅与安全（加密方案、token 验证、URL verification challenge）：搜索 "larksuite event subscription encrypt key verification"
- **飞书官方 Node SDK（作为运行时依赖）**：`https://github.com/larksuite/node-sdk` — 重点研读以下模块：
  - `client/` — `lark.Client` 的构造参数（`appId`/`appSecret`/`domain`/`appType`/`disableTokenCache`），了解其内部 token 自动管理机制
  - `dispatcher/` — `lark.EventDispatcher` 的构造参数（`encryptKey`）、`.register()` 方法、以及内置的解密+challenge 自动处理
  - `utils/` — `lark.AESCipher` 解密工具
  - `typings/` — 事件 payload 类型定义（`im.message.receive_v1` 的 data 结构）
  - `adaptor/` — `adaptDefault`/`adaptExpress`/`adaptKoa` 的实现方式，理解 `invoke()` 自定义适配器入口
  - `ws-client/` — `lark.WSClient` 长连接模式（了解即可，适配器层优先用 webhook）
  - `http/` — SDK 的 HTTP 实例和拦截器机制
  - npm 包名：`@larksuiteoapi/node-sdk`
- 飞书 API 速率限制文档：搜索 "larksuite api rate limit"
- 飞书临时消息 API：搜索 "larksuite ephemeral message api"
- 飞书文件/图片上传 API：搜索 "larksuite im v1 files images upload"
- 飞书 bot info API：`/open-apis/bot/v3/info`

**产出**：一张双列映射表 ——

| Adapter 方法              | 飞书 API 端点                                                           | 注意事项                                   |
| ------------------------- | ----------------------------------------------------------------------- | ------------------------------------------ |
| `postMessage`             | `POST /open-apis/im/v1/messages?receive_id_type=chat_id`                | content 是 JSON 字符串                     |
| `postMessage`（话题回复） | `POST /open-apis/im/v1/messages/{message_id}/reply`                     |                                            |
| `editMessage`             | `PUT /open-apis/im/v1/messages/{message_id}`                            | 仅支持 text/post/interactive               |
| `deleteMessage`           | `DELETE /open-apis/im/v1/messages/{message_id}`                         | 即撤回                                     |
| `addReaction`             | `POST /open-apis/im/v1/messages/{message_id}/reactions`                 |                                            |
| `removeReaction`          | `DELETE /open-apis/im/v1/messages/{message_id}/reactions/{reaction_id}` | 需要 reaction_id 非 emoji 名               |
| `fetchMessages`           | `GET /open-apis/im/v1/messages?container_id_type=chat&container_id=...` | 分页                                       |
| `fetchMessage`            | `GET /open-apis/im/v1/messages/{message_id}`                            |                                            |
| `fetchThread`             | `GET /open-apis/im/v1/chats/{chat_id}`                                  |                                            |
| `openDM`                  | `POST /open-apis/im/v1/chats`                                           | chat_mode=p2p                              |
| `stream`                  | 复用 `editMessage`，节流调用                                            | 飞书无原生 streaming                       |
| `postEphemeral`           | `POST /open-apis/ephemeral/v1/send`                                     | 仅 interactive                             |
| 文件上传                  | `POST /open-apis/im/v1/images` / `POST /open-apis/im/v1/files`          | 先传获得 key                               |
| 鉴权                      | **由 `lark.Client` 内部自动管理**                                       | SDK 自动获取/缓存/刷新 tenant_access_token |
| 事件解密/验证             | **由 `lark.EventDispatcher` 内部自动处理**                              | SDK 内置 AES 解密 + challenge 响应         |
| bot 信息                  | `GET /open-apis/bot/v3/info`                                            | 获取 open_id                               |

---

## 任务 1 — 项目骨架与工程配置

**检索**：任务 0 产出的 Chat SDK contributing/building 文档中的 project setup 章节

**做什么**：

- 包名 `chat-adapter-lark`（`@chat-adapter/` scope 为 Vercel 保留）
- `package.json`：`"type": "module"`、`chat` 为 peerDependency `^4.0.0`、`@chat-adapter/shared` 为 dependency、`@larksuiteoapi/node-sdk` 为 dependency、`keywords: ["chat-sdk", "chat-adapter", "lark", "feishu"]`
- `tsup.config.ts`：ESM only、dts、sourcemap
- `tsconfig.json`：`target ES2022`、`strict: true`、`moduleResolution: bundler`
- `vitest.config.ts`：globals、node 环境、v8 coverage
- 安装 `msw`（Mock Service Worker）作为 devDependency，用于 mock 飞书 HTTP API
- `.github/workflows/ci.yml`：lint → typecheck → test → build 流水线
- `.npmignore` 或 `"files": ["dist"]` 确保发布干净

**验证方法**：

- `npm run build` 成功产出 `dist/index.js` + `dist/index.d.ts`
- `npm run typecheck` 零错误
- `npm pack --dry-run` 只包含 `dist/`、`package.json`、`README.md`

---

## 任务 2 — 类型系统

**检索**：

- 任务 0.3 产出的 API 映射表
- 飞书 Node SDK 的类型导出：`import * as lark from '@larksuiteoapi/node-sdk'`，检查 `lark.Client` 构造参数类型、`EventDispatcher` 回调的 data 类型
- `https://github.com/larksuite/node-sdk/tree/main/typings` — SDK 完整类型定义目录
- Chat SDK 的 `Adapter<TThreadId, TRawMessage>` 泛型约束

**做什么**：

- `LarkThreadId`：`{ chatId: string; rootMessageId?: string }`
- `LarkAdapterConfig`：`appId`、`appSecret`、`encryptKey?`、`verificationToken?`、`domain?`（使用 SDK 的 `lark.Domain.Feishu` / `lark.Domain.Lark`，默认 Feishu）、`userName?`、`disableTokenCache?`
- 从 SDK 复用的类型：`lark.EventDispatcher` 回调 data 中 `im.message.receive_v1` 的事件结构（无需自定义 `LarkMessageReceiveEvent`，直接用 SDK 提供的类型）
- 仍需自定义的类型：`LarkThreadId`、`LarkAdapterConfig`、以及 Chat SDK 适配层需要的桥接类型

**测试**：

- 类型本身不需运行时测试，但写 type-level 测试确保 `LarkAdapter` 满足 `Adapter<LarkThreadId, LarkEventMessage>` 约束（`tsc --noEmit` 验证）

---

## 任务 3 — 安全层：基于飞书 SDK 的事件接入

> 不自己实现 AES 解密和 token 验证——飞书官方 SDK 已经内建了这些能力。本任务的核心是把 SDK 的 `EventDispatcher` 桥接到 Chat SDK 的 `handleWebhook` 流程中。

**检索**：

- `https://github.com/larksuite/node-sdk/tree/main/dispatcher` — `EventDispatcher` 源码，理解 `.register()` 和 `.invoke()` 的内部流程（解密 → challenge 应答 → 路由 → 回调）
- `https://github.com/larksuite/node-sdk/tree/main/utils` — `AESCipher` 实现，了解其与 `EventDispatcher` 的关系
- `https://github.com/larksuite/node-sdk/tree/main/adaptor` — `adaptDefault` 源码，理解如何把 HTTP request 传给 `dispatcher.invoke()`，这是我们桥接到 Chat SDK `handleWebhook` 的关键参考
- 飞书 SDK README 中 "Challenge check" 章节 — `autoChallenge: true` 的工作方式
- 飞书 SDK README 中 "Custom adapter" 章节 — 自定义适配器调用 `dispatcher.invoke(assigned)` 的模式

**做什么**：

- 在适配器 `initialize()` 时创建 `lark.EventDispatcher({ encryptKey })` 实例，通过 `.register()` 注册 `im.message.receive_v1` 等事件
- 在 `handleWebhook()` 中，仿照 SDK 的 `adaptDefault` 实现：从 Request 提取 body + headers → 构造 `Object.assign(Object.create({ headers }), data)` → 调用 `dispatcher.invoke(assigned)` → 返回结果
- SDK 内部自动完成：AES-256-CBC 解密、`header.token` 验证、URL verification challenge 应答
- 适配器层只需关注：从 SDK 回调的 data 中提取消息 → 构造 Chat SDK 的 `Message` → 调用 `processMessage()`
- 事件去重仍由适配器自己做（SDK 不做去重）：LRU 缓存 event_id，FIFO 淘汰防内存泄漏

**测试**（`event-bridge.test.ts`）：

- 构造一条 `im.message.receive_v1` 的原始 webhook request → 传入 `handleWebhook` → 验证 SDK EventDispatcher 的回调被触发、Chat SDK 的 `processMessage` 被调用
- URL verification challenge → 验证返回正确的 `{ challenge }` JSON
- 加密事件：使用 `lark.AESCipher` 加密一段 payload → 传入 → 验证被正确解密并路由
- 去重：同一 event_id 发两次 → 第二次静默跳过
- 无效请求体 → 400

---

## 任务 4 — API 客户端：基于飞书 SDK 的薄封装

> 不自己管理 token——使用 `lark.Client` 的语义化 API（`client.im.message.create()` 等），适配器层只做两件事：调用 SDK 方法 + 把 SDK 异常映射为 Chat SDK 的错误类。

**检索**：

- `https://github.com/larksuite/node-sdk` README — "API Call" 章节完整阅读，理解 `client.im.message.create()`、`client.im.message.reply()`、`client.im.file.create()`、`client.im.file.get()` 等语义化调用方式
- `https://github.com/larksuite/node-sdk/tree/main/client` — Client 构造逻辑、token 自动获取/缓存/刷新的内部机制
- `https://github.com/larksuite/node-sdk/tree/main/http` — SDK HTTP 实例，理解如何注入自定义拦截器（用于错误映射）
- SDK README "File upload" / "File download" 章节 — 文件上传下载的 API
- SDK README "Pagination" 章节 — `listWithIterator` 分页迭代器
- SDK README "Configure request options" 章节 — `lark.withTenantKey()` 等选项注入方式
- Chat SDK `@chat-adapter/shared` 的错误类列表：`AdapterRateLimitError`、`AuthenticationError`、`ResourceNotFoundError`、`NetworkError`

**做什么**：

- 在适配器 `initialize()` 中创建 `lark.Client({ appId, appSecret, domain, appType })` 实例
- 封装一个薄的 `LarkApiClient` 类，内部持有 `lark.Client`，对外提供适配器需要的方法：
  - `sendMessage(chatId, msgType, content)` → 调用 `client.im.message.create()`
  - `replyMessage(messageId, msgType, content)` → 调用 `client.im.message.reply()`
  - `updateMessage(messageId, msgType, content)` → 调用 `client.im.message.patch()` 或 `.update()`
  - `deleteMessage(messageId)` → 调用 `client.im.message.delete()`
  - `getMessage(messageId)` → 调用 `client.im.message.get()`
  - `listMessages(chatId, pageToken, pageSize)` → 调用 `client.im.message.list()`
  - `addReaction(messageId, emojiType)` → 调用 `client.im.messageReaction.create()`
  - `removeReaction(messageId, reactionId)` → 调用 `client.im.messageReaction.delete()`
  - `getChatInfo(chatId)` → 调用 `client.im.chat.get()`
  - `createP2PChat(userId)` → 调用 `client.im.chat.create()`
  - `uploadImage(imageData)` → 调用 `client.im.image.create()`
  - `uploadFile(fileData)` → 调用 `client.im.file.create()`
  - `getBotInfo()` → 调用 `client.bot.v3.info.get()` 或等效 request 方法
  - `sendEphemeral(...)` → 如果 SDK 无语义化方法，使用 `client.request()` 兜底
- 统一异常映射层：try-catch SDK 调用，根据返回的 `code` 或 HTTP 状态映射为 `@chat-adapter/shared` 的错误类
- 保留 `client.request()` 作为兜底，用于 SDK 未封装的 API（如 ephemeral）

**测试**（`api.test.ts`）：

- 注入自定义 `httpInstance`（或使用 msw mock SDK 底层的 axios 请求），验证：
- sendMessage → SDK 发出正确的 POST 请求，验证 `receive_id_type` 查询参数、body 结构
- replyMessage → 验证请求路径含 message_id
- 文件上传 → 验证 multipart 请求格式
- 分页 → 验证 page_token 透传
- 异常映射：SDK 返回 `code: 99991` → 抛 `NetworkError`
- 异常映射：SDK 请求 429 → 抛 `AdapterRateLimitError`
- 异常映射：SDK 鉴权失败 → 抛 `AuthenticationError`
- `getBotInfo` → 验证返回 open_id

---

## 任务 5 — 格式转换器

**检索**：

- Chat SDK 的 `BaseFormatConverter` 源码：从 `chat` 包的 exports 中找到基类
- Chat SDK 导出的 AST 工具函数：`parseMarkdown`、`stringifyMarkdown`、`text`、`strong`、`emphasis`、`inlineCode`、`codeBlock`、`link`、`paragraph`、`root`
- 飞书各消息类型的 content JSON schema（text / post / image / file / interactive）
- 飞书消息卡片（Interactive Card）的 JSON 结构和全部组件清单
- Chat SDK 的 `CardElement` 类型定义和子组件（Button / Section / Image / Text / Divider / Actions / Table 等）
- Discord 适配器的 `markdown.ts`（参考 @mention 语法转换模式）

**做什么**：

- `toAst(platformText: string): Root`：
  - text 消息：`JSON.parse` → 提取 `.text` → `parseMarkdown()`
  - post 富文本：遍历 `content` 嵌套数组，按 `tag` 类型（`text` / `a` / `at` / `img`）构造 Markdown 字符串 → `parseMarkdown()`
  - interactive：提取卡片中的 markdown 元素 → 拼接 → `parseMarkdown()`
  - 非 JSON 输入：作为纯文本处理
- `fromAst(ast: Root): string`：`stringifyMarkdown(ast)`（飞书渲染支持基本 Markdown 子集）
- `renderForSend(message: AdapterPostableMessage): { msgType: string; content: string }`：
  - 有 card → `cardToLarkInteractive()` → `{ msgType: "interactive", content }`
  - 纯文本 → `{ msgType: "text", content: JSON.stringify({ text }) }`
- `cardToLarkInteractive()`：将 Chat SDK Card 组件映射到飞书卡片 JSON
  - `Text` → `{ tag: "markdown", content: "..." }`
  - `Button` → `{ tag: "button", text: {...}, type: "primary" }`
  - `Image` → `{ tag: "img", img_key: "...", alt: {...} }`
  - `Divider` → `{ tag: "hr" }`
  - `Actions` → `{ tag: "action", actions: [...] }`
  - 不支持的组件 → 调用 `cardToFallbackText()` 降级为 markdown 文本

**测试**（`format-converter.test.ts`）：

- `toAst`：text JSON / post 富文本 / 纯字符串 / 非法 JSON → 验证产出的 AST root 节点类型正确
- `toAst` mention 处理：输入含 `@_user_1` 的文本 + mentions 数组 → 验证输出含可读用户名
- `fromAst` roundtrip：构造 mdast 树 → `fromAst` → 验证输出 Markdown 字符串
- `renderForSend` 纯文本：验证 `msgType === "text"` 且 content 是合法 JSON
- `renderForSend` 卡片：验证 `msgType === "interactive"` 且 content 含 `elements` 数组
- `cardToLarkInteractive`：逐个组件类型验证映射正确
- 降级测试：不支持的 Card 组件 → 验证降级到 fallback text

---

## 任务 6 — 主适配器类

> 核心任务，最重。依赖前面所有实现任务的产出。

**检索**：

- 任务 0.1 产出的 Adapter 接口方法清单
- Telegram 适配器的 `adapter.ts`（参考整体结构）
- Chat SDK `processMessage()` 的调用约定（positional args、factory 函数模式）
- Chat SDK `Message` 构造参数的完整字段

**做什么**（`LarkAdapter implements Adapter<LarkThreadId, LarkEventMessage>`）：

### 6.1 生命周期

- `initialize(chat: ChatInstance)`：存 chat 引用、创建 logger、调用 `getBotInfo` 获取 `botOpenId`
- `disconnect()`：清理去重缓存

### 6.2 Thread ID 编解码

- `encodeThreadId`：`lark:{base64url(chatId)}` 或 `lark:{base64url(chatId)}:{base64url(rootMessageId)}`
- `decodeThreadId`：反向解析，前缀非 `lark` 时抛 `ValidationError`

### 6.3 Webhook 处理

- `handleWebhook(request: Request, options?: WebhookOptions): Promise<Response>`
- 桥接流程：从 Request 提取 body + headers → 按 SDK `adaptDefault` 模式构造 `Object.assign(Object.create({ headers }), data)` → 调用 `eventDispatcher.invoke(assigned)` → SDK 内部自动完成解密/challenge/路由 → 通过 `.register()` 注册的回调触发适配器的消息处理逻辑 → 立即返回 200
- 适配器自己做事件去重（SDK 不处理）：LRU 缓存 event_id，FIFO 淘汰防内存泄漏
- 飞书有 **3 秒超时要求**：必须先返回 200，再异步处理

### 6.4 事件路由

- 通过 `eventDispatcher.register()` 注册回调，SDK 自动路由：
- `im.message.receive_v1` → 构造 `Message`、判断 @mention、调用 `processMessage()`
- `im.message.reaction.created_v1` → 触发 `onReaction` 回调
- `im.message.reaction.deleted_v1` → 触发 `onReactionRemoved` 回调
- bot 被加入群 `im.chat.member.bot.added_v1` → 日志记录
- 未注册的事件 → SDK 自动忽略

### 6.5 消息解析

- `parseMessage()`：从 `LarkEventMessage` 构造 `Message<LarkEventMessage>`
- @mention 占位符替换：`@_user_1` → `@用户真实名称`
- DM 消息自动设 `isMention = true`（Chat SDK 对 DM 的约定）

### 6.6 消息发送

- `postMessage`：根据 `rootMessageId` 有无决定 sendMessage vs replyMessage
- `editMessage`：调用 `updateMessage` API
- `deleteMessage`：调用 `deleteMessage` API
- 有 card → interactive 消息；有 files → 先上传再发对应类型消息；纯文本 → text 消息

### 6.7 Reactions

- `addReaction`：处理 `EmojiValue | string`（`EmojiValue` 有 `.name` 属性，无 `.unicode`）
- `removeReaction`：飞书需要 `reaction_id` 非 emoji 名 → 先 list reactions 定位再删除

### 6.8 消息拉取

- `fetchMessages`：分页拉取、按时间正序、返回 `nextCursor`
- `fetchThread`：获取群信息返回 `ThreadInfo`
- `fetchMessage`：单条消息查询

### 6.9 DM

- `openDM(userId)`：创建 p2p chat → 返回编码后 thread ID
- `isDM(threadId)`：通过内部缓存判断 chat_type（从收到的事件中提取并缓存）

### 6.10 Streaming

- `stream(threadId, textStream)`：先 postMessage 占位 → 消费 stream → 每 300-500ms 调 editMessage 更新 → 流结束后最终 update
- 节流机制：防止超出飞书 API 速率限制
- 异常处理：stream 中断时确保最后一次 edit 把已收到的内容发出去

### 6.11 Ephemeral Messages

- `postEphemeral(threadId, userId, message)`：调用 `sendEphemeral` API（仅 interactive 卡片）

### 6.12 文件上传

- 检测 `extractFiles(message)` 有文件 → 按类型走 `uploadImage` 或 `uploadFile` → 获得 key → 发送 image/file 类型消息

### 6.13 其他可选方法

- `startTyping()`：飞书无公开 typing API → no-op
- `renderFormatted(content: FormattedContent)`：委托 converter.fromAst()
- `channelIdFromThreadId(threadId)`：从 thread ID 中提取 chatId
- `fetchChannelInfo(channelId)`：调用 getChatInfo

**测试**（`adapter.test.ts`，最大的测试文件，使用 msw mock API Client 的 HTTP 交互）：

Thread ID：

- encode/decode roundtrip（纯 chatId、chatId + rootMessageId）
- 特殊字符（chatId 含 `!` `@` `:` 等）
- 无效前缀 / 不足 segment → ValidationError

Webhook：

- URL verification → SDK 自动应答 challenge（200）
- 无效 JSON → 400
- 加密事件 → SDK 自动解密后正确路由到注册的回调
- 同一 event_id 发两次 → 第二次静默 200（适配器层去重）
- 去重缓存超限 → 旧条目被淘汰
- im.message.receive_v1 事件 → processMessage 被调用（mock ChatInstance）
- reaction 事件 → 正确触发回调
- 未注册事件类型 → 静默 200

消息解析：

- text 消息 → 正确提取文本
- post 富文本 → 正确提取并拼接
- mention 替换 → @\_user_1 → @真实名称
- bot 自己的消息 → `author.isBot === true`、`author.isMe === true`
- DM 消息 → `isMention === true`

消息发送（mock API client）：

- 纯文本消息 → 调用 sendMessage，验证 body
- 话题回复 → 调用 replyMessage
- 有 card → msgType 为 interactive
- 有文件 → 先 upload 再发消息，验证调用序列
- editMessage / deleteMessage → 正确调用对应 API

Streaming（mock API client + fake ReadableStream）：

- 正常流 → 先 post 再多次 edit → 最终 edit 含完整内容
- 节流验证 → edit 调用间隔 >= 阈值
- 流中断 → 最终 edit 仍被调用

Reactions：

- addReaction 字符串 emoji → 正确传 emoji_type
- addReaction EmojiValue 对象 → 正确提取 .name
- removeReaction → list + delete 调用链

DM：

- openDM → 创建 p2p chat → 返回编码 thread ID
- isDM → 缓存命中/未命中

---

## 任务 7 — 工厂函数与公共导出

**检索**：Chat SDK building 文档中的 "Factory function" 章节

**做什么**：

- `createLarkAdapter(config?)` 工厂函数
- 环境变量 fallback 链：`LARK_APP_ID`、`LARK_APP_SECRET`、`LARK_ENCRYPT_KEY`、`LARK_VERIFICATION_TOKEN`、`LARK_DOMAIN`（接受 `feishu` / `lark` / 完整 URL）
- 缺少 appId/appSecret 时抛 `ValidationError` 并给出清晰提示
- `index.ts` 公共导出：`LarkAdapter`、`createLarkAdapter`、`LarkFormatConverter`、`LarkApiClient`、所有公共类型

**测试**（`factory.test.ts`）：

- 显式 config → 创建成功
- 环境变量 fallback → mock `process.env` → 创建成功
- 缺 appId → 抛 ValidationError 含 "LARK_APP_ID"
- 缺 appSecret → 抛 ValidationError 含 "LARK_APP_SECRET"
- config 覆盖环境变量 → config 优先

---

## 任务 8 — 集成测试

> 前面各任务的测试都是单元测试（隔离的、mock 依赖的）。本任务是端到端级别的集成测试。

**检索**：

- `https://github.com/vercel/chat/tree/main/packages/integration-tests/src` — 官方集成测试结构
- Chat SDK 的 `MemoryStateAdapter` 用法

**做什么**（使用 msw 模拟全部飞书 HTTP，不连真实飞书）：

- **完整收发流程**：创建 `Chat` 实例 + `LarkAdapter` + `MemoryStateAdapter` → 构造 `im.message.receive_v1` webhook request → 调 `bot.webhooks.lark(request)` → 验证 `onNewMention` handler 触发 → handler 中调 `thread.post("reply")` → 验证 msw 捕获了正确的 sendMessage 请求
- **话题回复流程**：rootMessageId 存在时走 reply API
- **Streaming 流程**：`thread.post(textStream)` → 验证 post + 多次 edit 调用序列
- **@mention 过滤**：非 @bot 消息 → `onSubscribedMessage` 而非 `onNewMention`
- **Reaction 流程**：reaction 事件 → `onReaction` handler 触发 → handler 中 `thread.addReaction` → 验证 API 调用
- **DM 流程**：收到 p2p 消息 → `isMention` 为 true → `openDM` 创建会话
- **多适配器并存**：同一 Chat 实例注册 lark + memory state → 各自独立工作
- **错误恢复**：API 返回 429 → 验证错误被上报、不崩溃

---

## 任务 9 — 文档与 README

**检索**：

- `https://chat-sdk.dev/docs/contributing/documenting` — 文档规范
- 官方适配器文档页面格式：`https://chat-sdk.dev/docs/adapters/slack`、`https://chat-sdk.dev/docs/adapters/telegram`
- 飞书开放平台应用创建流程：搜索 "larksuite custom app development process"

**做什么**：

- `README.md`：
  - 安装命令
  - Quick Start 代码示例（含 import / Chat 实例创建 / handler 注册）
  - 配置表（config 字段 + 环境变量 + 是否必填 + 说明，包含 `domain` 字段使用 `lark.Domain.Feishu` / `lark.Domain.Lark` 切换）
  - Webhook 设置指南：Next.js App Router / Hono / Express 三种框架的 route 示例
  - 飞书开放平台配置步骤：创建应用 → 配置权限 → 事件订阅 → URL 验证 → 发布
  - 所需权限列表（`im:message`、`im:message:send_as_bot`、`im:chat:readonly`、`im:resource`、`contact:user.id:readonly`）
  - 功能支持矩阵（每个功能标 ✅ 或 ⚠️ 含限制说明）
  - Feishu vs Lark 切换说明（设置 `domain: lark.Domain.Lark` 或环境变量 `LARK_DOMAIN=lark`）
  - Contributing 指南
- `CHANGELOG.md`

---

## 任务 10 — 发布与收录

**检索**：

- `https://chat-sdk.dev/docs/contributing/publishing` — 发布清单
- Chat SDK 适配器目录数据源（在 `https://github.com/vercel/chat` 仓库中搜索 adapters 目录或 json 配置）

**做什么**：

- 发布前检查：`typecheck` 零错误 → `test` 全过 → `build` 成功 → `npm pack --dry-run` 干净
- `npm publish --access public`
- 向 `vercel/chat` 仓库提交 PR 申请收录到适配器目录（tier: community）

---

## 关键决策

| 决策项         | 结论                                                                     | 理由                                                                                                                              |
| -------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| 包名           | `chat-adapter-lark`                                                      | `@chat-adapter/` 是 Vercel 保留 scope                                                                                             |
| 默认 domain    | `lark.Domain.Feishu`（即 `https://open.feishu.cn`）                      | 国内用户为主，国际版用户设 `lark.Domain.Lark` 切换                                                                                |
| 飞书 SDK       | **作为运行时 dependency**，使用 `@larksuiteoapi/node-sdk`                | 复用官方 token 管理（获取/缓存/刷新）、事件解密（AESCipher）、challenge 应答、语义化 API 调用、类型定义；避免自造轮子引入鉴权 bug |
| SDK 用法边界   | 鉴权 + 事件接入 + API 调用 全部走 SDK；格式转换 + Chat SDK 桥接 自己实现 | SDK 管"和飞书通信"，适配器管"和 Chat SDK 对接"                                                                                    |
| streaming 策略 | editMessage 节流（同 Telegram/Discord）                                  | 飞书无原生 streaming API，Chat SDK 非 Slack 平台标准做法                                                                          |
| isDM 判断      | 事件中缓存 chat_type                                                     | 飞书 chatId 格式无法区分群聊/私聊                                                                                                 |
| Card 映射      | 完整映射 + 不支持组件降级                                                | 生产标准，不做 stub                                                                                                               |
| removeReaction | list → 找 reaction_id → delete                                           | 飞书 API 设计要求 reaction_id                                                                                                     |
| 事件去重       | LRU 缓存 + 大小上限 + FIFO 淘汰                                          | 避免内存泄漏、处理飞书重试推送                                                                                                    |
| 测试 mock 方案 | msw (Mock Service Worker) mock SDK 底层的 axios 请求                     | SDK 内部用 axios，msw 可透明拦截；也可用 SDK 的 `httpInstance` 参数注入 mock                                                      |

---

## 任务依赖关系

```
任务 0 (知识准备)
  ├── 任务 1 (项目骨架 + 飞书 SDK 依赖)
  │     └── 任务 2 (类型系统，复用 SDK 类型)
  │           ├── 任务 3 (安全层：SDK EventDispatcher 桥接)  ── 可与 4 并行
  │           ├── 任务 4 (API 客户端：SDK Client 薄封装)
  │           │     └── 任务 5 (格式转换器)
  │           │           └── 任务 6 (主适配器：组装 3+4+5) ← 最重的任务
  │           │                 └── 任务 7 (工厂函数)
  │           │                       └── 任务 8 (集成测试)
  │           │                             └── 任务 9 (文档)
  │           │                                   └── 任务 10 (发布)
```

任务 3 和 4 可并行（都依赖飞书 SDK，但职责不同：3 管事件接入，4 管 API 调用）。任务 6 是汇聚点，组装全部前置模块。每个任务自身含单元测试，任务 8 是跨模块的集成测试。
