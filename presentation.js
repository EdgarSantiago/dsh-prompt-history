// Accept native projection milliseconds and ISO timestamps, never missing values.
function validDate(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? new Date(value.getTime()) : null
  if (typeof value !== 'string' && typeof value !== 'number') return null
  if (typeof value === 'string') {
    const parts = /^([+-]\d{6}|\d{4})-(\d{2})-(\d{2})T/.exec(value)
    if (!parts) return null
    const [year, month, day] = parts.slice(1).map(Number)
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    if (day < 1 || day > (days[month - 1] || 0)) return null
  }
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date : null
}

function formatter(locale, options) {
  try {
    const supported = Intl.DateTimeFormat.supportedLocalesOf(locale).length > 0
    return new Intl.DateTimeFormat(supported ? locale : 'en', options)
  } catch { return new Intl.DateTimeFormat('en', options) }
}

function dayKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/** Keep adjacent local days together, without sorting or cloning prompt rows. */
export function groupPromptsByDay(items, { locale = 'en', now = new Date(), today = 'Today', yesterday = 'Yesterday', unknown = 'Unknown date' } = {}) {
  const current = validDate(now)
  const previous = current && new Date(current.getTime())
  if (previous) previous.setDate(previous.getDate() - 1)
  const todayKey = current && dayKey(current), yesterdayKey = previous && dayKey(previous)
  const shortDate = formatter(locale, { month: 'short', day: 'numeric' })
  const fullDate = formatter(locale, { month: 'short', day: 'numeric', year: 'numeric' })
  const groups = []
  for (const item of Array.isArray(items) ? items : []) {
    const date = validDate(item?.time)
    const key = date ? dayKey(date) : 'unknown'
    let group = groups.at(-1)
    if (!group || group.key !== key) {
      let label = unknown
      if (date) {
        label = (current && date.getFullYear() === current.getFullYear() ? shortDate : fullDate).format(date)
        const relative = key === todayKey ? today : key === yesterdayKey ? yesterday : null
        if (relative) label = `${relative} · ${label}`
      }
      group = { key, label, items: [] }
      groups.push(group)
    }
    group.items.push(item)
  }
  return groups
}

/** Compact local clock time; full timestamps belong in the row's title. */
export function promptTime(value, locale = 'en') {
  const date = validDate(value)
  return date ? formatter(locale, { hour: '2-digit', minute: '2-digit' }).format(date) : '—'
}
