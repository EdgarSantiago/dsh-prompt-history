export const ENTER_MS = 180
export const EXIT_MS = 120
// Pure scheduling only. React owns rendering, CSS owns visual interpolation.
// stop() cancels this effect generation and supports React effect reactivation.
export function createPresenceDriver(publish, clock) {
  let state = {present:false,phase:'closed'}, generation = 0, frame, timer
  const update = next => {
    if (next.present === state.present && next.phase === state.phase) return
    state = next; publish(next)
  }
  function stop() {
    generation++
    if (frame !== undefined) clock.cancelFrame(frame)
    if (timer !== undefined) clock.clearDelay(timer)
    frame = timer = undefined
  }
  function setOpen(open, instant = false) {
    stop()
    const version = generation
    if (instant) { update({present:open,phase:open?'open':'closed'}); return }
    if (open) {
      if (state.phase === 'exit' || state.phase === 'open') { update({present:true,phase:'open'}); return }
      update({present:true,phase:'enter'})
      // Paint the initial pose before switching to the CSS transition target.
      frame = clock.frame(() => {
        if (generation !== version) return
        frame = clock.frame(() => { if (generation === version) { frame=undefined; update({present:true,phase:'open'}) } })
      })
    } else if (!state.present || state.phase === 'enter') update({present:false,phase:'closed'})
    else {
      update({present:true,phase:'exit'})
      timer = clock.delay(() => { if (generation === version) { timer=undefined; update({present:false,phase:'closed'}) } }, EXIT_MS+32)
    }
  }
  return {setOpen,stop}
}
