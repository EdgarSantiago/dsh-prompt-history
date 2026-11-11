import { en, pt } from './strings.js'

const ownedMessages = new Set([en.reused, pt.reused])

// One-time migration of our old notify('info', ...) banner. The 0.2.2
// SessionInputShell exposes the notices SnapshotStore separately from draft
// state. Capability-check it; never clear unrelated notices or modify drafts.
export function clearLegacyHistoryNotice(input) {
  const notices = input?.notices
  if (typeof notices?.getSnapshot !== 'function' || typeof notices?.set !== 'function') return false
  const current = notices.getSnapshot()
  if (current?.level !== 'info' || !ownedMessages.has(current.text)) return false
  notices.set(null)
  return true
}
