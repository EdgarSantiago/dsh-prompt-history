import { promptHistoryProjection } from './projection.js'

export const name = 'prompt-history'
export const inject = ['sessionProjections']

export async function apply(ctx) {
  // The native registry already owns registration on this fiber, including
  // cancellation during its asynchronous ready handoff. Retain the ready handle
  // in an explicit, idempotent cleanup effect as well; never use a dispose event.
  const handle = await ctx.sessionProjections.register(promptHistoryProjection)
  ctx.effect(() => {
    let active = true
    return async () => {
      if (!active) return
      active = false
      await handle.dispose()
    }
  })
}
