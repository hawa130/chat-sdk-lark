import { describe, expect, it } from 'vitest'
import cardMapper from '../src/card-mapper.ts'

const { cardToFallbackText, cardToLarkInteractive } = cardMapper

type LarkEl = { tag: string } & Record<string, unknown>
type LarkCard = { body: { elements: LarkEl[] }; config: Record<string, unknown>; schema: string }

const byTag = (tag: string) => (el: { tag: string }) => el.tag === tag

describe('cardToLarkInteractive', () => {
  it('outputs schema 2.0 and config', () => {
    const card = { children: [], type: 'card' as const }
    const result = cardToLarkInteractive(card) as LarkCard
    expect(result.schema).toBe('2.0')
    expect(result.config).toMatchObject({ update_multi: true })
  })

  it('card with text has element_id on markdown element', () => {
    const card = {
      children: [{ content: 'Hello **world**', style: undefined, type: 'text' as const }],
      type: 'card' as const,
    }
    const result = cardToLarkInteractive(card) as LarkCard
    const mdEl = result.body.elements.find(byTag('markdown')) as LarkEl
    expect(mdEl).toBeDefined()
    expect(mdEl.content).toBe('Hello **world**')
    expect(mdEl.element_id).toMatch(/^el_/)
  })

  it('card with divider has element_id on hr element', () => {
    const card = {
      children: [{ type: 'divider' as const }],
      type: 'card' as const,
    }
    const result = cardToLarkInteractive(card) as LarkCard
    const hrEl = result.body.elements.find(byTag('hr'))
    expect(hrEl).toBeDefined()
    expect(hrEl).toHaveProperty('element_id')
  })

  it('card with buttons flattens to standalone button elements (no action wrapper)', () => {
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
    const result = cardToLarkInteractive(card) as LarkCard
    const { elements } = result.body
    expect(elements.find(byTag('action'))).toBeUndefined()
    const btnEl = elements.find(byTag('button')) as LarkEl
    expect(btnEl).toBeDefined()
    expect((btnEl.text as LarkEl).content).toBe('Click me')
    expect(btnEl.element_id).toMatch(/^el_/)
  })

  it('button with value uses behaviors array', () => {
    const card = {
      children: [
        {
          children: [
            {
              label: 'Do it',
              style: 'primary' as const,
              type: 'button' as const,
              value: 'my_action',
            },
          ],
          type: 'actions' as const,
        },
      ],
      type: 'card' as const,
    }
    const result = cardToLarkInteractive(card) as LarkCard
    const btnEl = result.body.elements.find(byTag('button')) as LarkEl
    expect(btnEl.behaviors).toEqual([{ type: 'callback', value: { action: 'my_action' } }])
  })

  it('card with image has element_id on img element', () => {
    const card = {
      children: [{ alt: 'A photo', type: 'image' as const, url: 'img_key_123' }],
      type: 'card' as const,
    }
    const result = cardToLarkInteractive(card) as LarkCard
    const imgEl = result.body.elements.find(byTag('img')) as LarkEl
    expect(imgEl).toBeDefined()
    expect(imgEl.img_key).toBe('img_key_123')
    expect(imgEl.element_id).toMatch(/^el_/)
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
    const result = cardToLarkInteractive(card) as LarkCard
    const mdEl = result.body.elements.find(byTag('markdown'))
    expect(mdEl).toBeDefined()
    expect(mdEl).toHaveProperty('element_id')
  })

  it('header includes title with template', () => {
    const card = {
      children: [],
      title: 'Test Card',
      type: 'card' as const,
    }
    const result = cardToLarkInteractive(card) as Record<string, unknown>
    expect(result.header).toMatchObject({
      template: 'blue',
      title: { content: 'Test Card', tag: 'plain_text' },
    })
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
