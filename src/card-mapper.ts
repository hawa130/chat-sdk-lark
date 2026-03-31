import type {
  CardChild,
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
import { mapFieldsToColumns } from './card-shared.ts'

const ID_SIZE = 12
const MIN_PAGE_SIZE = 1
const MAX_PAGE_SIZE = 10

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

/* eslint-disable no-magic-numbers -- bit math for nanoid-style ID generation */
const POOL_SIZE_MULTIPLIER = 128
const MASK = (2 << (31 - Math.clz32((ALPHABET.length - 1) | 1))) - 1
const STEP = Math.ceil((1.6 * MASK * ID_SIZE) / ALPHABET.length)
/* eslint-enable no-magic-numbers */

/* eslint-disable no-magic-numbers -- nanoid-style random byte pool implementation */

// Pre-allocated random byte pool to amortize crypto.getRandomValues calls
let pool: Uint8Array<ArrayBuffer> | undefined = undefined
let poolOffset = 0

const fillPool = (bytes: number): void => {
  if (!pool || pool.length < bytes) {
    pool = new Uint8Array(bytes * POOL_SIZE_MULTIPLIER)
    globalThis.crypto.getRandomValues(pool)
    poolOffset = 0
  } else if (poolOffset + bytes > pool.length) {
    globalThis.crypto.getRandomValues(pool)
    poolOffset = 0
  }
  poolOffset += bytes
}

const randomPool = (bytes: number): Uint8Array => {
  fillPool(bytes)
  return pool!.subarray(poolOffset - bytes, poolOffset)
}

const generateId = (size: number = ID_SIZE): string => {
  let id = ''
  // eslint-disable-next-line no-constant-condition -- intentional rejection-sampling loop
  while (true) {
    const bytes = randomPool(STEP)
    for (let idx = STEP - 1; idx >= 0; idx--) {
      id += ALPHABET[bytes[idx]! & MASK] || ''
      if (id.length >= size) {
        return id
      }
    }
  }
}

/* eslint-enable no-magic-numbers */

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
      text: { content: opt.label ?? '', tag: 'plain_text' },
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
  mapFieldsToColumns(child.children ?? [], nextElementId)

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
      tag: 'column',
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

export { cardMapper }
