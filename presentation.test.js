import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { groupPromptsByDay, promptTime } from './presentation.js'

const iso = (year, month, day, hour = 12, minute = 0) => new Date(year, month - 1, day, hour, minute).toISOString()
const dateLabel = (value, locale = 'en', year = false) => new Intl.DateTimeFormat(locale, {
  month: 'short', day: 'numeric', ...(year ? { year: 'numeric' } : {}),
}).format(new Date(value))
const timeLabel = (value, locale = 'en') => new Intl.DateTimeFormat(locale, {
  hour: '2-digit', minute: '2-digit',
}).format(new Date(value))

test('same local date groups different ISO times and uses translated relative labels', () => {
  const now = new Date(2026, 10, 10, 18)
  const items = [{ time: iso(2026, 11, 10, 15, 20) }, { time: iso(2026, 11, 10, 1, 5) }, { time: iso(2026, 11, 9) }]
  const groups = groupPromptsByDay(items, { locale: 'pt-BR', now, today: 'Hoje', yesterday: 'Ontem' })
  assert.deepEqual(groups.map(group => group.key), ['2026-11-10', '2026-11-09'])
  assert.deepEqual(groups.map(group => group.label), [
    `Hoje · ${dateLabel(items[0].time, 'pt-BR')}`,
    `Ontem · ${dateLabel(items[2].time, 'pt-BR')}`,
  ])
  assert.deepEqual(groups.map(group => group.items.length), [2, 1])
})

test('numeric projection times, including epoch zero, remain valid', () => {
  const now = new Date(2026, 10, 10, 18)
  const items = [{ time: now.getTime() }, { time: 0 }]
  const groups = groupPromptsByDay(items, { now })
  assert.equal(groups[0].label, `Today · ${dateLabel(now)}`)
  assert.notEqual(groups[1].key, 'unknown')
  assert.equal(groups[1].label, dateLabel(0, 'en', true))
  assert.equal(promptTime(0), timeLabel(0))
  assert.equal(promptTime(now.getTime(), 'pt-BR'), timeLabel(now, 'pt-BR'))
})

test('preserves exact row identity and input order, including noncontiguous repeated days', () => {
  const rows = Object.freeze([
    Object.freeze({ id: 'a', time: iso(2026, 11, 10) }),
    Object.freeze({ id: 'b', time: iso(2026, 11, 9) }),
    Object.freeze({ id: 'c', time: iso(2026, 11, 10, 1) }),
    Object.freeze({ id: 'd', time: null }),
    Object.freeze({ id: 'e', time: iso(2026, 11, 8) }),
    Object.freeze({ id: 'f' }),
  ])
  const groups = groupPromptsByDay(rows, { now: new Date(2026, 10, 10) })
  assert.deepEqual(groups.map(group => group.key), ['2026-11-10', '2026-11-09', '2026-11-10', 'unknown', '2026-11-08', 'unknown'])
  const flattened = groups.flatMap(group => group.items)
  assert.equal(flattened.length, rows.length)
  flattened.forEach((row, index) => assert.equal(row, rows[index]))
})

test('year boundary keeps Yesterday translation and includes its previous calendar year', () => {
  const previous = iso(2025, 12, 31, 23, 59)
  const groups = groupPromptsByDay([{ time: iso(2026, 1, 1, 0, 1) }, { time: previous }], {
    locale: 'pt-BR', now: new Date(2026, 0, 1, 0, 5), today: 'Hoje', yesterday: 'Ontem',
  })
  assert.equal(groups[0].label, `Hoje · ${dateLabel(iso(2026, 1, 1), 'pt-BR')}`)
  assert.equal(groups[1].label, `Ontem · ${dateLabel(previous, 'pt-BR', true)}`)
})

test('absolute dates omit current year and include earlier and future years', () => {
  const values = [iso(2026, 4, 12), iso(2025, 4, 12), iso(2027, 4, 12)]
  const groups = groupPromptsByDay(values.map(time => ({ time })), { now: new Date(2026, 10, 10) })
  assert.deepEqual(groups.map(group => group.label), values.map((value, index) => dateLabel(value, 'en', index !== 0)))
})

test('invalid and missing dates form an explicit translated unknown group', () => {
  const values = [undefined, null, '', ' ', 'not-a-date', '2026-02-30T12:00:00Z', '2026-00-01T12:00:00Z', '2026-11-00T12:00:00Z', '3', {}, [], NaN, Infinity, -Infinity, new Date(NaN), Symbol('invalid')]
  const rows = values.map(time => ({ time }))
  rows.push({}, null, undefined)
  const groups = groupPromptsByDay(rows, { unknown: 'Data desconhecida' })
  assert.equal(groups.length, 1)
  assert.equal(groups[0].key, 'unknown')
  assert.equal(groups[0].label, 'Data desconhecida')
  rows.forEach((row, index) => assert.equal(groups[0].items[index], row))
  values.forEach(value => assert.equal(promptTime(value), '—'))
  assert.equal(promptTime(), '—')
})

test('empty and missing item inputs return no groups', () => {
  for (const items of [[], undefined, null, {}]) assert.deepEqual(groupPromptsByDay(items), [])
})

test('malformed and unsupported locales safely fall back to English', () => {
  const value = iso(2025, 5, 17, 13, 42)
  const now = new Date(2026, 10, 10)
  for (const locale of ['bad_locale', 'en--US', 'xx-XX', null, 42]) {
    assert.equal(groupPromptsByDay([{ time: value }], { locale, now })[0].label, dateLabel(value, 'en', true))
    assert.equal(promptTime(value, locale), timeLabel(value, 'en'))
  }
})

test('invalid now disables relative labels and retains the full calendar date', () => {
  const value = iso(2026, 11, 10)
  for (const now of [new Date(NaN), 'invalid', null, NaN, Infinity, Symbol('invalid')]) {
    assert.equal(groupPromptsByDay([{ time: value }], { now })[0].label, dateLabel(value, 'en', true))
  }
})

test('clock formatting has hours/minutes only and follows the active locale', () => {
  const value = iso(2026, 11, 10, 13, 42).replace(':00.000', ':59.000')
  for (const locale of ['en', 'pt-BR', 'de-DE']) assert.equal(promptTime(value, locale), timeLabel(value, locale))
  assert.equal(promptTime(new Date(value)), timeLabel(value))
})

function inTimeZone(t, zone, body) {
  const helper = new URL('./presentation.js', import.meta.url).href
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict'
    import { groupPromptsByDay, promptTime } from ${JSON.stringify(helper)}
    if (Intl.DateTimeFormat().resolvedOptions().timeZone !== ${JSON.stringify(zone)}) {
      console.log('unsupported')
    } else {
      ${body}
      console.log('passed')
    }
  `], { encoding: 'utf8', env: { ...process.env, TZ: zone } })
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr)
  if (result.stdout.trim() === 'unsupported') t.skip(`Node does not support isolated TZ=${zone}`)
  else assert.equal(result.stdout.trim(), 'passed')
}

test('local midnight, not UTC midnight, determines the group and compact time', t => {
  inTimeZone(t, 'America/New_York', `
    const items = [
      { time: '2026-11-10T04:59:00.000Z' },
      { time: '2026-11-10T05:01:00.000Z' },
      { time: '2026-11-11T04:59:00.000Z' },
    ]
    const groups = groupPromptsByDay(items, { now: new Date('2026-11-10T17:00:00.000Z') })
    assert.deepEqual(groups.map(group => group.key), ['2026-11-09', '2026-11-10'])
    assert.equal(groups[0].label, 'Yesterday · Nov 9')
    assert.equal(groups[1].label, 'Today · Nov 10')
    assert.equal(groups[1].items.length, 2)
    assert.equal(promptTime(items[1].time, 'pt-BR'), '00:01')
  `)
})

test('Yesterday uses local calendar arithmetic across both DST transitions', t => {
  inTimeZone(t, 'America/New_York', `
    const springNow = new Date('2026-03-09T00:30:00-04:00')
    assert.equal(new Date(springNow.getTime() - 86400000).getDate(), 7)
    const spring = groupPromptsByDay([{ time: '2026-03-08T12:00:00-04:00' }], { now: springNow })
    assert.equal(spring[0].label, 'Yesterday · Mar 8')
    const fallNow = new Date('2026-11-01T23:30:00-05:00')
    assert.equal(new Date(fallNow.getTime() - 86400000).getDate(), 1)
    const fall = groupPromptsByDay([{ time: '2026-10-31T12:00:00-04:00' }], { now: fallNow })
    assert.equal(fall[0].label, 'Yesterday · Oct 31')
  `)
})
