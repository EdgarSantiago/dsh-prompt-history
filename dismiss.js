// Owned roots only: composedPath includes their children and top-layer popovers.
// Do not cancel the pointer or redirect focus; the clicked control keeps its action.
export function listenForOutsidePointer(target, getRoots, onOutside) {
  const handle = event => {
    const path = event.composedPath()
    if (!getRoots().some(root => root && path.includes(root))) onOutside()
  }
  const options = { capture: true }
  target.addEventListener('pointerdown', handle, options)
  return () => target.removeEventListener('pointerdown', handle, options)
}
