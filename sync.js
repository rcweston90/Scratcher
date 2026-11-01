// Scratcher pads and sync.
//
// The panel reads and writes pads in chrome.storage.local, so typing never
// waits on anything. The service worker mirrors them to chrome.storage.sync,
// which the browser itself syncs to the user's account and their other
// computers. Scratcher has no server and makes no network requests.
//
// Local storage (this computer):
//   pads          { order: [id], deleted: { id: time } }
//   pad:<id>      { id, name, text, rev, at }
//   syncstate     { joined, pads: { id: { base, big, remoteBig } } }
//
// Sync storage (Chrome sync, about 100 KB in all, 8 KB per item):
//   i             { o: [id], d: { id: time } }
//   m:<id>        { n: name, r: rev, a: time, c: chunk count, x: 1 if too big }
//   c:<id>:<k>    [rev, text]  each chunk carries its rev, so a pad whose
//                 chunks arrive from different edits is never stitched together.
//
// A pad edited on two computers before either synced keeps both versions: the
// incoming one takes the pad, this computer's text becomes a "(copy)" pad.
(function (root) {
  'use strict';

  const QUOTA_BYTES = 102400; // chrome.storage.sync.QUOTA_BYTES
  const QUOTA_BYTES_PER_ITEM = 8192; // chrome.storage.sync.QUOTA_BYTES_PER_ITEM
  const BUDGET = QUOTA_BYTES - 4096; // headroom for rounding and the index
  const ITEM_HEADROOM = 96;
  const TOMBSTONE_MS = 30 * 24 * 3600 * 1000;
  const MAX_PADS = 30;
  const LEGACY_ID = 'legacy';

  const K = {
    index: 'pads',
    pad: (id) => `pad:${id}`,
    state: 'syncstate',
    source: '__source',
    views: 'views',
    active: 'active',
  };
  const S = {
    index: 'i',
    meta: (id) => `m:${id}`,
    chunk: (id, k) => `c:${id}:${k}`,
  };

  const newId = () => Math.random().toString(36).slice(2, 10).padEnd(8, '0');
  const newRev = (now = Date.now()) => `${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

  // ── Labels ──

  function autoLabel(text) {
    const line = String(text ?? '').split('\n').find((l) => l.trim()) ?? '';
    return line.trim().replace(/\s+/g, ' ').slice(0, 40);
  }

  function padLabel(pad) {
    return (pad?.name ?? '').trim() || autoLabel(pad?.text) || 'Untitled';
  }

  // ── Sizes, as Chrome counts them: key length plus the value's JSON in UTF-8.
  // Chrome's JSON writer also escapes < > & and U+2028/2029, so those count 6.

  function charCost(cp, inString) {
    if (inString) {
      if (cp === 0x22 || cp === 0x5c) return 2;
      if (cp === 0x08 || cp === 0x09 || cp === 0x0a || cp === 0x0c || cp === 0x0d) return 2;
      if (cp < 0x20) return 6;
      if (cp >= 0xd800 && cp <= 0xdfff) return 6; // lone surrogate
    }
    if (cp === 0x3c || cp === 0x3e || cp === 0x26 || cp === 0x7f || cp === 0x2028 || cp === 0x2029) return 6;
    if (cp < 0x80) return 1;
    if (cp < 0x800) return 2;
    if (cp < 0x10000) return 3;
    return 4;
  }

  function jsonBytes(value) {
    let n = 0;
    for (const ch of JSON.stringify(value)) n += charCost(ch.codePointAt(0), false);
    return n;
  }

  const itemBytes = (key, value) => key.length + jsonBytes(value);

  // Split text into pieces that each fit one sync item, never inside a character.
  function chunkText(text, maxBytes) {
    const chunks = [];
    let start = 0;
    let used = 0;
    let i = 0;
    while (i < text.length) {
      const cp = text.codePointAt(i);
      const width = cp > 0xffff ? 2 : 1;
      const cost = charCost(cp, true);
      if (used + cost > maxBytes && i > start) {
        chunks.push(text.slice(start, i));
        start = i;
        used = 0;
      }
      used += cost;
      i += width;
    }
    if (i > start || chunks.length === 0) chunks.push(text.slice(start));
    return chunks;
  }

  function chunkBudget(id, rev) {
    // c:<id>:<k> with k up to 99, plus ["<rev>",""]
    return QUOTA_BYTES_PER_ITEM - S.chunk(id, 99).length - rev.length - 6 - ITEM_HEADROOM;
  }

  // ── Normalising what storage hands back ──

  function readIndex(v, orderKey = 'order', deletedKey = 'deleted') {
    const order = Array.isArray(v?.[orderKey]) ? v[orderKey].filter((id) => typeof id === 'string') : [];
    const deleted = v && typeof v[deletedKey] === 'object' && v[deletedKey] ? { ...v[deletedKey] } : {};
    return { order: [...new Set(order)], deleted };
  }

  function readPads(all) {
    const pads = {};
    for (const [key, v] of Object.entries(all)) {
      if (!key.startsWith('pad:') || !v || typeof v !== 'object') continue;
      const id = key.slice(4);
      pads[id] = {
        id,
        name: typeof v.name === 'string' ? v.name : '',
        text: typeof v.text === 'string' ? v.text : '',
        rev: typeof v.rev === 'string' ? v.rev : '',
        at: Number(v.at) || 0,
      };
    }
    return pads;
  }

  function readRemotePad(rem, id) {
    const meta = rem[S.meta(id)];
    if (!meta || typeof meta !== 'object' || typeof meta.r !== 'string') return null;
    const h = Array.isArray(meta.h) ? meta.h.filter((x) => typeof x === 'string') : [];
    const base = { id, rev: meta.r, h, name: typeof meta.n === 'string' ? meta.n : '', at: Number(meta.a) || 0 };
    if (meta.x) return { ...base, big: true };
    const parts = [];
    const count = Number(meta.c) || 0;
    for (let k = 0; k < count; k++) {
      const c = rem[S.chunk(id, k)];
      if (!Array.isArray(c) || c[0] !== meta.r || typeof c[1] !== 'string') return { ...base, incomplete: true };
      parts.push(c[1]);
    }
    return { ...base, text: parts.join('') };
  }

  // ── First run of tabs: the single pad from 0.5 becomes the first tab ──

  async function migrate(local) {
    const all = await local.get(null);
    if (all[K.index]) return false;
    const pads = readPads(all);
    const order = Object.keys(pads);
    const write = {};
    if (!order.length) {
      const text = typeof all.text === 'string' ? all.text : '';
      const now = Date.now();
      write[K.pad(LEGACY_ID)] = { id: LEGACY_ID, name: '', text, rev: newRev(now), at: now };
      order.push(LEGACY_ID);
      if (all.view && typeof all.view === 'object') write[K.views] = { [LEGACY_ID]: all.view };
      write[K.active] = LEGACY_ID;
    }
    write[K.index] = { order, deleted: {} };
    await local.set(write);
    await local.remove(['text', 'view']);
    return true;
  }

  // ── Reconcile: pull what changed elsewhere, then push what changed here ──
  //
  // api.local / api.sync: { get(keys), set(items), remove(keys) } returning promises.
  // Returns a summary for logging and tests.

  async function reconcile(api, { now = Date.now(), budget = BUDGET } = {}) {
    await migrate(api.local);
    const [loc, rem] = await Promise.all([api.local.get(null), api.sync.get(null)]);

    const localIndex = readIndex(loc[K.index]);
    const remoteIndex = readIndex(rem[S.index], 'o', 'd');
    const pads = readPads(loc);
    const readRevs = Object.fromEntries(Object.values(pads).map((p) => [p.id, p.rev]));
    const state = loc[K.state] && typeof loc[K.state] === 'object' ? loc[K.state] : {};
    const st = {};
    for (const [id, s] of Object.entries(state.pads ?? {})) st[id] = { ...s };
    let joined = Boolean(state.joined);

    const summary = { pulled: [], added: [], removedHere: [], conflicts: [], pushed: [], big: [], removedThere: 0, incomplete: [], wrote: { local: false, sync: false } };
    const localSet = {};
    const localRemove = new Set();
    const setPad = (p) => {
      pads[p.id] = p;
      localSet[K.pad(p.id)] = p;
      localRemove.delete(K.pad(p.id));
    };
    const dropPad = (id) => {
      delete pads[id];
      delete st[id];
      delete localSet[K.pad(id)];
      localRemove.add(K.pad(id));
    };

    // Tombstones from both sides; old ones expire.
    const deleted = { ...localIndex.deleted };
    for (const [id, t] of Object.entries(remoteIndex.deleted)) deleted[id] = Math.max(Number(deleted[id]) || 0, Number(t) || 0);
    for (const [id, t] of Object.entries(deleted)) if (now - t > TOMBSTONE_MS) delete deleted[id];

    // Order: the synced order first, so every computer settles on the same one,
    // then pads only this computer has.
    let order = remoteIndex.order.filter((id) => pads[id]);
    for (const id of localIndex.order) if (pads[id] && !order.includes(id)) order.push(id);
    for (const id of Object.keys(pads)) if (!order.includes(id) && !(id in deleted)) order.push(id);
    // Pads in sync that this computer leaves alone this round: too big to show
    // here, or still arriving.
    const keepRemote = new Set();

    // Joining sync for the first time: an empty, unnamed pad here makes way for
    // the pads already in sync, so a new computer doesn't add a blank tab.
    const remoteIds = remoteIndex.order.filter((id) => rem[S.meta(id)]);
    if (!joined && remoteIds.length) {
      for (const id of [...order]) {
        const p = pads[id];
        if (!st[id] && !p.text.trim() && !p.name.trim() && !remoteIds.includes(id)) {
          dropPad(id);
          order = order.filter((x) => x !== id);
        }
      }
    }

    // Pull.
    for (const id of remoteIds) {
      const r = readRemotePad(rem, id);
      if (!r) continue;
      if (r.incomplete) {
        summary.incomplete.push(id);
        keepRemote.add(id);
        continue;
      }
      const p = pads[id];
      const s = (st[id] ??= {});

      if (!p) {
        if (id in deleted && !(r.at > deleted[id])) continue; // deleted here; that wins
        if (r.big) {
          keepRemote.add(id); // only the computer that has it can show it
          continue;
        }
        delete deleted[id];
        setPad({ id, name: r.name, text: r.text, rev: r.rev, at: r.at });
        st[id] = { base: r.rev, h: r.h };
        if (!order.includes(id)) order.push(id);
        summary.added.push(id);
        continue;
      }

      if (s.base === r.rev) continue; // nothing new over there
      if (r.rev === p.rev) {
        s.base = r.rev;
        s.h = r.h;
        continue;
      }

      const clean = s.base !== undefined && p.rev === s.base && !s.big;
      // Was their version made on top of the one this computer last synced?
      const descends = s.base !== undefined && r.h.includes(s.base);

      if (r.big) {
        // Another computer has a version too big to sync. Keep ours; don't push
        // over it unless it's edited here.
        s.base = r.rev;
        s.h = r.h;
        s.mine = false;
        s.remoteBig = true;
        if (clean) setPad({ ...p, rev: r.rev });
        continue;
      }

      // Take theirs when nothing here would be lost: this pad wasn't edited
      // since it last synced and their version builds on it (or someone else
      // wrote what it last held), or it's blank, or the text is the same.
      const blank = !p.text.trim() && !p.name.trim();
      const fastForward = clean && (descends || !s.mine);
      if (fastForward || blank || p.text === r.text) {
        const name = fastForward || blank ? r.name : p.name;
        const same = name === r.name;
        setPad({ id, name, text: r.text, rev: same ? r.rev : p.rev, at: same ? r.at : Math.max(p.at, r.at, now) });
        st[id] = { base: r.rev, h: r.h };
        summary.pulled.push(id);
        continue;
      }

      // Edited in both places: keep both.
      const copyId = newId();
      setPad({ id: copyId, name: `${padLabel(p)} (copy)`, text: p.text, rev: newRev(now), at: now });
      order.splice(order.indexOf(id) + 1, 0, copyId);
      setPad({ id, name: r.name, text: r.text, rev: r.rev, at: r.at });
      st[id] = { base: r.rev, h: r.h };
      summary.conflicts.push({ id, copyId });
    }

    // Deleted elsewhere: drop it here, unless it was edited here afterwards.
    for (const id of [...order]) {
      if (!(id in deleted)) continue;
      const p = pads[id];
      if (p && p.at > deleted[id]) {
        delete deleted[id];
        continue;
      }
      dropPad(id);
      order = order.filter((x) => x !== id);
      summary.removedHere.push(id);
    }

    if (!order.length) {
      // Never leave this computer without a pad.
      const id = newId();
      setPad({ id, name: '', text: '', rev: newRev(now), at: now });
      order.push(id);
    }

    for (const id of Object.keys(st)) if (!pads[id]) delete st[id];

    // Write what was pulled, unless the panel saved over those pads meanwhile.
    const indexChanged = JSON.stringify(localIndex) !== JSON.stringify({ order, deleted });
    if (Object.keys(localSet).length || localRemove.size || indexChanged) {
      const fresh = await api.local.get(null);
      const freshPads = readPads(fresh);
      const moved = JSON.stringify(readIndex(fresh[K.index])) !== JSON.stringify(localIndex)
        || Object.keys(freshPads).length !== Object.keys(readRevs).length
        || Object.entries(readRevs).some(([id, rev]) => freshPads[id]?.rev !== rev);
      if (moved) return { ...summary, retry: true }; // the panel saved meanwhile; go again shortly
      await api.local.set({
        ...localSet,
        [K.index]: { order, deleted },
        [K.state]: { joined, pads: st },
        [K.source]: { id: 'sync', n: newRev(now) },
      });
      if (localRemove.size) await api.local.remove([...localRemove]);
      summary.wrote.local = true;
    }

    // Push: lay out every pad in tab order until the space runs out. A pad that
    // doesn't fit is marked too big and stays on this computer.
    const want = {};
    want[S.index] = { o: [], d: deleted };
    let used = itemBytes(S.index, { o: order, d: deleted });
    const keep = (id) => {
      for (const [key, v] of Object.entries(rem)) {
        if (key === S.meta(id) || key.startsWith(`c:${id}:`)) {
          want[key] = v;
          used += itemBytes(key, v);
        }
      }
      want[S.index].o.push(id);
    };
    for (const id of [...order, ...remoteIds.filter((id) => !order.includes(id))]) {
      if (keepRemote.has(id)) {
        keep(id);
        continue;
      }
      if (!pads[id]) continue;
      const p = pads[id];
      const s = (st[id] ??= {});
      const clean = s.base !== undefined && p.rev === s.base;
      const metaKey = S.meta(id);

      if (s.remoteBig && clean && rem[metaKey]?.x) {
        want[metaKey] = rem[metaKey];
        used += itemBytes(metaKey, rem[metaKey]);
        want[S.index].o.push(id);
        continue;
      }

      // The revs this one was built on, so other computers can tell an edit
      // made on top of theirs from one made at the same time.
      const h = clean ? (s.h ?? []) : [s.base, ...(s.h ?? [])].filter(Boolean).slice(0, 20);
      const chunks = chunkText(p.text, chunkBudget(id, p.rev));
      const meta = { n: p.name, r: p.rev, a: p.at, c: chunks.length, h };
      let size = itemBytes(metaKey, meta);
      chunks.forEach((c, k) => { size += itemBytes(S.chunk(id, k), [p.rev, c]); });

      if (used + size <= budget) {
        used += size;
        want[metaKey] = meta;
        chunks.forEach((c, k) => { want[S.chunk(id, k)] = [p.rev, c]; });
        s.big = false;
      } else {
        const marker = { n: p.name, r: p.rev, a: p.at, c: 0, h, x: 1 };
        used += itemBytes(metaKey, marker);
        want[metaKey] = marker;
        s.big = true;
        summary.big.push(id);
      }
      want[S.index].o.push(id);
    }

    const set = {};
    for (const [key, v] of Object.entries(want)) {
      if (JSON.stringify(rem[key]) !== JSON.stringify(v)) set[key] = v;
    }
    const remove = Object.keys(rem).filter((key) => /^[mc]:/.test(key) && !(key in want));
    summary.removedThere = remove.length;

    if (remove.length) await api.sync.remove(remove);
    if (Object.keys(set).length) await api.sync.set(set);
    summary.wrote.sync = Boolean(remove.length || Object.keys(set).length);

    for (const id of order) {
      const s = st[id];
      if (!s) continue;
      if (set[S.meta(id)] || set[S.chunk(id, 0)]) {
        s.base = pads[id].rev;
        s.h = want[S.meta(id)].h;
        s.mine = true;
        if (!s.big) s.remoteBig = false;
        summary.pushed.push(id);
      } else if (!keepRemote.has(id) && rem[S.meta(id)]?.r === pads[id].rev && JSON.stringify(rem[S.meta(id)]) === JSON.stringify(want[S.meta(id)])) {
        s.base = pads[id].rev;
        s.h = want[S.meta(id)].h;
      }
    }
    joined = true;

    const nextState = { joined, pads: st };
    if (JSON.stringify(nextState) !== JSON.stringify(loc[K.state] ?? null) || summary.wrote.local) {
      await api.local.set({ [K.state]: nextState });
    }
    return summary;
  }

  // ── Service-worker side: run reconcile after changes, one at a time ──

  function createEngine(api, { log = console } = {}) {
    let timer = null;
    let firstAt = 0;
    let running = null;
    let again = false;
    let pausedUntil = 0;

    function schedule(delay, maxWait = 10000) {
      const now = Date.now();
      if (!timer) firstAt = now;
      clearTimeout(timer);
      const wait = Math.max(Math.min(delay, firstAt + maxWait - now), pausedUntil - now, 0);
      timer = setTimeout(run, wait);
    }

    async function run() {
      timer = null;
      if (running) {
        again = true;
        return running;
      }
      running = (async () => {
        try {
          const result = await reconcile(api);
          if (result.retry || result.incomplete.length) schedule(1500);
        } catch (err) {
          const msg = String(err?.message ?? err);
          if (/MAX_WRITE_OPERATIONS_PER_HOUR/.test(msg)) pausedUntil = Date.now() + 10 * 60 * 1000;
          else if (/MAX_WRITE_OPERATIONS_PER_MINUTE/.test(msg)) pausedUntil = Date.now() + 61 * 1000;
          else pausedUntil = Date.now() + 30 * 1000;
          log.warn?.('Scratcher sync: will retry', msg);
          schedule(0);
        }
      })();
      await running;
      running = null;
      if (again) {
        again = false;
        schedule(500);
      }
    }

    // Local edits wait for a pause in typing; changes from sync come in quickly.
    function onChanged(changes, area) {
      if (area === 'sync') {
        if (Object.keys(changes).some((k) => k === S.index || /^[mc]:/.test(k))) schedule(400, 2000);
        return;
      }
      if (area !== 'local') return;
      if (changes[K.source]?.newValue?.id === 'sync') return;
      if (Object.keys(changes).some((k) => k === K.index || k.startsWith('pad:'))) schedule(2000, 10000);
    }

    return { schedule, run, onChanged };
  }

  const api = {
    K, S, BUDGET, QUOTA_BYTES, QUOTA_BYTES_PER_ITEM, MAX_PADS, LEGACY_ID,
    newId, newRev, autoLabel, padLabel, jsonBytes, itemBytes, chunkText, chunkBudget,
    readIndex, readPads, readRemotePad, migrate, reconcile, createEngine,
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ScratcherSync = api;
})(typeof self !== 'undefined' ? self : globalThis);
