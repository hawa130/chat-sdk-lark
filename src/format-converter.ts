import { BaseFormatConverter, parseMarkdown, stringifyMarkdown } from 'chat'
import type { Root } from 'mdast'
import type { LarkInteractiveContent, LarkMessageContent, LarkPostContent } from './types.ts'
import cardMapper from './card-mapper.ts'

type PostLang = { content?: PostInlineTag[][]; title?: string }
type PostInlineTag =
  | { href: string; tag: 'a'; text: string }
  | { tag: 'at'; user_id?: string; user_name?: string }
  | { tag: 'text'; text: string }
  | { tag: string }

const FIRST_INDEX = 0

const inlineToMarkdown = (el: PostInlineTag): string => {
  if (el.tag === 'text' && 'text' in el) {
    return el.text
  }
  if (el.tag === 'a' && 'href' in el) {
    return `[${el.text}](${el.href})`
  }
  if (el.tag === 'at' && 'user_name' in el) {
    return `@${el.user_name ?? 'unknown'}`
  }
  if (el.tag === 'at') {
    return '@unknown'
  }
  return ''
}

const langToMarkdown = (lang: PostLang): string => {
  const lines: string[] = []
  if (lang.title) {
    lines.push(`# ${lang.title}`)
  }
  for (const row of lang.content ?? []) {
    lines.push(row.map(inlineToMarkdown).join(''))
  }
  return lines.join('\n')
}

const postToMarkdown = (parsed: LarkPostContent): string => {
  const { post } = parsed
  const lang = (post['zh_cn'] ?? post['en_us'] ?? Object.values(post)[FIRST_INDEX]) as
    | PostLang
    | undefined
  if (!lang) {
    return ''
  }
  return langToMarkdown(lang)
}

const interactiveToMarkdown = (parsed: LarkInteractiveContent): string => {
  if (!parsed.body?.elements) {
    return ''
  }
  return parsed.body.elements
    .filter((el) => el.tag === 'markdown' && el.content)
    .map((el) => el.content ?? '')
    .join('\n')
}

const tryParseJson = (text: string): LarkMessageContent | null => {
  try {
    return JSON.parse(text) as LarkMessageContent
  } catch {
    return null
  }
}

const parsePlatformText = (platformText: string): string => {
  const parsed = tryParseJson(platformText)
  if (!parsed) {
    return platformText
  }
  if ('text' in parsed) {
    return parsed.text
  }
  if ('post' in parsed) {
    return postToMarkdown(parsed)
  }
  if ('body' in parsed) {
    return interactiveToMarkdown(parsed)
  }
  return platformText
}

export default class LarkFormatConverter extends BaseFormatConverter {
  toAst(platformText: string): Root {
    return parseMarkdown(parsePlatformText(platformText))
  }

  fromAst(ast: Root): string {
    return stringifyMarkdown(ast)
  }

  renderForSend(message: { card?: CardChild; text?: string }): {
    content: string
    msgType: string
  } {
    if (message.card) {
      const interactive = cardMapper.cardToLarkInteractive(message.card)
      return { content: JSON.stringify(interactive), msgType: 'interactive' }
    }
    return { content: JSON.stringify({ text: message.text ?? '' }), msgType: 'text' }
  }

  replaceMentions(text: string, mentions: Array<{ key: string; name: string }>): string {
    return mentions.reduce(
      (result, mention) => result.replaceAll(mention.key, `@${mention.name}`),
      text,
    )
  }
}
