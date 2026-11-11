import test from 'node:test'
import assert from 'node:assert/strict'
import { Context, Service } from '@deepseek-ai/cordis'
import * as plugin from './index.js'
import { PROJECTION_KEY } from './projection.js'

// Real Cordis fibers and Service tracing. The small registry carrier reproduces
// the documented fiber-owned asynchronous registration seam, without opening
// any user Session, persistence, network endpoint, Agent or model.
async function runtime(options = {}) {
  const root = new Context(), active = new Map(), stats = { releases: 0, ready: false, reject: false }
  class Registry extends Service {
    constructor(ctx) { super(ctx, 'sessionProjections') }
    async register(definition) {
      assert.equal(definition.key, PROJECTION_KEY)
      if (stats.reject) throw Error('Fixture registration rejected')
      const release = this.ctx.effect(() => {
        assert.equal(active.has(definition.key), false)
        active.set(definition.key, definition)
        return () => { stats.releases++; active.delete(definition.key) }
      })
      options.onStarted?.()
      await (options.ready || Promise.resolve())
      this.ctx.fiber.assertActive()
      stats.ready = true
      return { dispose: async () => release() }
    }
  }
  await root.plugin({ apply(ctx) { new Registry(ctx) } })
  return { root, active, stats }
}

test('Host waits for projection readiness instead of publishing an unready registration', async () => {
  let release, started
  const ready = new Promise(resolve => { release = resolve })
  const entered = new Promise(resolve => { started = resolve })
  const { root, active, stats } = await runtime({ ready, onStarted: started })
  const fiber = root.plugin(plugin)
  let activated = false
  const activation = Promise.resolve(fiber).then(() => { activated = true })
  await entered
  assert.equal(activated, false); assert.equal(stats.ready, false)
  release(); await activation
  assert.equal(stats.ready, true); assert.equal(active.size, 1)
  await fiber.dispose()
  assert.equal(active.size, 0); assert.equal(stats.releases, 1)
})

test('real traced Service activation, disposal and reactivation leave no duplicate projection owner', async () => {
  const { root, active, stats } = await runtime()
  assert.deepEqual(plugin.inject, ['sessionProjections'])
  for (let round = 0; round < 3; round++) {
    const fiber = await root.plugin(plugin)
    assert.equal(active.size, 1)
    assert.equal(active.get(PROJECTION_KEY).wire.summary, false)
    await fiber.dispose(); await fiber.dispose()
    assert.equal(active.size, 0)
    assert.equal(stats.releases, round + 1, 'Native and explicit cleanup share one idempotent Cordis effect')
  }
})

test('registration failure does not leave a projection behind and later activation can recover', async () => {
  const { root, active, stats } = await runtime()
  stats.reject = true
  const failed = root.plugin(plugin)
  await assert.rejects(async () => await failed, /Fixture registration rejected/)
  await failed.dispose(); assert.equal(active.size, 0)
  stats.reject = false
  const recovered = await root.plugin(plugin)
  assert.equal(active.size, 1)
  await recovered.dispose(); assert.equal(active.size, 0)
})
