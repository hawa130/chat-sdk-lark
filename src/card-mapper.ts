import { customAlphabet } from 'nanoid'
import type {
  LarkBehavior,
  LarkButtonElement,
  LarkCardBody,
  LarkCardElement,
  LarkCardHeader,
  LarkColumnSetElement,
  LarkHrElement,
  LarkImgElement,
  LarkMarkdownElement,
  LarkSelectElement,
  LarkTableElement,
} from './types.ts'

/** Minimal shapes for card elements (JSX components, not importable as types). */
interface CardChild {
  align?: string[]
  alt?: string
  children?: CardChild[]
  content?: string
  disabled?: boolean
  headers?: string[]
  id?: string
  imageUrl?: string
  initialOption?: string
  label?: string
  options?: CardChild[]
  placeholder?: string
  rows?: string[][]
  style?: string
  subtitle?: string
  title?: string
  type: string
  url?: string
  value?: unknown
}

const NANO_ID_SIZE = 12
const MIN_PAGE_SIZE = 1
const MAX_PAGE_SIZE = 10

const generateId = customAlphabet(
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
  NANO_ID_SIZE,
)

const nextElementId = (): string => `el_${generateId()}`

const buttonType = (style: string | undefined): string => {
  if (style === 'danger') {
    return 'danger'
  }
  if (style === 'secondary' || style === 'default') {
    return 'default'
  }
  return 'primary_filled'
}

const buildCallbackValue = (btn: CardChild): Record<string, string> => {
  const val: Record<string, string> = { id: btn.id ?? '' }
  if (btn.value != null) {
    val['action'] = String(btn.value)
  }
  return val
}

const mapButton = (btn: CardChild, behaviors?: LarkBehavior[]): LarkButtonElement => {
  const el: LarkButtonElement = {
    behaviors: behaviors ?? [{ type: 'callback', value: buildCallbackValue(btn) }],
    element_id: nextElementId(),
    tag: 'button',
    text: { content: btn.label ?? '', tag: 'plain_text' },
    type: buttonType(btn.style),
  }
  if (btn.disabled) {
    el.disabled = true
  }
  return el
}

const mapSelect = (child: CardChild): LarkSelectElement => {
  const placeholderText = child.placeholder ?? child.label
  const el: LarkSelectElement = {
    behaviors: [{ type: 'callback', value: { id: child.id ?? '' } }],
    element_id: nextElementId(),
    options: (child.options ?? []).map((opt) => ({
      text: { content: opt.label ?? '', tag: 'plain_text' as const },
      value: String(opt.value ?? ''),
    })),
    tag: 'select_static',
  }
  if (placeholderText) {
    el.placeholder = { content: placeholderText, tag: 'plain_text' }
  }
  if (child.initialOption) {
    el.initial_option = child.initialOption
  }
  return el
}

const mapActionChild = (child: CardChild): LarkCardElement | null => {
  if (child.type === 'link-button') {
    return mapButton(child, [{ default_url: child.url ?? '', type: 'open_url' }])
  }
  if (child.type === 'select' || child.type === 'radio_select') {
    return mapSelect(child)
  }
  return mapButton(child)
}

const mapFields = (child: CardChild): LarkColumnSetElement[] =>
  (child.children ?? []).map((field) => ({
    background_style: 'default',
    columns: [
      {
        elements: [
          {
            content: `**${field.label ?? ''}**`,
            element_id: nextElementId(),
            tag: 'markdown' as const,
          },
        ],
        tag: 'column' as const,
        vertical_align: 'top',
        weight: 1,
        width: 'weighted',
      },
      {
        elements: [
          {
            content: String(field.value ?? ''),
            element_id: nextElementId(),
            tag: 'markdown' as const,
            text_align: 'right' as const,
          },
        ],
        tag: 'column' as const,
        vertical_align: 'top',
        weight: 1,
        width: 'weighted',
      },
    ],
    flex_mode: 'none',
    tag: 'column_set' as const,
  }))

const mapTable = (child: CardChild): LarkTableElement | null => {
  if (!child.headers?.length) {
    return null
  }
  const columns = child.headers.map((header, idx) => ({
    data_type: 'text' as const,
    display_name: header,
    horizontal_align: child.align?.[idx] ?? 'left',
    name: `col_${String(idx)}`,
  }))
  const tableRows = (child.rows ?? []).map((row) =>
    Object.fromEntries(child.headers!.map((_hdr, idx) => [`col_${String(idx)}`, row[idx] ?? ''])),
  )
  return {
    columns,
    element_id: nextElementId(),
    header_style: { bold: true, text_align: 'left' },
    page_size: Math.min(Math.max(tableRows.length, MIN_PAGE_SIZE), MAX_PAGE_SIZE),
    rows: tableRows,
    tag: 'table',
  }
}

const mapActions = (child: CardChild): LarkColumnSetElement | null => {
  const items = (child.children ?? [])
    .map((actionChild) => mapActionChild(actionChild))
    .filter((item): item is LarkCardElement => item != null)
  if (!items.length) {
    return null
  }
  return {
    background_style: 'default',
    columns: items.map((item) => ({
      elements: [item],
      tag: 'column' as const,
      vertical_align: 'top',
      weight: 1,
      width: 'auto',
    })),
    flex_mode: 'flow',
    tag: 'column_set',
  }
}

const flatMapChildren = (children: CardChild[]): LarkCardElement[] =>
  children.flatMap((ch) => {
    const result = mapChild(ch)
    if (Array.isArray(result)) {
      return result
    }
    if (result) {
      return [result]
    }
    return []
  })

const mapChild = (child: CardChild): LarkCardElement | LarkCardElement[] | null => {
  switch (child.type) {
    case 'text':
      return {
        content: child.content,
        element_id: nextElementId(),
        tag: 'markdown',
      } satisfies LarkMarkdownElement
    case 'divider':
      return { element_id: nextElementId(), tag: 'hr' } satisfies LarkHrElement
    case 'image':
      return {
        alt: { content: child.alt ?? '', tag: 'plain_text' },
        element_id: nextElementId(),
        img_key: child.url,
        tag: 'img',
      } satisfies LarkImgElement
    case 'link':
      return {
        content: `[${child.label ?? ''}](${child.url ?? ''})`,
        element_id: nextElementId(),
        tag: 'markdown',
      } satisfies LarkMarkdownElement
    case 'fields':
      return mapFields(child)
    case 'table':
      return mapTable(child)
    case 'actions':
      return mapActions(child)
    case 'section':
      return flatMapChildren(child.children ?? [])
    default: {
      const { content } = child
      if (content) {
        return {
          content,
          element_id: nextElementId(),
          tag: 'markdown',
        } satisfies LarkMarkdownElement
      }
      return null
    }
  }
}

const cardToLarkInteractive = (card: CardChild): LarkCardBody => {
  const elements = flatMapChildren(card.children ?? [])

  if (card.imageUrl) {
    elements.unshift({
      alt: { content: card.title ?? '', tag: 'plain_text' },
      element_id: nextElementId(),
      img_key: card.imageUrl,
      tag: 'img',
    })
  }

  const result: LarkCardBody = {
    body: { elements },
    config: { update_multi: true },
    schema: '2.0',
  }
  if (card.title) {
    const header: LarkCardHeader = {
      template: 'blue',
      title: { content: card.title, tag: 'plain_text' },
    }
    if (card.subtitle) {
      header.subtitle = { content: card.subtitle, tag: 'plain_text' }
    }
    result.header = header
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
