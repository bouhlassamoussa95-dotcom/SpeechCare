// Offline simulation tests for www/cloud-sync.js (fake Firestore + fake Storage, two virtual phones).
// Run:  node tests/sync-test.js      (no network, no dependencies)
const vm = require('vm'), fs = require('fs'), path = require('path'), assert = require('assert');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'www', 'cloud-sync.js'), 'utf8');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const results = [];
async function test(name, fn) { try { await fn(); pass++; results.push('PASS  ' + name); } catch (e) { fail++; results.push('FAIL  ' + name + '\n      ' + (e.stack || e).split('\n').slice(0, 3).join('\n      ')); } }

/* ---------- fake cloud shared by all phones ---------- */
function makeCloud() {
  const c = { docs: {}, subs: {}, storage: {}, writes: 0, storageDown: false, bigWrites: [] };
  c.notify = p => (c.subs[p] || []).forEach(f => f());
  c.snap = p => { const d = c.docs[p]; return { exists: !!d, data: () => d && JSON.parse(JSON.stringify(d)), metadata: { hasPendingWrites: false, fromCache: false } }; };
  return c;
}
function makePhone(cloud, name) {
  const store = {}, sb = { console };
  const net = { online: true };
  const err = () => Object.assign(new Error('Failed to get document because the client is offline.'), { code: 'unavailable' });
  const ref = p => ({
    path: p,
    get: async () => { if (!net.online) throw err(); return cloud.snap(p); },
    onSnapshot: (cb) => { const f = () => { if (net.online) cb(cloud.snap(p)); }; (cloud.subs[p] = cloud.subs[p] || []).push(f); setTimeout(f, 0); return () => { cloud.subs[p] = cloud.subs[p].filter(x => x !== f); }; }
  });
  const db = {
    doc: ref,
    runTransaction: async fn => {
      if (!net.online) throw err();
      const pend = [];
      await fn({ get: async r => cloud.snap(r.path), set: (r, d) => pend.push([r.path, d]) });
      pend.forEach(([p, d]) => { cloud.docs[p] = JSON.parse(JSON.stringify(d)); cloud.writes++; if (JSON.stringify(d).length > 900000) cloud.bigWrites.push(p); });
      pend.forEach(([p]) => cloud.notify(p));
    }
  };
  const firebase = { storage: () => ({ ref: p => ({
    putString: async (u) => { if (!net.online) throw err(); if (cloud.storageDown) throw Object.assign(new Error('x'), { code: 'storage/unauthorized' }); cloud.storage[p] = u; },
    getDownloadURL: async () => 'https://fake.storage/' + encodeURIComponent(p) + '?token=t',
    delete: async () => { if (!cloud.storage[p]) throw Object.assign(new Error('nf'), { code: 'storage/object-not-found' }); delete cloud.storage[p]; }
  }) }), app: () => ({ options: { storageBucket: 'b' } }) };
  const ctx = Object.assign(sb, {
    localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } },
    navigator: { get onLine() { return net.online; } }, crypto: require('crypto').webcrypto, TextEncoder, atob, Blob,
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {}, firebase,
    FB: { storageBucket: 'b' }, PR: { lang: 'fr', theme: 'system' }, toasts: [], refreshes: 0,
    toast: x => ctx.toasts.push(x), go: () => { ctx.refreshes++; }, mig: () => { ctx.S.c = ctx.S.c || []; ctx.S.toys = ctx.S.toys || []; },
    applyPref: () => {}, document: { addEventListener() {}, getElementById: id => (id === 'shell' ? { hidden: false } : null), activeElement: null, visibilityState: 'visible' },
    K: '', U: null, S: null, db
  });
  ctx.window = ctx; ctx.window.addEventListener = () => {};
  ctx.save = () => { ctx.CORE.onSave(); ctx.localStorage.setItem(ctx.K, JSON.stringify(ctx.S)); };
  vm.createContext(ctx); vm.runInContext(SRC, ctx, { filename: 'cloud-sync.js' });
  return {
    name, ctx, net, store, CORE: ctx.CORE,
    get S() { return ctx.S; },
    async login(uid, local) {
      ctx.K = 'ortho_' + uid; ctx.U = { uid, getIdToken: async () => 'tok' };
      const raw = ctx.localStorage.getItem(ctx.K);
      ctx.S = raw ? JSON.parse(raw) : (local || { p: [], a: [], act: {}, toys: [], c: [], me: { name: '', places: [] } });
      if (local && !raw) ctx.localStorage.setItem(ctx.K, JSON.stringify(ctx.S));
      await ctx.CORE.initialSync(db, ctx.U); ctx.mig(); ctx.CORE.ready();
    },
    edit(fn) { fn(ctx.S); ctx.save(); },
    async settle(ms = 3000) { const t0 = Date.now(); await sleep(900); while (Date.now() - t0 < ms) { const s = ctx.CORE._t.status(); if (!s.pend && s.s === 'saved') return s; await sleep(100); } return ctx.CORE._t.status(); }
  };
}
const cloudDoc = (cl, n) => JSON.parse(cl.docs['users/u1/app/' + n].json);
const base = () => ({ p: [{ id: 'p1', name: 'Amel' }, { id: 'p2', name: 'Yacine' }], a: [{ id: 'a1', pid: 'p1', date: '2026-01-01', status: 'done' }], act: {}, toys: [], c: [], sr: [{ id: 'sr_a1', pid: 'p1' }], me: { name: 'Chourouk', places: [{ id: 'w1', n: 'Crèche' }] } });

(async () => {
  await test('merge: concurrent edits on different records are both kept', async () => {
    const A = makePhone(makeCloud(), 'x'); const M = A.CORE._t.merge, snap = A.CORE._t.snapshot;
    const b = base(), l = JSON.parse(JSON.stringify(b)), r = JSON.parse(JSON.stringify(b));
    l.p[0].name = 'Amel L'; l.p[0]._u = 5; r.p[1].name = 'Yacine R'; r.p[1]._u = 6;
    const m = M(snap(b), l, r); assert.equal(m.p[0].name, 'Amel L'); assert.equal(m.p[1].name, 'Yacine R');
  });
  await test('merge: same record edited twice -> newer edit wins; delete vs edit keeps the edit; delete propagates', async () => {
    const A = makePhone(makeCloud(), 'x'); const M = A.CORE._t.merge, snap = A.CORE._t.snapshot;
    const b = base(); let l = JSON.parse(JSON.stringify(b)), r = JSON.parse(JSON.stringify(b));
    l.p[0].name = 'L'; l.p[0]._u = 10; r.p[0].name = 'R'; r.p[0]._u = 20;
    assert.equal(M(snap(b), l, r).p[0].name, 'R'); l.p[0]._u = 30; assert.equal(M(snap(b), l, r).p[0].name, 'L');
    l = JSON.parse(JSON.stringify(b)); r = JSON.parse(JSON.stringify(b)); l.p = l.p.filter(x => x.id !== 'p1'); r.p[0].name = 'edited remotely';
    assert.equal(M(snap(b), l, r).p.find(x => x.id === 'p1').name, 'edited remotely');
    l = JSON.parse(JSON.stringify(b)); r = JSON.parse(JSON.stringify(b)); l.p = l.p.filter(x => x.id !== 'p1');
    assert.equal(M(snap(b), l, r).p.find(x => x.id === 'p1'), undefined);
    l = JSON.parse(JSON.stringify(b)); r = JSON.parse(JSON.stringify(b)); r.a = []; assert.equal(M(snap(b), l, r).a.length, 0);
  });
  await test('merge: settings fields and activity counters merge per field', async () => {
    const A = makePhone(makeCloud(), 'x'); const M = A.CORE._t.merge, snap = A.CORE._t.snapshot;
    const b = base(); b.me.phone = '1'; b.runs = { x1: { runs: 1, best: 50, last: '2026-01-01' } };
    const l = JSON.parse(JSON.stringify(b)), r = JSON.parse(JSON.stringify(b));
    l.me.title = 'T-local'; r.me.phone = '2'; l.runs.x1 = { runs: 3, best: 60, last: '2026-02-01' }; r.runs.x1 = { runs: 2, best: 90, last: '2026-01-15' };
    const m = M(snap(b), l, r); assert.equal(m.me.title, 'T-local'); assert.equal(m.me.phone, '2'); assert.deepEqual(m.runs.x1, { runs: 3, best: 90, last: '2026-02-01' });
  });

  await test('empty local data never uploaded when cloud has no database, nothing created', async () => {
    const cl = makeCloud(), A = makePhone(cl, 'A'); await A.login('u1'); await sleep(1200);
    assert.equal(cl.writes, 0); assert.equal(Object.keys(cl.docs).length, 0);
  });
  await test('empty local data never overwrites an existing cloud database (adopts cloud instead)', async () => {
    const cl = makeCloud(), A = makePhone(cl, 'A'); await A.login('u1', base()); await A.settle();
    const B = makePhone(cl, 'B'); await B.login('u1'); await B.settle();
    assert.equal(B.S.p.length, 2); assert.equal(cloudDoc(cl, 'data').p.length, 2);
  });
  await test('legacy migration: old {json,t} cloud doc + older local data -> union, nothing deleted, repeatable', async () => {
    const cl = makeCloud(); const old = base(); old.toysDoc = 1; old.toys = [];
    cl.docs['users/u1/app/data'] = { json: JSON.stringify(old), t: 1000 }; cl.docs['users/u1/app/toys'] = { json: JSON.stringify([{ id: 't1', name: 'Ball', img: '', acts: [] }]), t: 1000 };
    const loc = base(); loc.p.push({ id: 'p9', name: 'Only on phone' });
    const A = makePhone(cl, 'A'); await A.login('u1', loc); await A.settle();
    const d = cloudDoc(cl, 'data'); assert.ok(d.p.find(x => x.id === 'p9')); assert.ok(d.p.find(x => x.id === 'p1')); assert.equal(JSON.parse(cl.docs['users/u1/app/toys'].json).length, 1);
    const w = cl.writes; await A.login('u1'); await A.settle(); const w2 = cl.writes; await A.login('u1'); await A.settle(); assert.ok(cl.writes - w2 <= 2, 're-login must not keep rewriting');
    assert.ok(A.store['ortho_u1_prebackup'], 'one-time local safety copy created');
  });

  await test('saving: local first, cloud confirmed only after Firestore commit; pending flag cleared after', async () => {
    const cl = makeCloud(), A = makePhone(cl, 'A'); await A.login('u1', base()); await A.settle();
    A.edit(s => s.p.push({ id: 'p3', name: 'New' }));
    assert.ok(JSON.parse(A.store['ortho_u1']).p.find(x => x.id === 'p3'), 'on device immediately'); assert.ok(A.store['ortho_u1_pend'], 'pending set');
    assert.notEqual(A.CORE._t.status().s, 'saved'); await A.settle();
    assert.ok(cloudDoc(cl, 'data').p.find(x => x.id === 'p3')); assert.ok(!A.store['ortho_u1_pend']); assert.equal(A.CORE._t.status().s, 'saved');
  });
  await test('offline: change kept locally as pending, retried when connectivity returns, never lost', async () => {
    const cl = makeCloud(), A = makePhone(cl, 'A'); await A.login('u1', base()); await A.settle();
    A.net.online = false; A.edit(s => s.p.push({ id: 'p4', name: 'Offline add' })); await sleep(1200);
    assert.equal(A.CORE._t.status().s, 'offline'); assert.ok(A.store['ortho_u1_pend']); assert.ok(!cloudDoc(cl, 'data').p.find(x => x.id === 'p4'));
    A.net.online = true; await A.CORE.syncNow(); await A.settle();
    assert.ok(cloudDoc(cl, 'data').p.find(x => x.id === 'p4')); assert.ok(!A.store['ortho_u1_pend']);
  });
  await test('app killed while offline: pending survives restart and uploads at next launch', async () => {
    const cl = makeCloud(), A = makePhone(cl, 'A'); await A.login('u1', base()); await A.settle();
    A.net.online = false; A.edit(s => s.p.push({ id: 'p5', name: 'Before kill' })); await sleep(900);
    const B = makePhone(cl, 'A2'); Object.assign(B.store, A.store); A.CORE.stop(); await B.login('u1'); await B.settle();
    assert.ok(cloudDoc(cl, 'data').p.find(x => x.id === 'p5'));
  });
  await test('two phones: add / edit / delete on one appear on the other (live listeners)', async () => {
    const cl = makeCloud(), A = makePhone(cl, 'A'), B = makePhone(cl, 'B'); await A.login('u1', base()); await A.settle(); await B.login('u1'); await B.settle();
    A.edit(s => s.p.push({ id: 'p6', name: 'From A' })); await A.settle(); await sleep(900); assert.ok(B.S.p.find(x => x.id === 'p6'), 'add'); assert.ok(B.ctx.refreshes > 0, 'UI refreshed');
    B.edit(s => { s.p.find(x => x.id === 'p6').name = 'Edited by B'; }); await B.settle(); await sleep(900); assert.equal(A.S.p.find(x => x.id === 'p6').name, 'Edited by B', 'edit');
    A.edit(s => { s.p = s.p.filter(x => x.id !== 'p6'); }); await A.settle(); await sleep(900); assert.ok(!B.S.p.find(x => x.id === 'p6'), 'delete');
  });
  await test('two phones offline editing different things at once -> both edits survive after reconnect', async () => {
    const cl = makeCloud(), A = makePhone(cl, 'A'), B = makePhone(cl, 'B'); await A.login('u1', base()); await A.settle(); await B.login('u1'); await B.settle();
    A.net.online = false; B.net.online = false;
    A.edit(s => { s.p.find(x => x.id === 'p1').name = 'Amel (A)'; s.a.push({ id: 'aA', pid: 'p1', date: '2026-03-01', status: 'scheduled' }); });
    B.edit(s => { s.p.find(x => x.id === 'p2').name = 'Yacine (B)'; s.sr.push({ id: 'srB', pid: 'p2' }); s.me.phone = '0555'; });
    A.net.online = true; await A.CORE.syncNow(); await A.settle(); B.net.online = true; await B.CORE.syncNow(); await B.settle(); await sleep(900); await A.settle();
    for (const X of [A, B]) { assert.equal(X.S.p.find(x => x.id === 'p1').name, 'Amel (A)'); assert.equal(X.S.p.find(x => x.id === 'p2').name, 'Yacine (B)'); assert.ok(X.S.a.find(x => x.id === 'aA')); assert.ok(X.S.sr.find(x => x.id === 'srB')); assert.equal(X.S.me.phone, '0555'); }
    const d = cloudDoc(cl, 'data'); assert.equal(d.p.length, 2); assert.ok(d.a.find(x => x.id === 'aA'));
  });
  await test('stale phone cannot erase newer cloud data', async () => {
    const cl = makeCloud(), A = makePhone(cl, 'A'), B = makePhone(cl, 'B'); await A.login('u1', base()); await A.settle(); await B.login('u1'); await B.settle();
    B.net.online = false; A.edit(s => s.p.push({ id: 'pN', name: 'Newer on A' })); await A.settle();
    B.edit(s => { s.a.push({ id: 'aB', pid: 'p2', date: '2026-04-01', status: 'scheduled' }); }); B.net.online = true; await B.CORE.syncNow(); await B.settle();
    const d = cloudDoc(cl, 'data'); assert.ok(d.p.find(x => x.id === 'pN'), 'A\'s newer patient still in cloud'); assert.ok(d.a.find(x => x.id === 'aB'));
  });
  await test('guard: a suddenly-empty local state restores from cloud instead of wiping it', async () => {
    const cl = makeCloud(), A = makePhone(cl, 'A'); await A.login('u1', base()); await A.settle();
    A.edit(s => { s.p = []; s.a = []; s.sr = []; s.c = []; s.me.places = []; }); await A.settle(); await sleep(300);
    const d = cloudDoc(cl, 'data'); assert.equal(d.p.length, 2, 'cloud kept'); assert.equal(A.S.p.length, 2, 'device restored');
  });

  await test('photos: uploaded to Storage, Firestore holds URL+path only (no Base64), other phone sees the URL', async () => {
    const cl = makeCloud(), A = makePhone(cl, 'A'), B = makePhone(cl, 'B'); await A.login('u1', base()); await A.settle(); await B.login('u1'); await B.settle();
    const img = 'data:image/jpeg;base64,' + Buffer.from('fake-jpeg-bytes-1').toString('base64');
    A.edit(s => s.toys.push({ id: 't1', name: 'Ball', cat: 'speech', img, acts: [] })); await A.settle(); await sleep(900);
    const toys = JSON.parse(cl.docs['users/u1/app/toys'].json); assert.ok(/^https:\/\/fake\.storage\//.test(toys[0].img)); assert.ok(toys[0].imgPath.startsWith('users/u1/toys/'));
    assert.ok(!cl.docs['users/u1/app/toys'].json.includes('base64')); assert.ok(!cl.docs['users/u1/app/data'].json.includes('base64')); assert.equal(Object.keys(cl.storage).length, 1);
    assert.equal(B.S.toys[0].img, toys[0].img); assert.equal(A.S.toys[0].img, toys[0].img, 'local state switched to the URL');
    A.edit(s => s.toys.push({ id: 't2', name: 'Same photo', cat: 'speech', img, acts: [] })); await A.settle(); assert.equal(Object.keys(cl.storage).length, 1, 'identical photo not uploaded twice');
  });
  await test('photos: delete toy removes its Storage file, but a file still used elsewhere is kept', async () => {
    const cl = makeCloud(), A = makePhone(cl, 'A'); await A.login('u1', base()); await A.settle();
    const img = 'data:image/jpeg;base64,' + Buffer.from('fake-jpeg-bytes-2').toString('base64');
    A.edit(s => { s.toys.push({ id: 't1', img, acts: [] }, { id: 't2', img, acts: [] }); }); await A.settle();
    A.edit(s => { s.toys = s.toys.filter(x => x.id !== 't1'); }); await A.settle(); assert.equal(Object.keys(cl.storage).length, 1, 'kept: t2 still uses it');
    A.edit(s => { s.toys = s.toys.filter(x => x.id !== 't2'); }); await A.settle(); assert.equal(Object.keys(cl.storage).length, 0, 'removed once unreferenced');
  });
  await test('photos: Storage unavailable -> text still syncs, photo stays on device (not Base64 in Firestore), status says so, retry works', async () => {
    const cl = makeCloud(), A = makePhone(cl, 'A'); await A.login('u1', base()); await A.settle(); cl.storageDown = true;
    const img = 'data:image/jpeg;base64,' + Buffer.from('fake-jpeg-bytes-3').toString('base64');
    A.edit(s => s.toys.push({ id: 't9', name: 'Puzzle', img, acts: [] })); await sleep(2000);
    assert.equal(A.CORE._t.status().s, 'photos'); assert.ok(A.S.toys[0].img.startsWith('data:'), 'kept locally'); assert.ok(!JSON.stringify(cl.docs).includes('base64'), 'no Base64 in Firestore');
    assert.ok(JSON.parse(cl.docs['users/u1/app/toys'].json).find(x => x.id === 't9'), 'toy record itself synced');
    cl.storageDown = false; await A.CORE.syncNow(); await A.settle(); assert.ok(A.S.toys[0].img.startsWith('https://')); assert.equal(Object.keys(cl.storage).length, 1);
  });
  await test('storage health check reports success and failure honestly', async () => {
    const cl = makeCloud(), A = makePhone(cl, 'A'); await A.login('u1', base()); A.ctx.fetch = async () => ({ ok: true }); A.ctx.CapacitorWebFetch = undefined;
    assert.equal((await A.CORE.checkStorage()).ok, true); cl.storageDown = true; assert.equal((await A.CORE.checkStorage()).ok, false);
  });

  await test('OpenRouter key/model untouched, never written to cloud, never in sync code', async () => {
    const cl = makeCloud(), A = makePhone(cl, 'A'); A.store['speechcare_or_key'] = 'sk-or-v1-SECRET'; A.store['speechcare_or_model'] = 'openrouter/free';
    await A.login('u1', base()); A.edit(s => s.p.push({ id: 'pk', name: 'x' })); await A.settle();
    assert.equal(A.store['speechcare_or_key'], 'sk-or-v1-SECRET'); assert.equal(A.store['speechcare_or_model'], 'openrouter/free'); assert.ok(!JSON.stringify(cl).includes('SECRET'));
    assert.ok(!/speechcare_or_(key|model)/.test(SRC), 'sync code never references the key');
  });
  await test('logout stops sync cleanly (no writes afterwards)', async () => {
    const cl = makeCloud(), A = makePhone(cl, 'A'); await A.login('u1', base()); await A.settle(); A.CORE.stop(); const w = cl.writes; A.edit(s => s.p.push({ id: 'zz' })); await sleep(1200); assert.equal(cl.writes, w);
  });
  await test('Firestore document size guard (<1 MB) holds with photos in Storage', async () => {
    const cl = makeCloud(), A = makePhone(cl, 'A'); await A.login('u1', base()); A.edit(s => { for (let i = 0; i < 40; i++) s.toys.push({ id: 'tt' + i, img: 'data:image/jpeg;base64,' + Buffer.from('p' + i + 'x'.repeat(30000)).toString('base64'), acts: [] }); });
    await A.settle(10000); assert.equal(cl.bigWrites.length, 0); assert.ok(cl.docs['users/u1/app/toys'].json.length < 20000);
  });

  console.log(results.join('\n')); console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
