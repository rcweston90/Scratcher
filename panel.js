// Scratcher: a plain text pad in the browser's side panel.
// Saving follows NewTabPad by Norikazu Kato (MIT): debounced writes to
// chrome.storage.local, kept in step across open panels.
(() => {
  'use strict';

  const TEXT_KEY = 'text';
  const SOURCE_KEY = '__source';
  const VIEW_KEY = 'view';
  const INBOX_KEY = 'inbox';
  const SAVE_MS = 150;
  const VIEW_MS = 400;
  const TEXT_FILE = /\.(txt|text|md|markdown|mdx|csv|tsv|json|jsonl|ya?ml|toml|ini|xml|html?|css|js|mjs|ts|tsx|jsx|py|rb|go|rs|sh|sql|log|srt|vtt|tex)$/i;
  const isMac = /mac/i.test(navigator.userAgentData?.platform ?? navigator.platform);
  const MOD = isMac ? '⌘' : 'Ctrl+';
  const SHIFT = isMac ? '⇧' : 'Shift+';
  const myId = crypto.randomUUID();

  const $ = (id) => document.getElementById(id);
  const editor = $('editor');
  const btn = { speak: $('speakBtn'), copy: $('copyBtn'), clear: $('clearBtn') };

  let windowId = null;
  let saveTimer = null;
  let viewTimer = null;
  let saveFailed = false;

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
      editor.dispatchEvent(new Event('input'));
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
    toastTimer = setTimeout(hideToast, action ? 6000 : 1600);
  }

  function hideToast() {
    clearTimeout(toastTimer);
    $('toast').hidden = true;
  }

  // ── Saving ──

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, SAVE_MS);
  }

  async function save() {
    clearTimeout(saveTimer);
    saveTimer = null;
    try {
      await chrome.storage.local.set({
        [TEXT_KEY]: editor.value,
        [SOURCE_KEY]: { id: myId, at: Date.now() },
        [VIEW_KEY]: viewState(),
      });
      saveFailed = false;
    } catch (err) {
      console.error('Scratcher: save failed', err);
      if (!saveFailed) toast("Couldn't save. The text may be too large.");
      saveFailed = true;
    }
  }

  function flush() {
    if (saveTimer) void save();
  }

  function viewState() {
    return { start: editor.selectionStart, end: editor.selectionEnd, top: editor.scrollTop };
  }

  function scheduleViewSave() {
    clearTimeout(viewTimer);
    viewTimer = setTimeout(() => {
      chrome.storage.local.set({ [VIEW_KEY]: viewState() }).catch(() => {});
    }, VIEW_MS);
  }

  // ── Right-click "Send to Scratcher" ──

  // Runs one at a time, so a snippet is never added twice.
  let inboxQueue = Promise.resolve();
  function takeInbox() {
    inboxQueue = inboxQueue.then(drainInbox).catch((err) => console.error('Scratcher: inbox', err));
    return inboxQueue;
  }

  async function drainInbox() {
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
    toast(mine.length === 1 ? 'Added from the page' : `Added ${mine.length} snippets`);
  }

  // ── Another open panel (another window) changed the text ──

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[INBOX_KEY]?.newValue?.length) void takeInbox();
    if (!changes[TEXT_KEY]) return;
    if (changes[SOURCE_KEY]?.newValue?.id === myId) return;
    if (saveTimer) return; // Our own pending edit wins.
    const { selectionStart: s, selectionEnd: e } = editor;
    editor.value = changes[TEXT_KEY].newValue ?? '';
    editor.setSelectionRange(Math.min(s, editor.value.length), Math.min(e, editor.value.length));
    refreshCount();
  });

  // ── Paste ──

  let rawPaste = false;

  editor.addEventListener('paste', (e) => {
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
    if (!dt) return;
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
    editor.focus();
    editor.select();
    if (!document.execCommand('delete')) {
      editor.value = '';
      editor.dispatchEvent(new Event('input'));
    }
    toast('Cleared', {
      label: 'Undo',
      run: () => {
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

  editor.addEventListener('input', () => {
    refreshCount();
    scheduleSave();
  });
  editor.addEventListener('select', refreshCount);
  document.addEventListener('selectionchange', refreshCount);
  editor.addEventListener('scroll', scheduleViewSave, { passive: true });
  editor.addEventListener('keyup', scheduleViewSave);
  editor.addEventListener('mouseup', scheduleViewSave);
  editor.addEventListener('blur', flush);
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
    if (e.isComposing) return;
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
    const [stored, win] = await Promise.all([
      chrome.storage.local.get([TEXT_KEY, VIEW_KEY]),
      chrome.windows?.getCurrent?.().catch(() => null),
    ]);
    windowId = win?.id ?? null;
    editor.value = stored[TEXT_KEY] ?? '';
    const view = stored[VIEW_KEY];
    const len = editor.value.length;
    editor.focus({ preventScroll: true });
    if (view) {
      editor.setSelectionRange(Math.min(view.start ?? len, len), Math.min(view.end ?? len, len));
      editor.scrollTop = view.top ?? 0;
    } else {
      editor.setSelectionRange(len, len);
    }
    document.body.classList.remove('loading');
    refreshCount();
    connect();
    await takeInbox();
  }

  start().catch((err) => {
    document.body.classList.remove('loading');
    console.error('Scratcher: start failed', err);
  });
})();
