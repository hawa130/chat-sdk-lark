import type { Actions, Button, Card, CardText, Image, Section } from 'chat'

type CardChild =
  | Actions
  | Button
  | CardText
  | Image
  | Section
  | { children?: CardChild[]; content?: string; type: string }

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

const mapButton = (btn: Button): LarkElement => {
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

const mapActions = (el: Actions): LarkElement => ({
  actions: el.children.map((child) => mapButton(child as Button)),
  tag: 'action',
})

const mapSection = (el: Section): LarkElement | null => {
  const texts = el.children
    .map((child) => {
      if ('content' in child) {
        return (child as CardText).content
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
      return { content: (child as CardText).content, tag: 'markdown' }
    case 'divider':
      return { tag: 'hr' }
    case 'image':
      return {
        alt: { content: (child as Image).alt ?? '', tag: 'plain_text' },
        img_key: (child as Image).url,
        tag: 'img',
      }
    case 'actions':
      return mapActions(child as Actions)
    case 'section':
      return mapSection(child as Section)
    default: {
      if ('content' in child && child.content) {
        return { content: child.content as string, tag: 'markdown' }
      }
      return null
    }
  }
}

const cardToLarkInteractive = (card: Card): Record<string, unknown> => {
  const elements = card.children.map(mapChild).filter(Boolean)
  const result: Record<string, unknown> = { body: { elements } }
  if (card.title) {
    result['header'] = { template: 'blue', title: { content: card.title, tag: 'plain_text' } }
  }
  return result
}

const cardToFallbackText = (card: Card): string => {
  const parts: string[] = []
  if (card.title) {
    parts.push(`**${card.title}**`)
  }
  if ('subtitle' in card && card.subtitle) {
    parts.push(card.subtitle as string)
  }
  for (const child of card.children) {
    if (child.type === 'text') {
      parts.push((child as CardText).content)
    }
  }
  return parts.join('\n')
}

const cardMapper = { cardToFallbackText, cardToLarkInteractive }

export default cardMapper
