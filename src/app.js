'use strict';
(function () {
  var T = window.__TAURI__, fs = T.fs, $ = function (s) { return document.querySelector(s); };
  var SEP = '\\', saveDir = '', bakDir = '', page = 'snapshots', busyUntil = 0, unwatch = null, timer = null, KEEP_AUTO = 20;
  var j = function (a, b) { return a.replace(/[\\/]+$/, '') + SEP + b; };
  var esc = function (s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  var fmtSize = function (n) { return n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; };
  var pad = function (n) { return String(n).padStart(2, '0'); };

  function toast(msg) { var t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(t._t); t._t = setTimeout(function () { t.classList.remove('show'); }, 2600); }

  function ask(title, text, o) {
    o = o || {};
    return new Promise(function (res) {
      var d = $('#dlg'), i = $('#di');
      $('#dt').textContent = title; $('#dx').textContent = text || '';
      $('#dok').textContent = o.ok || 'OK'; i.hidden = !o.input; i.value = typeof o.input === 'string' ? o.input : '';
      d.onclose = function () { res(d.returnValue === 'ok' ? (o.input ? i.value.trim() : true) : null); };
      d.returnValue = ''; d.showModal(); if (o.input) i.focus();
    });
  }

  /* ---------- file helpers ---------- */
  async function copyDir(s, d) {
    await fs.mkdir(d, { recursive: true });
    for (var e of await fs.readDir(s)) {
      if (e.isDirectory) await copyDir(j(s, e.name), j(d, e.name)); else await fs.copyFile(j(s, e.name), j(d, e.name));
    }
  }
  async function dirSize(p) {
    var n = 0;
    for (var e of await fs.readDir(p)) n += e.isDirectory ? await dirSize(j(p, e.name)) : (await fs.stat(j(p, e.name))).size;
    return n;
  }

  /* ---------- snapshots ---------- */
  async function list() {
    if (!(await fs.exists(bakDir))) return [];
    var out = [];
    for (var e of await fs.readDir(bakDir)) {
      if (!e.isDirectory) continue;
      try { out.push(JSON.parse(await fs.readTextFile(j(j(bakDir, e.name), 'snapshot.json')))); } catch (_) { /* not ours */ }
    }
    return out.sort(function (a, b) { return b.created.localeCompare(a.created); });
  }
  async function snap(tag, auto) {
    var n = new Date(), id = n.getFullYear() + pad(n.getMonth() + 1) + pad(n.getDate()) + '-' + pad(n.getHours()) + pad(n.getMinutes()) + pad(n.getSeconds());
    var dir = j(bakDir, id), data = j(dir, 'data');
    busyUntil = Date.now() + 6000;
    await copyDir(saveDir, data);
    var meta = { id: id, tag: tag || '', auto: !!auto, created: n.toISOString(), size: await dirSize(data), files: (await fs.readDir(data)).length };
    await fs.writeTextFile(j(dir, 'snapshot.json'), JSON.stringify(meta));
    if (auto) { var old = (await list()).filter(function (m) { return m.auto; }).slice(KEEP_AUTO); for (var m of old) await fs.remove(j(bakDir, m.id), { recursive: true }); }
    return meta;
  }
  async function restore(id) {
    await snap('Before restore', true);
    var data = j(j(bakDir, id), 'data'), keep = new Set((await fs.readDir(data)).map(function (e) { return e.name; }));
    busyUntil = Date.now() + 8000;
    for (var e of await fs.readDir(saveDir)) if (!keep.has(e.name)) await fs.remove(j(saveDir, e.name), { recursive: true });
    await copyDir(data, saveDir);
  }

  /* ---------- auto backup ---------- */
  async function startWatch() {
    if (unwatch) { unwatch(); unwatch = null; }
    if (localStorage.getItem('auto') === '0' || !saveDir || !(await fs.exists(saveDir))) return;
    unwatch = await fs.watch(saveDir, function () {
      if (Date.now() < busyUntil) return;
      clearTimeout(timer);
      timer = setTimeout(async function () {
        if (Date.now() < busyUntil) return;
        var last = (await list())[0];
        if (last && Date.now() - new Date(last.created) < 15000) return;
        try { await snap('', true); toast('Auto backup created'); if (page === 'snapshots') render(); } catch (e) { toast('Auto backup failed: ' + e); }
      }, 5000);
    }, { recursive: false, delayMs: 1500 });
  }

  /* ---------- views ---------- */
  async function renderSnapshots() {
    var ok = await fs.exists(saveDir), v = $('#view');
    var head = '<h1>Snapshots</h1><p class="sub">' + esc(saveDir) + ' &middot; ' + (ok ? '<span class="good">found</span>' : '<span class="bad">not found</span>') + '</p>';
    if (!ok) { v.innerHTML = head + '<div class="empty">Save folder not found.<br><br><button data-act="pick" class="pri">Choose folder</button></div>'; return; }
    var l = await list();
    var rows = l.map(function (m) {
      return '<div class="snap"><div><h4>' + esc(m.tag || 'Snapshot') + '<span class="tag ' + (m.auto ? '' : 'man') + '">' + (m.auto ? 'Auto' : 'Manual') + '</span></h4>' +
        '<div class="meta">' + new Date(m.created).toLocaleString() + ' &middot; ' + m.files + ' items &middot; ' + fmtSize(m.size) + '</div></div>' +
        '<div class="acts" data-id="' + m.id + '"><button data-act="restore" class="pri">Restore</button><button data-act="rename">Rename</button><button data-act="del" class="dng">Delete</button></div></div>';
    }).join('');
    v.innerHTML = head + '<div class="bar"><button data-act="backup" class="pri">Back up now</button><span class="sp"></span><span class="meta">' + l.length + ' snapshot' + (l.length === 1 ? '' : 's') + '</span></div>' +
      (rows || '<div class="empty">No snapshots yet. Back up now, or play and let auto backup do it.</div>');
  }
  async function renderSettings() {
    var auto = localStorage.getItem('auto') !== '0';
    $('#view').innerHTML = '<h1>Settings</h1><p class="sub">Vostok Quartermaster</p>' +
      '<div class="set"><h4>Save folder</h4><p>' + esc(saveDir) + '</p><button data-act="pick">Change&hellip;</button> <button data-act="open-save">Show in Explorer</button></div>' +
      '<div class="set"><h4>Backups folder</h4><p>' + esc(bakDir) + '</p><button data-act="open-bak">Show in Explorer</button></div>' +
      '<div class="set"><h4>Auto backup</h4><p>Creates a snapshot a few seconds after the game saves. The newest ' + KEEP_AUTO + ' automatic snapshots are kept; manual ones are never removed.</p>' +
      '<label><input type="checkbox" id="auto" ' + (auto ? 'checked' : '') + '> Enable auto backup</label></div>';
  }
  function render() { return (page === 'settings' ? renderSettings() : renderSnapshots()).catch(function (e) { $('#view').innerHTML = '<div class="empty bad">' + esc(e) + '</div>'; }); }

  /* ---------- events ---------- */
  document.addEventListener('click', async function (ev) {
    var nb = ev.target.closest('#nav button[data-page]');
    if (nb) { page = nb.dataset.page; document.querySelectorAll('#nav button').forEach(function (b) { b.classList.toggle('on', b === nb); }); return render(); }
    var b = ev.target.closest('[data-act]'); if (!b) return;
    var act = b.dataset.act, id = b.parentElement.dataset.id;
    try {
      if (act === 'backup') { var tag = await ask('Back up now', 'Add a tag to find it later (optional).', { input: true, ok: 'Back up' }); if (tag === null) return; await snap(tag, false); toast('Snapshot saved'); }
      else if (act === 'restore') { if (!(await ask('Restore this snapshot?', 'Close Road to Vostok first. Your current save is backed up automatically, then replaced with this snapshot.', { ok: 'Restore' }))) return; await restore(id); toast('Snapshot restored'); }
      else if (act === 'rename') { var m = (await list()).find(function (x) { return x.id === id; }); var t = await ask('Rename snapshot', '', { input: m.tag, ok: 'Save' }); if (t === null) return; m.tag = t; await fs.writeTextFile(j(j(bakDir, id), 'snapshot.json'), JSON.stringify(m)); }
      else if (act === 'del') { if (!(await ask('Delete snapshot?', 'This cannot be undone.', { ok: 'Delete' }))) return; await fs.remove(j(bakDir, id), { recursive: true }); }
      else if (act === 'pick') { var p = await T.dialog.open({ directory: true, defaultPath: saveDir, title: 'Choose the Road to Vostok save folder' }); if (!p) return; saveDir = p; localStorage.setItem('saveDir', p); await startWatch(); }
      else if (act === 'open-save') return T.opener.revealItemInDir(saveDir);
      else if (act === 'open-bak') { await fs.mkdir(bakDir, { recursive: true }); return T.opener.revealItemInDir(bakDir); }
    } catch (e) { toast('Error: ' + e); }
    render();
  });
  document.addEventListener('change', function (ev) { if (ev.target.id === 'auto') { localStorage.setItem('auto', ev.target.checked ? '1' : '0'); startWatch(); } });

  /* ---------- start ---------- */
  (async function () {
    try {
      var data = await T.path.dataDir(); SEP = data.indexOf('\\') !== -1 ? '\\' : '/';
      saveDir = localStorage.getItem('saveDir') || j(data, 'Road to Vostok');
      bakDir = j(await T.path.appDataDir(), 'backups');
      await fs.mkdir(bakDir, { recursive: true });
      await startWatch();
    } catch (e) { toast('Startup error: ' + e); }
    render();
  })();
})();
