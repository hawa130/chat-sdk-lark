/** Minimal shapes for card elements (JSX components, not importable as types). */
interface CardChild {
  alt?: string
  children?: CardChild[]
  content?: string
  label?: string
  style?: string
  subtitle?: string
  title?: string
  type: string
  url?: string
  value?: unknown
}

type LarkElement = Record<string, unknown>

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
    tag: 'button',
    text: { content: btn.label, tag: 'plain_text' },
    type: buttonType(btn.style),
  }
  if (btn.value != null) {
    el['value'] = { action: String(btn.value) }
  }
  return el
}

const mapActions = (el: CardChild): LarkElement => ({
  actions: (el.children ?? []).map((child) => mapButton(child)),
  tag: 'action',
})

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
  return { content: texts, tag: 'markdown' }
}

const mapChild = (child: CardChild): LarkElement | null => {
  switch (child.type) {
    case 'text':
      return { content: child.content, tag: 'markdown' }
    case 'divider':
      return { tag: 'hr' }
    case 'image':
      return {
        alt: { content: child.alt ?? '', tag: 'plain_text' },
        img_key: child.url,
        tag: 'img',
      }
    case 'actions':
      return mapActions(child)
    case 'section':
      return mapSection(child)
    default: {
      if ('content' in child && child.content) {
        return { content: child.content as string, tag: 'markdown' }
      }
      return null
    }
  }
}

const cardToLarkInteractive = (card: CardChild): Record<string, unknown> => {
  const elements = (card.children ?? []).map(mapChild).filter(Boolean)
  const result: Record<string, unknown> = { body: { elements } }
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
