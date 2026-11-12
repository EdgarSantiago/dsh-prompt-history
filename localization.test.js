import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { fileURLToPath } from 'node:url'
import { buildSync } from 'esbuild'
import * as messages from './strings.js'
import { groupPromptsByDay, promptTime } from './presentation.js'

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8')
const locales = ['en', 'pt', 'pt-BR', 'zh', 'ja', 'es', 'fr', 'de', 'ru']
const dictionary = locale => messages[locale === 'pt-BR' ? 'pt' : locale]

// Exercise the actual entry points at the public ModuleLoader/apply boundary.
// No React hook renderer or imitation of the host's translation algorithm is used.
function registrations(code) {
  let plugin
  runInNewContext(code, { window: { __ModuleLoader__: { load: value => { plugin = value } } } })
  assert.equal(plugin.id, '@local/dsh-prompt-history')
  const runtime = plugin.factory(name => {
    assert.ok(['react', 'react-dom'].includes(name), name)
    return {}
  })
  const registered = new Map(), bindings = [], cleanups = [], removed = []
  runtime.apply({
    locale: {
      register(namespace, locale, dict) {
        assert.equal(namespace, 'local-prompt-history')
        assert.ok(!registered.has(locale), locale)
        registered.set(locale, dict)
        return () => { removed.push(locale); registered.delete(locale) }
      },
      bind(namespace) { bindings.push(namespace); return () => assert.fail('translation must remain lazy') },
    },
    effect(start) { cleanups.push(start()) },
    on() { return () => {} },
    slots: { inject() {} },
  })
  return { registered, bindings, dispose() { for (const cleanup of cleanups.reverse()) cleanup() }, removed }
}

const sourceBundle = buildSync({
  entryPoints: [fileURLToPath(new URL('client.js', import.meta.url))],
  bundle: true, write: false, platform: 'browser', format: 'iife', target: ['es2022'], charset: 'utf8',
  legalComments: 'eof', external: ['react', 'react-dom', 'react/jsx-runtime'],
}).outputFiles[0].text

test('prebuilt Client exactly matches the current source build', () => {
  assert.equal(read('lib/client.js'), sourceBundle, 'run pnpm run build after changing the Client or its dependencies')
})

for (const [entry, code] of [['source', sourceBundle], ['lib/client.js', read('lib/client.js')]]) {
  test(`${entry}: registers eight full languages, pt-BR alias and English fallback with cleanup`, () => {
    const fixture = registrations(code)
    assert.deepEqual([...fixture.registered.keys()], locales)
    assert.deepEqual(fixture.bindings, ['local-prompt-history'])
    for (const locale of locales) {
      // JSON normalizes objects crossing the VM realm; dictionaries are real production data.
      assert.deepEqual(JSON.parse(JSON.stringify(fixture.registered.get(locale))), dictionary(locale), locale)
    }
    assert.equal(fixture.registered.get('pt-BR'), fixture.registered.get('pt'))
    const fallback = fixture.registered.get('en')
    assert.equal(fallback.title, 'Prompt history')
    assert.equal(fallback.copyFailed, messages.en.copyFailed)
    for (const locale of locales) {
      for (const key of Object.keys(fixture.registered.get(locale))) assert.ok(fallback[key], `${locale}.${key}`)
    }
    fixture.dispose()
    assert.equal(fixture.registered.size, 0)
    assert.deepEqual(fixture.removed, [...locales].reverse())
  })
}

test('distributable locale metadata covers every language and the Portuguese alias', () => {
  const files = readdirSync(new URL('locale/', import.meta.url)).filter(file => file.endsWith('.json')).sort()
  assert.deepEqual(files, locales.map(locale => locale + '.json').sort())
  const keys = Object.keys(JSON.parse(read('locale/en.json')).meta).sort()
  for (const locale of locales) {
    const metadata = JSON.parse(read(`locale/${locale}.json`))
    assert.deepEqual(Object.keys(metadata), ['meta'])
    assert.deepEqual(Object.keys(metadata.meta).sort(), keys, locale)
    assert.equal(metadata.meta.title, dictionary(locale).title, locale)
    for (const value of Object.values(metadata.meta)) assert.ok(typeof value === 'string' && value.trim(), locale)
    if (locale !== 'en') assert.notEqual(metadata.meta.description, JSON.parse(read('locale/en.json')).meta.description, locale)
  }
  assert.deepEqual(JSON.parse(read('locale/pt-BR.json')), JSON.parse(read('locale/pt.json')))
})

test('every UI and metadata translation preserves native interpolation names and excludes invisible markers', () => {
  // This is the public locale service's {name} syntax, not an interpolation implementation.
  const placeholders = text => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort()
  const metadata = JSON.parse(read('locale/en.json')).meta
  for (const locale of locales) {
    for (const [key, value] of Object.entries(dictionary(locale))) {
      assert.deepEqual(placeholders(value), placeholders(messages.en[key]), `${locale}.${key}`)
      assert.ok(!/[\u200b\ufeff]/u.test(value), `${locale}.${key}`)
    }
    for (const [key, value] of Object.entries(JSON.parse(read(`locale/${locale}.json`)).meta)) {
      assert.deepEqual(placeholders(value), placeholders(metadata[key]), `metadata ${locale}.${key}`)
      assert.ok(!/[\u200b\ufeff]/u.test(value), `metadata ${locale}.${key}`)
    }
  }
})

test('open menu geometry follows locale changes without resetting menu or keyboard focus', () => {
  const client = read('client.js')
  const card = client.slice(client.indexOf('function Card('), client.indexOf('function Panel('))
  const geometry = card.slice(card.indexOf('if(!menuOpen||!menuRef.current'), card.indexOf('},[menuOpen,point,locale])'))
  assert.ok(geometry.includes('getBoundingClientRect()'))
  assert.ok(geometry.includes('setPosition('))
  assert.ok(!geometry.includes('.focus('), 'a locale-driven resize must preserve the focused menu item')
  assert.ok(card.includes("if(menuOpen)menuRef.current?.querySelector('button:not(:disabled)')?.focus({preventScroll:true})},[menuOpen])"))
  assert.ok(!card.includes('key:locale'), 'do not remount a menu to translate it')
  assert.ok(!/\[locale\][^\n]*hideMenu|hideMenu\(\)[^\n]*\[locale\]/.test(card))
})

test('dynamic states, aria labels, confirmation and feedback keys exist in every dictionary', () => {
  const keys = ['open', 'title', 'search', 'scope', 'copy', 'attachments', 'moreActions', 'refresh', 'close',
    'confirm', 'replace', 'cancel', 'expand', 'collapse', 'reverseSearch', 'panelKeys', 'older', 'newer',
    'failed', 'migration', 'partial', 'noMatches', 'empty', 'loading', 'today', 'yesterday', 'unknownDate',
    'copied', 'copyFailed', 'busy', 'draftAttachments', 'references', 'changed', 'bang', 'truncated',
    'invalid', 'referenceText', 'actionUnavailable', 'actionFailed']
  for (const locale of locales) for (const key of keys) assert.ok(dictionary(locale)[key], `${locale}.${key}`)
  const client = read('client.js')
  assert.ok(client.includes('ctx.locale.bind(ns)'))
  assert.ok(client.includes('useSyncExternalStore(fn=>ctx.locale.subscribe(fn),()=>ctx.locale.getSnapshot())'))
  assert.ok(client.includes('const locale=useLocale()'))
  assert.ok(client.includes('function Launcher(props){\n      useLocale()'))
  assert.ok(!/setFeedback\(t\(|onFeedback\(t\(/.test(client), 'feedback must retain keys, not stale translated strings')
  assert.ok(client.includes("role:'status'},t(feedback)"))
  assert.ok(client.includes('},item.text)'), 'user prompt text remains verbatim')
  assert.ok(client.includes('navigator.clipboard.writeText(item.text)'))
})

test('all active languages format days and times with real Intl, preserving user content', () => {
  const now = new Date(2026, 10, 12, 18)
  const row = Object.freeze({ time: new Date(2026, 10, 12, 13, 42).getTime(), text: '用户 prompt ! / referência 🧪' })
  const older = Object.freeze({ time: new Date(2025, 3, 8, 9, 7).getTime(), text: 'Original text' })
  for (const locale of locales) {
    const dict = dictionary(locale)
    const groups = groupPromptsByDay([row, older], { locale, now, today: dict.today, yesterday: dict.yesterday, unknown: dict.unknownDate })
    assert.equal(groups[0].label, `${dict.today} · ${new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(row.time)}`)
    assert.equal(groups[1].label, new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', year: 'numeric' }).format(older.time))
    assert.equal(promptTime(row.time, locale), new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(row.time))
    assert.equal(groups[0].items[0], row)
    assert.equal(groups[1].items[0], older)
  }
})

test('unknown and malformed date locales fall back to English without changing content', () => {
  const row = Object.freeze({ time: new Date(2025, 2, 3, 14, 17).getTime(), text: 'Never translate me' })
  const options = { now: new Date(2026, 10, 12) }
  for (const locale of ['xx-XX', 'bad_locale', '', null]) {
    assert.deepEqual(groupPromptsByDay([row], { ...options, locale }), groupPromptsByDay([row], { ...options, locale: 'en' }))
    assert.equal(promptTime(row.time, locale), promptTime(row.time, 'en'))
  }
})
