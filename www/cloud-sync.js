/* ==========================================================================
   SpeechCare cloud sync engine  (loaded LAST, after modules-core.js)

   - Keeps the existing Firestore documents:  users/{uid}/app/data  and
     users/{uid}/app/toys   (same { json, t } shape, so older builds still read them)
   - Offline-first: every change is on the device first; a "pending" flag survives
     app restarts and is cleared ONLY after Firestore confirms the write.
   - Never blind-overwrites the cloud: every write is a Firestore transaction that
     3-way-merges (base / this device / cloud) record by record, so edits made on
     two phones are combined and a stale phone cannot erase newer cloud data.
   - Live listeners (onSnapshot) bring the other phone's changes in.
   - Photos go to Firebase Storage; Firestore keeps only the URL + path.
   - Does NOT touch the AI (OpenRouter) key or model settings: they stay in this device's own storage.
   ========================================================================== */
(function () {
  'use strict';
  var G = (typeof window !== 'undefined') ? window : globalThis;
  var CORE = G.CORE = G.CORE || {};

  /* ---- switches ---- */
  var SYNC_UI_PREFS = true;            // language/theme follow the account (set false to keep per device)
  var BACKUP_EVERY_MS = 6 * 3600 * 1000;
  var MAX_DOC_CHARS = 950000;          // Firestore documents are limited to ~1 MiB

  /* ---- small helpers ---- */
  var L3 = function (en, fr, ar) { var l = (typeof PR !== 'undefined' && PR) ? PR.lang : 'en'; return l === 'fr' ? fr : l === 'ar' ? ar : en; };
  var tmo = function (p, ms) { return Promise.race([p, new Promise(function (_, j) { setTimeout(function () { j(new Error('timeout')); }, ms); })]); };
  var lsGet = function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } };
  var lsSet = function (k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } };
  var lsDel = function (k) { try { localStorage.removeItem(k); } catch (e) { } };
  var clone = function (o) { return o === undefined ? undefined : JSON.parse(JSON.stringify(o)); };
  var isPlain = function (v) { return v && typeof v === 'object' && !Array.isArray(v); };
  var isRec = function (x) { return isPlain(x) && x.id != null && x.id !== ''; };
  var union = function (a, b) { var o = {}, r = []; a.concat(b).forEach(function (k) { if (!o[k]) { o[k] = 1; r.push(k); } }); return r; };

  function h32(s) { var h = 2166136261, i; for (i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36) + '.' + s.length.toString(36); }
  function stable(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
    if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
    return '{' + Object.keys(v).filter(function (k) { return k !== '_u'; }).sort().map(function (k) { return JSON.stringify(k) + ':' + stable(v[k]); }).join(',') + '}';
  }
  var H = function (v) { return h32(stable(v)); };

  var devId = lsGet('sc_device_id');
  if (!devId) { devId = 'd' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36); lsSet('sc_device_id', devId); }

  /* ======================================================================
     State model: records (arrays of objects with id) + atoms (scalar/object fields)
     ====================================================================== */
  var BASE_COLS = ['p', 'a', 'c', 'sr', 'ai', 'toys', 'me.places'];
  var firstDot = function (p) { var i = p.indexOf('.'); return i < 0 ? [p, null] : [p.slice(0, i), p.slice(i + 1)]; };
  function getPath(s, p) { var x = firstDot(p), o = s ? s[x[0]] : undefined; return x[1] == null ? o : (o == null ? undefined : o[x[1]]); }
  function setPath(s, p, v) {
    var x = firstDot(p);
    if (x[1] == null) { if (v === undefined) delete s[x[0]]; else s[x[0]] = v; return; }
    if (!isPlain(s[x[0]])) { if (v === undefined) return; s[x[0]] = {}; }
    if (v === undefined) delete s[x[0]][x[1]]; else s[x[0]][x[1]] = v;
  }
  function colsOf() {
    var out = BASE_COLS.slice();
    Array.prototype.slice.call(arguments).forEach(function (s) {
      Object.keys(s || {}).forEach(function (k) {
        if (k !== 'toysDoc' && out.indexOf(k) < 0 && Array.isArray(s[k]) && s[k].length && s[k].every(isRec)) out.push(k);
      });
    });
    return out;
  }
  function atomsOf(s, cols) {
    var o = {};
    Object.keys(s || {}).forEach(function (k) {
      if (k === 'toysDoc' || k === '_at' || cols.indexOf(k) >= 0) return;
      var v = s[k];
      if (isPlain(v)) Object.keys(v).forEach(function (sk) { var p = k + '.' + sk; if (cols.indexOf(p) < 0) o[p] = v[sk]; });
      else o[k] = v;
    });
    return o;
  }
  function snapshot(s) {
    var cols = colsOf(s), c = {}, a = {};
    cols.forEach(function (col) { var m = {}; (getPath(s, col) || []).forEach(function (r) { if (isRec(r)) m[r.id] = H(r); }); c[col] = m; });
    var at = atomsOf(s, cols); Object.keys(at).forEach(function (p) { a[p] = H(at[p]); });
    return { c: c, a: a };
  }
  function norm(s) { var o = Object.assign({}, s); delete o.toysDoc; return o; }
  function recCount(s) { var n = 0; colsOf(s).forEach(function (c) { n += (getPath(s, c) || []).length; }); return n; }
  function isEmpty(s) { return recCount(s) === 0 && !Object.keys((s && s.act) || {}).length; }

  /* ---- 3-way merge by record id ---- */
  function mergeCol(bH, lArr, rArr) {
    var lm = {}, rm = {}, ids = [], extraL = [], extraR = [], out = [];
    lArr.forEach(function (r) { if (isRec(r)) lm[r.id] = r; else extraL.push(r); });
    rArr.forEach(function (r) { if (isRec(r)) { rm[r.id] = r; ids.push(r.id); } else extraR.push(r); });
    Object.keys(lm).forEach(function (id) { if (!rm[id]) ids.push(id); });
    ids.forEach(function (id) {
      var l = lm[id], r = rm[id], b = bH[id], pick;
      if (l && r) {
        var lh = H(l), rh = H(r);
        if (lh === rh) pick = r;
        else {
          var lc = b === undefined || lh !== b, rc = b === undefined || rh !== b;
          pick = (lc && !rc) ? l : (rc && !lc) ? r : ((l._u || 0) > (r._u || 0) ? l : r);
        }
      } else if (l) { pick = (b === undefined || H(l) !== b) ? l : null; }        // remote deleted it: keep only if edited here
      else { pick = (b === undefined || H(r) !== b) ? r : null; }                  // local deleted it: keep only if edited remotely
      if (pick) out.push(pick);
    });
    var seen = {}; extraR.concat(extraL).forEach(function (x) { var k = stable(x); if (!seen[k]) { seen[k] = 1; out.push(x); } });
    return out;
  }
  function resolveAtom(path, lv, rv, lt, rt) {
    if (path.indexOf('runs.') === 0 && isPlain(lv) && isPlain(rv)) {   // activity counters: never lose runs
      return { runs: Math.max(+lv.runs || 0, +rv.runs || 0), best: Math.max(+lv.best || 0, +rv.best || 0), last: String(lv.last || '') > String(rv.last || '') ? lv.last : rv.last };
    }
    return (lt || 0) > (rt || 0) ? lv : rv;
  }
  function merge(base, L, R) {
    base = base || { c: {}, a: {} };
    var cols = colsOf(L, R), M = clone(R);
    cols.forEach(function (c) { setPath(M, c, mergeCol((base.c || {})[c] || {}, getPath(L, c) || [], getPath(R, c) || [])); });
    var la = atomsOf(L, cols), ra = atomsOf(R, cols), ba = base.a || {}, lt = L._at || {}, rt = R._at || {};
    union(Object.keys(la), Object.keys(ra)).forEach(function (p) {
      var lv = la[p], rv = ra[p], b = ba[p], lh = lv === undefined ? '~' : H(lv), rh = rv === undefined ? '~' : H(rv), val;
      if (lh === rh) val = rv;
      else if (b === undefined && lv === undefined) val = rv;
      else if (b === undefined && rv === undefined) val = lv;
      else {
        var lc = b === undefined || lh !== b, rc = b === undefined || rh !== b;
        if (lc && !rc) val = lv; else if (rc && !lc) val = rv;
        else if (lv === undefined || rv === undefined) val = lv === undefined ? rv : lv;
        else val = resolveAtom(p, lv, rv, lt[p], rt[p]);
      }
      setPath(M, p, clone(val));
    });
    var at = Object.assign({}, rt); Object.keys(lt).forEach(function (p) { at[p] = Math.max(at[p] || 0, lt[p] || 0); });
    if (Object.keys(at).length) M._at = at;
    if (R.toysDoc || L.toysDoc) M.toysDoc = 1;
    return M;
  }

  /* ======================================================================
     Engine state
     ====================================================================== */
  var C = null;                         // active context for the signed-in user
  var BASE = { c: {}, a: {}, t: 0, none: 1 };
  var LH = { c: {}, a: {} };            // hashes at last local save (to stamp edited records)
  var saveSeq = 0, running = false, again = false, timer = null, retryN = 0, retryTimer = null;
  var photosPending = 0, lastPhotoErr = null, lastSync = 0, lastErr = null, storageState = '';
  var PH = {};                          // sha -> {path,url}
  var seenPref = '';
  var pendingRefresh = false, refreshTimer = null;

  var kBase = function () { return K + '_syncbase'; }, kPend = function () { return K + '_pend'; }, kPH = function () { return K + '_photos'; }, kKnown = function () { return K + '_stor'; };
  var persistLocal = function () { lsSet(K, JSON.stringify(S)); };
  var isPend = function () { return !!lsGet(kPend()); };
  var setPend = function () { lsSet(kPend(), String(Date.now())); };
  var clrPend = function () { lsDel(kPend()); };
  function loadBase() { try { var b = JSON.parse(lsGet(kBase())); if (b && b.c) { BASE = b; return; } } catch (e) { } BASE = { c: {}, a: {}, t: 0, none: 1 }; }
  function saveBase(R, t) { var b = snapshot(R); b.t = t || 0; BASE = b; lsSet(kBase(), JSON.stringify(b)); }
  function loadPH() { try { PH = JSON.parse(lsGet(kPH())) || {}; } catch (e) { PH = {}; } }
  var getKnown = function () { try { return JSON.parse(lsGet(kKnown())) || []; } catch (e) { return []; } };
  var setKnown = function (a) { lsSet(kKnown(), JSON.stringify(a)); };
  function trackPaths(toys) { var k = getKnown(), ch = 0; (toys || []).forEach(function (t) { if (t && t.imgPath && k.indexOf(t.imgPath) < 0) { k.push(t.imgPath); ch = 1; } }); if (ch) setKnown(k); }

  /* ---- status pill ---- */
  var STATUS = { s: 'idle', detail: '' };
  var TXT = {
    saving: ['Saving…', 'Enregistrement…', 'جارٍ الحفظ…'],
    saved: ['Saved to cloud', 'Enregistré dans le cloud', 'تم الحفظ في السحابة'],
    pending: ['Saved on device · waiting to sync', 'Enregistré sur l’appareil · en attente', 'محفوظ على الجهاز · بانتظار المزامنة'],
    offline: ['Offline · saved on device', 'Hors ligne · enregistré sur l’appareil', 'بدون اتصال · محفوظ على الجهاز'],
    photos: ['Saved · photos waiting to upload', 'Enregistré · photos en attente', 'تم الحفظ · الصور بانتظار الرفع'],
    error: ['Cloud error · tap for details', 'Erreur cloud · appuyez', 'خطأ في السحابة · اضغط للتفاصيل']
  };
  function setStatus(s, detail) {
    STATUS = { s: s, detail: detail || '' };
    try { drawPill(); } catch (e) { }
  }
  function drawPill() {
    if (typeof document === 'undefined' || !document.body || !document.createElement) return;
    var el = document.getElementById('scSync');
    if (!el) {
      var st = document.createElement('style');
      st.textContent = '#scSync{position:fixed;left:10px;bottom:calc(68px + env(safe-area-inset-bottom,0px));z-index:30;font:600 12px/1 system-ui,sans-serif;padding:7px 11px;border-radius:999px;background:#222d;color:#fff;box-shadow:0 2px 8px #0003;max-width:70%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;transition:opacity .4s}#scSync.ok{background:#1b7a4bdd}#scSync.warn{background:#b36b00e6}#scSync.err{background:#b3261eee}#scSync.dim{opacity:.55}#scSheetBg{position:fixed;inset:0;background:#0007;z-index:60;display:flex;align-items:center;justify-content:center;padding:18px}#scSheet{background:var(--card,#fff);color:var(--ink,#17262b);border-radius:18px;padding:16px;max-width:420px;width:100%;font:14px/1.45 system-ui,sans-serif;max-height:80vh;overflow:auto}#scSheet h3{margin:0 0 8px;font-size:17px}#scSheet button{margin:8px 8px 0 0;padding:10px 14px;border-radius:12px;border:0;background:var(--sec,#2f6fe4);color:#fff;font-weight:600;min-height:44px}#scSheet button.g{background:#8883;color:inherit}#scSheet .m{opacity:.75;font-size:12.5px;word-break:break-word}';
      document.head && document.head.appendChild(st);
      el = document.createElement('div'); el.id = 'scSync'; el.setAttribute('role', 'status');
      el.onclick = openSheet; document.body.appendChild(el);
    }
    var s = STATUS.s;
    if (!C || s === 'idle') { el.style.display = 'none'; return; }
    el.style.display = '';
    var t = TXT[s] || TXT.saved;
    el.textContent = (s === 'saved' ? '✓ ' : s === 'saving' ? '↻ ' : s === 'error' ? '⚠ ' : '☁ ') + L3(t[0], t[1], t[2]);
    el.className = s === 'saved' ? 'ok' : (s === 'error') ? 'err' : (s === 'pending' || s === 'offline' || s === 'photos') ? 'warn' : '';
    clearTimeout(el._d); if (s === 'saved') el._d = setTimeout(function () { el.classList.add('dim'); }, 4000);
  }
  function fmtT(t) { try { return t ? new Date(t).toLocaleString() : '—'; } catch (e) { return '—'; } }
  function openSheet() {
    if (typeof document === 'undefined' || !document.createElement) return;
    var old = document.getElementById('scSheetBg'); if (old) old.remove();
    var bg = document.createElement('div'); bg.id = 'scSheetBg';
    var esc2 = function (x) { return String(x == null ? '' : x).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
    var t = TXT[STATUS.s] || TXT.saved;
    bg.innerHTML = '<div id="scSheet"><h3>' + L3('Cloud sync', 'Synchronisation cloud', 'مزامنة السحابة') + '</h3>' +
      '<div><b>' + esc2(L3(t[0], t[1], t[2])) + '</b></div>' +
      '<div class="m">' + L3('Last confirmed by Firebase: ', 'Dernière confirmation Firebase : ', 'آخر تأكيد من Firebase: ') + esc2(fmtT(lastSync)) + '</div>' +
      '<div class="m">' + L3('Changes waiting to upload: ', 'Modifications en attente : ', 'تغييرات بانتظار الرفع: ') + (isPend() ? L3('yes', 'oui', 'نعم') : L3('none', 'aucune', 'لا يوجد')) + '</div>' +
      '<div class="m">' + L3('Photos waiting: ', 'Photos en attente : ', 'صور بانتظار الرفع: ') + photosPending + '</div>' +
      (storageState ? '<div class="m">' + esc2(storageState) + '</div>' : '') +
      (STATUS.detail ? '<div class="m">' + esc2(STATUS.detail) + '</div>' : '') +
      '<div><button id="scNow">' + L3('Sync now', 'Synchroniser', 'مزامنة الآن') + '</button><button id="scTest" class="g">' + L3('Test photo storage', 'Tester le stockage photo', 'اختبار تخزين الصور') + '</button><button id="scX" class="g">' + L3('Close', 'Fermer', 'إغلاق') + '</button></div></div>';
    bg.onclick = function (e) { if (e.target === bg) bg.remove(); };
    document.body.appendChild(bg);
    var q = function (id) { return document.getElementById(id); };
    q('scX').onclick = function () { bg.remove(); };
    q('scNow').onclick = function () { bg.remove(); CORE.syncNow(); };
    q('scTest').onclick = async function () { var r = await CORE.checkStorage(); bg.remove(); openSheet(); if (typeof toast === 'function') toast(r.ok ? L3('Photo storage works', 'Le stockage photo fonctionne', 'تخزين الصور يعمل') : L3('Photo storage problem', 'Problème de stockage photo', 'مشكلة في تخزين الصور')); };
  }

  /* ======================================================================
     Local edits: stamp edited records, mark pending, schedule push
     ====================================================================== */
  function stamp() {
    var snap = snapshot(S), cols = colsOf(S), now = Date.now();
    S._at = S._at || {};
    cols.forEach(function (col) {
      (getPath(S, col) || []).forEach(function (r) { if (isRec(r) && (LH.c[col] || {})[r.id] !== snap.c[col][r.id]) r._u = now; });
    });
    Object.keys(snap.a).forEach(function (p) { if (LH.a[p] !== snap.a[p]) S._at[p] = now; });
    Object.keys(LH.a).forEach(function (p) { if (!(p in snap.a)) S._at[p] = now; });
    LH = snap;
  }
  CORE.active = function () { return !!C; };
  CORE.onSave = function () {
    if (!C || !S) return;
    try { stamp(); } catch (e) { }
    saveSeq++; setPend(); setStatus('saving'); schedulePush(700);
  };
  function schedulePush(ms) { clearTimeout(timer); timer = setTimeout(function () { pushNow(); }, ms); }

  /* ======================================================================
     Photos -> Firebase Storage
     ====================================================================== */
  async function sha(s) {
    try { var buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)); return Array.prototype.map.call(new Uint8Array(buf), function (b) { return ('0' + b.toString(16)).slice(-2); }).join('').slice(0, 40); }
    catch (e) { return h32(s).replace('.', '') + h32(s.split('').reverse().join('')).replace('.', ''); }
  }
  function dataToBytes(u) {
    var i = u.indexOf(','), bin = atob(u.slice(i + 1)), a = new Uint8Array(bin.length), k;
    for (k = 0; k < bin.length; k++) a[k] = bin.charCodeAt(k);
    return { bytes: a, type: (u.slice(5, i).split(';')[0]) || 'image/jpeg' };
  }
  function bucket() { return (typeof FB !== 'undefined' && FB.storageBucket) || (G.firebase && firebase.app().options.storageBucket); }
  function restUrl(path) { return 'https://firebasestorage.googleapis.com/v0/b/' + bucket() + '/o/' + encodeURIComponent(path); }
  function fetchFn() { return G.CapacitorWebFetch || G.fetch.bind(G); }
  async function restPut(path, dataUrl) {
    var d = dataToBytes(dataUrl), tok = await C.u.getIdToken();
    var r = await fetchFn()('https://firebasestorage.googleapis.com/v0/b/' + bucket() + '/o?name=' + encodeURIComponent(path), { method: 'POST', headers: { Authorization: 'Firebase ' + tok, 'Content-Type': d.type }, body: new Blob([d.bytes], { type: d.type }) });
    if (!r.ok) { var e = new Error('storage http ' + r.status); e.code = 'storage/http-' + r.status; throw e; }
    var j = await r.json(), t = j.downloadTokens;
    if (!t) { var m = await (await fetchFn()(restUrl(path), { headers: { Authorization: 'Firebase ' + tok } })).json(); t = m.downloadTokens; }
    return { path: path, url: restUrl(path) + '?alt=media&token=' + String(t || '').split(',')[0] };
  }
  async function sdkPut(path, dataUrl) {
    var ref = firebase.storage().ref(path);
    await ref.putString(dataUrl, 'data_url', { contentType: dataToBytes(dataUrl).type, cacheControl: 'private,max-age=31536000' });
    return { path: path, url: await ref.getDownloadURL() };
  }
  async function putPhoto(dataUrl) {
    var sig = await sha(dataUrl), path = 'users/' + C.u.uid + '/toys/' + sig + '.jpg';
    if (PH[sig] && PH[sig].path === path) return Object.assign({ sig: sig }, PH[sig]);         // already uploaded: no duplicate
    var r;
    if (G.firebase && firebase.storage) {
      try { r = await tmo(sdkPut(path, dataUrl), 60000); }
      catch (e) { if (/unauthorized|unauthenticated|quota|canceled/i.test((e && e.code) || '')) throw e; r = await tmo(restPut(path, dataUrl), 60000); }
    } else r = await tmo(restPut(path, dataUrl), 60000);
    PH[sig] = r; lsSet(kPH(), JSON.stringify(PH));
    return Object.assign({ sig: sig }, r);
  }
  async function delPhoto(path) {
    try { if (G.firebase && firebase.storage) await tmo(firebase.storage().ref(path).delete(), 30000); else throw new Error('nosdk'); }
    catch (e) {
      if (e && /object-not-found/.test(e.code || '')) return true;
      var tok = await C.u.getIdToken(), r = await fetchFn()(restUrl(path), { method: 'DELETE', headers: { Authorization: 'Firebase ' + tok } });
      if (!r.ok && r.status !== 404) throw new Error('delete ' + r.status);
    }
    return true;
  }
  async function uploadPhotos() {
    var toys = (S.toys || []).slice(), fails = 0;
    for (var i = 0; i < toys.length; i++) {
      var t = toys[i];
      if (!t || typeof t.img !== 'string' || t.img.indexOf('data:') !== 0) continue;
      try {
        var r = await putPhoto(t.img), cur = (S.toys || []).find(function (x) { return x.id === t.id; });
        if (cur && cur.img === t.img) { cur.img = r.url; cur.imgPath = r.path; cur.imgH = r.sig; (LH.c.toys = LH.c.toys || {})[cur.id] = H(cur); }
        storageState = L3('Photo storage: working', 'Stockage photo : OK', 'تخزين الصور: يعمل');
      } catch (e) { fails++; lastPhotoErr = e; storageState = L3('Photo upload failed: ', 'Échec d’envoi photo : ', 'فشل رفع الصورة: ') + ((e && (e.code || e.message)) || ''); }
    }
    photosPending = (S.toys || []).filter(function (x) { return x && typeof x.img === 'string' && x.img.indexOf('data:') === 0; }).length;
    persistLocal();
    return fails;
  }
  async function cleanupOrphans(committed) {
    var refd = {};
    (S.toys || []).concat((committed && committed.toys) || []).forEach(function (t) { if (t && t.imgPath) refd[t.imgPath] = 1; });
    var known = getKnown(), keep = [];
    for (var i = 0; i < known.length; i++) {
      var p = known[i];
      if (refd[p]) { keep.push(p); continue; }
      try { await delPhoto(p); Object.keys(PH).forEach(function (k) { if (PH[k] && PH[k].path === p) delete PH[k]; }); lsSet(kPH(), JSON.stringify(PH)); } catch (e) { keep.push(p); }
    }
    setKnown(keep);
  }

  /* ======================================================================
     Cloud documents
     ====================================================================== */
  function parseRemote(dS, tS) {
    if (!dS || !dS.exists) return null;
    var d = dS.data(), R;
    try { R = JSON.parse(d.json); } catch (e) { return null; }
    if (R.toysDoc) { R.toys = []; if (tS && tS.exists) { try { R.toys = JSON.parse(tS.data().json) || []; } catch (e) { } } }
    return { R: R, t: Math.max(+d.t || 0, (tS && tS.exists && +tS.data().t) || 0) };
  }
  function cloudPayload(M) {              // what goes to Firestore: never Base64 photos
    var P = clone(M); delete P._tmp;
    (P.toys || []).forEach(function (t) { if (t && typeof t.img === 'string' && t.img.indexOf('data:') === 0) { t.img = ''; t.imgPend = 1; } });
    return P;
  }

  async function commit() {
    var out = {};
    var refData = C.refData, refToys = C.refToys, refBak = C.refBak;
    await tmo(C.db.runTransaction(async function (tx) {
      var dS = await tx.get(refData), tS = await tx.get(refToys), rr = parseRemote(dS, tS);
      var L = cloudPayload(S), M, noWrite = false;
      if (!rr) {
        if (isEmpty(L)) { out = { skip: 1 }; return; }          // never create an empty cloud database
        M = L;
      } else if (isEmpty(L) && recCount(rr.R) > 0 && baseCount() >= 3) {
        M = rr.R; noWrite = true; out.blocked = 1;               // local suddenly empty but we had data: restore, never wipe
      } else M = merge(BASE, L, rr.R);
      var rt = rr ? rr.t : 0, t = Math.max(Date.now(), rt + 1);
      var main = JSON.stringify(Object.assign({}, M, { toys: [], toysDoc: 1 }));
      if (main.length > MAX_DOC_CHARS) { var e = new Error('Cloud document is almost full (1 MB limit)'); e.code = 'size'; throw e; }
      var toysJson = JSON.stringify(M.toys || []);
      if (!noWrite) {
        if (rr && Date.now() - (+lsGet('sc_bak_t') || 0) > BACKUP_EVERY_MS) tx.set(refBak, { json: dS.data().json, t: dS.data().t, saved: Date.now(), by: devId });
        if (!tS.exists || tS.data().json !== toysJson) tx.set(refToys, { json: toysJson, t: t, v: 2, by: devId });
        tx.set(refData, { json: main, t: t, v: 2, by: devId });
      }
      out = { M: M, Lsnap: snapshot(L), t: noWrite ? rt : t, noWrite: noWrite, bak: !noWrite && rr && Date.now() - (+lsGet('sc_bak_t') || 0) > BACKUP_EVERY_MS, blocked: out.blocked };
    }), 25000);
    if (out.bak) lsSet('sc_bak_t', String(Date.now()));
    return out;
  }
  function baseCount() { var n = 0; Object.keys(BASE.c || {}).forEach(function (c) { n += Object.keys(BASE.c[c]).length; }); return n; }

  var classify = function (e) {
    var c = String((e && (e.code || e.message)) || '');
    if (/size/i.test(c)) return 'error';
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return 'offline';
    if (/unavailable|network|offline|timeout|deadline|aborted|failed to get/i.test(c)) return 'offline';
    return 'error';
  };

  async function pushNow() {
    if (!C || !S) return;
    if (running) { again = true; return; }
    running = true; var seq = saveSeq, ctx = C;
    clearTimeout(retryTimer);
    if (STATUS.s !== 'saving') setStatus('saving');
    try {
      var fails = await uploadPhotos();
      var out;
      try { out = await commit(); }
      catch (e) {
        if (/permission|unauthenticated/i.test((e && e.code) || '')) { await ctx.u.getIdToken(true); out = await commit(); }   // token/email_verified claim may be stale
        else throw e;
      }
      if (C !== ctx) return;
      if (out.skip) { lastSync = Date.now(); if (saveSeq === seq) clrPend(); setStatus('saved'); retryN = 0; return; }
      lastErr = null; lastSync = Date.now(); retryN = 0;
      var M = out.M;
      trackPaths(M.toys);
      /* fold the confirmed cloud state back in: base = what we sent, so cloud-side additions are adopted and edits made while writing are kept */
      var Snew = out.blocked ? clone(M) : merge(out.Lsnap, S, M), changed = stable(norm(Snew)) !== stable(norm(S));
      saveBase(M, out.t);
      CORE.lastT = Math.max(CORE.lastT || 0, out.t);
      if (changed) { S = Snew; afterExternal(); }
      persistLocal();
      if (saveSeq === seq && !out.blocked) clrPend();
      if (saveSeq !== seq) { schedulePush(300); }
      await cleanupOrphans(M).catch(function () { });
      if (out.blocked) { setStatus('error', L3('Local data was empty: restored from cloud instead of overwriting it.', 'Données locales vides : restaurées depuis le cloud.', 'البيانات المحلية فارغة: تمت الاستعادة من السحابة.')); }
      else if (fails || photosPending) { setStatus('photos', storageState); retryLater(); }
      else setStatus('saved');
    } catch (e) {
      if (C !== ctx) return;
      lastErr = e; var k = classify(e);
      setStatus(k === 'offline' ? 'offline' : 'error', String((e && (e.code || e.message)) || ''));
      retryLater();
    } finally {
      running = false;
      if (again) { again = false; schedulePush(300); }
      if (C && C.queued) { C.queued = 0; onRemote(); }
    }
  }
  function retryLater() {
    clearTimeout(retryTimer);
    var d = Math.min(300000, 5000 * Math.pow(3, retryN++));
    retryTimer = setTimeout(function () { if (C && (isPend() || photosPending)) pushNow(); }, d);
  }
  CORE.syncNow = function () { retryN = 0; return pushNow(); };
  CORE.push = async function () { if (!C) throw new Error('offline'); await pushNow(); };   // keeps the old entry point working
  CORE.afterPull = async function () { };                                                       // superseded by initialSync

  /* ======================================================================
     Pull + live listeners
     ====================================================================== */
  function busyUI() {
    if (typeof document === 'undefined') return false;
    var a = document.activeElement;
    if (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName || '')) return true;
    return !!(document.getElementById && document.getElementById('sh'));
  }
  function refreshUI() {
    if (typeof go !== 'function' || typeof U === 'undefined' || !U) return;
    var sh = document.getElementById && document.getElementById('shell'); if (!sh || sh.hidden) return;
    if (busyUI()) {
      pendingRefresh = true;
      if (!refreshTimer) refreshTimer = setInterval(function () { if (!busyUI()) { clearInterval(refreshTimer); refreshTimer = null; pendingRefresh = false; try { go(); } catch (e) { } } }, 1500);
      return;
    }
    try { go(); toast(L3('Updated from your other device', 'Mis à jour depuis votre autre appareil', 'تم التحديث من جهازك الآخر')); } catch (e) { }
  }
  function afterExternal() {
    try { if (typeof mig === 'function') mig(); } catch (e) { }
    try {                                               // synced preferences + activity counters -> this device
      if (SYNC_UI_PREFS && S.prefs && typeof PR !== 'undefined') {
        var np = { lang: S.prefs.lang, theme: S.prefs.theme };
        if (np.lang && (np.lang !== PR.lang || np.theme !== PR.theme)) { PR.lang = np.lang; PR.theme = np.theme || PR.theme; lsSet('ortho_pref', JSON.stringify(PR)); if (typeof applyPref === 'function') applyPref(); }
        seenPref = stable({ lang: PR.lang, theme: PR.theme });
      }
      if (S.runs && isPlain(S.runs)) lsSet('speechcare_activity_runs', JSON.stringify(S.runs));
    } catch (e) { }
    persistLocal(); LH = snapshot(S);
    refreshUI();
  }
  function integrate(R, t, force) {
    if (!force && t <= (BASE.t || 0)) return false;          // stale / already-integrated snapshot
    if (BASE.none && !lsGet(K + '_prebackup')) lsSet(K + '_prebackup', JSON.stringify(S));   // one-time safety copy before first merge
    var M2 = merge(BASE, S, R), changed = stable(norm(M2)) !== stable(norm(S));
    saveBase(R, t); CORE.lastT = Math.max(CORE.lastT || 0, t);
    trackPaths(R.toys);
    if (changed) { S = M2; afterExternal(); }
    if (stable(norm(M2)) !== stable(norm(R))) { setPend(); schedulePush(500); }       // we hold changes the cloud lacks
    else if (!photosPending) { clrPend(); }
    return changed;
  }
  var remoteTimer = null;
  function onRemote() {
    if (!C || !C.rData || !C.rToys) return;
    clearTimeout(remoteTimer);
    remoteTimer = setTimeout(function () {
      if (!C) return;
      if (running) { C.queued = 1; return; }
      var rr = parseRemote(C.rData, C.rToys); if (!rr) return;
      if (integrate(rr.R, rr.t, false)) setStatus(isPend() ? 'pending' : 'saved');
    }, 250);
  }
  function attach() {
    var onS = function (which) {
      return function (snap) {
        if (snap.metadata && (snap.metadata.hasPendingWrites || snap.metadata.fromCache)) return;
        C[which] = snap; onRemote();
      };
    };
    var onE = function (e) { if (/permission/i.test((e && e.code) || '')) setStatus('error', String(e.code)); };
    C.unsubs.push(C.refData.onSnapshot(onS('rData'), onE));
    C.unsubs.push(C.refToys.onSnapshot(onS('rToys'), onE));
  }

  CORE.initialSync = async function (db, u) {
    CORE.stop(true);
    var base = 'users/' + u.uid + '/app/';
    C = { db: db, u: u, refData: db.doc(base + 'data'), refToys: db.doc(base + 'toys'), refBak: db.doc(base + 'backup'), unsubs: [], rData: null, rToys: null };
    loadBase(); loadPH(); LH = snapshot(S);
    var ok = true;
    try {
      var ds = await tmo(Promise.all([C.refData.get({ source: 'server' }), C.refToys.get({ source: 'server' })]), 9000);
      var rr = parseRemote(ds[0], ds[1]);
      if (rr) integrate(rr.R, rr.t, true);
      else if (!isEmpty(S)) { setPend(); }               // legacy local-only data: upload it (never an empty state)
    } catch (e) {
      ok = false;
      if (typeof toast === 'function') toast(L3('Offline: showing data saved on this device.', 'Hors ligne : données de cet appareil.', 'بدون اتصال: عرض البيانات المحفوظة على الجهاز.'));
    }
    attach();
    setStatus(ok ? (isPend() ? 'pending' : 'saved') : 'offline');
    if (isPend()) schedulePush(ok ? 400 : 8000);
    return ok;
  };
  CORE.ready = function () {                                  // called at the end of enter(), after mig()
    if (!C || !S) return;
    LH = snapshot(S);
    seenPref = stable({ lang: (typeof PR !== 'undefined') ? PR.lang : '', theme: (typeof PR !== 'undefined') ? PR.theme : '' });
    var cur = snapshot(S), diff = stable(cur.c) !== stable(BASE.c) || stable(cur.a) !== stable(BASE.a);
    if (diff && !BASE.none) { setPend(); schedulePush(800); }
    else if (BASE.none && !isEmpty(S)) { setPend(); schedulePush(800); }
    drawPill();
  };
  CORE.stop = function (quiet) {
    if (C) { C.unsubs.forEach(function (f) { try { f(); } catch (e) { } }); }
    clearTimeout(timer); clearTimeout(retryTimer); clearTimeout(remoteTimer);
    C = null; running = false; again = false;
    if (!quiet) { STATUS = { s: 'idle', detail: '' }; try { drawPill(); } catch (e) { } }
  };

  /* ---- Storage health check (real upload + download URL + delete of a 1-pixel image) ---- */
  CORE.checkStorage = async function () {
    if (!C) return { ok: false, why: 'not signed in' };
    var png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
    var path = 'users/' + C.u.uid + '/_probe_' + Date.now() + '.png';
    try {
      var r = G.firebase && firebase.storage ? await tmo(sdkPut(path, png), 30000) : await tmo(restPut(path, png), 30000);
      var res = await tmo(fetchFn()(r.url), 20000);
      if (!res.ok) throw new Error('download http ' + res.status);
      await delPhoto(path);
      storageState = L3('Photo storage: working (upload, download and delete verified)', 'Stockage photo : OK (envoi, lecture, suppression vérifiés)', 'تخزين الصور: يعمل (تم التحقق من الرفع والتنزيل والحذف)');
      return { ok: true };
    } catch (e) {
      var code = (e && (e.code || e.message)) || 'unknown';
      storageState = L3('Photo storage NOT working (' + code + '). In Firebase Console open Build → Storage → Get started, then publish storage.rules.', 'Stockage photo NON fonctionnel (' + code + '). Console Firebase : Build → Storage → Commencer, puis publiez storage.rules.', 'تخزين الصور لا يعمل (' + code + '). في وحدة تحكم Firebase: Build → Storage → Get started ثم انشر storage.rules.');
      return { ok: false, why: code };
    }
  };

  /* ---- wire-up: preferences, activity counters, logout, connectivity ---- */
  var _ap = G.applyPref;
  if (typeof _ap === 'function') G.applyPref = function () {
    var r = _ap.apply(this, arguments);
    try {
      if (SYNC_UI_PREFS && C && S && typeof PR !== 'undefined') {
        var cur = stable({ lang: PR.lang, theme: PR.theme });
        if (seenPref && cur !== seenPref) { seenPref = cur; S.prefs = { lang: PR.lang, theme: PR.theme }; if (typeof save === 'function') save(); }
      }
    } catch (e) { }
    return r;
  };
  var _ar = G.actRecord;
  if (typeof _ar === 'function') G.actRecord = function () {
    var r = _ar.apply(this, arguments);
    try { if (C && S) { var o = JSON.parse(lsGet('speechcare_activity_runs') || '{}'); S.runs = o; if (typeof save === 'function') save(); } } catch (e) { }
    return r;
  };
  var _lo = G.logout;
  if (typeof _lo === 'function') G.logout = async function () {
    try { if (C && isPend()) await tmo(pushNow(), 5000); } catch (e) { }
    try { CORE.stop(); } catch (e) { }
    return _lo.apply(this, arguments);
  };
  var resume = function () { if (C && (isPend() || photosPending)) { retryN = 0; pushNow(); } };
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('online', function () { if (C) { setStatus(isPend() ? 'saving' : STATUS.s); resume(); } });
    window.addEventListener('offline', function () { if (C && isPend()) setStatus('offline'); });
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') resume(); });
    try { var A = G.Capacitor && Capacitor.Plugins && Capacitor.Plugins.App; if (A && A.addListener) A.addListener('appStateChange', function (s) { if (s && s.isActive) resume(); }); } catch (e) { }
    setInterval(function () { if (C && !running && (isPend() || photosPending) && navigator.onLine !== false) pushNow(); }, 60000);
  }

  CORE._t = { merge: merge, snapshot: snapshot, stable: stable, H: H, mergeCol: mergeCol, status: function () { return { s: STATUS.s, detail: STATUS.detail, pend: C ? isPend() : null, photosPending: photosPending, lastSync: lastSync }; }, _setS: function (x) { S = x; } };
})();
