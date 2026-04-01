# Roadmap

## Current Status

All 17 required Adapter methods implemented. 12 of 15 optional methods implemented.

**Coverage:**

- Messaging: post / edit / delete / stream / ephemeral
- Rich content: cards / modals (form container) / file uploads
- Interactions: buttons / select menus / reactions / modal submit & close
- History: fetch messages / threads / channels
- Conversations: DMs / channel visibility / channel info

## Phase 1: Complete Chat SDK Coverage

Fill remaining gaps in the standard Adapter interface.

- [ ] `listThreads` — after the `thread_id` model is corrected, enumerate recent thread/topic roots from chat history and map them to `ThreadSummary`
- [ ] `processMemberJoinedChannel` — listen to `im.chat.member.user.added_v1` event
- [ ] Stream rate limiting — throttle `cardkit` text updates to stay under 10 QPS/card

## Phase 2: Core Platform-Specific Features

High-value Lark-specific methods to expose on `LarkAdapter`. Users access via `chat.getAdapter('lark')`.

### Message Enhancement

- [ ] `pinMessage` / `unpinMessage` — `POST/DELETE /im/v1/pins`
- [ ] `urgentMessage` — `PATCH /im/v1/messages/:id/urgent` (app / SMS / phone)
- [ ] `getReadUsers` — `GET /im/v1/messages/:id/read_users`
- [ ] `forwardMessage` — `POST /im/v1/messages/:id/forward`

### User Info

- [ ] `getUser` — `GET /contact/v3/users/:id` (name, avatar, department)
- [ ] Enrich `Author` fields in `parseMessage` when user info is available

## Phase 3: Group Management

Methods for managing Lark group chats programmatically.

- [ ] `addMembers` / `removeMembers` — `POST/DELETE /im/v1/chats/:id/members`
- [ ] `getChatMembers` — `GET /im/v1/chats/:id/members`
- [ ] `updateChat` — `PUT /im/v1/chats/:id` (name, description, avatar)
- [ ] `setAnnouncement` — `PATCH /im/v1/chats/:id/announcement`

## Phase 4: Advanced Features

Lower priority, implement as needed.

- [ ] `mergeForward` — `POST /im/v1/messages/merge_forward`
- [ ] `pushFollowUp` — `POST /im/v1/messages/:id/push_follow_up` (action buttons below message)
- [ ] `setChatMenuTree` — `POST /im/v1/chat_menu_tree` (bot menu in group)
- [ ] `setTopNotice` — `POST /im/v1/chats/:id/top_notice/put_top_notice`

## Not Planned

Features that don't apply to Lark:

| Feature                | Reason                              |
| ---------------------- | ----------------------------------- |
| `scheduleMessage`      | No Lark API for scheduled delivery  |
| `processSlashCommand`  | Lark has no slash command mechanism |
| `processAppHomeOpened` | Lark has no App Home tab            |
| `processAssistant*`    | Slack AI Assistant-specific         |
