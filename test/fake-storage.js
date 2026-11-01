// In-memory stand-ins for chrome.storage areas, with Chrome sync's quotas,
// and a "cloud" that copies sync changes between computers.
'use strict';
const { itemBytes } = require('../sync.js');

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

function area({ quota = Infinity, perItem = Infinity, perMinute = Infinity, name = 'local' } = {}) {
  const data = {};
  const listeners = [];
  const a = {
    data, writes: 0, name,
    onChanged: (fn) => listeners.push(fn),
    async get(keys) {
      if (keys == null) return clone(data);
      const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
      const out = {};
      for (const k of list) if (k in data) out[k] = clone(data[k]);
      return out;
    },
    async set(items, { silent = false, remote = false } = {}) {
      if (!remote) {
        a.writes += 1;
        if (a.writes > perMinute) throw new Error('This request exceeds the MAX_WRITE_OPERATIONS_PER_MINUTE quota.');
        for (const [k, v] of Object.entries(items)) {
          if (itemBytes(k, v) > perItem) throw new Error(`QUOTA_BYTES_PER_ITEM quota exceeded (${k} ${itemBytes(k, v)})`);
        }
        const next = { ...data, ...items };
        const total = Object.entries(next).reduce((n, [k, v]) => n + itemBytes(k, v), 0);
        if (total > quota) throw new Error(`QUOTA_BYTES quota exceeded (${total})`);
      }
      const changes = {};
      for (const [k, v] of Object.entries(items)) {
        if (JSON.stringify(data[k]) === JSON.stringify(v)) continue;
        changes[k] = { oldValue: clone(data[k]), newValue: clone(v) };
        data[k] = clone(v);
      }
      if (Object.keys(changes).length && !silent) for (const fn of listeners) fn(changes, a.name, remote);
    },
    async remove(keys, { remote = false } = {}) {
      if (!remote) a.writes += 1;
      const changes = {};
      for (const k of [].concat(keys)) if (k in data) {
        changes[k] = { oldValue: clone(data[k]) };
        delete data[k];
      }
      if (Object.keys(changes).length) for (const fn of listeners) fn(changes, a.name, remote);
    },
    bytes() {
      return Object.entries(data).reduce((n, [k, v]) => n + itemBytes(k, v), 0);
    },
  };
  return a;
}

// A computer: its own local area and its own copy of sync storage.
function computer(name) {
  return {
    name,
    local: area({ name: 'local' }),
    sync: area({ name: 'sync', quota: 102400, perItem: 8192 }),
  };
}

// Chrome sync, roughly: one copy of each item on the server, last write wins
// per item. Online computers send writes straight away and get everyone
// else's; offline ones queue them and catch up when they're back.
function cloud(...computers) {
  const server = {};
  const queues = new Map(computers.map((c) => [c, []]));
  let online = true;
  for (const c of computers) {
    c.sync.onChanged((changes, _area, remote) => {
      if (remote) return;
      queues.get(c).push(changes);
      if (online) void flush();
    });
  }
  let flushing = Promise.resolve();
  function flush() {
    flushing = flushing.then(async () => {
      const touched = new Set();
      for (const [, q] of queues) {
        while (q.length) {
          const changes = q.shift();
          for (const [k, ch] of Object.entries(changes)) {
            if ('newValue' in ch) server[k] = clone(ch.newValue);
            else delete server[k];
            touched.add(k);
          }
        }
      }
      for (const c of computers) {
        const set = {};
        const del = [];
        for (const k of touched) {
          if (k in server) { if (JSON.stringify(c.sync.data[k]) !== JSON.stringify(server[k])) set[k] = server[k]; }
          else if (k in c.sync.data) del.push(k);
        }
        if (Object.keys(set).length) await c.sync.set(set, { remote: true });
        if (del.length) await c.sync.remove(del, { remote: true });
      }
    });
    return flushing;
  }
  return {
    server,
    offline() { online = false; },
    async online() { online = true; await flush(); },
    flush,
  };
}

module.exports = { area, computer, cloud, clone };
