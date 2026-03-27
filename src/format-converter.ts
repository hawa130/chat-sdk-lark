import { BaseFormatConverter, parseMarkdown, stringifyMarkdown } from 'chat'
import type { Root } from 'mdast'
import cardMapper from './card-mapper.ts'

type PostLang = { content?: PostInlineTag[][]; title?: string }
type PostInlineTag =
  | { [k: string]: unknown; tag: string }
  | { href: string; tag: 'a'; text: string }
  | { tag: 'at'; user_id?: string; user_name?: string }
  | { tag: 'text'; text: string }

const FIRST_INDEX = 0

const inlineToMarkdown = (el: PostInlineTag): string => {
  if (el.tag === 'text') {
    return (el as { tag: 'text'; text: string }).text
  }
  if (el.tag === 'a') {
    const link = el as { href: string; tag: 'a'; text: string }
    return `[${link.text}](${link.href})`
  }
  if (el.tag === 'at') {
    return `@${(el as { tag: 'at'; user_name?: string }).user_name ?? 'unknown'}`
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

const postToMarkdown = (parsed: Record<string, unknown>): string => {
  const post = parsed['post'] as Record<string, unknown> | undefined
  if (!post) {
    return ''
  }
  const lang = (post['zh_cn'] ?? post['en_us'] ?? Object.values(post)[FIRST_INDEX]) as
    | PostLang
    | undefined
  if (!lang) {
    return ''
  }
  return langToMarkdown(lang)
}

const interactiveToMarkdown = (parsed: Record<string, unknown>): string => {
  const body = parsed['body'] as
    | { elements?: Array<{ content?: string; tag?: string }> }
    | undefined
  if (!body?.elements) {
    return ''
  }
  return body.elements
    .filter((el) => el.tag === 'markdown' && el.content)
    .map((el) => el.content ?? '')
    .join('\n')
}

const parsePlatformText = (platformText: string): string => {
  const parsed = (() => {
    try {
      return JSON.parse(platformText) as Record<string, unknown>
    } catch {
      return null
    }
  })()
  if (!parsed) {
    return platformText
  }
  if ('text' in parsed) {
    return String(parsed['text'])
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

  renderForSend(message: { card?: unknown; text?: string }): { content: string; msgType: string } {
    if (message.card) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const interactive = cardMapper.cardToLarkInteractive(message.card as any)
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
