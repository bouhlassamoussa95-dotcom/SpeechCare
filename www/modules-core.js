/* ==========================================================================
   SpeechCare care modules (loaded after the main script; wraps globals, never
   rewrites index.html wholesale).
   Phase 4  workplaces + compact patient directory + location filters
   Phase 5  treatment programs, next-appointment-only recurrence
   Phase 6  structured session completion -> immutable reports
   Phase 7  workplace finance with per-session snapshots
   Data     non-destructive idempotent migration, toy photos in a second doc,
            "warn before overwriting newer cloud data"
   ========================================================================== */
(function () {
  'use strict';
  var doc = document;
  var qa = function (s, r) { return Array.prototype.slice.call((r || doc).querySelectorAll(s)); };
  var q = function (s, r) { return (r || doc).querySelector(s); };
  var L3 = function (en, fr, ar) { var l = PR.lang; return l === 'fr' ? fr : l === 'ar' ? ar : en; };
  var X = function (s) { return esc(s == null ? '' : s); };
  var iso = function () { return new Date().toISOString(); };
  var fmtD = function (ds) { return ds ? new Date(ds + 'T12:00').toLocaleDateString(LCS[PR.lang], { weekday: 'short', day: 'numeric', month: 'short' }) : '—'; };
  var wdName = function (d) { return new Date(2024, 0, 7 + d).toLocaleDateString(LCS[PR.lang], { weekday: 'short' }); };
  var WORDER = [1, 2, 3, 4, 5, 6, 0];
  var CORE = {};

  /* ============================================================ workplaces */
  function hash(s) { var h = 5381, i; for (i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return h.toString(36); }
  var wpById = function (id) { return id ? S.me.places.find(function (x) { return x.id === id; }) : null; };
  var wpByName = function (n) { return n ? S.me.places.find(function (x) { return x.n === n; }) : null; };
  var WTYPES = [['daycare', 'Daycare', 'Crèche', 'روضة'], ['center', 'Therapy center', 'Centre de thérapie', 'مركز علاجي'], ['school', 'School', 'École', 'مدرسة'], ['hospital', 'Hospital', 'Hôpital', 'مستشفى'], ['private', 'Private practice', 'Cabinet privé', 'عيادة خاصة'], ['company', 'Company', 'Entreprise', 'شركة'], ['other', 'Other', 'Autre', 'أخرى']];
  var wtLabel = function (t) { var r = WTYPES.find(function (x) { return x[0] === t; }); return r ? L3(r[1], r[2], r[3]) : (t || ''); };
  var patWps = function (p) { return [p.wpId].concat(p.wpExtra || []).filter(Boolean); };
  var inWp = function (p, f) { return f === 'all' || !f || (f === 'none' ? !p.wpId : patWps(p).indexOf(f) >= 0); };
  CORE.wpById = wpById; CORE.wpByName = wpByName;

  /* ============================================================ programs */
  function endOf(pr) {
    if (!pr) return '';
    if (pr.end) return pr.end;
    if (!pr.start || !(+pr.dur > 0)) return '';
    var d = new Date(pr.start + 'T12:00');
    if (pr.unit === 'months') d.setMonth(d.getMonth() + (+pr.dur)); else d.setDate(d.getDate() + 7 * (+pr.dur));
    d.setDate(d.getDate() - 1);
    return d.toLocaleDateString('en-CA');
  }
  function expectedFor(p) {
    var pr = p.prog;
    if (pr && pr.days && pr.days.length && pr.start) {
      var end = endOf(pr), n = 0, d = pr.start, i;
      if (!end || end < pr.start) return 0;
      for (i = 0; i < 1200 && d <= end; i++) { if (pr.days.indexOf(new Date(d + 'T12:00').getDay()) >= 0) n++; d = addD(d, 1); }
      return n;
    }
    return exp(p);
  }
  function doneOf(p) { var st = p.prog && p.prog.start; return S.a.filter(function (a) { return a.pid === p.id && a.status === 'done' && (!st || a.date >= st); }); }
  function nextDate(p, from) {
    var pr = p.prog; if (!pr || pr.status !== 'active') return '';
    var end = endOf(pr), i, d;
    if (pr.days && pr.days.length) {
      for (i = 1; i <= 400; i++) { d = addD(from, i); if (end && d > end) return ''; if (pr.days.indexOf(new Date(d + 'T12:00').getDay()) >= 0) return d; }
      return '';
    }
    var f = Math.max(1, +pr.freq || 1), step = pr.per === 'day' ? 1 : pr.per === 'month' ? Math.round(30 / f) : Math.max(1, Math.round(7 / f));
    d = addD(from, step); return end && d > end ? '' : d;
  }
  var upcoming = function (pid) { return S.a.filter(function (a) { return a.pid === pid && a.status === 'scheduled' && a.date >= td(); }).sort(function (x, y) { return (x.date + x.time).localeCompare(y.date + y.time); }); };
  var lastReports = function (pid) { return (S.sr || []).filter(function (r) { return r.pid === pid; }).sort(function (x, y) { return (y.date + y.time).localeCompare(x.date + x.time); }); };
  CORE.expected = expectedFor; CORE.nextDate = nextDate; CORE.upcoming = upcoming; CORE.endOf = endOf; CORE.doneOf = doneOf;

  function legacyProg(p) { return { freq: +p.fn || 0, per: p.fu || 'week', days: [], time: '', start: p.start || '', dur: +p.dv || 0, unit: p.du || 'weeks', end: '', status: 'active', legacy: true, log: [] }; }
  function syncPatient(p) {
    var w = wpByName(p.place); if (w && p.wpId !== w.id) p.wpId = w.id;
    if (!Array.isArray(p.wpExtra)) p.wpExtra = [];
    p.wpExtra = p.wpExtra.filter(function (id) { return id !== p.wpId; });
    if (!p.prog) p.prog = legacyProg(p);
    var pr = p.prog;
    if (!pr.days || !pr.days.length) { pr.legacy = true; pr.freq = +p.fn || pr.freq || 0; pr.per = p.fu || pr.per || 'week'; pr.dur = +p.dv || pr.dur || 0; pr.unit = p.du || pr.unit || 'weeks'; if (p.start) pr.start = p.start; }
    else { p.fn = pr.days.length; p.fu = 'week'; if (pr.dur) { p.dv = pr.dur; p.du = pr.unit; } if (pr.start) p.start = pr.start; }
  }
  CORE.syncPatient = syncPatient;

  /* ============================================================ migration */
  CORE.migrate = function () {
    if (!S || !S.me) return;
    S.sr = S.sr || []; S.ai = S.ai || []; S.toys = S.toys || [];
    var used = {}; S.me.places.forEach(function (x) { if (x.id) used[x.id] = 1; });
    S.me.places.forEach(function (x) {
      if (!x.id) { var id = 'wp_' + hash(x.n || ''); while (used[id]) id += 'x'; x.id = id; used[id] = 1; }
      if (!x.type) x.type = x.t === 'daycare' ? 'daycare' : 'center';
      ['addr', 'notes', 'pay', 'payNotes'].forEach(function (k) { if (x[k] == null) x[k] = ''; });
    });
    S.p.forEach(syncPatient);
    S.a.forEach(function (a) {
      if (!a.placeId) { var w = wpByName(a.place); if (w) a.placeId = w.id; }
      if (!a.src) a.src = 'legacy';
      if (!a.progId) a.progId = 'pg_' + a.pid;
    });
  };

  /* ============================================================ finance */
  function finSnap(placeName, p) {
    var pl = wpByName(placeName) || {}, price = p && p.fee !== '' && p.fee != null && !isNaN(+p.fee) ? +p.fee : +(pl.fee) || 0, e = earn(price, placeName);
    return { price: e.price, mine: e.mine, owner: e.owner, mode: pl.mode || 'pct', pct: pl.my == null ? 100 : +pl.my, fixed: +pl.mine || 0, placeId: pl.id || '', place: placeName || '', cur: S.me.cur, at: iso() };
  }
  CORE.finSnap = finSnap;
  CORE.freezePlace = function (name) {
    var n = 0; S.a.forEach(function (a) { if (a.status === 'done' && a.place === name && !a.fin) { a.fin = finSnap(name, P(a.pid)); a.fin.frozen = 1; n++; } });
    return n;
  };
  CORE.freezeAll = function () { var n = 0; S.me.places.forEach(function (x) { n += CORE.freezePlace(x.n); }); if (n) save(); toast(L3(n + ' past session(s) now keep their current terms.', n + ' séance(s) passée(s) conservent maintenant leurs conditions actuelles.', 'تم تثبيت الشروط الحالية لـ ' + n + ' حصة سابقة.')); go(); };
  var _setPl = window.setPl, _rmPl = window.rmPl;
  if (typeof _setPl === 'function') window.setPl = function (i) { var p = S.me.places[i]; if (p && CORE.freezePlace(p.n)) save(); return _setPl.apply(this, arguments); };
  if (typeof _rmPl === 'function') window.rmPl = function (i) { var p = S.me.places[i]; if (p && CORE.freezePlace(p.n)) save(); return _rmPl.apply(this, arguments); };

  /* ============================================================ appointments */
  function mkAppt(o) {
    var dup = S.a.find(function (a) { return a.id === o.id || (a.pid === o.pid && a.date === o.date && a.time === o.time && a.status !== 'cancelled' && a.status !== 'rescheduled'); });
    if (dup) return dup;
    var a = { id: o.id || uid(), pid: o.pid, date: o.date, time: o.time, place: o.place || '', placeId: o.placeId || '', goal: o.goal || '', remark: '', status: 'scheduled', acts: o.acts || '', materials: o.materials || '', src: o.src || 'manual', progId: 'pg_' + o.pid };
    if (o.from) a.from = o.from;
    S.a.push(a); return a;
  }
  CORE.mkAppt = mkAppt;

  function wpSelect(id, selId) {
    return '<select id="' + id + '">' + S.me.places.map(function (w) { return '<option value="' + X(w.id) + '"' + (w.id === selId ? ' selected' : '') + '>' + X(w.n) + '</option>'; }).join('') + '</select>';
  }
  var val = function (id) { var e = q('#' + id); return e ? e.value.trim() : ''; };

  /* ---- schedule / prepare next appointment ---- */
  CORE.nextForm = function (pid, pre) {
    var p = P(pid); if (!p) return;
    pre = pre || {};
    var from = (lastReports(pid)[0] || {}).date || td(); if (from < td()) from = td();
    var date = pre.date || nextDate(p, from) || addD(td(), 1), time = pre.time || (p.prog && p.prog.time) || '10:00', wp = pre.placeId || p.wpId || '';
    sheet('<h2>' + L3('Next appointment', 'Prochain rendez-vous', 'الموعد القادم') + '</h2><div class="mut">' + full(p) + '</div>' +
      '<div class="row" style="flex-wrap:nowrap"><div style="flex:1"><label>' + L3('Date', 'Date', 'التاريخ') + '</label><input id="na_d" type="date" value="' + X(date) + '"></div><div style="flex:1"><label>' + L3('Time', 'Heure', 'الوقت') + '</label><input id="na_t" type="time" value="' + X(time) + '"></div></div>' +
      '<label>' + L3('Workplace / location', 'Lieu de travail', 'مكان العمل') + '</label>' + wpSelect('na_w', wp) +
      '<label>' + L3('Goals', 'Objectifs', 'الأهداف') + '</label><textarea id="na_g" dir="auto">' + X(pre.goal) + '</textarea>' +
      '<label>' + L3('Activities', 'Activités', 'الأنشطة') + '</label><textarea id="na_a" dir="auto">' + X(pre.acts) + '</textarea>' +
      '<label>' + L3('Materials / preparation notes', 'Matériel / notes de préparation', 'الوسائل / ملاحظات التحضير') + '</label><textarea id="na_m" dir="auto">' + X(pre.materials) + '</textarea>' +
      '<div class="row" style="margin-top:8px"><button class="b" id="na_s" onclick="CORE.saveNext(\'' + pid + '\')">' + L3('Save appointment', 'Enregistrer', 'حفظ الموعد') + '</button><button class="b g" onclick="cs()">' + L3('Cancel', 'Annuler', 'إلغاء') + '</button></div>');
  };
  CORE.saveNext = function (pid) {
    var btn = q('#na_s'); if (btn) { if (btn.disabled) return; btn.disabled = true; }
    var p = P(pid), date = val('na_d'); if (!p || !date) { toast(L3('Pick a date', 'Choisissez une date', 'اختاري تاريخاً')); if (btn) btn.disabled = false; return; }
    var w = wpById(val('na_w')) || {};
    var ex = upcoming(pid)[0];
    if (ex && ex.date !== date) { /* an upcoming appointment already exists: update it instead of adding a second one */
      Object.assign(ex, { date: date, time: val('na_t') || ex.time, place: w.n || ex.place, placeId: w.id || ex.placeId, goal: val('na_g'), acts: val('na_a'), materials: val('na_m') });
    } else mkAppt({ id: 'na_pg_' + pid + '_' + date, pid: pid, date: date, time: val('na_t') || '10:00', place: w.n || p.place, placeId: w.id || '', goal: val('na_g'), acts: val('na_a'), materials: val('na_m'), src: 'program' });
    save(); cs(); go(); toast(L3('Appointment saved', 'Rendez-vous enregistré', 'تم حفظ الموعد'));
  };
  CORE.resched = function (aid) {
    var a = S.a.find(function (x) { return x.id === aid; }); if (!a) return;
    sheet('<h2>' + L3('Reschedule', 'Reprogrammer', 'إعادة جدولة') + '</h2><div class="mut">' + full(P(a.pid)) + ' · ' + fmtD(a.date) + ' ' + X(a.time) + '</div>' +
      '<div class="row" style="flex-wrap:nowrap"><div style="flex:1"><label>' + L3('New date', 'Nouvelle date', 'التاريخ الجديد') + '</label><input id="rs_d" type="date" value="' + X(a.date) + '"></div><div style="flex:1"><label>' + L3('Time', 'Heure', 'الوقت') + '</label><input id="rs_t" type="time" value="' + X(a.time) + '"></div></div>' +
      '<div class="mut" style="margin:6px 0">' + L3('The old appointment is kept as “Rescheduled” and never counts as completed.', 'L’ancien rendez-vous est conservé comme « Reprogrammé » et n’est jamais compté comme réalisé.', 'يبقى الموعد القديم بحالة «معاد جدولته» ولا يُحتسب حصة منجزة.') + '</div>' +
      '<div class="row"><button class="b" id="rs_s" onclick="CORE.doResched(\'' + aid + '\')">' + L3('Reschedule', 'Reprogrammer', 'إعادة الجدولة') + '</button><button class="b g" onclick="cs()">' + L3('Cancel', 'Annuler', 'إلغاء') + '</button></div>');
  };
  CORE.doResched = function (aid) {
    var btn = q('#rs_s'); if (btn) { if (btn.disabled) return; btn.disabled = true; }
    var a = S.a.find(function (x) { return x.id === aid; }), d = val('rs_d'), t = val('rs_t') || (a && a.time);
    if (!a || !d || (d === a.date && t === a.time)) { toast(L3('Choose a different date or time', 'Choisissez une autre date ou heure', 'اختاري تاريخاً أو وقتاً مختلفاً')); if (btn) btn.disabled = false; return; }
    if (a.status === 'scheduled') {
      a.status = 'rescheduled';
      mkAppt({ id: 'rs_' + a.id + '_' + d + '_' + t.replace(':', ''), pid: a.pid, date: d, time: t, place: a.place, placeId: a.placeId, goal: a.goal, acts: a.acts, materials: a.materials, src: a.src === 'legacy' ? 'legacy' : 'manual', from: a.id });
    }
    save(); cs(); go(); toast(L3('Rescheduled', 'Reprogrammé', 'تمت إعادة الجدولة'));
  };

  /* ============================================================ completion */
  var FIELDS = [
    ['acts', 'Activities performed', 'Activités réalisées', 'الأنشطة المنجزة'],
    ['goals', 'Goals addressed', 'Objectifs travaillés', 'الأهداف المعالجة'],
    ['resp', 'Patient response', 'Réponse du patient', 'استجابة المريض'],
    ['prog', 'Progress observed', 'Progrès observés', 'التقدم الملحوظ'],
    ['diff', 'Difficulties encountered', 'Difficultés rencontrées', 'الصعوبات المصادفة'],
    ['ach', 'Achievements', 'Réussites', 'الإنجازات'],
    ['obs', 'Clinical observations', 'Observations cliniques', 'الملاحظات السريرية'],
    ['rec', 'Recommendations for the next session', 'Recommandations pour la prochaine séance', 'توصيات للحصة القادمة']
  ];
  CORE.FIELDS = FIELDS;
  var fLabel = function (f) { return L3(f[1], f[2], f[3]); };
  CORE.openDone = function (aid) {
    var a = S.a.find(function (x) { return x.id === aid; }), p = a && P(a.pid); if (!a || !p) return;
    if ((S.sr || []).some(function (r) { return r.id === 'sr_' + a.id; })) { toast(L3('This session is already saved.', 'Cette séance est déjà enregistrée.', 'هذه الحصة محفوظة مسبقاً.')); return CORE.viewReport('sr_' + a.id); }
    var pr = p.prog, nd = nextDate(p, a.date > td() ? a.date : td()), canNext = !!nd && !upcoming(p.id).some(function (x) { return x.id !== a.id; });
    var pre = { acts: a.acts || '', goals: a.goal || '' };
    sheet('<h2>' + L3('Complete session', 'Terminer la séance', 'إنهاء الحصة') + '</h2><div class="mut">' + full(p) + ' · ' + fmtD(a.date) + ' ' + X(a.time) + '</div>' +
      '<label>' + L3('Workplace / location of this session', 'Lieu de cette séance', 'مكان هذه الحصة') + '</label>' + wpSelect('dr_w', a.placeId || (wpByName(a.place) || {}).id || p.wpId) +
      FIELDS.map(function (f) { return '<label>' + fLabel(f) + '</label><textarea id="dr_' + f[0] + '" dir="auto" style="min-height:64px">' + X(pre[f[0]] || '') + '</textarea>'; }).join('') +
      '<div class="card" style="margin:10px 0"><label class="row" style="flex-wrap:nowrap;margin:0"><input type="checkbox" id="dr_next"' + (canNext ? ' checked' : '') + ' onchange="$(\'#dr_nx\').hidden=!this.checked"><b>' + L3('Prepare the next appointment', 'Préparer le prochain rendez-vous', 'تحضير الموعد القادم') + '</b></label>' +
      '<div id="dr_nx"' + (canNext ? '' : ' hidden') + '><div class="row" style="flex-wrap:nowrap"><div style="flex:1"><label>' + L3('Date', 'Date', 'التاريخ') + '</label><input id="dr_nd" type="date" value="' + X(nd || addD(td(), 1)) + '"></div><div style="flex:1"><label>' + L3('Time', 'Heure', 'الوقت') + '</label><input id="dr_nt" type="time" value="' + X((pr && pr.time) || a.time || '10:00') + '"></div></div>' +
      '<label>' + L3('Workplace / location', 'Lieu', 'المكان') + '</label>' + wpSelect('dr_nw', p.wpId || a.placeId) +
      '<label>' + L3('Goals', 'Objectifs', 'الأهداف') + '</label><textarea id="dr_ng" dir="auto" style="min-height:50px"></textarea><label>' + L3('Activities', 'Activités', 'الأنشطة') + '</label><textarea id="dr_na" dir="auto" style="min-height:50px"></textarea><label>' + L3('Materials / preparation notes', 'Matériel / préparation', 'الوسائل / التحضير') + '</label><textarea id="dr_nm" dir="auto" style="min-height:50px"></textarea></div></div>' +
      '<div class="mut" style="margin-bottom:8px">' + L3('You can save without scheduling another appointment: untick the box above.', 'Vous pouvez enregistrer sans programmer de rendez-vous : décochez la case ci-dessus.', 'يمكنك الحفظ دون جدولة موعد آخر: ألغي تحديد المربع أعلاه.') + '</div>' +
      '<div class="row"><button class="b" id="dr_save" onclick="CORE.saveDone(\'' + a.id + '\')">' + L3('Save session', 'Enregistrer la séance', 'حفظ الحصة') + '</button><button class="b g" onclick="cs()">' + L3('Cancel', 'Annuler', 'إلغاء') + '</button></div>');
  };
  CORE.saveDone = function (aid) {
    var btn = q('#dr_save'); if (btn) { if (btn.disabled) return; btn.disabled = true; }          /* double-tap guard */
    var a = S.a.find(function (x) { return x.id === aid; }), p = a && P(a.pid); if (!a || !p) return;
    var rid = 'sr_' + a.id;
    if ((S.sr || []).some(function (r) { return r.id === rid; })) { cs(); go(); return; }          /* retry / double submit: never a second report */
    var w = wpById(val('dr_w')) || wpByName(a.place) || {}, f = {};
    FIELDS.forEach(function (x) { f[x[0]] = val('dr_' + x[0]); });
    var filled = Object.keys(f).some(function (k) { return f[k]; });
    if (!filled && !confirm(L3('Save this session without any clinical notes?', 'Enregistrer cette séance sans aucune note clinique ?', 'حفظ هذه الحصة دون أي ملاحظات سريرية؟'))) { if (btn) btn.disabled = false; return; }
    var place = w.n || a.place || '', fin = finSnap(place, p);
    S.sr = S.sr || [];
    S.sr.push({ id: rid, aid: a.id, pid: a.pid, progId: 'pg_' + a.pid, placeId: w.id || '', place: place, date: a.date, time: a.time, doneOn: td(), createdAt: iso(), f: f, fin: fin, rev: 1 });
    a.status = 'done'; a.rid = rid; a.place = place; a.placeId = w.id || a.placeId || ''; a.fin = fin;
    if (!a.remark) a.remark = f.obs || f.prog || ''; if (!a.goal) a.goal = f.goals || '';
    var nx = q('#dr_next'), msg = L3('Session saved', 'Séance enregistrée', 'تم حفظ الحصة');
    if (nx && nx.checked && val('dr_nd')) {
      var nw = wpById(val('dr_nw')) || {}, d = val('dr_nd'), t = val('dr_nt') || '10:00', ex = upcoming(a.pid).filter(function (x) { return x.id !== a.id; })[0];
      if (!ex) { mkAppt({ id: 'na_pg_' + a.pid + '_' + d, pid: a.pid, date: d, time: t, place: nw.n || p.place, placeId: nw.id || '', goal: val('dr_ng'), acts: val('dr_na'), materials: val('dr_nm'), src: 'program' }); msg += ' · ' + L3('next appointment ', 'prochain rdv ', 'الموعد القادم ') + fmtD(d); }
    }
    save(); cs(); go(); toast(msg);
  };
  CORE.viewReport = function (rid) {
    var r = (S.sr || []).find(function (x) { return x.id === rid; }); if (!r) return;
    var p = P(r.pid) || {}, fn = r.fin;
    sheet('<h2>' + L3('Session report', 'Compte rendu de séance', 'تقرير الحصة') + '</h2><div class="mut">' + full(p) + ' · ' + fmtD(r.date) + ' ' + X(r.time) + ' · ' + X(r.place) + '</div>' +
      FIELDS.filter(function (f) { return r.f[f[0]]; }).map(function (f) { return '<div class="card sec" style="--c:#16a39a"><label style="margin:0">' + fLabel(f) + '</label><div dir="auto" style="white-space:pre-wrap">' + X(r.f[f[0]]) + '</div></div>'; }).join('') +
      (fn ? '<div class="mut" style="margin:6px 0">' + L3('Financial basis saved with this session', 'Base financière enregistrée avec cette séance', 'الأساس المالي المحفوظ مع هذه الحصة') + ': ' + (fn.mode === 'fix' ? L3('fixed', 'fixe', 'مبلغ ثابت') + ' ' + money(fn.mine) : fn.pct + '% × ' + money(fn.price) + ' = ' + money(fn.mine)) + '</div>' : '') +
      '<button class="b g" onclick="cs()">' + L3('Close', 'Fermer', 'إغلاق') + '</button>');
  };
  var _setSt = window.setSt;
  if (typeof _setSt === 'function') window.setSt = function (id, s) {
    if (s === 'done') { var a = S.a.find(function (x) { return x.id == id; }); if (a && a.status !== 'done') { CORE.openDone(id); return; } }
    return _setSt.apply(this, arguments);
  };

  /* ============================================================ program UI */
  CORE.progForm = function (pid) {
    var p = P(pid); if (!p) return; var pr = p.prog || legacyProg(p);
    var days = pr.days || [];
    sheet('<h2>' + L3('Treatment program', 'Programme de traitement', 'برنامج العلاج') + '</h2><div class="mut">' + full(p) + '</div>' +
      '<label>' + L3('Workplace', 'Lieu de travail', 'مكان العمل') + '</label>' + wpSelect('pg_wp', p.wpId || (wpByName(p.place) || {}).id) +
      '<label>' + L3('Preferred weekdays (one session per selected day)', 'Jours préférés (une séance par jour choisi)', 'الأيام المفضلة (حصة واحدة لكل يوم)') + '</label><div class="row" style="gap:6px">' +
      WORDER.map(function (d) { return '<button type="button" class="pill pgd' + (days.indexOf(d) >= 0 ? ' on' : '') + '" data-d="' + d + '" onclick="this.classList.toggle(\'on\');CORE.pgUpd()">' + wdName(d) + '</button>'; }).join('') + '</div>' +
      '<div class="mut" id="pg_fq" style="margin:6px 0"></div>' +
      '<div id="pg_fw"' + (days.length ? ' hidden' : '') + '><label>' + L3('Sessions per week (if no weekdays chosen)', 'Séances par semaine (si aucun jour choisi)', 'حصص في الأسبوع (إن لم تُحدد أيام)') + '</label><input id="pg_freq" type="number" min="0" value="' + X(pr.freq || '') + '" oninput="CORE.pgUpd()"></div>' +
      '<div class="row" style="flex-wrap:nowrap"><div style="flex:1"><label>' + L3('Preferred time', 'Heure préférée', 'الوقت المفضل') + '</label><input id="pg_time" type="time" value="' + X(pr.time || '') + '"></div><div style="flex:1"><label>' + L3('Start date', 'Date de début', 'تاريخ البداية') + '</label><input id="pg_start" type="date" value="' + X(pr.start || p.start || td()) + '" oninput="CORE.pgUpd(1)"></div></div>' +
      '<div class="row" style="flex-wrap:nowrap"><div style="flex:1"><label>' + L3('Duration', 'Durée', 'المدة') + '</label><input id="pg_dur" type="number" min="1" value="' + X(pr.dur || 12) + '" oninput="CORE.pgUpd(1)"></div><div style="flex:1.2"><label>' + L3('Unit', 'Unité', 'الوحدة') + '</label><select id="pg_unit" onchange="CORE.pgUpd(1)"><option value="weeks"' + (pr.unit !== 'months' ? ' selected' : '') + '>' + L3('Weeks', 'Semaines', 'أسابيع') + '</option><option value="months"' + (pr.unit === 'months' ? ' selected' : '') + '>' + L3('Months', 'Mois', 'أشهر') + '</option></select></div></div>' +
      '<label>' + L3('End date (calculated, you can adjust it)', 'Date de fin (calculée, modifiable)', 'تاريخ النهاية (محسوب ويمكن تعديله)') + '</label><input id="pg_end" type="date" value="' + X(endOf(pr)) + '" data-auto="' + (pr.end ? 0 : 1) + '" oninput="this.dataset.auto=0;CORE.pgUpd()">' +
      '<div class="card" style="margin:10px 0"><b id="pg_exp"></b></div>' +
      '<div class="mut" style="margin-bottom:8px">' + L3('Changes never edit completed sessions or reports.', 'Les modifications ne changent jamais les séances ni les comptes rendus terminés.', 'التعديلات لا تغيّر الحصص أو التقارير المنجزة أبداً.') + '</div>' +
      '<div class="row"><button class="b" onclick="CORE.progSave(\'' + pid + '\')">' + L3('Save program', 'Enregistrer le programme', 'حفظ البرنامج') + '</button><button class="b g" onclick="cs()">' + L3('Cancel', 'Annuler', 'إلغاء') + '</button></div>');
    CORE.pgUpd();
  };
  function pgRead() {
    var days = qa('.pgd.on').map(function (x) { return +x.dataset.d; });
    return { days: days, start: val('pg_start'), dur: +val('pg_dur') || 0, unit: val('pg_unit') || 'weeks', end: val('pg_end'), freq: days.length || +val('pg_freq') || 0, time: val('pg_time') };
  }
  CORE.pgUpd = function (recalcEnd) {
    var r = pgRead(), e = q('#pg_end'); if (!e) return;
    if (recalcEnd) e.dataset.auto = 1;
    if (e.dataset.auto === '1') { r.end = ''; e.value = endOf(r); r.end = e.value; }
    var fw = q('#pg_fw'); if (fw) fw.hidden = r.days.length > 0;
    var fq = q('#pg_fq'); if (fq) fq.textContent = r.days.length ? (r.days.length + ' ' + L3('session(s) per week', 'séance(s) par semaine', 'حصة في الأسبوع')) : '';
    var tmp = { prog: { days: r.days, start: r.start, end: r.end, dur: r.dur, unit: r.unit, freq: r.freq, per: 'week' }, fn: r.freq, fu: 'week', dv: r.dur, du: r.unit };
    var n = expectedFor(tmp), x = q('#pg_exp');
    if (x) x.textContent = L3('Expected sessions: ', 'Séances prévues : ', 'عدد الحصص المتوقع: ') + n;
  };
  CORE.progSave = function (pid) {
    var p = P(pid), r = pgRead(); if (!p) return;
    if (!r.start) return toast(L3('Pick a start date', 'Choisissez une date de début', 'اختاري تاريخ البداية'));
    if (!r.days.length && !r.freq) return toast(L3('Choose weekdays or sessions per week', 'Choisissez des jours ou un nombre de séances par semaine', 'اختاري أياماً أو عدد الحصص في الأسبوع'));
    var pr = p.prog || legacyProg(p), w = wpById(val('pg_wp'));
    var before = { days: pr.days, start: pr.start, end: pr.end, freq: pr.freq };
    Object.assign(pr, { days: r.days, freq: r.freq, per: 'week', time: r.time, start: r.start, dur: r.dur, unit: r.unit, end: r.end, legacy: !r.days.length });
    pr.log = (pr.log || []).concat([{ t: iso(), ch: 'edit', from: before, to: { days: r.days, start: r.start, end: r.end, freq: r.freq } }]);
    p.prog = pr;
    if (w) { p.wpId = w.id; p.place = w.n; p.pt = w.t === 'daycare' ? 'daycare' : 'center'; }
    syncPatient(p); save(); cs(); go(); toast(L3('Program saved', 'Programme enregistré', 'تم حفظ البرنامج'));
  };
  CORE.pgStatus = function (pid, st) { var p = P(pid); if (!p || !p.prog) return; p.prog.status = st; p.prog.log = (p.prog.log || []).concat([{ t: iso(), ch: st }]); save(); go(); toast(st === 'paused' ? L3('Treatment paused', 'Traitement en pause', 'تم إيقاف العلاج مؤقتاً') : L3('Treatment resumed', 'Traitement repris', 'تم استئناف العلاج')); };
  CORE.pgShift = function (pid, days) {
    var p = P(pid); if (!p || !p.prog) return; var pr = p.prog, end = endOf(pr); if (!end) return toast(L3('Set an end date first (Edit program).', 'Définissez d’abord une date de fin (Modifier le programme).', 'حدّدي تاريخ النهاية أولاً (تعديل البرنامج).'));
    var ne = addD(end, days), last = (doneOf(p).map(function (a) { return a.date; }).sort().pop()) || pr.start || td();
    if (days < 0 && ne < (last > td() ? last : td())) return toast(L3('The program cannot end before today or the last completed session.', 'Le programme ne peut pas se terminer avant aujourd’hui ou la dernière séance réalisée.', 'لا يمكن أن ينتهي البرنامج قبل اليوم أو آخر حصة منجزة.'));
    pr.end = ne; pr.log = (pr.log || []).concat([{ t: iso(), ch: days > 0 ? 'extend' : 'shorten', end: ne }]); save(); go();
  };

  /* ---- profile blocks ---- */
  function progCard(p) {
    var pr = p.prog || legacyProg(p), exp_ = expectedFor(p), done = doneOf(p).length, rem = Math.max(0, exp_ - done), pct = exp_ ? Math.min(100, Math.round(done / exp_ * 100)) : 0, end = endOf(pr);
    var st = pr.status || 'active', stL = { active: L3('Active', 'Actif', 'نشط'), paused: L3('Paused', 'En pause', 'متوقف مؤقتاً'), ended: L3('Ended', 'Terminé', 'منتهٍ') }[st] || st;
    var freq = pr.days && pr.days.length ? pr.days.length + ' / ' + L3('week', 'semaine', 'أسبوع') + ' · ' + WORDER.filter(function (d) { return pr.days.indexOf(d) >= 0; }).map(wdName).join(', ') : fq(p);
    var dur = pr.dur ? pr.dur + ' ' + (pr.unit === 'months' ? L3('months', 'mois', 'أشهر') : L3('weeks', 'semaines', 'أسابيع')) : '—';
    var wps = patWps(p).map(function (id) { var w = wpById(id); return w ? '<span class="chip">' + ic('pin', 13) + ' ' + X(w.n) + (id === p.wpId ? ' ★' : '') + '</span>' : ''; }).join('');
    return '<div class="card sec" style="--c:#16a39a"><div class="row sp"><b>' + L3('Treatment program', 'Programme de traitement', 'برنامج العلاج') + '</b><span class="tag ' + (st === 'active' ? 't-done' : 't-cancelled') + '">' + stL + '</span></div>' +
      '<div class="chips">' + wps + '</div>' +
      '<div class="mut" style="margin-top:6px">' + X(freq) + (pr.time ? ' · ' + X(pr.time) : '') + '</div><div class="mut">' + fmtD(pr.start) + ' → ' + fmtD(end) + ' · ' + dur + '</div>' +
      '<div class="pgnums"><div><b>' + exp_ + '</b><span>' + L3('Expected', 'Prévues', 'المتوقعة') + '</span></div><div><b>' + done + '</b><span>' + L3('Completed', 'Réalisées', 'المنجزة') + '</span></div><div><b>' + rem + '</b><span>' + L3('Remaining', 'Restantes', 'المتبقية') + '</span></div></div>' +
      '<div class="bar"><div style="width:' + pct + '%"></div></div><div class="mut" style="margin:4px 0 8px">' + pct + '% · ' + L3('only completed sessions are counted', 'seules les séances réalisées sont comptées', 'تُحتسب الحصص المنجزة فقط') + '</div>' +
      '<div class="row"><button class="b g s" onclick="CORE.progForm(\'' + p.id + '\')">' + L3('Edit program', 'Modifier', 'تعديل البرنامج') + '</button>' +
      (st === 'paused' ? '<button class="b t s" onclick="CORE.pgStatus(\'' + p.id + '\',\'active\')">' + L3('Resume', 'Reprendre', 'استئناف') + '</button>' : '<button class="b g s" onclick="CORE.pgStatus(\'' + p.id + '\',\'paused\')">' + L3('Pause', 'Pause', 'إيقاف مؤقت') + '</button>') +
      '<button class="b g s" onclick="CORE.pgShift(\'' + p.id + '\',28)">' + L3('Extend 4 wk', 'Prolonger 4 sem.', 'تمديد 4 أسابيع') + '</button><button class="b g s" onclick="CORE.pgShift(\'' + p.id + '\',-28)">' + L3('Shorten 4 wk', 'Raccourcir 4 sem.', 'تقصير 4 أسابيع') + '</button></div></div>';
  }
  function nextCard(p) {
    var a = upcoming(p.id)[0], last = lastReports(p.id)[0];
    var prev = last ? '<div class="mut" style="margin-top:6px"><b>' + L3('Previous session', 'Séance précédente', 'الحصة السابقة') + ' (' + fmtD(last.date) + ')</b>' + (last.f.prog ? '<br>' + X(last.f.prog) : '') + (last.f.rec ? '<br><i>' + L3('Recommendation: ', 'Recommandation : ', 'توصية: ') + X(last.f.rec) + '</i>' : '') + '</div>' : '';
    if (!a) {
      var nd = nextDate(p, td());
      return '<div class="card sec" style="--c:#e8a33d"><b>' + L3('Next appointment', 'Prochain rendez-vous', 'الموعد القادم') + '</b><div class="mut" style="margin:4px 0 8px">' + L3('No appointment scheduled.', 'Aucun rendez-vous programmé.', 'لا يوجد موعد مجدول.') + (nd ? ' ' + L3('Suggested by the program: ', 'Proposé par le programme : ', 'يقترح البرنامج: ') + fmtD(nd) : '') + '</div>' + prev +
        '<div class="row" style="margin-top:8px"><button class="b s" onclick="CORE.nextForm(\'' + p.id + '\')">' + L3('Schedule next appointment', 'Programmer le prochain rendez-vous', 'جدولة الموعد القادم') + '</button><button class="b g s" onclick="CORE.progForm(\'' + p.id + '\')">' + L3('Review program', 'Revoir le programme', 'مراجعة البرنامج') + '</button></div></div>';
    }
    var today = a.date === td(), w = wpById(a.placeId) || wpByName(a.place) || {};
    return '<div class="card sec" style="--c:' + (today ? '#2fb872' : '#e8a33d') + '"><div class="row sp"><b>' + (today ? L3('Today’s appointment', 'Rendez-vous d’aujourd’hui', 'موعد اليوم') : L3('Next appointment', 'Prochain rendez-vous', 'الموعد القادم')) + '</b><span class="tag t-scheduled">' + fmtD(a.date) + ' · ' + X(a.time) + '</span></div>' +
      '<div class="mut">' + ic('pin', 13) + ' ' + X(w.n || a.place || '—') + '</div>' +
      (a.goal ? '<div style="margin-top:6px"><b>' + L3('Goals', 'Objectifs', 'الأهداف') + ':</b> <span dir="auto">' + X(a.goal) + '</span></div>' : '') +
      (a.acts ? '<div><b>' + L3('Activities', 'Activités', 'الأنشطة') + ':</b> <span dir="auto">' + X(a.acts) + '</span></div>' : '') +
      (today && a.materials ? '<div><b>' + L3('Materials required', 'Matériel requis', 'الوسائل المطلوبة') + ':</b> <span dir="auto">' + X(a.materials) + '</span></div>' : (!today && a.materials ? '<div class="mut">' + X(a.materials) + '</div>' : '')) +
      (today ? prev : '') +
      '<div class="row" style="margin-top:8px">' + (today ? '<button class="b s" onclick="setSt(\'' + a.id + '\',\'done\')">' + L3('Complete session', 'Terminer la séance', 'إنهاء الحصة') + '</button>' : '') +
      '<button class="b g s" onclick="CORE.resched(\'' + a.id + '\')">' + L3('Reschedule', 'Reprogrammer', 'إعادة جدولة') + '</button><button class="b g s" onclick="apForm(\'' + a.id + '\')">' + L3('Edit', 'Modifier', 'تعديل') + '</button></div></div>';
  }
  function historyCard(p) {
    var R = lastReports(p.id), AI = (S.ai || []).filter(function (x) { return x.pid === p.id; }).sort(function (x, y) { return y.at.localeCompare(x.at); });
    return '<h2>' + L3('Completed sessions and reports', 'Séances réalisées et comptes rendus', 'الحصص المنجزة والتقارير') + ' <span class="chip">' + R.length + '</span></h2>' +
      (R.map(function (r) {
        return '<div class="card apt" role="button" tabindex="0" onclick="CORE.viewReport(\'' + r.id + '\')" style="align-items:center"><div class="tbx">' + X(r.time) + '</div><div style="flex:1;min-width:0"><b>' + fmtD(r.date) + '</b> <span class="mut">· ' + X(r.place) + '</span><div class="mut" dir="auto" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + X(r.f.prog || r.f.obs || r.f.acts || '—') + '</div></div><span class="navchev">' + ic('chev', 18) + '</span></div>';
      }).join('') || '<div class="card mut">' + L3('No structured reports yet. Use “Complete session” to create one.', 'Aucun compte rendu structuré. Utilisez « Terminer la séance » pour en créer un.', 'لا توجد تقارير منظمة بعد. استعملي «إنهاء الحصة» لإنشاء واحد.') + '</div>') +
      (AI.length ? '<h2>' + L3('Approved AI progress reviews', 'Bilans IA approuvés', 'تقارير التقدم المعتمدة') + '</h2>' + AI.map(function (x) { return '<div class="card apt" role="button" tabindex="0" onclick="CORE.viewReview(\'' + x.id + '\')"><div style="flex:1"><b>' + fmtD(x.at.slice(0, 10)) + '</b><div class="mut">' + L3('Based on ', 'Basé sur ', 'استناداً إلى ') + x.n + ' ' + L3('report(s)', 'compte(s) rendu(s)', 'تقرير') + '</div></div><span class="navchev">' + ic('chev', 18) + '</span></div>'; }).join('') : '') +
      '<div class="row" style="margin:8px 0"><button class="b g s" onclick="CORE.aiReview(\'' + p.id + '\')">' + ic('chat', 14) + ' ' + L3('AI progress review', 'Bilan de progrès IA', 'مراجعة التقدم بالذكاء الاصطناعي') + '</button></div>';
  }
  var _pat = window.pat;
  if (typeof _pat === 'function') window.pat = function () {
    var h = _pat.apply(this, arguments), p = P(V.pid); if (!p) return h;
    syncPatient(p);
    var re = /<div class="card sec" style="--c:#16a39a">[\s\S]*?<\/div><\/div>\n/, blocks = nextCard(p) + progCard(p);
    h = re.test(h) ? h.replace(re, function () { return blocks; }) : blocks + h;
    return h.replace('<h2>Suggested activities</h2>', function () { return historyCard(p) + '<h2>Suggested activities</h2>'; });
  };

  /* ============================================================ patient directory */
  var wfBar = function (kind) {
    var f = V.wf || 'all', n = S.me.places.length; if (!n) return '';
    var pill = function (v, l) { return '<button class="pill' + (f === v ? ' on' : '') + '" onclick="V.wf=\'' + v + '\';go()">' + X(l) + '</button>'; };
    return '<div class="fltr wfbar" style="margin-top:8px">' + pill('all', L3('All workplaces', 'Tous les lieux', 'كل أماكن العمل')) + S.me.places.map(function (w) { return pill(w.id, w.n); }).join('') + (S.p.some(function (p) { return !p.wpId; }) ? pill('none', L3('No workplace', 'Sans lieu', 'بدون مكان')) : '') + '</div>';
  };
  var shortAge = function (p) { return p.birth ? age(p.birth) : ''; };
  function pcard(p) {
    var w = wpById(p.wpId) || wpByName(p.place) || {}, ex = (p.wpExtra || []).length;
    return '<button type="button" class="pcard" onclick="openPt(\'' + p.id + '\')"><div class="av">' + ini(p) + '</div><div class="pn" dir="auto">' + X(p.name) + (p.pre ? '<br>' + X(p.pre) : '') + '</div><div class="mut ps">' + X(shortAge(p)) + (shortAge(p) && (w.n || p.place) ? ' · ' : '') + X(w.n || p.place || '') + (ex ? ' +' + ex : '') + '</div><span class="pch">' + ic('chev', 16) + '</span></button>';
  }
  window.plst = function () {
    var qq = (V.pq || '').toLowerCase(), f = V.wf || 'all';
    var L = S.p.filter(function (p) { return (rn(p) + cn(p).join(' ') + p.place).toLowerCase().indexOf(qq) >= 0 && inWp(p, f); });
    return L.length ? '<div class="pgrid">' + L.map(pcard).join('') + '</div>' : '<div class="card mut">' + (S.p.length ? L3('No patients in this workplace.', 'Aucun patient dans ce lieu.', 'لا يوجد مرضى في هذا المكان.') : L3('No patients yet. Tap + Patient.', 'Aucun patient. Appuyez sur + Patient.', 'لا يوجد مرضى بعد. اضغطي + مريض.')) + '</div>';
  };
  var _pats = window.pats;
  if (typeof _pats === 'function') window.pats = function () { return _pats.apply(this, arguments).replace('<div id=pl2', function () { return wfBar() + '<div id=pl2'; }); };
  window.slst = function () {
    var qq = (V.sq || '').toLowerCase(), f = V.wf || 'all';
    return S.a.filter(function (a) { return (V.f == 'all' || a.status == V.f) && (!V.sd || a.date == V.day) && rn(P(a.pid)).toLowerCase().indexOf(qq) >= 0 && (f === 'all' || (f === 'none' ? !a.placeId : a.placeId === f)); })
      .sort(function (x, y) { return (y.date + y.time).localeCompare(x.date + x.time); }).map(function (a) { return sc(a); }).join('') || '<div class="card mut">' + L3('No sessions match.', 'Aucune séance.', 'لا توجد حصص مطابقة.') + '</div>';
  };
  function sessPatients() {
    var qq = (V.sq || '').toLowerCase(), f = V.wf || 'all';
    var L = S.p.filter(function (p) { return rn(p).toLowerCase().indexOf(qq) >= 0 && inWp(p, f); });
    return L.length ? '<div class="pgrid">' + L.map(function (p) {
      var a = upcoming(p.id)[0], w = a && (wpById(a.placeId) || wpByName(a.place) || {});
      return '<button type="button" class="pcard" onclick="openPt(\'' + p.id + '\')"><div class="av">' + ini(p) + '</div><div class="pn" dir="auto">' + X(p.name) + (p.pre ? '<br>' + X(p.pre) : '') + '</div><div class="ps' + (a ? '' : ' mut') + '">' + (a ? (a.date === td() ? '<b>' + L3('Today', 'Aujourd’hui', 'اليوم') + '</b> ' : fmtD(a.date) + ' ') + X(a.time) + (w && w.n ? '<br><span class="mut">' + X(w.n) + '</span>' : '') : L3('No appointment', 'Aucun rendez-vous', 'لا يوجد موعد')) + '</div><span class="pch">' + ic('chev', 16) + '</span></button>';
    }).join('') + '</div>' : '<div class="card mut">' + L3('No patients in this workplace.', 'Aucun patient dans ce lieu.', 'لا يوجد مرضى في هذا المكان.') + '</div>';
  }
  var _sess = window.sess;
  if (typeof _sess === 'function') window.sess = function () {
    var m = V.sm === 'pats' ? 'pats' : 'appts';
    var seg = '<div class="seg" style="margin-bottom:8px">' + [['appts', L3('Appointments', 'Rendez-vous', 'المواعيد')], ['pats', L3('Patients', 'Patients', 'المرضى')]].map(function (x) { return '<button class="' + (m === x[0] ? 'on' : '') + '" onclick="V.sm=\'' + x[0] + '\';go()">' + x[1] + '</button>'; }).join('') + '</div>';
    if (m === 'pats') return seg + '<div class="srch">' + ic('search', 18) + '<input placeholder="' + X(L3('Search a patient', 'Rechercher un patient', 'ابحثي عن مريض')) + '" value="' + X(V.sq) + '" oninput="V.sq=this.value;$(\'#lst\').innerHTML=CORE.sessPatients()"></div>' + wfBar() + '<div id="lst" style="margin-top:10px">' + sessPatients() + '</div>';
    return seg + _sess.apply(this, arguments).replace('<div class=fltr style="margin-top:8px">', function () { return wfBar() + '<div class=fltr style="margin-top:8px">'; });
  };
  CORE.sessPatients = sessPatients;

  /* patient form: additional workplaces + program managed note */
  var _ptForm = window.ptForm;
  if (typeof _ptForm === 'function') window.ptForm = function (id) {
    var r = _ptForm.apply(this, arguments), p = id && P(id), box = q('#sh .box'); if (!box) return r;
    var ex = (p && p.wpExtra) || [], cards = qa('#sh .card'), rowBtns = q('#sh .row:last-of-type');
    var html = '<div class="card" id="wpx"><b>' + L3('Additional workplaces', 'Lieux supplémentaires', 'أماكن عمل إضافية') + '</b><div class="mut">' + L3('Same patient, same profile: sessions keep their own location.', 'Même patient, même dossier : chaque séance garde son propre lieu.', 'نفس المريض ونفس الملف: كل حصة تحتفظ بمكانها.') + '</div><div class="wpck">' + (S.me.places.length ? S.me.places.map(function (w) { return '<label><input type="checkbox" value="' + X(w.id) + '"' + (ex.indexOf(w.id) >= 0 ? ' checked' : '') + '>' + X(w.n) + '</label>'; }).join('') : '<span class="mut">' + L3('Add workplaces first (menu → Workplaces).', 'Ajoutez d’abord des lieux (menu → Lieux de travail).', 'أضيفي أماكن العمل أولاً (القائمة → أماكن العمل).') + '</span>') + '</div></div>';
    var anchor = rowBtns || null; if (anchor) anchor.insertAdjacentHTML('beforebegin', html);
    if (p && p.prog && p.prog.days && p.prog.days.length) { var tot = q('#tot'); if (tot) { var c = tot.closest('.card'); if (c) c.innerHTML = '<b>' + L3('Sessions schedule', 'Planning des séances', 'جدول الحصص') + '</b><div class="mut">' + L3('Managed in the treatment program (patient profile → Edit program).', 'Géré dans le programme de traitement (profil → Modifier le programme).', 'يُدار من برنامج العلاج (ملف المريض ← تعديل البرنامج).') + '</div>'; } }
    return r;
  };
  var _savePt = window.savePt;
  if (typeof _savePt === 'function') window.savePt = function (id) {
    var extras = qa('#wpx input:checked').map(function (x) { return x.value; }), hadPrograms = id && P(id) && P(id).prog && P(id).prog.days && P(id).prog.days.length;
    var keep = hadPrograms ? { fn: P(id).fn, fu: P(id).fu, dv: P(id).dv, du: P(id).du, start: P(id).start } : null;
    var r = _savePt.apply(this, arguments);
    if (q('#sh')) return r;                                           /* validation failed: form still open */
    var p = P(id || V.pid); if (!p) return r;
    if (keep) Object.assign(p, keep);                                /* weekday-based program owns these fields */
    p.wpExtra = extras; syncPatient(p); save(); go();
    return r;
  };

  /* ============================================================ workplaces screen */
  window.wps = function () {
    var cnt = function (w) { return S.p.filter(function (p) { return patWps(p).indexOf(w.id) >= 0; }).length; };
    var terms = function (w) { return w.mode === 'fix' ? L3('Fixed ', 'Fixe ', 'ثابت ') + money(+w.mine || 0) + ' / ' + L3('session', 'séance', 'حصة') : L3('Clinician ', 'Praticien ', 'الأخصائية ') + (w.my == null ? 100 : w.my) + '% · ' + L3('Institution ', 'Établissement ', 'المؤسسة ') + (100 - (w.my == null ? 100 : w.my)) + '%'; };
    return '<div class="act-note" style="margin:0 2px 10px">' + L3('Each workplace has its own financial arrangement. Completed sessions keep the terms that applied when they were saved.', 'Chaque lieu a son propre accord financier. Les séances terminées gardent les conditions en vigueur lors de leur enregistrement.', 'لكل مكان عمل ترتيبه المالي. تحتفظ الحصص المنجزة بالشروط التي كانت سارية عند حفظها.') + '</div>' +
      (S.me.places.map(function (w, i) { return '<div class="card apt" role="button" tabindex="0" onclick="CORE.wpForm(\'' + w.id + '\')" style="align-items:center"><div class="av" style="background:' + COL[i % 6] + '">' + ic('pin', 18) + '</div><div style="flex:1;min-width:0"><div class="row sp" style="flex-wrap:nowrap"><h3>' + X(w.n) + '</h3><span class="navchev">' + ic('chev', 18) + '</span></div><div class="chips"><span class="chip">' + X(wtLabel(w.type)) + '</span><span class="chip">' + cnt(w) + ' ' + L3('patients', 'patients', 'مرضى') + '</span></div><div class="mut">' + X(terms(w)) + (w.fee ? ' · ' + money(+w.fee) : '') + '</div>' + (w.addr ? '<div class="mut">' + X(w.addr) + '</div>' : '') + '</div></div>'; }).join('') || '<div class="card mut">' + L3('No workplaces yet. Tap + Workplace.', 'Aucun lieu. Appuyez sur + Lieu.', 'لا توجد أماكن عمل بعد. اضغطي + مكان.') + '</div>');
  };
  CORE.wpForm = function (id) {
    var w = id ? wpById(id) : { n: '', type: 'daycare', my: 50, fee: 0, mode: 'pct', mine: 0, addr: '', notes: '', pay: '', payNotes: '' };
    if (id && !w) return;
    var known = WTYPES.some(function (t) { return t[0] === w.type; }), myv = w.my == null ? 50 : +w.my;
    var payOpts = [['', '—'], ['cash', L3('Cash', 'Espèces', 'نقداً')], ['bank', L3('Bank transfer', 'Virement', 'تحويل بنكي')], ['cheque', L3('Cheque', 'Chèque', 'شيك')], ['invoice', L3('Monthly invoice', 'Facture mensuelle', 'فاتورة شهرية')], ['other', L3('Other', 'Autre', 'أخرى')]];
    sheet('<h2>' + (id ? L3('Edit workplace', 'Modifier le lieu', 'تعديل مكان العمل') : L3('New workplace', 'Nouveau lieu', 'مكان عمل جديد')) + '</h2>' +
      '<label>' + L3('Workplace name', 'Nom du lieu', 'اسم مكان العمل') + '</label><input id="wf_n" dir="auto" value="' + X(w.n) + '">' +
      '<label>' + L3('Type', 'Type', 'النوع') + '</label><select id="wf_t" onchange="$(\'#wf_to\').hidden=this.value!==\'other\'">' + WTYPES.map(function (t) { return '<option value="' + t[0] + '"' + ((known ? w.type : 'other') === t[0] ? ' selected' : '') + '>' + L3(t[1], t[2], t[3]) + '</option>'; }).join('') + '</select>' +
      '<div id="wf_to"' + (known && w.type !== 'other' ? ' hidden' : '') + '><input id="wf_tc" dir="auto" placeholder="' + X(L3('Custom type', 'Type personnalisé', 'نوع مخصص')) + '" value="' + X(known ? '' : w.type) + '"></div>' +
      '<label>' + L3('Address or notes', 'Adresse ou notes', 'العنوان أو ملاحظات') + '</label><input id="wf_a" dir="auto" value="' + X(w.addr) + '"><textarea id="wf_no" dir="auto" style="min-height:50px">' + X(w.notes) + '</textarea>' +
      '<div class="card"><b>' + L3('Financial arrangement', 'Accord financier', 'الترتيب المالي') + '</b>' +
      segH('wf_m', [['pct', L3('Percentage', 'Pourcentage', 'نسبة مئوية')], ['fix', L3('Fixed per session', 'Fixe par séance', 'مبلغ ثابت لكل حصة')]], w.mode === 'fix' ? 'fix' : 'pct', "$('#wf_pc').hidden=sv('wf_m')=='fix';$('#wf_fx').hidden=sv('wf_m')!='fix'") +
      '<div id="wf_pc"' + (w.mode === 'fix' ? ' hidden' : '') + '><div class="row" style="flex-wrap:nowrap"><div style="flex:1"><label>' + L3('Clinician %', '% praticien', 'نسبة الأخصائية %') + '</label><input id="wf_my" type="number" min="0" max="100" value="' + myv + '" oninput="$(\'#wf_in\').value=Math.max(0,Math.min(100,100-(+this.value||0)))"></div><div style="flex:1"><label>' + L3('Institution %', '% établissement', 'نسبة المؤسسة %') + '</label><input id="wf_in" type="number" min="0" max="100" value="' + (100 - myv) + '" oninput="$(\'#wf_my\').value=Math.max(0,Math.min(100,100-(+this.value||0)))"></div></div></div>' +
      '<div id="wf_fx"' + (w.mode === 'fix' ? '' : ' hidden') + '><label>' + L3('My fixed amount per session', 'Mon montant fixe par séance', 'مبلغي الثابت لكل حصة') + '</label><input id="wf_mine" type="number" min="0" value="' + (+w.mine || 0) + '"></div>' +
      '<label>' + L3('Price per session', 'Prix par séance', 'سعر الحصة') + '</label><input id="wf_fee" type="number" min="0" value="' + (+w.fee || 0) + '">' +
      '<label>' + L3('Payment method', 'Mode de paiement', 'طريقة الدفع') + '</label><select id="wf_p">' + payOpts.map(function (o) { return '<option value="' + o[0] + '"' + (w.pay === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select>' +
      '<textarea id="wf_pn" dir="auto" style="min-height:44px" placeholder="' + X(L3('Payment notes / other arrangements', 'Notes de paiement / autres accords', 'ملاحظات الدفع / ترتيبات أخرى')) + '">' + X(w.payNotes) + '</textarea></div>' +
      '<div class="mut" style="margin:8px 0">' + L3('Past completed sessions keep the terms saved with them.', 'Les séances passées gardent les conditions enregistrées avec elles.', 'تحتفظ الحصص السابقة بالشروط المحفوظة معها.') + '</div>' +
      '<div class="row"><button class="b" onclick="CORE.wpSave(\'' + (id || '') + '\')">' + L3('Save', 'Enregistrer', 'حفظ') + '</button><button class="b g" onclick="cs()">' + L3('Cancel', 'Annuler', 'إلغاء') + '</button>' + (id ? '<button class="b r" data-danger onclick="CORE.wpDelete(\'' + id + '\')">' + L3('Delete workplace', 'Supprimer le lieu', 'حذف مكان العمل') + '</button>' : '') + '</div>');
  };
  CORE.wpSave = function (id) {
    var n = val('wf_n'); if (!n) return toast(L3('Enter the workplace name', 'Saisissez le nom du lieu', 'أدخلي اسم مكان العمل'));
    if (S.me.places.some(function (x) { return x.id !== id && x.n.toLowerCase() === n.toLowerCase(); })) return toast(L3('This workplace already exists', 'Ce lieu existe déjà', 'مكان العمل موجود بالفعل'));
    var type = val('wf_t'); if (type === 'other' && val('wf_tc')) type = val('wf_tc');
    var mode = sv('wf_m'), my = Math.max(0, Math.min(100, +val('wf_my') || 0));
    var w = id ? wpById(id) : null, old = w && w.n;
    if (w) CORE.freezePlace(old);                                       /* old sessions keep the terms they were worked under */
    else { w = { id: 'wp_' + hash(n + uid()) }; S.me.places.push(w); }
    Object.assign(w, { n: n, type: type, t: type === 'daycare' ? 'daycare' : 'center', addr: val('wf_a'), notes: val('wf_no'), mode: mode, my: my, mine: +val('wf_mine') || 0, fee: +val('wf_fee') || 0, pay: val('wf_p'), payNotes: val('wf_pn') });
    if (old && old !== n) {                                             /* keep name-based links consistent */
      S.p.forEach(function (p) { if (p.place === old) p.place = n; });
      S.a.forEach(function (a) { if (a.place === old) a.place = n; });
      (S.c || []).forEach(function (c) { if (c.place === old) c.place = n; });
      S.a.forEach(function (a) { if (a.fin && a.fin.place === old) a.fin.place = old; });
    }
    save(); cs(); go(); toast(L3('Workplace saved', 'Lieu enregistré', 'تم حفظ مكان العمل'));
  };
  CORE.wpDelete = function (id) {
    var w = wpById(id); if (!w) return;
    var users = S.p.filter(function (p) { return patWps(p).indexOf(id) >= 0; }).length, appts = S.a.filter(function (a) { return a.placeId === id || a.place === w.n; }).length;
    if (users || appts) return toast(L3('Cannot delete: used by ' + users + ' patient(s) and ' + appts + ' appointment(s).', 'Suppression impossible : utilisé par ' + users + ' patient(s) et ' + appts + ' rendez-vous.', 'لا يمكن الحذف: مستعمل من ' + users + ' مريض و' + appts + ' موعد.'));
    S.me.places = S.me.places.filter(function (x) { return x.id !== id; }); save(); cs(); go();
  };

  /* ============================================================ finance: calculation basis */
  var _fin = window.fin;
  if (typeof _fin === 'function') window.fin = function () {
    var h = _fin.apply(this, arguments), rg = frng(), a = rg[0], b = rg[1];
    var rows = {}; S.a.filter(function (x) { return x.status === 'done' && x.date >= a && x.date <= b; }).forEach(function (x) { var r = rows[x.place || '—'] = rows[x.place || '—'] || { snap: 0, legacy: 0 }; if (x.fin) r.snap++; else r.legacy++; });
    var legacyAll = S.a.filter(function (x) { return x.status === 'done' && !x.fin; }).length;
    var card = '<h2>' + L3('Calculation basis', 'Base de calcul', 'أساس الحساب') + '</h2><div class="card">' +
      (Object.keys(rows).map(function (n) {
        var w = wpByName(n) || {}, r = rows[n], t = w.mode === 'fix' ? L3('fixed ', 'fixe ', 'ثابت ') + money(+w.mine || 0) + ' / ' + L3('session', 'séance', 'حصة') : (w.my == null ? 100 : w.my) + '% ' + L3('clinician', 'praticien', 'الأخصائية') + ' / ' + (100 - (w.my == null ? 100 : w.my)) + '% ' + L3('institution', 'établissement', 'المؤسسة');
        return '<div style="margin-bottom:8px"><b>' + X(n) + '</b><div class="mut">' + L3('Current terms: ', 'Conditions actuelles : ', 'الشروط الحالية: ') + X(t) + '</div><div class="mut">' + r.snap + ' ' + L3('session(s) use their saved terms', 'séance(s) avec conditions enregistrées', 'حصة بشروطها المحفوظة') + (r.legacy ? ' · ' + r.legacy + ' ' + L3('older session(s) follow the current terms', 'ancienne(s) séance(s) suivent les conditions actuelles', 'حصة أقدم تتبع الشروط الحالية') : '') + '</div></div>';
      }).join('') || '<span class="mut">' + L3('Nothing counted in this period.', 'Rien de compté sur cette période.', 'لا شيء محتسب في هذه الفترة.') + '</span>') +
      '<div class="mut">' + L3('Only completed sessions are counted. Planned, missed, cancelled and rescheduled ones never are.', 'Seules les séances réalisées sont comptées. Les séances prévues, manquées, annulées ou reprogrammées ne le sont jamais.', 'تُحتسب الحصص المنجزة فقط. الحصص المجدولة أو الغائبة أو الملغاة أو المعاد جدولتها لا تُحتسب.') + '</div>' +
      (legacyAll ? '<button class="b g s" style="margin-top:8px" onclick="if(confirm(\'' + L3('Freeze the current terms on older sessions so future rate changes do not affect them?', 'Figer les conditions actuelles sur les anciennes séances pour que les futurs changements de tarif ne les affectent pas ?', 'تثبيت الشروط الحالية على الحصص الأقدم حتى لا تتأثر بتغيير الأسعار مستقبلاً؟') + '\'))CORE.freezeAll()">' + L3('Freeze current terms on ' + legacyAll + ' older session(s)', 'Figer les conditions sur ' + legacyAll + ' ancienne(s) séance(s)', 'تثبيت الشروط على ' + legacyAll + ' حصة أقدم') + '</button>' : '') + '</div>';
    return h.replace('<h2>Places and percentages</h2>', function () { return card + '<h2>Places and percentages</h2>'; });
  };

  /* ============================================================ cloud: toy photos in a second doc + overwrite guard */
  CORE.lastT = 0; CORE.toysHash = '';
  var docPath = function (u) { return 'users/' + u.uid + '/app/data'; };
  CORE.afterPull = async function (db, u, t) {
    CORE.lastT = +t || 0;
    if (S && S.toysDoc) {
      try { var d = await db.doc('users/' + u.uid + '/app/toys').get(); if (d.exists) { S.toys = JSON.parse(d.data().json) || []; CORE.toysHash = d.data().json; } } catch (e) { /* keep local toys */ }
    }
  };
  CORE.push = async function (db, u, state) {
    if (CORE.lastT) {
      try {
        var cur = await db.doc(docPath(u)).get({ source: 'server' });
        if (cur.exists && +cur.data().t > CORE.lastT) {
          var keepCloud = confirm(L3('Newer data from another device was found in the cloud.\n\nOK = load the cloud version (your recent edits on this device are kept as a local backup).\nCancel = overwrite the cloud with this device’s data.',
            'Des données plus récentes provenant d’un autre appareil existent dans le cloud.\n\nOK = charger la version du cloud (vos modifications récentes sur cet appareil sont gardées en sauvegarde locale).\nAnnuler = écraser le cloud avec les données de cet appareil.',
            'وُجدت بيانات أحدث من جهاز آخر في السحابة.\n\nموافق = تحميل نسخة السحابة (تُحفظ تعديلاتك الأخيرة على هذا الجهاز كنسخة احتياطية محلية).\nإلغاء = استبدال السحابة ببيانات هذا الجهاز.'));
          if (keepCloud) {
            try { localStorage.setItem(K + '_backup_' + Date.now(), JSON.stringify(S)); } catch (e) {}
            S = JSON.parse(cur.data().json); await CORE.afterPull(db, u, cur.data().t); mig();
            try { localStorage.setItem(K, JSON.stringify(S)); } catch (e) {}
            go(); toast(L3('Loaded the newer cloud data.', 'Données du cloud chargées.', 'تم تحميل بيانات السحابة الأحدث.')); return 'loaded';
          }
        }
      } catch (e) { /* offline: normal write path decides */ }
    }
    var t = Date.now(), toysJson = JSON.stringify(state.toys || []);
    var main = JSON.stringify(Object.assign({}, state, { toys: [], toysDoc: 1 }));
    if (main.length > 900000) toast(L3('Cloud data is almost full (1 MB limit). Please contact support before adding more.', 'Les données cloud sont presque pleines (limite 1 Mo).', 'بيانات السحابة شبه ممتلئة (حد 1 ميغابايت).'));
    if (toysJson !== CORE.toysHash) { await db.doc('users/' + u.uid + '/app/toys').set({ json: toysJson, t: t }); CORE.toysHash = toysJson; }
    await db.doc(docPath(u)).set({ json: main, t: t });
    CORE.lastT = t; return 'saved';
  };

  window.CORE = CORE;
  CORE.wps = window.wps;
})();
