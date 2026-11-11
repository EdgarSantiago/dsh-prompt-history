// UI-only editor action. Never submits, queues, calls a model, or restores files.
export function prepareReuse(input, item, expectedRevision) {
  if (!item || typeof item.text !== 'string' || !item.text.trim()) return {kind:'blocked',reason:'empty'}
  if (item.truncated) return {kind:'blocked',reason:'truncated'}
  // Native paste removes its private reference markers. Never let that silently
  // change a recalled prompt (or expose a leading ! to the terminal observer).
  if (/[\uE100-\uE11D\uFFFC]/u.test(item.text)) return {kind:'blocked',reason:'referenceText'}
  if (item.text.startsWith('!')) return {kind:'blocked',reason:'bang'}
  if (!input || input.phase !== 'plain' || input.claim) return {kind:'blocked',reason:'busy'}
  if (input.attachmentIds?.length) return {kind:'blocked',reason:'attachments'}
  if (input.occurrences?.length) return {kind:'blocked',reason:'references'}
  if (!Number.isSafeInteger(input.draftRev) || typeof input.draft !== 'string') return {kind:'blocked',reason:'busy'}
  if (expectedRevision !== undefined && input.draftRev !== expectedRevision) return {kind:'blocked',reason:'changed'}
  if (input.draft.length && expectedRevision === undefined) return {kind:'confirm',revision:input.draftRev}
  return {kind:'ready',span:{start:0,end:input.draft.length,draftRev:input.draftRev}}
}
export function reusePrompt(input, actions, item, expectedRevision) {
  const decision = prepareReuse(input.state.getSnapshot(),item,expectedRevision)
  if (decision.kind !== 'ready') return decision
  // Native insertText compares the revision again and preserves intervening edits.
  if (!actions.insertText(item.text,decision.span)) return {kind:'blocked',reason:'changed'}
  actions.persistDraft()
  input.focus()
  return {kind:'applied'}
}
