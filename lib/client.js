(() => {
  // history-reader.js
  var HISTORY_KEY = "localPromptHistory";
  var SESSION_LIMIT = 50;
  var BATCH = 10;
  var initial = () => ({ phase: "idle", scope: "all", items: [], issues: [], loaded: 0, available: 0, totalAvailable: 0, omitted: 0, more: false });
  function unwrap(result) {
    if (!result?.ok) throw Object.assign(new Error(result?.error?.code || "read-failed"), { code: result?.error?.code || "read-failed" });
    return result.value;
  }
  function sessionTitle(row) {
    const title = row?.projections?.values?.title;
    return typeof title === "string" && title.trim() ? title : row?.sessionId?.slice(0, 8) || "—";
  }
  function recentSessions(rows, currentId) {
    const unique = /* @__PURE__ */ new Map();
    for (const row of rows || []) {
      if (typeof row?.sessionId !== "string" || row.origin === "subagent" || row.blank || unique.has(row.sessionId)) continue;
      unique.set(row.sessionId, row);
    }
    const result = [...unique.values()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    const at = result.findIndex((row) => row.sessionId === currentId);
    if (at > 0) result.unshift(...result.splice(at, 1));
    return result;
  }
  function filterPrompts(items, query) {
    const term = query.trim().normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase();
    if (!term) return items;
    return items.filter((item) => item.text.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase().includes(term));
  }
  function createHistoryReader(remote, currentSessionId) {
    let state = initial(), alive = true, paused = false, generation = 0, controller, candidates = [], offset = 0;
    const listeners = /* @__PURE__ */ new Set(), groups = /* @__PURE__ */ new Map();
    const publish = (patch) => {
      if (!alive) return;
      state = { ...state, ...patch };
      for (const fn of listeners) fn();
    };
    const valid = (g, signal) => alive && g === generation && !signal.aborted;
    const merge = () => {
      const items = [...groups.values()].flatMap((group) => group.items).sort((a, b) => b.time - a.time || b.seq - a.seq || a.sessionId.localeCompare(b.sessionId));
      return { items, omitted: [...groups.values()].reduce((n, group) => n + group.omitted, 0) };
    };
    async function batch(g, signal) {
      const selected = candidates.slice(offset, offset + BATCH);
      offset += selected.length;
      let index = 0;
      const issues = [...state.issues];
      async function worker() {
        while (valid(g, signal) && index < selected.length) {
          const row = selected[index++];
          try {
            const value = unwrap(await remote.projections({ sessionId: row.sessionId }, signal));
            if (!valid(g, signal)) return;
            if (!value || value.kind !== "sequenced") throw Object.assign(new Error("migration-required"), { code: "migration-required" });
            const view = value.values?.[HISTORY_KEY];
            if (!view || view.version !== 1 || !Array.isArray(view.items) || view.items.length > 60) throw Object.assign(new Error("projection-unavailable"), { code: "projection-unavailable" });
            let textBudget = 0;
            const titleValue = value.values?.title;
            const title = typeof titleValue === "string" && titleValue.trim() ? titleValue : sessionTitle(row);
            const items = view.items.map((item) => {
              if (typeof item?.text !== "string" || item.text.length > 32768 || !Number.isSafeInteger(item.seq) || !Number.isFinite(item.time) || (textBudget += item.text.length) > 262144) throw Object.assign(new Error("invalid-projection"), { code: "invalid-projection" });
              return { ...item, sessionId: row.sessionId, title, key: row.sessionId + ":" + item.seq };
            });
            groups.set(row.sessionId, { items, omitted: Number.isSafeInteger(view.omitted) && view.omitted >= 0 ? view.omitted : 0 });
          } catch (error) {
            if (!valid(g, signal)) return;
            issues.push({ sessionId: row.sessionId, code: error.code || "read-failed" });
          }
          if (valid(g, signal)) publish({ ...merge(), issues: [...issues], loaded: state.loaded + 1 });
        }
      }
      await Promise.all([worker(), worker()]);
      if (valid(g, signal)) publish({ phase: "ready", more: offset < candidates.length });
    }
    async function load(scope = "all") {
      if (!alive) return;
      paused = false;
      controller?.abort();
      controller = new AbortController();
      const signal = controller.signal, g = ++generation;
      candidates = [];
      offset = 0;
      groups.clear();
      publish({ ...initial(), phase: "loading", scope });
      try {
        if (scope === "current") candidates = [{ sessionId: currentSessionId }];
        else {
          const value = unwrap(await remote.list({}, signal));
          if (!valid(g, signal)) return;
          const all = recentSessions(value?.items, currentSessionId);
          candidates = all.slice(0, SESSION_LIMIT);
          publish({ totalAvailable: all.length });
        }
        if (!valid(g, signal)) return;
        publish({ available: candidates.length, totalAvailable: scope === "current" ? 1 : state.totalAvailable });
        await batch(g, signal);
      } catch (error) {
        if (valid(g, signal)) publish({ phase: "error", issues: [{ code: error.code || "read-failed" }] });
      }
    }
    async function more() {
      if (!alive || paused || state.phase !== "ready" || !state.more) return;
      publish({ phase: "loading", more: false });
      await batch(generation, controller.signal);
    }
    function cancel() {
      paused = true;
      generation++;
      controller?.abort();
    }
    function dispose() {
      alive = false;
      cancel();
      groups.clear();
      candidates = [];
      state = initial();
      listeners.clear();
    }
    return { state: { getSnapshot: () => state, subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    } }, load, more, cancel, dispose };
  }

  // reuse.js
  function prepareReuse(input, item, expectedRevision) {
    if (!item || typeof item.text !== "string" || !item.text.trim()) return { kind: "blocked", reason: "empty" };
    if (item.truncated) return { kind: "blocked", reason: "truncated" };
    if (/[\uE100-\uE11D\uFFFC]/u.test(item.text)) return { kind: "blocked", reason: "referenceText" };
    if (item.text.startsWith("!")) return { kind: "blocked", reason: "bang" };
    if (!input || input.phase !== "plain" || input.claim) return { kind: "blocked", reason: "busy" };
    if (input.attachmentIds?.length) return { kind: "blocked", reason: "attachments" };
    if (input.occurrences?.length) return { kind: "blocked", reason: "references" };
    if (!Number.isSafeInteger(input.draftRev) || typeof input.draft !== "string") return { kind: "blocked", reason: "busy" };
    if (expectedRevision !== void 0 && input.draftRev !== expectedRevision) return { kind: "blocked", reason: "changed" };
    if (input.draft.length && expectedRevision === void 0) return { kind: "confirm", revision: input.draftRev };
    return { kind: "ready", span: { start: 0, end: input.draft.length, draftRev: input.draftRev } };
  }
  function reusePrompt(input, actions, item, expectedRevision) {
    const decision = prepareReuse(input.state.getSnapshot(), item, expectedRevision);
    if (decision.kind !== "ready") return decision;
    if (!actions.insertText(item.text, decision.span)) return { kind: "blocked", reason: "changed" };
    actions.persistDraft();
    input.focus();
    return { kind: "applied" };
  }

  // strings.js
  var en = {
    quote: "Quote in composer",
    paste: "Paste in composer",
    reverseSearch: "Reverse search",
    older: "Older",
    newer: "Newer",
    panelKeys: "↑/↓ browse · Enter pastes · Ctrl R searches",
    actionUnavailable: "The editor could not accept this action. Nothing was inserted.",
    actionFailed: "Could not finish this action. Review your draft before trying again.",
    description: "Find and reuse your previous prompts.",
    conversation: "Conversation",
    today: "Today",
    yesterday: "Yesterday",
    unknownDate: "Unknown date",
    moreActions: "More prompt actions",
    title: "Prompt history",
    open: "Open prompt history",
    close: "Close history",
    search: "Search loaded prompts…",
    scope: "Conversations",
    all: "Recent conversations",
    current: "This conversation",
    refresh: "Refresh",
    more: "Load more conversations",
    morePrompts: "Show more prompts",
    loading: "Loading history…",
    empty: "No previous prompts found.",
    noMatches: "No loaded prompts match this search.",
    reuse: "Reuse",
    copy: "Copy",
    copied: "Prompt copied.",
    copyFailed: "Could not copy. Expand the prompt and copy its text manually.",
    expand: "Show full text",
    collapse: "Collapse",
    origin: "Open original conversation",
    textOnly: "Only text is reused. Attachments and reference chips are not restored.",
    attachments: "Had attachments",
    truncated: "Long prompt: this preview is incomplete. Open the original conversation for the complete text.",
    confirm: "Replace your current draft? It will not be sent automatically.",
    replace: "Replace draft",
    cancel: "Cancel",
    partial: "Some conversations could not be read. Refresh to retry.",
    failed: "Could not load history.",
    migration: "Some conversations require migration or do not have the history projection available.",
    loaded: "Conversations checked",
    prompts: "Prompts",
    bounds: "Up to 60 prompts per conversation and the 50 most recent conversations. Search filters only the loaded text.",
    omitted: "Older prompts omitted by the per-conversation limits",
    busy: "Wait for the current submission or leave command mode before reusing a prompt.",
    draftAttachments: "Remove the current draft attachments before reusing another prompt.",
    references: "The current draft contains references. Copy this prompt or clear the draft first.",
    changed: "The editor could not apply this change safely. Your current draft was preserved.",
    bang: "This text starts with ! and would open the terminal. Use Copy instead.",
    referenceText: "This prompt contains editor reference markers. Use Copy and review the text instead.",
    invalid: "This prompt cannot be reused.",
    reused: "Prompt inserted. Review it before sending."
  };
  var pt = {
    quote: "Citar no editor",
    paste: "Colar no editor",
    reverseSearch: "Busca reversa",
    older: "Anterior",
    newer: "Próximo",
    panelKeys: "↑/↓ navega · Enter cola · Ctrl R busca",
    actionUnavailable: "O editor não aceitou esta ação. Nada foi inserido.",
    actionFailed: "Não foi possível concluir esta ação. Confira o rascunho antes de tentar novamente.",
    description: "Encontre e reutilize seus prompts anteriores.",
    conversation: "Conversa",
    today: "Hoje",
    yesterday: "Ontem",
    unknownDate: "Data desconhecida",
    moreActions: "Mais ações do prompt",
    title: "Histórico de prompts",
    open: "Abrir histórico de prompts",
    close: "Fechar histórico",
    search: "Buscar nos prompts carregados…",
    scope: "Conversas",
    all: "Conversas recentes",
    current: "Esta conversa",
    refresh: "Atualizar",
    more: "Carregar mais conversas",
    morePrompts: "Ver mais prompts",
    loading: "Carregando histórico…",
    empty: "Nenhum prompt anterior encontrado.",
    noMatches: "Nenhum prompt carregado corresponde à busca.",
    reuse: "Reutilizar",
    copy: "Copiar",
    copied: "Prompt copiado.",
    copyFailed: "Não foi possível copiar. Expanda o prompt e copie o texto manualmente.",
    expand: "Ver texto completo",
    collapse: "Recolher",
    origin: "Abrir conversa original",
    textOnly: "Só o texto é reutilizado. Anexos e referências não são restaurados.",
    attachments: "Tinha anexos",
    truncated: "Prompt longo: esta prévia está incompleta. Abra a conversa original para recuperar o texto completo.",
    confirm: "Substituir seu rascunho atual? Ele não será enviado automaticamente.",
    replace: "Substituir rascunho",
    cancel: "Cancelar",
    partial: "Algumas conversas não puderam ser lidas. Atualize para tentar novamente.",
    failed: "Não foi possível carregar o histórico.",
    migration: "Algumas conversas precisam de migração ou ainda não têm a projeção do histórico disponível.",
    loaded: "Conversas consultadas",
    prompts: "Prompts",
    bounds: "Até 60 prompts por conversa e as 50 conversas mais recentes. A busca filtra apenas o texto carregado.",
    omitted: "Prompts antigos omitidos pelos limites por conversa",
    busy: "Aguarde o envio atual ou saia do modo de comando antes de reutilizar um prompt.",
    draftAttachments: "Remova os anexos do rascunho antes de reutilizar outro prompt.",
    references: "O rascunho atual contém referências. Copie este prompt ou limpe o campo primeiro.",
    changed: "O editor não pôde aplicar esta alteração com segurança. Seu rascunho atual foi preservado.",
    bang: "Este texto começa com ! e abriria o terminal. Use Copiar.",
    referenceText: "Este prompt contém marcadores de referência do editor. Use Copiar e confira o texto.",
    invalid: "Este prompt não pode ser reutilizado.",
    reused: "Prompt inserido. Revise antes de enviar."
  };

  // legacy-notice.js
  var ownedMessages = /* @__PURE__ */ new Set([en.reused, pt.reused]);
  function clearLegacyHistoryNotice(input) {
    const notices = input?.notices;
    if (typeof notices?.getSnapshot !== "function" || typeof notices?.set !== "function") return false;
    const current = notices.getSnapshot();
    if (current?.level !== "info" || !ownedMessages.has(current.text)) return false;
    notices.set(null);
    return true;
  }

  // presence.js
  var ENTER_MS = 180;
  var EXIT_MS = 120;
  function createPresenceDriver(publish, clock) {
    let state = { present: false, phase: "closed" }, generation = 0, frame, timer;
    const update = (next) => {
      if (next.present === state.present && next.phase === state.phase) return;
      state = next;
      publish(next);
    };
    function stop() {
      generation++;
      if (frame !== void 0) clock.cancelFrame(frame);
      if (timer !== void 0) clock.clearDelay(timer);
      frame = timer = void 0;
    }
    function setOpen(open, instant = false) {
      stop();
      const version = generation;
      if (instant) {
        update({ present: open, phase: open ? "open" : "closed" });
        return;
      }
      if (open) {
        if (state.phase === "exit" || state.phase === "open") {
          update({ present: true, phase: "open" });
          return;
        }
        update({ present: true, phase: "enter" });
        frame = clock.frame(() => {
          if (generation !== version) return;
          frame = clock.frame(() => {
            if (generation === version) {
              frame = void 0;
              update({ present: true, phase: "open" });
            }
          });
        });
      } else if (!state.present || state.phase === "enter") update({ present: false, phase: "closed" });
      else {
        update({ present: true, phase: "exit" });
        timer = clock.delay(() => {
          if (generation === version) {
            timer = void 0;
            update({ present: false, phase: "closed" });
          }
        }, EXIT_MS + 32);
      }
    }
    return { setOpen, stop };
  }

  // presentation.js
  function validDate(value) {
    if (value instanceof Date) return Number.isFinite(value.getTime()) ? new Date(value.getTime()) : null;
    if (typeof value !== "string" && typeof value !== "number") return null;
    if (typeof value === "string") {
      const parts = /^([+-]\d{6}|\d{4})-(\d{2})-(\d{2})T/.exec(value);
      if (!parts) return null;
      const [year, month, day] = parts.slice(1).map(Number);
      const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
      const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
      if (day < 1 || day > (days[month - 1] || 0)) return null;
    }
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
  }
  function formatter(locale, options) {
    try {
      const supported = Intl.DateTimeFormat.supportedLocalesOf(locale).length > 0;
      return new Intl.DateTimeFormat(supported ? locale : "en", options);
    } catch {
      return new Intl.DateTimeFormat("en", options);
    }
  }
  function dayKey(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }
  function groupPromptsByDay(items, { locale = "en", now = /* @__PURE__ */ new Date(), today = "Today", yesterday = "Yesterday", unknown = "Unknown date" } = {}) {
    const current = validDate(now);
    const previous = current && new Date(current.getTime());
    if (previous) previous.setDate(previous.getDate() - 1);
    const todayKey = current && dayKey(current), yesterdayKey = previous && dayKey(previous);
    const shortDate = formatter(locale, { month: "short", day: "numeric" });
    const fullDate = formatter(locale, { month: "short", day: "numeric", year: "numeric" });
    const groups = [];
    for (const item of Array.isArray(items) ? items : []) {
      const date = validDate(item?.time);
      const key = date ? dayKey(date) : "unknown";
      let group = groups.at(-1);
      if (!group || group.key !== key) {
        let label = unknown;
        if (date) {
          label = (current && date.getFullYear() === current.getFullYear() ? shortDate : fullDate).format(date);
          const relative = key === todayKey ? today : key === yesterdayKey ? yesterday : null;
          if (relative) label = `${relative} · ${label}`;
        }
        group = { key, label, items: [] };
        groups.push(group);
      }
      group.items.push(item);
    }
    return groups;
  }
  function promptTime(value, locale = "en") {
    const date = validDate(value);
    return date ? formatter(locale, { hour: "2-digit", minute: "2-digit" }).format(date) : "—";
  }

  // dismiss.js
  function listenForOutsidePointer(target, getRoots, onOutside) {
    const handle = (event) => {
      const path = event.composedPath();
      if (!getRoots().some((root) => root && path.includes(root))) onOutside();
    };
    const options = { capture: true };
    target.addEventListener("pointerdown", handle, options);
    return () => target.removeEventListener("pointerdown", handle, options);
  }

  // navigation.js
  function selectHistoryItem(items, currentKey, move = "older") {
    const rows = Array.isArray(items) ? items : [];
    const total = rows.length;
    const cleared = { key: null, index: -1, total };
    if (total === 0) return cleared;
    const currentIndex = currentKey == null ? -1 : rows.findIndex((item) => item.key === currentKey);
    let index;
    if (move === "first") index = 0;
    else if (move === "newer") index = Math.max(0, currentIndex - 1);
    else index = currentIndex < 0 ? 0 : Math.min(currentIndex + 1, total - 1);
    return { key: rows[index].key, index, total };
  }

  // editor-actions.js
  function prepare(input, item, span, quote) {
    if (!item || typeof item.text !== "string" || !item.text.trim()) return { kind: "blocked", reason: "empty" };
    if (item.truncated) return { kind: "blocked", reason: "truncated" };
    if (/[\uE100-\uE11D\uFFFC]/u.test(item.text)) return { kind: "blocked", reason: "referenceText" };
    const snapshot = input?.state.getSnapshot();
    if (!snapshot || snapshot.phase !== "plain" || snapshot.claim || !Number.isSafeInteger(snapshot.draftRev)) return { kind: "blocked", reason: "busy" };
    if (!span || !Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end) || span.start < 0 || span.end < span.start || span.draftRev !== snapshot.draftRev) return { kind: "blocked", reason: "changed" };
    if (snapshot.draft.startsWith("!") || !quote && item.text.startsWith("!")) return { kind: "blocked", reason: "bang" };
    return { kind: "ready" };
  }
  function pasteHistoryPrompt(input, actions, item, span) {
    const decision = prepare(input, item, span, false);
    if (decision.kind !== "ready") return decision;
    if (!actions.insertText(item.text, span)) return { kind: "blocked", reason: "changed" };
    actions.persistDraft();
    input.focus();
    return { kind: "applied" };
  }
  function quoteHistoryPrompt(input, actions, item, span) {
    const decision = prepare(input, item, span, true);
    if (decision.kind !== "ready") return decision;
    if (!actions.insertQuote(item.text)) return { kind: "blocked", reason: "unavailable" };
    actions.persistDraft();
    input.focus();
    return { kind: "applied" };
  }

  // composer-bridge.js
  var COMPOSER_CARD = "[data-composer-card]";
  var COMPOSER_EDITOR = "[data-composer-input]";
  var DOUBLE_DOWN_MS = 500;
  var CHIPS = '[data-composer-chip],[data-composer-command],[data-composer-quote],[contenteditable="false"]';
  function visible(node) {
    if (node.closest('[hidden],[inert],[aria-hidden="true"]')) return false;
    const popover = node.closest("[popover]");
    if (popover && !popover.matches(":popover-open")) return false;
    return typeof node.checkVisibility !== "function" || node.checkVisibility({ visibilityProperty: true });
  }
  function inspectComposerTarget(launcher, event) {
    const doc = launcher?.ownerDocument, target = event.target;
    if (!launcher?.isConnected || !doc || typeof target?.closest !== "function") return null;
    const card = launcher.closest(COMPOSER_CARD), editor = target.closest(COMPOSER_EDITOR);
    if (!card || !editor || editor.closest(COMPOSER_CARD) !== card || doc.activeElement !== editor || !editor.isContentEditable) return null;
    const selection = doc.getSelection();
    const inside = selection?.rangeCount > 0 && selection.anchorNode && selection.focusNode && editor.contains(selection.anchorNode) && editor.contains(selection.focusNode);
    return {
      owned: true,
      editor,
      focused: doc.hasFocus(),
      collapsed: !!inside && selection.isCollapsed,
      empty: editor.textContent === "",
      disabled: !!editor.closest("[inert]") || editor.getAttribute("aria-disabled") === "true" || editor.getAttribute("data-phase") !== "plain",
      composing: editor.hasAttribute("data-composer-composing"),
      structured: !!editor.querySelector(CHIPS),
      popup: !!card.querySelector("[data-trigger-menu]") || [...card.querySelectorAll('[role="listbox"],[role="menu"],[aria-haspopup][aria-expanded="true"]')].some(visible),
      modal: [...doc.querySelectorAll('dialog[open],[aria-modal="true"]')].some(visible)
    };
  }
  function openKey(event) {
    if (event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && (event.code === "KeyR" || event.key?.toLowerCase() === "r")) return "reverse";
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return null;
    if (event.key === "ArrowUp") return "older";
    if (event.key === "ArrowDown") return "newer";
    return null;
  }
  function composerOpenIntent(event, input, view) {
    const key = openKey(event);
    if (!key) return null;
    if (event.defaultPrevented || event.repeat || event.isComposing || event.keyCode === 229) return null;
    if (!view || view.owned !== true || view.focused !== true || view.collapsed !== true) return null;
    if (view.disabled !== false || view.composing !== false || view.structured !== false || view.popup !== false || view.modal !== false) return null;
    if (!input || input.phase !== "plain" || input.claim || typeof input.draft !== "string" || !Number.isSafeInteger(input.draftRev)) return null;
    if (!Array.isArray(input.attachmentIds) || input.attachmentIds.length || !Array.isArray(input.occurrences) || input.occurrences.length) return null;
    if (/^\s*[!/@]/u.test(input.draft) || /[\uE100-\uE11D\uFFFC]/u.test(input.draft)) return null;
    if (key === "reverse") return key;
    return input.draft === "" && view.empty === true ? key : null;
  }
  function listenForComposerOpen(target, { inspect, readInput, open, enabled = () => true, now = () => performance.now() }) {
    const options = { capture: true };
    let composing = false, ended = -Infinity, stopped = false, down = null;
    const reset = () => {
      down = null;
    };
    const start = () => {
      reset();
      composing = true;
    };
    const end = () => {
      reset();
      composing = false;
      ended = now();
    };
    const blur = () => {
      reset();
      if (composing) end();
    };
    const key = (event) => {
      if (stopped) return;
      const at = now();
      if (composing || at - ended < 20 || event.defaultPrevented || event.repeat || !openKey(event)) {
        reset();
        return;
      }
      try {
        if (!enabled()) {
          reset();
          return;
        }
        const view = inspect(event);
        if (!view) {
          reset();
          return;
        }
        const input = readInput(), intent = composerOpenIntent(event, input, view);
        if (!intent) {
          reset();
          return;
        }
        if (intent === "newer") {
          if (!view.editor) {
            reset();
            return;
          }
          const paired = down && down.editor === view.editor && down.revision === input.draftRev && at >= down.at && at - down.at <= DOUBLE_DOWN_MS;
          if (!paired) {
            down = { editor: view.editor, revision: input.draftRev, at };
            return;
          }
        }
        reset();
        if (open(intent) === true) {
          event.preventDefault();
          event.stopPropagation();
        }
      } catch {
        reset();
      }
    };
    target.addEventListener("keydown", key, options);
    target.addEventListener("compositionstart", start, options);
    target.addEventListener("compositionend", end, options);
    target.addEventListener("focusout", blur, options);
    target.addEventListener("pointerdown", reset, options);
    return () => {
      if (stopped) return;
      stopped = true;
      reset();
      target.removeEventListener("keydown", key, options);
      target.removeEventListener("compositionstart", start, options);
      target.removeEventListener("compositionend", end, options);
      target.removeEventListener("focusout", blur, options);
      target.removeEventListener("pointerdown", reset, options);
    };
  }

  // client.js
  window.__ModuleLoader__.load({ id: "@local/dsh-prompt-history", factory: (require2) => {
    const React = require2("react"), h = React.createElement, { createPortal } = require2("react-dom");
    const { useState, useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } = React;
    const css = `
.rph-launch{box-sizing:border-box;width:28px;height:28px;padding:0;corner-shape:round;border:none;border-radius:999px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer;flex:none;place-items:center;display:grid}
@media(hover:hover){.rph-launch:hover:not(:disabled){background:color-mix(in srgb,currentColor 12%,transparent)}}
.rph-launch:disabled{opacity:.5;cursor:default}
.rph-panel{box-sizing:border-box;width:calc(100% - 24px);max-width:1100px;margin:0 auto 10px;display:flex;flex-direction:column;max-height:min(66dvh,680px);min-height:0;overflow:hidden;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg,12px);font:inherit;font-size:13px;line-height:1.5;container:rph / inline-size}
.rph-panel *{box-sizing:border-box}.rph-head{display:flex;align-items:center;gap:12px;padding:16px 18px;border-bottom:1px solid var(--dsw-alias-border-l1)}.rph-heading-icon{display:grid;place-items:center;flex:none;width:38px;height:38px;border-radius:10px;background:var(--dsw-alias-bg-layer-2)}.rph-heading{flex:1;min-width:0}.rph-heading h2{font:inherit;font-size:17px;font-weight:650;line-height:1.3;margin:0}.rph-heading p{margin:3px 0 0;color:var(--dsw-alias-label-secondary);font-size:12px}
.rph-tools{display:flex;gap:12px;align-items:center;padding:16px 18px 12px}.rph-panel input,.rph-panel select,.rph-panel button{font:inherit;color:inherit;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:var(--dsw-radius-md,8px);padding:7px 10px;min-height:34px}.rph-panel button{cursor:pointer}.rph-panel button:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}.rph-panel button:disabled{opacity:.5;cursor:default}.rph-panel button:focus-visible,.rph-launch:focus-visible,.rph-panel input:focus-visible,.rph-panel select:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.rph-search{flex:1;min-width:0;display:flex;align-items:center;gap:10px;padding:0 12px;border:1px solid color-mix(in srgb,var(--dsw-alias-border-l1) 65%,transparent);border-radius:10px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary)}.rph-search:focus-within{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}.rph-panel .rph-search input{width:100%;flex:1;min-width:0;padding:10px 0;border:0;border-radius:0;background:transparent;outline:none;color:var(--dsw-alias-label-primary);font-size:14px}.rph-search input::placeholder{color:var(--dsw-alias-label-secondary);opacity:1}.rph-search kbd{flex:none;white-space:nowrap;font:inherit;font-size:11px;padding:1px 5px;border:1px solid var(--dsw-alias-border-l1);border-radius:5px}.rph-tools select{min-width:165px;max-width:100%;min-height:42px;padding-inline:12px}
.rph-context{display:flex;align-items:center;gap:7px;padding:0 18px 12px;min-width:0;color:var(--dsw-alias-label-secondary);font-size:12px}.rph-panel .rph-conversation-link{border:0;background:transparent;min-height:24px;padding:0;min-width:0;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:start;color:var(--dsw-alias-label-secondary);text-decoration:underline;text-underline-offset:3px}.rph-conversation-link svg{vertical-align:middle;margin-inline-start:5px}
.rph-list{overflow:auto;min-height:0;overscroll-behavior:contain;padding:0 12px 10px}.rph-day-title{margin:0;padding:13px 6px 9px;font:inherit;font-size:12px;font-weight:650;color:var(--dsw-alias-label-secondary);border-bottom:1px solid var(--dsw-alias-border-l1)}.rph-item{padding:14px 8px;border-bottom:1px solid color-mix(in srgb,var(--dsw-alias-border-l1) 65%,transparent);border-radius:8px}.rph-row{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:18px}.rph-body{min-width:0}.rph-text{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;font-size:15px;line-height:1.55;font-weight:500;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.rph-text[data-expanded=true]{display:block;max-height:240px;overflow:auto;font-weight:400}.rph-caption{display:flex;gap:8px;align-items:center;margin-top:5px;min-width:0;font-size:12px;color:var(--dsw-alias-label-secondary)}.rph-attachment{display:inline-flex;align-items:center;gap:4px;flex:none}.rph-note{margin:5px 0 0;font-size:12px;color:var(--dsw-alias-state-warn-primary)}
.rph-actions{display:flex;align-items:center;gap:8px;flex:none}.rph-time{color:var(--dsw-alias-label-secondary);font-size:12px;font-variant-numeric:tabular-nums;white-space:nowrap;margin-inline-end:6px}.rph-panel .rph-icon-button{display:inline-grid;place-items:center;width:34px;height:34px;min-height:34px;flex:none;padding:0;background:transparent;border-color:transparent}.rph-panel .rph-copy{border-color:var(--dsw-alias-border-l1)}.rph-panel .rph-primary{display:inline-flex;align-items:center;justify-content:center;gap:6px;white-space:nowrap;font-weight:600;background:var(--dsw-alias-bg-layer-2);border-color:color-mix(in srgb,var(--dsw-alias-label-secondary) 30%,var(--dsw-alias-border-l1))}.rph-panel .rph-primary:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary)}.rph-icon{flex:none;vertical-align:middle}
.rph-menu{position:fixed;inset:auto;margin:0;min-width:195px;max-width:calc(100vw - 16px);padding:5px;max-height:calc(100dvh - 16px);overflow:auto;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);box-shadow:var(--dsw-elevation-soft);font:inherit;font-size:13px}.rph-menu:popover-open{display:flex;flex-direction:column;gap:2px}.rph-panel .rph-menu button{display:flex;align-items:center;gap:8px;width:100%;text-align:start;border:0;background:transparent;min-height:36px}.rph-menu::backdrop{background:transparent}
.rph-item[data-selected=true]{background:var(--dsw-alias-bg-layer-2);outline:1px solid var(--dsw-alias-brand-primary);outline-offset:-1px}.rph-item:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}.rph-nav{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:0 18px 10px;color:var(--dsw-alias-label-secondary);font-size:12px}.rph-nav p{margin:0;flex:1;min-width:150px}.rph-nav button{min-height:30px;font-size:12px}.rph-nav button[aria-pressed=true]{border-color:var(--dsw-alias-brand-primary)}
.rph-more{display:block;margin:12px auto 4px}.rph-status{padding:10px 18px;margin:0;color:var(--dsw-alias-label-secondary)}.rph-confirm{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:12px 18px;border-block:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2)}.rph-confirm p{margin:0;flex-basis:100%}.rph-launch svg{flex:none}
.rph-panel{--rph-out:cubic-bezier(.165,.84,.44,1);transform-origin:bottom left;opacity:1;transform:translateY(0) scale(1);transition:opacity ${ENTER_MS}ms var(--rph-out),transform ${ENTER_MS}ms var(--rph-out)}
.rph-panel[data-phase=enter],.rph-panel[data-phase=closed]{opacity:0;transform:translateY(8px) scale(.985)}
.rph-panel[data-phase=exit]{opacity:0;transform:translateY(5px) scale(.99);transition-duration:${EXIT_MS}ms;pointer-events:none}
.rph-panel button,.rph-item{transition:background-color 150ms ease,color 150ms ease,border-color 150ms ease}
@media(hover:hover){.rph-item:hover,.rph-item:focus-within{background:var(--dsw-alias-bg-layer-2)}}
.rph-panel button:active:not(:disabled){transform:scale(.98)}
.rph-list[data-ready=true]{animation:rph-results 140ms cubic-bezier(.215,.61,.355,1)}
.rph-confirm,.rph-status[role=status]{animation:rph-feedback 120ms cubic-bezier(.215,.61,.355,1)}
@keyframes rph-results{from{opacity:.7;transform:translateY(3px)}to{opacity:1;transform:none}}
@keyframes rph-feedback{from{opacity:0;transform:translateY(2px)}to{opacity:1;transform:none}}
.rph-tip{position:fixed;z-index:10000;pointer-events:none;width:max-content;max-width:min(280px,calc(100vw - 16px));box-sizing:border-box;padding:6px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);box-shadow:var(--dsw-elevation-soft);font:inherit;font-size:12px;line-height:18px;opacity:1;transform:translateY(-100%);transition:opacity 120ms cubic-bezier(.165,.84,.44,1),transform 120ms cubic-bezier(.165,.84,.44,1)}
.rph-tip[data-side=bottom]{transform:translateY(0)}.rph-tip[data-phase=enter],.rph-tip[data-phase=closed]{opacity:0;transform:translateY(calc(-100% + 4px))}.rph-tip[data-phase=exit]{opacity:0;transform:translateY(calc(-100% + 2px));transition-duration:90ms}.rph-tip[data-side=bottom][data-phase=enter],.rph-tip[data-side=bottom][data-phase=closed]{transform:translateY(-4px)}.rph-tip[data-side=bottom][data-phase=exit]{transform:translateY(-2px)}
@media(prefers-reduced-motion:reduce){.rph-panel,.rph-panel *,.rph-launch,.rph-launch svg,.rph-tip{animation:none!important;transition:none!important}.rph-launch svg,.rph-panel button{transform:none!important}}
@container rph (max-width:600px){.rph-tools{flex-wrap:wrap;gap:10px}.rph-search{flex-basis:100%}.rph-search kbd{display:none}.rph-tools select{width:100%}.rph-row{grid-template-columns:1fr;gap:10px}.rph-actions{justify-content:flex-end}.rph-time{margin-inline-end:auto}.rph-context{align-items:baseline}.rph-heading p{font-size:12px}}
@media(max-width:720px){.rph-panel{width:calc(100% - 16px)}.rph-actions button{min-height:36px}}
`;
    const glyphs = { history: "M3 11a9 9 0 1 1 2.4 7M3 5v6h6M12 7v5l3 2", search: "M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0", refresh: "M20 7v5h-5M4 17v-5h5M6 6a8 8 0 0 1 13 2M18 18a8 8 0 0 1-13-2", close: "m6 6 12 12M6 18 18 6", copy: "M9 5V3H3v14h2M8 7h13v14H8z", arrow: "M7 17 17 7M7 7h10v10", expand: "m8 3-5 0v5m13-5h5v5M3 16v5h5m13-5v5h-5", collapse: "m3 8 5 0V3m8 0v5h5M8 21v-5H3m13 5v-5h5", attachment: "m8 13 6-6a3 3 0 0 1 4 4l-8 8a5 5 0 0 1-7-7l9-9a7 7 0 0 1 10 10" };
    function icon(name, size = 16) {
      return h("svg", { className: "rph-icon", width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true }, name === "more" ? [5, 12, 19].map((x) => h("circle", { key: x, cx: x, cy: 12, r: 1, fill: "currentColor" })) : h("path", { d: glyphs[name] }));
    }
    function useReducedMotion() {
      const [reduced, setReduced] = useState(() => !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
      useEffect(() => {
        const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
        if (!media) return;
        const change = () => setReduced(media.matches);
        change();
        media.addEventListener?.("change", change);
        return () => media.removeEventListener?.("change", change);
      }, []);
      return reduced;
    }
    function usePresence(open, instant) {
      const [presence, setPresence] = useState({ present: false, phase: "closed" });
      const driver = useMemo(() => createPresenceDriver(setPresence, { frame: (fn) => requestAnimationFrame(fn), cancelFrame: (id) => cancelAnimationFrame(id), delay: (fn, ms) => setTimeout(fn, ms), clearDelay: (id) => clearTimeout(id) }), []);
      useLayoutEffect(() => {
        driver.setOpen(open, instant);
        return () => driver.stop();
      }, [driver, open, instant]);
      return presence;
    }
    function observable(value) {
      const listeners = /* @__PURE__ */ new Set();
      return { getSnapshot: () => value, subscribe: (fn) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      }, set: (next) => {
        value = next;
        for (const fn of listeners) fn();
      } };
    }
    function apply(ctx) {
      const ns = "local-prompt-history", stores = /* @__PURE__ */ new Map(), boundaries = /* @__PURE__ */ new Map(), launchers = /* @__PURE__ */ new Map();
      let openRequestId = 0;
      ctx.effect(() => ctx.locale.register(ns, "en", en));
      ctx.effect(() => ctx.locale.register(ns, "pt", pt));
      ctx.effect(() => ctx.locale.register(ns, "pt-BR", pt));
      const t = ctx.locale.bind(ns), forSession = (id) => {
        if (!stores.has(id)) stores.set(id, observable({ open: false, instant: false }));
        return stores.get(id);
      };
      const useLocale = () => useSyncExternalStore((fn) => ctx.locale.subscribe(fn), () => ctx.locale.getSnapshot());
      const inputFor = (id) => {
        const actx = ctx.sessions.scope(id);
        return actx ? ctx.conversation.input.for(actx) : null;
      };
      function close(id, instant = false, restoreFocus = true) {
        forSession(id).set({ open: false, instant });
        if (restoreFocus) inputFor(id)?.focus();
      }
      ctx.effect(() => ctx.on("connection/reset", () => {
        for (const store of stores.values()) store.set({ open: false, instant: true });
      }));
      ctx.effect(() => () => {
        stores.clear();
        boundaries.clear();
        launchers.clear();
      });
      function Launcher(props) {
        useLocale();
        useEffect(() => {
          try {
            clearLegacyHistoryNotice(inputFor(props.sessionId));
          } catch {
          }
        }, [props.sessionId]);
        const store = forSession(props.sessionId), current = useSyncExternalStore(store.subscribe, store.getSnapshot), open = current.open;
        const button = useRef(null), tip = useRef(null), timer = useRef(null), id = React.useId(), label = t("title"), reduced = useReducedMotion();
        useLayoutEffect(() => {
          const node = button.current;
          boundaries.set(node, props.sessionId);
          launchers.set(node, props.sessionId);
          return () => {
            boundaries.delete(node);
            launchers.delete(node);
          };
        }, [props.sessionId]);
        const [showTip, setShowTip] = useState(false), [anchor, setAnchor] = useState({ left: 0, top: 0, side: "top" }), tooltip = usePresence(showTip, reduced);
        const hideTip = () => {
          clearTimeout(timer.current);
          setShowTip(false);
        };
        const reveal = () => {
          clearTimeout(timer.current);
          if (!button.current) return;
          const box = button.current.getBoundingClientRect();
          setAnchor({ left: box.left + box.width / 2, top: box.top - 8, side: "top" });
          setShowTip(true);
        };
        useEffect(() => () => clearTimeout(timer.current), []);
        useEffect(() => {
          const node = button.current, doc = node?.ownerDocument;
          if (!doc) return;
          return listenForComposerOpen(doc, {
            inspect: (event) => inspectComposerTarget(node, event),
            readInput: () => inputFor(props.sessionId)?.state.getSnapshot(),
            enabled: () => !store.getSnapshot().open && [...launchers.values()].filter((id2) => id2 === props.sessionId).length === 1,
            open: (mode) => {
              if (store.getSnapshot().open) return false;
              hideTip();
              store.set({ open: true, instant: false, request: { id: ++openRequestId, mode } });
              return true;
            }
          });
        }, [props.sessionId]);
        useLayoutEffect(() => {
          if (!showTip || !tip.current || !button.current) return;
          const box = button.current.getBoundingClientRect(), size = tip.current.getBoundingClientRect();
          const below = box.top < size.height + 16;
          setAnchor({ left: Math.max(8, Math.min(box.left + box.width / 2 - size.width / 2, window.innerWidth - size.width - 8)), top: below ? box.bottom + 8 : box.top - 8, side: below ? "bottom" : "top" });
        }, [showTip, label]);
        useEffect(() => {
          if (!showTip) return;
          window.addEventListener("resize", hideTip);
          window.addEventListener("scroll", hideTip, true);
          return () => {
            window.removeEventListener("resize", hideTip);
            window.removeEventListener("scroll", hideTip, true);
          };
        }, [showTip]);
        return h(
          React.Fragment,
          null,
          h("style", null, css),
          h(
            "button",
            {
              ref: button,
              type: "button",
              className: "rph-launch",
              "aria-label": t("open"),
              "aria-expanded": open,
              "aria-describedby": showTip ? id : void 0,
              onPointerEnter: (event) => {
                if (event.pointerType === "mouse") {
                  clearTimeout(timer.current);
                  if (tooltip.present) reveal();
                  else timer.current = setTimeout(reveal, 500);
                }
              },
              onPointerLeave: hideTip,
              onBlur: hideTip,
              onFocus: (event) => {
                if (event.currentTarget.matches(":focus-visible")) reveal();
              },
              onKeyDown: (event) => {
                if (event.key === "Escape") hideTip();
              },
              onClick: () => {
                hideTip();
                if (open) close(props.sessionId);
                else store.set({ open: true, instant: false });
              }
            },
            h("svg", { width: 14, height: 14, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.7, "aria-hidden": true }, h("path", { d: "M3 11a9 9 0 1 1 2.4 7M3 5v6h6M12 7v5l3 2" }))
          ),
          (showTip || tooltip.present) && createPortal(h("span", { ref: tip, id, role: "tooltip", className: "rph-tip", "aria-hidden": !showTip, "data-phase": tooltip.phase, "data-side": anchor.side, style: { left: anchor.left, top: anchor.top } }, label), document.body)
        );
      }
      function Card({ item, onReuse, onCapture, onEditorAction, onNavigate, onSelect, selected, focusSelected, locale, onFeedback, onOrigin, showConversation, active }) {
        const [expanded, setExpanded] = useState(false), [menuOpen, setMenuOpen] = useState(false), [position, setPosition] = useState({ left: 0, top: 0 }), [point, setPoint] = useState(null), alive = useRef(true);
        const menuRef = useRef(null), triggerRef = useRef(null), rowRef = useRef(null), captured = useRef(null), id = React.useId(), workspace = ctx.get("uiWorkspace");
        useEffect(() => {
          alive.current = true;
          return () => {
            alive.current = false;
          };
        }, []);
        useEffect(() => {
          if (selected) {
            rowRef.current?.scrollIntoView({ block: "nearest" });
            if (focusSelected) rowRef.current?.focus({ preventScroll: true });
          }
        }, [selected, focusSelected]);
        const hideMenu = () => {
          if (menuRef.current?.matches(":popover-open")) menuRef.current.hidePopover();
          setMenuOpen(false);
        };
        useEffect(() => {
          const node = menuRef.current;
          if (!node) return;
          const toggle = (event) => setMenuOpen(event.newState === "open");
          node.addEventListener("toggle", toggle);
          return () => node.removeEventListener("toggle", toggle);
        }, []);
        useLayoutEffect(() => {
          if (!active) hideMenu();
        }, [active]);
        useLayoutEffect(() => {
          if (!menuOpen || !menuRef.current || !triggerRef.current) return;
          const box = triggerRef.current.getBoundingClientRect(), size = menuRef.current.getBoundingClientRect();
          const left = point ? point.x : box.right - size.width, top = point ? point.y : box.bottom + 6;
          setPosition({ left: Math.max(8, Math.min(left, window.innerWidth - size.width - 8)), top: Math.max(8, Math.min(top, window.innerHeight - size.height - 8)) });
          menuRef.current.querySelector("button:not(:disabled)")?.focus({ preventScroll: true });
        }, [menuOpen, point]);
        useEffect(() => {
          if (!menuOpen) return;
          const dismiss = () => hideMenu();
          window.addEventListener("resize", dismiss);
          window.addEventListener("scroll", dismiss, true);
          return () => {
            window.removeEventListener("resize", dismiss);
            window.removeEventListener("scroll", dismiss, true);
          };
        }, [menuOpen]);
        function openMenu(position2 = null) {
          if (!active) return;
          captured.current = onCapture();
          setPoint(position2);
          menuRef.current.showPopover();
          setMenuOpen(true);
        }
        function menuKey(event) {
          const buttons = [...event.currentTarget.querySelectorAll("button:not(:disabled)")], at = buttons.indexOf(event.target);
          if (event.key === "Escape") {
            event.stopPropagation();
            event.preventDefault();
            hideMenu();
            triggerRef.current?.focus({ preventScroll: true });
          } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
            event.preventDefault();
            event.stopPropagation();
            const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (at + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
            buttons[next]?.focus({ preventScroll: true });
          }
        }
        async function copy() {
          try {
            await navigator.clipboard.writeText(item.text);
            if (alive.current) onFeedback(t("copied"));
          } catch {
            if (alive.current) onFeedback(t("copyFailed"));
          }
        }
        const instant = new Date(item.time), validDate2 = !Number.isNaN(instant.getTime());
        const origin = () => {
          hideMenu();
          onOrigin();
          workspace.openSession(item.sessionId);
        };
        return h(
          "article",
          { ref: rowRef, className: "rph-item", tabIndex: 0, "data-selected": selected, "aria-current": selected ? "true" : void 0, "aria-labelledby": id + "-text", onFocus: (event) => {
            if (event.target === event.currentTarget) onSelect(item.key);
          }, onContextMenu: (event) => {
            if (menuRef.current?.contains(event.target)) return;
            event.preventDefault();
            event.stopPropagation();
            openMenu({ x: event.clientX, y: event.clientY });
          }, onKeyDown: (event) => {
            if (event.target !== event.currentTarget || event.isComposing || event.nativeEvent?.isComposing) return;
            if (event.key === "ContextMenu" || event.shiftKey && event.key === "F10") {
              event.preventDefault();
              event.stopPropagation();
              openMenu();
            } else if (!event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && ["ArrowUp", "ArrowDown"].includes(event.key)) {
              event.preventDefault();
              event.stopPropagation();
              onNavigate(event.key === "ArrowDown" ? "older" : "newer", item.key);
            } else if (event.key === "Enter") {
              event.preventDefault();
              event.stopPropagation();
              onEditorAction("paste", item, onCapture());
            }
          } },
          h(
            "div",
            { className: "rph-row" },
            h(
              "div",
              { className: "rph-body" },
              h("p", { id: id + "-text", className: "rph-text", "data-expanded": expanded }, item.text),
              (showConversation || item.hasAttachments) && h("div", { className: "rph-caption" }, showConversation && (workspace ? h("button", { type: "button", className: "rph-conversation-link", title: item.title, onClick: origin }, item.title, icon("arrow", 12)) : h("span", null, item.title)), item.hasAttachments && h("span", { className: "rph-attachment", role: "img", "aria-label": t("attachments"), title: t("attachments") }, icon("attachment", 13))),
              item.truncated && h("p", { className: "rph-note" }, t("truncated"))
            ),
            h(
              "div",
              { className: "rph-actions" },
              h("time", { className: "rph-time", dateTime: validDate2 ? instant.toISOString() : void 0, title: validDate2 ? instant.toISOString() : t("unknownDate") }, promptTime(item.time, locale)),
              h("button", { type: "button", className: "rph-icon-button rph-copy", title: t("copy"), "aria-label": t("copy"), disabled: item.truncated, onClick: () => void copy() }, icon("copy")),
              h("button", { type: "button", className: "rph-primary", disabled: item.truncated, onClick: () => onReuse(item) }, t("reuse"), icon("arrow", 14)),
              h("button", { ref: triggerRef, type: "button", className: "rph-icon-button", title: t("moreActions"), "aria-label": t("moreActions"), "aria-haspopup": "menu", "aria-expanded": menuOpen, "aria-controls": id + "-menu", onClick: () => {
                if (menuOpen) hideMenu();
                else openMenu();
              } }, icon("more"))
            )
          ),
          h(
            "div",
            { ref: menuRef, id: id + "-menu", popover: "auto", role: "menu", "aria-label": t("moreActions"), className: "rph-menu", style: position, onKeyDown: menuKey, onBlur: (event) => {
              if (!event.currentTarget.contains(event.relatedTarget)) hideMenu();
            } },
            h("button", { type: "button", role: "menuitem", tabIndex: -1, disabled: item.truncated, onClick: () => {
              hideMenu();
              void copy();
              triggerRef.current?.focus({ preventScroll: true });
            } }, icon("copy"), t("copy")),
            h("button", { type: "button", role: "menuitem", tabIndex: -1, disabled: item.truncated || !captured.current, onClick: () => {
              hideMenu();
              onEditorAction("quote", item, captured.current);
            } }, icon("arrow"), t("quote")),
            h("button", { type: "button", role: "menuitem", tabIndex: -1, disabled: item.truncated || !captured.current, onClick: () => {
              hideMenu();
              onEditorAction("paste", item, captured.current);
            } }, icon("arrow"), t("paste")),
            h("button", { type: "button", role: "menuitem", tabIndex: -1, onClick: () => {
              hideMenu();
              setExpanded((v) => !v);
              triggerRef.current?.focus({ preventScroll: true });
            } }, icon(expanded ? "collapse" : "expand"), t(expanded ? "collapse" : "expand")),
            workspace && h("button", { type: "button", role: "menuitem", tabIndex: -1, onClick: origin }, icon("arrow"), t("origin"))
          )
        );
      }
      function Panel(props) {
        const locale = useLocale(), [scope, setScope] = useState("current"), [query, setQuery] = useState(""), [pending, setPending] = useState(null), [feedback, setFeedback] = useState(""), [shown, setShown] = useState(40);
        const [selectedKey, setSelectedKey] = useState(null), [reverse, setReverse] = useState(false), [focusSelection, setFocusSelection] = useState(false), [requestApplied, setRequestApplied] = useState(null), keysId = React.useId(), composition = useRef({ active: false, ended: -Infinity });
        const [model, setModel] = useState(() => createHistoryReader(ctx.remote.session, props.sessionId));
        const state = useSyncExternalStore(model.state.subscribe, model.state.getSnapshot), wasOpen = useRef(props.open), panelRef = useRef(null), searchRef = useRef(null), requestSeen = useRef(null), initialSelection = useRef(false);
        useLayoutEffect(() => {
          const node = panelRef.current;
          boundaries.set(node, props.sessionId);
          return () => {
            boundaries.delete(node);
          };
        }, [props.sessionId]);
        useEffect(() => {
          if (!props.open) return;
          return listenForOutsidePointer(window, () => [...boundaries].filter(([, id]) => id === props.sessionId).map(([node]) => node), () => {
            if (forSession(props.sessionId).getSnapshot().open) close(props.sessionId, true, false);
          });
        }, [props.open, props.sessionId]);
        useLayoutEffect(() => {
          if (panelRef.current) panelRef.current.inert = !props.open;
          if (!props.open) model.cancel();
          else if (!wasOpen.current) void model.load(scope);
          wasOpen.current = props.open;
        }, [props.open, model, scope]);
        useEffect(() => {
          const next = createHistoryReader(ctx.remote.session, props.sessionId);
          setModel(next);
          void next.load(scope);
          return () => next.dispose();
        }, [props.sessionId, scope]);
        const items = state.scope === scope ? state.items : [], filtered = filterPrompts(items, query), currentItem = items.find((item) => item.sessionId === props.sessionId);
        const selected = filtered.find((item) => item.key === selectedKey), selectedIndex = selected ? filtered.indexOf(selected) : -1;
        const groups = groupPromptsByDay(filtered.slice(0, shown), { locale: locale.active, today: t("today"), yesterday: t("yesterday"), unknown: t("unknownDate") });
        const workspace = ctx.get("uiWorkspace");
        useLayoutEffect(() => {
          const request = props.openRequest;
          if (!props.open || !request || requestSeen.current === request.id) return;
          requestSeen.current = request.id;
          initialSelection.current = true;
          setScope("current");
          setQuery("");
          setPending(null);
          setFeedback("");
          setShown(40);
          setSelectedKey(null);
          setFocusSelection(false);
          setReverse(request.mode === "reverse");
          searchRef.current?.focus({ preventScroll: true });
          setRequestApplied(request.id);
        }, [props.open, props.openRequest]);
        useEffect(() => {
          if (!props.open || !props.openRequest || requestApplied !== props.openRequest.id || !initialSelection.current || scope !== "current" || state.scope !== "current" || state.phase !== "ready" || model.state.getSnapshot() !== state) return;
          initialSelection.current = false;
          setSelectedKey(selectHistoryItem(filtered, null, "first").key);
        }, [props.open, props.openRequest, requestApplied, scope, model, state, query]);
        useEffect(() => setShown(40), [query, scope]);
        useEffect(() => {
          if (reverse && !selected && filtered.length) setSelectedKey(filtered[0].key);
        }, [state.items]);
        function browse(move, from, enterRows = false) {
          initialSelection.current = false;
          const rowDriven = from !== void 0, next = selectHistoryItem(filtered, rowDriven ? from : selectedKey, move);
          setFocusSelection(rowDriven || enterRows);
          setSelectedKey(next.key);
          if (next.index >= 0) setShown((count) => Math.max(count, Math.ceil((next.index + 1) / 40) * 40));
        }
        function reverseSearch() {
          setReverse(true);
          browse(reverse ? "older" : "first");
          searchRef.current?.focus();
        }
        function capture() {
          try {
            return props.inputActions.captureInsertion();
          } catch {
            setFeedback(t("actionUnavailable"));
            return null;
          }
        }
        function editorAction(kind, item, span) {
          const input = inputFor(props.sessionId);
          if (!input) {
            setFeedback(t("busy"));
            return;
          }
          try {
            const result = (kind === "quote" ? quoteHistoryPrompt : pasteHistoryPrompt)(input, props.inputActions, item, span);
            if (result.kind === "applied") {
              setPending(null);
              close(props.sessionId, true);
              return;
            }
            const keys = { busy: "busy", changed: "changed", bang: "bang", truncated: "truncated", empty: "invalid", referenceText: "referenceText", unavailable: "actionUnavailable" };
            setFeedback(t(keys[result.reason] || "invalid"));
          } catch {
            setFeedback(t("actionFailed"));
          }
        }
        function reuse(item, revision) {
          setFeedback("");
          const input = inputFor(props.sessionId);
          if (!input) {
            setFeedback(t("busy"));
            return;
          }
          try {
            const result = reusePrompt(input, props.inputActions, item, revision);
            if (result.kind === "confirm") {
              setPending({ item, revision: result.revision });
              return;
            }
            setPending(null);
            if (result.kind === "applied") {
              close(props.sessionId, true);
              return;
            }
            const keys = { busy: "busy", attachments: "draftAttachments", references: "references", changed: "changed", bang: "bang", truncated: "truncated", empty: "invalid", referenceText: "referenceText" };
            setFeedback(t(keys[result.reason] || "invalid"));
          } catch {
            setPending(null);
            setFeedback(t("changed"));
          }
        }
        const unavailable = state.issues.some((issue) => ["projection-unavailable", "migration-required"].includes(issue.code));
        return h(
          "section",
          { ref: panelRef, className: "rph-panel", "data-phase": props.phase, "aria-hidden": !props.open, role: "region", "aria-label": t("title"), onCompositionStart: () => {
            composition.current.active = true;
          }, onCompositionEnd: () => {
            composition.current = { active: false, ended: performance.now() };
          }, onKeyDown: (event) => {
            if (composition.current.active || performance.now() - composition.current.ended < 20 || event.isComposing || event.nativeEvent?.isComposing || event.nativeEvent?.keyCode === 229) return;
            if (event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "r") {
              event.preventDefault();
              event.stopPropagation();
              reverseSearch();
              return;
            }
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k" && !event.isComposing && !event.nativeEvent?.isComposing) {
              event.preventDefault();
              event.stopPropagation();
              setFocusSelection(false);
              searchRef.current?.focus();
              return;
            }
            if (event.target === searchRef.current && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
              if (["ArrowUp", "ArrowDown"].includes(event.key)) {
                event.preventDefault();
                event.stopPropagation();
                browse("first", void 0, true);
                return;
              }
              if (event.key === "Enter") {
                event.preventDefault();
                event.stopPropagation();
                if (selected) editorAction("paste", selected, capture());
                return;
              }
            }
            if (event.key === "Escape") {
              initialSelection.current = false;
              event.stopPropagation();
              event.preventDefault();
              if (pending) setPending(null);
              else if (reverse) {
                setReverse(false);
                setSelectedKey(null);
              } else close(props.sessionId, true);
            }
          } },
          h("style", null, css),
          h("header", { className: "rph-head" }, h("span", { className: "rph-heading-icon" }, icon("history", 22)), h("div", { className: "rph-heading" }, h("h2", null, t("title")), h("p", null, t("description"))), h("button", { type: "button", className: "rph-icon-button", title: t("refresh"), "aria-label": t("refresh"), disabled: state.phase === "loading", onClick: () => {
            initialSelection.current = false;
            setPending(null);
            setSelectedKey(null);
            void model.load(scope);
          } }, icon("refresh", 19)), h("button", { type: "button", className: "rph-icon-button", title: t("close"), "aria-label": t("close"), onClick: () => close(props.sessionId) }, icon("close", 19))),
          h(
            "div",
            { className: "rph-tools" },
            h("div", { className: "rph-search" }, icon("search", 18), h("input", { ref: searchRef, type: "search", autoFocus: true, value: query, placeholder: t("search"), "aria-label": t("search"), "aria-describedby": keysId, onChange: (e) => {
              const value = e.target.value;
              setFocusSelection(false);
              setQuery(value);
              setSelectedKey(reverse ? selectHistoryItem(filterPrompts(items, value), null, "first").key : null);
            } }), h("kbd", { "aria-hidden": true }, "Ctrl/⌘ K")),
            h("select", { value: scope, "aria-label": t("scope"), onChange: (e) => {
              initialSelection.current = false;
              setPending(null);
              setFeedback("");
              setSelectedKey(null);
              setReverse(false);
              setScope(e.target.value);
            } }, h("option", { value: "all" }, t("all")), h("option", { value: "current" }, t("current")))
          ),
          h("div", { className: "rph-nav" }, h("p", { id: keysId, role: "status", "aria-live": "polite" }, t(reverse ? "reverseSearch" : "panelKeys"), selected ? " · " + (selectedIndex + 1) + " / " + filtered.length : ""), h("button", { type: "button", "aria-pressed": reverse, onClick: reverseSearch }, t("reverseSearch"), " · Ctrl R"), h("button", { type: "button", disabled: !filtered.length || selectedIndex === filtered.length - 1, onClick: () => browse("older") }, "↓ ", t("older")), h("button", { type: "button", disabled: selectedIndex <= 0, onClick: () => browse("newer") }, "↑ ", t("newer"))),
          scope === "current" && currentItem && h("div", { className: "rph-context" }, h("span", null, t("conversation"), ":"), workspace ? h("button", { type: "button", className: "rph-conversation-link", title: currentItem.title, onClick: () => {
            close(props.sessionId, true);
            workspace.openSession(props.sessionId);
          } }, currentItem.title, icon("arrow", 12)) : h("span", null, currentItem.title)),
          pending && h("div", { className: "rph-confirm", role: "group", "aria-label": t("confirm") }, h("p", null, t("confirm")), h("button", { type: "button", className: "rph-primary", onClick: () => reuse(pending.item, pending.revision) }, t("replace")), h("button", { type: "button", onClick: () => setPending(null) }, t("cancel"))),
          feedback && h("p", { className: "rph-status", role: "status" }, feedback),
          state.issues.length > 0 && h("p", { className: "rph-status", role: "alert" }, t(state.phase === "error" ? "failed" : unavailable ? "migration" : "partial"), " (", state.issues.length, ")"),
          h(
            "div",
            { className: "rph-list", "data-ready": state.phase === "ready", "aria-busy": state.phase === "loading" },
            groups.map((group, index) => h("section", { className: "rph-day", key: group.key + ":" + index, "aria-label": group.label }, h("h3", { className: "rph-day-title" }, group.label), group.items.map((item) => h(Card, { key: item.key, item, onReuse: reuse, onCapture: capture, onEditorAction: editorAction, onNavigate: browse, onSelect: setSelectedKey, selected: item.key === selectedKey, focusSelected: focusSelection, locale: locale.active, onFeedback: setFeedback, onOrigin: () => close(props.sessionId, true), showConversation: scope !== "current", active: props.open })))),
            filtered.length > shown && h("button", { type: "button", className: "rph-more", onClick: () => setShown((n) => n + 40) }, t("morePrompts")),
            !filtered.length && state.phase === "ready" && !state.issues.length && h("p", { className: "rph-status" }, t(query.trim() ? "noMatches" : "empty")),
            state.more && h("button", { type: "button", className: "rph-more", onClick: () => void model.more() }, t("more")),
            state.phase === "loading" && h("p", { className: "rph-status", role: "status" }, t("loading"))
          )
        );
      }
      function Dock(props) {
        const store = forSession(props.sessionId), current = useSyncExternalStore(store.subscribe, store.getSnapshot), open = current.open;
        const reduced = useReducedMotion(), presence = usePresence(open, reduced || current.instant);
        if (!open && current.instant) return null;
        return open || presence.present ? h(Panel, { ...props, key: props.sessionId, open, openRequest: current.request, phase: presence.phase }) : null;
      }
      ctx.slots.inject("conversation.input.left", () => ctx.slots.register({ name: "conversation.input.left", id: "prompt-history-launcher", order: 40 }, Launcher));
      ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({ name: "conversation.input.dock", id: "prompt-history-panel", order: 14 }, Dock));
    }
    return { apply, inject: ["slots", "locale", "sessions", "remote", "remote.session", "conversation"] };
  } });
})();
