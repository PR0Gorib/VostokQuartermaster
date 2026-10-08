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
  var modsDir = '', RS = { src: 'live' };
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
    if (!modsDir) { v.innerHTML = head + '<div class="empty">Choose the <b>game folder</b> first (it contains the <b>mods</b> folder).<br><br><button data-act="pickgame" class="pri">Choose game folder</button></div>'; return; }
    var l = await list(), mods;
    if (RS.src !== 'live' && !l.some(function (m) { return m.id === RS.src; })) RS.src = 'live';
    var srcDir = RS.src === 'live' ? saveDir : j(j(bakDir, RS.src), 'data');
    if (!(await fs.exists(srcDir))) { v.innerHTML = head + '<div class="empty">No save found yet. Start a new game once, then come back.</div>'; return; }
    try { mods = await scanDir(srcDir); } catch (e) { v.innerHTML = head + '<div class="empty bad">Could not read the folders: ' + esc(niceErr(e)) + '<br><br><button data-act="pickgame" class="pri">Choose game folder again</button>' + (RS.src !== 'live' ? ' <button data-act="srclive">Use current save folder</button>' : '') + '</div>'; return; }
    var opts = '<option value="live">Current save folder</option>' + l.map(function (m) { return '<option value="' + m.id + '"' + (RS.src === m.id ? ' selected' : '') + '>' + esc((m.tag || 'Snapshot') + ' - ' + new Date(m.created).toLocaleString()) + '</option>'; }).join('');
    var rows = mods.map(function (m) {
      return '<label class="snap"><div><h4><input type="checkbox" data-mod="' + esc(m.name) + '"' + (m.found ? '' : ' checked') + '> ' + esc(m.name) + '<span class="tag ' + (m.found ? '' : 'man') + '">' + (m.found ? 'Installed' : 'Not found') + '</span></h4>' +
        '<div class="meta">' + m.items + ' item' + (m.items === 1 ? '' : 's') + (m.stored ? ' (+' + m.stored + ' stored inside)' : '') + ' in ' + Object.keys(m.files).join(', ') + (m.other ? ' &middot; ' + m.other + ' mod data reference' + (m.other === 1 ? '' : 's') + ' (the mod&rsquo;s own data, not items)' : '') + '</div></div></label>';
    }).join('');
    v.innerHTML = head + '<div class="bar"><select id="rsrc">' + opts + '</select><span class="sp"></span><button data-act="clean" class="pri"' + (mods.length ? '' : ' disabled') + '>Create cleaned copy</button></div>' +
      (rows || '<div class="empty">No items from mods were found in this save.</div>');
    $('#rsrc').value = RS.src;
  }


  /* ---------- item icons (read from the installed game on demand; nothing is copied or stored) ---------- */
  var STEAM_DEFAULT = 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Road to Vostok', GD_AUTO = false, gameDir = '', IC = { pack: null, idx: null, url: {}, busy: null, fail: '', close: null };
  // one folder for everything: the mods folder is the "mods" folder inside the game folder
  var APP_VER = '1.0.0';
  function setGame(dir) { gameDir = dir || ''; modsDir = gameDir ? j(gameDir, 'mods') : ''; }
  function pckReader(file, size) {
    var fh = null, q = Promise.resolve();
    var rd = async function (pos, len) {
      if (!fh) fh = await fs.open(file, { read: true });
      await fh.seek(pos, T.fs.SeekMode.Start);
      var buf = new Uint8Array(len), got = 0;
      while (got < len) { var n = await fh.read(buf.subarray(got)); if (!n) break; got += n; }
      return buf.subarray(0, got);
    };
    return { size: size, read: function (pos, len) { var r = q.then(function () { return rd(pos, len); }); q = r.catch(function () {}); return r; }, close: function () { return fh ? fh.close() : null; } };
  }
  async function iconPack() {
    if (IC.pack) return IC.pack;
    if (IC.busy) return IC.busy;
    IC.busy = (async function () {
      try {
        var f = (await fs.readDir(gameDir)).filter(function (e) { return !e.isDirectory && /\.pck$/i.test(e.name); })[0];
        if (!f) throw new Error('No .pck file found in the game folder');
        var p = j(gameDir, f.name), rdr = pckReader(p, (await fs.stat(p)).size);
        IC.pack = await Pck.open(rdr); IC.idx = Pck.iconIndex(IC.pack); IC.close = rdr.close;
        return IC.pack;
      } finally { IC.busy = null; }
    })();
    return IC.busy;
  }
  function niceErr(e) { var m = String(e && e.message || e); if (/cannot find the path|os error 3|No such file/i.test(m)) return 'the game folder was not found at this location, so choose it again'; return /forbidden path|not allowed on the scope/i.test(m) ? 'the app no longer has permission to read the game folder (it is not remembered between launches), so choose the folder again' : m; }
  function iconReset() { try { if (IC.close) IC.close(); } catch (e) {} IC = { pack: null, idx: null, url: {}, busy: null, fail: '', close: null }; }
  function toUrl(tex) { var c = document.createElement('canvas'); c.width = tex.width; c.height = tex.height; c.getContext('2d').putImageData(new ImageData(tex.rgba, tex.width, tex.height), 0, 0); return c.toDataURL('image/png'); }
  async function fillIcons() {
    var imgs = Array.prototype.slice.call(document.querySelectorAll('#view img[data-ic]'));
    if (!imgs.length || !gameDir || IC.fail) return;
    try { await iconPack(); } catch (e) { IC.fail = niceErr(e); return; }
    for (var im of imgs) {
      var n = im.dataset.ic;
      if (!(n in IC.url)) {
        try { var p = await Pck.itemIcon(IC.pack, n); IC.url[n] = p ? toUrl(Pck.decodeCtex(await IC.pack.read(p))) : ''; } catch (e) { IC.url[n] = ''; }
      }
      if (IC.url[n]) { im.src = IC.url[n]; im.hidden = false; var g = im.parentNode.querySelector('.gl'); if (g) g.hidden = true; }
    }
  }
  var GLYPH = {
    weapons: '<path d="M2 10.5h12.5l1-1.5h4l1 1.5H22v2.5h-5l-1.2 1.2h-3L11.5 19H8.5l1.2-4.8H6.6L4.8 17H2.6l1.3-3.6L2 13z"/>',
    ammo: '<path d="M12 2.5c2 1.8 3 3.8 3 6.2V19H9V8.7c0-2.4 1-4.4 3-6.2z"/><path d="M9 15.5h6M9 21.5h6"/>',
    attachments: '<circle cx="12" cy="12" r="5.5"/><path d="M12 3v4M12 17v4M3 12h4M17 12h4"/>',
    knives: '<path d="M20.5 3.5c-6.5.8-10.5 4.7-12 11.2l2.8 2.8c6.5-1.5 10.4-5.5 9.2-14z"/><path d="M8.5 15.5L4 20"/>',
    grenades: '<circle cx="12" cy="14.5" r="6"/><path d="M10 8.5V5.5h4v3M14 5.5l3.5-2"/>',
    armor: '<path d="M12 3l7.5 3v6c0 4.5-3.2 7.5-7.5 9-4.3-1.5-7.5-4.5-7.5-9V6z"/>',
    helmets: '<path d="M4.5 15a7.5 7.5 0 0115 0z"/><path d="M3 15h18v2.5H3z"/>',
    clothing: '<path d="M8.5 4L3 7l2 4 2.5-1V20h9V10l2.5 1 2-4-5.5-3c-.6 1.6-2 2.5-3.5 2.5S9.1 5.6 8.5 4z"/>',
    backpacks: '<path d="M9 7V5.5a3 3 0 016 0V7"/><rect x="5" y="7" width="14" height="14" rx="3"/><path d="M9 14h6v4H9z"/>',
    rigs: '<path d="M8.5 3.5L5 6v14.5h5.2V15h3.6v5.5H19V6l-3.5-2.5c-.6 1.8-2 2.7-3.5 2.7s-2.9-.9-3.5-2.7z"/>',
    belts: '<rect x="2.5" y="9" width="19" height="6" rx="1.5"/><rect x="9.5" y="7.5" width="5" height="9" rx="1"/>',
    medical: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M12 8v8M8 12h8"/>',
    consumables: '<path d="M7 5h10v14.5a1.5 1.5 0 01-1.5 1.5h-7A1.5 1.5 0 017 19.5z"/><path d="M7 9h10M7 16h10"/>',
    electronics: '<rect x="7" y="7" width="10" height="10" rx="1"/><path d="M10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4"/>',
    keys: '<circle cx="7.5" cy="12" r="4"/><path d="M11.5 12H21M18 12v4M21 12v3"/>',
    books: '<path d="M5 4.5h11.5A2.5 2.5 0 0119 7v13H7.5A2.5 2.5 0 015 17.5z"/><path d="M5 17.5A2.5 2.5 0 017.5 15H19"/>',
    fishing: '<path d="M14 3v11a4.5 4.5 0 01-9 0"/><path d="M5 14l-2.5-2.5M5 14l2.5-2.5"/>',
    instruments: '<path d="M9 18V5.5l11-2V16"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/>',
    lore: '<path d="M6 3h9l4 4v14H6z"/><path d="M15 3v4h4M9 12h7M9 16h7"/>',
    misc: '<path d="M3 8l9-5 9 5v8l-9 5-9-5z"/><path d="M3 8l9 5 9-5M12 13v8"/>',
    trader: '<circle cx="12" cy="8" r="4"/><path d="M4.5 21c.6-4.5 3.7-7 7.5-7s6.9 2.5 7.5 7"/>',
    mod: '<g stroke-dasharray="2.2 2"><path d="M3 8l9-5 9 5v8l-9 5-9-5z"/><path d="M3 8l9 5 9-5M12 13v8"/></g>'
  };
  function glyph(cat) { return '<span class="gl" title="' + esc(cat) + '"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' + (GLYPH[String(cat).toLowerCase()] || GLYPH.mod) + '</svg></span>'; }
  function iconHint() { return gameDir ? '' : '<p class="meta">Tip: choose the game folder in Settings to show item icons.</p>'; }

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
    return { name: p ? Tres.itemName(p) : 'Unknown item', path: p || '', cat: catOf(p), cond: Math.round(n('condition')), qty: n('amount'), slot: String(t.get(b, 'slot') || '').replace(/"/g, ''),
      att: ids(inner(t.get(b, 'nested')), 'ExtResource').map(function (i) { return Tres.itemName(ext[i] || ''); }), stored: ids(inner(t.get(b, 'storage')), 'SubResource').length };
  }
  function rowsHtml(list, sort) {
    var g = {}, order = [];
    list.forEach(function (s) { if (!s) return; var k = [s.name, s.cond, s.qty, s.att.join('+'), s.slot, s.stored].join('|'); if (!g[k]) { g[k] = { s: s, n: 0 }; order.push(k); } g[k].n++; });
    if (sort) order.sort(function (a, b) { var x = g[a].s, y = g[b].s; return x.cat.localeCompare(y.cat) || x.name.localeCompare(y.name); });
    return order.map(function (k) {
      var s = g[k].s, n = g[k].n;
      return '<tr data-q="' + esc((s.name + ' ' + s.cat + ' ' + s.att.join(' ') + ' ' + s.slot).toLowerCase()) + '"><td>' + '<span class="ib">' + (/^res:\/\/Items\//i.test(s.path || '') ? '<img class="ico" data-ic="' + esc(s.path) + '" alt="" hidden>' : '') + glyph(s.cat) + '</span>' + (s.slot ? '<span class="meta">' + esc(s.slot) + '</span> ' : '') + esc(s.name) + (n > 1 ? ' &times;' + n : '') +
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
    if (!(await fs.exists(dir))) { v.innerHTML = head + '<div class="empty">No save found yet. Start a new game once, then come back.</div>'; $('#isrc').value = IS.src; return; }
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
    v.innerHTML = head + iconHint() + (chars || '<div class="empty">No character file found in this save.</div>') + shelters.map(function (s) { return s.h; }).join('');
    $('#isrc').value = IS.src;
    fillIcons();
  }


  /* ---------- traders (read-only) ---------- */
  var TS = { src: 'live' };
  // task totals from the wiki (roadtovostok.wiki/traders); unknown traders just show the completed count
  var TRADERS = { generalist: ['Generalist', 10, 100], doctor: ['Doctor', 10, 200], gunsmith: ['Gunsmith', 10, 300], driver: ['Driver', 1], hunter: ['Hunter', 0] };
  function tradersHtml(t) {
    var m = t.main(), ext = extMap(t), notes = {};
    ids(inner(t.get(m, 'taskNotes')), 'ExtResource').forEach(function (i) {
      var p = ext[i] || '', mm = /Traders\/([^\/]+)\//.exec(p), k = mm ? mm[1].toLowerCase() : 'other';
      (notes[k] = notes[k] || []).push(p.split('/').pop().replace(/\.tres$/i, '').replace(/^\d+_/, '').replace(/_/g, ' '));
    });
    return t.keys(m).filter(function (k) { return k !== 'script' && k !== 'taskNotes' && k !== 'grandma'; }).map(function (k) {
      var done = (inner(t.get(m, k)).match(/"(?:[^"\\]|\\.)*"/g) || []).map(function (s) { return s.slice(1, -1); });
      var meta = TRADERS[k] || [k.charAt(0).toUpperCase() + k.slice(1), null], act = notes[k] || [];
      var pic = '<span class="tb"><img class="tpic" data-ic="res://Traders/' + esc(meta[0]) + '/' + esc(meta[0]) + '.tres" alt="" hidden>' + glyph('trader') + '</span>';
      return '<div class="snap"><div class="tw">' + pic + '<div><h4>' + esc(meta[0]) + '<span class="tag ' + (done.length ? 'man' : '') + '">' + done.length + (meta[1] ? ' / ' + meta[1] : '') + ' tasks done</span>' + (meta[2] ? '<span class="tag" title="Estimated: base tax x (1 - done / 10). Matches in-game values seen so far.">Tax ~' + Math.round(meta[2] * Math.max(0, 1 - done.length / meta[1])) + '% (est.)</span>' : '') + '</h4>' +
        (done.length ? '<div class="meta wi">' + done.map(esc).join(' &middot; ') + '</div>' : '<div class="meta">No tasks completed yet.</div>') +
        (act.length ? '<div class="meta">In progress: ' + act.map(esc).join(', ') + '</div>' : '') + '</div></div></div>';
    }).join('');
  }
  async function renderTraders() {
    var v = $('#view'), l = await list();
    if (TS.src !== 'live' && !l.some(function (m) { return m.id === TS.src; })) TS.src = 'live';
    var dir = TS.src === 'live' ? saveDir : j(j(bakDir, TS.src), 'data'), f = j(dir, 'Traders.tres');
    var opts = '<option value="live">Current save folder</option>' + l.map(function (m) { return '<option value="' + m.id + '">' + esc((m.tag || 'Snapshot') + ' - ' + new Date(m.created).toLocaleString()) + '</option>'; }).join('');
    var head = '<h1>Traders</h1><p class="sub">Completed and in-progress tasks. Read-only: nothing here changes your save.</p><div class="bar"><select id="tsrc">' + opts + '</select></div>';
    try { v.innerHTML = head + ((await fs.exists(f)) ? tradersHtml(Tres.parse(await fs.readTextFile(f))) : '<div class="empty">No Traders.tres in this save.</div>'); }
    catch (err) { v.innerHTML = head + '<div class="empty bad">Could not read the save: ' + esc(err) + '</div>'; }
    $('#tsrc').value = TS.src;
    fillIcons();
  }


  /* ---------- edit (character + world, written to a new snapshot) ---------- */
  var ES = { src: 'live' };
  var METERS = [['health', 'Health'], ['energy', 'Energy'], ['hydration', 'Hydration'], ['temperature', 'Temperature'], ['mental', 'Mental'], ['reputation', 'Reputation'], ['cat', 'Cat health'], ['bodyStamina', 'Body stamina'], ['armStamina', 'Arm stamina']];
  var CONDS = [['overweight', 'Overweight'], ['starvation', 'Starvation'], ['dehydration', 'Dehydration'], ['bleeding', 'Bleeding'], ['fracture', 'Fracture'], ['burn', 'Burn'], ['poisoning', 'Poisoning'], ['frostbite', 'Frostbite'], ['insanity', 'Insanity'], ['rupture', 'Rupture'], ['headshot', 'Headshot'], ['catFound', 'Cat found'], ['catDead', 'Cat dead']];
  var HEAL_M = ['health', 'energy', 'hydration', 'temperature', 'mental', 'bodyStamina', 'armStamina'];
  var HEAL_C = ['overweight', 'starvation', 'dehydration', 'bleeding', 'fracture', 'burn', 'poisoning', 'frostbite', 'insanity', 'rupture', 'headshot'];
  var WEATHER = ['Neutral', 'Rain', 'Storm', 'Overcast', 'Wind', 'Fog', 'Aurora'];
  function rawOf(e) {
    if (e.t === 'bool') return e.v;
    if (e.t === 'str') return '"' + e.v.replace(/["\\]/g, '') + '"';
    var f = function (n) { return Number.isInteger(n) ? n.toFixed(1) : String(+n.toFixed(4)); };
    if (e.t === 'num') { var n = parseFloat(e.v); if (isNaN(n)) throw new Error(e.label + ' is not a number'); return f(Math.min(100, Math.max(0, n))); }
    if (e.t === 'int') { var i = parseInt(e.v, 10); if (isNaN(i) || i < 1) throw new Error(e.label + ' must be 1 or more'); return String(i); }
    if (e.t === 'time') { var p = String(e.v).split(':'), h = parseInt(p[0], 10), mi = parseInt(p[1], 10); if (isNaN(h) || isNaN(mi)) throw new Error('Time is not valid'); return f(h * 100 + mi * 100 / 60); }
    throw new Error('Unknown field type');
  }
  function collectEdits() {
    var out = [];
    document.querySelectorAll('#view [data-k]').forEach(function (el) {
      var chk = el.type === 'checkbox', v = chk ? String(el.checked) : el.value;
      if (v === el.dataset.init) return;
      var to = chk ? (el.checked ? 'on' : 'off') : el.tagName === 'SELECT' ? el.options[el.selectedIndex].text : v;
      var from = chk ? (el.dataset.init === 'true' ? 'on' : 'off') : (el.dataset.initText || el.dataset.init);
      out.push({ f: el.dataset.f, k: el.dataset.k, t: el.dataset.t, v: v, label: el.dataset.label, from: from, to: to });
    });
    return out;
  }
  async function makeEdited(src, edits) {
    var meta = await snapFrom(src, 'Edited: ' + edits.length + ' change' + (edits.length === 1 ? '' : 's')), data = j(j(bakDir, meta.id), 'data');
    for (var f of ['Character', 'World']) {
      var es = edits.filter(function (e) { return e.f === f; }); if (!es.length) continue;
      var p = j(data, f + '.tres'), t = Tres.parse(await fs.readTextFile(p)), m = t.main();
      es.forEach(function (e) { t.set(m, e.k, e.raw); });
      await fs.writeTextFile(p, t.serialize());
    }
    return meta;
  }
  async function renderEdit() {
    var v = $('#view'), l = await list();
    if (ES.src !== 'live' && !l.some(function (m) { return m.id === ES.src; })) ES.src = 'live';
    var dir = ES.src === 'live' ? saveDir : j(j(bakDir, ES.src), 'data');
    var opts = '<option value="live">Current save folder</option>' + l.map(function (m) { return '<option value="' + m.id + '">' + esc((m.tag || 'Snapshot') + ' - ' + new Date(m.created).toLocaleString()) + '</option>'; }).join('');
    var head = '<h1>Edit</h1><p class="sub">Change values, then create an edited copy. Your live save is never touched: the copy appears under Snapshots, and you restore it when the game is closed.</p>' +
      '<div class="bar"><select id="esrc">' + opts + '</select><span class="sp"></span><button data-act="heal">Heal all</button><button data-act="mkedit" class="pri">Create edited copy</button></div>';
    var read = async function (n) { var p = j(dir, n + '.tres'); return (await fs.exists(p)) ? Tres.parse(await fs.readTextFile(p)) : null; };
    var ch, wo;
    try { ch = await read('Character'); wo = await read('World'); } catch (err) { v.innerHTML = head + '<div class="empty bad">Could not read the save: ' + esc(err) + '</div>'; $('#esrc').value = ES.src; return; }
    var gv = function (t, k) { var x = t.get(t.main(), k); return x === undefined ? null : String(x).replace(/^"|"$/g, ''); };
    var attrs = function (f, k, ty, label, init, extra) { return ' data-f="' + f + '" data-k="' + k + '" data-t="' + ty + '" data-label="' + esc(label) + '" data-init="' + esc(init) + '"' + (extra || ''); };
    var html = head;
    if (ch) {
      html += '<h2>Character</h2><div class="fgrid">' + METERS.filter(function (x) { return gv(ch, x[0]) !== null; }).map(function (x) {
        var init = String(+parseFloat(gv(ch, x[0])).toFixed(2));
        return '<label class="fld">' + esc(x[1]) + '<input type="number" min="0" max="100" step="1" value="' + init + '"' + attrs('Character', x[0], 'num', x[1], init) + '></label>';
      }).join('') + '</div><h3>Conditions</h3><div class="fgrid">' + CONDS.filter(function (x) { return gv(ch, x[0]) !== null; }).map(function (x) {
        var on = gv(ch, x[0]) === 'true';
        return '<label class="fld chk"><input type="checkbox"' + (on ? ' checked' : '') + attrs('Character', x[0], 'bool', x[1], String(on)) + '> ' + esc(x[1]) + '</label>';
      }).join('') + '</div>';
    } else html += '<div class="empty">No Character.tres in this save.</div>';
    if (wo) {
      var sel = function (k, label, pairs, cur) {
        if (!pairs.some(function (p) { return p[0] === cur; })) pairs = pairs.concat([[cur, cur]]);
        var txt = (pairs.filter(function (p) { return p[0] === cur; })[0] || [0, cur])[1];
        return '<label class="fld">' + esc(label) + '<select' + attrs('World', k, k === 'weather' ? 'str' : 'int', label, cur, ' data-init-text="' + esc(txt) + '"') + '>' + pairs.map(function (p) { return '<option value="' + esc(p[0]) + '"' + (p[0] === cur ? ' selected' : '') + '>' + esc(p[1]) + '</option>'; }).join('') + '</select></label>';
      };
      var day = gv(wo, 'day'), tm = gv(wo, 'time'), tinit = tm !== null && !isNaN(parseFloat(tm)) ? fmtTime(parseFloat(tm)) : null;
      html += '<h2>World</h2><div class="fgrid">' +
        (day !== null ? '<label class="fld">Day<input type="number" min="1" step="1" value="' + esc(day) + '"' + attrs('World', 'day', 'int', 'Day', day) + '></label>' : '') +
        (tinit ? '<label class="fld">Time of day<input type="time" value="' + tinit + '"' + attrs('World', 'time', 'time', 'Time', tinit) + '></label>' : '') +
        (gv(wo, 'season') !== null ? sel('season', 'Season', [['1', 'Summer'], ['2', 'Winter']], gv(wo, 'season')) : '') +
        (gv(wo, 'difficulty') !== null ? sel('difficulty', 'Difficulty', [['1', 'Standard'], ['2', 'Darkness'], ['3', 'Ironman']], gv(wo, 'difficulty')) : '') +
        (gv(wo, 'weather') !== null ? sel('weather', 'Weather', WEATHER.map(function (w) { return [w, w]; }), gv(wo, 'weather')) : '') + '</div>';
    } else html += '<div class="empty">No World.tres in this save.</div>';
    v.innerHTML = html; $('#esrc').value = ES.src;
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
      '<div class="set"><h4>Game folder</h4><p>' + esc(gameDir || 'Not set') + (GD_AUTO ? ' (found automatically)' : '') + '</p><button data-act="pickgame">Choose&hellip;</button><p style="margin:10px 0 0">Used for item icons and to check which mods are installed (the <b>mods</b> folder inside it). Icons are read from your own game files when needed and are never copied into the app or its backups.' + (IC.fail ? ' <span class="bad">Could not read icons: ' + esc(IC.fail) + ' &mdash; choose the folder again.</span>' : '') + '</p></div>' +
      '<div class="set"><h4>Backups folder</h4><p>' + esc(bakDir) + '</p><button data-act="open-bak">Show in Explorer</button></div>' +
      '<div class="set"><h4>Skip when backing up</h4><p>Top-level folders left out of snapshots, separated by commas. Restoring never touches them.</p><input id="skip" type="text" value="' + esc(skipList().join(', ')) + '"></div>' +
      '<div class="set"><h4>Auto backup (off by default)</h4><p>Creates a snapshot a few seconds after the game saves. The newest ' + KEEP_AUTO + ' automatic snapshots are kept; manual ones are never removed.</p>' +
      '<label><input type="checkbox" id="auto" ' + (auto ? 'checked' : '') + '> Enable auto backup</label></div>' +
      '<div class="set"><h4>About</h4><p style="word-break:normal"><b>Vostok Quartermaster</b> v' + esc(APP_VER) + '</p><p style="word-break:normal">Back up, repair, inspect and edit your Road to Vostok saves. Made for Build 2 saves.</p><button data-act="open-url" data-url="https://github.com/PR0Gorib/VostokQuartermaster">GitHub</button> <button data-act="open-url" data-url="https://github.com/PR0Gorib/VostokQuartermaster/issues">Report a problem</button><p style="margin:10px 0 0;word-break:normal">Unofficial tool. Not affiliated with the Road to Vostok Ltd. Item icons and trader portraits are read from your own game files when needed and are never stored.</p></div>';
  }
  function render() { return (page === 'settings' ? renderSettings() : page === 'repair' ? renderRepair() : page === 'inventory' ? renderInventory() : page === 'traders' ? renderTraders() : page === 'edit' ? renderEdit() : renderSnapshots()).catch(function (e) { $('#view').innerHTML = '<div class="empty bad">' + esc(e) + '</div>'; }); }

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
      else if (act === 'heal') {
        HEAL_M.forEach(function (k) { var el = document.querySelector('[data-f="Character"][data-k="' + k + '"]'); if (el) el.value = '100'; });
        HEAL_C.forEach(function (k) { var el = document.querySelector('[data-f="Character"][data-k="' + k + '"]'); if (el) el.checked = false; });
        toast('Meters set to 100 and conditions cleared. Review, then create the copy.'); return;
      }
      else if (act === 'mkedit') {
        var edits = collectEdits(); if (!edits.length) { toast('No changes to apply'); return; }
        edits.forEach(function (e) { e.raw = rawOf(e); });
        if (!(await ask('Create edited copy?', edits.map(function (e) { return e.label + ': ' + e.from + ' \u2192 ' + e.to; }).join('\n'), { ok: 'Create' }))) return;
        await makeEdited(ES.src === 'live' ? saveDir : j(j(bakDir, ES.src), 'data'), edits);
        await ask('Edited copy created', 'Find it under Snapshots (tagged "Edited") and restore it when the game is closed. Your original is unchanged.', { ok: 'OK' });
      }
      else if (act === 'delauto') {
        var del = (await list()).filter(function (m) { return m.auto && m.tag !== 'Before restore'; }); if (!del.length) return;
        if (!(await ask('Delete automatic snapshots?', del.length + ' automatic snapshot' + (del.length === 1 ? '' : 's') + ' will be deleted. Manual snapshots and "Before restore" safety copies are kept. This cannot be undone.', { ok: 'Delete' }))) return;
        for (var d of del) await fs.remove(j(bakDir, d.id), { recursive: true });
        toast(del.length + ' deleted');
      }
      else if (act === 'pickgame') { var g = await T.dialog.open({ directory: true, defaultPath: gameDir || undefined, title: 'Choose the Road to Vostok game folder (the one with RTV.pck)' }); if (!g) return; GD_AUTO = false; setGame(g); localStorage.setItem('gameDir', g); iconReset(); }
      else if (act === 'clean') {
        var chosen = Array.prototype.filter.call(document.querySelectorAll('input[data-mod]'), function (c) { return c.checked; }).map(function (c) { return c.dataset.mod; });
        if (!chosen.length) { toast('Tick at least one mod to remove'); return; }
        var src = RS.src === 'live' ? saveDir : j(j(bakDir, RS.src), 'data'), r = await cleanTo(src, 'Cleaned: ' + chosen.join(', '), chosen);
        await ask('Cleaned copy created', (r.done.length ? 'Removed items in: ' + r.done.join(', ') + '. ' : 'No item slots needed removing. ') + (r.left ? r.left + ' reference(s) to these mods remain (not item slots). ' : '') + 'Find it under Snapshots and restore it when the game is closed.', { ok: 'OK' });
      }
      else if (act === 'open-url') return T.opener.openUrl(b.dataset.url);
      else if (act === 'open-save') return T.opener.revealItemInDir(saveDir);
      else if (act === 'open-bak') { await fs.mkdir(bakDir, { recursive: true }); return T.opener.revealItemInDir(bakDir); }
    } catch (e) { toast('Error: ' + e); if (act === 'mkedit') return; }
    render();
  });
  document.addEventListener('change', function (ev) { if (ev.target.id === 'esrc') { ES.src = ev.target.value; render(); } if (ev.target.id === 'tsrc') { TS.src = ev.target.value; render(); } if (ev.target.id === 'isrc') { IS.src = ev.target.value; render(); } if (ev.target.id === 'rsrc') { RS.src = ev.target.value; render(); } if (ev.target.id === 'skip') { localStorage.setItem('skip', ev.target.value); toast('Saved'); } if (ev.target.id === 'auto') { localStorage.setItem('auto', ev.target.checked ? '1' : '0'); startWatch(); } });

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
      var gd = localStorage.getItem('gameDir') || '';
      if (!gd && localStorage.getItem('modsDir')) { gd = localStorage.getItem('modsDir').replace(/[\\/][^\\/]*$/, ''); localStorage.setItem('gameDir', gd); }
      if (!gd) { try { if (await fs.exists(STEAM_DEFAULT)) { gd = STEAM_DEFAULT; GD_AUTO = true; } } catch (e) {} }
      setGame(gd);
      try { APP_VER = await T.app.getVersion(); } catch (e) {}
      await fs.mkdir(bakDir, { recursive: true });
      await startWatch();
    } catch (e) { toast('Startup error: ' + e); }
    render();
  })();
})();
