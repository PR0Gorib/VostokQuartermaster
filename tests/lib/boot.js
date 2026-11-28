// Loads the real index.html scripts (tres.js, pck.js, app.js) in jsdom with a mock Tauri API backed by an in-memory file system.
const fs = require('fs'), path = require('path');
function findSrc() {
  const c = [process.env.VQ_SRC, path.join(process.cwd(), 'src'), process.cwd(), path.join(__dirname, '..', '..', 'src'), path.join(__dirname, '..', '..')].filter(Boolean);
  for (const d of c) if (fs.existsSync(path.join(d, 'app.js')) && fs.existsSync(path.join(d, 'tres.js'))) return d;
  throw new Error('Cannot find app.js. Run from the repository root, or set VQ_SRC to the folder that holds app.js.');
}
const norm = p => String(p).replace(/\\/g, '/').replace(/\/+$/, ''), par = p => p.slice(0, p.lastIndexOf('/'));
function boot(extra) {
  const { JSDOM } = require('jsdom'), SRC = findSrc();
  const html = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8').replace(/<script src[^>]*><\/script>/g, '');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/' }), w = dom.window;
  const F = {}, D = {}, RO = {}, mk = p => { p = norm(p); while (p && !D[p]) { D[p] = 1; p = par(p); } };
  w.__TAURI__ = { fs: {
    exists: async p => { p = norm(p); return p in F || !!D[p]; },
    readTextFile: async p => { p = norm(p); if (!(p in F)) throw new Error('ENOENT ' + p); return F[p]; },
    writeTextFile: async (p, t) => { p = norm(p); mk(par(p)); F[p] = t; },
    readDir: async p => { p = norm(p) + '/'; const seen = {}, out = []; Object.keys(F).concat(Object.keys(D)).forEach(k => { if (k.indexOf(p) !== 0 || k === p) return; const n = k.slice(p.length).split('/')[0]; if (seen[n]) return; seen[n] = 1; out.push({ name: n, isDirectory: !!D[p + n] }); }); return out; },
    stat: async p => ({ size: (F[norm(p)] || '').length, readonly: !!RO[norm(p)] }),
    mkdir: async p => mk(p), copyFile: async (a, b) => { mk(par(norm(b))); F[norm(b)] = F[norm(a)]; },
    remove: async p => { p = norm(p); Object.keys(F).forEach(k => { if (k === p || k.indexOf(p + '/') === 0) delete F[k]; }); Object.keys(D).forEach(k => { if (k === p || k.indexOf(p + '/') === 0) delete D[k]; }); },
    rename: async (a, b) => { a = norm(a); b = norm(b); Object.keys(F).forEach(k => { if (k === a || k.indexOf(a + '/') === 0) { F[b + k.slice(a.length)] = F[k]; delete F[k]; } }); Object.keys(D).forEach(k => { if (k === a || k.indexOf(a + '/') === 0) { D[b + k.slice(a.length)] = 1; delete D[k]; } }); mk(b); },
    watch: async () => () => {} },
    path: { dataDir: async () => '/data', appDataDir: async () => '/appdata/vq' } };
  for (const f of ['tres.js', 'pck.js']) w.eval(fs.readFileSync(path.join(SRC, f), 'utf8'));
  let src = fs.readFileSync(path.join(SRC, 'app.js'), 'utf8');
  const marker = '/* ---------- start ---------- */';
  if (src.indexOf(marker) < 0) throw new Error('app.js no longer contains the start marker comment the tests hook into: ' + marker);
  src = src.replace(marker, 'window.__vq = { planInv: planInv, planTraders: planTraders, brokenIn: brokenIn, repairBroken: repairBroken, scanDir: scanDir, cleanTo: cleanTo, rescueLoad: rescueLoad, rescueSave: rescueSave, snap: snap, restore: restore, list: list, cleanName: cleanName, uniqueName: uniqueName, skipList: skipList, cmpHtml: cmpHtml, rawOf: rawOf, renderRepair: renderRepair,' +
    ' setKeep: function (n) { KEEP_AUTO = n; }, setDirs: function (o) { if (o.bak !== undefined) bakDir = o.bak; if (o.mods !== undefined) modsDir = o.mods; if (o.box !== undefined) rescueFile = o.box; if (o.save !== undefined) saveDir = o.save; } }; return;');
  w.eval(src);
  const api = w.__vq;
  api.setDirs({ bak: '/appdata/vq/backups', mods: '/game/mods', box: '/appdata/vq/rescue-box.json', save: '/data/Road to Vostok' });
  mk('/data/Road to Vostok'); mk('/game/mods'); mk('/appdata/vq/backups');
  return { w, api, F, D, RO, mk, Tres: w.Tres, SAVE: '/data/Road to Vostok', BAK: '/appdata/vq/backups', SRC };
}
module.exports = { boot, norm };
