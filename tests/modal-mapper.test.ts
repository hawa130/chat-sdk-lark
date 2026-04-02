import { beforeEach, describe, expect, it } from 'vitest'
import { modalMapper } from '../src/modal-mapper.ts'
import type {
  LarkButtonElement,
  LarkCardBody,
  LarkFormElement,
  LarkInputElement,
  LarkMarkdownElement,
  LarkSelectElement,
} from '../src/types.ts'

beforeEach(() => {
  modalMapper.resetIdCounter()
})

const findForm = (card: LarkCardBody): LarkFormElement =>
  card.body.elements.find((el) => el.tag === 'form') as LarkFormElement

const findInput = (form: LarkFormElement): LarkInputElement | undefined =>
  form.elements.find((el): el is LarkInputElement => el.tag === 'input')

const findSelect = (form: LarkFormElement): LarkSelectElement | undefined =>
  form.elements.find((el): el is LarkSelectElement => el.tag === 'select_static')

const findMarkdown = (form: LarkFormElement): LarkMarkdownElement | undefined =>
  form.elements.find((el): el is LarkMarkdownElement => el.tag === 'markdown')

/** Walk form elements (including column_set children) to find all buttons. */
function findButtonsInForm(form: LarkFormElement): LarkButtonElement[] {
  const buttons: LarkButtonElement[] = []
  for (const el of form.elements) {
    if (el.tag === 'button') {
      buttons.push(el)
    }
    if (el.tag === 'column_set') {
      for (const col of el.columns) {
        for (const child of col.elements) {
          if (child.tag === 'button') {
            buttons.push(child)
          }
        }
      }
    }
  }
  return buttons
}

describe('modalMapper.modalToLarkCard', () => {
  it('wraps children in a form container with header', () => {
    const result = modalMapper.modalToLarkCard(
      { callbackId: 'fb', children: [], title: 'Feedback', type: 'modal' as const },
      'ctx_1',
    )

    expect(result.schema).toBe('2.0')
    expect(result.header?.title.content).toBe('Feedback')
    const form = findForm(result)
    expect(form).toBeDefined()
    expect(form.tag).toBe('form')
  })

  it('maps text_input to Lark input element', () => {
    const result = modalMapper.modalToLarkCard(
      {
        callbackId: 'test',
        children: [
          {
            id: 'name',
            initialValue: 'Alice',
            label: 'Name',
            maxLength: 100,
            optional: true,
            placeholder: 'Enter name',
            type: 'text_input' as const,
          },
        ],
        title: 'T',
        type: 'modal' as const,
      },
      'ctx',
    )

    const input = findInput(findForm(result))
    expect(input).toBeDefined()
    expect(input!.name).toBe('name')
    expect(input!.label?.content).toBe('Name')
    expect(input!.placeholder?.content).toBe('Enter name')
    expect(input!.default_value).toBe('Alice')
    expect(input!.max_length).toBe(100)
    expect(input!.required).toBe(false)
  })

  it('maps multiline text_input with input_type', () => {
    const result = modalMapper.modalToLarkCard(
      {
        callbackId: 'test',
        children: [{ id: 'desc', label: 'Desc', multiline: true, type: 'text_input' as const }],
        title: 'T',
        type: 'modal' as const,
      },
      'ctx',
    )

    const input = findInput(findForm(result))
    expect(input!.input_type).toBe('multiline_text')
  })

  it('maps select with options and initialOption', () => {
    const result = modalMapper.modalToLarkCard(
      {
        callbackId: 'test',
        children: [
          {
            id: 'cat',
            initialOption: 'bug',
            label: 'Category',
            options: [
              { label: 'Bug', value: 'bug' },
              { label: 'Feature', value: 'feature' },
            ],
            placeholder: 'Pick one',
            type: 'select' as const,
          },
        ],
        title: 'T',
        type: 'modal' as const,
      },
      'ctx',
    )

    const select = findSelect(findForm(result))
    expect(select).toBeDefined()
    expect(select!.options).toHaveLength(2)
    expect(select!.options[0]!.text.content).toBe('Bug')
    expect(select!.options[0]!.value).toBe('bug')
    expect(select!.initial_option).toBe('bug')
    expect(select!.placeholder?.content).toBe('Pick one')
  })

  it('maps radio_select as select_static fallback', () => {
    const result = modalMapper.modalToLarkCard(
      {
        callbackId: 'test',
        children: [
          {
            id: 'status',
            label: 'Status',
            options: [
              { label: 'Open', value: 'open' },
              { label: 'Closed', value: 'closed' },
            ],
            type: 'radio_select' as const,
          },
        ],
        title: 'T',
        type: 'modal' as const,
      },
      'ctx',
    )

    const select = findSelect(findForm(result))
    expect(select).toBeDefined()
    expect(select!.options).toHaveLength(2)
  })

  it('maps text child as markdown', () => {
    const result = modalMapper.modalToLarkCard(
      {
        callbackId: 'test',
        children: [{ content: 'Please fill out the form.', type: 'text' as const }],
        title: 'T',
        type: 'modal' as const,
      },
      'ctx',
    )

    const md = findMarkdown(findForm(result))
    expect(md?.content).toBe('Please fill out the form.')
  })

  it('maps fields child as key-value column_set pairs', () => {
    const result = modalMapper.modalToLarkCard(
      {
        callbackId: 'test',
        children: [
          {
            children: [
              { label: 'Status', type: 'field' as const, value: 'Open' },
              { label: 'Priority', type: 'field' as const, value: 'High' },
            ],
            type: 'fields' as const,
          },
        ],
        title: 'T',
        type: 'modal' as const,
      },
      'ctx',
    )

    const form = findForm(result)
    const colSets = form.elements.filter((el) => el.tag === 'column_set')
    expect(colSets.length).toBeGreaterThanOrEqual(2)
  })

  it('includes submit button with encoded metadata', () => {
    const result = modalMapper.modalToLarkCard(
      {
        callbackId: 'my_form',
        children: [],
        privateMetadata: '{"foo":"bar"}',
        submitLabel: 'Go',
        title: 'Form',
        type: 'modal' as const,
      },
      'ctx_456',
    )

    const buttons = findButtonsInForm(findForm(result))
    const submitBtn = buttons.find((b) => b.form_action_type === 'submit')
    expect(submitBtn).toBeDefined()
    expect(submitBtn!.text.content).toBe('Go')

    expect(submitBtn!.behaviors).toBeDefined()
    const cbValue = submitBtn!.behaviors![0]!
    expect(cbValue.type).toBe('callback')
    if (cbValue.type === 'callback') {
      expect(cbValue.value['__modal']).toBe('1')
      expect(cbValue.value['__callbackId']).toBe('my_form')
      expect(cbValue.value['__privateMetadata']).toBe('{"foo":"bar"}')
      expect(cbValue.value['__contextId']).toBe('ctx_456')
    }
  })

  it('renders close button with callback metadata inside the form', () => {
    const result = modalMapper.modalToLarkCard(
      {
        callbackId: 'my_form',
        children: [],
        closeLabel: 'Nah',
        title: 'Form',
        type: 'modal' as const,
      },
      'ctx_456',
    )

    const buttons = findButtonsInForm(findForm(result))
    const closeBtn = buttons.find((b) => b.form_action_type === undefined)
    expect(closeBtn).toBeDefined()
    expect(closeBtn!.text.content).toBe('Nah')
    expect(closeBtn!.behaviors).toBeDefined()
    const cbValue = closeBtn!.behaviors![0]!
    expect(cbValue.type).toBe('callback')
    if (cbValue.type === 'callback') {
      expect(cbValue.value['__modalClose']).toBe('1')
      expect(cbValue.value['__notifyOnClose']).toBeUndefined()
    }
  })

  it('encodes notifyOnClose metadata on the form close button', () => {
    const result = modalMapper.modalToLarkCard(
      {
        callbackId: 'my_form',
        children: [],
        closeLabel: 'Close form',
        notifyOnClose: true,
        privateMetadata: '{"foo":"bar"}',
        title: 'Form',
        type: 'modal' as const,
      },
      'ctx_456',
    )

    const formButtons = findButtonsInForm(findForm(result))
    expect(formButtons).toHaveLength(2)

    const closeBtn = formButtons.find(
      (b) =>
        b.form_action_type === undefined &&
        b.behaviors?.[0]?.type === 'callback' &&
        b.behaviors[0].value['__modalClose'] === '1',
    )
    expect(closeBtn).toBeDefined()
    expect(closeBtn!.text.content).toBe('Close form')
    const cbValue = closeBtn!.behaviors![0]!
    expect(cbValue.type).toBe('callback')
    if (cbValue.type === 'callback') {
      expect(cbValue.value['__modal']).toBe('1')
      expect(cbValue.value['__callbackId']).toBe('my_form')
      expect(cbValue.value['__privateMetadata']).toBe('{"foo":"bar"}')
      expect(cbValue.value['__contextId']).toBe('ctx_456')
      expect(cbValue.value['__modalClose']).toBe('1')
      expect(cbValue.value['__notifyOnClose']).toBe('1')
      expect(cbValue.value['__modalTitle']).toBe('Form')
    }
  })

  it('uses cancel as the default lark fallback close label', () => {
    const result = modalMapper.modalToLarkCard(
      { callbackId: 'test', children: [], title: 'Test', type: 'modal' as const },
      'ctx',
    )

    const buttons = findButtonsInForm(findForm(result))
    const closeBtn = buttons.find((b) => b.form_action_type === undefined)
    expect(closeBtn).toBeDefined()
    expect(closeBtn!.text.content).toBe('Cancel')
  })

  it('uses default submit label when not specified', () => {
    const result = modalMapper.modalToLarkCard(
      { callbackId: 'test', children: [], title: 'Test', type: 'modal' as const },
      'ctx',
    )

    const buttons = findButtonsInForm(findForm(result))
    const submitBtn = buttons.find((b) => b.form_action_type === 'submit')
    expect(submitBtn!.text.content).toBe('Submit')
  })
})

describe('modalMapper.modalToLarkCard with errors', () => {
  it('inserts error markdown before the errored field', () => {
    const result = modalMapper.modalToLarkCard(
      {
        callbackId: 'test',
        children: [
          { id: 'name', label: 'Name', type: 'text_input' as const },
          { id: 'email', label: 'Email', type: 'text_input' as const },
        ],
        title: 'Test',
        type: 'modal' as const,
      },
      'ctx',
      { name: 'Name is required' },
    )

    const form = findForm(result)
    const errorEl = form.elements.find(
      (el): el is LarkMarkdownElement =>
        el.tag === 'markdown' && (el.content?.includes('Name is required') ?? false),
    )
    expect(errorEl).toBeDefined()
  })
})
