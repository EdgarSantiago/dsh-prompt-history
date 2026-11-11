import test from 'node:test'
import assert from 'node:assert/strict'
import { clearLegacyHistoryNotice } from './legacy-notice.js'
import { en, pt } from './strings.js'

function inputWith(notice){
 let current=notice,writes=0
 return {input:{notices:{getSnapshot:()=>current,set:value=>{writes++;current=value}}},get current(){return current},get writes(){return writes}}
}
test('clears only the old English or Portuguese history success banner, once',()=>{
 for(const text of [en.reused,pt.reused]){
  const f=inputWith({level:'info',text,seq:12})
  assert.equal(clearLegacyHistoryNotice(f.input),true);assert.equal(f.current,null);assert.equal(f.writes,1)
  assert.equal(clearLegacyHistoryNotice(f.input),false);assert.equal(f.writes,1)
 }
})
test('does not clear errors, other business notices or merely similar messages',()=>{
 for(const notice of [null,undefined,{level:'error',text:en.reused},{level:'info',text:'Native business notice'},{level:'info',text:en.reused+' extra'},{level:'info',text:''}]){
  const f=inputWith(notice);assert.equal(clearLegacyHistoryNotice(f.input),false);assert.equal(f.current,notice);assert.equal(f.writes,0)
 }
})
test('unsupported facade capabilities are a safe no-op',()=>{
 for(const input of [undefined,null,{}, {notices:{}},{notices:{getSnapshot:()=>null}},{notices:{set(){throw Error('must not write')}}}])assert.equal(clearLegacyHistoryNotice(input),false)
})
test('cleanup never reads or writes draft, attachment, submission or focus state',()=>{
 const f=inputWith({level:'info',text:en.reused,seq:1})
 for(const key of ['state','setDraft','submit','focus','notify','addAttachments'])Object.defineProperty(f.input,key,{get(){throw Error('Unexpected access: '+key)}})
 assert.equal(clearLegacyHistoryNotice(Object.freeze(f.input)),true);assert.equal(f.current,null)
})
