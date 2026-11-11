import test from 'node:test'
import assert from 'node:assert/strict'
import { composerOpenIntent, listenForComposerOpen, DOUBLE_DOWN_MS } from './composer-bridge.js'

// Policy facts and boundary-adapter observations only; no DOM or React emulation.
const baseView=Object.freeze({editor:Object.freeze({identity:'main-editor'}),owned:true,focused:true,collapsed:true,empty:true,disabled:false,composing:false,structured:false,popup:false,modal:false})
const baseInput=Object.freeze({phase:'plain',draft:'',draftRev:7,attachmentIds:Object.freeze([]),occurrences:Object.freeze([])})
const baseEvent=Object.freeze({key:'ArrowUp',code:'ArrowUp',ctrlKey:false,metaKey:false,altKey:false,shiftKey:false,defaultPrevented:false,repeat:false,isComposing:false,keyCode:38})
const facts=extra=>Object.freeze({...baseEvent,...extra})
const input=extra=>Object.freeze({...baseInput,...extra})
const view=extra=>Object.freeze({...baseView,...extra})
function keyEvent(extra={}) {
  return Object.assign(new Event('keydown',{cancelable:true,bubbles:true}),{
    key:'ArrowUp',code:'ArrowUp',ctrlKey:false,metaKey:false,altKey:false,shiftKey:false,repeat:false,isComposing:false,keyCode:38,...extra,
  })
}
function fixture(options={}) {
  const target=new EventTarget(),calls={inspect:0,read:0,enabled:0,open:[]}
  let clock=100
  const stop=listenForComposerOpen(target,{
    inspect:event=>{calls.inspect++;return options.inspect?options.inspect(event):baseView},
    readInput:()=>{calls.read++;return options.readInput?options.readInput():baseInput},
    open:intent=>{calls.open.push(intent);return options.open?options.open(intent):true},
    enabled:()=>{calls.enabled++;return options.enabled?options.enabled():true},
    now:()=>clock,
  })
  return {target,calls,stop,setTime:value=>{clock=value},dispatch:extra=>{const event=keyEvent(extra);target.dispatchEvent(event);return event}}
}

test('unmodified arrow eligibility requires a semantically and natively empty draft',()=>{
  assert.equal(composerOpenIntent(baseEvent,baseInput,baseView),'older')
  assert.equal(composerOpenIntent(facts({key:'ArrowDown',code:'ArrowDown'}),baseInput,baseView),'newer')
  for(const draft of ['text',' ','\n','\t','one\ntwo']) {
    for(const key of ['ArrowUp','ArrowDown']) assert.equal(composerOpenIntent(facts({key}),input({draft}),baseView),null)
  }
  for(const empty of [false,undefined,null]) assert.equal(composerOpenIntent(baseEvent,baseInput,view({empty})),null)
})

test('Ctrl R opens reverse search for empty or normal nonempty plain text',()=>{
  for(const draft of ['','normal draft','multiple\nlines',' leading ordinary words']) {
    assert.equal(composerOpenIntent(facts({key:'r',code:'KeyR',ctrlKey:true}),input({draft}),view({empty:draft===''})),'reverse')
  }
  assert.equal(composerOpenIntent(facts({key:'R',code:'KeyR',ctrlKey:true}),baseInput,baseView),'reverse')
  assert.equal(composerOpenIntent(facts({key:'я',code:'KeyR',ctrlKey:true}),baseInput,baseView),'reverse')
})

test('modified arrows and all non-Control R chords remain native',()=>{
  for(const modifier of ['ctrlKey','metaKey','altKey','shiftKey']) {
    for(const key of ['ArrowUp','ArrowDown']) assert.equal(composerOpenIntent(facts({key,[modifier]:true}),baseInput,baseView),null)
  }
  for(const modifiers of [{metaKey:true},{ctrlKey:true,metaKey:true},{ctrlKey:true,altKey:true},{ctrlKey:true,shiftKey:true},{}]) {
    assert.equal(composerOpenIntent(facts({key:'r',code:'KeyR',...modifiers}),baseInput,baseView),null)
  }
  for(const key of ['a','Enter','Escape','ArrowLeft','ArrowRight','F10']) assert.equal(composerOpenIntent(facts({key,code:key}),baseInput,baseView),null)
})

test('consumed, repeated and IME key events never open',()=>{
  for(const extra of [{defaultPrevented:true},{repeat:true},{isComposing:true},{keyCode:229}]) {
    for(const event of [facts(extra),facts({key:'r',code:'KeyR',ctrlKey:true,...extra})]) assert.equal(composerOpenIntent(event,baseInput,baseView),null)
  }
})

test('ownership, focus, selection and every unavailable view guard fail closed',()=>{
  for(const observed of [null,undefined,{},view({owned:false}),view({focused:false}),view({collapsed:false})]) {
    assert.equal(composerOpenIntent(baseEvent,baseInput,observed),null)
  }
  for(const key of ['owned','focused','collapsed']) {
    for(const value of [undefined,null,1]) assert.equal(composerOpenIntent(baseEvent,baseInput,view({[key]:value})),null)
  }
  for(const key of ['disabled','composing','structured','popup','modal']) {
    for(const value of [true,undefined,null,0]) {
      assert.equal(composerOpenIntent(baseEvent,baseInput,view({[key]:value})),null)
      assert.equal(composerOpenIntent(facts({key:'r',code:'KeyR',ctrlKey:true}),baseInput,view({[key]:value})),null)
    }
  }
})

test('busy phases and claims cannot open even when native DOM looks empty',()=>{
  for(const phase of ['claimed','adjudicating','submitting','sending','inert',undefined,null]) assert.equal(composerOpenIntent(baseEvent,input({phase}),baseView),null)
  for(const claim of [{name:'command'},true,'claim']) assert.equal(composerOpenIntent(baseEvent,input({claim}),baseView),null)
})

test('attachments, reference occurrences and malformed snapshots are rejected',()=>{
  for(const snapshot of [null,undefined,{},input({draft:undefined}),input({draft:12}),input({draft:null}),input({draftRev:undefined}),input({draftRev:NaN}),input({draftRev:1.5}),input({draftRev:Number.MAX_SAFE_INTEGER+1}),input({draftRev:'7'})]) {
    assert.equal(composerOpenIntent(baseEvent,snapshot,baseView),null)
  }
  for(const key of ['attachmentIds','occurrences']) {
    for(const value of [undefined,null,{},'empty',Object.freeze(['existing'])]) {
      assert.equal(composerOpenIntent(baseEvent,input({[key]:value}),baseView),null)
      assert.equal(composerOpenIntent(facts({key:'r',code:'KeyR',ctrlKey:true}),input({[key]:value}),baseView),null)
    }
  }
})

test('bang, slash and reference prefixes with leading whitespace never open',()=>{
  for(const prefix of ['!','/','@']) {
    for(const whitespace of ['',' ','\n\t']) {
      assert.equal(composerOpenIntent(facts({key:'r',code:'KeyR',ctrlKey:true}),input({draft:whitespace+prefix+'text'}),view({empty:false})),null)
    }
  }
})

test('private reference markers anywhere in a draft block reverse search',()=>{
  for(const marker of ['\uE100','\uE11D','\uFFFC']) {
    assert.equal(composerOpenIntent(facts({key:'r',code:'KeyR',ctrlKey:true}),input({draft:'before '+marker+' after'}),view({empty:false})),null)
  }
})

test('policy reads frozen input facts without mutating identity or draft',()=>{
  const event=facts({key:'r',code:'KeyR',ctrlKey:true}),snapshot=input({draft:'retained text'}),observed=view({empty:false})
  const before=structuredClone({event,snapshot,observed}),attachments=snapshot.attachmentIds,occurrences=snapshot.occurrences
  assert.equal(composerOpenIntent(event,snapshot,observed),'reverse')
  assert.deepEqual({event,snapshot,observed},before)
  assert.strictEqual(snapshot.attachmentIds,attachments)
  assert.strictEqual(snapshot.occurrences,occurrences)
})

test('real native events are consumed only after the panel confirms opening',()=>{
  const f=fixture()
  try {
    const event=f.dispatch()
    assert.deepEqual(f.calls.open,['older'])
    assert.equal(event.defaultPrevented,true)
    const firstDown=f.dispatch({key:'ArrowDown',code:'ArrowDown'})
    assert.equal(firstDown.defaultPrevented,false)
    assert.deepEqual(f.calls.open,['older'])
    const down=f.dispatch({key:'ArrowDown',code:'ArrowDown'})
    assert.equal(down.defaultPrevented,true)
    assert.deepEqual(f.calls.open,['older','newer'])
    const reverse=f.dispatch({key:'r',code:'KeyR',ctrlKey:true})
    assert.equal(reverse.defaultPrevented,true)
    assert.deepEqual(f.calls.open,['older','newer','reverse'])
  } finally { f.stop() }
})

test('open false, undefined or throwing leaves native events unconsumed',()=>{
  for(const open of [()=>false,()=>undefined,()=>{throw new Error('unmounted')}]) {
    const f=fixture({open})
    try {
      assert.equal(f.dispatch().defaultPrevented,false)
      assert.equal(f.calls.open.length,1)
    } finally { f.stop() }
  }
})

test('boundary probe failures never read input or consume key events',()=>{
  for(const inspect of [()=>null,()=>{throw new Error('detached target')}]) {
    const f=fixture({inspect})
    try {
      assert.equal(f.dispatch().defaultPrevented,false)
      assert.equal(f.calls.inspect,1)
      assert.equal(f.calls.read,0)
      assert.deepEqual(f.calls.open,[])
    } finally { f.stop() }
  }
})

test('input read failures or malformed data leave the original event native',()=>{
  for(const readInput of [()=>{throw new Error('session disappeared')},()=>null,()=>({}),()=>input({phase:'sending'})]) {
    const f=fixture({readInput})
    try {
      assert.equal(f.dispatch().defaultPrevented,false)
      assert.equal(f.calls.inspect,1)
      assert.equal(f.calls.read,1)
      assert.deepEqual(f.calls.open,[])
    } finally { f.stop() }
  }
})

test('disabled bridges do not inspect a target or read a draft',()=>{
  for(const enabled of [()=>false,()=>{throw new Error('disposed owner')}]) {
    const f=fixture({enabled})
    try {
      assert.equal(f.dispatch().defaultPrevented,false)
      assert.equal(f.calls.enabled,1)
      assert.equal(f.calls.inspect,0)
      assert.equal(f.calls.read,0)
      assert.deepEqual(f.calls.open,[])
    } finally { f.stop() }
  }
})

test('foreign observed views cannot open; foreign boundary declines avoid draft reads',()=>{
  const foreign=fixture({inspect:()=>view({owned:false})}),declined=fixture({inspect:()=>null})
  try {
    assert.equal(foreign.dispatch().defaultPrevented,false)
    assert.deepEqual(foreign.calls.open,[])
    assert.equal(declined.dispatch().defaultPrevented,false)
    assert.equal(declined.calls.read,0)
  } finally { foreign.stop();declined.stop() }
})

test('irrelevant keys, Meta R, repeats and already handled events skip every adapter',()=>{
  const f=fixture()
  try {
    for(const extra of [{key:'a',code:'KeyA'},{key:'r',code:'KeyR',metaKey:true},{key:'ArrowUp',ctrlKey:true},{repeat:true}]) {
      assert.equal(f.dispatch(extra).defaultPrevented,false)
    }
    const prevented=keyEvent();prevented.preventDefault();f.target.dispatchEvent(prevented)
    assert.equal(prevented.defaultPrevented,true)
    assert.deepEqual(f.calls,{inspect:0,read:0,enabled:0,open:[]})
  } finally { f.stop() }
})

test('IME event flags refuse opening without consuming the event',()=>{
  const f=fixture()
  try {
    assert.equal(f.dispatch({isComposing:true}).defaultPrevented,false)
    assert.equal(f.dispatch({keyCode:229}).defaultPrevented,false)
    assert.deepEqual(f.calls.open,[])
  } finally { f.stop() }
})

test('native composition start/end retains a 20ms guard using the supplied clock',()=>{
  const f=fixture()
  try {
    f.target.dispatchEvent(new Event('compositionstart'))
    assert.equal(f.dispatch().defaultPrevented,false)
    assert.equal(f.calls.inspect,0)
    f.setTime(200);f.target.dispatchEvent(new Event('compositionend'))
    for(const time of [200,219]) {
      f.setTime(time);assert.equal(f.dispatch().defaultPrevented,false)
    }
    assert.equal(f.calls.inspect,0)
    f.setTime(220)
    assert.equal(f.dispatch().defaultPrevented,true)
    assert.deepEqual(f.calls.open,['older'])
  } finally { f.stop() }
})

test('focusout releases an interrupted composition after the same guard interval',()=>{
  const f=fixture()
  try {
    f.target.dispatchEvent(new Event('compositionstart'))
    f.setTime(300);f.target.dispatchEvent(new Event('focusout'))
    f.setTime(319);assert.equal(f.dispatch().defaultPrevented,false)
    f.setTime(320);assert.equal(f.dispatch().defaultPrevented,true)
    assert.deepEqual(f.calls.open,['older'])
  } finally { f.stop() }
})

test('ordinary focusout does not unnecessarily impose an IME delay',()=>{
  const f=fixture()
  try {
    f.target.dispatchEvent(new Event('focusout'))
    assert.equal(f.dispatch().defaultPrevented,true)
  } finally { f.stop() }
})

test('disposal removes exact capture listeners, is idempotent and permits clean remount',()=>{
  class ObservedTarget extends EventTarget {
    registrations=[]
    removals=[]
    addEventListener(...args) { this.registrations.push(args);return super.addEventListener(...args) }
    removeEventListener(...args) { this.removals.push(args);return super.removeEventListener(...args) }
  }
  const target=new ObservedTarget(),opened=[]
  const options={inspect:()=>baseView,readInput:()=>baseInput,open:intent=>{opened.push(intent);return true},now:()=>100}
  const stop=listenForComposerOpen(target,options)
  target.dispatchEvent(keyEvent());assert.deepEqual(opened,['older'])
  stop();stop()
  assert.equal(target.registrations.length,5)
  assert.equal(target.removals.length,5)
  for(let index=0;index<5;index++) {
    const [type,handler,capture]=target.registrations[index]
    assert.equal(capture.capture,true)
    assert.equal(target.removals[index][0],type)
    assert.strictEqual(target.removals[index][1],handler)
    assert.strictEqual(target.removals[index][2],capture)
  }
  const afterStop=keyEvent();target.dispatchEvent(afterStop)
  assert.equal(afterStop.defaultPrevented,false)
  assert.deepEqual(opened,['older'])
  const remount=listenForComposerOpen(target,options)
  try {
    target.dispatchEvent(keyEvent())
    assert.deepEqual(opened,['older','older'])
  } finally { remount() }
})

const downKey=Object.freeze({key:'ArrowDown',code:'ArrowDown'})
test('two fresh Down presses within 500ms open once; the first press stays native',()=>{
  assert.equal(DOUBLE_DOWN_MS,500)
  const f=fixture()
  try {
    assert.equal(f.dispatch(downKey).defaultPrevented,false)
    assert.deepEqual(f.calls.open,[])
    f.setTime(600)
    assert.equal(f.dispatch(downKey).defaultPrevented,true)
    assert.deepEqual(f.calls.open,['newer'])
    assert.equal(f.dispatch(downKey).defaultPrevented,false)
    assert.deepEqual(f.calls.open,['newer'])
  } finally {f.stop()}
})
test('slow Down presses start a new pair instead of opening',()=>{
  const f=fixture()
  try {
    f.dispatch(downKey);f.setTime(601)
    assert.equal(f.dispatch(downKey).defaultPrevented,false)
    assert.deepEqual(f.calls.open,[])
    f.setTime(700);assert.equal(f.dispatch(downKey).defaultPrevented,true)
  } finally {f.stop()}
})
test('double Down cannot span editor replacement or a draft revision change',()=>{
  for(const change of ['editor','revision']){
    let observed=baseView,snapshot=baseInput
    const f=fixture({inspect:()=>observed,readInput:()=>snapshot})
    try {
      f.dispatch(downKey)
      if(change==='editor')observed=view({editor:Object.freeze({identity:'replacement-editor'})})
      else snapshot=input({draftRev:8})
      f.setTime(200);assert.equal(f.dispatch(downKey).defaultPrevented,false)
      assert.deepEqual(f.calls.open,[])
      f.setTime(250);assert.equal(f.dispatch(downKey).defaultPrevented,true)
    } finally {f.stop()}
  }
  const missing=fixture({inspect:()=>view({editor:null})})
  try {missing.dispatch(downKey);missing.dispatch(downKey);assert.deepEqual(missing.calls.open,[])}finally{missing.stop()}
})
test('click, focus loss and unrelated or repeated keys cancel a pending Down pair',()=>{
  for(const interrupt of ['pointerdown','focusout','letter','modifier','repeat','handled','composition']){
    const f=fixture()
    try {
      f.dispatch(downKey)
      if(['pointerdown','focusout'].includes(interrupt))f.target.dispatchEvent(new Event(interrupt))
      else if(interrupt==='letter')f.dispatch({key:'a',code:'KeyA'})
      else if(interrupt==='modifier')f.dispatch({...downKey,shiftKey:true})
      else if(interrupt==='repeat')f.dispatch({...downKey,repeat:true})
      else if(interrupt==='handled'){const event=keyEvent(downKey);event.preventDefault();f.target.dispatchEvent(event)}
      else {f.target.dispatchEvent(new Event('compositionstart'));f.target.dispatchEvent(new Event('compositionend'))}
      f.setTime(200);assert.equal(f.dispatch(downKey).defaultPrevented,false,interrupt)
      assert.deepEqual(f.calls.open,[],interrupt)
      f.setTime(250);assert.equal(f.dispatch(downKey).defaultPrevented,true,interrupt)
    } finally {f.stop()}
  }
})
test('newly blocked menus, selection, busy state and disabled owners cancel the pair',()=>{
  for(const blocked of ['popup','modal','selection','busy','disabled','foreign']){
    let reject=false
    const f=fixture({enabled:()=>!(reject&&blocked==='disabled'),inspect:()=>reject&&blocked==='foreign'?null:view({popup:reject&&blocked==='popup',modal:reject&&blocked==='modal',collapsed:!(reject&&blocked==='selection')}),readInput:()=>reject&&blocked==='busy'?input({phase:'sending'}):baseInput})
    try {
      f.dispatch(downKey);reject=true;f.setTime(150)
      assert.equal(f.dispatch(downKey).defaultPrevented,false,blocked)
      reject=false;f.setTime(200)
      assert.equal(f.dispatch(downKey).defaultPrevented,false,blocked)
      assert.deepEqual(f.calls.open,[],blocked)
      f.setTime(250);assert.equal(f.dispatch(downKey).defaultPrevented,true,blocked)
    } finally {f.stop()}
  }
})
test('a pending Down pair never survives disposal and remount',()=>{
  const target=new EventTarget(),opened=[]
  const options={inspect:()=>baseView,readInput:()=>baseInput,open:mode=>{opened.push(mode);return true},now:()=>100}
  const stop=listenForComposerOpen(target,options)
  target.dispatchEvent(keyEvent(downKey));stop()
  const next=listenForComposerOpen(target,options)
  try {
    const first=keyEvent(downKey);target.dispatchEvent(first)
    assert.equal(first.defaultPrevented,false);assert.deepEqual(opened,[])
    const second=keyEvent(downKey);target.dispatchEvent(second)
    assert.equal(second.defaultPrevented,true);assert.deepEqual(opened,['newer'])
  } finally {next()}
})
test('disposed composition listeners do not read the clock or leak into a remount',()=>{
  const target=new EventTarget()
  let timeReads=0,opens=0
  const options={inspect:()=>baseView,readInput:()=>baseInput,open:()=>{opens++;return true},now:()=>{timeReads++;return 100}}
  const stop=listenForComposerOpen(target,options)
  stop()
  for(const type of ['compositionstart','compositionend','focusout']) target.dispatchEvent(new Event(type))
  assert.equal(timeReads,0)
  const next=listenForComposerOpen(target,options)
  try {
    target.dispatchEvent(keyEvent())
    assert.equal(opens,1)
  } finally { next() }
})
