// Compatibility bridge for Harness 0.2.2-rc.1 DOM markers. Read-only: the
// editor and its selection are observed, never written. Only our panel opens.
export const COMPOSER_CARD = '[data-composer-card]'
export const COMPOSER_EDITOR = '[data-composer-input]'
export const DOUBLE_DOWN_MS = 500
const CHIPS = '[data-composer-chip],[data-composer-command],[data-composer-quote],[contenteditable="false"]'

function visible(node) {
  if(node.closest('[hidden],[inert],[aria-hidden="true"]'))return false
  const popover=node.closest('[popover]')
  if(popover&&!popover.matches(':popover-open'))return false
  return typeof node.checkVisibility!=='function'||node.checkVisibility({visibilityProperty:true})
}

export function inspectComposerTarget(launcher,event) {
  const doc=launcher?.ownerDocument,target=event.target
  if(!launcher?.isConnected||!doc||typeof target?.closest!=='function')return null
  const card=launcher.closest(COMPOSER_CARD),editor=target.closest(COMPOSER_EDITOR)
  if(!card||!editor||editor.closest(COMPOSER_CARD)!==card||doc.activeElement!==editor||!editor.isContentEditable)return null
  const selection=doc.getSelection()
  const inside=selection?.rangeCount>0&&selection.anchorNode&&selection.focusNode&&editor.contains(selection.anchorNode)&&editor.contains(selection.focusNode)
  return {
    owned:true,
    editor,
    focused:doc.hasFocus(),
    collapsed:!!inside&&selection.isCollapsed,
    empty:editor.textContent==='',
    disabled:!!editor.closest('[inert]')||editor.getAttribute('aria-disabled')==='true'||editor.getAttribute('data-phase')!=='plain',
    composing:editor.hasAttribute('data-composer-composing'),
    structured:!!editor.querySelector(CHIPS),
    popup:!!card.querySelector('[data-trigger-menu]')||[...card.querySelectorAll('[role="listbox"],[role="menu"],[aria-haspopup][aria-expanded="true"]')].some(visible),
    modal:[...doc.querySelectorAll('dialog[open],[aria-modal="true"]')].some(visible),
  }
}

function openKey(event) {
  if(event.ctrlKey&&!event.metaKey&&!event.altKey&&!event.shiftKey&&(event.code==='KeyR'||event.key?.toLowerCase()==='r'))return 'reverse'
  if(event.ctrlKey||event.metaKey||event.altKey||event.shiftKey)return null
  if(event.key==='ArrowUp')return 'older'
  if(event.key==='ArrowDown')return 'newer'
  return null
}

// Testable policy over observed facts; no DOM, draft or selection writes.
export function composerOpenIntent(event,input,view) {
  const key=openKey(event)
  if(!key)return null
  if(event.defaultPrevented||event.repeat||event.isComposing||event.keyCode===229)return null
  if(!view||view.owned!==true||view.focused!==true||view.collapsed!==true)return null
  if(view.disabled!==false||view.composing!==false||view.structured!==false||view.popup!==false||view.modal!==false)return null
  if(!input||input.phase!=='plain'||input.claim||typeof input.draft!=='string'||!Number.isSafeInteger(input.draftRev))return null
  if(!Array.isArray(input.attachmentIds)||input.attachmentIds.length||!Array.isArray(input.occurrences)||input.occurrences.length)return null
  if(/^\s*[!/@]/u.test(input.draft)||/[\uE100-\uE11D\uFFFC]/u.test(input.draft))return null
  if(key==='reverse')return key
  return input.draft===''&&view.empty===true?key:null
}

// One effect-owned listener per launcher; inspect() binds to that launcher's
// exact native card. Other sessions/fields and rejected keys remain native.
export function listenForComposerOpen(target,{inspect,readInput,open,enabled=()=>true,now=()=>performance.now()}) {
  const options={capture:true}
  let composing=false,ended=-Infinity,stopped=false,down=null
  const reset=()=>{down=null}
  const start=()=>{reset();composing=true}
  const end=()=>{reset();composing=false;ended=now()}
  const blur=()=>{reset();if(composing)end()}
  const key=event=>{
    if(stopped)return
    const at=now()
    if(composing||at-ended<20||event.defaultPrevented||event.repeat||!openKey(event)){reset();return}
    try {
      if(!enabled()){reset();return}
      const view=inspect(event)
      if(!view){reset();return}
      const input=readInput(),intent=composerOpenIntent(event,input,view)
      if(!intent){reset();return}
      if(intent==='newer'){
        // First ↓ stays native; only a second fresh press in the same unchanged
        // editor opens our search. Holding the key is not a double press.
        if(!view.editor){reset();return}
        const paired=down&&down.editor===view.editor&&down.revision===input.draftRev&&at>=down.at&&at-down.at<=DOUBLE_DOWN_MS
        if(!paired){down={editor:view.editor,revision:input.draftRev,at};return}
      }
      reset()
      if(open(intent)===true){event.preventDefault();event.stopPropagation()}
    } catch {
      reset()
      // A disappearing Session or changed DOM contract must leave native input
      // untouched. The ordinary clock launcher remains available.
    }
  }
  target.addEventListener('keydown',key,options)
  target.addEventListener('compositionstart',start,options)
  target.addEventListener('compositionend',end,options)
  target.addEventListener('focusout',blur,options)
  target.addEventListener('pointerdown',reset,options)
  return()=>{
    if(stopped)return
    stopped=true;reset()
    target.removeEventListener('keydown',key,options)
    target.removeEventListener('compositionstart',start,options)
    target.removeEventListener('compositionend',end,options)
    target.removeEventListener('focusout',blur,options)
    target.removeEventListener('pointerdown',reset,options)
  }
}
