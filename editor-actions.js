// Public Slot InputActions only. Spans use native detect coordinates, never
// clipboard draft.length (atomic quotes/references have different projections).
function prepare(input,item,span,quote) {
  if(!item||typeof item.text!=='string'||!item.text.trim())return {kind:'blocked',reason:'empty'}
  if(item.truncated)return {kind:'blocked',reason:'truncated'}
  if(/[\uE100-\uE11D\uFFFC]/u.test(item.text))return {kind:'blocked',reason:'referenceText'}
  const snapshot=input?.state.getSnapshot()
  if(!snapshot||snapshot.phase!=='plain'||snapshot.claim||!Number.isSafeInteger(snapshot.draftRev))return {kind:'blocked',reason:'busy'}
  if(!span||!Number.isSafeInteger(span.start)||!Number.isSafeInteger(span.end)||span.start<0||span.end<span.start||span.draftRev!==snapshot.draftRev)return {kind:'blocked',reason:'changed'}
  if(snapshot.draft.startsWith('!')||(!quote&&item.text.startsWith('!')))return {kind:'blocked',reason:'bang'}
  return {kind:'ready'}
}

export function pasteHistoryPrompt(input,actions,item,span) {
  const decision=prepare(input,item,span,false)
  if(decision.kind!=='ready')return decision
  if(!actions.insertText(item.text,span))return {kind:'blocked',reason:'changed'}
  actions.persistDraft()
  input.focus()
  return {kind:'applied'}
}

export function quoteHistoryPrompt(input,actions,item,span) {
  const decision=prepare(input,item,span,true)
  if(decision.kind!=='ready')return decision
  // Native QuoteNode insertion appends after the retained selection, preserving
  // the selection and existing structured content. Never imitate it with Markdown.
  if(!actions.insertQuote(item.text))return {kind:'blocked',reason:'unavailable'}
  actions.persistDraft()
  input.focus()
  return {kind:'applied'}
}
