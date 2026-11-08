/* ==========================================================================
   SpeechCare report -> real Word (.docx) file.
   - Page frame (teal triple border), SpeechCare ribbon header, footer with page numbers
   - Fully editable text (headings + paragraphs), Arabic/Darija right-to-left aware
   - Signature block = the Mebarki / SpeechCare logo + therapist details
   - Delivered through the Android share sheet (Word, WPS, Drive...) or a normal download
   Replaces the old dl() which saved an HTML file named .doc through a blob link
   (blocked inside the Android WebView).
   ========================================================================== */
(function () {
  'use strict';
  var TEAL = '0F7A72', PURPLE = '5B3F8C', GOLD = 'C9A24A', INK = '17262B';
  var enc = new TextEncoder();

  /* ---------------- zip (store only) ---------------- */
  var CRC = (function () { var t = new Uint32Array(256), c, n, k; for (n = 0; n < 256; n++) { c = n; for (k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  function crc32(b) { var c = 0xFFFFFFFF, i; for (i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
  function zip(files) {
    var d = new Date(), time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    var parts = [], central = [], off = 0;
    files.forEach(function (f) {
      var name = enc.encode(f.name), data = f.data, crc = crc32(data);
      var lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
      lh.setUint16(10, time, true); lh.setUint16(12, date, true); lh.setUint32(14, crc, true); lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true);
      lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
      parts.push(new Uint8Array(lh.buffer), name, data);
      var ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
      ch.setUint16(12, time, true); ch.setUint16(14, date, true); ch.setUint32(16, crc, true); ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true);
      ch.setUint16(28, name.length, true); ch.setUint32(42, off, true);
      central.push(new Uint8Array(ch.buffer), name);
      off += 30 + name.length + data.length;
    });
    var csize = 0; central.forEach(function (c) { csize += c.length; });
    var end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true); end.setUint32(12, csize, true); end.setUint32(16, off, true);
    var all = parts.concat(central, [new Uint8Array(end.buffer)]), total = 0; all.forEach(function (p) { total += p.length; });
    var out = new Uint8Array(total), o = 0; all.forEach(function (p) { out.set(p, o); o += p.length; });
    return out;
  }
  function b64ToBytes(b64) { var s = atob(b64), u = new Uint8Array(s.length), i; for (i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; }
  function bytesToB64(u) { var s = '', i, CH = 0x8000; for (i = 0; i < u.length; i += CH) s += String.fromCharCode.apply(null, u.subarray(i, i + CH)); return btoa(s); }

  /* ---------------- xml helpers ---------------- */
  var X = function (s) { return String(s == null ? '' : s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  var AR = /[\u0600-\u06FF\u0750-\u077F]/g, LAT = /[A-Za-zÀ-ÿ]/g;
  function isAr(t) { var a = (t.match(AR) || []).length, l = (t.match(LAT) || []).length; return a > l; }
  function run(text, o) {
    o = o || {};
    var rp = '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Arial"/>' + (o.b ? '<w:b/><w:bCs/>' : '') + (o.i ? '<w:i/><w:iCs/>' : '') +
      '<w:color w:val="' + (o.color || INK) + '"/><w:sz w:val="' + (o.sz || 22) + '"/><w:szCs w:val="' + (o.sz || 22) + '"/>' + (o.rtl ? '<w:rtl/>' : '');
    return '<w:r><w:rPr>' + rp + '</w:rPr><w:t xml:space="preserve">' + X(text) + '</w:t></w:r>';
  }
  function para(runs, o) {
    o = o || {};
    var pp = (o.keep ? '<w:keepNext/>' : '') + (o.pBdr || '') + (o.shd ? '<w:shd w:val="clear" w:color="auto" w:fill="' + o.shd + '"/>' : '') + (o.rtl ? '<w:bidi/>' : '') +
      '<w:spacing w:before="' + (o.before || 0) + '" w:after="' + (o.after == null ? 100 : o.after) + '" w:line="' + (o.line || 276) + '" w:lineRule="auto"/>' +
      (o.ind ? '<w:ind w:left="' + o.ind + '" w:right="' + o.ind + '"/>' : '') + (o.jc ? '<w:jc w:val="' + o.jc + '"/>' : '');
    return '<w:p><w:pPr>' + pp + '</w:pPr>' + runs + '</w:p>';
  }
  function image(rid, id, name, wIn, hIn) {
    var cx = Math.round(wIn * 914400), cy = Math.round(hIn * 914400);
    return '<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="' + cx + '" cy="' + cy + '"/><wp:docPr id="' + id + '" name="' + X(name) + '" descr="' + X(name) + '"/>' +
      '<wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr>' +
      '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
      '<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="' + id + '" name="' + X(name) + '"/><pic:cNvPicPr/></pic:nvPicPr>' +
      '<pic:blipFill><a:blip r:embed="' + rid + '"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>' +
      '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="' + cx + '" cy="' + cy + '"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>' +
      '</a:graphicData></a:graphic></wp:inline></w:drawing></w:r>';
  }
  var NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"';
  var HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

  /* ---------------- build ---------------- */
  function buildDocx(d) {
    var A = window.RPT_ASSETS, rtlDoc = d.rtl, ban = A.banner, sig = A.sig;
    var bw = 4.7, bh = bw * ban.h / ban.w, sw = 1.2;
    var body = '';
    /* title band */
    body += para(run(d.title, { b: 1, sz: 40, color: 'FFFFFF', rtl: rtlDoc }), { shd: TEAL, jc: 'center', rtl: rtlDoc, before: 60, after: 160, line: 320 });
    /* patient line + date */
    body += para(run(d.patient, { b: 1, sz: 26, color: TEAL, rtl: rtlDoc }) + (d.age ? run('  –  ' + d.age, { sz: 24, color: '4A5A60', rtl: rtlDoc }) : ''), { rtl: rtlDoc, after: 40 });
    if (d.meta) body += para(run(d.meta, { sz: 20, color: '5A6A70', rtl: rtlDoc }), { rtl: rtlDoc, after: 120 });
    /* sections */
    d.sections.forEach(function (s) {
      var h = isAr(s.t) || rtlDoc;
      body += para(run(s.t, { b: 1, sz: 26, color: PURPLE, rtl: h }), {
        keep: 1, rtl: h, before: 220, after: 80,
        pBdr: '<w:pBdr><w:bottom w:val="single" w:sz="10" w:space="2" w:color="' + TEAL + '"/></w:pBdr>'
      });
      String(s.v == null ? '' : s.v).split(/\r?\n/).forEach(function (line) {
        var r = rtlDoc || isAr(line);
        body += para(line.trim() ? run(line, { rtl: r }) : '', { rtl: r, after: line.trim() ? 80 : 20 });
      });
    });
    /* signature block (her logo) */
    var tr = rtlDoc ? ' <w:bidiVisual/>' : '';
    var nobd = '<w:tblBorders><w:top w:val="nil"/><w:left w:val="nil"/><w:bottom w:val="nil"/><w:right w:val="nil"/><w:insideH w:val="nil"/><w:insideV w:val="nil"/></w:tblBorders>';
    var info = '';
    info += para(run(d.me.name || '', { b: 1, sz: 28, color: TEAL, rtl: rtlDoc }), { rtl: rtlDoc, after: 20 });
    if (d.me.title) info += para(run(d.me.title, { i: 1, sz: 22, color: PURPLE, rtl: rtlDoc || isAr(d.me.title) }), { rtl: rtlDoc || isAr(d.me.title), after: 20 });
    var contact = [d.me.phone, d.me.email].filter(Boolean).join('  ·  ');
    if (contact) info += para(run(contact, { sz: 20, color: '4A5A60' }), { rtl: false, jc: rtlDoc ? 'right' : '', after: 20 });
    if (d.me.addr) info += para(run(d.me.addr, { sz: 20, color: '4A5A60', rtl: rtlDoc || isAr(d.me.addr) }), { rtl: rtlDoc || isAr(d.me.addr), after: 20 });
    var sigP = para(image('rIdSig', 20, 'Signature', sw, sw), { after: 0, jc: 'center' });
    var tbl = '<w:tbl><w:tblPr>' + (rtlDoc ? '<w:bidiVisual/>' : '') + '<w:tblW w:w="0" w:type="auto"/>' + nobd + '<w:tblLayout w:type="fixed"/></w:tblPr>' +
      '<w:tblGrid><w:gridCol w:w="2100"/><w:gridCol w:w="6700"/></w:tblGrid><w:tr><w:trPr><w:cantSplit/></w:trPr>' +
      '<w:tc><w:tcPr><w:tcW w:w="2100" w:type="dxa"/><w:vAlign w:val="center"/></w:tcPr>' + sigP + '</w:tc>' +
      '<w:tc><w:tcPr><w:tcW w:w="6700" w:type="dxa"/><w:vAlign w:val="center"/></w:tcPr>' + info + '</w:tc></w:tr></w:tbl>';
    body += para(run(d.dateLine, { sz: 20, color: '5A6A70', rtl: rtlDoc }), {
      rtl: rtlDoc, before: 360, after: 80, keep: 1,
      pBdr: '<w:pBdr><w:top w:val="single" w:sz="8" w:space="6" w:color="' + GOLD + '"/></w:pBdr>'
    });
    body += tbl + para('', { after: 0 });

    var sect = '<w:sectPr><w:headerReference w:type="default" r:id="rIdHdr"/><w:footerReference w:type="default" r:id="rIdFtr"/>' +
      '<w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="2100" w:right="1250" w:bottom="1500" w:left="1250" w:header="620" w:footer="520" w:gutter="0"/>' +
      '<w:pgBorders w:offsetFrom="page">' + ['top', 'left', 'bottom', 'right'].map(function (s) { return '<w:' + s + ' w:val="thinThickThinSmallGap" w:sz="18" w:space="22" w:color="' + TEAL + '"/>'; }).join('') + '</w:pgBorders>' +
      '<w:cols w:space="720"/>' + (rtlDoc ? '<w:bidi/>' : '') + '</w:sectPr>';
    var doc = HEAD + '<w:document ' + NS + '><w:body>' + body + sect + '</w:body></w:document>';

    var hdr = HEAD + '<w:hdr ' + NS + '>' + para(image('rIdBan', 10, 'SpeechCare', bw, bh), { jc: 'center', after: 0, line: 240 }) + '</w:hdr>';
    var ftr = HEAD + '<w:ftr ' + NS + '>' + '<w:p><w:pPr><w:pBdr><w:top w:val="single" w:sz="8" w:space="4" w:color="' + GOLD + '"/></w:pBdr><w:jc w:val="center"/></w:pPr>' +
      run('\u2581\u2583\u2585\u2583\u2581  ', { sz: 18, color: GOLD }) + run('SpeechCare', { b: 1, sz: 18, color: TEAL }) + run('  \u2581\u2583\u2585\u2583\u2581', { sz: 18, color: GOLD }) +
      run('     ' + d.pageWord + ' ', { sz: 18, color: '5A6A70' }) +
      '<w:fldSimple w:instr=" PAGE "><w:r><w:rPr><w:sz w:val="18"/><w:color w:val="5A6A70"/></w:rPr><w:t>1</w:t></w:r></w:fldSimple></w:p></w:ftr>';
    var styles = HEAD + '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Arial"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US" w:eastAsia="en-US" w:bidi="ar-DZ"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="100" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style></w:styles>';
    var ct = HEAD + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
      '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>' +
      '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>';
    var rels = HEAD + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>';
    var core = HEAD + '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>' + X(d.title) + '</dc:title><dc:creator>' + X(d.me.name || 'SpeechCare') + '</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">' + new Date().toISOString() + '</dcterms:created></cp:coreProperties>';
    var R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
    var docRels = HEAD + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdSt" Type="' + R + 'styles" Target="styles.xml"/><Relationship Id="rIdHdr" Type="' + R + 'header" Target="header1.xml"/><Relationship Id="rIdFtr" Type="' + R + 'footer" Target="footer1.xml"/><Relationship Id="rIdSig" Type="' + R + 'image" Target="media/signature.png"/></Relationships>';
    var hdrRels = HEAD + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdBan" Type="' + R + 'image" Target="media/banner.jpeg"/></Relationships>';
    var u = function (s) { return enc.encode(s); };
    return zip([
      { name: '[Content_Types].xml', data: u(ct) }, { name: '_rels/.rels', data: u(rels) }, { name: 'docProps/core.xml', data: u(core) },
      { name: 'word/document.xml', data: u(doc) }, { name: 'word/styles.xml', data: u(styles) }, { name: 'word/header1.xml', data: u(hdr) }, { name: 'word/footer1.xml', data: u(ftr) },
      { name: 'word/_rels/document.xml.rels', data: u(docRels) }, { name: 'word/_rels/header1.xml.rels', data: u(hdrRels) },
      { name: 'word/media/banner.jpeg', data: b64ToBytes(ban.b64) }, { name: 'word/media/signature.png', data: b64ToBytes(sig.b64) }
    ]);
  }

  /* ---------------- delivery ---------------- */
  var MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  function plugin(n) { var c = window.Capacitor; return c && c.Plugins && c.Plugins[n]; }
  /* mode "share": Android share sheet (Word, WPS, Drive, email...) ; mode "save": Documents folder / browser download */
  async function deliver(name, bytes, mode) {
    var FS = plugin('Filesystem'), SH = plugin('Share');
    if (FS && FS.writeFile) {
      var data = bytesToB64(bytes);
      if (mode === 'share') {
        try {
          var w = await FS.writeFile({ path: name, data: data, directory: 'CACHE', recursive: true });
          if (SH && SH.share) {
            try { await SH.share({ title: name, text: name, url: w.uri, dialogTitle: name }); return 'shared'; }
            catch (e) { if (e && /cancel/i.test(String(e.message || e))) return 'cancelled'; }
          }
        } catch (e) { /* fall through */ }
      }
      try { await FS.writeFile({ path: name, data: data, directory: 'DOCUMENTS', recursive: true }); return 'documents'; } catch (e) { /* fall through */ }
    }
    var a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([bytes], { type: MIME })); a.download = name;
    document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
    return 'download';
  }

  /* ---------------- data from the open report screen ---------------- */
  function collect() {
    var lg = V.rl === 'fr' ? 1 : V.rl === 'ar' ? 2 : 0, p = P(V.pid), m = S.me || {};
    var L = function (en, fr, ar) { return [en, fr, ar][lg]; };
    var loc = LCS[V.rl] || LCS[PR.lang] || 'en';
    var place = p.place ? (L('Center / daycare', 'Centre / crèche', 'مركز / روضة') + ': ' + p.place) : '';
    return {
      rtl: V.rl === 'ar', title: MODELS[V.rm][lg], patient: rn(p), age: age(p.birth),
      meta: place, sections: body(), me: m, pageWord: L('Page', 'Page', 'صفحة'),
      dateLine: new Date().toLocaleDateString(loc, { year: 'numeric', month: 'long', day: 'numeric' }),
      file: ('Report_' + (p.name || 'patient') + '_' + V.rm + '.docx').replace(/[^\w\u0600-\u06FF.-]+/g, '_')
    };
  }
  window.buildReportDocx = function () { return buildDocx(collect()); };
  async function runExport(mode) {
    var msg = document.querySelector('#rmsg');
    try {
      var d = collect(), bytes = buildDocx(d), r = await deliver(d.file, bytes, mode);
      if (msg) msg.textContent = T(r === 'shared' ? 'Word file ready. Choose Word, WPS or Drive to open and edit it.' : r === 'documents' ? 'Word file saved in your Documents folder.' : r === 'cancelled' ? '' : 'Word file downloaded.');
    } catch (e) { if (msg) msg.textContent = T('Could not create the Word file. Use Copy instead.'); }
  }
  window.dl = function () { return runExport('save'); };                 /* Download Word */
  window.uxShareDocx = function () { return runExport('share'); };       /* Edit / Email report */

  /* ---------------- share plain text (client message) ---------------- */
  window.shareText = async function (text, title) {
    var SH = plugin('Share');
    try { if (SH && SH.share) { await SH.share({ title: title || 'SpeechCare', text: text, dialogTitle: title || 'SpeechCare' }); return; } } catch (e) { if (e && /cancel/i.test(String(e.message || e))) return; }
    try { if (navigator.share) { await navigator.share({ title: title || 'SpeechCare', text: text }); return; } } catch (e) { if (e && e.name === 'AbortError') return; }
    try { await navigator.clipboard.writeText(text); toast(T('Report text copied.')); } catch (e) { /* nothing else to try */ }
  };

  /* ---------------- Send to client: structured message, reviewed before sharing ---------------- */
  window.uxClientMsg = function () {
    var lg = V.rl === 'fr' ? 1 : V.rl === 'ar' ? 2 : 0, Lr = function (en, fr, ar) { return [en, fr, ar][lg]; };
    var p = P(V.pid), m = S.me || {}, loc = LCS[V.rl] || 'en', sec = body().filter(function (x) { return x.v && x.v.trim(); });
    var rep = (S.sr || []).filter(function (r) { return r.pid === p.id; }).sort(function (a, b) { return (b.date + b.time).localeCompare(a.date + a.time); })[0];
    var nx = S.a.filter(function (a) { return a.pid === p.id && a.status === 'scheduled' && a.date >= td(); }).sort(function (a, b) { return (a.date + a.time).localeCompare(b.date + b.time); })[0];
    var cut = function (t, n) { t = String(t || '').replace(/\s+\n/g, '\n').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
    var L = [Lr('Hello,', 'Bonjour,', 'السلام عليكم،'), '',
      Lr('Here is a summary of the speech therapy follow-up for ' + p.name + ' (' + MODELS[V.rm][0] + ').', 'Voici un résumé du suivi orthophonique de ' + p.name + ' (' + MODELS[V.rm][1] + ').', 'هذا ملخص المتابعة الأرطفونية للطفل ' + p.name + ' (' + MODELS[V.rm][2] + ').')];
    if (rep && (rep.f.prog || rep.f.ach)) {
      L.push('', '▪ ' + Lr('Latest progress', 'Derniers progrès', 'آخر تقدم') + ' (' + new Date(rep.date + 'T12:00').toLocaleDateString(loc, { day: 'numeric', month: 'long' }) + '):');
      if (rep.f.prog) L.push(cut(rep.f.prog, 400)); if (rep.f.ach) L.push(Lr('Achievements: ', 'Réussites : ', 'الإنجازات: ') + cut(rep.f.ach, 300));
    } else if (sec.length) {
      sec.slice(0, 3).forEach(function (x) { L.push('', '▪ ' + x.t + ':', cut(x.v, 300)); });
    }
    var adv = sec.find(function (x) { return /advice|conseil|نصائح|توصيات|recommend/i.test(x.t); });
    var rec = (rep && rep.f.rec) || (adv && adv.v);
    if (rec) L.push('', '▪ ' + Lr('Recommendations', 'Recommandations', 'التوصيات') + ':', cut(rec, 450));
    if (nx) L.push('', '▪ ' + Lr('Next appointment', 'Prochain rendez-vous', 'الموعد القادم') + ': ' + new Date(nx.date + 'T12:00').toLocaleDateString(loc, { weekday: 'long', day: 'numeric', month: 'long' }) + ' ' + nx.time + (nx.place ? ' — ' + nx.place : ''));
    L.push('', Lr('Kind regards,', 'Cordialement,', 'مع أطيب التحيات،'), [m.name, m.title].filter(Boolean).join(' — '), [m.phone, m.email].filter(Boolean).join(' · '));
    var text = L.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    sheet('<h2>' + T('Send to client') + '</h2><div class="mut">' + esc(Lr('Review and edit the message. Nothing is sent automatically: you choose the app (WhatsApp, email…) and press send there.', 'Relisez et modifiez le message. Rien n’est envoyé automatiquement : vous choisissez l’application (WhatsApp, e-mail…) et envoyez depuis celle-ci.', 'راجعي الرسالة وعدّليها. لا يُرسل شيء تلقائياً: تختارين التطبيق (واتساب، بريد…) وتضغطين إرسال هناك.')) + '</div><textarea id="cm_tx" dir="auto" style="min-height:44vh;margin-top:8px">' + esc(text) + '</textarea>' +
      '<div class="row" style="margin-top:8px"><button class="b" onclick="shareText($(\'#cm_tx\').value,\'' + esc(p.name) + '\')">' + esc(Lr('Share…', 'Partager…', 'مشاركة…')) + '</button><button class="b g" onclick="navigator.clipboard.writeText($(\'#cm_tx\').value).then(()=>toast(T(\'Report text copied.\')))">' + T('Copy') + '</button><button class="b g" onclick="cs()">' + esc(Lr('Close', 'Fermer', 'إغلاق')) + '</button></div>');
  };

  /* ---------------- AI polish: wording only, never facts ---------------- */
  var digits = function (t) { return (String(t).replace(/[\u0660-\u0669]/g, function (c) { return c.charCodeAt(0) - 0x0660; }).match(/\d+/g) || []).sort().join(','); };
  window.aiPolish = async function () {
    var p = P(V.pid), nm = rn(p), b = body(); if (!b.length) return;
    var box = document.querySelector('#rmsg'), areas = [].slice.call(document.querySelectorAll('.rs textarea')), before = areas.map(function (t) { return t.value; });
    var mk = function (x) { return nm ? x.split(nm).join('[PATIENT]') : x; }, rs = function (x) { return x.split('[PATIENT]').join(nm); };
    box.textContent = T('Thinking…');
    try {
      var prompt = 'You are editing a speech-language therapy report. Improve ONLY grammar, clarity, organisation, readability and professional tone, in ' + LN(V.rl) + '. ' +
        'STRICT RULES: do not add, remove or change any clinical observation, diagnosis, patient performance, score, number, date, achievement or outcome; do not add information that is not in the text; keep every section\'s meaning; leave empty sections empty; if unsure keep the original wording. Keep the [PATIENT] placeholder unchanged. ' +
        'Return only a valid JSON array of strings: one polished text per section, same number and order. Sections:\n' + JSON.stringify(b.map(function (x) { return { title: x.t, text: mk(x.v) }; }));
      var out = await gem([{ r: 'u', t: prompt }], SYS(V.rl), 1), arr;
      try { arr = JSON.parse(out.replace(/```json|```/gi, '').trim()); } catch (e) { var mt = out.match(/\[[\s\S]*\]/); if (mt) arr = JSON.parse(mt[0]); }
      if (!Array.isArray(arr)) throw { code: 'format' };
      var applied = 0, kept = 0;
      areas.forEach(function (t, i) {
        var n = typeof arr[i] === 'string' ? rs(arr[i]).trim() : '';
        if (!n || !before[i].trim()) return;
        if (digits(before[i]) !== digits(n)) { kept++; return; }               /* a number or date changed: refuse this section */
        t.value = n; applied++;
      });
      window.__polishUndo = before;
      box.innerHTML = esc(T('Report improved by AI. Please review it.') + ' ' + T('Review identifying details before sending.') + (kept ? ' · ' + kept + ' ' + [' section(s) kept unchanged because the AI altered numbers or dates.', ' section(s) laissée(s) inchangée(s) car l’IA modifiait des chiffres ou des dates.', ' قسم بقي دون تغيير لأن الذكاء الاصطناعي غيّر أرقاماً أو تواريخ.'][V.rl === 'fr' ? 1 : V.rl === 'ar' ? 2 : 0] : '')) + (applied ? ' <button type="button" class="lnk" onclick="uxUndoPolish()">' + esc({ en: 'Undo', fr: 'Annuler', ar: 'تراجع' }[V.rl] || 'Undo') + '</button>' : '');
    } catch (e) { box.textContent = aiErr(e); }
  };
  window.uxUndoPolish = function () {
    var u = window.__polishUndo; if (!u) return;
    [].slice.call(document.querySelectorAll('.rs textarea')).forEach(function (t, i) { if (typeof u[i] === 'string') t.value = u[i]; });
    var b = document.querySelector('#rmsg'); if (b) b.textContent = '';
  };
})();
