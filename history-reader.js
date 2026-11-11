export const HISTORY_KEY = 'localPromptHistory'
export const SESSION_LIMIT = 50
const BATCH = 10
const initial = () => ({ phase:'idle', scope:'all', items:[], issues:[], loaded:0, available:0, totalAvailable:0, omitted:0, more:false })

function unwrap(result) {
  if (!result?.ok) throw Object.assign(new Error(result?.error?.code || 'read-failed'), { code:result?.error?.code || 'read-failed' })
  return result.value
}
export function sessionTitle(row) {
  const title = row?.projections?.values?.title
  return typeof title === 'string' && title.trim() ? title : row?.sessionId?.slice(0, 8) || '—'
}
export function recentSessions(rows, currentId) {
  const unique = new Map()
  for (const row of rows || []) {
    if (typeof row?.sessionId !== 'string' || row.origin === 'subagent' || row.blank || unique.has(row.sessionId)) continue
    unique.set(row.sessionId, row)
  }
  const result = [...unique.values()].sort((a,b)=>(b.updatedAt || 0)-(a.updatedAt || 0))
  const at = result.findIndex(row => row.sessionId === currentId)
  if (at > 0) result.unshift(...result.splice(at,1))
  return result
}
export function filterPrompts(items, query) {
  const term = query.trim().normalize('NFD').replace(/\p{M}/gu,'').toLocaleLowerCase()
  if (!term) return items
  return items.filter(item => item.text.normalize('NFD').replace(/\p{M}/gu,'').toLocaleLowerCase().includes(term))
}

// Native Session Remote enforces both list visibility and each projection read.
// No raw event download, Agent activation, persistent browser text, or HTTP route.
export function createHistoryReader(remote, currentSessionId) {
  let state = initial(), alive = true, paused = false, generation = 0, controller, candidates = [], offset = 0
  const listeners = new Set(), groups = new Map()
  const publish = patch => { if (!alive) return; state = {...state,...patch}; for (const fn of listeners) fn() }
  const valid = (g, signal) => alive && g === generation && !signal.aborted
  const merge = () => {
    const items = [...groups.values()].flatMap(group=>group.items).sort((a,b)=>b.time-a.time || b.seq-a.seq || a.sessionId.localeCompare(b.sessionId))
    return { items, omitted:[...groups.values()].reduce((n,group)=>n+group.omitted,0) }
  }
  async function batch(g, signal) {
    const selected = candidates.slice(offset, offset+BATCH)
    offset += selected.length
    let index = 0
    const issues = [...state.issues]
    async function worker() {
      while (valid(g,signal) && index < selected.length) {
        const row = selected[index++]
        try {
          const value = unwrap(await remote.projections({sessionId:row.sessionId},signal))
          if (!valid(g,signal)) return
          if (!value || value.kind !== 'sequenced') throw Object.assign(new Error('migration-required'),{code:'migration-required'})
          const view = value.values?.[HISTORY_KEY]
          if (!view || view.version !== 1 || !Array.isArray(view.items) || view.items.length > 60) throw Object.assign(new Error('projection-unavailable'),{code:'projection-unavailable'})
          let textBudget = 0
          const titleValue = value.values?.title
          const title = typeof titleValue === 'string' && titleValue.trim() ? titleValue : sessionTitle(row)
          const items = view.items.map(item => {
            if (typeof item?.text !== 'string' || item.text.length > 32768 || !Number.isSafeInteger(item.seq) || !Number.isFinite(item.time) || (textBudget += item.text.length) > 262144) throw Object.assign(new Error('invalid-projection'),{code:'invalid-projection'})
            return {...item,sessionId:row.sessionId,title,key:row.sessionId+':'+item.seq}
          })
          groups.set(row.sessionId,{items,omitted:Number.isSafeInteger(view.omitted)&&view.omitted>=0?view.omitted:0})
        } catch (error) {
          if (!valid(g,signal)) return
          issues.push({sessionId:row.sessionId,code:error.code || 'read-failed'})
        }
        if (valid(g,signal)) publish({...merge(),issues:[...issues],loaded:state.loaded+1})
      }
    }
    await Promise.all([worker(),worker()])
    if (valid(g,signal)) publish({phase:'ready',more:offset<candidates.length})
  }
  async function load(scope = 'all') {
    if (!alive) return
    paused = false
    controller?.abort(); controller = new AbortController()
    const signal = controller.signal, g = ++generation
    candidates = []; offset = 0; groups.clear()
    publish({...initial(),phase:'loading',scope})
    try {
      if (scope === 'current') candidates = [{sessionId:currentSessionId}]
      else {
        const value = unwrap(await remote.list({},signal))
        if (!valid(g,signal)) return
        const all = recentSessions(value?.items,currentSessionId)
        candidates = all.slice(0,SESSION_LIMIT)
        publish({totalAvailable:all.length})
      }
      if (!valid(g,signal)) return
      publish({available:candidates.length,totalAvailable:scope==='current'?1:state.totalAvailable})
      await batch(g,signal)
    } catch (error) {
      if (valid(g,signal)) publish({phase:'error',issues:[{code:error.code || 'read-failed'}]})
    }
  }
  async function more() {
    if (!alive || paused || state.phase !== 'ready' || !state.more) return
    publish({phase:'loading',more:false})
    await batch(generation,controller.signal)
  }
  // Stop IO as soon as closing begins; the last frame may fade for 120 ms.
  function cancel() { paused=true; generation++; controller?.abort() }
  function dispose() { alive=false; cancel(); groups.clear(); candidates=[]; state=initial(); listeners.clear() }
  return {state:{getSnapshot:()=>state,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn)}},load,more,cancel,dispose}
}
