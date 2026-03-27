import { describe, expect, it } from 'vitest'
import LarkFormatConverter from '../src/format-converter.ts'

type AstNode = { children?: unknown[]; type: string; value?: string }

const converter = new LarkFormatConverter()

/** Recursively collect all text node values from an mdast node. */
const extractText = (node: AstNode): string => {
  if ('value' in node && node.type === 'text') {
    return node.value ?? ''
  }
  const children = (node as { children?: unknown[] }).children ?? []
  return children.map((child) => extractText(child as AstNode)).join('')
}

describe('LarkFormatConverter.toAst', () => {
  it('parses text JSON to root with text node', () => {
    const ast = converter.toAst('{"text":"hello world"}')
    expect(ast.type).toBe('root')
    expect(extractText(ast)).toBe('hello world')
  })

  it('handles non-JSON plain string as text', () => {
    const ast = converter.toAst('just a plain string')
    expect(ast.type).toBe('root')
    expect(extractText(ast)).toBe('just a plain string')
  })

  it('parses post rich text with title and links', () => {
    const post = JSON.stringify({
      post: {
        zh_cn: {
          content: [
            [
              { tag: 'text', text: 'Click ' },
              { href: 'https://example.com', tag: 'a', text: 'here' },
            ],
          ],
          title: 'My Title',
        },
      },
    })
    const ast = converter.toAst(post)
    expect(ast.type).toBe('root')
    const textContent = extractText(ast)
    expect(textContent).toContain('My Title')
    expect(textContent).toContain('Click')
    expect(textContent).toContain('here')
  })

  it('handles @mention (tag: "at") in post content', () => {
    const post = JSON.stringify({
      post: {
        zh_cn: {
          content: [
            [
              { tag: 'at', user_id: 'ou_abc', user_name: 'Alice' },
              { tag: 'text', text: ' hello' },
            ],
          ],
        },
      },
    })
    const ast = converter.toAst(post)
    const textContent = extractText(ast)
    expect(textContent).toContain('Alice')
    expect(textContent).toContain('hello')
  })
})

describe('LarkFormatConverter.fromAst', () => {
  it('converts AST back to markdown string containing the text', () => {
    const ast = converter.toAst('{"text":"hello world"}')
    const md = converter.fromAst(ast)
    expect(typeof md).toBe('string')
    expect(md).toContain('hello world')
  })
})

describe('LarkFormatConverter.renderForSend', () => {
  it('plain text → { msgType: "text", content: JSON with text key }', () => {
    const result = converter.renderForSend({ text: 'hello' })
    expect(result.msgType).toBe('text')
    expect(typeof result.content).toBe('string')
    const parsed = JSON.parse(result.content)
    expect(parsed.text).toBe('hello')
  })

  it('card → { msgType: "interactive", content: string }', () => {
    const card = { children: [], title: 'Test Card', type: 'card' as const }
    const result = converter.renderForSend({ card })
    expect(result.msgType).toBe('interactive')
    expect(typeof result.content).toBe('string')
  })
})

describe('LarkFormatConverter.replaceMentions', () => {
  it('replaces @_user_N placeholders with real names', () => {
    const text = '@_user_1 hello @_user_2'
    const mentions = [
      { key: '@_user_1', name: 'Alice' },
      { key: '@_user_2', name: 'Bob' },
    ]
    const result = converter.replaceMentions(text, mentions)
    expect(result).toContain('@Alice')
    expect(result).toContain('@Bob')
    expect(result).not.toContain('@_user_1')
    expect(result).not.toContain('@_user_2')
  })
})
