'use strict';
(function () {
  var T = window.__TAURI__, fs = T.fs, $ = function (s) { return document.querySelector(s); };
  var SEP = '\\', saveDir = '', bakDir = '', page = 'snapshots', busyUntil = 0, unwatch = null, timer = null, KEEP_AUTO = 20;
  var j = function (a, b) { return a.replace(/[\\/]+$/, '') + SEP + b; };
  var esc = function (s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  var fmtSize = function (n) { return n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; };
  function skipList() { var v = localStorage.getItem('skip'); return (v === null ? 'logs, shader_cache, vulkan, d3d12, modloader_hooks, vmz_mount_cache, mws_cache' : v).split(',').map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean); }
  var skipped = function (n) { return skipList().indexOf(n.toLowerCase()) !== -1; };
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
  async function copyDir(s, d, top) {
    await fs.mkdir(d, { recursive: true });
    for (var e of await fs.readDir(s)) {
      if (top && skipped(e.name)) continue;
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
    await copyDir(saveDir, data, true);
    var meta = { id: id, tag: tag || '', auto: !!auto, created: n.toISOString(), size: await dirSize(data), files: (await fs.readDir(data)).length };
    await fs.writeTextFile(j(dir, 'snapshot.json'), JSON.stringify(meta));
    if (auto) { var old = (await list()).filter(function (m) { return m.auto; }).slice(KEEP_AUTO); for (var m of old) await fs.remove(j(bakDir, m.id), { recursive: true }); }
    return meta;
  }
  async function restore(id) {
    await snap('Before restore', true);
    var data = j(j(bakDir, id), 'data'), keep = new Set((await fs.readDir(data)).map(function (e) { return e.name; }));
    busyUntil = Date.now() + 8000;
    for (var e of await fs.readDir(saveDir)) if (!keep.has(e.name) && !skipped(e.name)) await fs.remove(j(saveDir, e.name), { recursive: true });
    await copyDir(data, saveDir);
  }

  /* ---------- auto backup ---------- */
  async function startWatch() {
    if (unwatch) { unwatch(); unwatch = null; }
    if (localStorage.getItem('auto') !== '1' || !saveDir || !(await fs.exists(saveDir))) return;
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



  /* ---------- world info (day, season, difficulty, weather) ---------- */
  // In-game values as stored in World.tres. Unknown numbers fall back to showing the raw value.
  var WORLD = { difficulty: { 1: 'Standard', 2: 'Darkness', 3: 'Ironman' }, season: { 1: 'Summer', 2: 'Winter' } };
  async function worldInfo(dataDir) {
    try {
      var t = Tres.parse(await fs.readTextFile(j(dataDir, 'World.tres'))), m = t.main();
      var g = function (k) { var v = t.get(m, k); return v === undefined ? null : String(v).replace(/^"|"$/g, ''); };
      return { day: g('day'), time: g('time'), season: g('season'), difficulty: g('difficulty'), weather: g('weather') };
    } catch (_) { return null; }
  }
  // time is stored as hours x 100 with a decimal fraction (2341.2 = 23.412 h = 23:24)
  function fmtTime(t) { return pad(Math.floor(t / 100) % 24) + ':' + pad(Math.floor((t % 100) * 0.6)); }
  function fmtWorld(w) {
    if (!w) return '';
    var p = [];
    if (w.day !== null) p.push('Day ' + esc(w.day));
    if (w.time !== null && !isNaN(parseFloat(w.time))) p.push(fmtTime(parseFloat(w.time)));
    if (w.season !== null) p.push(esc(WORLD.season[w.season] || 'Season ' + w.season));
    if (w.difficulty !== null) p.push(esc(WORLD.difficulty[w.difficulty] || 'Difficulty ' + w.difficulty));
    if (w.weather) p.push(esc(w.weather));
    return p.join(' &middot; ');
  }

  /* ---------- repair: remove items from mods that are no longer installed ---------- */
  var modsDir = localStorage.getItem('modsDir') || '', RS = { src: 'live' };
  var normName = function (s) { return s.toLowerCase().replace(/\.(vmz|zip|pck|vmod|7z)$/, '').replace(/[^a-z0-9]/g, ''); };
  var isTres = function (e) { return !e.isDirectory && /\.tres$/i.test(e.name); };
  async function scanDir(dir) {
    var have = (await fs.readDir(modsDir)).map(function (e) { return normName(e.name); }), mods = {};
    for (var e of await fs.readDir(dir)) {
      if (!isTres(e)) continue;
      var txt = await fs.readTextFile(j(dir, e.name)), t = Tres.parse(txt);
      t.dependencies().forEach(function (d) {
        if (!d.mod) return;
        var m = mods[d.mod] || (mods[d.mod] = { name: d.mod, items: 0, stored: 0, other: 0, files: {} });
        if (d.type === 'Resource') { m.items += t.usesOf(d.id); try { m.stored += Tres.parse(txt).removeItemsUsing(d.id).children.length; } catch (_) { /* count only */ } } else m.other++;
        m.files[e.name] = 1;
      });
    }
    return Object.keys(mods).sort().map(function (k) {
      var m = mods[k], n = normName(k); m.found = have.some(function (h) { return h === n || (n.length > 3 && h.indexOf(n) !== -1); }); return m;
    });
  }
  async function snapFrom(src, tag) {
    var n = new Date(), id = n.getFullYear() + pad(n.getMonth() + 1) + pad(n.getDate()) + '-' + pad(n.getHours()) + pad(n.getMinutes()) + pad(n.getSeconds());
    var dir = j(bakDir, id), data = j(dir, 'data');
    await copyDir(src, data, true);
    var meta = { id: id, tag: tag, auto: false, created: n.toISOString(), size: await dirSize(data), files: (await fs.readDir(data)).length };
    await fs.writeTextFile(j(dir, 'snapshot.json'), JSON.stringify(meta));
    return meta;
  }
  async function cleanTo(src, tag, chosen) {
    var meta = await snapFrom(src, tag), data = j(j(bakDir, meta.id), 'data'), done = [], left = 0;
    var mine = function (b) { return chosen.indexOf(Tres.modOf(b.attrs.path || '')) !== -1; };
    for (var e of await fs.readDir(data)) {
      if (!isTres(e)) continue;
      var p = j(data, e.name), t = Tres.parse(await fs.readTextFile(p)), n = 0, st = 0;
      t.ext().filter(function (b) { return b.attrs.type === 'Resource' && mine(b); }).forEach(function (b) { var r = t.removeItemsUsing(b.attrs.id); n += r.slots.length; st += r.children.length; });
      left += t.ext().filter(mine).length;
      if (!n) continue;
      var bad = t.validate(); if (bad.length) throw new Error(e.name + ': ' + bad[0]);
      await fs.writeTextFile(p, t.serialize()); done.push(e.name + ' (' + n + (st ? ' + ' + st + ' stored inside' : '') + ')');
    }
    return { meta: meta, done: done, left: left };
  }
  async function renderRepair() {
    var v = $('#view'), head = '<h1>Repair</h1><p class="sub">Finds items from mods that are no longer installed and removes them into a cleaned copy. Your live save is never changed.</p>';
    if (!modsDir) { v.innerHTML = head + '<div class="empty">Choose the game\'s <b>mods</b> folder first.<br><br><button data-act="pickmods" class="pri">Choose mods folder</button></div>'; return; }
    var l = await list(), mods;
    if (RS.src !== 'live' && !l.some(function (m) { return m.id === RS.src; })) RS.src = 'live';
    var srcDir = RS.src === 'live' ? saveDir : j(j(bakDir, RS.src), 'data');
    try { mods = await scanDir(srcDir); } catch (e) { v.innerHTML = head + '<div class="empty bad">Could not read the folders: ' + esc(e) + '<br><br><button data-act="pickmods" class="pri">Choose mods folder again</button> <button data-act="srclive">Use current save folder</button></div>'; return; }
    var opts = '<option value="live">Current save folder</option>' + l.map(function (m) { return '<option value="' + m.id + '"' + (RS.src === m.id ? ' selected' : '') + '>' + esc((m.tag || 'Snapshot') + ' - ' + new Date(m.created).toLocaleString()) + '</option>'; }).join('');
    var rows = mods.map(function (m) {
      return '<label class="snap"><div><h4><input type="checkbox" data-mod="' + esc(m.name) + '"' + (m.found ? '' : ' checked') + '> ' + esc(m.name) + '<span class="tag ' + (m.found ? '' : 'man') + '">' + (m.found ? 'Installed' : 'Not found') + '</span></h4>' +
        '<div class="meta">' + m.items + ' item' + (m.items === 1 ? '' : 's') + (m.stored ? ' (+' + m.stored + ' stored inside)' : '') + ' in ' + Object.keys(m.files).join(', ') + (m.other ? ' &middot; ' + m.other + ' mod data reference' + (m.other === 1 ? '' : 's') + ' (the mod&rsquo;s own data, not items)' : '') + '</div></div></label>';
    }).join('');
    v.innerHTML = head + '<div class="bar"><select id="rsrc">' + opts + '</select><span class="sp"></span><button data-act="clean" class="pri"' + (mods.length ? '' : ' disabled') + '>Create cleaned copy</button></div>' +
      (rows || '<div class="empty">No items from mods were found in this save.</div>');
    $('#rsrc').value = RS.src;
  }


  /* ---------- inventory (read-only) ---------- */
  var IS = { src: 'live' };
  var ids = function (s, fn) { var re = new RegExp(fn + '\\("([^"]+)"\\)', 'g'), o = [], x; while ((x = re.exec(s || ''))) o.push(x[1]); return o; };
  var inner = function (s) { var x = /\(\[(.*)\]\)\s*$/.exec(s || ''); return x ? x[1] : ''; };
  var extMap = function (t) { var o = {}; t.ext().forEach(function (b) { o[b.attrs.id] = b.attrs.path || ''; }); return o; };
  function catOf(p) { var m = /^res:\/\/Items\/([^\/]+)\//.exec(p); return m ? m[1] : (Tres.modOf(p) || 'Other'); }
  function slotInfo(t, ext, sid) {
    var b = t.subById(sid); if (!b) return null;
    var im = /ExtResource\("([^"]+)"\)/.exec(t.get(b, 'itemData') || ''), p = im ? (ext[im[1]] || '') : '';
    var n = function (k) { var x = parseFloat(t.get(b, k)); return isNaN(x) ? 0 : x; };
    return { name: p ? Tres.itemName(p) : 'Unknown item', cat: catOf(p), cond: Math.round(n('condition')), qty: n('amount'), slot: String(t.get(b, 'slot') || '').replace(/"/g, ''),
      att: ids(inner(t.get(b, 'nested')), 'ExtResource').map(function (i) { return Tres.itemName(ext[i] || ''); }), stored: ids(inner(t.get(b, 'storage')), 'SubResource').length };
  }
  function rowsHtml(list, sort) {
    var g = {}, order = [];
    list.forEach(function (s) { if (!s) return; var k = [s.name, s.cond, s.qty, s.att.join('+'), s.slot, s.stored].join('|'); if (!g[k]) { g[k] = { s: s, n: 0 }; order.push(k); } g[k].n++; });
    if (sort) order.sort(function (a, b) { var x = g[a].s, y = g[b].s; return x.cat.localeCompare(y.cat) || x.name.localeCompare(y.name); });
    return order.map(function (k) {
      var s = g[k].s, n = g[k].n;
      return '<tr data-q="' + esc((s.name + ' ' + s.cat + ' ' + s.att.join(' ') + ' ' + s.slot).toLowerCase()) + '"><td>' + (s.slot ? '<span class="meta">' + esc(s.slot) + '</span> ' : '') + esc(s.name) + (n > 1 ? ' &times;' + n : '') +
        (s.att.length || s.stored ? '<div class="meta">' + esc(s.att.join(', ')) + (s.stored ? (s.att.length ? ' &middot; ' : '') + s.stored + ' stored inside' : '') + '</div>' : '') + '</td><td class="meta">' + esc(s.cat) + '</td><td>' + s.cond + '%</td><td>' + (s.qty || '') + '</td></tr>';
    }).join('');
  }
  var itemTable = function (rows) { return rows ? '<table class="itm"><thead><tr><th>Item</th><th>Category</th><th>Cond.</th><th>Qty</th></tr></thead><tbody>' + rows + '</tbody></table>' : '<p class="meta">Nothing here.</p>'; };
  function charHtml(t, m, ext) {
    var map = function (k) { return ids(t.get(m, k), 'SubResource').map(function (i) { return slotInfo(t, ext, i); }); }, eq = map('equipment'), inv = map('inventory');
    return '<h2>Character</h2><h3>Equipped</h3>' + itemTable(rowsHtml(eq, false)) + '<h3>Carried &middot; ' + inv.length + ' items</h3>' + itemTable(rowsHtml(inv, true));
  }
  function shelterHtml(name, t, m, ext) {
    var fur = ids(t.get(m, 'furnitures'), 'SubResource').map(function (id) {
      var b = t.subById(id); return { name: String(t.get(b, 'name') || '').replace(/"/g, ''), items: ids(t.get(b, 'storage'), 'SubResource').map(function (i) { return slotInfo(t, ext, i); }) };
    });
    var cont = fur.filter(function (f) { return f.items.length; }), stored = cont.reduce(function (n, f) { return n + f.items.length; }, 0);
    var loose = ids(t.get(m, 'items'), 'SubResource').map(function (id) { var b = t.subById(id); return b ? slotInfo(t, ext, ids(t.get(b, 'slotData'), 'SubResource')[0]) : null; }).filter(Boolean);
    var det = function (title, items) { return '<details><summary>' + esc(title) + ' <span class="meta">&middot; ' + items.length + ' item' + (items.length === 1 ? '' : 's') + '</span></summary>' + itemTable(rowsHtml(items, true)) + '</details>'; };
    return '<h2>' + esc(name) + '</h2><p class="meta">' + fur.length + ' furniture pieces &middot; ' + stored + ' items in containers &middot; ' + loose.length + ' loose items</p>' +
      cont.map(function (f) { return det(f.name, f.items); }).join('') + (loose.length ? det('Loose items', loose) : '');
  }
  async function renderInventory() {
    var v = $('#view'), l = await list();
    if (IS.src !== 'live' && !l.some(function (m) { return m.id === IS.src; })) IS.src = 'live';
    var dir = IS.src === 'live' ? saveDir : j(j(bakDir, IS.src), 'data');
    var opts = '<option value="live">Current save folder</option>' + l.map(function (m) { return '<option value="' + m.id + '">' + esc((m.tag || 'Snapshot') + ' - ' + new Date(m.created).toLocaleString()) + '</option>'; }).join('');
    var head = '<h1>Inventory</h1><p class="sub">What is equipped, carried and stored. Read-only: nothing here changes your save.</p><div class="bar"><select id="isrc">' + opts + '</select><span class="sp"></span><input id="invq" type="search" placeholder="Search items"></div>';
    var chars = '', shelters = [];
    try {
      for (var e of await fs.readDir(dir)) {
        if (!isTres(e)) continue;
        var t = Tres.parse(await fs.readTextFile(j(dir, e.name))), m = t.main(); if (!m) continue;
        if (t.get(m, 'equipment') !== undefined) chars += charHtml(t, m, extMap(t));
        else if (t.get(m, 'furnitures') !== undefined) shelters.push({ n: e.name.replace(/\.tres$/i, ''), h: shelterHtml(e.name.replace(/\.tres$/i, ''), t, m, extMap(t)) });
      }
    } catch (err) { v.innerHTML = head + '<div class="empty bad">Could not read the save: ' + esc(err) + '</div>'; $('#isrc').value = IS.src; return; }
    shelters.sort(function (a, b) { return a.n.localeCompare(b.n); });
    v.innerHTML = head + (chars || '<div class="empty">No character file found in this save.</div>') + shelters.map(function (s) { return s.h; }).join('');
    $('#isrc').value = IS.src;
  }

  /* ---------- views ---------- */
  async function renderSnapshots() {
    var ok = await fs.exists(saveDir), v = $('#view'), lw = ok ? await worldInfo(saveDir) : null;
    var head = '<h1>Snapshots</h1><p class="sub">' + esc(saveDir) + ' &middot; ' + (ok ? '<span class="good">found</span>' : '<span class="bad">not found</span>') + (lw ? ' &middot; ' + fmtWorld(lw) + (lw.difficulty === '3' ? ' <span class="tag iron">Ironman</span>' : '') : '') + '</p>';
    if (!ok) { v.innerHTML = head + '<div class="empty">Save folder not found.<br><br><button data-act="pick" class="pri">Choose folder</button></div>'; return; }
    var l = await list();
    await Promise.all(l.map(async function (m) { m.world = await worldInfo(j(j(bakDir, m.id), 'data')); }));
    var rows = l.map(function (m) {
      return '<div class="snap"><div><h4>' + esc(m.tag || 'Snapshot') + '<span class="tag ' + (m.auto ? '' : 'man') + '">' + (m.auto ? 'Auto' : 'Manual') + '</span>' + (m.world && m.world.difficulty === '3' ? '<span class="tag iron">Ironman</span>' : '') + '</h4>' +
        (m.world ? '<div class="meta wi">' + fmtWorld(m.world) + '</div>' : '') + '<div class="meta">' + new Date(m.created).toLocaleString() + ' &middot; ' + m.files + ' items &middot; ' + fmtSize(m.size) + '</div></div>' +
        '<div class="acts" data-id="' + m.id + '"><button data-act="restore" class="pri">Restore</button><button data-act="rename">Rename</button><button data-act="del" class="dng">Delete</button></div></div>';
    }).join('');
    var autoN = l.filter(function (m) { return m.auto && m.tag !== 'Before restore'; }).length;
    v.innerHTML = head + '<div class="bar"><button data-act="backup" class="pri">Back up now</button>' + (autoN ? '<button data-act="delauto" class="dng">Delete ' + autoN + ' automatic</button>' : '') + '<span class="sp"></span><span class="meta">' + l.length + ' snapshot' + (l.length === 1 ? '' : 's') + '</span></div>' +
      (rows || '<div class="empty">No snapshots yet. Back up now, or play and let auto backup do it.</div>');
  }
  async function renderSettings() {
    var auto = localStorage.getItem('auto') === '1';
    $('#view').innerHTML = '<h1>Settings</h1><p class="sub">Vostok Quartermaster</p>' +
      '<div class="set"><h4>Save folder</h4><p>' + esc(saveDir) + '</p><button data-act="pick">Change&hellip;</button> <button data-act="open-save">Show in Explorer</button></div>' +
      '<div class="set"><h4>Game mods folder</h4><p>' + esc(modsDir || 'Not set') + '</p><button data-act="pickmods">Choose&hellip;</button></div>' +
      '<div class="set"><h4>Backups folder</h4><p>' + esc(bakDir) + '</p><button data-act="open-bak">Show in Explorer</button></div>' +
      '<div class="set"><h4>Skip when backing up</h4><p>Top-level folders left out of snapshots, separated by commas. Restoring never touches them.</p><input id="skip" type="text" value="' + esc(skipList().join(', ')) + '"></div>' +
      '<div class="set"><h4>Auto backup (off by default)</h4><p>Creates a snapshot a few seconds after the game saves. The newest ' + KEEP_AUTO + ' automatic snapshots are kept; manual ones are never removed.</p>' +
      '<label><input type="checkbox" id="auto" ' + (auto ? 'checked' : '') + '> Enable auto backup</label></div>';
  }
  function render() { return (page === 'settings' ? renderSettings() : page === 'repair' ? renderRepair() : page === 'inventory' ? renderInventory() : renderSnapshots()).catch(function (e) { $('#view').innerHTML = '<div class="empty bad">' + esc(e) + '</div>'; }); }

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
      else if (act === 'del') { if (!(await ask('Delete snapshot?', 'This cannot be undone.', { ok: 'Delete' }))) return; await fs.remove(j(bakDir, id), { recursive: true }); if (RS.src === id) RS.src = 'live'; }
      else if (act === 'srclive') { RS.src = 'live'; }
      else if (act === 'pick') { var p = await T.dialog.open({ directory: true, defaultPath: saveDir, title: 'Choose the Road to Vostok save folder' }); if (!p) return; saveDir = p; localStorage.setItem('saveDir', p); await startWatch(); }
      else if (act === 'delauto') {
        var del = (await list()).filter(function (m) { return m.auto && m.tag !== 'Before restore'; }); if (!del.length) return;
        if (!(await ask('Delete automatic snapshots?', del.length + ' automatic snapshot' + (del.length === 1 ? '' : 's') + ' will be deleted. Manual snapshots and "Before restore" safety copies are kept. This cannot be undone.', { ok: 'Delete' }))) return;
        for (var d of del) await fs.remove(j(bakDir, d.id), { recursive: true });
        toast(del.length + ' deleted');
      }
      else if (act === 'pickmods') { var q = await T.dialog.open({ directory: true, defaultPath: modsDir || undefined, title: 'Choose the Road to Vostok mods folder' }); if (!q) return; modsDir = q; localStorage.setItem('modsDir', q); }
      else if (act === 'clean') {
        var chosen = Array.prototype.filter.call(document.querySelectorAll('input[data-mod]'), function (c) { return c.checked; }).map(function (c) { return c.dataset.mod; });
        if (!chosen.length) { toast('Tick at least one mod to remove'); return; }
        var src = RS.src === 'live' ? saveDir : j(j(bakDir, RS.src), 'data'), r = await cleanTo(src, 'Cleaned: ' + chosen.join(', '), chosen);
        await ask('Cleaned copy created', (r.done.length ? 'Removed items in: ' + r.done.join(', ') + '. ' : 'No item slots needed removing. ') + (r.left ? r.left + ' reference(s) to these mods remain (not item slots). ' : '') + 'Find it under Snapshots and restore it when the game is closed.', { ok: 'OK' });
      }
      else if (act === 'open-save') return T.opener.revealItemInDir(saveDir);
      else if (act === 'open-bak') { await fs.mkdir(bakDir, { recursive: true }); return T.opener.revealItemInDir(bakDir); }
    } catch (e) { toast('Error: ' + e); }
    render();
  });
  document.addEventListener('change', function (ev) { if (ev.target.id === 'isrc') { IS.src = ev.target.value; render(); } if (ev.target.id === 'rsrc') { RS.src = ev.target.value; render(); } if (ev.target.id === 'skip') { localStorage.setItem('skip', ev.target.value); toast('Saved'); } if (ev.target.id === 'auto') { localStorage.setItem('auto', ev.target.checked ? '1' : '0'); startWatch(); } });

  document.addEventListener('input', function (ev) {
    if (ev.target.id !== 'invq') return;
    var q = ev.target.value.trim().toLowerCase();
    document.querySelectorAll('#view tr[data-q]').forEach(function (r) { r.hidden = !!q && r.dataset.q.indexOf(q) === -1; });
    document.querySelectorAll('#view details').forEach(function (d) { var any = !q || d.querySelector('tr[data-q]:not([hidden])'); d.hidden = !any; if (q && any) d.open = true; });
  });

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
