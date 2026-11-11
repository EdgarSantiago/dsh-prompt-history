import test from 'node:test'
import assert from 'node:assert/strict'
import {pasteHistoryPrompt,quoteHistoryPrompt} from './editor-actions.js'
const prompt=Object.freeze({text:'Previous prompt\nsecond line',truncated:false})
function fixture(extra={},accepted=true){
 const snapshot={phase:'plain',draft:'current draft',draftRev:7,attachmentIds:[],occurrences:[],...extra},calls=[]
 const input={state:{getSnapshot:()=>snapshot},focus:()=>calls.push('focus')}
 const actions={insertText:(text,span)=>{calls.push(['paste',text,span]);return accepted},insertQuote:text=>{calls.push(['quote',text]);return accepted},persistDraft:()=>calls.push('persist'),setDraft:()=>assert.fail('never replace the entire draft'),submit:()=>assert.fail('never submit'),addAttachments:()=>assert.fail('never restore attachments')}
 return{snapshot,calls,input,actions}
}
const span=Object.freeze({start:2,end:4,draftRev:7})
test('paste uses the captured native span exactly and never replaces the full draft',()=>{
 const f=fixture();assert.equal(pasteHistoryPrompt(f.input,f.actions,prompt,span).kind,'applied')
 assert.deepEqual(f.calls,[['paste',prompt.text,span],'persist','focus'])
 assert.equal(f.calls[0][2],span);assert.equal(f.snapshot.draft,'current draft')
})
test('native quote insertion is distinct from plain text paste and accepts a bang safely',()=>{
 const f=fixture();assert.equal(quoteHistoryPrompt(f.input,f.actions,{text:'!do not execute'},span).kind,'applied')
 assert.deepEqual(f.calls,[['quote','!do not execute'],'persist','focus'])
})
test('additive actions preserve structured content and do not derive spans from clipboard length',()=>{
 for(const action of [pasteHistoryPrompt,quoteHistoryPrompt]){
  const f=fixture({draft:'> an expanded atomic quote\nrest',attachmentIds:['existing-file'],occurrences:[{id:'existing-ref'}]})
  const before=structuredClone(f.snapshot),native=Object.freeze({start:1,end:1,draftRev:7})
  assert.equal(action(f.input,f.actions,prompt,native).kind,'applied')
  assert.deepEqual(f.snapshot,before)
  if(action===pasteHistoryPrompt)assert.equal(f.calls[0][2],native)
 }
})
test('a changed draft invalidates both actions before any editor mutation',()=>{
 for(const action of [pasteHistoryPrompt,quoteHistoryPrompt]){
  const f=fixture();f.snapshot.draftRev=8
  assert.deepEqual(action(f.input,f.actions,prompt,span),{kind:'blocked',reason:'changed'})
  assert.deepEqual(f.calls,[])
 }
})
test('native refusal never persists, focuses or falls back to another insertion method',()=>{
 for(const [action,reason] of [[pasteHistoryPrompt,'changed'],[quoteHistoryPrompt,'unavailable']]){
  const f=fixture({},false)
  assert.deepEqual(action(f.input,f.actions,prompt,span),{kind:'blocked',reason})
  assert.equal(f.calls.length,1)
 }
})
test('busy/claimed editor and missing input are rejected without mutation',()=>{
 for(const extra of [{phase:'sending'},{phase:'submitting'},{phase:'adjudicating'},{phase:'claimed'},{claim:{name:'cmd'}}]){
  for(const action of [pasteHistoryPrompt,quoteHistoryPrompt]){
   const f=fixture(extra);assert.equal(action(f.input,f.actions,prompt,span).reason,'busy');assert.deepEqual(f.calls,[])
  }
 }
 assert.equal(pasteHistoryPrompt(null,{},prompt,span).reason,'busy')
})
test('incomplete, empty and private reference-marker text cannot be pasted or quoted',()=>{
 for(const item of [{text:' '},{...prompt,truncated:true},{text:'\uFFFC!unsafe'},{text:'\uE100reference'}]){
  for(const action of [pasteHistoryPrompt,quoteHistoryPrompt]){
   const f=fixture();assert.equal(action(f.input,f.actions,item,span).kind,'blocked');assert.deepEqual(f.calls,[])
  }
 }
})
test('paste cannot hand off to bang terminal and malformed capture ranges are rejected',()=>{
 for(const extra of [{item:{text:'!echo test'}},{snapshot:{draft:'!existing'}}]){
  const f=fixture(extra.snapshot);assert.equal(pasteHistoryPrompt(f.input,f.actions,extra.item||prompt,span).reason,'bang');assert.deepEqual(f.calls,[])
 }
 const terminal=fixture({draft:'!existing'});assert.equal(quoteHistoryPrompt(terminal.input,terminal.actions,prompt,span).reason,'bang');assert.deepEqual(terminal.calls,[])
 for(const bad of [null,{start:-1,end:1,draftRev:7},{start:2,end:1,draftRev:7},{start:0,end:NaN,draftRev:7},{start:0,end:1,draftRev:6}]){
  const f=fixture();assert.equal(pasteHistoryPrompt(f.input,f.actions,prompt,bad).reason,'changed');assert.deepEqual(f.calls,[])
 }
})
