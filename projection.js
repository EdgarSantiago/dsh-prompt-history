import { z } from 'zod'

export const PROJECTION_KEY = 'localPromptHistory'
export const MAX_ITEMS = 60
export const MAX_TEXT = 32768
export const MAX_TOTAL_TEXT = 262144

const safeInteger = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
export const promptRowSchema = z.object({
  id: z.string().min(1).max(1024),
  seq: safeInteger,
  time: z.number().finite().min(0),
  text: z.string().min(1).max(MAX_TEXT),
  hasAttachments: z.boolean(),
  truncated: z.boolean(),
}).strict()

export const promptHistoryViewSchema = z.object({
  version: z.literal(1),
  items: z.array(promptRowSchema).max(MAX_ITEMS),
  omitted: safeInteger,
}).strict().superRefine((view, context) => {
  if (view.items.reduce((sum, item) => sum + item.text.length, 0) > MAX_TOTAL_TEXT) {
    context.addIssue({ code: 'custom', message: 'Prompt-history text exceeds its total bound', path: ['items'] })
  }
  for (let index = 1; index < view.items.length; index++) {
    if (view.items[index].seq <= view.items[index - 1].seq) context.addIssue({ code: 'custom', message: 'Prompt occurrences must remain in log order', path: ['items', index, 'seq'] })
  }
})

export const promptHistoryStateSchema = z.object({
  inheritedEventCount: safeInteger,
  eligible: z.boolean(),
  view: promptHistoryViewSchema,
}).strict().superRefine((state, context) => {
  if (state.view.items.some(item => item.seq < state.inheritedEventCount)) context.addIssue({ code: 'custom', message: 'Inherited occurrences cannot enter prompt history', path: ['view', 'items'] })
  if (!state.eligible && (state.view.items.length || state.view.omitted)) context.addIssue({ code: 'custom', message: 'Subagent histories must remain empty', path: ['view'] })
})

function textOf(content) {
  let text = '', meaningful = false, truncated = false, hasAttachments = false, sawText = false
  const append = value => {
    const remaining = MAX_TEXT - text.length
    if (remaining > 0) text += value.slice(0, remaining)
    if (value.length > remaining) truncated = true
  }
  for (const block of content) {
    if (block?.type === 'image' || block?.type === 'file') hasAttachments = true
    if (block?.type !== 'text' || typeof block.text !== 'string') continue
    if (/\S/u.test(block.text)) meaningful = true
    if (sawText) append('\n')
    sawText = true
    append(block.text)
  }
  // A bounded preview must not end halfway through an astral character.
  if (truncated && /[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1)
  return meaningful ? { text, truncated, hasAttachments } : null
}

export function initialState(header, inheritedEventCount = 0) {
  if (!Number.isSafeInteger(inheritedEventCount) || inheritedEventCount < 0) throw new RangeError('Invalid inherited-event count')
  return {
    inheritedEventCount,
    eligible: header?.origin !== 'subagent',
    view: { version: 1, items: [], omitted: 0 },
  }
}

export function applyPromptEvent(state, event) {
  if (!state.eligible || event?.type !== 'user/message' || event.data?.source?.kind !== 'user') return state
  if (!Number.isSafeInteger(event.seq) || event.seq < state.inheritedEventCount || !Number.isFinite(event.time) || event.time < 0) return state
  const message = event.data
  if (typeof message.id !== 'string' || !message.id || message.id.length > 1024 || !Array.isArray(message.content)) return state
  const value = textOf(message.content)
  if (!value) return state
  // Native replay is ordered and exactly-once. Ignore a stale or duplicate
  // occurrence without conflating separate sends of identical text.
  const last = state.view.items.at(-1)
  if (last && event.seq <= last.seq) return state
  const row = { id: message.id, seq: event.seq, time: event.time, ...value }
  const items = [...state.view.items, row]
  let total = items.reduce((sum, item) => sum + item.text.length, 0), removed = 0
  while (items.length > MAX_ITEMS || total > MAX_TOTAL_TEXT) {
    total -= items.shift().text.length
    removed++
  }
  return {
    ...state,
    view: { version: 1, items, omitted: state.view.omitted + removed },
  }
}

/** A native materialized view, never a separate prompt log or HTTP authority. */
export const promptHistoryProjection = {
  key: PROJECTION_KEY,
  stateVersion: 1,
  stateSchema: promptHistoryStateSchema,
  init: initialState,
  apply: applyPromptEvent,
  wire: {
    summary: false,
    viewSchema: promptHistoryViewSchema,
    view: state => state.view,
  },
}
