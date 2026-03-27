/** Minimal shapes for card elements (JSX components, not importable as types). */
interface CardChild {
  alt?: string
  children?: CardChild[]
  content?: string
  disabled?: boolean
  id?: string
  label?: string
  style?: string
  subtitle?: string
  title?: string
  type: string
  url?: string
  value?: unknown
}

type LarkElement = Record<string, unknown>

const COUNTER_START = 0

let elementCounter = COUNTER_START

const resetElementCounter = (): void => {
  elementCounter = COUNTER_START
}

const nextElementId = (): string => `el_${String(elementCounter++)}`

const buttonType = (style: string | undefined): string => {
  if (style === 'danger') {
    return 'danger'
  }
  if (style === 'secondary') {
    return 'default'
  }
  return 'primary'
}

const mapButton = (btn: CardChild): LarkElement => {
  const el: LarkElement = {
    element_id: nextElementId(),
    tag: 'button',
    text: { content: btn.label, tag: 'plain_text' },
    type: buttonType(btn.style),
  }
  if (btn.value != null) {
    el['behaviors'] = [{ type: 'callback', value: { action: String(btn.value) } }]
  }
  return el
}

const mapSection = (el: CardChild): LarkElement | null => {
  const texts = (el.children ?? [])
    .map((child) => {
      if ('content' in child) {
        return child.content
      }
      return null
    })
    .filter(Boolean)
    .join('\n')
  if (!texts) {
    return null
  }
  return { content: texts, element_id: nextElementId(), tag: 'markdown' }
}

const mapChild = (child: CardChild): LarkElement | LarkElement[] | null => {
  switch (child.type) {
    case 'text':
      return { content: child.content, element_id: nextElementId(), tag: 'markdown' }
    case 'divider':
      return { element_id: nextElementId(), tag: 'hr' }
    case 'image':
      return {
        alt: { content: child.alt ?? '', tag: 'plain_text' },
        element_id: nextElementId(),
        img_key: child.url,
        tag: 'img',
      }
    case 'actions':
      return (child.children ?? []).map((btn) => mapButton(btn))
    case 'section':
      return mapSection(child)
    default: {
      if ('content' in child && child.content) {
        return { content: child.content as string, element_id: nextElementId(), tag: 'markdown' }
      }
      return null
    }
  }
}

const cardToLarkInteractive = (card: CardChild): Record<string, unknown> => {
  resetElementCounter()
  const elements = (card.children ?? []).flatMap((child) => {
    const result = mapChild(child)
    if (Array.isArray(result)) {
      return result
    }
    if (result) {
      return [result]
    }
    return []
  })
  const result: Record<string, unknown> = {
    body: { elements },
    config: { update_multi: true },
    schema: '2.0',
  }
  if (card.title) {
    result['header'] = { template: 'blue', title: { content: card.title, tag: 'plain_text' } }
  }
  return result
}

const cardToFallbackText = (card: CardChild): string => {
  const parts: string[] = []
  if (card.title) {
    parts.push(`**${card.title}**`)
  }
  if (card.subtitle) {
    parts.push(card.subtitle)
  }
  for (const child of card.children ?? []) {
    if (child.type === 'text') {
      parts.push(child.content ?? '')
    }
  }
  return parts.join('\n')
}

const cardMapper = { cardToFallbackText, cardToLarkInteractive }

export default cardMapper
