import test from 'node:test'
import assert from 'node:assert/strict'
import { listenForOutsidePointer } from './dismiss.js'

// Real EventTarget/Event instances, not a simulated DOM or React renderer.
test('an outside pointer dismisses without cancelling the original interaction',()=>{
  const target=new EventTarget(),panel=new EventTarget()
  let dismissed=0,delivered=0,clicked=0
  const stop=listenForOutsidePointer(target,()=>[panel],()=>dismissed++)
  target.addEventListener('pointerdown',()=>delivered++)
  target.addEventListener('click',()=>clicked++)
  const event=new Event('pointerdown',{cancelable:true})
  assert.equal(target.dispatchEvent(event),true)
  target.dispatchEvent(new Event('click'))
  assert.equal(dismissed,1);assert.equal(delivered,1);assert.equal(clicked,1)
  assert.equal(event.defaultPrevented,false)
  stop()
})
test('a pointer whose composed path includes the panel or launcher stays internal',()=>{
  for(const position of [0,1]){
    const target=new EventTarget(),other=new EventTarget()
    const roots=position===0?[target,other]:[other,target]
    let dismissed=0
    const stop=listenForOutsidePointer(target,()=>roots,()=>dismissed++)
    target.dispatchEvent(new Event('pointerdown'))
    assert.equal(dismissed,0)
    stop()
  }
})
test('ownership is read per interaction and can be scoped to the current conversation',()=>{
  const target=new EventTarget(),other=new EventTarget()
  const owned=new Map([[target,'current'],[other,'other']])
  let dismissed=0
  const stop=listenForOutsidePointer(target,()=>[...owned].filter(([,sid])=>sid==='current').map(([node])=>node),()=>dismissed++)
  target.dispatchEvent(new Event('pointerdown'));assert.equal(dismissed,0)
  owned.set(target,'other')
  target.dispatchEvent(new Event('pointerdown'));assert.equal(dismissed,1)
  owned.set(target,'current')
  target.dispatchEvent(new Event('pointerdown'));assert.equal(dismissed,1)
  stop()
})
test('cleanup removes the exact capture listener and is safe when repeated',()=>{
  const target=new EventTarget()
  let dismissed=0
  const stop=listenForOutsidePointer(target,()=>[],()=>dismissed++)
  target.dispatchEvent(new Event('pointerdown'));assert.equal(dismissed,1)
  stop();stop()
  target.dispatchEvent(new Event('pointerdown'));assert.equal(dismissed,1)
})
test('unrelated events do not dismiss history',()=>{
  const target=new EventTarget()
  let dismissed=0
  const stop=listenForOutsidePointer(target,()=>[],()=>dismissed++)
  for(const type of ['click','keydown','pointerup','scroll'])target.dispatchEvent(new Event(type))
  assert.equal(dismissed,0)
  stop()
})
