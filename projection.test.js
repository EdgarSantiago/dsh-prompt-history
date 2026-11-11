import test from 'node:test'
import assert from 'node:assert/strict'
import { applyPromptEvent, initialState, MAX_ITEMS, MAX_TEXT, MAX_TOTAL_TEXT, PROJECTION_KEY, promptHistoryProjection, promptHistoryStateSchema, promptHistoryViewSchema } from './projection.js'

const header = { id: 'fixture-session', version: 1, createdAt: 1, isSeeded: false }
const event = (seq, text = 'A human prompt', extra = {}) => ({
  type: 'user/message', seq, time: seq + 100,
  data: { id: 'message-' + seq, role: 'user', source: { kind: 'user', rpcId: 'rpc-' + seq }, content: [{ type: 'text', text }] },
  ...extra,
})
const fold = (events, state = initialState(header)) => events.reduce(applyPromptEvent, state)
function freeze(value) { if (value && typeof value === 'object') { Object.freeze(value); for (const item of Object.values(value)) freeze(item) } return value }

test('only human user-role event sources produce a compact text-only wire projection', () => {
  const kinds = ['system-prompt', 'model', 'tool', 'schedule', 'goal', 'skill', 'subagent', 'user-rpc']
  const zero = initialState(header)
  for (const kind of kinds) {
    const item = event(1); item.data.source = { kind }
    assert.equal(applyPromptEvent(zero, item), zero)
  }
  for (const type of ['assistant/message', 'developer/message', 'system/message', 'tool/result', 'command/run', 'turn/start']) assert.equal(applyPromptEvent(zero, event(1, 'not human', { type })), zero)
  const one = applyPromptEvent(zero, event(0, '  first line\nsecond line  '))
  assert.equal(one.view.items[0].text, '  first line\nsecond line  ')
  assert.deepEqual(Object.keys(one.view.items[0]).sort(), ['hasAttachments', 'id', 'seq', 'text', 'time', 'truncated'].sort())
  assert.equal(one.view.items[0].id, 'message-0')
  assert.equal(promptHistoryProjection.key, PROJECTION_KEY)
  assert.equal(promptHistoryProjection.wire.summary, false, 'Human prompt text must not enter the all-session header listing')
  assert.equal(promptHistoryProjection.wire.view(one), one.view)
})

test('ordered text blocks use native visible-text newlines and attachments become only a boolean', () => {
  const item = event(0)
  item.data.content = [{ type: 'text', text: 'first' }, { type: 'image', attachment: { secret: 'image bytes never copied' } }, { type: 'text', text: 'second' }, { type: 'file', attachment: { name: 'secret.txt' } }, { type: 'reasoning', text: 'not prompt text' }]
  const state = fold([item])
  assert.equal(state.view.items[0].text, 'first\nsecond')
  assert.equal(state.view.items[0].hasAttachments, true)
  assert.ok(!JSON.stringify(state).includes('secret'))
  const imageOnly = event(1); imageOnly.data.content = [{ type: 'image', attachment: {} }]
  assert.equal(applyPromptEvent(state, imageOnly), state)
  assert.equal(applyPromptEvent(state, event(2, ' \n\t ')), state)
})

test('human principal metadata is not copied, and legacy direct-user sources remain eligible', () => {
  const item = event(0); item.data.source = { kind: 'user', principal: { id: 'other-human-principal' }, clientTimeZone: 'Somewhere' }
  const state = fold([item])
  assert.equal(state.view.items.length, 1)
  assert.ok(!JSON.stringify(state).includes('other-human-principal'))
  assert.ok(!JSON.stringify(state).includes('Somewhere'))
  const legacy = event(1); legacy.data.source = { kind: 'user' }
  assert.equal(fold([legacy], state).view.items.length, 2)
})

test('fork inherited prefix is excluded but newly sent fork prompts are retained', () => {
  const fork = { ...header, isSeeded: true, parentSession: 'parent-session' }
  const state = fold([event(0), event(2), event(3, 'new fork prompt')], initialState(fork, 3))
  assert.deepEqual(state.view.items.map(item => item.seq), [3])
  assert.equal(state.view.omitted, 0)
  const child = initialState({ ...fork, origin: 'subagent' }, 0)
  assert.equal(applyPromptEvent(child, event(4, 'generated child instructions')), child)
})

test('fold is immutable, reuses unchanged references, and separate identical sends remain separate', () => {
  const zero = freeze(initialState(header)), item = freeze(event(0))
  const one = freeze(applyPromptEvent(zero, item))
  assert.equal(zero.view.items.length, 0)
  assert.equal(applyPromptEvent(one, event(1, 'tool output', { type: 'tool/result' })), one)
  assert.equal(promptHistoryProjection.wire.view(one), one.view)
  assert.equal(applyPromptEvent(one, item), one)
  const two = applyPromptEvent(one, event(1))
  assert.equal(two.view.items.length, 2)
  assert.notEqual(two, one); assert.notEqual(two.view.items, one.view.items)
})

test('count bound retains the newest occurrences and reports evictions without growing on unrelated events', () => {
  const state = fold(Array.from({ length: MAX_ITEMS + 5 }, (_, index) => event(index)))
  assert.equal(state.view.items.length, MAX_ITEMS)
  assert.equal(state.view.items[0].seq, 5)
  assert.equal(state.view.omitted, 5)
  for (let index = 0; index < 1000; index++) assert.equal(applyPromptEvent(state, event(index + 100, 'large tool output', { type: 'tool/result' })), state)
})

test('text and aggregate caps are explicit, character-safe and never silently reusable', () => {
  const tooLong = fold([event(0, 'x'.repeat(MAX_TEXT + 1))])
  assert.equal(tooLong.view.items[0].text.length, MAX_TEXT)
  assert.equal(tooLong.view.items[0].truncated, true)
  const astral = fold([event(0, 'x'.repeat(MAX_TEXT - 1) + '😀')])
  assert.equal(astral.view.items[0].text.length, MAX_TEXT - 1)
  assert.equal(astral.view.items[0].truncated, true)
  const count = MAX_TOTAL_TEXT / MAX_TEXT + 1
  const capped = fold(Array.from({ length: count }, (_, index) => event(index, 'x'.repeat(MAX_TEXT))))
  assert.equal(capped.view.items.reduce((sum, row) => sum + row.text.length, 0), MAX_TOTAL_TEXT)
  assert.equal(capped.view.omitted, 1)
  assert.equal(capped.view.items[0].seq, 1)
})

test('JSON checkpoint validation and tail recomputation match a fresh full fold', () => {
  const events = Array.from({ length: 75 }, (_, index) => event(index, 'prompt ' + index))
  const checkpoint = JSON.parse(JSON.stringify(fold(events.slice(0, 40))))
  const restored = promptHistoryStateSchema.parse(checkpoint)
  const resumed = fold(events.slice(40), restored)
  assert.deepEqual(resumed, fold(events))
  assert.deepEqual(promptHistoryViewSchema.parse(promptHistoryProjection.wire.view(resumed)), resumed.view)
  assert.equal(promptHistoryStateSchema.safeParse({ ...checkpoint, unexpected: true }).success, false)
  assert.equal(promptHistoryStateSchema.safeParse({ ...checkpoint, inheritedEventCount: 1000 }).success, false)
  assert.equal(promptHistoryStateSchema.safeParse({ ...checkpoint, eligible: false }).success, false)
  const reversed = structuredClone(checkpoint); reversed.view.items.reverse()
  assert.equal(promptHistoryStateSchema.safeParse(reversed).success, false)
  const oversized = structuredClone(checkpoint); oversized.view.items[0].text = 'x'.repeat(MAX_TEXT + 1)
  assert.equal(promptHistoryStateSchema.safeParse(oversized).success, false)
  const totalOverflow = { version: 1, items: Array.from({ length: 9 }, (_, index) => ({ id: String(index), seq: index, time: 1, text: 'x'.repeat(MAX_TEXT), hasAttachments: false, truncated: false })), omitted: 0 }
  assert.equal(promptHistoryViewSchema.safeParse(totalOverflow).success, false)
})

test('malformed records never throw or mutate the existing valid projection', () => {
  const zero = initialState(header)
  const records = [null, {}, { type: 'user/message', data: null }, event(-1), event(1, 'x', { time: Infinity }), event(1, 'x', { time: -1 }), event(0, 'x', { data: { source: { kind: 'user' }, id: '', content: [] } }), event(0, 'x', { data: { source: { kind: 'user' }, id: 'x', content: 'not blocks' } })]
  for (const item of records) assert.equal(applyPromptEvent(zero, item), zero)
  assert.throws(() => initialState(header, -1), /Invalid inherited/)
})
