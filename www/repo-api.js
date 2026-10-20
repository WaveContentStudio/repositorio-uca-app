/* Repositorio UCA - conexión con Supabase
   La app llama a api('POST', '/api/...') y acá se traduce a Supabase (auth, base de datos y archivos). */
(function (root) {
  'use strict';
  var MIME = { pdf: 'application/pdf', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png' };
  var FMT = { pdf: 'PDF', doc: 'DOCX', docx: 'DOCX', ppt: 'PPTX', pptx: 'PPTX', jpg: 'IMG', jpeg: 'IMG', png: 'IMG' };

  function es(e) {
    var m = (e && e.message) || String(e || '');
    if (/Failed to fetch|NetworkError|Load failed|fetch failed/i.test(m)) return 'No hay conexión con el servidor. Revisá tu internet.';
    if (/Invalid login credentials/i.test(m)) return 'Correo o contraseña incorrectos.';
    if (/already registered|already been registered/i.test(m)) return 'Ya hay una cuenta con ese correo. Probá ingresar.';
    if (/Email not confirmed/i.test(m)) return 'Tenés que confirmar tu correo antes de ingresar. Revisá tu bandeja de entrada.';
    if (/at least \d+ characters/i.test(m)) return 'La contraseña tiene que tener al menos 6 caracteres.';
    if (/rate limit|too many requests/i.test(m)) return 'Hubo demasiados intentos. Esperá unos minutos y probá de nuevo.';
    if (/row-level security/i.test(m)) return 'No tenés permiso para hacer eso.';
    if (/duplicate key/i.test(m)) return 'Eso ya existe.';
    if (/violates check constraint/i.test(m)) return 'Revisá los datos: alguno no cumple el formato permitido.';
    if (/too large|maximum allowed size/i.test(m)) return 'El archivo es demasiado grande (máximo 20 MB).';
    if (/mime type|not supported/i.test(m)) return 'Ese formato de archivo no está permitido.';
    if (/JWT|not authenticated|Auth session missing/i.test(m)) return 'Tu sesión venció. Ingresá de nuevo.';
    return m || 'Algo salió mal.';
  }
  function unauth() { var e = new Error('Tenés que ingresar de nuevo.'); e.status = 401; return e; }
  function chk(res) {
    if (res.error) { var er = new Error(res.error.message || 'Error'); er.code = res.error.code; er.status = res.status; throw er; }
    return res.data;
  }

  function createRepoApi(sb) {
    async function me() {
      var r = await sb.auth.getSession();
      if (!r.data || !r.data.session) throw unauth();
      return r.data.session.user;
    }

    async function bootstrap() {
      var u = await me(), uid = u.id;
      var rs = await Promise.all([
        sb.from('profiles').select('name,sede,career,year').eq('id', uid).maybeSingle(),
        sb.from('materials').select('*').order('id', { ascending: false }),
        sb.from('comments').select('material_id,who,t,d').order('id', { ascending: true }),
        sb.from('ranking').select('id,n,s,up,pts'),
        sb.from('votes').select('material_id,v'),
        sb.from('notifications').select('id,ic,t,ref,read,d').order('id', { ascending: false }).limit(40),
        sb.from('user_data').select('data').eq('user_id', uid).maybeSingle()
      ]);
      var prof = chk(rs[0]);
      if (!prof) throw new Error('Tu perfil no se creó. Volvé a ejecutar el script SQL en Supabase y registrate de nuevo.');
      var mats = chk(rs[1]).map(function (r) {
        return { id: r.id, title: r.title, subject: r.subject, sede: r.sede, career: r.career, year: r.year, type: r.type, format: r.format, uploader: r.uploader, date: r.d, up: r.up, down: r.down, dl: r.dl, pages: r.pages, desc: r.descr, preview: r.preview, tags: r.tags || [], mine: r.owner === uid, _file: r.file_path, _fname: r.file_name };
      });
      var comments = {};
      chk(rs[2]).forEach(function (c) { (comments[c.material_id] = comments[c.material_id] || []).push({ who: c.who, t: c.t, d: c.d }); });
      var rank = chk(rs[3]).map(function (r) { return { n: r.n, s: r.s, up: r.up, pts: r.pts, me: r.id === uid }; });
      if (!rank.some(function (r) { return r.me; })) rank.push({ n: prof.name, s: prof.sede, up: 0, pts: 0, me: true });
      rank.sort(function (a, b) { return b.pts - a.pts; });
      var votes = {};
      chk(rs[4]).forEach(function (v) { votes[v.material_id] = v.v; });
      var ud = chk(rs[6]);
      return {
        user: { name: prof.name, email: u.email, sede: prof.sede, career: prof.career, year: prof.year },
        materials: mats, comments: comments, rank: rank, votes: votes, notifs: chk(rs[5]), data: (ud && ud.data) || {}
      };
    }

    async function api(method, path, body) {
      var id = (path.match(/\/(\d+)/) || [])[1];
      var key = method + ' ' + path.replace(/\/\d+/g, '/:id');
      body = body || {};
      try {
        switch (key) {
          case 'POST /api/register': {
            var r = await sb.auth.signUp({ email: body.email, password: body.password, options: { data: { name: body.name, sede: body.sede, career: body.career, year: body.year } } });
            if (r.error) throw r.error;
            if (r.data.user && r.data.user.identities && r.data.user.identities.length === 0) throw new Error('already registered');
            if (!r.data.session) throw new Error('Te mandamos un correo para confirmar tu cuenta. Abrí el enlace y después ingresá.');
            return { token: 'sb' };
          }
          case 'POST /api/login': {
            var l = await sb.auth.signInWithPassword({ email: body.email, password: body.password });
            if (l.error) throw l.error;
            return { token: 'sb' };
          }
          case 'POST /api/logout': { await sb.auth.signOut(); return { ok: true }; }
          case 'GET /api/bootstrap': return await bootstrap();
          case 'PUT /api/userdata': {
            var u1 = await me();
            chk(await sb.from('user_data').upsert({ user_id: u1.id, data: body }, { onConflict: 'user_id' }));
            return { ok: true };
          }
          case 'PUT /api/me': {
            var u2 = await me();
            var upd = await sb.from('profiles').update({ name: body.name, sede: body.sede, career: body.career, year: body.year }).eq('id', u2.id).select('name');
            if (!chk(upd).length) throw new Error('No se pudo guardar el perfil.');
            return { ok: true };
          }
          case 'POST /api/materials': {
            var u3 = await me(), f = body.file || {};
            var ext = String(f.name || '').split('.').pop().toLowerCase();
            if (!FMT[ext]) throw new Error('Ese formato no está permitido. Subí un PDF, Word, PowerPoint o imagen.');
            var path3 = null;
            if (f.data) {
              var blob = await (await fetch(f.data)).blob();
              if (blob.size > 20 * 1024 * 1024) throw new Error('El archivo pesa más de 20 MB.');
              path3 = u3.id + '/' + (root.crypto || globalThis.crypto).randomUUID() + '.' + ext;
              var up = await sb.storage.from('materials').upload(path3, blob, { contentType: MIME[ext], upsert: false });
              if (up.error) throw up.error;
            }
            var ins = await sb.from('materials').insert({
              owner: u3.id, title: body.title, subject: body.subject, sede: body.sede, career: body.career, year: body.year, type: body.type, format: FMT[ext],
              pages: Math.min(500, Math.max(1, Math.round(f.pages || (f.bytes ? f.bytes / 90000 : 3)))),
              descr: body.desc || 'Material compartido por un estudiante de la UCA.',
              preview: path3 ? 'Archivo: ' + f.name + '\n\nLa vista previa completa se genera cuando se procesa el archivo.' : '',
              tags: body.tags || [], file_path: path3, file_name: f.name || null
            }).select('id').single();
            if (ins.error) { if (path3) await sb.storage.from('materials').remove([path3]); throw ins.error; }
            return { id: ins.data.id };
          }
          case 'DELETE /api/materials/:id': {
            var cur = chk(await sb.from('materials').select('file_path').eq('id', Number(id)).maybeSingle());
            var del = chk(await sb.from('materials').delete().eq('id', Number(id)).select('id'));
            if (!del.length) throw new Error('Solo podés eliminar tus propios aportes.');
            if (cur && cur.file_path) { try { await sb.storage.from('materials').remove([cur.file_path]); } catch (e) { /* el archivo quedó huérfano, no es grave */ } }
            return { ok: true };
          }
          case 'POST /api/materials/:id/vote': {
            var vv = chk(await sb.rpc('cast_vote', { p_material: Number(id), p_v: body.v }));
            return { vote: vv };
          }
          case 'POST /api/materials/:id/comments': {
            var u4 = await me();
            return chk(await sb.from('comments').insert({ material_id: Number(id), user_id: u4.id, t: body.t }).select('who,t,d').single());
          }
          case 'POST /api/materials/:id/download': {
            return { dl: chk(await sb.rpc('register_download', { p_material: Number(id) })) };
          }
          case 'POST /api/materials/:id/report': {
            var u5 = await me();
            chk(await sb.from('reports').insert({ material_id: Number(id), user_id: u5.id, reason: body.reason, detail: body.detail || '' }));
            return { ok: true };
          }
          case 'POST /api/notifs/read': {
            var u6 = await me();
            var q = sb.from('notifications').update({ read: true }).eq('user_id', u6.id);
            if (!body.all) q = q.eq('id', Number(body.id));
            chk(await q);
            return { ok: true };
          }
          default: throw new Error('Acción desconocida: ' + key);
        }
      } catch (e) {
        var err = new Error(es(e));
        err.status = e.status === 401 || /JWT|Auth session missing/i.test((e && e.message) || '') ? 401 : e.status;
        throw err;
      }
    }
    /* dirección desde la que se puede bajar el archivo de un material */
    async function fileUrl(m) {
      if (!m._file) return null;
      return { url: sb.storage.from('materials').getPublicUrl(m._file, { download: m._fname || true }).data.publicUrl, name: m._fname };
    }
    return { api: api, es: es, fileUrl: fileUrl };
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { createRepoApi: createRepoApi, es: es };
  else root.createRepoApi = createRepoApi;
})(typeof window !== 'undefined' ? window : globalThis);
