'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Sync = require('../sync.js');
const { computer, cloud } = require('./fake-storage.js');

const { K, reconcile, chunkText, chunkBudget, itemBytes, newRev } = Sync;

// What the panel does when you type in a pad.
async function edit(c, id, text, extra = {}) {
  const cur = (await c.local.get(K.pad(id)))[K.pad(id)] ?? { id, name: '' };
  await c.local.set({ [K.pad(id)]: { ...cur, ...extra, id, text, rev: newRev(), at: Date.now() } });
}
async function addPad(c, text = '', name = '') {
  await Sync.migrate(c.local);
  const id = Sync.newId();
  const idx = (await c.local.get(K.index))[K.index] ?? { order: [], deleted: {} };
  await c.local.set({ [K.index]: { ...idx, order: [...idx.order, id] }, [K.pad(id)]: { id, name, text, rev: newRev(), at: Date.now() } });
  return id;
}
async function closePad(c, id) {
  const idx = (await c.local.get(K.index))[K.index];
  await c.local.set({ [K.index]: { order: idx.order.filter((x) => x !== id), deleted: { ...idx.deleted, [id]: Date.now() } } });
  await c.local.remove(K.pad(id));
}
async function padsOf(c) {
  const all = await c.local.get(null);
  return all[K.index].order.map((id) => ({ id, ...all[K.pad(id)] }));
}
const texts = async (c) => (await padsOf(c)).map((p) => p.text);
const api = (c) => ({ local: c.local, sync: c.sync });
async function settle(...cs) {
  // Run every computer until nothing changes, the way the service workers would.
  for (let round = 0; round < 8; round++) {
    let wrote = false;
    for (const c of cs) {
      const r = await reconcile(api(c));
      await new Promise((res) => setTimeout(res, 0)); // let the cloud deliver
      wrote ||= r.wrote.local || r.wrote.sync || r.retry;
    }
    if (!wrote) return round;
  }
  for (const c of cs) console.error(c.name, JSON.stringify(await reconcile(api(c))), JSON.stringify((await c.local.get(K.state))[K.state]));
  throw new Error("did not settle");
}
const tick = () => new Promise((r) => setTimeout(r, 3));

test('chunks fit Chrome sync items, whatever the characters', () => {
  const nasty = '<&>"\\\n\t\u0001 😀éa'.repeat(3000) + '\ud800x';
  const rev = newRev();
  const chunks = chunkText(nasty, chunkBudget('abcdefgh', rev));
  assert.equal(chunks.join(''), nasty);
  chunks.forEach((c, k) => assert.ok(itemBytes(`c:abcdefgh:${k}`, [rev, c]) <= 8192, `chunk ${k} too big`));
  // No chunk splits an emoji.
  for (const c of chunks) assert.ok(!/^[\udc00-\udfff]/.test(c) && !/[\ud800-\udbff]$/.test(c.slice(-1)) || c.endsWith('\ud800'));
  assert.deepEqual(chunkText('', 100), ['']);
});

test('0.5 text becomes the first tab, with its cursor', async () => {
  const a = computer('a');
  await a.local.set({ text: 'old notes', view: { start: 3, end: 3, top: 0 } });
  await reconcile(api(a));
  const all = await a.local.get(null);
  assert.deepEqual(all[K.index].order, ['legacy']);
  assert.equal(all['pad:legacy'].text, 'old notes');
  assert.deepEqual(all.views.legacy, { start: 3, end: 3, top: 0 });
  assert.equal(all.text, undefined);
  assert.ok(a.sync.data['m:legacy']);
});

test('new pads, edits, renames and closes reach the other computer', async () => {
  const a = computer('a'), b = computer('b');
  cloud(a, b);
  await a.local.set({ text: 'from a' });
  await settle(a, b);
  assert.deepEqual(await texts(b), ['from a']); // b's empty first pad made way

  const id = await addPad(a, 'second');
  await settle(a, b);
  assert.deepEqual(await texts(b), ['from a', 'second']);

  await tick();
  await edit(b, id, 'second, edited on b', { name: 'Ideas' });
  await settle(a, b);
  const onA = await padsOf(a);
  assert.equal(onA[1].text, 'second, edited on b');
  assert.equal(onA[1].name, 'Ideas');

  await tick();
  await closePad(a, 'legacy');
  await settle(a, b);
  assert.deepEqual(await texts(b), ['second, edited on b']);
  assert.ok(!a.sync.data['m:legacy'] && !b.sync.data['c:legacy:0']);
});

test('both computers keep their own 0.5 text', async () => {
  const a = computer('a'), b = computer('b');
  cloud(a, b);
  await a.local.set({ text: 'notes on a' });
  await b.local.set({ text: 'notes on b' });
  await settle(a, b);
  const ta = (await texts(a)).sort(), tb = (await texts(b)).sort();
  assert.deepEqual(ta, ['notes on a', 'notes on b']);
  assert.deepEqual(tb, ta);
  assert.deepEqual((await padsOf(a)).map((p) => p.id), (await padsOf(b)).map((p) => p.id), 'same order everywhere');
});

test('edits on both computers while offline keep both versions', async () => {
  const a = computer('a'), b = computer('b');
  const net = cloud(a, b);
  await a.local.set({ text: 'shared' });
  await settle(a, b);
  net.offline();
  await tick();
  await edit(a, 'legacy', 'shared + a');
  await edit(b, 'legacy', 'shared + b');
  await reconcile(api(a));
  await reconcile(api(b));
  await net.online();
  await tick();
  await settle(a, b);
  const ta = (await texts(a)).sort(), tb = (await texts(b)).sort();
  assert.deepEqual(ta, ['shared + a', 'shared + b']);
  assert.deepEqual(tb, ta);
  assert.ok((await padsOf(a)).some((p) => / \(copy\)$/.test(p.name)));
});

test('a pad too big to sync stays on its computer, others keep syncing', async () => {
  const a = computer('a'), b = computer('b');
  cloud(a, b);
  await a.local.set({ text: 'small' });
  const big = await addPad(a, 'x'.repeat(60000));
  const big2 = await addPad(a, 'y'.repeat(60000));
  await settle(a, b);
  const st = (await a.local.get(K.state))[K.state];
  assert.equal(st.pads[big].big, false);
  assert.equal(st.pads[big2].big, true, 'second big pad is over the 100 KB total');
  assert.ok(a.sync.bytes() <= 102400);
  assert.deepEqual((await texts(b)).map((t) => t.length), [5, 60000]);

  // Shrinking it brings it back into sync.
  await tick();
  await edit(a, big2, 'short now');
  await settle(a, b);
  assert.deepEqual((await texts(b)).map((t) => t.length), [5, 60000, 9]);
  assert.equal((await a.local.get(K.state))[K.state].pads[big2].big, false);
});

test('a pad that grows too big on one computer is kept on the other', async () => {
  const a = computer('a'), b = computer('b');
  cloud(a, b);
  await a.local.set({ text: 'notes' });
  await settle(a, b);
  await tick();
  await edit(a, 'legacy', 'z'.repeat(120000));
  await settle(a, b);
  assert.equal((await texts(a))[0].length, 120000);
  assert.deepEqual(await texts(b), ['notes'], 'b keeps the last copy that synced');
  const sb = (await b.local.get(K.state))[K.state];
  assert.equal(sb.pads.legacy.remoteBig, true);

  // b edits its copy: b's version takes the pad, a's big text is kept as a copy.
  await tick();
  await edit(b, 'legacy', 'notes from b');
  await settle(a, b);
  const pa = await padsOf(a);
  assert.equal(pa[0].text, 'notes from b');
  assert.equal(pa[1].text.length, 120000);
  assert.match(pa[1].name, /\(copy\)$/);
});

test('settled computers write nothing more', async () => {
  const a = computer('a'), b = computer('b');
  cloud(a, b);
  await a.local.set({ text: 'hello' });
  await addPad(b, 'b pad');
  await settle(a, b);
  const before = a.sync.writes + b.sync.writes;
  for (let i = 0; i < 3; i++) { await reconcile(api(a)); await reconcile(api(b)); }
  assert.equal(a.sync.writes + b.sync.writes, before);
});

test('engine batches a burst of typing into few sync writes', async () => {
  const a = computer('a');
  a.local.onChanged((ch, area) => engine.onChanged(ch, area));
  const engine = Sync.createEngine(api(a), { log: { warn() {} } });
  await a.local.set({ text: '' });
  await reconcile(api(a));
  const start = a.sync.writes;
  for (let i = 0; i < 40; i++) {
    await edit(a, 'legacy', 'typing '.repeat(i));
    await new Promise((r) => setTimeout(r, 25));
  }
  await new Promise((r) => setTimeout(r, 2600));
  assert.equal((await a.sync.get('c:legacy:0'))['c:legacy:0'][1], 'typing '.repeat(39));
  assert.ok(a.sync.writes - start <= 2, `wrote ${a.sync.writes - start} times`);
});

test('a run of edits on one computer fast-forwards the other, no copies', async () => {
  const a = computer('a'), b = computer('b');
  const net = cloud(a, b);
  await a.local.set({ text: 'v0' });
  await settle(a, b);
  for (let i = 1; i <= 25; i++) {
    await tick();
    await edit(i % 2 ? b : a, 'legacy', `v${i}`);
    await settle(a, b);
  }
  net.offline();
  for (let i = 26; i <= 30; i++) { await tick(); await edit(b, 'legacy', `v${i}`); await reconcile(api(b)); }
  await net.online();
  await tick();
  await settle(a, b);
  assert.deepEqual(await texts(a), ['v30']);
  assert.deepEqual(await texts(b), ['v30']);
});

test('a pad edited after it was closed elsewhere comes back', async () => {
  const a = computer('a'), b = computer('b');
  const net = cloud(a, b);
  await a.local.set({ text: 'keep me' });
  const other = await addPad(a, 'other');
  await settle(a, b);
  net.offline();
  await closePad(a, 'legacy');
  await reconcile(api(a));
  await tick();
  await edit(b, 'legacy', 'keep me, edited');
  await reconcile(api(b));
  await net.online();
  await tick();
  await settle(a, b);
  assert.deepEqual((await texts(a)).sort(), ['keep me, edited', 'other']);
  assert.deepEqual((await texts(b)).sort(), ['keep me, edited', 'other']);
  void other;
});

test('fuzz: three computers converge and lose no edits', async () => {
  let seed = 7;
  const rand = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  for (let run = 0; run < 25; run++) {
    const cs = [computer('a'), computer('b'), computer('c')];
    const net = cloud(...cs);
    await cs[0].local.set({ text: 'start' });
    await settle(...cs);
    const written = new Set(['start']);
    for (let step = 0; step < 30; step++) {
      const c = cs[rand(3)];
      const op = rand(10);
      if (op === 0) net.offline();
      else if (op === 1) { await net.online(); await tick(); }
      else if (op === 2) {
        const text = `new ${run}.${step}`;
        written.add(text);
        await addPad(c, text);
      } else if (op < 6) {
        await reconcile(api(c));
      } else {
        const pads = await padsOf(c);
        const p = pads[rand(pads.length)];
        const token = `${c.name}${run}.${step}`;
        const text = `${p.text} ${token}`; // edits add to the text, so a lost edit shows as a missing token
        written.add(token);
        await tick();
        await edit(c, p.id, text);
      }
    }
    await net.online();
    await tick();
    await settle(...cs);
    const finals = await Promise.all(cs.map(async (c) => (await padsOf(c)).map((p) => `${p.id}=${p.text}`)));
    assert.deepEqual(finals[1], finals[0], `run ${run}: b differs`);
    assert.deepEqual(finals[2], finals[0], `run ${run}: c differs`);
    // Every edit made anywhere survives in some pad.
    const everything = finals[0].join('\n');
    for (const token of written) assert.ok(everything.includes(token), `run ${run}: lost ${token}`);
  }
});
