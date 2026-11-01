// Scratcher: plain text pads in the browser's side panel.
// Saving follows NewTabPad by Norikazu Kato (MIT): debounced writes to
// chrome.storage.local, kept in step across open panels. Sync to the user's
// other computers happens in the service worker (see sync.js).
(() => {
  'use strict';

  const Sync = self.ScratcherSync;
  const { K } = Sync;
  const INBOX_KEY = 'inbox';
  const SAVE_MS = 150;
  const VIEW_MS = 400;
  const TEXT_FILE = /\.(txt|text|md|markdown|mdx|csv|tsv|json|jsonl|ya?ml|toml|ini|xml|html?|css|js|mjs|ts|tsx|jsx|py|rb|go|rs|sh|sql|log|srt|vtt|tex)$/i;
  const isMac = /mac/i.test(navigator.userAgentData?.platform ?? navigator.platform);
  const MOD = isMac ? '⌘' : 'Ctrl+';
  const SHIFT = isMac ? '⇧' : 'Shift+';
  const myId = crypto.randomUUID();

  const $ = (id) => document.getElementById(id);
  const tabsEl = $('tabs');
  const editorsEl = $('editors');
  const btn = { speak: $('speakBtn'), copy: $('copyBtn'), clear: $('clearBtn'), add: $('newBtn'), sync: $('syncNote') };

  // Pads on this computer. Each pad has its own textarea, so each keeps its own undo history.
  const pads = new Map(); // id -> { id, name, text, rev, at }
  const editors = new Map(); // id -> textarea
  let order = [];
  let activeId = null;
  let editor = null; // the active pad's textarea
  let views = {}; // id -> { start, end, top }
  let syncState = { pads: {} };

  let ready = false; // start() has loaded what's stored
  let windowId = null;
  let saveTimer = null;
  let viewTimer = null;
  let saveFailed = false;
  const dirty = new Set();

  // ── Text helpers ──

  // Clean up pasted or dropped text: one kind of line break, no invisible
  // characters, no trailing spaces, at most one blank line in a row.
  function tidy(text) {
    return text
      .replace(/\r\n?/g, '\n')
      .replace(/[​-‍⁠﻿­]/g, '')
      .replace(/[   ]/g, ' ')
      .replace(/[ \t]+$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/^\n+|\n+$/g, '');
  }

  // Insert through execCommand so Cmd+Z can undo it.
  // A block (a dropped file, a sent snippet) becomes its own paragraph.
  function insert(text, { atEnd = false, block = atEnd } = {}) {
    editor.focus();
    if (atEnd) {
      const len = editor.value.length;
      editor.setSelectionRange(len, len);
    }
    const before = editor.value.slice(0, editor.selectionStart);
    const after = editor.value.slice(editor.selectionEnd);
    const lead = block && before ? (before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n') : '';
    const trail = block && after ? (after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : '\n\n') : '';
    const value = lead + text + trail;
    if (!document.execCommand('insertText', false, value)) {
      editor.setRangeText(value, editor.selectionStart, editor.selectionEnd, 'end');
      editor.dispatchEvent(new Event('input', { bubbles: true }));
    }
    if (after === '') editor.scrollTop = editor.scrollHeight;
  }

  function selectedText() {
    return editor.value.slice(editor.selectionStart, editor.selectionEnd);
  }

  // ── Counts ──

  const fmt = new Intl.NumberFormat();
  const words = (t) => (t.match(/\S+/g) ?? []).length;
  const plural = (n, one, many) => `${fmt.format(n)} ${n === 1 ? one : many}`;
  let countFrame = 0;

  function refreshCount() {
    cancelAnimationFrame(countFrame);
    countFrame = requestAnimationFrame(() => {
      if (!editor) return;
      const all = editor.value;
      const sel = selectedText();
      let label = '';
      if (sel) {
        label = `${fmt.format(words(sel))} of ${plural(words(all), 'word', 'words')} · ${plural(sel.length, 'char', 'chars')} selected`;
      } else if (all) {
        label = `${plural(words(all), 'word', 'words')} · ${plural(all.length, 'char', 'chars')}`;
      }
      $('count').textContent = label;
      const empty = all.trim() === '';
      btn.copy.disabled = empty;
      btn.clear.disabled = empty;
      if (!speaking) btn.speak.disabled = empty;
      refreshLabel(activeId);
    });
  }

  // ── Toast ──

  let toastTimer = null;

  function toast(message, action) {
    clearTimeout(toastTimer);
    $('toastText').textContent = message;
    const a = $('toastAction');
    a.hidden = !action;
    a.onclick = null;
    if (action) {
      a.textContent = action.label;
      a.onclick = () => { hideToast(); action.run(); };
    }
    $('toast').hidden = false;
    // The toast comes and goes, so screen readers hear it from a region that stays put.
    $('live').textContent = '';
    requestAnimationFrame(() => { $('live').textContent = message; });
    toastTimer = setTimeout(hideToast, action ? 6000 : 2200);
  }

  function hideToast() {
    clearTimeout(toastTimer);
    $('toast').hidden = true;
  }

  // ── Tabs ──

  function liveText(id) {
    return editors.get(id)?.value ?? pads.get(id)?.text ?? '';
  }

  function labelOf(id) {
    const pad = pads.get(id);
    return Sync.padLabel({ name: pad?.name, text: liveText(id) });
  }

  function refreshLabel(id) {
    const tab = id && $(`tab-${id}`);
    if (!tab || tab.querySelector('.rename')) return;
    const label = labelOf(id);
    const span = tab.querySelector('.label');
    if (span.textContent !== label) span.textContent = label;
    tab.title = `${label}\nDouble-click to rename`;
  }

  function makeTab(id) {
    const tab = document.createElement('div');
    tab.className = 'tab';
    tab.id = `tab-${id}`;
    tab.dataset.id = id;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-controls', `panel-${id}`);
    tab.setAttribute('aria-selected', 'false');
    tab.setAttribute('aria-keyshortcuts', 'F2 Delete');
    tab.tabIndex = -1;
    const label = document.createElement('span');
    label.className = 'label';
    const x = document.createElement('span');
    x.className = 'x';
    x.setAttribute('aria-hidden', 'true');
    x.title = 'Close pad';
    x.innerHTML = '<svg viewBox="0 0 12 12"><path d="M3.5 3.5l5 5M8.5 3.5l-5 5"/></svg>';
    tab.append(label, x);
    return tab;
  }

  function makeEditor(id) {
    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.id = `panel-${id}`;
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', `tab-${id}`);
    panel.hidden = true;
    const ta = document.createElement('textarea');
    ta.className = 'editor';
    ta.dataset.id = id;
    ta.spellcheck = false;
    ta.setAttribute('autocomplete', 'off');
    ta.setAttribute('autocapitalize', 'off');
    ta.setAttribute('aria-label', 'Text');
    ta.setAttribute('aria-describedby', 'hint');
    ta.placeholder = 'Paste or drop text here';
    ta.value = pads.get(id)?.text ?? '';
    panel.append(ta);
    editors.set(id, ta);
    return panel;
  }

  // Bring the tab strip and editors in line with `order`.
  function renderTabs() {
    const want = order.filter((id) => pads.has(id));
    // If the open pad goes away, open the one that slides into its place.
    const oldPos = [...tabsEl.children].findIndex((t) => t.dataset.id === activeId);
    for (const [id, ta] of editors) {
      if (want.includes(id)) continue;
      ta.parentElement.remove();
      editors.delete(id);
      $(`tab-${id}`)?.remove();
      dirty.delete(id);
    }
    want.forEach((id, i) => {
      let tab = $(`tab-${id}`);
      if (!tab) {
        tab = makeTab(id);
        editorsEl.insertBefore(makeEditor(id), $('toast'));
      }
      if (tabsEl.children[i] !== tab) tabsEl.insertBefore(tab, tabsEl.children[i] ?? null);
      refreshLabel(id);
    });
    document.body.classList.toggle('single', want.length === 1);
    btn.add.disabled = want.length >= Sync.MAX_PADS;
    if (!want.includes(activeId)) {
      editor = null;
      activeId = null;
      activate(want[Math.min(Math.max(oldPos, 0), want.length - 1)] ?? null, { focus: false });
    }
  }

  function rememberView() {
    if (editor && activeId) views[activeId] = { start: editor.selectionStart, end: editor.selectionEnd, top: editor.scrollTop };
  }

  function activate(id, { focus = true } = {}) {
    if (id === activeId && editor) {
      if (focus && document.activeElement !== editor) {
        const { selectionStart: s, selectionEnd: e, scrollTop } = editor;
        editor.focus({ preventScroll: true });
        editor.setSelectionRange(s, e);
        editor.scrollTop = scrollTop;
      }
      return;
    }
    if (editor) {
      rememberView();
      editor.parentElement.hidden = true;
      const old = $(`tab-${activeId}`);
      if (old) {
        old.setAttribute('aria-selected', 'false');
        old.tabIndex = -1;
      }
    }
    activeId = id;
    editor = id ? editors.get(id) ?? null : null;
    if (!editor) return;
    editor.parentElement.hidden = false;
    const tab = $(`tab-${id}`);
    tab.setAttribute('aria-selected', 'true');
    tab.tabIndex = 0;
    tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const len = editor.value.length;
    const view = views[id];
    if (focus) editor.focus({ preventScroll: true });
    if (view) {
      editor.setSelectionRange(Math.min(view.start ?? len, len), Math.min(view.end ?? len, len));
      editor.scrollTop = view.top ?? 0;
    } else {
      editor.setSelectionRange(len, len);
    }
    refreshCount();
    refreshSyncNote();
    scheduleViewSave();
  }

  async function readIndex() {
    const r = await chrome.storage.local.get(K.index);
    return Sync.readIndex(r[K.index]);
  }

  async function newPad(text = '') {
    if (order.length >= Sync.MAX_PADS) {
      toast(`You can have up to ${Sync.MAX_PADS} pads`);
      return;
    }
    flush();
    const now = Date.now();
    const pad = { id: Sync.newId(), name: '', text, rev: Sync.newRev(now), at: now };
    const idx = await readIndex();
    idx.order = [...idx.order.filter((id) => pads.has(id)), pad.id];
    pads.set(pad.id, pad);
    order = idx.order;
    renderTabs();
    activate(pad.id);
    await write({ [K.index]: idx, [K.pad(pad.id)]: pad, [K.active]: pad.id });
  }

  async function closePad(id) {
    if (!pads.has(id)) return;
    if (id === activeId) stopSpeaking();
    const at = order.indexOf(id);
    const pad = { ...pads.get(id), text: liveText(id) };
    const label = labelOf(id);
    const view = views[id];
    dirty.delete(id);

    const idx = await readIndex();
    idx.order = idx.order.filter((x) => x !== id && pads.has(x));
    idx.deleted = { ...idx.deleted, [id]: Date.now() };
    const items = { [K.index]: idx };
    let fresh = null;
    if (!idx.order.length) {
      // The last pad closes into a new, empty one.
      const now = Date.now();
      fresh = { id: Sync.newId(), name: '', text: '', rev: Sync.newRev(now), at: now };
      idx.order.push(fresh.id);
      items[K.pad(fresh.id)] = fresh;
      pads.set(fresh.id, fresh);
    }
    pads.delete(id);
    delete views[id];
    order = idx.order;
    const wasOpen = activeId === id;
    renderTabs();
    if (wasOpen) editor?.focus({ preventScroll: true });
    items[K.active] = activeId;
    await write(items);
    await chrome.storage.local.remove(K.pad(id));

    if (pad.text.trim()) {
      toast(`Closed “${label}”`, { label: 'Undo', run: () => void restorePad(pad, at, view, fresh) });
    }
  }

  async function restorePad(pad, at, view, fresh) {
    const idx = await readIndex();
    delete idx.deleted[pad.id];
    const now = Date.now();
    const back = { ...pad, rev: Sync.newRev(now), at: now };
    idx.order = idx.order.filter((x) => x !== pad.id);
    // If closing it left a fresh empty pad that's still empty, put it away again.
    const remove = [];
    if (fresh && pads.has(fresh.id) && !liveText(fresh.id).trim() && idx.order.length === 1 && idx.order[0] === fresh.id) {
      idx.order = [];
      pads.delete(fresh.id);
      remove.push(K.pad(fresh.id));
    }
    idx.order.splice(Math.min(at, idx.order.length), 0, pad.id);
    pads.set(pad.id, back);
    if (view) views[pad.id] = view;
    order = idx.order;
    renderTabs();
    activate(pad.id);
    await write({ [K.index]: idx, [K.pad(pad.id)]: back, [K.active]: pad.id });
    if (remove.length) await chrome.storage.local.remove(remove);
  }

  function startRename(id) {
    const tab = $(`tab-${id}`);
    if (!tab || tab.querySelector('.rename')) return;
    activate(id, { focus: false });
    const span = tab.querySelector('.label');
    const current = labelOf(id);
    const input = document.createElement('input');
    input.className = 'rename';
    input.value = current === 'Untitled' ? '' : current;
    input.placeholder = 'Untitled';
    input.maxLength = 60;
    input.setAttribute('aria-label', 'Pad name');
    const fit = () => { input.size = Math.max(6, Math.min(22, input.value.length + 1)); };
    fit();
    span.hidden = true;
    tab.insertBefore(input, span);
    input.focus();
    input.select();

    let done = false;
    const finish = (keep) => {
      if (done) return;
      done = true;
      const value = input.value.trim();
      input.remove();
      span.hidden = false;
      const pad = pads.get(id);
      if (keep && pad) {
        // Typing the automatic name (or nothing) keeps it automatic.
        const name = value === Sync.autoLabel(liveText(id)) ? '' : value;
        if (name !== pad.name) {
          pad.name = name;
          dirty.add(id);
          void save();
        }
      }
      refreshLabel(id);
      if (activeId === id) editor?.focus({ preventScroll: true });
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') finish(true);
      else if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('input', fit);
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('click', (e) => e.stopPropagation());
    input.addEventListener('dblclick', (e) => e.stopPropagation());
  }

  tabsEl.addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (!tab) return;
    if (e.target.closest('.x')) void closePad(tab.dataset.id);
    else activate(tab.dataset.id);
  });
  tabsEl.addEventListener('auxclick', (e) => {
    const tab = e.target.closest('.tab');
    if (tab && e.button === 1) {
      e.preventDefault();
      void closePad(tab.dataset.id);
    }
  });
  tabsEl.addEventListener('mousedown', (e) => {
    if (e.button === 1) e.preventDefault(); // no autoscroll on middle-click
  });
  tabsEl.addEventListener('dblclick', (e) => {
    const tab = e.target.closest('.tab');
    if (tab) startRename(tab.dataset.id);
    else void newPad(); // double-click the empty strip for a new pad, like browser tabs
  });
  tabsEl.addEventListener('keydown', (e) => {
    const tab = e.target.closest('.tab');
    if (!tab || e.target.closest('.rename')) return;
    const i = order.indexOf(tab.dataset.id);
    let to = null;
    if (e.key === 'ArrowRight') to = order[(i + 1) % order.length];
    else if (e.key === 'ArrowLeft') to = order[(i - 1 + order.length) % order.length];
    else if (e.key === 'Home') to = order[0];
    else if (e.key === 'End') to = order[order.length - 1];
    else if (e.key === 'F2') {
      e.preventDefault();
      startRename(tab.dataset.id);
      return;
    } else if (e.key === 'Delete') {
      e.preventDefault();
      void closePad(tab.dataset.id).then(() => $(`tab-${activeId}`)?.focus());
      return;
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      editor?.focus();
      return;
    } else return;
    e.preventDefault();
    activate(to, { focus: false });
    $(`tab-${to}`)?.focus();
  });
  btn.add.addEventListener('click', () => void newPad());
  btn.add.title = 'New pad';

  // ── Sync note ──

  function refreshSyncNote() {
    const s = syncState?.pads?.[activeId];
    const kind = s?.big ? 'big' : s?.remoteBig ? 'remote' : '';
    btn.sync.hidden = !kind;
    btn.sync.dataset.kind = kind;
    btn.sync.title = kind === 'big'
      ? 'This pad is too big to sync, so it’s saved on this computer only. Chrome sync holds about 100 KB for all your pads.'
      : kind === 'remote'
        ? 'This pad got too big to sync on another computer. This is the last copy that reached this one.'
        : '';
  }

  btn.sync.addEventListener('click', () => {
    toast(btn.sync.dataset.kind === 'big' ? 'Too big to sync. Saved on this computer.' : 'Too big to sync from another computer');
  });

  // ── Saving ──

  async function write(items) {
    try {
      await chrome.storage.local.set({ ...items, [K.source]: { id: myId, n: Sync.newRev() } });
      saveFailed = false;
    } catch (err) {
      console.error('Scratcher: save failed', err);
      if (!saveFailed) toast("Couldn't save. The text may be too large.");
      saveFailed = true;
    }
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, SAVE_MS);
  }

  async function save() {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (!dirty.size) return;
    const items = {};
    const now = Date.now();
    for (const id of dirty) {
      const pad = pads.get(id);
      if (!pad) continue;
      pad.text = liveText(id);
      pad.rev = Sync.newRev(now);
      pad.at = now;
      items[K.pad(id)] = { ...pad };
    }
    dirty.clear();
    rememberView();
    items[K.views] = pick(views);
    items[K.active] = activeId;
    await write(items);
  }

  function pick(v) {
    const out = {};
    for (const id of order) if (v[id]) out[id] = v[id];
    return out;
  }

  function flush() {
    if (saveTimer || dirty.size) void save();
  }

  function scheduleViewSave() {
    clearTimeout(viewTimer);
    viewTimer = setTimeout(() => {
      rememberView();
      chrome.storage.local.set({ [K.views]: pick(views), [K.active]: activeId }).catch(() => {});
    }, VIEW_MS);
  }

  // ── Right-click "Send to Scratcher": lands in the open pad ──

  // Runs one at a time, so a snippet is never added twice.
  let inboxQueue = Promise.resolve();
  function takeInbox() {
    inboxQueue = inboxQueue.then(drainInbox).catch((err) => console.error('Scratcher: inbox', err));
    return inboxQueue;
  }

  async function drainInbox() {
    if (!editor) return;
    const r = await chrome.storage.local.get(INBOX_KEY);
    const inbox = Array.isArray(r[INBOX_KEY]) ? r[INBOX_KEY] : [];
    const mine = inbox.filter((item) => item.windowId == null || item.windowId === windowId);
    if (!mine.length) return;
    const rest = inbox.filter((item) => !mine.includes(item));
    await chrome.storage.local.set({ [INBOX_KEY]: rest });
    for (const item of mine) {
      const text = tidy(String(item.text ?? ''));
      if (text) insert(text, { atEnd: true });
    }
    const where = order.length > 1 ? ` to “${labelOf(activeId)}”` : ' from the page';
    toast(mine.length === 1 ? `Added${where}` : `Added ${mine.length} snippets`);
  }

  // ── Changes from another open panel, or from sync ──

  let indexFetch = Promise.resolve();

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !ready) return;
    if (changes[INBOX_KEY]?.newValue?.length) void takeInbox();
    if (changes[K.state]) {
      syncState = changes[K.state].newValue ?? { pads: {} };
      refreshSyncNote();
    }
    if (changes[K.source]?.newValue?.id === myId) return;

    for (const [key, ch] of Object.entries(changes)) {
      if (!key.startsWith('pad:') || !ch.newValue) continue;
      const id = key.slice(4);
      if (dirty.has(id)) continue; // our own pending edit wins
      const pad = { ...ch.newValue };
      pads.set(id, pad);
      const ta = editors.get(id);
      if (ta && ta.value !== pad.text) {
        const { selectionStart: s, selectionEnd: e, scrollTop } = ta;
        ta.value = pad.text;
        ta.setSelectionRange(Math.min(s, pad.text.length), Math.min(e, pad.text.length));
        ta.scrollTop = scrollTop;
        if (id === activeId) refreshCount();
      }
      refreshLabel(id);
    }

    if (changes[K.index]?.newValue) {
      const idx = Sync.readIndex(changes[K.index].newValue);
      indexFetch = indexFetch.then(async () => {
        const missing = idx.order.filter((id) => !pads.has(id));
        if (missing.length) {
          const got = await chrome.storage.local.get(missing.map(K.pad));
          for (const id of missing) if (got[K.pad(id)]) pads.set(id, { ...got[K.pad(id)] });
        }
        for (const id of [...pads.keys()]) if (!idx.order.includes(id)) pads.delete(id);
        order = idx.order.filter((id) => pads.has(id));
        renderTabs();
      }).catch((err) => console.error('Scratcher: tabs', err));
    }
  });

  // ── Paste ──

  let rawPaste = false;

  editorsEl.addEventListener('paste', (e) => {
    if (e.target !== editor) return;
    const data = e.clipboardData;
    if (!data) return;
    const text = data.getData('text/plain');
    if (!text) {
      if (data.files?.length) {
        e.preventDefault();
        toast('Only text can go here');
      }
      return;
    }
    e.preventDefault();
    insert(rawPaste ? text : tidy(text));
    rawPaste = false;
  });

  // ── Drop ──

  let dragDepth = 0;

  async function readFiles(files) {
    const parts = [];
    const skipped = [];
    for (const file of files) {
      if (file.type.startsWith('text/') || /json|xml|javascript/.test(file.type) || TEXT_FILE.test(file.name)) {
        parts.push(tidy(await file.text()));
      } else {
        skipped.push(file.name);
      }
    }
    if (skipped.length) {
      toast(skipped.length === 1 ? `Skipped ${skipped[0]}, it isn't text` : `Skipped ${skipped.length} files that aren't text`);
    }
    return parts.filter(Boolean).join('\n\n');
  }

  window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragDepth += 1;
    document.body.classList.add('dragging');
  });
  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) document.body.classList.remove('dragging');
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', async (e) => {
    dragDepth = 0;
    document.body.classList.remove('dragging');
    const dt = e.dataTransfer;
    if (!dt || !editor) return;
    const files = [...(dt.files ?? [])];

    if (files.length) {
      e.preventDefault();
      const text = await readFiles(files);
      if (text) insert(text, { block: true, atEnd: document.activeElement !== editor });
      return;
    }

    // Text dropped right on the editor lands where it's dropped; elsewhere it's appended.
    if (e.target === editor) return;
    e.preventDefault();
    const text = tidy(dt.getData('text/plain') || dt.getData('text/uri-list') || '');
    if (text) insert(text, { atEnd: true });
  });

  // ── Copy and clear ──

  async function copy() {
    const sel = selectedText();
    const text = sel || editor.value;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Clipboard API can refuse without focus; fall back to the old way.
      const { selectionStart: s, selectionEnd: e } = editor;
      editor.focus();
      if (!sel) editor.select();
      document.execCommand('copy');
      editor.setSelectionRange(s, e);
    }
    toast(sel ? 'Copied selection' : 'Copied');
  }

  function clearAll() {
    if (!editor.value) return;
    stopSpeaking();
    const previous = editor.value;
    const id = activeId;
    editor.focus();
    editor.select();
    if (!document.execCommand('delete')) {
      editor.value = '';
      editor.dispatchEvent(new Event('input', { bubbles: true }));
    }
    toast('Cleared', {
      label: 'Undo',
      run: () => {
        if (!editors.has(id)) return;
        activate(id);
        if (editor.value) insert(previous, { atEnd: true });
        else insert(previous);
        editor.setSelectionRange(0, 0);
        editor.scrollTop = 0;
      },
    });
  }

  // ── Read aloud ──

  let speaking = false;
  let voice = null;

  function pickVoice() {
    const voices = speechSynthesis.getVoices();
    if (!voices.length) return;
    const lang = (navigator.language || 'en-US').toLowerCase();
    const base = lang.split('-')[0];
    const score = (v) => {
      const l = v.lang.toLowerCase();
      let s = 0;
      if (l === lang) s += 4;
      else if (l.startsWith(base)) s += 2;
      else return -1;
      if (/premium|enhanced|neural|natural/i.test(v.name)) s += 3;
      if (v.default) s += 1;
      if (v.localService) s += 1;
      return s;
    };
    let best = null;
    let bestScore = -1;
    for (const v of voices) {
      const s = score(v);
      if (s > bestScore) {
        best = v;
        bestScore = s;
      }
    }
    voice = best;
  }

  speechSynthesis.addEventListener?.('voiceschanged', pickVoice);

  function chunk(text) {
    // Long utterances can stall in Chromium, so speak sentence-sized pieces.
    const pieces = text.match(/[^.!?\n]+[.!?]*["'”’)\]]*\s*|\n+/g) ?? [text];
    const out = [];
    let buf = '';
    for (const p of pieces) {
      if ((buf + p).length > 220 && buf) {
        out.push(buf);
        buf = '';
      }
      buf += p;
    }
    if (buf.trim()) out.push(buf);
    return out.filter((s) => s.trim());
  }

  function setSpeaking(on) {
    speaking = on;
    btn.speak.setAttribute('aria-pressed', String(on));
    btn.speak.setAttribute('aria-label', on ? 'Stop reading' : 'Read aloud');
    btn.speak.title = on ? 'Stop (Esc)' : `Read aloud (${MOD}${SHIFT}L)`;
    if (!on) refreshCount();
  }

  function stopSpeaking() {
    if (!speaking) return;
    speechSynthesis.cancel();
    setSpeaking(false);
  }

  function toggleSpeak() {
    if (speaking) {
      stopSpeaking();
      return;
    }
    const sel = selectedText();
    const text = sel.trim() ? sel : editor.value;
    if (!text.trim()) return;
    if (!voice) pickVoice();

    const parts = chunk(text);
    speechSynthesis.cancel();
    setSpeaking(true);
    parts.forEach((part, i) => {
      const u = new SpeechSynthesisUtterance(part);
      if (voice) {
        u.voice = voice;
        u.lang = voice.lang;
      }
      if (i === parts.length - 1) u.onend = () => setSpeaking(false);
      u.onerror = (ev) => {
        if (ev.error !== 'interrupted' && ev.error !== 'canceled') {
          speechSynthesis.cancel();
          setSpeaking(false);
          toast("Couldn't read this aloud");
        }
      };
      speechSynthesis.speak(u);
    });
  }

  // ── Closing from the shortcut ──

  function connect() {
    try {
      const port = chrome.runtime.connect({ name: 'panel' });
      port.postMessage({ windowId });
      port.onMessage.addListener((msg) => {
        if (msg?.type === 'close') {
          flush();
          window.close();
        }
      });
      // The service worker can restart; register again when it does.
      port.onDisconnect.addListener(() => setTimeout(connect, 250));
    } catch {
      // Extension reloaded under us; nothing to reconnect to.
    }
  }

  // ── Wiring ──

  editorsEl.addEventListener('input', (e) => {
    const id = e.target.dataset?.id;
    if (!id) return;
    dirty.add(id);
    if (id === activeId) refreshCount();
    scheduleSave();
  });
  editorsEl.addEventListener('select', refreshCount);
  document.addEventListener('selectionchange', refreshCount);
  editorsEl.addEventListener('scroll', scheduleViewSave, { passive: true, capture: true });
  editorsEl.addEventListener('keyup', scheduleViewSave);
  editorsEl.addEventListener('mouseup', scheduleViewSave);
  editorsEl.addEventListener('focusout', flush);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
  window.addEventListener('pagehide', () => {
    flush();
    if (speaking) speechSynthesis.cancel();
  });

  btn.speak.addEventListener('click', toggleSpeak);
  btn.copy.addEventListener('click', copy);
  btn.clear.addEventListener('click', clearAll);

  btn.copy.setAttribute('aria-label', 'Copy');
  btn.copy.title = `Copy all, or the selection (${MOD}${SHIFT}↩)`;
  btn.clear.setAttribute('aria-label', 'Clear');
  btn.clear.title = `Clear (${MOD}${SHIFT}⌫)`;
  setSpeaking(false);

  window.addEventListener('keydown', (e) => {
    if (e.isComposing || !editor) return;
    const mod = isMac ? e.metaKey : e.ctrlKey;
    if (mod && e.shiftKey && e.code === 'KeyV') {
      rawPaste = true; // Paste exactly as copied, no cleanup.
      setTimeout(() => { rawPaste = false; }, 500);
    } else if (mod && e.shiftKey && e.key === 'Enter') {
      e.preventDefault();
      void copy();
    } else if (mod && e.shiftKey && e.code === 'KeyL') {
      e.preventDefault();
      toggleSpeak();
    } else if (mod && e.shiftKey && e.key === 'Backspace') {
      e.preventDefault();
      clearAll();
    } else if (e.key === 'Escape') {
      if (speaking) stopSpeaking();
      else if (!$('toast').hidden) hideToast();
    }
  });

  // ── Start ──

  async function start() {
    await Sync.migrate(chrome.storage.local);
    const [all, win] = await Promise.all([
      chrome.storage.local.get(null),
      chrome.windows?.getCurrent?.().catch(() => null),
    ]);
    windowId = win?.id ?? null;
    for (const pad of Object.values(Sync.readPads(all))) pads.set(pad.id, pad);
    const index = Sync.readIndex(all[K.index]);
    order = index.order.filter((id) => pads.has(id));
    if (!order.length) {
      const now = Date.now();
      const pad = { id: Sync.newId(), name: '', text: '', rev: Sync.newRev(now), at: now };
      pads.set(pad.id, pad);
      order = [pad.id];
      await write({ [K.index]: { order, deleted: index.deleted }, [K.pad(pad.id)]: pad });
    }
    views = all[K.views] && typeof all[K.views] === 'object' ? all[K.views] : {};
    syncState = all[K.state] ?? { pads: {} };
    ready = true;
    renderTabs();
    activate(order.includes(all[K.active]) ? all[K.active] : order[0]);
    document.body.classList.remove('loading');
    connect();
    await takeInbox();
  }

  start().catch((err) => {
    document.body.classList.remove('loading');
    console.error('Scratcher: start failed', err);
  });
})();
