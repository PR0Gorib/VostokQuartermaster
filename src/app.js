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
  // Folder names: a snapshot you name gets that name (cleaned for Windows, made unique); automatic and unnamed
  // ones keep a timestamp so they stay distinct. snapshot.json keeps the exact tag.
  var stampOf = function (n) { return n.getFullYear() + pad(n.getMonth() + 1) + pad(n.getDate()) + '-' + pad(n.getHours()) + pad(n.getMinutes()) + pad(n.getSeconds()); };
  function cleanName(s) {
    s = String(s || '').replace(/[\\\/:*?"<>|\u0000-\u001f]+/g, ' - ').replace(/\s+/g, ' ').replace(/^[\s.-]+|[\s.-]+$/g, '').slice(0, 50).replace(/[\s.-]+$/, '');
    return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(s) ? '_' + s : s;
  }
  async function uniqueName(base) {
    var have = {};
    if (await fs.exists(bakDir)) (await fs.readDir(bakDir)).forEach(function (e) { have[e.name.toLowerCase()] = true; });
    var name = base, i = 2;
    while (have[name.toLowerCase()]) name = base + ' (' + (i++) + ')';
    return name;
  }
  function folderFor(tag, auto, n) {
    var c = cleanName(tag);
    return uniqueName(!auto && c ? c : (c || (auto ? 'Auto' : 'Snapshot')) + ' ' + stampOf(n));
  }
  async function list() {
    if (!(await fs.exists(bakDir))) return [];
    var out = [];
    for (var e of await fs.readDir(bakDir)) {
      if (!e.isDirectory) continue;
      try { var m = JSON.parse(await fs.readTextFile(j(j(bakDir, e.name), 'snapshot.json'))); m.id = e.name; out.push(m); } catch (_) { /* not ours */ }
    }
    return out.sort(function (a, b) { return b.created.localeCompare(a.created); });
  }
  async function snap(tag, auto) {
    var n = new Date(), id = await folderFor(tag, auto, n);
    var dir = j(bakDir, id), data = j(dir, 'data');
    busyUntil = Date.now() + 6000;
    var meta;
    try {
      await copyDir(saveDir, data, true);
      meta = { id: id, tag: tag || '', auto: !!auto, created: n.toISOString(), size: await dirSize(data), files: (await fs.readDir(data)).length };
      await fs.writeTextFile(j(dir, 'snapshot.json'), JSON.stringify(meta));
    } catch (e) { try { await fs.remove(dir, { recursive: true }); } catch (_) { /* leave it */ } throw e; }
    if (auto) { var old = (await list()).filter(function (m) { return m.auto && m.tag !== 'Before restore'; }).slice(KEEP_AUTO); for (var m of old) await fs.remove(j(bakDir, m.id), { recursive: true }); }
    return meta;
  }
  var restoreStarted = false;
  // files that Restore would delete or overwrite but that Windows has marked Read-only (both would fail)
  async function roAll(dir, out) { for (var e of await fs.readDir(dir)) { var p = j(dir, e.name); if (e.isDirectory) await roAll(p, out); else if ((await fs.stat(p)).readonly === true) out.push(p); } }
  async function roOver(src, dst, out) { for (var e of await fs.readDir(src)) { var d = j(dst, e.name); if (!(await fs.exists(d))) continue; if (e.isDirectory) await roOver(j(src, e.name), d, out); else if ((await fs.stat(d)).readonly === true) out.push(d); } }
  async function restore(id) {
    restoreStarted = false;
    var dataDir = j(j(bakDir, id), 'data'), ro = [], have = new Set((await fs.readDir(dataDir)).map(function (e) { return e.name; }));
    for (var se of await fs.readDir(saveDir)) {
      if (skipped(se.name)) continue;
      var sp = j(saveDir, se.name);
      if (!have.has(se.name)) { if (se.isDirectory) await roAll(sp, ro); else if ((await fs.stat(sp)).readonly === true) ro.push(sp); }
    }
    await roOver(dataDir, saveDir, ro);
    if (ro.length) { var er = new Error('readonly'); er.ro = ro; throw er; }
    await snap('Before restore', true);
    restoreStarted = true;
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
    var n = new Date(), id = await folderFor(tag, false, n);
    var dir = j(bakDir, id), data = j(dir, 'data');
    var meta;
    try {
      await copyDir(src, data, true);
      meta = { id: id, tag: tag, auto: false, created: n.toISOString(), size: await dirSize(data), files: (await fs.readDir(data)).length };
      await fs.writeTextFile(j(dir, 'snapshot.json'), JSON.stringify(meta));
    } catch (e) { try { await fs.remove(dir, { recursive: true }); } catch (_) { /* leave it */ } throw e; }
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
    var v = pageEl('repair'), head = '<h1>Repair</h1><p class="sub">Finds items from mods that are no longer installed and removes them into a cleaned copy. Your live save is never changed.</p>';
    if (!modsDir) { v.innerHTML = head + '<div class="empty">Choose the <b>game folder</b> first (it contains the <b>mods</b> folder).<br><br><button data-act="pickgame" class="pri">Choose game folder</button></div>'; return; }
    var l = await list(), mods;
    if (RS.src !== 'live' && !l.some(function (m) { return m.id === RS.src; })) RS.src = 'live';
    var srcDir = RS.src === 'live' ? saveDir : j(j(bakDir, RS.src), 'data');
    if (!(await fs.exists(srcDir))) { v.innerHTML = head + '<div class="empty">No save found yet. Start a new game once, then come back.</div>'; return; }
    try { mods = await scanDir(srcDir); } catch (e) { v.innerHTML = head + '<div class="empty bad">Could not read the folders: ' + esc(niceErr(e)) + '<br><br><button data-act="pickgame" class="pri">Choose game folder again</button>' + (RS.src !== 'live' ? ' <button data-act="srclive">Use current save folder</button>' : '') + '</div>'; return; }
    var opts = '<option value="live">Current save folder</option>' + l.map(function (m) { return '<option value="' + esc(m.id) + '"' + (RS.src === m.id ? ' selected' : '') + '>' + esc((m.tag || 'Snapshot') + ' - ' + new Date(m.created).toLocaleString()) + '</option>'; }).join('');
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
  var APP_VER = '1.2.0';   // fallback only; the real version is read from the app at startup (keep it equal to package.json)
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
        var pcks = (await fs.readDir(gameDir)).filter(function (e) { return !e.isDirectory && /\.pck$/i.test(e.name); }), f = pcks.filter(function (e) { return /^rtv\.pck$/i.test(e.name); })[0] || pcks[0];
        if (!f) throw new Error('No .pck file found in the game folder');
        var p = j(gameDir, f.name), rdr = pckReader(p, (await fs.stat(p)).size);
        IC.pack = await Pck.open(rdr); IC.idx = Pck.iconIndex(IC.pack); IC.close = rdr.close;
        return IC.pack;
      } finally { IC.busy = null; }
    })();
    return IC.busy;
  }
  function niceErr(e) { var m = String(e && e.message || e); var fp = /forbidden path:\s*(.+?),\s*maybe it is not allowed/i.exec(m); if (fp && !(gameDir && fp[1].toLowerCase().indexOf(gameDir.toLowerCase()) === 0)) { var perm = (/for `([^`]+)`/.exec(m) || [])[1]; return 'Quartermaster is not allowed to use "' + fp[1] + '"' + (perm ? ' (' + perm + ')' : '') + '. Choose the folder again in Settings; if that does not help, use Settings > Troubleshooting.'; } if (/cannot find the path|os error 3|No such file/i.test(m)) return 'the game folder was not found at this location, so choose it again'; if (/os error 5|access is denied|permission denied/i.test(m)) return 'Windows denied access (a file may be Read-only or in use by another program): ' + m; return /forbidden path|not allowed on the scope/i.test(m) ? 'the app no longer has permission to read the game folder (it is not remembered between launches), so choose the folder again' : m; }
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
  var CUR_FILE = '', CUR_CID = '', EDIT_ON = false, SS = { src: 'live', edit: false, items: {} };
  function slotInfo(t, ext, sid, rid) {
    var b = t.subById(sid); if (!b) return null;
    var im = /ExtResource\("([^"]+)"\)/.exec(t.get(b, 'itemData') || ''), p = im ? (ext[im[1]] || '') : '';
    var n = function (k) { var x = parseFloat(t.get(b, k)); return isNaN(x) ? 0 : x; };
    var gpm = /Vector2\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)/.exec(t.get(b, 'gridPosition') || '');
    return { sid: sid, rid: rid || sid, file: CUR_FILE, cid: CUR_CID, gx: gpm ? parseFloat(gpm[1]) : NaN, gy: gpm ? parseFloat(gpm[2]) : NaN, rot: t.get(b, 'gridRotated') === 'true', hasC: t.get(b, 'condition') !== undefined, hasA: t.get(b, 'amount') !== undefined, name: p ? Tres.itemName(p) : 'Unknown item', path: p || '', cat: catOf(p), cond: Math.round(n('condition')), qty: n('amount'), slot: String(t.get(b, 'slot') || '').replace(/"/g, ''),
      att: ids(inner(t.get(b, 'nested')), 'ExtResource').map(function (i) { return Tres.itemName(ext[i] || ''); }), attp: ids(inner(t.get(b, 'nested')), 'ExtResource').map(function (i) { return ext[i] || ''; }), chamber: t.get(b, 'chamber') === 'true', stored: ids(inner(t.get(b, 'storage')), 'SubResource').length };
  }
  function rowsHtml(list, sort) {
    var g = {}, order = [], seq = 0;
    list.forEach(function (s) { if (!s) return; var k = EDIT_ON ? 'e' + (seq++) : [s.name, s.cond, s.qty, s.att.join('+'), s.slot, s.stored].join('|'); if (!g[k]) { g[k] = { s: s, n: 0, ids: [] }; order.push(k); } g[k].n++; g[k].ids.push(s.sid); });
    if (sort) order.sort(function (a, b) { var x = g[a].s, y = g[b].s; return x.cat.localeCompare(y.cat) || x.name.localeCompare(y.name); });
    return order.map(function (k) {
      var s = g[k].s, n = g[k].n, kids = g[k].ids;
      var ed = EDIT_ON && s.sid;
      return '<tr' + (s.cat ? ' data-cat="' + esc(s.cat) + '"' : '') + (s.path ? ' data-path="' + esc(s.path) + '"' : '') + (s.attp && s.attp.length ? ' data-nested="' + esc(s.attp.join('|')) + '"' : '') + (s.slot ? ' data-slot="' + esc(s.slot) + '"' : '') + (s.sid ? ' data-ks="' + esc(kids.join(' ')) + '"' : '') + (s.cid ? ' data-cid="' + esc(s.cid) + '" data-gx="' + s.gx + '" data-gy="' + s.gy + '" data-rot="' + (s.rot ? 1 : 0) + '"' : '') + (ed ? ' class="er" data-file="' + esc(s.file) + '" data-rid="' + esc(s.rid) + '" data-sid="' + esc(s.sid) + '" data-name="' + esc(s.name) + '" data-ci="' + s.cond + '" data-ai="' + s.qty + '"' + (s.slot ? ' data-eq="1"' : '') + ' data-chi="' + (s.chamber ? 1 : 0) + '"' : '') + ' data-q="' + esc((s.name + ' ' + s.cat + ' ' + s.att.join(' ') + ' ' + s.slot).toLowerCase()) + '"><td>' + '<span class="ib">' + (/^res:\/\/Items\//i.test(s.path || '') ? '<img class="ico" data-ic="' + esc(s.path) + '" alt="" hidden>' : '') + glyph(s.cat) + '</span>' + (s.slot ? '<span class="meta">' + esc(s.slot) + '</span> ' : '') + esc(s.name) + (n > 1 ? ' &times;' + n : '') +
        (s.att.length || s.stored ? '<div class="meta">' + esc(s.att.join(', ')) + (s.stored ? (s.att.length ? ' &middot; ' : '') + s.stored + ' stored inside' : '') + '</div>' : '') + '</td><td class="meta">' + esc(s.cat) + '</td>' + (ed ? '<td class="cc">' + (s.hasC ? '<input type="number" data-w="c" min="0" max="100" step="1" value="' + s.cond + '">' : '') + '</td><td class="qc">' + (s.hasA ? '<input type="number" data-w="a" min="1" step="1" value="' + s.qty + '">' : '') + '</td><td><label><input type="checkbox" data-w="r"> Remove</label></td>' : '<td class="cc">' + s.cond + '%</td><td class="qc">' + (s.qty || '') + '</td>') + '</tr>';
    }).join('');
  }
  var itemTable = function (rows, force) { return rows || force ? '<table class="itm"><thead><tr><th>Item</th><th>Category</th><th>Cond.</th><th>Qty</th>' + (EDIT_ON ? '<th></th>' : '') + '</tr></thead><tbody>' + rows + '</tbody></table>' : '<p class="meta">Nothing here.</p>'; };
  // The equipment screen as the game draws it: 6 columns x 8 rows of cells. [slot name in the save, column, row, width, height]
  var EQ_CELL = 56, EQ_W = 6, EQ_H = 8;
  var EQ_LAYOUT = [['Primary', 0, 0, 6, 2], ['Secondary', 0, 2, 4, 2], ['Knife', 4, 2, 2, 1], ['Grenade_1', 4, 3, 1, 1], ['Grenade_2', 5, 3, 1, 1],
    ['Backpack', 0, 4, 2, 2], ['Rig', 2, 4, 2, 2], ['Helmet', 4, 4, 2, 2],
    ['Head', 0, 6, 1, 1], ['Torso', 1, 6, 1, 1], ['Legs', 2, 6, 1, 1], ['Belt', 3, 6, 1, 1], ['Feet', 4, 6, 1, 1], ['Hands', 5, 6, 1, 1],
    ['Matches', 0, 7, 1, 1], ['Light', 1, 7, 1, 1], ['NVG', 2, 7, 1, 1], ['Time', 3, 7, 1, 1], ['Map', 4, 7, 1, 1], ['Player', 5, 7, 1, 1]];
  function eqBarHtml() {
    return '<div class="addbar eqbar" data-file="' + esc(CUR_FILE) + '"><span class="tag man" title="New and still being tested. Keep your original snapshot and test the edited copy.">Experimental</span> <select class="eqslot"><option value="">Equip into slot...</option>' + EQ_LAYOUT.map(function (b) { return '<option value="' + b[0] + '">' + b[0].replace('_', ' ') + '</option>'; }).join('') + '</select>' +
      '<select class="eqitem" disabled><option value="">Choose a slot first</option></select><button data-act="eq-add">Equip</button><div class="eqatt" hidden></div><span class="meta amsg"></span></div>';
  }
  // base-game items allowed in each equipment slot, from the item definitions (built once)
  async function slotItems(slot) {
    if (!IC.slotIdx) {
      IC.slotIdx = {};
      var names = IC.pack.names.filter(function (n) { return /^Items\/[^\/]+\/[^\/]+\/[^\/]+\.tres\.remap$/.test(n) && n.indexOf('/Files/') === -1; });
      for (var n of names) {
        var p = 'res://' + n.replace(/\.remap$/, ''), d = await Pck.itemDef(IC.pack, p); if (!d || !d.ok) continue;
        d.slots.forEach(function (sl) { (IC.slotIdx[sl] = IC.slotIdx[sl] || []).push({ path: p, name: Tres.itemName(p) }); });
      }
    }
    return (IC.slotIdx[slot] || []).slice().sort(function (a, b) { return a.name.localeCompare(b.name); });
  }
  async function fillEqItems(bar) {
    var sel = bar.querySelector('.eqitem'), slot = bar.querySelector('.eqslot').value, msg = bar.querySelector('.amsg');
    msg.textContent = ''; fillEqAtt(bar, true); sel.disabled = true; sel.innerHTML = '<option value="">' + (slot ? 'Loading...' : 'Choose a slot first') + '</option>';
    if (!slot) return;
    if (!gameDir) { sel.innerHTML = '<option value="">Game folder needed</option>'; msg.textContent = 'Set the game folder in Settings first: the allowed items come from the game files.'; return; }
    try { await iconPack(); } catch (e) { sel.innerHTML = '<option value="">Unavailable</option>'; msg.textContent = 'Could not read the game files.'; return; }
    var items = await slotItems(slot);
    sel.innerHTML = '<option value="">' + (items.length ? 'Choose an item...' : 'No base-game items for this slot') + '</option>' + items.map(function (o) { return '<option value="' + esc(o.path) + '">' + esc(o.name) + '</option>'; }).join('');
    sel.disabled = !items.length;
  }
  // a weapon is equipped with one of its magazines loaded (the game's own compatible list)
  async function fillEqAtt(bar, clear) {
    var box = bar.querySelector('.eqatt'); box.hidden = true; box.innerHTML = ''; if (clear) return;
    var path = bar.querySelector('.eqitem').value; if (!path) return;
    var wd = await Pck.itemDef(IC.pack, path); if (!wd || !wd.ok) return;
    var cg = await compatGroups(wd, []); if (!cg.names.length) return;
    box.innerHTML = cg.names.map(function (c) {
      var mag = c === 'Magazine', opts = cg.groups[c].map(function (o, i) { return '<option value="' + esc(o.path) + '" data-max="' + (o.d.maxAmount || 0) + '"' + (mag && i === 0 ? ' selected' : '') + '>' + esc(optLabel(c, o)) + '</option>'; }).join('');
      return '<label class="eqf">' + esc(c) + ' <select data-cat="' + esc(c) + '">' + (mag ? opts + '<option value="" data-max="0">None</option>' : '<option value="">None</option>' + opts) + '</select></label>';
    }).join('');
    box.hidden = false;
  }
  async function eqAdd(bar) {
    var msg = bar.querySelector('.amsg'), say = function (t) { msg.textContent = t; }; say('');
    var slot = bar.querySelector('.eqslot').value, path = bar.querySelector('.eqitem').value;
    if (!slot || !path) return say('Choose a slot and an item first.');
    var box = bar.closest('.cgwrap').querySelector('.eqs[data-slot="' + slot + '"]'); if (!box) return say('This slot is not on the equipment screen.');
    var used = document.querySelector('#view tr.er[data-slot="' + slot + '"]');
    if (used && !used.querySelector('[data-w="r"]').checked) return say('The ' + slot.replace('_', ' ') + ' slot is in use. Remove its item first (the \u00d7 on the slot).');
    if (document.querySelector('#view tr.ea[data-slot="' + slot + '"]')) return say('This slot already has a pending item. Cancel it first.');
    var def = await Pck.itemDef(IC.pack, path); if (!def || !def.ok) return say('Could not read this item from the game files.');
    var sels = Array.prototype.slice.call(bar.querySelectorAll('.eqatt select')), att = sels.map(function (x) { return x.value; }).filter(Boolean);
    var ms = bar.querySelector('.eqatt select[data-cat="Magazine"]'), mmax = ms && ms.value ? +ms.options[ms.selectedIndex].dataset.max || 0 : 0;
    var amount = def.type === 'Weapon' ? (ms ? mmax : def.magazineSize) : (def.stackable ? Math.min(def.defaultAmount || 1, def.maxAmount > 0 ? def.maxAmount : (def.defaultAmount || 1)) : (def.showAmount ? (def.defaultAmount || def.maxAmount || 1) : def.defaultAmount));
    var aid = 'a' + (++AID), cond = def.showCondition || (def.carrier && att.length) ? 100 : 0, nm = Tres.itemName(path), cat = catOf(path), tb = bar.closest('.cbody').querySelector('table.itm tbody');
    var attNames = att.map(function (a) { return Tres.itemName(a); }).join(', ');
    placeRow(tb, '<tr class="ea" data-aid="' + aid + '" data-file="' + esc(bar.dataset.file) + '" data-cid="' + EQ_CID + '" data-cname="Equipment" data-slot="' + esc(slot) + '" data-att="' + esc(att.join('|')) + '" data-path="' + esc(path) + '" data-name="' + esc(nm) + '" data-gx="0" data-gy="0" data-rot="0" data-amt="' + amount + '" data-cond="' + cond + '" data-cat="' + esc(cat) + '" data-q="' + esc(nm.toLowerCase()) + '"><td><span class="ib"><img class="ico" data-ic="' + esc(path) + '" alt="" hidden>' + glyph(cat) + '</span>' + esc(nm) + ' <span class="tag man">NEW</span><div class="meta">' + esc(slot.replace('_', ' ')) + ' slot' + (attNames ? ' &middot; ' + esc(attNames) : '') + '</div></td><td class="meta">' + esc(cat) + '</td><td>' + (cond ? cond + '%' : '\u2013') + '</td><td>' + (amount || '') + '</td><td><button data-act="sh-cancel">Cancel</button></td></tr>');
    box.dataset.old = box.innerHTML; box.dataset.oldc = box.className; box.dataset.aid = aid; box.className = 'eqs has new';
    box.innerHTML = '<img data-ic="' + esc(path) + '" alt="" hidden>' + glyph(cat) + '<span class="eqn">' + esc(nm) + '</span>';
    bar.querySelector('.eqslot').value = ''; fillEqItems(bar);
    say('Equipped ' + nm + ' (pending). It is saved only when you create the edited copy.');
    fillIcons();
  }
  function eqPanelHtml(eq) {
    var by = {}, used = {};
    eq.forEach(function (s) { by[String(s.slot).toLowerCase()] = s; });
    var boxes = EQ_LAYOUT.map(function (b) {
      var s = by[b[0].toLowerCase()]; if (s) used[b[0].toLowerCase()] = true;
      return '<div class="eqs' + (s ? ' has' : (EDIT_ON ? ' eqe' : '')) + '" data-slot="' + esc(b[0]) + '" data-c="' + b[1] + '" data-r="' + b[2] + '" data-w="' + b[3] + '" data-h="' + b[4] + '"' + (s ? ' data-path="' + esc(s.path) + '" data-nested="' + esc((s.attp || []).join('|')) + '" data-cond="' + s.cond + '" data-qty="' + s.qty + '" title="' + esc(s.name + ' (' + b[0] + ')') + '"' : ' title="' + esc(b[0]) + ' (empty)"') + '>' +
        (s ? (/^res:\/\/Items\//i.test(s.path || '') ? '<img data-ic="' + esc(s.path) + '" alt="" hidden>' : '') + glyph(s.cat) + '<span class="eqn">' + esc(s.name) + '</span><span class="eqc"></span><span class="eqa"></span>' + (EDIT_ON && s.sid ? '<button class="eqx" data-act="eq-rm" title="Remove this item">&times;</button>' : '') : '<span class="eql">' + esc(b[0].replace('_', ' ')) + '</span>') + '</div>';
    }).join('');
    var other = eq.filter(function (s) { return !used[String(s.slot).toLowerCase()]; });
    return '<div class="cgrid eqgrid">' + boxes + '</div>' + (other.length ? '<p class="meta">Other equipped (slot not on the screen): ' + other.map(function (s) { return esc(s.name) + ' (' + esc(s.slot || 'no slot') + ')'; }).join(', ') + '</p>' : '') + '<p class="meta">Click an item to select it.</p>';
  }
  // sizes and positions are set from code (the CSP does not allow inline style attributes)
  async function layoutEquip() {
    var gs = Array.prototype.slice.call(document.querySelectorAll('#view .eqgrid')); if (!gs.length) return;
    var haveDefs = false; if (gameDir && !IC.fail) { try { await iconPack(); haveDefs = true; } catch (e) {} }
    for (var g of gs) {
      g.style.width = EQ_W * EQ_CELL + 'px'; g.style.height = EQ_H * EQ_CELL + 'px'; g.style.backgroundSize = EQ_CELL + 'px ' + EQ_CELL + 'px';
      for (var el of Array.prototype.slice.call(g.querySelectorAll('.eqs'))) {
        el.style.left = el.dataset.c * EQ_CELL + 'px'; el.style.top = el.dataset.r * EQ_CELL + 'px'; el.style.width = el.dataset.w * EQ_CELL + 'px'; el.style.height = el.dataset.h * EQ_CELL + 'px';
        if (!el.dataset.path || !haveDefs) continue;
        var d = null; try { d = /^res:\/\/Items\//i.test(el.dataset.path) ? await Pck.itemDef(IC.pack, el.dataset.path) : null; } catch (e) { d = null; }
        if (!d || !d.ok) continue;
        var c = el.querySelector('.eqc'), a = el.querySelector('.eqa'), cond = +el.dataset.cond, qty = +el.dataset.qty;
        var platedEq = !!d.carrier && (d.compatible || []).some(function (cp) { return (el.dataset.nested || '').split('|').indexOf(cp) !== -1; });
        if (d.showCondition || platedEq) { c.textContent = cond + '%'; c.className = 'eqc ' + (cond >= 50 ? 'ok' : cond >= 25 ? 'warn' : 'bad'); }
        if (d.showAmount && qty) a.textContent = qty;
      }
    }
  }
  var INV_CID = '__inv', EQ_CID = '__eq', INV_W = 8, INV_H = 13;
  function eqIdx(slot) { for (var i = 0; i < EQ_LAYOUT.length; i++) if (EQ_LAYOUT[i][0] === slot) return i; return 99; }
  // puts a new (pending) row where it will be listed after saving: equipment by slot (right below the item it replaces), other lists by category and name
  function placeRow(tb, html) {
    var tmp = document.createElement('tbody'); tmp.innerHTML = html; var nr = tmp.firstElementChild; if (!nr) return;
    var isEq = nr.dataset.cid === EQ_CID, newKey = isEq ? eqIdx(nr.dataset.slot) * 2 + 1 : 0, ref = null;
    for (var r of Array.prototype.slice.call(tb.children)) {
      if (r.classList.contains('wrow')) continue;   // belongs to the row before it
      var after = isEq ? eqIdx(r.dataset.slot || '') * 2 + (r.classList.contains('ea') ? 1 : 0) > newKey : ((r.dataset.cat || '').localeCompare(nr.dataset.cat || '') || (r.dataset.name || '').localeCompare(nr.dataset.name || '')) > 0;
      if (after) { ref = r; break; }
    }
    tb.insertBefore(nr, ref);
  }   // the carried inventory: 8 columns x 13 rows, stored in the character's own inventory list
  var INSP_VIEW = '<div class="meta">Click an item on a grid or slot to see its details. Turn on Edit mode to change it.</div>', INSP_EDIT = '<div class="meta">Click an item on a grid or slot to edit it here.</div>';
  var inspPh = function (pg) { return ((pg && pg.id === 'pg-shelter') ? SS.edit : IS.edit) ? INSP_EDIT : INSP_VIEW; };
  function charHtml(t, m, ext) {
    var map = function (k) { return ids(t.get(m, k), 'SubResource').map(function (i) { return slotInfo(t, ext, i); }); }, eq = map('equipment').filter(Boolean).sort(function (a, b) { return eqIdx(a.slot) - eqIdx(b.slot); });
    CUR_CID = INV_CID; var inv = map('inventory'); CUR_CID = '';
    return '<h2>Character</h2><div class="invlayout"><div class="ilcol"><h3>Equipment</h3><div class="cbody"><div class="ctab"><h3>Equipped</h3>' + itemTable(rowsHtml(eq, false)) + '</div><div class="cgwrap">' + eqPanelHtml(eq) + (EDIT_ON ? eqBarHtml() : '') + '</div></div></div>' +
      '<div class="ilcol carried"><h3>Carried &middot; ' + inv.length + ' items &middot; ' + INV_W + '&times;' + INV_H + ' grid</h3>' + (EDIT_ON ? addBarHtml(CUR_FILE, INV_CID, INV_W, INV_H, 'Carried items') : '') + '<div class="cbody"><div class="ctab"><h3>Carried</h3>' + itemTable(rowsHtml(inv, true), EDIT_ON) + '</div><div class="cgwrap">' + gridHtml({ dims: [INV_W, INV_H], items: inv }) + '</div></div></div>' +
      '<div class="insp">' + (EDIT_ON ? INSP_EDIT : INSP_VIEW) + '</div></div>';
  }
  // Uses the item definitions in the game files: hides condition/quantity where the game has none, caps the quantity at the stack limit.
  async function applyDefs() {
    var rows = Array.prototype.slice.call(document.querySelectorAll('#view tr[data-path]'));
    if (!rows.length || !gameDir || IC.fail) return;
    try { await iconPack(); } catch (e) { return; }
    for (var tr of rows) {
      var d; try { d = await Pck.itemDef(IC.pack, tr.dataset.path); } catch (e) { d = null; }
      if (!d || !d.ok) continue;
      var ed = tr.classList.contains('er'), cc = tr.querySelector('.cc'), qc = tr.querySelector('.qc');
      var wkind = d.type === 'Weapon' ? 'Weapon' : (d.slots || []).indexOf('Rig') !== -1 ? 'Plates' : (d.slots || []).indexOf('Player') !== -1 ? 'Cassette' : '';
      if (ed && wkind && !tr.querySelector('[data-act="wp-open"]')) { var lt = tr.lastElementChild; if (lt) lt.insertAdjacentHTML('beforeend', ' <button data-act="wp-open" title="' + (wkind === 'Weapon' ? 'Change the magazine, attachments and chamber' : 'Change what is fitted to this item') + '">' + wkind + '&hellip;</button>'); if (wkind === 'Weapon') { tr.dataset.wp = '1'; var wq = tr.querySelector('[data-w="a"]'); if (wq) wq.min = 0; } }
      var plated = !!d.carrier && (d.compatible || []).some(function (c) { return (tr.dataset.nested || '').split('|').indexOf(c) !== -1; });
      if (d.carrier) { tr.dataset.rig = '1'; tr.dataset.plated = plated ? '1' : '0'; }
      if (cc && !d.showCondition && !plated) cc.innerHTML = '<span class="meta" title="The game does not use a condition for this item">' + (ed ? 'n/a' : '\u2013') + '</span>';
      if (qc && !d.showAmount) qc.innerHTML = ed ? '<span class="meta" title="The game does not use a quantity for this item">n/a</span>' : '';
      else if (qc && d.maxAmount) { var qi = qc.querySelector('input'); if (qi) { qi.max = d.maxAmount; if (+qi.value > d.maxAmount) qi.value = d.maxAmount; } }
    }
  }
  async function renderInventory() {
    var v = pageEl('inventory'), l = await list();
    if (IS.src !== 'live' && !l.some(function (m) { return m.id === IS.src; })) IS.src = 'live';
    var dir = IS.src === 'live' ? saveDir : j(j(bakDir, IS.src), 'data');
    var opts = '<option value="live">Current save folder</option>' + l.map(function (m) { return '<option value="' + esc(m.id) + '">' + esc((m.tag || 'Snapshot') + ' - ' + new Date(m.created).toLocaleString()) + '</option>'; }).join('');
    var head = '<h1>Inventory</h1><p class="sub">' + (IS.edit ? 'Edit mode: change condition and quantity, tick Remove, or add items to your carried grid, then create an edited copy. Your live save is never touched: the copy appears under Snapshots, and you restore it when the game is closed.' : 'What you wear and carry. Shelters are on the Shelter page. Nothing here changes your save unless you create an edited copy in Edit mode.') + '</p><div class="bar"><select id="isrc">' + opts + '</select><span class="sp"></span><button data-act="lv-toggle" title="Show the item lists with their edit fields next to the grids">' + (LV.inventory ? 'Hide list view' : 'List view') + '</button><input id="invq" type="search" placeholder="Search items">' + (IS.edit ? '<button data-act="inv-edit">Exit edit mode</button><button data-act="inv-apply" class="pri">Create edited copy</button>' : '<button data-act="inv-edit">Edit mode</button>') + '</div>';
    if (!(await fs.exists(dir))) { v.innerHTML = head + '<div class="empty">No save found yet. Start a new game once, then come back.</div>'; $('#isrc').value = IS.src; return; }
    var chars = '';
    try {
      for (var e of await fs.readDir(dir)) {
        if (!isTres(e)) continue;
        var t = Tres.parse(await fs.readTextFile(j(dir, e.name))), m = t.main(); if (!m) continue;
        CUR_FILE = e.name; EDIT_ON = IS.edit;
        if (t.get(m, 'equipment') !== undefined) chars += charHtml(t, m, extMap(t));
      }
    } catch (err) { v.innerHTML = head + '<div class="empty bad">Could not read the save: ' + esc(err) + '</div>'; $('#isrc').value = IS.src; return; }
    v.innerHTML = head + iconHint() + '' + (chars || '<div class="empty">No character file found in this save.</div>'); v.classList.toggle('lv', LV.inventory);
    $('#isrc').value = IS.src;
    fillIcons();
    applyDefs();
    layoutGrids();
    layoutEquip();
    if (IS.edit) fillItemList();
  }



  /* ---------- shelter page (containers and loose items; editing writes a new snapshot) ---------- */
  // Grid size of each container furniture, in cells (width x height).
  var CONTAINERS = { Cabinet_Medical_F: [4, 4], Cabinet_Office_F: [4, 4], Cabinet_Wood_F: [6, 8], Crate_Military_F: [8, 6], Crate_Special_F: [8, 13], Freezer_F: [8, 13], Fridge_F: [4, 6], Locker_F: [8, 13], Nightstand_F: [4, 3], Stove_F: [5, 5] };
  var CELL = 64;  // grid positions in the save are cell index x 64
  // Items from mods are not in the game files, so their grid size is unknown. The user tells us once; it is remembered.
  var MODSZ = (function () { try { return JSON.parse(localStorage.getItem('modsizes') || '{}') || {}; } catch (e) { return {}; } })();
  var LV = { inventory: localStorage.getItem('lv_inventory') === '1', shelter: localStorage.getItem('lv_shelter') !== '0' };   // show the item lists (with their edit fields) next to the grids; the shelter has too many items for the grid-only view
  var WARN = localStorage.getItem('warnunsaved') !== '0', noWarnOnce = false;   // warn about changes that are not in an edited copy yet
  var XMAGS = localStorage.getItem('xmags') === '1';   // offer magazines of other weapons with the same ammo (needs a cross-compatibility mod)
  function saveModSizes() { localStorage.setItem('modsizes', JSON.stringify(MODSZ)); }
  async function sizeFor(path) {
    var d = null; try { d = IC.pack ? await Pck.itemDef(IC.pack, path) : null; } catch (e) { d = null; }
    return d && d.ok ? d.size : (MODSZ[path] || null);
  }
  async function askModSize(path) {
    var mod = Tres.modOf(path);
    var r = await ask('Size of a modded item', Tres.itemName(path) + (mod ? ' (from the mod "' + mod + '")' : '') + ' is not in the base game, so its size in the inventory grid is unknown.\n\nHow many cells does it take in the game? Enter width x height, for example 1x1. Quartermaster remembers it (Settings lists it and can forget it). A wrong size can make items overlap in game, so check it in your inventory.', { input: '1x1', ok: 'Save' });
    var m = typeof r === 'string' ? /^\s*(\d+)\s*[x\u00d7*]\s*(\d+)\s*$/i.exec(r) : null;
    if (!m || +m[1] < 1 || +m[2] < 1 || +m[1] > 12 || +m[2] > 16) return null;
    MODSZ[path] = [+m[1], +m[2]]; saveModSizes(); return MODSZ[path];
  }
  var invLine = function (e) { return e.weapon ? weaponLine(e) : e.add ? '+ ' + e.name + (e.amount > 1 ? ' \u00d7' + e.amount : '') + ' \u2192 ' + e.cname + (e.slot ? ' (' + e.slot + ' slot' + (e.att && e.att.length ? ', with ' + e.att.map(function (a) { return Tres.itemName(a); }).join(', ') : '') + ')' : ' (column ' + (e.col + 1) + ', row ' + (e.row + 1) + ')') : e.remove ? e.name + ': remove' : e.name + ': ' + (e.cond !== undefined ? 'condition ' + e.condFrom + ' \u2192 ' + e.cond : '') + (e.cond !== undefined && e.amt !== undefined ? ', ' : '') + (e.amt !== undefined ? 'quantity ' + e.amtFrom + ' \u2192 ' + e.amt : ''); };
  // plans every page's pending changes on top of each other (so two pages can change the same file) and writes ONE edited copy
  async function createBatch() {
    var ie = collectInvEdits().concat(collectAdds(), collectWeaponEdits()), qe = collectQuestEdits(), ce = collectEdits();
    var total = ie.length + qe.length + ce.length; if (!total) { toast('No changes to apply'); return; }
    var src = srcDir(), texts = {}, parts = [], blocks = [];
    var rd = async function (f) { return texts[f] !== undefined ? texts[f] : await fs.readTextFile(j(src, f)); };
    if (ie.length) {
      var plan = await planInv(src, ie, rd); Object.keys(plan.out).forEach(function (f) { texts[f] = plan.out[f]; });
      if (ie.some(function (e) { return e.file === 'Character.tres'; })) parts.push('inventory');
      if (ie.some(function (e) { return e.file !== 'Character.tres'; })) parts.push('shelter');
      var lines = ie.slice(0, 14).map(invLine); if (ie.length > 14) lines.push('...and ' + (ie.length - 14) + ' more');
      var sum = [plan.added ? plan.added + ' added' : '', plan.edited ? plan.edited + ' changed' : '', plan.removed ? plan.removed + ' removed (including anything stored inside them)' : ''].filter(Boolean).join(', ');
      var eqWarn = (ie.some(function (e) { return e.remove && e.eq; }) ? '\nNote: removing an equipped item may confuse the game\'s held-item state. Test the copy before relying on it.' : '') + (ie.some(function (e) { return e.add; }) ? '\nAdding items is experimental. It has worked in testing, but keep your original snapshot and test the copy before relying on it.' : '');
      blocks.push('Inventory and shelters\n' + lines.join('\n') + '\n' + sum + '.' + eqWarn);
    }
    if (ce.length) {
      ce.forEach(function (e) { e.raw = rawOf(e); });
      for (var f of ['Character', 'World']) {
        var es = ce.filter(function (e) { return e.f === f; }); if (!es.length) continue;
        var tc = Tres.parse(await rd(f + '.tres')), mc = tc.main(); es.forEach(function (e) { tc.set(mc, e.k, e.raw); }); texts[f + '.tres'] = tc.serialize();
      }
      parts.push('character'); blocks.push('Character and world\n' + ce.map(function (e) { return e.label + ': ' + e.from + ' \u2192 ' + e.to; }).join('\n'));
    }
    if (qe.length) {
      var qp = await planTraders(src, qe, rd); Object.keys(qp.out).forEach(function (f) { texts[f] = qp.out[f]; });
      parts.push('traders');
      var ql = qe.slice(0, 14).map(function (e) { return TRADERS[e.k][0] + ' - ' + e.name + ': ' + QSTATE[e.from] + ' \u2192 ' + QSTATE[e.to]; }); if (qe.length > 14) ql.push('...and ' + (qe.length - 14) + ' more');
      blocks.push('Traders\n' + ql.join('\n') + '\nMarking a task Completed does not hand over its reward.');
    }
    for (var fn of Object.keys(texts)) { var tt = Tres.parse(texts[fn]), pr = tt.validate().concat(tt.checkOrder()); if (pr.length) throw new Error('The edited ' + fn + ' failed its check: ' + pr[0]); }
    if (!(await ask('Create edited copy?', blocks.join('\n\n'), { ok: 'Create' }))) return;
    var tag = 'Edited ' + parts.join(' + ') + ': ' + total + ' change' + (total === 1 ? '' : 's');
    var meta = await snapFrom(src, tag), data = j(j(bakDir, meta.id), 'data');
    for (var wf of Object.keys(texts)) await fs.writeTextFile(j(data, wf), texts[wf]);
    resetAllPages();
    await ask('Edited copy created', 'Find it under Snapshots (tagged "' + tag + '") and restore it when the game is closed. Your original is unchanged.', { ok: 'OK' });
  }
  function warnSettingHtml() {
    return '<div class="set"><h4>Unsaved changes</h4><label class="ab-check"><input type="checkbox" id="warnunsaved"' + (WARN ? ' checked' : '') + '> Warn me when I leave a page or close the app with changes that are not in an edited copy yet</label></div>';
  }
  // how many edits are waiting on the current page (anything that cannot be read counts as pending)
  function pendingChanges() {
    var n = 0;
    [collectInvEdits, collectAdds, collectWeaponEdits, collectEdits, collectQuestEdits].forEach(function (fn) { try { n += fn().length; } catch (e) { n += 1; } });
    return n;
  }
  async function leaveOk() { return !WARN || !pendingChanges() || !!(await ask('Unsaved changes', 'You have changes that are not in an edited copy yet. If you continue they are lost.', { ok: 'Discard changes' })); }
  function diagHtml() {
    return '<div class="set"><h4>Troubleshooting</h4><p class="nb">If Quartermaster reports a "forbidden path" or permission error, run this test and send the result when asking for help.</p><div class="ab-line"><button data-act="diag">Test folder access</button><button data-act="diagcopy">Copy result</button><button data-act="resetscope" class="dng">Reset folder permissions</button></div><pre class="diag" id="diagout" hidden></pre></div>';
  }
  // tries what a backup needs (read the save folder, write into the backups folder, copy a file) and reports the exact error of each step
  async function runDiag() {
    var out = [], add = function (x) { out.push(x); };
    var test = async function (label, fn) { try { var r = await fn(); add('OK    ' + label + (r ? ' ' + r : '')); } catch (e) { add('FAIL  ' + label + ': ' + String(e && e.message || e)); } };
    add('Vostok Quartermaster' + (APP_VER ? ' v' + APP_VER : '')); add('Save folder:    ' + saveDir); add('Backups folder: ' + bakDir); add('Game folder:    ' + (gameDir || '(not set)'));
    try { add('App data:       ' + await T.path.appDataDir()); } catch (e) { add('App data:       ' + e); }
    add('');
    await test('read the save folder', async function () { var l = await fs.readDir(saveDir); return '(' + l.length + ' entries)'; });
    await test('create the backups folder', async function () { await fs.mkdir(bakDir, { recursive: true }); });
    await test('write and delete a file in the backups folder', async function () { var f = j(bakDir, 'diagnostic.tmp'); await fs.writeTextFile(f, 'test'); await fs.remove(f); });
    await test('copy a save file into the backups folder', async function () {
      var fl = (await fs.readDir(saveDir)).filter(function (x) { return !x.isDirectory; })[0]; if (!fl) return '(the save folder has no file to copy)';
      var d = j(bakDir, 'diagnostic-copy.tmp'); await fs.copyFile(j(saveDir, fl.name), d); await fs.remove(d);
    });
    if (gameDir) await test('read the game folder', async function () { var l = await fs.readDir(gameDir); return '(' + l.length + ' entries)'; });
    return out.join('\n');
  }
  function magSettingHtml() {
    return '<div class="set"><h4>Weapon editor</h4><label class="ab-check"><input type="checkbox" id="xmags"' + (XMAGS ? ' checked' : '') + '> Also offer magazines of other weapons that use the same ammo</label><p class="mt nb">The base game only lets a weapon take the magazines it lists. Turn this on only if you use a magazine cross-compatibility mod.</p></div>';
  }
  function modSizeHtml() {
    var ks = Object.keys(MODSZ);
    return '<div class="set"><h4>Modded item sizes</h4><p class="nb">Sizes you entered for items from mods (needed to add items next to them safely).' + (ks.length ? '' : ' None yet.') + '</p>' +
      ks.map(function (k) { return '<div class="ab-line"><span>' + esc(Tres.itemName(k)) + ' &middot; ' + MODSZ[k][0] + '&times;' + MODSZ[k][1] + ' <span class="meta">(' + esc(Tres.modOf(k) || 'unknown mod') + ')</span></span><button data-act="forgetsize" data-p="' + esc(k) + '">Forget</button></div>'; }).join('') + '</div>';
  }
  function furBase(p) { return (String(p).split('/').pop() || '').replace(/\.tres$/i, ''); }
  // placed = [{col,row,w,h}]; returns a problem description or ''
  function layoutProblem(W, H, placed) {
    var taken = {};
    for (var i = 0; i < placed.length; i++) {
      var p = placed[i];
      if (p.col < 0 || p.row < 0 || p.col + p.w > W || p.row + p.h > H) return 'An item in this container sits outside its grid (unexpected layout), so nothing is added.';
      for (var r = p.row; r < p.row + p.h; r++) for (var c = p.col; c < p.col + p.w; c++) { if (taken[c + ',' + r]) return 'Items in this container overlap (unexpected layout), so nothing is added.'; taken[c + ',' + r] = true; }
    }
    return '';
  }
  // first free spot, scanning row by row; the normal orientation first, then rotated
  function findSlot(W, H, placed, w, h) {
    var taken = {};
    placed.forEach(function (p) { for (var r = p.row; r < p.row + p.h; r++) for (var c = p.col; c < p.col + p.w; c++) taken[c + ',' + r] = true; });
    var fits = function (col, row, ww, hh) { for (var r = row; r < row + hh; r++) for (var c = col; c < col + ww; c++) if (taken[c + ',' + r]) return false; return true; };
    var row, col;
    for (row = 0; row <= H - h; row++) for (col = 0; col <= W - w; col++) if (fits(col, row, w, h)) return { col: col, row: row, rot: false };
    if (w !== h) for (row = 0; row <= H - w; row++) for (col = 0; col <= W - h; col++) if (fits(col, row, h, w)) return { col: col, row: row, rot: true };
    return null;
  }
  var CELLPX = 44, AID = 0;
  // size and position a grid item; a rotated item gets its icon turned 90 degrees to fill the swapped box
  function placeItem(el, col, row, sz, rot) {
    var w = rot ? sz[1] : sz[0], h = rot ? sz[0] : sz[1], im = el.querySelector('img');
    el.style.left = col * CELLPX + 'px'; el.style.top = row * CELLPX + 'px'; el.style.width = w * CELLPX + 'px'; el.style.height = h * CELLPX + 'px';
    if (im) {
      if (rot) { im.style.width = sz[0] * CELLPX + 'px'; im.style.height = sz[1] * CELLPX + 'px'; im.style.maxWidth = 'none'; im.style.flex = 'none'; im.style.transform = 'rotate(-90deg)'; }
      else { im.style.width = ''; im.style.height = ''; im.style.maxWidth = ''; im.style.flex = ''; im.style.transform = ''; }
    }
  }
  function gridHtml(f) {
    return '<div class="cgrid" data-w="' + (f.dims ? f.dims[0] : 0) + '" data-h="' + (f.dims ? f.dims[1] : 0) + '"' + (f.dims ? '' : ' data-est="1"') + '>' + f.items.map(function (s) {
      return '<div class="gi" data-k="' + esc(s.sid || '') + '" data-path="' + esc(s.path) + '" data-gx="' + s.gx + '" data-gy="' + s.gy + '" data-rot="' + (s.rot ? 1 : 0) + '" data-name="' + esc(s.name) + '" title="' + esc(s.name) + '">' +
        (/^res:\/\/Items\//i.test(s.path || '') ? '<img data-ic="' + esc(s.path) + '" alt="" hidden>' : '') + glyph(s.cat) + '</div>';
    }).join('') + '</div><p class="meta gmsg"></p>';
  }
  // positions and sizes are set from code (the page's CSP does not allow inline style attributes)
  async function layoutGrids() {
    var grids = Array.prototype.slice.call(document.querySelectorAll('#view .cgrid:not(.eqgrid)'));
    if (!grids.length) return;
    var haveDefs = false; if (gameDir && !IC.fail) { try { await iconPack(); haveDefs = true; } catch (e) {} }
    for (var g of grids) {
      var est = g.dataset.est === '1', W = est ? Infinity : +g.dataset.w, H = est ? Infinity : +g.dataset.h, placed = [], issues = [], maxc = 0, maxr = 0, unknown = 0;
      if (!est) { g.style.width = W * CELLPX + 'px'; g.style.height = H * CELLPX + 'px'; }
      g.style.backgroundSize = CELLPX + 'px ' + CELLPX + 'px';
      var els = Array.prototype.slice.call(g.querySelectorAll('.gi'));
      for (var el of els) {
        var d = null; try { d = haveDefs && /^res:\/\/Items\//i.test(el.dataset.path || '') ? await Pck.itemDef(IC.pack, el.dataset.path) : null; } catch (e) { d = null; }
        var ms = MODSZ[el.dataset.path], known = !!(d && d.ok) || !!ms, sz = d && d.ok ? d.size : (ms || [1, 1]), rot = el.dataset.rot === '1', gx = parseFloat(el.dataset.gx), gy = parseFloat(el.dataset.gy);
        var w = rot ? sz[1] : sz[0], h = rot ? sz[0] : sz[1], col = gx / CELL, row = gy / CELL, nm = el.dataset.name || 'item';
        if (isNaN(gx) || isNaN(gy)) { issues.push(nm + ' has no readable position'); el.hidden = true; continue; }
        if (gx % CELL || gy % CELL) issues.push(nm + ' is not on the 64-unit grid (x ' + gx + ', y ' + gy + ')');
        if (!known) { unknown++; el.classList.add('unk'); }
        placeItem(el, col, row, sz, rot);
        placed.push({ col: col, row: row, w: w, h: h, el: el, name: nm });
        maxc = Math.max(maxc, col + w); maxr = Math.max(maxr, row + h);
      }
      if (est) { var ew = Math.max(maxc, 2), eh = Math.max(maxr, 2); g.style.width = ew * CELLPX + 'px'; g.style.height = eh * CELLPX + 'px'; }
      placed.forEach(function (p, i) {
        var out = !est && (p.col < 0 || p.row < 0 || p.col + p.w > W || p.row + p.h > H), hit = placed.some(function (q, k) { return k !== i && p.col < q.col + q.w && q.col < p.col + p.w && p.row < q.row + q.h && q.row < p.row + p.h; });
        if (out) issues.push(p.name + ' reaches outside the ' + W + '\u00d7' + H + ' grid');
        if (hit) issues.push(p.name + ' overlaps another item');
        if (out || hit) p.el.classList.add('bad');
      });
      var msg = g.nextElementSibling;
      if (msg) { msg.className = 'meta gmsg' + (issues.length ? ' bad' : ''); msg.textContent = (est ? 'Size unknown (modded furniture), so this grid is drawn from the items\' positions. ' : '') + (placed.length ? 'Items reach column ' + maxc + (est ? '' : ' of ' + W) + ' and row ' + maxr + (est ? '' : ' of ' + H) + '.' : 'Empty ' + W + '\u00d7' + H + ' grid.') + (unknown ? ' ' + unknown + ' item' + (unknown === 1 ? '' : 's') + ' of unknown size (drawn as 1\u00d71).' : '') + (issues.length ? ' ' + issues.slice(0, 4).join('; ') + (issues.length > 4 ? '; ...' : '') + '.' : ''); }
    }
  }
  // the "add an item" bar above a grid (shelter containers and the carried inventory)
  function addBarHtml(file, cid, W, H, cname) {
    return '<div class="addbar" data-file="' + esc(file) + '" data-cid="' + esc(cid) + '" data-cw="' + W + '" data-ch="' + H + '" data-cname="' + esc(cname) + '"><span class="tag man" title="Adding items worked in testing, but it needs more testing. Always test the edited copy and keep your original.">Experimental</span><input type="search" class="aitem" list="itemlist" placeholder="Add an item to this container" autocomplete="off"><input type="number" class="aqty" min="1" placeholder="Qty" title="How many to add. Ammo and money: the total count (split into stacks). Anything else: the number of separate items."><button data-act="sh-add">Add</button><select class="atask" title="Add the reward items of a trader task to this container">' + questOptions() + '</select><button data-act="sh-reward">Add rewards</button><span class="meta amsg"></span></div>';
  }
  function shelterPageHtml(name, t, m, ext) {
    var seen = {};
    var fur = ids(t.get(m, 'furnitures'), 'SubResource').map(function (id) {
      var b = t.subById(id); if (!b) return null;
      var im = /ExtResource\("([^"]+)"\)/.exec(t.get(b, 'itemData') || ''), p = im ? (ext[im[1]] || '') : '', base = furBase(p);
      CUR_CID = id;
      var items = ids(t.get(b, 'storage'), 'SubResource').map(function (i) { return slotInfo(t, ext, i); });
      CUR_CID = '';
      var nm = String(t.get(b, 'name') || '').replace(/"/g, '') || base.replace(/_F$/, '').replace(/_/g, ' ') || 'Furniture';
      seen[nm] = (seen[nm] || 0) + 1;
      return { id: id, name: nm, n: seen[nm], dims: CONTAINERS[base] || null, items: items };
    }).filter(Boolean);
    var cont = fur.filter(function (f) { return f.dims || f.items.length; }), stored = cont.reduce(function (n, f) { return n + f.items.length; }, 0);
    var loose = ids(t.get(m, 'items'), 'SubResource').map(function (id) { var b = t.subById(id); return b ? slotInfo(t, ext, ids(t.get(b, 'slotData'), 'SubResource')[0], id) : null; }).filter(Boolean);
    var title = function (f) { return f.name + (seen[f.name] > 1 ? ' #' + f.n : ''); };
    var cdet = function (f) {
      var add = EDIT_ON && f.dims ? addBarHtml(CUR_FILE, f.id, f.dims[0], f.dims[1], title(f)) : '';
      return '<details' + (EDIT_ON ? ' open' : '') + '><summary>' + esc(title(f)) + ' <span class="meta">&middot; ' + (f.dims ? f.dims[0] + '&times;' + f.dims[1] + ' &middot; ' : 'size unknown &middot; ') + f.items.length + ' item' + (f.items.length === 1 ? '' : 's') + '</span></summary>' + add + '<div class="cbody"><div class="ctab">' + itemTable(rowsHtml(f.items, true), EDIT_ON && !!f.dims) + '</div>' + (f.dims || f.items.length ? '<div class="cgwrap">' + gridHtml(f) + '</div>' : '') + '</div></details>';
    };
    var ldet = loose.length ? '<details><summary>Loose items <span class="meta">&middot; ' + loose.length + ' item' + (loose.length === 1 ? '' : 's') + '</span></summary>' + itemTable(rowsHtml(loose, true)) + '</details>' : '';
    return '<h2>' + esc(name) + '</h2><p class="meta">' + fur.length + ' furniture pieces &middot; ' + cont.length + ' containers &middot; ' + stored + ' items stored &middot; ' + loose.length + ' loose items</p>' +
      (cont.length ? cont.map(cdet).join('') : '<p class="meta">No containers here.</p>') + ldet;
  }
  async function renderShelter() {
    var v = pageEl('shelter'), l = await list();
    if (SS.src !== 'live' && !l.some(function (m) { return m.id === SS.src; })) SS.src = 'live';
    var dir = SS.src === 'live' ? saveDir : j(j(bakDir, SS.src), 'data');
    var opts = '<option value="live">Current save folder</option>' + l.map(function (m) { return '<option value="' + esc(m.id) + '">' + esc((m.tag || 'Snapshot') + ' - ' + new Date(m.created).toLocaleString()) + '</option>'; }).join('');
    var head = '<h1>Shelter</h1><p class="sub">' + (SS.edit ? 'Edit mode: change condition and quantity, tick Remove, or add items to a container, then create an edited copy. Your live save is never touched: the copy appears under Snapshots, and you restore it when the game is closed. Adding items is new: test the copy in the game before relying on it.' : 'What your shelters store. Nothing here changes your save unless you create an edited copy in Edit mode.') + '</p><div class="bar"><select id="ssrc">' + opts + '</select><span class="sp"></span><button data-act="lv-toggle" title="Show the item lists with their edit fields next to the grids">' + (LV.shelter ? 'Hide list view' : 'List view') + '</button><input id="invq" type="search" placeholder="Search items">' + (SS.edit ? '<button data-act="sh-edit">Exit edit mode</button><button data-act="sh-apply" class="pri">Create edited copy</button>' : '<button data-act="sh-edit">Edit mode</button>') + '</div>';
    if (!(await fs.exists(dir))) { v.innerHTML = head + '<div class="empty">No save found yet. Start a new game once, then come back.</div>'; $('#ssrc').value = SS.src; return; }
    var shelters = [];
    try {
      for (var e of await fs.readDir(dir)) {
        if (!isTres(e)) continue;
        var t = Tres.parse(await fs.readTextFile(j(dir, e.name))), m = t.main(); if (!m || t.get(m, 'furnitures') === undefined) continue;
        CUR_FILE = e.name; EDIT_ON = SS.edit;
        shelters.push({ n: e.name.replace(/\.tres$/i, ''), h: shelterPageHtml(e.name.replace(/\.tres$/i, ''), t, m, extMap(t)) });
      }
    } catch (err) { v.innerHTML = head + '<div class="empty bad">Could not read the save: ' + esc(err) + '</div>'; $('#ssrc').value = SS.src; return; }
    shelters.sort(function (a, b) { return a.n.localeCompare(b.n); });
    v.innerHTML = head + iconHint() + '<div class="shlayout"><div class="shmain">' + (shelters.map(function (s) { return s.h; }).join('') || '<div class="empty">No shelter files found in this save.</div>') + '</div><div class="insp">' + (SS.edit ? INSP_EDIT : INSP_VIEW) + '</div></div>'; v.classList.toggle('lv', LV.shelter);
    $('#ssrc').value = SS.src;
    fillIcons();
    applyDefs();
    layoutGrids();
    if (SS.edit) fillItemList();
  }
  // the list of base-game items that can be added (read from the game files)
  async function fillItemList() {
    var dl = $('#itemlist'); if (!dl || !gameDir || IC.fail) return;
    try { await iconPack(); } catch (e) { return; }
    SS.items = {};
    var out = [];
    IC.pack.names.forEach(function (n) {
      var m = /^Items\/([^\/]+)\/[^\/]+\/([^\/]+)\.tres\.remap$/.exec(n);
      if (!m || m[1] === '0 - Shared' || m[1] === 'Physics' || n.indexOf('/Files/') !== -1) return;
      var label = Tres.itemName(m[2]) + ' (' + m[1] + ')';
      SS.items[label] = 'res://' + n.replace(/\.remap$/, ''); out.push(label);
    });
    out.sort(function (a, b) { return a.localeCompare(b); });
    dl.innerHTML = out.map(function (o) { return '<option value="' + esc(o) + '"></option>'; }).join('');
  }
  function resolveItem(text) {
    if (SS.items[text]) return SS.items[text];
    var low = text.toLowerCase(), hit = Object.keys(SS.items).filter(function (k) { return k.toLowerCase() === low || k.toLowerCase().indexOf(low + ' (') === 0; });
    return hit.length === 1 ? SS.items[hit[0]] : '';
  }
  async function addToContainer(bar) {
    var msg = bar.querySelector('.amsg'), say = function (s) { msg.textContent = s; };
    say('');
    if (!gameDir) return say('Set the game folder in Settings first: item sizes come from the game files.');
    try { await iconPack(); } catch (e) { return say('Could not read the game files: ' + niceErr(e)); }
    var path = resolveItem(bar.querySelector('.aitem').value.trim());
    if (!path) return say('Choose an item from the list.');
    var def = await Pck.itemDef(IC.pack, path);
    if (!def || !def.ok) return say('Could not read this item\'s definition from the game files.');
    var W = +bar.dataset.cw, H = +bar.dataset.ch, box = bar.parentNode, placed = [];
    var rows = Array.prototype.slice.call(box.querySelectorAll('tr[data-cid], tr.ea'));
    for (var tr of rows) {
      var sz0 = tr.dataset.path ? await sizeFor(tr.dataset.path) : null;
      if (!sz0 && tr.dataset.path && !/^res:\/\/Items\//i.test(tr.dataset.path)) { sz0 = await askModSize(tr.dataset.path); if (sz0) layoutGrids(); }
      if (!sz0) return say('This container holds an item whose size is unknown (for example from a mod), so nothing can be added safely.');
      var gx = parseFloat(tr.dataset.gx), gy = parseFloat(tr.dataset.gy);
      if (isNaN(gx) || isNaN(gy) || gx % CELL || gy % CELL) return say('Unexpected item layout in this container, so nothing is added.');
      var rot0 = tr.dataset.rot === '1';
      placed.push({ col: gx / CELL, row: gy / CELL, w: rot0 ? sz0[1] : sz0[0], h: rot0 ? sz0[0] : sz0[1] });
    }
    var prob = layoutProblem(W, H, placed); if (prob) return say(prob);
    // quantity: stackable items (ammo, money) = the total count, split into stacks of at most the stack limit;
    // everything else = how many separate items to add (a magazine is added full: its rounds are its "amount")
    var q = parseInt(bar.querySelector('.aqty').value, 10), amounts = [], cap, total, k;
    if (def.stackable) {
      total = isNaN(q) ? (def.defaultAmount || 1) : Math.max(1, q); cap = def.maxAmount > 0 ? def.maxAmount : total;
      while (total > 0) { var part = Math.min(cap, total); amounts.push(part); total -= part; }
    } else {
      var copies = isNaN(q) ? 1 : Math.max(1, q), each = def.showAmount ? (def.defaultAmount || def.maxAmount || 1) : def.defaultAmount;
      for (k = 0; k < copies; k++) amounts.push(each);
    }
    if (amounts.length > 60) return say('That would add ' + amounts.length + ' separate items; please add fewer at a time.');
    var spots = [];
    for (k = 0; k < amounts.length; k++) {
      var slot = findSlot(W, H, placed, def.size[0], def.size[1]);
      if (!slot) return say('No room: only ' + k + ' of ' + amounts.length + ' would fit in this container (each takes ' + def.size[0] + '\u00d7' + def.size[1] + ' cells). Nothing was added.');
      spots.push(slot); placed.push({ col: slot.col, row: slot.row, w: slot.rot ? def.size[1] : def.size[0], h: slot.rot ? def.size[0] : def.size[1] });
    }
    var cond = def.showCondition ? 100 : 0, nm = Tres.itemName(path), cat = catOf(path);
    var tb = box.querySelector('table.itm tbody'); if (!tb) return say('Nothing to add to.');
    var gridEl = box.querySelector('.cgrid');
    spots.forEach(function (slot, i) {
      var aid = 'a' + (++AID), amount = amounts[i];
      if (gridEl) { var ne = document.createElement('div'); ne.className = 'gi new'; ne.dataset.aid = aid; ne.title = nm; ne.innerHTML = '<img data-ic="' + esc(path) + '" alt="" hidden>' + glyph(cat); placeItem(ne, slot.col, slot.row, def.size, slot.rot); gridEl.appendChild(ne); }
      placeRow(tb, '<tr class="ea" data-aid="' + aid + '" data-file="' + esc(bar.dataset.file) + '" data-cid="' + esc(bar.dataset.cid) + '" data-cname="' + esc(bar.dataset.cname) + '" data-path="' + esc(path) + '" data-name="' + esc(nm) + '" data-gx="' + slot.col * CELL + '" data-gy="' + slot.row * CELL + '" data-rot="' + (slot.rot ? 1 : 0) + '" data-amt="' + amount + '" data-cond="' + cond + '" data-cat="' + esc(cat) + '" data-q="' + esc(nm.toLowerCase()) + '"><td><span class="ib"><img class="ico" data-ic="' + esc(path) + '" alt="" hidden>' + glyph(cat) + '</span>' + esc(nm) + ' <span class="tag man">NEW</span><div class="meta">column ' + (slot.col + 1) + ', row ' + (slot.row + 1) + (slot.rot ? ', rotated' : '') + '</div></td><td class="meta">' + esc(cat) + '</td><td>' + (def.showCondition ? cond + '%' : '\u2013') + '</td><td>' + (def.showAmount ? amount : '') + '</td><td><button data-act="sh-cancel">Cancel</button></td></tr>');
    });
    bar.querySelector('.aitem').value = ''; bar.querySelector('.aqty').value = '';
    say('Added ' + spots.length + (spots.length === 1 ? ' item' : ' items') + (def.stackable && spots.length > 1 ? ' (stacks of up to ' + cap + ')' : '') + '. It is saved only when you create the edited copy.');
    fillIcons();
  }
  var QOPTS = '';
  function questOptions() {
    if (!QOPTS) {
      QOPTS = '<option value="">Task rewards...</option>' + Object.keys(QUEST_STEMS).map(function (k) {
        return '<optgroup label="' + esc(TRADERS[k][0]) + '">' + questsOf(k).map(function (q, i) { return '<option value="' + k + '|' + i + '">' + esc(q.name) + '</option>'; }).join('') + '</optgroup>';
      }).join('');
    }
    return QOPTS;
  }
  // Adds every reward item of one trader task to this container (all or nothing). Furniture rewards cannot go in a container and are skipped.
  async function addRewards(bar) {
    var msg = bar.querySelector('.amsg'), say = function (s) { msg.textContent = s; };
    say('');
    var sv = bar.querySelector('.atask').value; if (!sv) return say('Choose a task first.');
    if (!gameDir) return say('Set the game folder in Settings first: rewards and item sizes come from the game files.');
    try { await iconPack(); } catch (e) { return say('Could not read the game files: ' + niceErr(e)); }
    var parts = sv.split('|'), q = questsOf(parts[0])[+parts[1]], td = await Pck.taskDef(IC.pack, q.path);
    if (!td || !td.ok) return say('Could not read this task from the game files.');
    var rew = td.receive.filter(function (p) { return /^res:\/\/Items\//i.test(p); }), skipped = td.receive.length - rew.length;
    if (!rew.length) return say('"' + q.name + '" only rewards furniture, which cannot be put in a container.');
    var W = +bar.dataset.cw, H = +bar.dataset.ch, box = bar.parentNode, placed = [];
    var rows = Array.prototype.slice.call(box.querySelectorAll('tr[data-cid], tr.ea'));
    for (var tr of rows) {
      var sz0 = tr.dataset.path ? await sizeFor(tr.dataset.path) : null;
      if (!sz0 && tr.dataset.path && !/^res:\/\/Items\//i.test(tr.dataset.path)) { sz0 = await askModSize(tr.dataset.path); if (sz0) layoutGrids(); }
      if (!sz0) return say('This container holds an item whose size is unknown (for example from a mod), so nothing can be added safely.');
      var gx = parseFloat(tr.dataset.gx), gy = parseFloat(tr.dataset.gy);
      if (isNaN(gx) || isNaN(gy) || gx % CELL || gy % CELL) return say('Unexpected item layout in this container, so nothing is added.');
      var rot0 = tr.dataset.rot === '1';
      placed.push({ col: gx / CELL, row: gy / CELL, w: rot0 ? sz0[1] : sz0[0], h: rot0 ? sz0[0] : sz0[1] });
    }
    var prob = layoutProblem(W, H, placed); if (prob) return say(prob);
    var plan = [];
    for (var i = 0; i < rew.length; i++) {
      var def = await Pck.itemDef(IC.pack, rew[i]);
      if (!def || !def.ok) return say('Could not read the definition of ' + Tres.itemName(rew[i]) + ' from the game files. Nothing was added.');
      var slot = findSlot(W, H, placed, def.size[0], def.size[1]);
      if (!slot) return say('No room: only ' + i + ' of ' + rew.length + ' reward items would fit in this container. Nothing was added.');
      placed.push({ col: slot.col, row: slot.row, w: slot.rot ? def.size[1] : def.size[0], h: slot.rot ? def.size[0] : def.size[1] });
      var amount = def.stackable ? Math.min(def.defaultAmount || 1, def.maxAmount > 0 ? def.maxAmount : (def.defaultAmount || 1)) : (def.showAmount ? (def.defaultAmount || def.maxAmount || 1) : def.defaultAmount);
      plan.push({ path: rew[i], def: def, slot: slot, amount: amount });
    }
    var tb = box.querySelector('table.itm tbody'); if (!tb) return say('Nothing to add to.');
    var gridEl = box.querySelector('.cgrid');
    plan.forEach(function (e) { addNewRow(bar, tb, gridEl, e.path, e.def, e.slot, e.amount); });
    bar.querySelector('.atask').value = '';
    say('Added ' + plan.length + (plan.length === 1 ? ' reward item' : ' reward items') + ' for "' + q.name + '"' + (skipped ? ' (' + skipped + ' furniture reward' + (skipped === 1 ? '' : 's') + ' skipped)' : '') + '. It is saved only when you create the edited copy.');
    fillIcons();
  }
  // one new item: its grid box and its table row (same markup as addToContainer)
  function addNewRow(bar, tb, gridEl, path, def, slot, amount) {
    var aid = 'a' + (++AID), cond = def.showCondition ? 100 : 0, nm = Tres.itemName(path), cat = catOf(path);
    if (gridEl) { var ne = document.createElement('div'); ne.className = 'gi new'; ne.dataset.aid = aid; ne.title = nm; ne.innerHTML = '<img data-ic="' + esc(path) + '" alt="" hidden>' + glyph(cat); placeItem(ne, slot.col, slot.row, def.size, slot.rot); gridEl.appendChild(ne); }
    placeRow(tb, '<tr class="ea" data-aid="' + aid + '" data-file="' + esc(bar.dataset.file) + '" data-cid="' + esc(bar.dataset.cid) + '" data-cname="' + esc(bar.dataset.cname) + '" data-path="' + esc(path) + '" data-name="' + esc(nm) + '" data-gx="' + slot.col * CELL + '" data-gy="' + slot.row * CELL + '" data-rot="' + (slot.rot ? 1 : 0) + '" data-amt="' + amount + '" data-cond="' + cond + '" data-cat="' + esc(cat) + '" data-q="' + esc(nm.toLowerCase()) + '"><td><span class="ib"><img class="ico" data-ic="' + esc(path) + '" alt="" hidden>' + glyph(cat) + '</span>' + esc(nm) + ' <span class="tag man">NEW</span><div class="meta">column ' + (slot.col + 1) + ', row ' + (slot.row + 1) + (slot.rot ? ', rotated' : '') + '</div></td><td class="meta">' + esc(cat) + '</td><td>' + (def.showCondition ? cond + '%' : '\u2013') + '</td><td>' + (def.showAmount ? amount : '') + '</td><td><button data-act="sh-cancel">Cancel</button></td></tr>');
  }
  function collectAdds(sc) {
    return Array.prototype.slice.call(document.querySelectorAll((sc || '#view') + ' tr.ea')).map(function (tr) { var d = tr.dataset; return { add: true, file: d.file, cid: d.cid, cname: d.cname, path: d.path, name: d.name, amount: +d.amt, cond: +d.cond, col: +d.gx / CELL, row: +d.gy / CELL, rot: d.rot === '1', slot: d.slot || '', att: (d.att || '').split('|').filter(Boolean) }; });
  }
  // a new SlotData entry, written in the game's own property order
  function addSlot(t, e, before) {
    var sc = t.extFor('res://Scripts/SlotData.gd', 'Script'), ic = t.extFor('res://Scripts/ItemData.gd', 'Script'), it = t.extFor(e.path, 'Resource');
    return t.addSub([['script', 'ExtResource("' + sc + '")'], ['itemData', 'ExtResource("' + it + '")'], ['nested', 'Array[ExtResource("' + ic + '")]([])'], ['storage', 'Array[ExtResource("' + sc + '")]([])'],
      ['condition', String(e.cond)], ['amount', String(e.amount)], ['position', '0'], ['mode', '1'], ['zoom', '1'], ['chamber', 'false'], ['casing', 'false'], ['state', '""'],
      ['gridPosition', 'Vector2(' + e.col * CELL + ', ' + e.row * CELL + ')'], ['gridRotated', e.rot ? 'true' : 'false'], ['slot', '"' + (e.slot || '') + '"']], 'Resource', before);
  }

  /* ---------- inventory editing (always written to a new snapshot) ---------- */
  function collectInvEdits(sc) {
    var out = [];
    document.querySelectorAll((sc || '#view') + ' tr.er').forEach(function (tr) {
      var d = tr.dataset, c = tr.querySelector('[data-w="c"]'), a = tr.querySelector('[data-w="a"]'), r = tr.querySelector('[data-w="r"]');
      if (r && r.checked) { out.push({ file: d.file, rid: d.rid, sid: d.sid, name: d.name, remove: true, eq: !!d.eq }); return; }
      var e = { file: d.file, sid: d.sid, name: d.name };
      if (c && c.value !== d.ci) { var cv = parseInt(c.value, 10); if (isNaN(cv) || cv < 0 || cv > 100) throw new Error(d.name + ': condition must be 0 to 100'); e.cond = cv; e.condFrom = d.ci; }
      if (a && a.value !== d.ai) { var av = parseInt(a.value, 10); var amax = +a.max > 0 ? +a.max : Infinity; var amin = d.wp ? 0 : 1; if (isNaN(av) || av < amin || av > amax) throw new Error(d.name + ': quantity must be ' + amin + (amax < Infinity ? ' to ' + amax : ' or more')); e.amt = av; e.amtFrom = d.ai; }
      if (e.cond !== undefined || e.amt !== undefined) out.push(e);
    });
    return out;
  }
  /* ---------- weapon workbench: magazine, attachments and chamber of a weapon row (what fits comes from the game's own item data) ---------- */
  async function sameAmmoMags(ammo) {
    if (!ammo) return [];
    if (!IC.mags) {
      IC.mags = [];
      var names = IC.pack.names.filter(function (n) { return /^Items\/Weapons\/[^\/]+\/[^\/]*(Magazine|Drum)[^\/]*\.tres\.remap$/i.test(n); });
      for (var n of names) { var p = 'res://' + n.replace(/\.remap$/, ''), d = await Pck.itemDef(IC.pack, p); if (d && d.ok && d.subtype === 'Magazine') IC.mags.push({ path: p, def: d }); }
    }
    return IC.mags.filter(function (m) { return m.def.compatible.indexOf(ammo) !== -1; });
  }
  var WB_FIXED = ['Magazine', 'Optic', 'Muzzle', 'Laser'];
  function groupOf(d, wd) { var g = d.subtype || (d.type !== 'Weapon' ? d.type : ''); return !g || (wd.type === 'Weapon' && WB_FIXED.indexOf(g) === -1) ? '' : g; }
  // options per group from the item's own "compatible" list (plus, if enabled, magazines of the same ammo); cur = paths already in it
  async function compatGroups(wd, cur) {
    var groups = {}, seen = {}, curBy = {}, p, d, g;
    var add = async function (path, same) { if (seen[path]) return; var dd = await Pck.itemDef(IC.pack, path); if (!dd || !dd.ok) return; var gg = groupOf(dd, wd); if (!gg) return; seen[path] = true; (groups[gg] = groups[gg] || []).push({ path: path, d: dd, same: same }); };
    for (p of wd.compatible) await add(p, false);
    if (XMAGS && wd.type === 'Weapon') for (var m of await sameAmmoMags(wd.ammo)) await add(m.path, true);
    for (p of cur || []) {
      d = await Pck.itemDef(IC.pack, p); if (!d || !d.ok) continue; g = groupOf(d, wd); if (!g) continue;
      (curBy[g] = curBy[g] || []).push(p);
      if (!seen[p]) { seen[p] = true; (groups[g] = groups[g] || []).push({ path: p, d: d, same: false, off: true }); }
    }
    var names = Object.keys(groups).sort(function (a, b) { var ia = WB_FIXED.indexOf(a), ib = WB_FIXED.indexOf(b); return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b); });
    return { groups: groups, curBy: curBy, names: names };
  }
  function optLabel(c, o) { return Tres.itemName(o.path) + (c === 'Magazine' && o.d.maxAmount ? ' (' + o.d.maxAmount + ' rounds)' : '') + (o.same ? ' - same ammo' : '') + (o.off ? ' - not on the game\'s list' : ''); }
  async function wbHtml(tr) {
    var wd = await Pck.itemDef(IC.pack, tr.dataset.path);
    if (!wd || !wd.ok) return null;
    var isW = wd.type === 'Weapon', cur = (tr.dataset.nested || '').split('|').filter(Boolean), cg = await compatGroups(wd, cur), hasMag = !!cg.groups.Magazine;
    // the build screen: the item in the middle, one box per fitting around it (the real <select> sits invisibly over its box)
    var POS = ['top', 'right', 'bottom', 'left', 'tl', 'tr', 'bl', 'br'], prefer = { Optic: 'top', Muzzle: 'right', Magazine: 'bottom', Laser: 'left' }, slots = [], taken = {};
    cg.names.forEach(function (c) { var inits = cg.curBy[c] && cg.curBy[c].length ? cg.curBy[c] : ['']; inits.forEach(function (init) { slots.push({ c: c, init: init, pos: '' }); }); });
    slots.forEach(function (sl) { if (prefer[sl.c] && !taken[prefer[sl.c]]) { sl.pos = prefer[sl.c]; taken[sl.pos] = true; } });
    slots.forEach(function (sl) { if (!sl.pos) { var free = POS.filter(function (x) { return !taken[x]; })[0]; sl.pos = free || 'br'; taken[sl.pos] = true; } });
    var boxes = slots.map(function (sl) {
      var c = sl.c;
      return '<div class="wslot wp-' + sl.pos + (sl.init ? ' has' : '') + '"><span class="wsl">' + esc(c) + '</span><span class="wsi">' + (sl.init ? '<img data-ic="' + esc(sl.init) + '" alt="" hidden>' : '') + '</span><span class="wsn">' + (sl.init ? esc(Tres.itemName(sl.init)) : 'None') + '</span>' +
        '<select data-w="wopt" data-cat="' + esc(c) + '" data-init="' + esc(sl.init) + '" title="' + esc(c) + '"><option value="">None</option>' + cg.groups[c].map(function (o) {
          return '<option value="' + esc(o.path) + '" data-max="' + (o.d.maxAmount || 0) + '"' + (o.path === sl.init ? ' selected' : '') + '>' + esc(optLabel(c, o)) + '</option>';
        }).join('') + '</select></div>';
    }).join('');
    if (!boxes && !isW) return '<tr class="wrow"><td colspan="5"><div class="wmodal"><button class="wclose" data-act="wp-close" title="Close (Esc)">&times;</button><div class="meta">Nothing to choose for ' + esc(Tres.itemName(tr.dataset.path)) + ' in the game data.</div></div></td></tr>';
    return '<tr class="wrow" data-wmax="' + wd.magazineSize + '"><td colspan="5"><div class="wmodal"><button class="wclose" data-act="wp-close" title="Close (Esc)">&times;</button><h4>Edit build &mdash; ' + esc(Tres.itemName(tr.dataset.path)) + '</h4><div class="meta"><span class="tag man" title="New and still being tested. Keep your original snapshot and test the edited copy.">Experimental</span> ' + esc(Tres.itemName(tr.dataset.path)) + (isW ? ' &middot; ammo: ' + (wd.ammo ? esc(Tres.itemName(wd.ammo)) : 'unknown') + (hasMag ? '' : ' &middot; built-in magazine, ' + wd.magazineSize + ' rounds') : '') + '</div>' +
      '<div class="wbuild"><div class="wcenter"><img data-ic="' + esc(tr.dataset.path) + '" alt="" hidden><span class="wcn">' + esc(Tres.itemName(tr.dataset.path)) + '</span></div>' + boxes + '</div>' +
      (isW ? '<div class="fgrid"><label class="fld chk"><input type="checkbox" data-w="wch"' + (tr.dataset.chi === '1' ? ' checked' : '') + '> Round in chamber</label></div>' : '') +
      '<div class="meta">Click a box to choose a part. ' + (isW ? 'Rounds loaded: use the Qty box in the item row (it follows the magazine size). ' : '') + 'Choices are what the game lists as compatible' + (isW && XMAGS ? ', plus other magazines for the same ammo' : '') + '.</div></div></td></tr>';
  }
  // refreshes a box of the build screen after its choice changed
  function wsUpdate(sel) {
    var box = sel.closest('.wslot'); if (!box) return;
    var v = sel.value, wsi = box.querySelector('.wsi'), im = wsi.querySelector('img');
    box.classList.toggle('has', !!v); box.classList.toggle('chg', v !== sel.dataset.init);
    box.querySelector('.wsn').textContent = v ? Tres.itemName(v) : 'None';
    if (v) { if (!im) { wsi.innerHTML = '<img alt="" hidden>'; im = wsi.querySelector('img'); } im.dataset.ic = v; im.hidden = true; fillIcons(); }
    else if (im) im.remove();
  }
  // keeps the Qty box (rounds loaded) in line with the chosen magazine
  function wbSync(w, initial) {
    var tr = w.previousElementSibling, qi = tr && tr.querySelector('[data-w="a"]'); if (!qi) return;
    var ms = w.querySelector('select[data-cat="Magazine"]');
    if (ms) {
      var max = +ms.options[ms.selectedIndex].dataset.max || 0; qi.max = max || '';
      if (!initial) { if (!ms.value) qi.value = 0; else { var v = parseInt(qi.value, 10); if (isNaN(v) || v === 0 || (max && v > max)) qi.value = max || v || 0; } }
    } else if (+w.dataset.wmax) qi.max = w.dataset.wmax;
  }
  function collectWeaponEdits(sc) {
    var out = [];
    document.querySelectorAll((sc || '#view') + ' tr.wrow').forEach(function (w) {
      var tr = w.previousElementSibling; if (!tr || !tr.classList.contains('er')) return;
      var rm = tr.querySelector('[data-w="r"]'); if (rm && rm.checked) return;
      var e = { file: tr.dataset.file, sid: tr.dataset.sid, name: tr.dataset.name, weapon: true, attOut: [], attIn: [] }, ch = w.querySelector('[data-w="wch"]');
      w.querySelectorAll('select[data-w="wopt"]').forEach(function (sel) { if (sel.value !== sel.dataset.init) { if (sel.dataset.init) e.attOut.push(sel.dataset.init); if (sel.value) e.attIn.push(sel.value); } });
      if (ch && (ch.checked ? '1' : '0') !== tr.dataset.chi) e.chamber = ch.checked;
      if (tr.dataset.rig === '1' && (e.attOut.length || e.attIn.length)) { var nowPlated = Array.prototype.some.call(w.querySelectorAll('select[data-w="wopt"]'), function (x) { return !!x.value; }); e.cond = nowPlated ? 100 : 0; }
      if (e.attOut.length || e.attIn.length || e.chamber !== undefined) out.push(e);
    });
    return out;
  }
  function weaponLine(e) {
    return e.name + ': ' + [].concat(e.attOut.map(function (p) { return 'remove ' + Tres.itemName(p); }), e.attIn.map(function (p) { return 'add ' + Tres.itemName(p); }), e.chamber === undefined ? [] : ['chamber ' + (e.chamber ? 'on' : 'off')], e.cond === undefined ? [] : ['plate condition ' + e.cond + '%']).join(', ');
  }
  var numLike = function (raw, v) { return /\./.test(String(raw)) ? Number(v).toFixed(1) : String(v); };
  // builds the new file texts in memory and checks them; nothing is written yet
  async function planInv(src, edits, rd) {
    var byFile = {}, out = {}, removed = 0, edited = 0, added = 0;
    edits.forEach(function (e) { (byFile[e.file] = byFile[e.file] || []).push(e); });
    for (var f of Object.keys(byFile)) {
      var t = Tres.parse(rd ? await rd(f) : await fs.readTextFile(j(src, f))), gone = {}, ls = null, addedHere = false;
      ls = t.loadSteps();
      var usedBefore = {}; t.ext().forEach(function (b) { if (b.attrs.type === 'Resource' && t.usesOf(b.attrs.id) > 0) usedBefore[b.attrs.id] = true; });
      byFile[f].filter(function (e) { return !e.remove && !e.add && !e.weapon; }).forEach(function (e) {
        var b = t.subById(e.sid); if (!b) throw new Error(e.name + ' was not found in ' + f + ' (the save may have changed since this page was loaded)');
        if (e.cond !== undefined) t.set(b, 'condition', numLike(t.get(b, 'condition'), e.cond));
        if (e.amt !== undefined) t.set(b, 'amount', numLike(t.get(b, 'amount'), e.amt));
        edited++;
      });
      byFile[f].filter(function (e) { return e.remove; }).forEach(function (e) {
        if (gone[e.rid]) return;
        var r = t.removeSlot(e.rid); if (!r.length) throw new Error(e.name + ' was not found in ' + f + ' (the save may have changed since this page was loaded)');
        r.forEach(function (id) { gone[id] = true; }); removed += r.length;
      });
      byFile[f].filter(function (e) { return e.weapon; }).forEach(function (e) {
        if (gone[e.sid]) return;
        var b = t.subById(e.sid); if (!b) throw new Error(e.name + ' was not found in ' + f + ' (the save may have changed since this page was loaded)');
        var nestedIds = function () { return ids(inner(t.get(b, 'nested')), 'ExtResource'); };
        (e.attOut || []).forEach(function (path) {
          var em = extMap(t), have = nestedIds();
          Object.keys(em).filter(function (id) { return em[id] === path && have.indexOf(id) !== -1; }).forEach(function (id) { t.removeRef(b, 'nested', 'ExtResource("' + id + '")'); t.dropExtIfUnused(id); });
        });
        (e.attIn || []).forEach(function (path) {
          var id = t.extFor(path, 'Resource');
          if (nestedIds().indexOf(id) === -1) t.appendRef(b, 'nested', 'ExtResource("' + id + '")');
        });
        if (e.chamber !== undefined) t.set(b, 'chamber', e.chamber ? 'true' : 'false');
        if (e.cond !== undefined) t.set(b, 'condition', numLike(t.get(b, 'condition'), e.cond));
        edited++;
      });
      byFile[f].filter(function (e) { return e.add; }).forEach(function (e) {
        var toInv = e.cid === INV_CID, toEq = e.cid === EQ_CID, toMain = toInv || toEq, cb = toMain ? t.main() : t.subById(e.cid), key = toInv ? 'inventory' : toEq ? 'equipment' : 'storage';
        if (!cb || gone[e.cid] || (toMain && t.get(cb, key) === undefined)) throw new Error('The container "' + e.cname + '" was not found in ' + f + ' (the save may have changed since this page was loaded)');
        var nid = addSlot(t, e, cb);
        (e.att || []).forEach(function (ap) { t.appendRef(t.subById(nid), 'nested', 'ExtResource("' + t.extFor(ap, 'Resource') + '")'); });
        if (t.get(cb, key) === undefined) t.insert(cb, 'storage', 'Array[ExtResource("' + t.extFor('res://Scripts/SlotData.gd', 'Script') + '")]([SubResource("' + nid + '")])');
        else t.appendRef(cb, key, 'SubResource("' + nid + '")');
        added++; addedHere = true;
      });
      t.ext().slice().forEach(function (b) { if (usedBefore[b.attrs.id] && t.usesOf(b.attrs.id) === 0) t.dropExtIfUnused(b.attrs.id); });   // items nothing refers to any more
      t.setLoadSteps(ls);
      if (addedHere) { var ord = t.checkOrder(); if (ord.length) throw new Error(f + ': ' + ord[0]); }
      var bad = t.validate(); if (bad.length) throw new Error(f + ': ' + bad[0]);
      out[f] = t.serialize();
    }
    return { out: out, removed: removed, edited: edited, added: added };
  }

  /* ---------- traders (read-only) ---------- */
  var TS = { src: 'live', edit: false, sel: '' };
  // task totals from the wiki (roadtovostok.wiki/traders); unknown traders just show the completed count
  var TRADERS = { generalist: ['Generalist', 10, 100], doctor: ['Doctor', 10, 200], gunsmith: ['Gunsmith', 10, 300], driver: ['Driver', 10, 200], hunter: ['Hunter', 10, 200] };
  // the 10 tasks of every trader, in the game's own order (file names under res://Traders/<Trader>/Tasks/NN_<stem>.tres)
  var QUEST_STEMS = {
    generalist: 'Prime_Time Bad_Habits Backpains Coffee_Reserve Sweaty_Business Handyman Six_Pack Old_Friend Road_Trip Homemade',
    doctor: 'Nasty_Draft Steady_Hands Bookworm Dice_Master Night_Surgery Infections Hypovolemia Mouth_Organ Patient_Report Substance',
    gunsmith: 'Bloodsuckers Warm_Meal Nordic_Trade Big_Blades Ammo_Delivery Weapon_Delivery Medic Home_Collection Everymans_Right Hitman',
    driver: 'Cravings Mandatory_Sleep Mental_Health Nordic_Pine Getting_Hot Bangers Black_Market Historic_Vehicle Missing_Suitcase Only_Zeros',
    hunter: 'Cold_Hands Wooden_Figurines Baked_Potato Moose_Season Dream_Bream Leather_Goods Friendly_Fire Crooked_Barrel Better_Scope Bald_Spot'
  };
  var QUEST_NAMES = { Everymans_Right: "Everyman's Right" };   // the save stores the name with its apostrophe
  var QSTATE = { none: 'Not started', prog: 'In progress', done: 'Completed' };
  function questsOf(k) {
    var folder = TRADERS[k] && TRADERS[k][0], stems = QUEST_STEMS[k];
    if (!folder || !stems) return null;
    return stems.split(' ').map(function (s, i) { return { name: QUEST_NAMES[s] || s.replace(/_/g, ' '), path: 'res://Traders/' + folder + '/Tasks/' + (i < 9 ? '0' : '') + (i + 1) + '_' + s + '.tres' }; });
  }
  function trPic(name, big) { return '<span class="tb' + (big ? ' lg' : '') + '"><img class="tpic" data-ic="res://Traders/' + esc(name) + '/' + esc(name) + '.tres" alt="" hidden>' + glyph('trader') + '</span>'; }
  function trTax(meta, n, total) { return Math.round(meta[2] * Math.max(0, 1 - n / total)); }
  function questCardHtml(k, meta, done, np, edit, shown) {
    var qs = questsOf(k), n = 0;
    var rows = qs.map(function (q, i) {
      var st = done.indexOf(q.name) !== -1 ? 'done' : np[q.path] ? 'prog' : 'none';
      if (st === 'done') n++;
      var ctl = edit
        ? '<select data-w="q" data-k="' + k + '" data-i="' + i + '" data-init="' + st + '" aria-label="' + esc(q.name) + '" hidden>' + ['none', 'prog', 'done'].map(function (v) { return '<option value="' + v + '"' + (v === st ? ' selected' : '') + '>' + QSTATE[v] + '</option>'; }).join('') + '</select>' +
          '<div class="seg" role="group" aria-label="' + esc(q.name) + ' state">' + ['none', 'prog', 'done'].map(function (v) { return '<button type="button" class="sg' + (v === st ? ' on' : '') + '" data-act="tr-seg" data-v="' + v + '">' + QSTATE[v] + '</button>'; }).join('') + '</div>'
        : '<span class="qs qs-' + st + '">' + QSTATE[st] + '</span>';
      return '<div class="trow" data-st="' + st + '"><span class="tn">' + pad(i + 1) + '</span><div class="tt"><b>' + esc(q.name) + '</b><div class="qi" data-qp="' + esc(q.path) + '"></div></div><div class="tctl">' + ctl + '</div></div>';
    }).join('');
    var other = done.filter(function (x) { return !qs.some(function (q) { return q.name === x; }); });
    return '<div class="trp" data-k="' + k + '"' + (shown ? '' : ' hidden') + '><div class="trh">' + trPic(meta[0], true) +
      '<div class="trm"><h2>' + esc(meta[0]) + '</h2><div class="trs"><span class="tag qcount' + (n ? ' man' : '') + '">' + n + ' / ' + qs.length + ' tasks done</span><span class="tag qtax" data-base="' + meta[2] + '" title="Base tax ' + meta[2] + '%, minus a tenth of it for every task done.">Tax ' + trTax(meta, n, qs.length) + '%</span></div>' +
      '<progress class="trpr" max="' + qs.length + '" value="' + n + '"></progress></div>' +
      (edit ? '<div class="qbar"><button data-act="tr-all" data-to="done">Complete all</button><button data-act="tr-all" data-to="none">Reset all</button></div>' : '') + '</div>' +
      (edit ? '<p class="meta trnote">Completing a task here does not hand out its reward: add rewards with Task rewards on the Inventory or Shelter page.</p>' : '') +
      '<div class="tlist">' + rows + '</div>' +
      (other.length ? '<div class="meta">Other completed tasks (not editable here): ' + other.map(esc).join(', ') + '</div>' : '') +
      '<h3>Can stock</h3><div class="stk" data-k="' + k + '"><div class="meta">Loading...</div></div></div>';
  }
  function qUpdate(p) {
    if (!p) return;
    var sel = p.querySelectorAll('select[data-w="q"]'), n = 0, total = sel.length, k = p.dataset.k, meta = TRADERS[k];
    sel.forEach(function (s) {
      var row = s.closest('.trow'); if (s.value === 'done') n++;
      row.dataset.st = s.value; row.classList.toggle('chg', s.value !== s.dataset.init);
      row.querySelectorAll('.sg').forEach(function (b) { b.classList.toggle('on', b.dataset.v === s.value); });
    });
    var c = p.querySelector('.qcount'), x = p.querySelector('.qtax'), pr = p.querySelector('progress'), tax = meta ? trTax(meta, n, total) : 0;
    c.textContent = n + ' / ' + total + ' tasks done'; c.classList.toggle('man', n > 0);
    if (x) x.textContent = 'Tax ' + tax + '%';
    if (pr) pr.value = n;
    var t = document.querySelector('#pg-traders .ttile[data-k="' + k + '"]');
    if (t) { t.querySelector('.tc').textContent = n + ' / ' + total + ' done'; t.querySelector('.tx').textContent = 'Tax ' + tax + '%'; }
  }
  function collectQuestEdits() {
    var out = [];
    document.querySelectorAll('#view select[data-w="q"]').forEach(function (s) {
      if (s.value === s.dataset.init) return;
      var q = questsOf(s.dataset.k)[+s.dataset.i];
      out.push({ k: s.dataset.k, name: q.name, path: q.path, from: s.dataset.init, to: s.value });
    });
    return out;
  }
  // Applies the task changes to Traders.tres: completed = name in the trader's list, in progress = a TaskData note, not started = neither.
  async function planTraders(src, edits, rd) {
    var f = j(src, 'Traders.tres');
    if (!(await fs.exists(f))) throw new Error('There is no Traders.tres in this save.');
    var t = Tres.parse(rd ? await rd('Traders.tres') : await fs.readTextFile(f)), m = t.main(), ls = t.loadSteps(), STR = /"(?:[^"\\]|\\.)*"/g;
    if (!m || t.get(m, 'taskNotes') === undefined) throw new Error('Traders.tres has an unexpected layout (no taskNotes).');
    edits.forEach(function (e) {
      var raw = t.get(m, e.k);
      if (raw === undefined || raw.indexOf('Array[String]([') !== 0) throw new Error('Unexpected format for ' + e.k + ' in Traders.tres.');
      var toks = inner(raw).match(STR) || [], q = '"' + e.name.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"', had = toks.indexOf(q) !== -1;
      if (e.to === 'done' && !had) { toks.push(q); t.set(m, e.k, 'Array[String]([' + toks.join(', ') + '])'); }
      else if (e.to !== 'done' && had) { toks = toks.filter(function (x) { return x !== q; }); t.set(m, e.k, 'Array[String]([' + toks.join(', ') + '])'); }
      var em = extMap(t), pids = Object.keys(em).filter(function (id) { return em[id] === e.path; }), inNotes = ids(inner(t.get(m, 'taskNotes')), 'ExtResource');
      var hasNote = pids.some(function (id) { return inNotes.indexOf(id) !== -1; });
      if (e.to === 'prog' && !hasNote) t.appendRef(m, 'taskNotes', 'ExtResource("' + t.extFor(e.path, 'Resource') + '")');
      else if (e.to !== 'prog' && hasNote) pids.forEach(function (id) { t.removeRef(m, 'taskNotes', 'ExtResource("' + id + '")'); t.dropExtIfUnused(id); });
    });
    t.setLoadSteps(ls);
    var problems = t.validate().concat(t.checkOrder());
    if (problems.length) throw new Error('The edited Traders.tres failed its check: ' + problems[0]);
    return { out: { 'Traders.tres': t.serialize() } };
  }
  function tradersHtml(t, edit) {
    var m = t.main(), ext = extMap(t), np = {};
    ids(inner(t.get(m, 'taskNotes')), 'ExtResource').forEach(function (i) { np[ext[i] || ''] = true; });
    var known = t.keys(m).filter(function (k) { return QUEST_STEMS[k] && TRADERS[k]; });
    if (known.indexOf(TS.sel) === -1) TS.sel = known[0] || '';
    var done = function (k) { return (inner(t.get(m, k)).match(/"(?:[^"\\]|\\.)*"/g) || []).map(function (s) { return s.slice(1, -1); }); };
    var tiles = known.map(function (k) {
      var meta = TRADERS[k], d = done(k), n = questsOf(k).filter(function (q) { return d.indexOf(q.name) !== -1; }).length, tot = meta[1];
      return '<button type="button" class="ttile' + (k === TS.sel ? ' on' : '') + '" data-act="tr-pick" data-k="' + k + '">' + trPic(meta[0]) + '<span class="tnm">' + esc(meta[0]) + '</span><span class="tmeta tc">' + n + ' / ' + tot + ' done</span><span class="tmeta tx">Tax ' + trTax(meta, n, tot) + '%</span></button>';
    }).join('');
    var panels = known.map(function (k) { return questCardHtml(k, TRADERS[k], done(k), np, edit, k === TS.sel); }).join('');
    return '<p class="meta" id="trnote" hidden></p>' + (known.length ? '<div class="ttiles">' + tiles + '</div>' + panels : '') + tradersOther(t, edit);
  }
  function tradersOther(t, edit) {
    var m = t.main(), ext = extMap(t), notes = {}, np = {};
    ids(inner(t.get(m, 'taskNotes')), 'ExtResource').forEach(function (i) {
      np[ext[i] || ''] = true;
      var p = ext[i] || '', mm = /Traders\/([^\/]+)\//.exec(p), k = mm ? mm[1].toLowerCase() : 'other';
      (notes[k] = notes[k] || []).push(p.split('/').pop().replace(/\.tres$/i, '').replace(/^\d+_/, '').replace(/_/g, ' '));
    });
    return t.keys(m).filter(function (k) { return k !== 'script' && k !== 'taskNotes' && k !== 'grandma' && !QUEST_STEMS[k]; }).map(function (k) {
      var done = (inner(t.get(m, k)).match(/"(?:[^"\\]|\\.)*"/g) || []).map(function (s) { return s.slice(1, -1); });
      var meta = TRADERS[k] || [k.charAt(0).toUpperCase() + k.slice(1), null], act = notes[k] || [];
      var pic = '<span class="tb"><img class="tpic" data-ic="res://Traders/' + esc(meta[0]) + '/' + esc(meta[0]) + '.tres" alt="" hidden>' + glyph('trader') + '</span>';
      return '<div class="snap"><div class="tw">' + pic + '<div><h4>' + esc(meta[0]) + '<span class="tag ' + (done.length ? 'man' : '') + '">' + done.length + (meta[1] ? ' / ' + meta[1] : '') + ' tasks done</span>' + (meta[2] ? '<span class="tag" title="Base tax, minus a tenth of it for every task done.">Tax ' + Math.round(meta[2] * Math.max(0, 1 - done.length / meta[1])) + '%</span>' : '') + '</h4>' +
        (done.length ? '<div class="meta wi">' + done.map(esc).join(' &middot; ') + '</div>' : '<div class="meta">No tasks completed yet.</div>') +
        (act.length ? '<div class="meta">In progress: ' + act.map(esc).join(', ') + '</div>' : '') + '</div></div></div>';
    }).join('');
  }
  // Bundled fallback: what each trader can stock (item file name : value : rarity C/R/L), from the 0.2.3.1 loot tables. Only used when the game files give no loot table.
  var STOCK_FB = {
    generalist: 'Ammo_12x70:200:C Ammo_45ACP:250:C Ammo_762x39:350:C Ammo_9x18:200:C Ammo_9x19:250:C AKM_Magazine:110:C AKS_74U_Magazine:100:C Colt_1911_Magazine:75:C Jatimatic_Magazine:50:R MP5_Magazine:60:C Makarov_Magazine:25:C PBS:330:R EXPS:850:R Kobra:350:R Micro:450:R PRO:650:R PU:400:R Backpack_Nomad:100:C Duffel_Retro:75:C Boots_Combat:160:C Gloves_Leather:25:C Gloves_Work:15:C Hat_Mosquito:20:C Hoodie_Gray:25:C Jacket_M62:125:C Jacket_Winter_Blue:40:C Jacket_Winter_Red:40:C Jeans_Black:30:C Pants_Hiking:40:C Windbreaker_Black:35:C Windbreaker_Green:35:C Canned_Meat:150:C Canned_Meatballs:100:C Canned_Peaches:120:C Canned_Pear:120:C Canned_Peas:80:C Canned_Pineapple:120:C Canned_Tomatoes:80:C Canned_Tuna:60:C Crackers:50:C Juice_Orange:50:C Juice_Pear:50:C Juice_Raspberry:50:C Peanuts:40:C Soda_Lemon:100:R Hotplate:250:C Narva:180:C Bed_Civilian:2750: Cabinet_Medical:350: Cabinet_Office:420: Cabinet_Wood:470: Carpet_Persian:250: Carpet_Rag:150: Chair_Office:220: Cupboard:275: Curtain_Long:120: Curtain_Mini:35: Dartboard:350: Freezer:950: Fridge:475: Nightstand:350: Painting_Lake:180: Pallet:50: Rack_Coat:50: Rya_Maria:250: Shelf_Wall:65: Shelf_Wood:320: Sofa_Leather:2400: Stool_Padded:120: Stove:2250: Table_Cabin:870: Table_Kitchen:320: Table_Office:380: Jaeger_140:150:C Bandage:150:C Cold_Medicine:75:C Blanket:75:C Map:250:R Mattress:110:C Vest_Fishing:140:C M28:450:C Mosin:450:C Colt_1911:550:C Makarov:250:C AKM:1200:C AKS_74U:850:C MP5K:1850:C Remington_870:550:C',
    doctor: 'Energy_Powder:100:R Alarm_Clock:150:C Hotplate:250:C Cabinet_Office:420: Chair_School:250: Locker:1850: Shelf_Metal:520: Table_Office:380: Trolley_Short:380: Trolley_Tall:580: Balm:85:C Bandage:150:C Cold_Medicine:75:C Gum:40:C Lotion:75:C Melatonin:75:C Painkillers:150:C Rags:20:C Splint:150:C Tissues:50:C Tourniquet:150:C Wipes:120:R Bucket:25:C Pillow:50:C Toilet_Paper:25:C',
    gunsmith: 'Ammo_12x70:200:C Ammo_223:300:C Ammo_308:400:R Ammo_45ACP:250:C Ammo_545x39:325:C Ammo_762x39:350:C Ammo_9x18:200:C Ammo_9x19:250:C Armor_Plate_II:200:R Armor_Plate_III:300:R Armor_Plate_IIIA:250:R Armor_Plate_III_Plus:400:R KAR_21_Barrel:350:R AKM_Magazine:110:C AKS_74U_Magazine:100:C Colt_1911_Magazine:75:C Glock_17_Magazine:90:C HP_DA_Magazine:80:C Jatimatic_Magazine:50:R KAR_21_223_Magazine:150:R KAR_21_308_Magazine:170:R MP5_Magazine:60:C Makarov_Magazine:25:C P320_Magazine:110:R RK_Magazine:120:C STANAG_Magazine:125:C Hybrid:750:R Monster:820:R Navy:880:R PBS:330:R Rider:800:R SOCOM:810:R ACOG:950:R EXPS:850:R Kobra:350:R MRO:740:R Micro:450:R POSP:650:R PRO:650:R PU:400:R RMR:820:R Backpack_Jaeger_Black:250:R Backpack_Jaeger_Brown:250:R Backpack_Jaeger_Green:250:R Backpack_Jaeger_M05:250:R Backpack_Kantamus:390:R Backpack_Patrol:200:R Kukkaro_Black:70:C Kukkaro_Brown:70:C Kukkaro_Green:70:C Kukkaro_M05:70:C Boots_Combat:160:C Cap_M62:75:C Fleece_Tactical_Brown:80:C Fleece_Tactical_Green:80:C Gloves_Leather:25:C Jacket_M62:125:C Chocolate_War:350:R Field_Ration:475:R Digital_Military_Wrist_Watch:400:R Narva:180:C Polaris:375:R Crate_Military:1200: Crate_Special:3500: Stool_Military:190: Table_Canteen:380: Target_Stand:1500: Weapon_Display:5000: F1:350:R M43:450:R RGD_5:350:R Helmet_Police:480:R SSh_39:240:C Jaeger_140:150:C Happy_Stove:220:R Jerry_Can:120:R Map_Tactical:250:R Mess_Kit:250:R Sleeping_Bag:450:R Weapon_Repair_Kit:2750:R Matches:20:C K19:450:R LVPC_Green:380:R LVPC_M05:380:R M28:450:C Mosin:450:C Colt_1911:550:C Glock_17:700:C HP_DA:550:C Makarov:250:C P320:1150:R AKM:1200:C AKS_74U:850:C KAR_21_223:3800:R KAR_21_308:4200:R M4A1:3850:C RK_62:2200:C RK_95:2200:C Jatimatic:1250:R MP5:2450:C MP5K:1850:C Remington_870:550:C',
    driver: 'Duffel_Retro:75:C Gloves_Work:15:C Hoodie_Gray:25:C Jacket_Winter_Blue:40:C Jacket_Winter_Red:40:C Jeans_Black:30:C Water_Bottle:300:R Beer:250:R Cigarettes:125:R Cigars:450:R Coffee:175:R Peanuts:40:C Salty_Liquorice:75:R Snus:125:R Soda_Lemon:100:R Batteries:100:R Battery:250:R Battery_Cables:50:C Casette_Player:250:L Inverter:220:R Casette_Electrofolk:150:R Casette_Radio:150:R Casette_Symphony:150:R Board_Game:140:R Duct_Tape:50:C Jerry_Can:120:R Map:250:R Oil_Filter:180:R Pillow:50:C Toolbox:375:R',
    hunter: 'Sticks:25:C Ammo_12x70:200:C Ammo_223:300:C Ammo_308:400:R Ammo_45ACP:250:C Ammo_762x54R:375:C Ammo_9x18:200:C Ammo_9x19:250:C AKM_Magazine:110:C AKS_74U_Magazine:100:C Colt_1911_Magazine:75:C HP_DA_Magazine:80:C Makarov_Magazine:25:C Backpack_Nomad:100:C Gloves_Leather:25:C Gloves_Work:15:C Pants_Hiking:40:C Canned_Meat:150:C Kilju:1000: Mustard:75:R Peanuts:40:C Potato:10:C Yeast:25:C Narva:180:C Fishing_Rod:480:R Bed_Nomad:350: Bench_Campsite:350: Pallet:50: Guitar:1280:L Jaeger_140:150:C Skrama_200:250:R Skrama_240:450:R Bandage_Improvised:75: Rags:20:C Splint_Improvised:125: Tourniquet_Improvised:75: Bucket:25:C Happy_Stove:220:R Lumber:150:C Mattress:110:C Sleeping_Bag:450:R Tackle_Box:370:R Matches:20:C Vest_Fishing:140:C M28:450:C Mosin:450:C Colt_1911:550:C HP_DA:550:C Makarov:250:C AKM:1200:C AKS_74U:850:C Remington_870:550:C'
  };
  /* ---------- what a trader can stock (read from the game files; bundled list as a fallback) ---------- */
  function itemChips(paths) {
    var n = {}, order = [];
    paths.forEach(function (p) { if (!n[p]) { n[p] = 0; order.push(p); } n[p]++; });
    return order.map(function (p) {
      var fur = !/^res:\/\/Items\//i.test(p), nm = Tres.itemName(p).replace(/ F$/, '');
      return '<span class="ichip" title="' + esc(nm + (fur ? ' (furniture)' : '')) + '"><span class="ti"><img data-ic="' + esc(p) + '" alt="" hidden>' + glyph('misc') + '</span>' + esc(nm) + (n[p] > 1 ? ' \u00d7' + n[p] : '') + '</span>';
    }).join('');
  }
  function stockFb(k) { return (STOCK_FB[k] || '').split(' ').filter(Boolean).map(function (s) { var a = s.split(':'); return { stem: a[0], value: +a[1] || 0, rar: a[2] || '' }; }); }
  function stemIndex() {
    if (IC.stems) return IC.stems;
    var ix = {};
    IC.pack.names.forEach(function (n) {
      var m = /^Items\/[^\/]+\/[^\/]+\/([^\/]+)\.tres\.remap$/.exec(n);
      if (m && n.indexOf('/Files/') === -1) { ix[m[1].toLowerCase()] = 'res://' + n.replace(/\.remap$/, ''); return; }
      m = /^Assets\/([^\/]+)\/[^\/]+_F\.tres\.remap$/.exec(n);
      if (m) ix[m[1].toLowerCase()] = 'res://' + n.replace(/\.remap$/, '');
    });
    return (IC.stems = ix);
  }
  async function fillStock(k) {
    var box = document.querySelector('#pg-traders .stk[data-k="' + k + '"]'), meta = TRADERS[k];
    if (!box || !meta || box.dataset.ready) return;
    if (!gameDir) { box.innerHTML = '<div class="meta">Set the game folder in Settings to see this.</div>'; return; }
    try { await iconPack(); } catch (e) { box.innerHTML = '<div class="meta">Could not read the game files.</div>'; return; }
    box.dataset.ready = '1';
    var live, items = [], note, fb = stockFb(k), miss = 0;
    try { live = await Pck.traderStock(IC.pack, meta[0]); } catch (e) { live = { ok: false, error: String(e && e.message || e), candidates: [] }; }
    if (live.ok) { items = live.items.map(function (p) { return { path: p, value: 0, rar: '' }; }); note = 'Read from the game files.'; }
    else {
      var ix = stemIndex();
      fb.forEach(function (s) { var p = ix[s.stem.toLowerCase()]; if (p) items.push({ path: p, value: s.value, rar: s.rar }); else miss++; });
      note = 'The game files did not give this trader\'s loot table, so this is Quartermaster\'s bundled list (game version 0.2.3.1)' + (miss ? '; ' + miss + ' of its items were not found in your game files' : '') + '.';
    }
    var RAR = { C: 'Common', R: 'Rare', L: 'Legendary' }, groups = {};
    for (var it of items) {
      var d = null; try { d = await Pck.itemDef(IC.pack, it.path); } catch (e) { d = null; }
      var cm = /^res:\/\/Items\/([^\/]+)\//.exec(it.path), cat = cm ? cm[1] : 'Furniture';
      var val = d && d.ok && d.value > 0 ? d.value : it.value, rar = d && d.ok && d.rarity ? d.rarity : (RAR[it.rar] || '');
      (groups[cat] = groups[cat] || []).push({ path: it.path, name: Tres.itemName(it.path).replace(/ F$/, ''), val: val, rar: rar });
    }
    var cats = Object.keys(groups).sort();
    var diag = live.ok ? 'Source: ' + live.file + ' (' + live.key + '), ' + items.length + ' items. The bundled list has ' + fb.length + '.' : String(live.error) + '\n' + (live.candidates || []).join('\n');
    box.innerHTML = '<div class="meta stn">' + esc(note) + ' What a trader actually has on the shelf can vary.</div>' + (cats.length ? cats.map(function (c) {
      return '<h4 class="sh">' + esc(c) + ' <span class="cnt">' + groups[c].length + '</span></h4><div class="sgrid">' + groups[c].sort(function (a, b) { return a.name < b.name ? -1 : 1; }).map(function (x) {
        return '<div class="sitem" title="' + esc(x.name) + '"><span class="ti"><img data-ic="' + esc(x.path) + '" alt="" hidden>' + glyph('misc') + '</span><span class="sn">' + esc(x.name) + '</span>' + (x.rar === 'Rare' || x.rar === 'Legendary' ? '<span class="tag">' + esc(x.rar) + '</span>' : '') + (x.val ? '<span class="sv">\u20ac' + x.val + '</span>' : '') + '</div>';
      }).join('') + '</div>';
    }).join('') : '<div class="meta">Nothing to show.</div>') + '<details><summary>Details</summary><pre class="diag">' + esc(diag) + '</pre></details>';
    fillIcons();
  }
  async function renderTraders() {
    var v = pageEl('traders'), l = await list();
    if (TS.src !== 'live' && !l.some(function (m) { return m.id === TS.src; })) TS.src = 'live';
    var dir = TS.src === 'live' ? saveDir : j(j(bakDir, TS.src), 'data'), f = j(dir, 'Traders.tres');
    var opts = '<option value="live">Current save folder</option>' + l.map(function (m) { return '<option value="' + esc(m.id) + '">' + esc((m.tag || 'Snapshot') + ' - ' + new Date(m.created).toLocaleString()) + '</option>'; }).join('');
    var head = '<h1>Traders</h1><p class="sub">' + (TS.edit ? 'Edit mode: set each task to Not started, In progress or Completed, then create an edited copy. Your live save is never touched: the copy appears under Snapshots, and you restore it when the game is closed.' : 'Completed and in-progress tasks. Nothing here changes your save unless you create an edited copy in Edit mode.') + '</p><div class="bar"><select id="tsrc">' + opts + '</select><span class="sp"></span>' + (TS.edit ? '<button data-act="tr-edit">Exit edit mode</button><button data-act="tr-apply" class="pri">Create edited copy</button>' : '<button data-act="tr-edit">Edit mode</button>') + '</div>';
    try { v.innerHTML = head + ((await fs.exists(f)) ? tradersHtml(Tres.parse(await fs.readTextFile(f)), TS.edit) : '<div class="empty">No Traders.tres in this save.</div>'); }
    catch (err) { v.innerHTML = head + '<div class="empty bad">Could not read the save: ' + esc(err) + '</div>'; }
    $('#tsrc').value = TS.src;
    fillIcons();
    fillQuestInfo(); fillStock(TS.sel);
  }
  // "Needs -> Reward" text for each task row, read from the game files
  function itemList(paths) {
    var n = {}, order = [];
    paths.forEach(function (p) { if (!n[p]) { n[p] = 0; order.push(p); } n[p]++; });
    return order.map(function (p) {
      var nm = Tres.itemName(p).replace(/ F$/, '') + (/^res:\/\/Items\//i.test(p) ? '' : ' (furniture)');
      return esc(nm) + (n[p] > 1 ? ' \u00d7' + n[p] : '');
    }).join(', ');
  }
  async function fillQuestInfo() {
    var cells = Array.prototype.slice.call(document.querySelectorAll('#view .qi')), note = $('#trnote');
    if (note) note.hidden = true;
    if (!cells.length) return;
    var say = function (m) { if (note) { note.textContent = m; note.hidden = false; } };
    if (!gameDir) { say('Set the game folder in Settings to see what each task needs and gives.'); return; }
    try { await iconPack(); } catch (e) { say('Could not read the game files.'); return; }
    for (var c of cells) {
      var d = await Pck.taskDef(IC.pack, c.dataset.qp);
      c.innerHTML = d && d.ok ? '<div class="qrow"><span class="ql">Needs</span>' + (itemChips(d.deliver) || '-') + '</div><div class="qrow"><span class="ql">Reward</span>' + (itemChips(d.receive) || '-') + '</div>' : 'Not found in the game files.';
    }
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
    if (e.t === 'int0') { var i0 = parseInt(e.v, 10); if (isNaN(i0) || i0 < 0 || i0 > 100) throw new Error(e.label + ' must be between 0 and 100'); return String(i0); }
    if (e.t === 'time') { var p = String(e.v).split(':'), h = parseInt(p[0], 10), mi = parseInt(p[1], 10); if (isNaN(h) || isNaN(mi)) throw new Error('Time is not valid'); var tv = h * 100 + mi * 100 / 60; return Number.isInteger(tv) ? f(tv) : String(Math.ceil(tv * 10000 - 1e-9) / 10000); }
    throw new Error('Unknown field type');
  }
  function collectEdits() {
    var out = [];
    document.querySelectorAll('#pg-edit input[data-k], #pg-edit select[data-k]').forEach(function (el) {
      var chk = el.type === 'checkbox', v = chk ? String(el.checked) : el.value;
      if (v === el.dataset.init) return;
      var to = chk ? (el.checked ? 'on' : 'off') : el.tagName === 'SELECT' ? el.options[el.selectedIndex].text : v;
      var from = chk ? (el.dataset.init === 'true' ? 'on' : 'off') : (el.dataset.initText || el.dataset.init);
      out.push({ f: el.dataset.f, k: el.dataset.k, t: el.dataset.t, v: v, label: el.dataset.label, from: from, to: to });
    });
    return out;
  }
  async function renderEdit() {
    var v = pageEl('edit'), l = await list();
    if (ES.src !== 'live' && !l.some(function (m) { return m.id === ES.src; })) ES.src = 'live';
    var dir = ES.src === 'live' ? saveDir : j(j(bakDir, ES.src), 'data');
    var opts = '<option value="live">Current save folder</option>' + l.map(function (m) { return '<option value="' + esc(m.id) + '">' + esc((m.tag || 'Snapshot') + ' - ' + new Date(m.created).toLocaleString()) + '</option>'; }).join('');
    var head = '<h1>Character &amp; World</h1><p class="sub">Change your character\'s meters, conditions and cat, and the world settings (day, time, difficulty, weather), then create an edited copy. Your live save is never touched: the copy appears under Snapshots, and you restore it when the game is closed.</p>' +
      '<div class="bar"><select id="esrc">' + opts + '</select><span class="sp"></span><button data-act="heal">Heal all</button><button data-act="mkedit" class="pri">Create edited copy</button></div>';
    var read = async function (n) { var p = j(dir, n + '.tres'); return (await fs.exists(p)) ? Tres.parse(await fs.readTextFile(p)) : null; };
    var ch, wo;
    try { ch = await read('Character'); wo = await read('World'); } catch (err) { v.innerHTML = head + '<div class="empty bad">Could not read the save: ' + esc(err) + '</div>'; $('#esrc').value = ES.src; return; }
    var gv = function (t, k) { var x = t.get(t.main(), k); return x === undefined ? null : String(x).replace(/^"|"$/g, ''); };
    var attrs = function (f, k, ty, label, init, extra) { return ' data-f="' + f + '" data-k="' + k + '" data-t="' + ty + '" data-label="' + esc(label) + '" data-init="' + esc(init) + '"' + (extra || ''); };
    var html = head;
    var chkHtml = function (x, cls) {
      var on = gv(ch, x[0]) === 'true';
      return '<label class="chip ' + cls + '" data-bx><input type="checkbox"' + (on ? ' checked' : '') + attrs('Character', x[0], 'bool', x[1], String(on)) + '><span>' + esc(x[1]) + '</span></label>';
    };
    var rb = function (label) { return '<div class="vh"><span>' + esc(label) + '</span><button class="rst" data-act="ed-reset" title="Reset to the saved value" aria-label="Reset ' + esc(label) + '">\u21ba</button></div>'; };
    var meterHtml = function (x) {
      var init = String(+parseFloat(gv(ch, x[0])).toFixed(2));
      return '<div class="vc" data-bx>' + rb(x[1]) +
        '<div class="vr"><input type="range" min="0" max="100" step="1" value="' + init + '" data-w="sl" aria-label="' + esc(x[1]) + ' slider"><input type="number" min="0" max="100" step="1" value="' + init + '" aria-label="' + esc(x[1]) + '"' + attrs('Character', x[0], 'num', x[1], init) + '></div>' +
        (x[0] === 'reputation' ? '<div class="vhint" data-hint="rep"></div>' : '') + '</div>';
    };
    var has = function (x) { return gv(ch, x[0]) !== null; };
    var pick = function (keys, list) { return keys.map(function (k) { return list.filter(function (x) { return x[0] === k; })[0]; }).filter(function (x) { return x && has(x); }); };
    if (ch) {
      var vit = pick(['health', 'energy', 'hydration', 'temperature', 'mental', 'reputation'], METERS), stm = pick(['bodyStamina', 'armStamina'], METERS), cat = pick(['cat'], METERS);
      var ccat = pick(['catFound', 'catDead'], CONDS), shown = {};
      var grp = function (title, keys) {
        var xs = pick(keys, CONDS); xs.forEach(function (x) { shown[x[0]] = 1; });
        return xs.length ? '<h3>' + title + '</h3><div class="chips">' + xs.map(function (x) { return chkHtml(x, ''); }).join('') + '</div>' : '';
      };
      html += '<h2>Character</h2>';
      if (vit.length) html += '<h3>Vitals</h3><div class="vgrid">' + vit.map(meterHtml).join('') + '</div>';
      if (stm.length) html += '<h3>Stamina</h3><div class="vgrid">' + stm.map(meterHtml).join('') + '</div>';
      var cg = grp('Injuries', ['bleeding', 'fracture', 'burn', 'frostbite', 'rupture', 'headshot']) + grp('Needs', ['overweight', 'starvation', 'dehydration', 'poisoning']) + grp('Mind', ['insanity']);
      var rest = CONDS.filter(function (x) { return has(x) && !shown[x[0]] && ccat.indexOf(x) === -1; });
      if (rest.length) cg += '<h3>Other conditions</h3><div class="chips">' + rest.map(function (x) { return chkHtml(x, ''); }).join('') + '</div>';
      html += cg;
      if (cat.length || ccat.length) html += '<h3>Cat</h3>' + (cat.length ? '<div class="vgrid">' + cat.map(meterHtml).join('') + '</div>' : '') + (ccat.length ? '<div class="chips">' + ccat.map(function (x) { return chkHtml(x, 'neu'); }).join('') + '</div>' : '');
    } else html += '<div class="empty">No Character.tres in this save.</div>';
    if (wo) {
      var sel = function (k, label, pairs, cur) {
        if (!pairs.some(function (p) { return p[0] === cur; })) pairs = pairs.concat([[cur, cur]]);
        var txt = (pairs.filter(function (p) { return p[0] === cur; })[0] || [0, cur])[1];
        var head2 = rb(label); if (k === 'difficulty') head2 = head2.replace('</span>', '</span><span class="tag iron" data-iron hidden>Ironman</span>');
        return '<div class="fld wf" data-bx>' + head2 + '<select aria-label="' + esc(label) + '"' + attrs('World', k, k === 'weather' ? 'str' : 'int', label, cur, ' data-init-text="' + esc(txt) + '"') + '>' + pairs.map(function (p) { return '<option value="' + esc(p[0]) + '"' + (p[0] === cur ? ' selected' : '') + '>' + esc(p[1]) + '</option>'; }).join('') + '</select></div>';
      };
      var day = gv(wo, 'day'), tm = gv(wo, 'time'), tinit = tm !== null && !isNaN(parseFloat(tm)) ? fmtTime(parseFloat(tm)) : null, nr = gv(wo, 'nomadsRemaining');
      html += '<h2>World</h2><div class="fgrid">' +
        (day !== null ? '<div class="fld wf" data-bx>' + rb('Day') + '<input type="number" min="1" step="1" value="' + esc(day) + '" aria-label="Day"' + attrs('World', 'day', 'int', 'Day', day) + '></div>' : '') +
        (tinit ? '<div class="fld wf" data-bx>' + rb('Time of day') + '<input type="time" value="' + tinit + '" aria-label="Time of day"' + attrs('World', 'time', 'time', 'Time', tinit) + '></div>' : '') +
        (gv(wo, 'season') !== null ? sel('season', 'Season', [['1', 'Summer'], ['2', 'Winter']], gv(wo, 'season')) : '') +
        (gv(wo, 'difficulty') !== null ? sel('difficulty', 'Difficulty', [['1', 'Standard'], ['2', 'Darkness'], ['3', 'Ironman']], gv(wo, 'difficulty')) : '') +
        (gv(wo, 'weather') !== null ? sel('weather', 'Weather', WEATHER.map(function (w) { return [w, w]; }), gv(wo, 'weather')) : '') +
        (nr !== null && /^\d+$/.test(nr) ? '<div class="fld wf" data-bx>' + rb('Nomads remaining') + '<input type="number" min="0" max="100" step="1" value="' + esc(nr) + '" aria-label="Nomads remaining"' + attrs('World', 'nomadsRemaining', 'int0', 'Nomads remaining', nr) + '><div class="vhint">Nomad Gatherings follow this number. A new save starts at 100. Once all are killed, the game refills 10 to 50 after a while.</div></div>' : '') + '</div>';
    } else html += '<div class="empty">No World.tres in this save.</div>';
    v.innerHTML = html; $('#esrc').value = ES.src; edSyncAll();
  }
  /* character page: slider/number sync, "changed" highlight, reputation hint */
  function edMark(el) {
    var bx = el.closest('[data-bx]'); if (!bx) return;
    bx.classList.toggle('chg', (el.type === 'checkbox' ? String(el.checked) : el.value) !== el.dataset.init);
  }
  function edHints() {
    var root = document.getElementById('pg-edit'); if (!root) return;
    var rp = root.querySelector('[data-k="reputation"]'), hp = root.querySelector('[data-hint="rep"]');
    if (rp && hp) {
      var n = parseFloat(rp.value);
      hp.textContent = isNaN(n) ? '' : n >= 50 ? 'Roaming Nomads will trade with you.' : 'Below 50, roaming Nomads are hostile and will not trade.';
      hp.classList.toggle('good', !isNaN(n) && n >= 50); hp.classList.toggle('bad', !isNaN(n) && n < 50);
    }
    var df = root.querySelector('[data-k="difficulty"]'), it = root.querySelector('[data-iron]');
    if (df && it) it.hidden = df.value !== '3';
  }
  function edSyncAll() {
    document.querySelectorAll('#pg-edit [data-k]').forEach(function (el) {
      var bx = el.closest('[data-bx]'), sl = bx && bx.querySelector('input[data-w="sl"]');
      if (sl && el.type === 'number') sl.value = el.value;
      edMark(el);
    });
    edHints();
  }
  function edSync(ev) {
    var t = ev.target; if (!t.closest || !t.closest('#pg-edit')) return;
    var bx = t.closest('[data-bx]'); if (!bx) return;
    if (t.dataset.w === 'sl') { var nm = bx.querySelector('input[data-k]'); if (nm) nm.value = t.value; }
    else if (t.dataset.k) {
      var sl = bx.querySelector('input[data-w="sl"]');
      if (sl) { if (ev.type === 'change' && t.value !== '' && !isNaN(+t.value)) t.value = Math.min(100, Math.max(0, +t.value)); sl.value = t.value; }
    }
    var k = bx.querySelector('[data-k]'); if (k) edMark(k);
    edHints();
  }
  document.addEventListener('input', edSync);
  document.addEventListener('change', edSync);

  /* ---------- views ---------- */
  async function renderSnapshots() {
    var ok = await fs.exists(saveDir), v = pageEl('snapshots'), lw = ok ? await worldInfo(saveDir) : null;
    var head = '<h1>Snapshots</h1><p class="sub">' + esc(saveDir) + ' &middot; ' + (ok ? '<span class="good">found</span>' : '<span class="bad">not found</span>') + (lw ? ' &middot; ' + fmtWorld(lw) + (lw.difficulty === '3' ? ' <span class="tag iron">Ironman</span>' : '') : '') + '</p>';
    if (!ok) { v.innerHTML = head + '<div class="empty">Save folder not found.<br><br><button data-act="pick" class="pri">Choose folder</button></div>'; return; }
    var l = await list();
    await Promise.all(l.map(async function (m) { m.world = await worldInfo(j(j(bakDir, m.id), 'data')); }));
    var rows = l.map(function (m) {
      return '<div class="snap"><div><h4>' + esc(m.tag || 'Snapshot') + '<span class="tag ' + (m.auto ? '' : 'man') + '">' + (m.auto ? 'Auto' : 'Manual') + '</span>' + (m.world && m.world.difficulty === '3' ? '<span class="tag iron">Ironman</span>' : '') + '</h4>' +
        (m.world ? '<div class="meta wi">' + fmtWorld(m.world) + '</div>' : '') + '<div class="meta">' + new Date(m.created).toLocaleString() + ' &middot; ' + m.files + ' items &middot; ' + fmtSize(m.size) + '</div></div>' +
        '<div class="acts" data-id="' + esc(m.id) + '"><button data-act="restore" class="pri">Restore</button><button data-act="rename">Rename</button><button data-act="del" class="dng">Delete</button></div></div>';
    }).join('');
    var autoN = l.filter(function (m) { return m.auto && m.tag !== 'Before restore'; }).length;
    v.innerHTML = head + '<div class="bar"><button data-act="backup" class="pri">Back up now</button>' + (autoN ? '<button data-act="delauto" class="dng">Delete ' + autoN + ' automatic</button>' : '') + '<span class="sp"></span><span class="meta">' + l.length + ' snapshot' + (l.length === 1 ? '' : 's') + '</span></div>' +
      (rows || '<div class="empty">No snapshots yet. Back up now, or play and let auto backup do it.</div>');
  }
  async function renderSettings() {
    var auto = localStorage.getItem('auto') === '1';
    pageEl('settings').innerHTML = '<h1>Settings</h1><p class="sub">Vostok Quartermaster</p>' +
      '<div class="set"><h4>Save folder</h4><p>' + esc(saveDir) + '</p><button data-act="pick">Change&hellip;</button> <button data-act="open-save">Show in Explorer</button></div>' +
      '<div class="set"><h4>Game folder</h4><p>' + esc(gameDir || 'Not set') + (GD_AUTO ? ' (found automatically)' : '') + '</p><button data-act="pickgame">Choose&hellip;</button><p class="mt">Used for item icons and to check which mods are installed (the <b>mods</b> folder inside it). Icons are read from your own game files when needed and are never copied into the app or its backups.' + (IC.fail ? ' <span class="bad">Could not read icons: ' + esc(IC.fail) + ' &mdash; choose the folder again.</span>' : '') + '</p></div>' +
      '<div class="set"><h4>Backups folder</h4><p>' + esc(bakDir) + '</p><button data-act="open-bak">Show in Explorer</button></div>' +
      '<div class="set"><h4>Skip when backing up</h4><p>Top-level folders left out of snapshots, separated by commas. Restoring never touches them.</p><input id="skip" type="text" value="' + esc(skipList().join(', ')) + '"></div>' +
      modSizeHtml() + magSettingHtml() + warnSettingHtml() + diagHtml() +
      '<div class="set"><h4>Auto backup (off by default)</h4><p>Creates a snapshot a few seconds after the game saves. The newest ' + KEEP_AUTO + ' automatic snapshots are kept; manual ones are never removed.</p>' +
      '<label><input type="checkbox" id="auto" ' + (auto ? 'checked' : '') + '> Enable auto backup</label></div>' +
      '<div class="set about"><h4>About</h4>' +
      '<div class="ab-head"><div class="ab-name">Vostok Quartermaster <span class="tag">v' + esc(APP_VER) + '</span></div><div class="meta">Back up, repair, inspect and edit your Road to Vostok saves. Made for Build 2 saves.</div></div>' +
      '<div class="ab-row"><div class="ab-label">Updates</div><div class="ab-body"><div class="ab-line">' + updStatus() + '</div><div class="ab-line"><button data-act="chkupd">Check for updates</button>' + (updAvail() ? '<button class="pri" data-act="open-url" data-url="' + esc(updUrl()) + '">View release</button>' : '') + '</div>' +
      '<label class="ab-check"><input type="checkbox" id="updchk" ' + (localStorage.getItem('updcheck') === '0' ? '' : 'checked') + '> Check for updates on startup</label><div class="meta">This only asks GitHub for the latest release number. Nothing is downloaded or installed.</div></div></div>' +
      '<div class="ab-row"><div class="ab-label">Links</div><div class="ab-body"><div class="ab-line"><button data-act="open-url" data-url="https://github.com/PR0Gorib/VostokQuartermaster">GitHub</button><button data-act="open-url" data-url="https://github.com/PR0Gorib/VostokQuartermaster/issues">Report a problem</button></div></div></div>' +
      '<div class="ab-foot"><div>Made with \u2764\ufe0f by PR0Gorib</div><div class="meta">Unofficial tool. Not affiliated with the Road to Vostok Ltd.<br>Item icons and trader portraits are read from your own game files when needed and are never stored.</div></div></div>';
  }
  /* ---------- inspector: details of the selected item, bound to that item's row in the list ---------- */
  function rowName(row) {
    var c = row.cells[0].cloneNode(true); c.querySelectorAll('.ib,.tag,.meta,button,label,input,select').forEach(function (x) { x.remove(); });
    return c.textContent.trim() || row.dataset.name || row.dataset.q || 'Item';
  }
  function fillInsp(insp, row) {
    insp._row = row;
    var path = row.dataset.path || '', cat = row.dataset.cat || '', cc = row.querySelector('.cc'), qc = row.querySelector('.qc');
    var ci = row.querySelector('.cc input'), qi = row.querySelector('.qc input'), rm = row.querySelector('[data-w="r"]'), wp = row.querySelector('[data-act="wp-open"]'), cancel = row.querySelector('[data-act="sh-cancel"]');
    var where = row.dataset.slot ? row.dataset.slot.replace('_', ' ') + ' slot' : (row.dataset.gx !== undefined && row.dataset.gx !== '' ? 'column ' + (+row.dataset.gx / CELL + 1) + ', row ' + (+row.dataset.gy / CELL + 1) + (row.dataset.rot === '1' ? ', rotated' : '') : '');
    var att = (row.dataset.nested || '').split('|').filter(Boolean).map(function (a) { return Tres.itemName(a); }).join(', ');
    insp.innerHTML = '<div class="ih"><span class="ib">' + (/^res:\/\/Items\//i.test(path) ? '<img data-ic="' + esc(path) + '" alt="" hidden>' : '') + glyph(cat) + '</span><div><b>' + esc(rowName(row)) + '</b><div class="meta">' + esc(cat) + (where ? ' &middot; ' + esc(where) : '') + '</div></div></div><div class="ib2"></div>';
    var box = insp.querySelector('.ib2');
    var bind = function (label, src) {
      var w = document.createElement('label'); w.className = 'ir'; w.appendChild(document.createTextNode(label));
      var inp = document.createElement('input'); inp.type = 'number'; inp.min = src.min; inp.max = src.max; inp.step = src.step || 1; inp.value = src.value; w.appendChild(inp);
      inp.addEventListener('input', function () { src.value = inp.value; src.dispatchEvent(new window.Event('input', { bubbles: true })); });
      inp.addEventListener('change', function () { src.value = inp.value; src.dispatchEvent(new window.Event('change', { bubbles: true })); inp.value = src.value; });
      box.appendChild(w);
    };
    var ro = function (label, txt) { var w = document.createElement('div'); w.className = 'ir'; w.textContent = label + ': ' + txt; box.appendChild(w); };
    if (ci) bind('Condition (%)', ci); else if (cc || row.cells[2]) ro('Condition', (cc || row.cells[2]).textContent.trim() || 'n/a');
    if (qi) bind(row.dataset.wp === '1' ? 'Rounds loaded' : 'Quantity', qi); else if (qc || row.cells[3]) { var qt = (qc || row.cells[3]).textContent.trim(); if (qt) ro('Quantity', qt); }
    if (att) ro('Fitted', att);
    if (rm) {
      var rl = document.createElement('label'); rl.className = 'ab-check'; var rc = document.createElement('input'); rc.type = 'checkbox'; rc.checked = rm.checked; rl.appendChild(rc); rl.appendChild(document.createTextNode(' Remove this item'));
      rc.addEventListener('change', function () { rm.checked = rc.checked; rm.dispatchEvent(new window.Event('change', { bubbles: true })); }); box.appendChild(rl);
    }
    if (wp) { var wb = document.createElement('button'); wb.textContent = wp.textContent; wb.addEventListener('click', function () { wp.click(); }); box.appendChild(wb); }
    if (cancel) { var cb = document.createElement('button'); cb.textContent = 'Cancel this new item'; cb.addEventListener('click', function () { cancel.click(); insp.innerHTML = inspPh(insp.closest('.pg')); insp._row = null; }); box.appendChild(cb); }
    fillIcons();
  }
  function selectItem(el, row) {
    var pg = el.closest('.pg'); if (!pg) return;
    pg.querySelectorAll('.gi.sel, .eqs.sel').forEach(function (x) { x.classList.remove('sel'); }); el.classList.add('sel');
    var insp = pg.querySelector('.insp'); if (insp && row) fillInsp(insp, row);
  }
  function refreshInsp() {
    document.querySelectorAll('#view .insp').forEach(function (insp) {
      if (!insp._row) return;
      if (!insp._row.isConnected) { insp.innerHTML = inspPh(insp.closest('.pg')); insp._row = null; return; }
      if (insp.contains(document.activeElement)) return;
      fillInsp(insp, insp._row);
    });
  }
  // each page lives in its own section of #view; pages being edited stay alive while you look at other tabs
  function pageEl(name) {
    var v = $('#view'), el = document.getElementById('pg-' + name);
    if (!el) { el = document.createElement('section'); el.id = 'pg-' + name; el.className = 'pg'; v.appendChild(el); }
    return el;
  }
  function showPage(name) { pageEl(name); document.querySelectorAll('#view > section.pg').forEach(function (e) { e.hidden = e.id !== 'pg-' + name; }); }
  function dropPages() { document.querySelectorAll('#view > section.pg').forEach(function (e) { e.remove(); }); }
  function resetAllPages() { IS.edit = false; SS.edit = false; TS.edit = false; dropPages(); }
  // one working source (the live save or a snapshot) for all editors, so their changes can go into one edited copy
  function setSource(v) { IS.src = SS.src = TS.src = ES.src = v; resetAllPages(); return render(); }
  function srcDir() { return IS.src === 'live' ? saveDir : j(j(bakDir, IS.src), 'data'); }
  function updPending() {
    var bar = $('#pbar'); if (!bar) return;
    var n = pendingChanges(); bar.hidden = n === 0; $('#pcount').textContent = n + ' pending change' + (n === 1 ? '' : 's');
  }
  var pTimer = 0;
  function schedPending() { clearTimeout(pTimer); pTimer = setTimeout(updPending, 60); }
  function render() { showPage(page); return Promise.resolve(page === 'settings' ? renderSettings() : page === 'repair' ? renderRepair() : page === 'inventory' ? renderInventory() : page === 'shelter' ? renderShelter() : page === 'traders' ? renderTraders() : page === 'edit' ? renderEdit() : renderSnapshots()).catch(function (e) { $('#view').innerHTML = '<div class="empty bad">' + esc(e) + '</div>'; }).then(schedPending); }

  /* ---------- update check (GitHub releases; only a link is shown, nothing is downloaded or installed) ---------- */
  var REPO_URL = 'https://github.com/PR0Gorib/VostokQuartermaster', UP = { tag: '', url: '' };
  function verParts(v) { var m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v || '').trim()); return m ? [+m[1], +m[2], +m[3]] : null; }
  function isNewer(a, b) { var x = verParts(a), y = verParts(b); if (!x || !y) return false; for (var i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false; }
  function updAvail() { return !!UP.tag && isNewer(UP.tag, APP_VER); }
  function updUrl() { return UP.url && UP.url.indexOf(REPO_URL + '/') === 0 ? UP.url : REPO_URL + '/releases'; }
  function updUi() {
    var el = $('#upd'); if (!el) return;
    el.hidden = !updAvail();
    el.innerHTML = updAvail() ? '<button data-act="open-url" data-url="' + esc(updUrl()) + '">Update available: ' + esc(UP.tag) + '</button>' : '';
  }
  async function checkUpdate(manual) {
    if (!manual) {
      if (localStorage.getItem('updcheck') === '0') return;
      UP.tag = localStorage.getItem('updtag') || ''; UP.url = localStorage.getItem('updurl') || '';
      if (Date.now() - (+localStorage.getItem('updlast') || 0) < 864e5) { updUi(); return; }
    }
    var ctl = new AbortController(), to = setTimeout(function () { ctl.abort(); }, 8000);
    try {
      var r = await fetch('https://api.github.com/repos/PR0Gorib/VostokQuartermaster/releases/latest', { headers: { Accept: 'application/vnd.github+json' }, signal: ctl.signal });
      var d = r.status === 404 ? {} : r.ok ? await r.json() : null;
      if (!d) throw new Error('HTTP ' + r.status);
      UP.tag = String(d.tag_name || ''); UP.url = String(d.html_url || '');
      localStorage.setItem('updtag', UP.tag); localStorage.setItem('updurl', UP.url); localStorage.setItem('updlast', String(Date.now()));
      if (manual) toast(updAvail() ? 'Update available: ' + UP.tag : 'You are up to date (v' + APP_VER + ')');
    } catch (e) { if (manual) toast('Could not check for updates. Are you online?'); }
    finally { clearTimeout(to); }
    updUi();
  }
  function updStatus() {
    var last = +localStorage.getItem('updlast') || 0;
    return (updAvail() ? '<span class="good">Update available: ' + esc(UP.tag) + '</span>' : last ? 'You are up to date.' : 'Not checked yet.') + (last ? ' <span class="meta">Last checked ' + esc(new Date(last).toLocaleString()) + '</span>' : '');
  }

  /* ---------- events ---------- */
  document.addEventListener('click', async function (ev) {
    var nb = ev.target.closest('#nav button[data-page]');
    if (nb) {
      var np = nb.dataset.page; if (np !== 'settings') IC.fail = ''; page = np;
      document.querySelectorAll('#nav button').forEach(function (b) { b.classList.toggle('on', b === nb); });
      var keep = document.getElementById('pg-' + np) && ((np === 'inventory' && IS.edit) || (np === 'shelter' && SS.edit) || (np === 'traders' && TS.edit) || (np === 'edit' && collectEdits().length));
      if (keep) { showPage(np); schedPending(); return; }
      return render();
    }
    if (ev.target.matches && ev.target.matches('tr.wrow > td')) { ev.target.parentNode.hidden = true; return; }
    var flashRow = function (tr) { tr.scrollIntoView({ block: 'center', behavior: 'smooth' }); tr.classList.add('flash'); setTimeout(function () { tr.classList.remove('flash'); }, 1400); };
    var es = ev.target.closest('.eqs.has');
    if (es && !ev.target.closest('[data-act]')) { var er = es.closest('.cbody').querySelector('tr[data-slot="' + es.dataset.slot + '"]'); selectItem(es, er); if (er && es.closest('.pg.lv')) flashRow(er); return; }
    var ee = ev.target.closest('.eqs.eqe');
    if (ee) { var eqb = document.querySelector('#view .eqbar'); if (eqb) { eqb.querySelector('.eqslot').value = ee.dataset.slot; fillEqItems(eqb); eqb.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } return; }
    var gi = ev.target.closest('#view .gi');
    if (gi) {
      var gs = gi.closest('.cbody') || document, gr = gi.dataset.aid ? gs.querySelector('tr[data-aid="' + gi.dataset.aid + '"]') : (gi.dataset.k ? gs.querySelector('tr[data-ks~="' + gi.dataset.k + '"]') : null);
      selectItem(gi, gr); if (gr && gi.closest('.pg.lv')) flashRow(gr); return;
    }
    var rr = ev.target.closest('#view tr[data-ks], #view tr.ea');
    if (rr && !ev.target.closest('button, input, select, label, summary, [data-act]')) {
      var rs = rr.closest('.cbody'), ks = (rr.dataset.ks || '').split(' ');
      if (rs) rs.querySelectorAll('.gi').forEach(function (g) {
        if (ks.indexOf(g.dataset.k) === -1 && !(rr.dataset.aid && g.dataset.aid === rr.dataset.aid)) return;
        g.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); g.classList.add('flashgi'); setTimeout(function () { g.classList.remove('flashgi'); }, 1400);
      });
    }
    var b = ev.target.closest('[data-act]'); if (!b) return;
    var act = b.dataset.act, id = b.parentElement.dataset.id;
    try {
      if (act === 'backup') { var tag = await ask('Back up now', 'Add a tag to find it later (optional).', { input: true, ok: 'Back up' }); if (tag === null) return; await snap(tag, false); toast('Snapshot saved'); }
      else if (act === 'restore') { if (!(await ask('Restore this snapshot?', 'Close Road to Vostok first. Your current save is backed up automatically, then replaced with this snapshot.', { ok: 'Restore' }))) return; await restore(id); toast('Snapshot restored'); }
      else if (act === 'rename') { var m = (await list()).find(function (x) { return x.id === id; }); var t = await ask('Rename snapshot', '', { input: m.tag || true, ok: 'Save' }); if (t === null) return;
        var c = cleanName(t), nid = id;
        if (c && c.toLowerCase() !== id.toLowerCase()) {
          nid = await uniqueName(c);
          try { await fs.rename(j(bakDir, id), j(bakDir, nid)); } catch (e) { toast('Could not rename the folder (is it open in Explorer?). Nothing was changed.'); return; }
        }
        m.tag = t; m.id = nid; await fs.writeTextFile(j(j(bakDir, nid), 'snapshot.json'), JSON.stringify(m));
        if (nid !== id) { [RS, IS, TS, ES].forEach(function (s) { if (s.src === id) s.src = nid; }); } }
      else if (act === 'del') { if (!(await ask('Delete snapshot?', 'This cannot be undone.', { ok: 'Delete' }))) return; await fs.remove(j(bakDir, id), { recursive: true }); if (RS.src === id) RS.src = 'live'; if (IS.src === id) { IS.src = SS.src = TS.src = ES.src = 'live'; resetAllPages(); } }
      else if (act === 'srclive') { RS.src = 'live'; }
      else if (act === 'pick') { var p = await T.dialog.open({ directory: true, defaultPath: saveDir, title: 'Choose the Road to Vostok save folder' }); if (!p) return; saveDir = p; localStorage.setItem('saveDir', p); await startWatch(); }
      else if (act === 'ed-reset') {
        var rbx = b.closest('[data-bx]'); if (!rbx) return;
        rbx.querySelectorAll('[data-k]').forEach(function (el) { if (el.type === 'checkbox') el.checked = el.dataset.init === 'true'; else el.value = el.dataset.init; el.dispatchEvent(new window.Event('input', { bubbles: true })); });
        return;
      }
      else if (act === 'heal') {
        HEAL_M.forEach(function (k) { var el = document.querySelector('[data-f="Character"][data-k="' + k + '"]'); if (el) el.value = '100'; });
        HEAL_C.forEach(function (k) { var el = document.querySelector('[data-f="Character"][data-k="' + k + '"]'); if (el) el.checked = false; });
        edSyncAll();
        toast('Meters set to 100 and conditions cleared. Review, then create the copy.'); return;
      }
      else if (act === 'batch-create' || act === 'mkedit' || act === 'inv-apply' || act === 'sh-apply' || act === 'tr-apply') { await createBatch(); }
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
      else if (act === 'inv-edit' || act === 'sh-edit') {
        var S1 = act === 'sh-edit' ? SS : IS;
        if (S1.edit) { var pend, scp = act === 'sh-edit' ? '#pg-shelter' : '#pg-inventory'; try { pend = collectInvEdits(scp).length + collectAdds(scp).length + collectWeaponEdits(scp).length; } catch (e) { pend = 1; } if (pend && !(await ask('Discard changes?', 'Your unsaved changes on this page will be lost.', { ok: 'Discard' }))) return; }
        S1.edit = !S1.edit;
      }
      else if (act === 'sh-add') { await addToContainer(b.closest('.addbar')); return; }
      else if (act === 'sh-reward') { await addRewards(b.closest('.addbar')); return; }
      else if (act === 'sh-cancel') { var cr = b.closest('tr'); if (cr) { var ge = document.querySelector('.gi[data-aid="' + cr.dataset.aid + '"]'); if (ge) ge.remove(); var eb = document.querySelector('.eqs[data-aid="' + cr.dataset.aid + '"]'); if (eb) { eb.innerHTML = eb.dataset.old || ''; eb.className = eb.dataset.oldc || 'eqs eqe'; delete eb.dataset.aid; delete eb.dataset.old; delete eb.dataset.oldc; } cr.remove(); } return; }
      else if (act === 'eq-rm') { var xb = b.closest('.eqs'), xt = document.querySelector('#view tr.er[data-slot="' + xb.dataset.slot + '"]'), xc = xt && xt.querySelector('[data-w="r"]'); if (xc) { xc.checked = !xc.checked; xb.classList.toggle('rm', xc.checked); } return; }
      else if (act === 'eq-add') { await eqAdd(b.closest('.eqbar')); return; }
      else if (act === 'tr-edit') {
        if (TS.edit && collectQuestEdits().length && !(await ask('Discard changes?', 'Your unsaved changes on this page will be lost.', { ok: 'Discard' }))) return;
        TS.edit = !TS.edit;
      }
      else if (act === 'tr-pick') {
        TS.sel = b.dataset.k;
        document.querySelectorAll('#pg-traders .trp').forEach(function (p) { p.hidden = p.dataset.k !== TS.sel; });
        document.querySelectorAll('#pg-traders .ttile').forEach(function (t) { t.classList.toggle('on', t.dataset.k === TS.sel); });
        fillStock(TS.sel); return;
      }
      else if (act === 'tr-seg') {
        var sg = b.closest('.trow').querySelector('select[data-w="q"]');
        if (sg.value !== b.dataset.v) { sg.value = b.dataset.v; sg.dispatchEvent(new window.Event('change', { bubbles: true })); }
        return;
      }
      else if (act === 'tr-all') { var qc = b.closest('.trp'); qc.querySelectorAll('select[data-w="q"]').forEach(function (s) { s.value = b.dataset.to; }); qUpdate(qc); return; }
      else if (act === 'forgetsize') { delete MODSZ[b.dataset.p]; saveModSizes(); }
      else if (act === 'wp-open') {
        var wtr = b.closest('tr'), wn = wtr.nextElementSibling;
        if (wn && wn.classList.contains('wrow')) { wn.hidden = !wn.hidden; return; }
        if (!gameDir) { toast('Set the game folder in Settings first'); return; }
        await iconPack();
        var wh = await wbHtml(wtr); if (!wh) { toast('Could not read this item from the game files'); return; }
        wtr.insertAdjacentHTML('afterend', wh); wbSync(wtr.nextElementSibling, true); fillIcons(); return;
      }
      else if (act === 'diag') { var dpre = $('#diagout'); dpre.hidden = false; dpre.textContent = 'Testing...'; dpre.textContent = await runDiag(); return; }
      else if (act === 'diagcopy') { var dtx = $('#diagout').textContent; if (!dtx || $('#diagout').hidden) { toast('Run the test first'); return; } try { await navigator.clipboard.writeText(dtx); toast('Copied'); } catch (e) { toast('Could not copy: select the text and copy it by hand'); } return; }
      else if (act === 'resetscope') {
        var appd = await T.path.appDataDir(), sf = j(appd, '.persisted-scope');
        if (!(await ask('Reset folder permissions', 'To reset the folders Quartermaster was given access to:\n\n1. Close Quartermaster.\n2. Delete the file ".persisted-scope" in the folder that opens now.\n3. Start Quartermaster again.\n\nYour saves and snapshots are not touched. You may have to choose the game folder again.\n\n(Quartermaster cannot delete this file itself: it would be written back when the app closes.)', { ok: 'Show the folder' }))) return;
        try { await T.opener.revealItemInDir(sf); } catch (e) { await T.opener.revealItemInDir(appd); }
        return;
      }
      else if (act === 'batch-discard') { if (!(await ask('Discard all changes?', 'Everything you changed on every page, that is not in an edited copy yet, is lost.', { ok: 'Discard all' }))) return; resetAllPages(); }
      else if (act === 'lv-toggle') { var lpg = b.closest('.pg'), lk = lpg && lpg.id === 'pg-shelter' ? 'shelter' : 'inventory'; LV[lk] = !LV[lk]; localStorage.setItem('lv_' + lk, LV[lk] ? '1' : '0'); lpg.classList.toggle('lv', LV[lk]); b.textContent = LV[lk] ? 'Hide list view' : 'List view'; return; }
      else if (act === 'wp-close') { b.closest('tr.wrow').hidden = true; return; }
      else if (act === 'chkupd') { await checkUpdate(true); }
      else if (act === 'open-url') return T.opener.openUrl(b.dataset.url);
      else if (act === 'open-save') return T.opener.revealItemInDir(saveDir);
      else if (act === 'open-bak') { await fs.mkdir(bakDir, { recursive: true }); return T.opener.revealItemInDir(bakDir); }
    } catch (e) {
      if (act === 'batch-create' || act === 'mkedit' || act === 'inv-apply' || act === 'sh-apply' || act === 'tr-apply') { await ask('Could not create the copy', String(e && e.message || e) + '\n\nNothing was changed. Your edits are still here.', { ok: 'OK' }); return; }
      if (act === 'restore') {
        var rl = e && e.ro ? e.ro.slice(0, 8).map(function (f) { return f.split(/[\\/]/).slice(-2).join('\\'); }).join('\n') + (e.ro.length > 8 ? '\n...and ' + (e.ro.length - 8) + ' more' : '') : '';
        await ask('Restore failed', e && e.ro ? 'Nothing was changed. Windows has these files marked Read-only, so they cannot be replaced:\n\n' + rl + '\n\nRight-click each file, choose Properties, untick Read-only, then restore again.' : (restoreStarted ? 'Restore stopped part-way, so your save may be partly restored.\n\n' : 'Nothing was changed.\n\n') + niceErr(e) + (restoreStarted ? '\n\nClose the game and any program using the save folder, then try again. A copy of your save from before the restore is under Snapshots (tagged "Before restore").' : ''), { ok: 'OK' });
        render(); return;
      }
      toast('Error: ' + e); if (act === 'mkedit') return;
    }
    render();
  });
  document.addEventListener('change', async function (ev) {
    var srcMap = { esrc: ES, tsrc: TS, isrc: IS, ssrc: SS }, sm = srcMap[ev.target.id];
    if (sm && !(await leaveOk())) { ev.target.value = sm.src; return; }
    var cw = ev.target.dataset && ev.target.dataset.w;
    if (cw === 'q') { qUpdate(ev.target.closest('.trp')); return; }
    if (cw === 'wopt') { var ww = ev.target.closest('tr.wrow'); wsUpdate(ev.target); wbSync(ww, false); var wr = ww.previousElementSibling; if (wr && wr.dataset.rig === '1') { var wcc = wr.querySelector('.cc'), wp = Array.prototype.some.call(ww.querySelectorAll('select[data-w="wopt"]'), function (x) { return !!x.value; }); if (wcc && !wcc.querySelector('input')) wcc.innerHTML = wp ? '<span class="meta">100% on saving</span>' : '<span class="meta">n/a</span>'; else if (wcc) { var ci = wcc.querySelector('input'); if (ci) { var wasP = wr.dataset.plated === '1'; if (wp && !wasP) ci.value = 100; if (!wp) ci.value = 0; } } } return; }
    var eb0 = ev.target.closest('.eqbar');
    if (eb0) { if (ev.target.classList.contains('eqslot')) fillEqItems(eb0); else if (ev.target.classList.contains('eqitem')) fillEqAtt(eb0, false); return; }
    if (ev.target.id === 'warnunsaved') { WARN = ev.target.checked; localStorage.setItem('warnunsaved', WARN ? '1' : '0'); toast(WARN ? 'You will be warned about unsaved changes' : 'Warnings about unsaved changes are off'); return; }
    if (ev.target.id === 'xmags') { XMAGS = ev.target.checked; localStorage.setItem('xmags', XMAGS ? '1' : '0'); toast(XMAGS ? 'Same-ammo magazines will be offered' : 'Only the game\'s compatible magazines will be offered'); return; }
    if (cw === 'r') { var rtr = ev.target.closest('tr'), rbx = rtr && rtr.dataset.slot ? document.querySelector('.eqs[data-slot="' + rtr.dataset.slot + '"]') : null; if (rbx) rbx.classList.toggle('rm', ev.target.checked); }
    if (cw === 'c' || cw === 'a') { var row = ev.target.closest('tr'), isC = cw === 'c', nn = parseInt(ev.target.value, 10); if (isNaN(nn)) nn = +(isC ? row.dataset.ci : row.dataset.ai); ev.target.value = Math.min(isC ? 100 : (+ev.target.max > 0 ? +ev.target.max : Infinity), Math.max(isC || row.dataset.wp ? 0 : 1, nn)); }
    if (/^(esrc|tsrc|isrc|ssrc)$/.test(ev.target.id)) { setSource(ev.target.value); return; } if (ev.target.id === 'rsrc') { RS.src = ev.target.value; render(); } if (ev.target.id === 'skip') { localStorage.setItem('skip', ev.target.value); toast('Saved'); } if (ev.target.id === 'auto') { localStorage.setItem('auto', ev.target.checked ? '1' : '0'); startWatch(); } if (ev.target.dataset && ev.target.dataset.w === 'r') { var rr = ev.target.closest('tr'); if (rr) rr.classList.toggle('rm', ev.target.checked); } if (ev.target.id === 'updchk') { localStorage.setItem('updcheck', ev.target.checked ? '1' : '0'); } });

  document.addEventListener('input', function (ev) {
    var tw = ev.target.dataset && ev.target.dataset.w;
    if (tw === 'c' || tw === 'a') { var nv = ev.target.value; if (tw === 'c' && nv !== '' && +nv > 100) ev.target.value = 100; if (tw === 'a' && nv !== '' && +ev.target.max > 0 && +nv > +ev.target.max) ev.target.value = ev.target.max; if (nv !== '' && +nv < 0) ev.target.value = tw === 'c' ? 0 : 1; return; }
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
      checkUpdate(false);
      await fs.mkdir(bakDir, { recursive: true });
      await startWatch();
    } catch (e) { toast('Startup error: ' + e); }
    document.body.insertAdjacentHTML('beforeend', '<div id="pbar" hidden><span id="pcount"></span><button data-act="batch-create" class="pri">Create edited copy</button><button data-act="batch-discard">Discard all</button></div><datalist id="itemlist"></datalist>');
    ['input', 'change', 'click'].forEach(function (evn) { document.addEventListener(evn, schedPending); });
    document.addEventListener('change', function () { setTimeout(refreshInsp, 0); });
    document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') document.querySelectorAll('tr.wrow:not([hidden])').forEach(function (w) { w.hidden = true; }); });
    try {
      var cw0 = window.__TAURI__.window.getCurrentWindow();
      cw0.onCloseRequested(async function (ev) {
        if (noWarnOnce || !WARN || !pendingChanges()) return;
        ev.preventDefault();
        var okQuit = await ask('Quit with unsaved changes?', 'You have changes that are not in an edited copy yet. If you quit now they are lost.', { ok: 'Quit anyway' });
        if (!okQuit) return;
        try { await cw0.destroy(); } catch (e) { noWarnOnce = true; toast('Could not close from here: ' + e + '. Click the window close button again.'); }
      });
    } catch (e) { /* no window API: nothing to warn about */ }
    render();
  })();
})();
