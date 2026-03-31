import type { LarkColumnSetElement, LarkMarkdownElement } from './types.ts'

interface FieldLike {
  label?: string
  value?: unknown
}

/** Map a list of label/value fields to two-column layout. Shared by card-mapper and modal-mapper. */
const mapFieldsToColumns = (fields: FieldLike[], nextId: () => string): LarkColumnSetElement[] =>
  fields.map((field) => ({
    background_style: 'default',
    columns: [
      {
        elements: [
          {
            content: `**${field.label ?? ''}**`,
            element_id: nextId(),
            tag: 'markdown',
          } satisfies LarkMarkdownElement,
        ],
        tag: 'column',
        vertical_align: 'top',
        weight: 1,
        width: 'weighted',
      },
      {
        elements: [
          {
            content: String(field.value ?? ''),
            element_id: nextId(),
            tag: 'markdown',
            text_align: 'right',
          } satisfies LarkMarkdownElement,
        ],
        tag: 'column',
        vertical_align: 'top',
        weight: 1,
        width: 'weighted',
      },
    ],
    flex_mode: 'none',
    tag: 'column_set',
  }))

export { mapFieldsToColumns }
