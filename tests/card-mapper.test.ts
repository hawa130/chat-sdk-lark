import { describe, expect, it } from 'vitest'
import cardMapper from '../src/card-mapper.ts'

const { cardToFallbackText, cardToLarkInteractive } = cardMapper

const SINGLE = 1

const byTag = (tag: string) => (el: { tag: string }) => el.tag === tag

describe('cardToLarkInteractive', () => {
  it('card with text → element { tag: "markdown", content }', () => {
    const card = {
      children: [{ content: 'Hello **world**', style: undefined, type: 'text' as const }],
      type: 'card' as const,
    }
    const result = cardToLarkInteractive(card)
    const { elements } = result.body
    const mdEl = elements.find(byTag('markdown'))
    expect(mdEl).toBeDefined()
    expect(mdEl.content).toBe('Hello **world**')
  })

  it('card with divider → element { tag: "hr" }', () => {
    const card = {
      children: [{ type: 'divider' as const }],
      type: 'card' as const,
    }
    const result = cardToLarkInteractive(card)
    const hrEl = result.body.elements.find(byTag('hr'))
    expect(hrEl).toBeDefined()
  })

  it('card with buttons in actions → { tag: "action", actions: [...] }', () => {
    const card = {
      children: [
        {
          children: [
            {
              disabled: false,
              id: 'btn1',
              label: 'Click me',
              style: 'primary' as const,
              type: 'button' as const,
              value: undefined,
            },
          ],
          type: 'actions' as const,
        },
      ],
      type: 'card' as const,
    }
    const result = cardToLarkInteractive(card)
    const actionEl = result.body.elements.find(byTag('action'))
    expect(actionEl).toBeDefined()
    const [firstAction] = actionEl.actions
    expect(actionEl.actions).toHaveLength(SINGLE)
    expect(firstAction.tag).toBe('button')
    expect(firstAction.text.content).toBe('Click me')
  })

  it('card with image → { tag: "img", ... }', () => {
    const card = {
      children: [{ alt: 'A photo', type: 'image' as const, url: 'img_key_123' }],
      type: 'card' as const,
    }
    const result = cardToLarkInteractive(card)
    const imgEl = result.body.elements.find(byTag('img'))
    expect(imgEl).toBeDefined()
    expect(imgEl.img_key).toBe('img_key_123')
    expect(imgEl.alt.content).toBe('A photo')
  })

  it('unknown component degrades to markdown if content exists', () => {
    const card = {
      children: [
        {
          children: [{ content: 'section text', style: undefined, type: 'text' as const }],
          type: 'section' as const,
        },
      ],
      type: 'card' as const,
    }
    const result = cardToLarkInteractive(card)
    const mdEl = result.body.elements.find(byTag('markdown'))
    expect(mdEl).toBeDefined()
  })
})

describe('cardToFallbackText', () => {
  it('extracts title and all text content', () => {
    const card = {
      children: [
        { content: 'Body text here', style: undefined, type: 'text' as const },
        { type: 'divider' as const },
      ],
      subtitle: 'A subtitle',
      title: 'My Card',
      type: 'card' as const,
    }
    const result = cardToFallbackText(card)
    expect(result).toContain('My Card')
    expect(result).toContain('Body text here')
  })
})
