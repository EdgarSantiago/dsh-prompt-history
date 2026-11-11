import test from 'node:test'
import assert from 'node:assert/strict'
import { createHistoryReader, filterPrompts, recentSessions, HISTORY_KEY, SESSION_LIMIT } from './history-reader.js'
const ok=value=>({ok:true,value})
const item=(seq=1,time=1,text='prompt')=>({id:'m'+seq,seq,time,text,hasAttachments:false,truncated:false})
const snapshot=(items=[item()],extra={})=>ok({kind:'sequenced',values:{title:'Original title',[HISTORY_KEY]:{version:1,items,omitted:0}},...extra})
const row=(id,n=0)=>({sessionId:id,updatedAt:n,blank:false,projections:{values:{title:'Title '+id}}})
const deferred=()=>{let resolve;const promise=new Promise(fn=>resolve=fn);return{promise,resolve}}

test('ordinary forks remain visible while child, blank and duplicate rows are excluded',()=>{
 const rows=recentSessions([row('old'),row('new',10),{...row('fork',5),parentSessionId:'old'},{...row('child',20),origin:'subagent'},{...row('blank',30),blank:true},row('new',10)],'old')
 assert.deepEqual(rows.map(r=>r.sessionId),['old','new','fork'])
})
test('loads bounded batches using native projection reads, sorted by actual prompt time',async()=>{
 const calls=[];const rows=Array.from({length:12},(_,i)=>row('s'+i,i))
 const reader=createHistoryReader({list:async()=>ok({items:rows}),projections:async(request,signal)=>{calls.push(request.sessionId);assert.ok(signal instanceof AbortSignal);return snapshot([item(1,Number(request.sessionId.slice(1)))])}},'s0')
 await reader.load();assert.equal(reader.state.getSnapshot().loaded,10);assert.equal(reader.state.getSnapshot().more,true);assert.equal(calls[0],'s0')
 await reader.more();const state=reader.state.getSnapshot();assert.equal(state.items.length,12);assert.equal(state.items[0].sessionId,'s11');assert.equal(state.more,false);assert.equal(state.items[0].title,'Original title');reader.dispose()
})
test('current scope does not require corpus listing and makes no Agent call',async()=>{
 const reader=createHistoryReader({list:()=>assert.fail('no list'),projections:async({sessionId})=>{assert.equal(sessionId,'current');return snapshot()}},'current')
 await reader.load('current');assert.equal(reader.state.getSnapshot().loaded,1);reader.dispose()
})
test('list denial is retained without fallback or unauthorized reads',async()=>{
 let reads=0;const reader=createHistoryReader({list:async()=>({ok:false,error:{code:'gateway/forbidden'}}),projections:()=>reads++},'current')
 await reader.load();assert.equal(reader.state.getSnapshot().phase,'error');assert.equal(reader.state.getSnapshot().issues[0].code,'gateway/forbidden');assert.equal(reads,0);reader.dispose()
})
test('per-session denial, missing projection and migration hints are explicit partial errors',async()=>{
 const reader=createHistoryReader({list:async()=>ok({items:[row('allowed'),row('denied'),row('missing'),row('old')]}),projections:async({sessionId})=>sessionId==='allowed'?snapshot():sessionId==='denied'?{ok:false,error:{code:'gateway/forbidden'}}:sessionId==='missing'?ok({kind:'sequenced',values:{}}):snapshot([item()],{kind:'migration-required'})},'allowed')
 await reader.load();const state=reader.state.getSnapshot();assert.equal(state.items.length,1);assert.equal(state.issues.length,3);assert.equal(state.loaded,4);assert.deepEqual(new Set(state.issues.map(e=>e.code)),new Set(['gateway/forbidden','projection-unavailable','migration-required']));reader.dispose()
})
test('superseded and disposed reads cannot publish stale history',async()=>{
 const late=deferred();const reader=createHistoryReader({list:()=>late.promise,projections:async()=>snapshot([item(2,20,'new')])},'current')
 const old=reader.load();await reader.load('current');late.resolve(ok({items:[row('stale')]}));await old
 assert.deepEqual(reader.state.getSnapshot().items.map(x=>x.text),['new'])
 reader.dispose();assert.equal(reader.state.getSnapshot().items.length,0)
})
test('concurrent projection reads are limited to two and closed panels discard late results',async()=>{
 const pending=[];let active=0,max=0;const reader=createHistoryReader({list:async()=>ok({items:[row('a'),row('b'),row('c')]}),projections:async()=>{active++;max=Math.max(max,active);const d=deferred();pending.push(d);await d.promise;active--;return snapshot()}},'a')
 const loading=reader.load();await Promise.resolve();assert.equal(pending.length,2);reader.dispose();for(const d of pending)d.resolve();await loading;assert.equal(max,2);assert.equal(reader.state.getSnapshot().items.length,0)
})
test('hard conversation limit bounds a full browse and subscribers can unsubscribe',async()=>{
 let reads=0,notifications=0;const reader=createHistoryReader({list:async()=>ok({items:Array.from({length:SESSION_LIMIT+20},(_,i)=>row('s'+i,i))}),projections:async()=>{reads++;return snapshot()}},'s0')
 const off=reader.state.subscribe(()=>notifications++);await reader.load();off();const count=notifications
 while(reader.state.getSnapshot().more)await reader.more()
 assert.equal(reads,SESSION_LIMIT);assert.equal(notifications,count);assert.equal(reader.state.getSnapshot().totalAvailable,SESSION_LIMIT+20);reader.dispose()
})
test('oversized projection output fails bounded instead of rendering or reusing invalid text',async()=>{
 const reader=createHistoryReader({projections:async()=>snapshot([item(1,1,'x'.repeat(32769))])},'current')
 await reader.load('current');assert.equal(reader.state.getSnapshot().items.length,0);assert.equal(reader.state.getSnapshot().issues[0].code,'invalid-projection');reader.dispose()
})
test('closing cancels further IO but preserves one visual snapshot until unmount or explicit reopen',async()=>{
 let reads=0;const reader=createHistoryReader({list:async()=>ok({items:Array.from({length:12},(_,i)=>row('s'+i,i))}),projections:async()=>{reads++;return snapshot()}},'s0')
 await reader.load();const frame=reader.state.getSnapshot();assert.equal(reads,10);assert.equal(frame.more,true)
 reader.cancel();await reader.more();assert.equal(reads,10);assert.equal(reader.state.getSnapshot(),frame)
 await reader.load('current');assert.equal(reads,11);assert.equal(reader.state.getSnapshot().phase,'ready');reader.dispose();assert.equal(reader.state.getSnapshot().items.length,0)
})
test('closing invalidates delayed reads even when the carrier ignores abort',async()=>{
 const late=deferred();const reader=createHistoryReader({projections:()=>late.promise},'current')
 const loading=reader.load('current');reader.cancel();const before=reader.state.getSnapshot();late.resolve(snapshot([item(1,1,'late')]));await loading;assert.equal(reader.state.getSnapshot(),before);reader.dispose()
})
test('search is local literal text, case and accent insensitive, never executable syntax',()=>{
 const rows=[item(1,1,'Revisão de código [x]'),item(2,2,'Other')]
 assert.equal(filterPrompts(rows,'REVISAO')[0],rows[0]);assert.equal(filterPrompts(rows,'[x]').length,1);assert.equal(filterPrompts(rows,'.*').length,0);assert.equal(filterPrompts(rows,' '),rows)
})
