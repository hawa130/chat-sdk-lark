import type {
  LarkButtonElement,
  LarkCardBody,
  LarkCardElement,
  LarkCardHeader,
  LarkColumnSetElement,
  LarkInputElement,
  LarkMarkdownElement,
  LarkSelectElement,
} from './types.ts'

/**
 * Structural type for Chat SDK ModalElement children.
 * We use a local type to avoid coupling the mapper to SDK internals.
 */
interface ModalChild {
  children?: ModalChild[]
  content?: string
  id?: string
  initialOption?: string
  initialValue?: string
  label?: string
  maxLength?: number
  multiline?: boolean
  optional?: boolean
  options?: Array<{ label: string; value: string }>
  placeholder?: string
  type: string
  value?: string
}

interface ModalInput {
  callbackId: string
  children: ModalChild[]
  closeLabel?: string
  notifyOnClose?: boolean
  privateMetadata?: string
  submitLabel?: string
  title: string
  type: 'modal'
}

const MODAL_MARKER = '1'
const DEFAULT_SUBMIT_LABEL = 'Submit'
const DEFAULT_CLOSE_LABEL = 'Cancel'

let idCounter = 0
const nextId = (): string => `fm_${String(++idCounter)}`
const resetIdCounter = (): void => {
  idCounter = 0
}

const mapTextInput = (child: ModalChild): LarkInputElement => {
  const el: LarkInputElement = {
    element_id: nextId(),
    name: child.id ?? nextId(),
    required: child.optional !== true,
    tag: 'input',
    width: 'fill',
  }
  if (child.label) {
    el.label = { content: child.label, tag: 'plain_text' }
  }
  if (child.placeholder) {
    el.placeholder = { content: child.placeholder, tag: 'plain_text' }
  }
  if (child.initialValue) {
    el.default_value = child.initialValue
  }
  if (child.multiline) {
    el.input_type = 'multiline_text'
  }
  if (child.maxLength != null) {
    el.max_length = child.maxLength
  }
  return el
}

const mapSelect = (child: ModalChild): LarkSelectElement => {
  const el: LarkSelectElement = {
    behaviors: [{ type: 'callback', value: { id: child.id ?? '' } }],
    element_id: nextId(),
    name: child.id ?? nextId(),
    options: (child.options ?? []).map((opt) => ({
      text: { content: opt.label, tag: 'plain_text' as const },
      value: opt.value,
    })),
    required: child.optional !== true,
    tag: 'select_static',
    width: 'fill',
  }
  if (child.placeholder) {
    el.placeholder = { content: child.placeholder, tag: 'plain_text' }
  }
  if (child.initialOption) {
    el.initial_option = child.initialOption
  }
  return el
}

const mapFields = (child: ModalChild): LarkColumnSetElement[] =>
  (child.children ?? []).map((field) => ({
    background_style: 'default',
    columns: [
      {
        elements: [
          {
            content: `**${field.label ?? ''}**`,
            element_id: nextId(),
            tag: 'markdown' as const,
          } satisfies LarkMarkdownElement,
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
            element_id: nextId(),
            tag: 'markdown' as const,
            text_align: 'right' as const,
          } satisfies LarkMarkdownElement,
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

const mapModalChild = (child: ModalChild): LarkCardElement | LarkCardElement[] | null => {
  switch (child.type) {
    case 'text_input':
      return mapTextInput(child)
    case 'select':
    case 'radio_select':
      return mapSelect(child)
    case 'text':
      return {
        content: child.content ?? '',
        element_id: nextId(),
        tag: 'markdown',
      } satisfies LarkMarkdownElement
    case 'fields':
      return mapFields(child)
    default:
      return null
  }
}

const buildMetadataValue = (
  modal: ModalInput,
  contextId: string,
  extra?: Record<string, string>,
): Record<string, string> => ({
  __callbackId: modal.callbackId,
  __contextId: contextId,
  __modal: MODAL_MARKER,
  ...(modal.privateMetadata ? { __privateMetadata: modal.privateMetadata } : {}),
  ...extra,
})

const buildSubmitButton = (modal: ModalInput, contextId: string): LarkButtonElement => ({
  behaviors: [{ type: 'callback', value: buildMetadataValue(modal, contextId) }],
  element_id: nextId(),
  form_action_type: 'submit',
  name: nextId(),
  tag: 'button',
  text: { content: modal.submitLabel ?? DEFAULT_SUBMIT_LABEL, tag: 'plain_text' },
  type: 'primary_filled',
})

const buildCloseButton = (modal: ModalInput, contextId: string): LarkButtonElement => ({
  behaviors: [
    {
      type: 'callback',
      value: buildMetadataValue(
        modal,
        contextId,
        modal.notifyOnClose ? { __notifyOnClose: '1' } : {},
      ),
    },
  ],
  element_id: nextId(),
  form_action_type: 'reset',
  name: nextId(),
  tag: 'button',
  text: { content: modal.closeLabel ?? DEFAULT_CLOSE_LABEL, tag: 'plain_text' },
  type: 'default',
})

const buildButtonRow = (modal: ModalInput, contextId: string): LarkColumnSetElement => ({
  background_style: 'default',
  columns: [
    {
      elements: [buildSubmitButton(modal, contextId)],
      tag: 'column',
      vertical_align: 'top',
      width: 'auto',
    },
    {
      elements: [buildCloseButton(modal, contextId)],
      tag: 'column',
      vertical_align: 'top',
      width: 'auto',
    },
  ],
  flex_mode: 'none',
  tag: 'column_set',
})

const modalToLarkCard = (
  modal: ModalInput,
  contextId: string,
  errors?: Record<string, string>,
): LarkCardBody => {
  const formElements: LarkCardElement[] = []

  for (const child of modal.children) {
    if (errors && child.id && errors[child.id]) {
      formElements.push({
        content: `**\u26a0\ufe0f ${errors[child.id]}**`,
        element_id: nextId(),
        tag: 'markdown',
      })
    }
    const mapped = mapModalChild(child)
    if (Array.isArray(mapped)) {
      formElements.push(...mapped)
    } else if (mapped) {
      formElements.push(mapped)
    }
  }

  formElements.push(buildButtonRow(modal, contextId))

  const result: LarkCardBody = {
    body: {
      elements: [
        {
          elements: formElements,
          name: `form_${modal.callbackId}`,
          tag: 'form',
        },
      ],
    },
    config: { update_multi: true },
    schema: '2.0',
  }

  if (modal.title) {
    const header: LarkCardHeader = {
      template: 'blue',
      title: { content: modal.title, tag: 'plain_text' },
    }
    result.header = header
  }

  return result
}

const modalMapper = { modalToLarkCard, resetIdCounter }

export { modalMapper }
export type { ModalInput }
