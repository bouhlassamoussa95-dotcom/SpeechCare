/* ==========================================================================
   Phase 9: AI clinical analysis over the patient's COMPLETE history.
   - all saved reports + legacy completed sessions (chunked + summarised if large)
   - only the selected patient; names/phones removed before sending
   - answer split into DOCUMENTED FACTS vs AI INTERPRETATION
   - nothing is saved or shared until the clinician reviews and approves it
   ========================================================================== */
(function () {
  'use strict';
  var doc = document, q = function (s) { return doc.querySelector(s); };
  var L3 = function (en, fr, ar) { var l = PR.lang; return l === 'fr' ? fr : l === 'ar' ? ar : en; };
  var X = function (s) { return esc(s == null ? '' : s); };
  var LNAME = function () { return PR.lang === 'ar' ? 'Algerian Arabic (Darija), clear and professional' : PR.lang === 'fr' ? 'French' : 'English'; };
  var busy = false;

  /* remove direct identifiers before anything leaves the device */
  function deid(text, p) {
    var t = String(text == null ? '' : text), names = [p.name, p.pre].concat(String(p.parents || '').split(/[,;\/&+]|\bet\b|\band\b|و/)).map(function (x) { return String(x || '').trim(); }).filter(function (x) { return x.length > 2; });
    names.sort(function (a, b) { return b.length - a.length; }).forEach(function (n, i) {
      var tag = i < 2 ? '[PATIENT]' : '[PARENT]';
      t = t.split(n).join(tag);
    });
    return t.replace(/(\+?\d[\d\s().-]{6,}\d)/g, '[NUMBER]').replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[EMAIL]');
  }
  var line = function (s, n) { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

  /* ordered clinical history entries for ONE patient */
  function entries(p) {
    var reps = (S.sr || []).filter(function (r) { return r.pid === p.id; }), byAid = {};
    reps.forEach(function (r) { byAid[r.aid] = 1; });
    var out = reps.map(function (r) { return { date: r.date, place: r.place, f: r.f, src: 'report' }; });
    S.a.filter(function (a) { return a.pid === p.id && a.status === 'done' && !byAid[a.id] && (a.goal || a.remark); })
      .forEach(function (a) { out.push({ date: a.date, place: a.place, f: { goals: a.goal || '', obs: a.remark || '' }, src: 'legacy' }); });
    return out.sort(function (x, y) { return x.date.localeCompare(y.date); });
  }
  function fmtEntry(e, i, p, full) {
    var n = full ? 600 : 160, f = e.f, parts = [['acts', 'activities'], ['goals', 'goals'], ['resp', 'response'], ['prog', 'progress'], ['diff', 'difficulties'], ['ach', 'achievements'], ['obs', 'observations'], ['rec', 'recommendations']]
      .filter(function (k) { return f[k[0]]; }).map(function (k) { return k[1] + ': ' + line(deid(f[k[0]], p), n); });
    return '#' + (i + 1) + ' ' + e.date + (e.place ? ' @' + deid(e.place, p) : '') + (e.src === 'legacy' ? ' (brief note)' : '') + ' | ' + (parts.join(' | ') || 'no notes');
  }

  /* compact context for the chat assistant: every completed session, newest first, capped */
  window.pctx = function (p) {
    var E = entries(p).reverse(), D = S.a.filter(function (a) { return a.pid === p.id && a.status === 'done'; }), cap = 6500, used = 0, shown = [];
    for (var i = 0; i < E.length; i++) { var l = '- ' + fmtEntry(E[i], E.length - 1 - i, p, false); if (used + l.length > cap) break; used += l.length; shown.push(l); }
    var omitted = E.length - shown.length;
    return 'Age: ' + age(p.birth) + '.\nConditions: ' + (cn(p).join('; ') || 'not specified') + '.\nSymptoms: ' + (p.symptoms || '-') + '.\nDiagnostic: ' + (p.diag || '-') + '.\nCurrent treatment plan: ' + (p.plan || '-') + '.\nFrequency: ' + fq(p) + '; sessions done: ' + D.length + '.\nSession history (newest first):\n' + (shown.join('\n') || '- none') + (omitted > 0 ? '\n(' + omitted + ' older session(s) not shown here; the "AI progress review" button analyses the complete history.)' : '');
  };

  async function ask(prompt) { return await gem([{ r: 'u', t: prompt }], SYS(PR.lang), 1); }

  var STRUCT = function () {
    return 'Write a PROGRESS REPORT for the clinician with EXACTLY two parts, in ' + LNAME() + ', using the headings "PART A — DOCUMENTED FACTS" and "PART B — AI INTERPRETATION".\n' +
      'PART A may contain ONLY information explicitly present in the clinical history below (cite the date in brackets, e.g. [2026-03-04]). If something is not documented write "Not documented".\n' +
      'PART B contains your analysis and recommendations; every statement there is an interpretation, not a fact.\n' +
      'Cover, in this order: 1) initial performance, 2) current documented performance, 3) improvements over time, 4) areas with the strongest progress, 5) remaining difficulties, 6) activities associated with progress (only if the reports support it), 7) goals achieved, 8) goals not yet achieved, 9) suggested future activities, 10) recommendations for the next treatment period.\n' +
      'Put items 1,2,3,5,7,8 mainly in PART A (facts) and 4,6,9,10 mainly in PART B; add a short interpretation under PART B for 1-3 and 5.\n' +
      'NEVER invent diagnoses, scores, dates, observations, patient responses, activities, improvements or outcomes. Keep the placeholders [PATIENT], [PARENT], [NUMBER] unchanged. Plain text, no tables.';
  }

  CORE.aiReview = async function (pid) {
    var p = P(pid); if (!p || busy) return;
    var E = entries(p);
    if (!E.length) return toast(L3('No completed sessions to analyse yet.', 'Aucune séance réalisée à analyser.', 'لا توجد حصص منجزة للتحليل بعد.'));
    busy = true;
    sheet('<h2>' + L3('AI progress review', 'Bilan de progrès IA', 'مراجعة التقدم بالذكاء الاصطناعي') + '</h2><div class="mut" id="air_st">' + L3('Preparing the complete history…', 'Préparation de l’historique complet…', 'جاري تجهيز السجل الكامل…') + '</div>');
    try {
      var head = 'Patient: [PATIENT], age ' + age(p.birth) + '. Conditions: ' + (cn(p).join('; ') || 'not specified') + '. Initial symptoms: ' + deid(p.symptoms || '-', p) + '. Initial diagnostic/assessment: ' + deid(p.diag || '-', p) + '. Treatment plan/goals: ' + deid(p.plan || '-', p) + '. Program: ' + fq(p) + ', start ' + (p.start || '?') + '. Completed sessions on record: ' + E.length + '.';
      var lines = E.map(function (e, i) { return fmtEntry(e, i, p, true); }), total = lines.join('\n').length, history;
      if (total <= 14000) history = lines.join('\n');
      else {                                                               /* map: summarise older chunks, keep the most recent raw */
        var keep = lines.slice(-6), old = lines.slice(0, -6), chunks = [], cur = [], len = 0;
        old.forEach(function (l) { if (len + l.length > 6000 && cur.length) { chunks.push(cur); cur = []; len = 0; } cur.push(l); len += l.length; });
        if (cur.length) chunks.push(cur);
        var sums = [];
        for (var i = 0; i < chunks.length; i++) {
          var st = q('#air_st'); if (st) st.textContent = L3('Summarising earlier sessions ', 'Résumé des séances précédentes ', 'تلخيص الحصص السابقة ') + (i + 1) + '/' + chunks.length + '…';
          sums.push(await ask('Summarise ONLY the documented facts in these session notes (keep dates in brackets, keep measurable details, do not interpret, do not add anything). Plain bullets, in ' + LNAME() + '.\n\n' + chunks[i].join('\n')));
        }
        history = 'EARLIER SESSIONS (summaries of documented facts):\n' + sums.join('\n---\n') + '\n\nMOST RECENT SESSIONS (full notes):\n' + keep.join('\n');
      }
      var st2 = q('#air_st'); if (st2) st2.textContent = L3('Analysing…', 'Analyse en cours…', 'جاري التحليل…');
      var out = await ask(STRUCT() + '\n\nCLINICAL HISTORY\n' + head + '\n\n' + history);
      var text = String(out || '').replace(/\*\*(.+?)\*\*/g, '$1').trim();
      busy = false;
      sheet('<h2>' + L3('AI progress review (draft)', 'Bilan de progrès IA (brouillon)', 'مراجعة التقدم (مسودة)') + '</h2>' +
        '<div class="card" style="border:1px solid #e8a33d"><b>' + L3('Review before saving', 'À relire avant d’enregistrer', 'راجعي قبل الحفظ') + '</b><div class="mut">' + L3('Part A should only repeat what you documented; Part B is the AI’s interpretation. Edit anything, then approve. Nothing is saved or shared until you approve.', 'La partie A ne doit reprendre que ce que vous avez documenté ; la partie B est l’interprétation de l’IA. Modifiez puis approuvez. Rien n’est enregistré ni partagé avant votre approbation.', 'يجب أن تكرر الفقرة A ما وثّقتِه فقط؛ الفقرة B تفسير الذكاء الاصطناعي. عدّلي ما شئتِ ثم اعتمدي. لا يُحفظ أو يُشارك شيء قبل اعتمادك.') + '</div></div>' +
        '<textarea id="air_tx" dir="auto" style="min-height:48vh;margin-top:8px">' + X(text) + '</textarea>' +
        '<div class="row" style="margin-top:8px"><button class="b" id="air_ok" onclick="CORE.aiApprove(\'' + pid + '\',' + E.length + ')">' + L3('Approve and save', 'Approuver et enregistrer', 'اعتماد وحفظ') + '</button><button class="b g" onclick="cs()">' + L3('Discard', 'Annuler', 'تجاهل') + '</button></div>');
    } catch (e) {
      busy = false; sheet('<h2>' + L3('AI progress review', 'Bilan de progrès IA', 'مراجعة التقدم') + '</h2><div class="card">' + X(aiErr(e)) + '</div><button class="b g" onclick="cs()">' + L3('Close', 'Fermer', 'إغلاق') + '</button>');
    }
  };
  CORE.aiApprove = function (pid, n) {
    var b = q('#air_ok'); if (b) { if (b.disabled) return; b.disabled = true; }
    var t = (q('#air_tx') || {}).value || ''; if (!t.trim()) { if (b) b.disabled = false; return; }
    S.ai = S.ai || []; S.ai.push({ id: 'ai_' + uid(), pid: pid, at: new Date().toISOString(), n: n, text: t.trim(), approved: true });
    save(); cs(); go(); toast(L3('Review saved to the patient’s history', 'Bilan enregistré dans le dossier du patient', 'تم حفظ المراجعة في سجل المريض'));
  };
  CORE.viewReview = function (id) {
    var r = (S.ai || []).find(function (x) { return x.id === id; }); if (!r) return;
    sheet('<h2>' + L3('Approved AI progress review', 'Bilan IA approuvé', 'مراجعة معتمدة') + '</h2><div class="mut">' + full(P(r.pid)) + ' · ' + r.at.slice(0, 10) + '</div><div class="card" dir="auto" style="white-space:pre-wrap">' + X(r.text) + '</div>' +
      '<div class="row"><button class="b g s" onclick="CORE.rvCopy(\'' + id + '\')">' + L3('Copy', 'Copier', 'نسخ') + '</button><button class="b g s" onclick="CORE.rvShare(\'' + id + '\')">' + L3('Share', 'Partager', 'مشاركة') + '</button><button class="b g s" onclick="cs()">' + L3('Close', 'Fermer', 'إغلاق') + '</button></div>');
  };
  CORE.rvCopy = function (id) { var r = (S.ai || []).find(function (x) { return x.id === id; }); if (r && navigator.clipboard) navigator.clipboard.writeText(r.text).then(function () { toast(L3('Copied', 'Copié', 'تم النسخ')); }); };
  CORE.rvShare = function (id) { var r = (S.ai || []).find(function (x) { return x.id === id; }); if (r && window.shareText) shareText(r.text, L3('AI progress review', 'Bilan de progrès', 'مراجعة التقدم')); };
  CORE.deid = deid; CORE.entries = entries;
})();
