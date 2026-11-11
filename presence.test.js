import test from 'node:test'
import assert from 'node:assert/strict'
import { createPresenceDriver,ENTER_MS,EXIT_MS } from './presence.js'

// A deterministic scheduler, not a browser/React/DOM emulator.
function scheduler(){
 let id=0,time=0;const frames=new Map(),timers=new Map(),cancelled=[]
 return{
  frame:fn=>{frames.set(++id,fn);return id},cancelFrame:key=>{if(frames.has(key))cancelled.push(frames.get(key));frames.delete(key)},
  delay:(fn,ms)=>{timers.set(++id,{fn,at:time+ms});return id},clearDelay:key=>{if(timers.has(key))cancelled.push(timers.get(key).fn);timers.delete(key)},
  nextFrame(){const pending=[...frames.values()];frames.clear();for(const fn of pending)fn()},
  advance(ms){time+=ms;for(const[key,value]of [...timers])if(value.at<=time){timers.delete(key);value.fn()}},
  flushCancelled(){for(const fn of cancelled.splice(0))fn()},
  get active(){return frames.size+timers.size},
 }
}
function fixture(){const clock=scheduler(),states=[];const driver=createPresenceDriver(value=>states.push(value),clock);return{clock,states,driver,get state(){return states.at(-1)}}}

test('opening paints a compact initial pose before moving to the visible state',()=>{
 const f=fixture();f.driver.setOpen(true);assert.deepEqual(f.state,{present:true,phase:'enter'})
 f.clock.nextFrame();assert.equal(f.state.phase,'enter');f.clock.nextFrame();assert.deepEqual(f.state,{present:true,phase:'open'});assert.equal(f.clock.active,0)
 assert.equal(ENTER_MS,180)
})
test('closing retains only the visual frame for a short, bounded exit',()=>{
 const f=fixture();f.driver.setOpen(true,true);f.driver.setOpen(false);assert.deepEqual(f.state,{present:true,phase:'exit'})
 f.clock.advance(EXIT_MS);assert.equal(f.state.present,true);f.clock.advance(32);assert.deepEqual(f.state,{present:false,phase:'closed'});assert.equal(f.clock.active,0)
})
test('quick reopen cancels stale exits and retargets without restarting entrance',()=>{
 const f=fixture();f.driver.setOpen(true,true);f.driver.setOpen(false);f.clock.advance(40);f.driver.setOpen(true)
 assert.deepEqual(f.state,{present:true,phase:'open'});f.clock.advance(1000);f.clock.flushCancelled();assert.equal(f.state.phase,'open');assert.equal(f.clock.active,0)
})
test('closing before the initial pose is painted leaves no empty animated panel',()=>{
 const f=fixture();f.driver.setOpen(true);f.driver.setOpen(false);assert.deepEqual(f.state,{present:false,phase:'closed'});f.clock.flushCancelled();assert.equal(f.clock.active,0)
})
test('reduced motion and security resets open/close immediately without scheduled work',()=>{
 const f=fixture();f.driver.setOpen(true,true);assert.equal(f.state.phase,'open');assert.equal(f.clock.active,0)
 f.driver.setOpen(false,true);assert.equal(f.state.present,false);assert.equal(f.clock.active,0)
})
test('cleanup cancels frames/timers and supports safe effect reactivation',()=>{
 const f=fixture();f.driver.setOpen(true);f.driver.stop();const count=f.states.length;f.clock.flushCancelled();assert.equal(f.states.length,count);assert.equal(f.clock.active,0)
 f.driver.setOpen(true);f.clock.nextFrame();f.clock.nextFrame();assert.equal(f.state.phase,'open')
 f.driver.setOpen(false);f.driver.stop();f.clock.flushCancelled();assert.equal(f.state.phase,'exit');assert.equal(f.clock.active,0)
})
