/* Repositorio UCA - modo local (sin base de datos)
   Se usa cuando config.js todavía no tiene los datos de Supabase.
   Cuentas y apuntes quedan en este dispositivo (localStorage) y los archivos en IndexedDB, así las descargas funcionan.
   Responde a las mismas acciones que repo-api.js, así la app no distingue un modo del otro. */
(function (root) {
  'use strict';
  var KEY = 'uca-repo-localdb', IDB_NAME = 'uca-repo-files', STORE = 'files';
  var FMT = { pdf: 'PDF', doc: 'DOCX', docx: 'DOCX', ppt: 'PPTX', pptx: 'PPTX', jpg: 'IMG', jpeg: 'IMG', png: 'IMG' };
  var TYPES = ['Resumen', 'Examen', 'Guía', 'Apunte'];

  function load() {
    try { var j = JSON.parse(localStorage.getItem(KEY)); if (j && j.v === 1) return j; } catch (e) { /* base vacía */ }
    return { v: 1, users: {}, materials: [], comments: {}, reports: [], session: null, nextId: 1 };
  }
  var db = load();
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(db)); }
    catch (e) { throw new Error('No se pudo guardar en este dispositivo. Revisá que tenga espacio disponible.'); }
  }
  function bad(msg, status) { var e = new Error(msg); if (status) e.status = status; return e; }
  function today() { return new Date().toISOString().slice(0, 10); }
  function uuid() { return (root.crypto && root.crypto.randomUUID) ? root.crypto.randomUUID() : 'u' + Date.now().toString(36) + Math.random().toString(16).slice(2); }
  function str(v, min, max, label) {
    v = typeof v === 'string' ? v.trim() : '';
    if (v.length < min || v.length > max) throw bad('Revisá ' + label.toLowerCase() + '.');
    return v;
  }
  async function hash(pw, salt) {
    if (root.crypto && root.crypto.subtle) {
      var buf = await root.crypto.subtle.digest('SHA-256', new TextEncoder().encode(salt + ':' + pw));
      return Array.prototype.map.call(new Uint8Array(buf), function (b) { return b.toString(16).padStart(2, '0'); }).join('');
    }
    var h = 5381, s = salt + pw;
    for (var i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
    return 'x' + h;
  }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  /* ---- archivos en IndexedDB ---- */
  function idb() {
    return new Promise(function (res, rej) {
      var r = indexedDB.open(IDB_NAME, 1);
      r.onupgradeneeded = function () { r.result.createObjectStore(STORE); };
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
    });
  }
  async function idbPut(k, blob) {
    var d = await idb();
    return new Promise(function (res, rej) { var tx = d.transaction(STORE, 'readwrite'); tx.objectStore(STORE).put(blob, k); tx.oncomplete = res; tx.onerror = function () { rej(tx.error); }; });
  }
  async function idbGet(k) {
    var d = await idb();
    return new Promise(function (res, rej) { var rq = d.transaction(STORE).objectStore(STORE).get(k); rq.onsuccess = function () { res(rq.result); }; rq.onerror = function () { rej(rq.error); }; });
  }
  async function idbDel(k) {
    var d = await idb();
    return new Promise(function (res, rej) { var tx = d.transaction(STORE, 'readwrite'); tx.objectStore(STORE).delete(k); tx.oncomplete = res; tx.onerror = function () { rej(tx.error); }; });
  }

  /* ---- ayudas ---- */
  function cur() {
    var u = db.session && db.users[db.session];
    if (!u) throw bad('Tenés que ingresar de nuevo.', 401);
    return u;
  }
  function notify(email, ic, t, ref) {
    var u = db.users[email]; if (!u) return;
    u.nid = (u.nid || 0) + 1;
    u.notifs.unshift({ id: u.nid, ic: ic, t: t, ref: ref, read: false, d: today() });
    u.notifs = u.notifs.slice(0, 40);
  }
  function pub(m, me) {
    return { id: m.id, title: m.title, subject: m.subject, sede: m.sede, career: m.career, year: m.year, type: m.type, format: m.format, uploader: m.uploader, date: m.d, up: m.up, down: m.down, dl: m.dl, pages: m.pages, desc: m.descr, preview: m.preview, tags: m.tags || [], mine: m.owner === me.email, _file: m.file_path, _fname: m.file_name };
  }
  function newData() { return { saved: {}, collections: [{ id: 'gen', name: 'General' }], downloads: [], recent: [], prefs: { newMat: true, replies: true, wifi: false } }; }
  function ranking(me) {
    var g = {};
    db.materials.forEach(function (m) {
      var o = g[m.owner] || (g[m.owner] = { n: m.uploader, s: (db.users[m.owner] || {}).sede || m.sede, up: 0, pts: 0, me: m.owner === me.email });
      o.up++; o.pts += 10 + m.up;
    });
    if (!g[me.email]) g[me.email] = { n: me.name, s: me.sede, up: 0, pts: 0, me: true };
    return Object.keys(g).map(function (k) { return g[k]; }).sort(function (a, b) { return b.pts - a.pts; });
  }
  function findMat(id) { var m = db.materials.find(function (x) { return x.id === Number(id); }); if (!m) throw bad('Ese material ya no existe.', 404); return m; }
  function pubUser(u) { return { name: u.name, email: u.email, sede: u.sede, career: u.career, year: u.year }; }

  async function api(method, path, body) {
    db = load();   // por si hay otra pestaña abierta
    var id = (path.match(/\/(\d+)/) || [])[1];
    var key = method + ' ' + path.replace(/\/\d+/g, '/:id');
    body = body || {};
    switch (key) {
      case 'POST /api/register': {
        var name = str(body.name, 2, 60, 'El nombre');
        var email = str(body.email, 5, 120, 'El correo').toLowerCase();
        if (!/^\S+@\S+\.\S+$/.test(email)) throw bad('Ingresá un correo válido.');
        if (typeof body.password !== 'string' || body.password.length < 6) throw bad('La contraseña tiene que tener al menos 6 caracteres.');
        var y = Number(body.year);
        if (!body.sede || !body.career || !(y >= 1 && y <= 7)) throw bad('Elegí tu sede, tu carrera y el año de cursada.');
        if (db.users[email]) throw bad('Ya hay una cuenta con ese correo. Probá ingresar.');
        var salt = uuid();
        db.users[email] = { id: uuid(), email: email, name: name, sede: body.sede, career: body.career, year: y, salt: salt, pw: await hash(body.password, salt), votes: {}, notifs: [], nid: 0, data: newData() };
        notify(email, 'star', '¡Bienvenido/a al Repositorio UCA! Explorá, guardá y compartí material.', 'explore');
        db.session = email; save();
        return { token: 'local' };
      }
      case 'POST /api/login': {
        var em = String(body.email || '').trim().toLowerCase(), u = db.users[em];
        if (!u || (await hash(String(body.password || ''), u.salt)) !== u.pw) throw bad('Correo o contraseña incorrectos.');
        db.session = em; save();
        return { token: 'local' };
      }
      case 'POST /api/logout': { db.session = null; save(); return { ok: true }; }
      case 'GET /api/bootstrap': {
        var me = cur();
        var comments = {};
        Object.keys(db.comments).forEach(function (k) { if (db.comments[k].length) comments[k] = db.comments[k]; });
        return clone({
          user: pubUser(me),
          materials: db.materials.slice().sort(function (a, b) { return b.id - a.id; }).map(function (m) { return pub(m, me); }),
          comments: comments, rank: ranking(me), votes: me.votes, notifs: me.notifs, data: me.data
        });
      }
      case 'PUT /api/userdata': {
        var u1 = cur(), d = body, o = u1.data;
        if (d.saved && typeof d.saved === 'object') o.saved = d.saved;
        if (Array.isArray(d.collections)) { o.collections = d.collections.slice(0, 50); if (!o.collections.some(function (c) { return c.id === 'gen'; })) o.collections.unshift({ id: 'gen', name: 'General' }); }
        if (Array.isArray(d.downloads)) o.downloads = d.downloads.slice(0, 200);
        if (Array.isArray(d.recent)) o.recent = d.recent.slice(0, 6);
        if (d.prefs && typeof d.prefs === 'object') o.prefs = d.prefs;
        save(); return { ok: true };
      }
      case 'PUT /api/me': {
        var u2 = cur();
        u2.name = str(body.name, 2, 60, 'El nombre'); u2.sede = body.sede; u2.career = body.career; u2.year = Number(body.year);
        db.materials.forEach(function (m) { if (m.owner === u2.email) m.uploader = u2.name; });
        save(); return { ok: true };
      }
      case 'POST /api/materials': {
        var u3 = cur(), f = body.file || {};
        var title = str(body.title, 5, 90, 'El título'), subject = str(body.subject, 2, 80, 'La materia');
        if (TYPES.indexOf(body.type) < 0) throw bad('Elegí un tipo de material válido.');
        var ext = String(f.name || '').split('.').pop().toLowerCase();
        if (!FMT[ext]) throw bad('Ese formato no está permitido. Subí un PDF, Word, PowerPoint o imagen.');
        var path3 = null, bytes = 0;
        if (f.data) {
          var blob = await (await fetch(f.data)).blob();
          if (blob.size > 20 * 1024 * 1024) throw bad('El archivo pesa más de 20 MB.');
          bytes = blob.size; path3 = u3.id + '/' + uuid() + '.' + ext;
          await idbPut(path3, blob);
        }
        var m = {
          id: db.nextId++, owner: u3.email, title: title, subject: subject, sede: body.sede, career: body.career, year: Number(body.year), type: body.type, format: FMT[ext],
          uploader: u3.name, d: today(), up: 0, down: 0, dl: 0,
          pages: Math.min(500, Math.max(1, Math.round(f.pages || (bytes ? bytes / 90000 : 3)))),
          descr: (typeof body.desc === 'string' && body.desc.trim().slice(0, 300)) || 'Material compartido por un estudiante de la UCA.',
          preview: path3 ? 'Archivo: ' + f.name + '\n\nLa vista previa completa se genera cuando se procesa el archivo.' : '',
          tags: (body.tags || []).slice(0, 5), file_path: path3, file_name: f.name || null
        };
        db.materials.push(m);
        try { save(); } catch (e) { if (path3) await idbDel(path3); throw e; }
        return { id: m.id };
      }
      case 'DELETE /api/materials/:id': {
        var u4 = cur(), m4 = findMat(id);
        if (m4.owner !== u4.email) throw bad('Solo podés eliminar tus propios aportes.');
        db.materials = db.materials.filter(function (x) { return x.id !== m4.id; });
        delete db.comments[m4.id];
        Object.keys(db.users).forEach(function (k) { delete db.users[k].votes[m4.id]; });
        save();
        if (m4.file_path) { try { await idbDel(m4.file_path); } catch (e) { /* queda huérfano, no es grave */ } }
        return { ok: true };
      }
      case 'POST /api/materials/:id/vote': {
        var u5 = cur(), m5 = findMat(id), v = Number(body.v);
        if (v !== 1 && v !== -1) throw bad('Voto inválido.');
        if (m5.owner === u5.email) throw bad('No podés votar tu propio aporte.');
        var c0 = u5.votes[m5.id] || 0;
        if (c0 === 1) m5.up--; if (c0 === -1) m5.down--;
        var nv = c0 === v ? 0 : v;
        if (nv === 1) { m5.up++; notify(m5.owner, 'star', 'Tu aporte "' + m5.title + '" recibió un voto útil', 'doc/' + m5.id); }
        if (nv === -1) m5.down++;
        if (nv === 0) delete u5.votes[m5.id]; else u5.votes[m5.id] = nv;
        save(); return { vote: nv };
      }
      case 'POST /api/materials/:id/comments': {
        var u6 = cur(), m6 = findMat(id), t = str(body.t, 1, 280, 'El comentario');
        var c = { who: u6.name, t: t, d: today() };
        (db.comments[m6.id] = db.comments[m6.id] || []).push(c);
        if (m6.owner !== u6.email) notify(m6.owner, 'comment', u6.name + ' comentó en tu aporte "' + m6.title + '"', 'comments/' + m6.id);
        save(); return c;
      }
      case 'POST /api/materials/:id/download': {
        var u7 = cur(), m7 = findMat(id);
        m7.dl++;
        if (m7.owner !== u7.email && m7.dl % 10 === 0) notify(m7.owner, 'download', 'Tu aporte "' + m7.title + '" ya se descargó ' + m7.dl + ' veces', 'doc/' + m7.id);
        save(); return { dl: m7.dl };
      }
      case 'POST /api/materials/:id/report': {
        var u8 = cur(), m8 = findMat(id);
        db.reports.push({ id: m8.id, by: u8.email, reason: str(body.reason, 2, 80, 'El motivo'), detail: String(body.detail || '').slice(0, 300), d: today() });
        save(); return { ok: true };
      }
      case 'POST /api/notifs/read': {
        var u9 = cur();
        u9.notifs.forEach(function (n) { if (body.all || n.id === Number(body.id)) n.read = true; });
        save(); return { ok: true };
      }
      default: throw bad('Acción desconocida: ' + key);
    }
  }

  /* devuelve una dirección desde la que se puede bajar el archivo de un material */
  async function fileUrl(m) {
    var blob = m._file ? await idbGet(m._file) : null;
    if (!blob) return null;
    var url = URL.createObjectURL(blob);
    return { url: url, name: m._fname, revoke: function () { URL.revokeObjectURL(url); } };
  }
  function hasSession() { db = load(); return !!(db.session && db.users[db.session]); }

  root.createLocalApi = function () { return { api: api, fileUrl: fileUrl, hasSession: hasSession }; };
})(typeof window !== 'undefined' ? window : globalThis);
