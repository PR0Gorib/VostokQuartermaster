const T = require('./lib/t')('rescue box: items saved from removed mod furniture'), { boot } = require('./lib/boot'), fx = require('./lib/fixtures');
const B = boot(), { api, F, D, Tres, SAVE, BAK, w } = B, P = fx.P, BOX = '/appdata/vq/rescue-box.json';
const put = (n, txt) => { F[SAVE + '/' + n] = txt; };
const snapFiles = () => Object.keys(F).filter(k => k.indexOf(BAK + '/') === 0 && /\/data\//.test(k));
const snapDirs = () => Object.keys(D).filter(k => /\/backups\/[^/]+$/.test(k)).length;
(async () => {
  put('Cabin.tres', fx.cabin()); put('Attic.tres', fx.attic());
  T.section('Saving the items when the cleaned copy is made');
  let r = await api.cleanTo(SAVE, 'Cleaned: VIKEA', ['VIKEA'], false, [], 'live'); T.ok(!(BOX in F), 'nothing is written when the box is not ticked');
  r = await api.cleanTo(SAVE, 'Cleaned: VIKEA', ['VIKEA'], false, ['VIKEA'], 'live'); T.eq(r.rescued, 2, 'two items saved when it is ticked');
  let box = await api.rescueLoad(); const ak = box.filter(x => /AKM/.test(x.path))[0], bd = box.filter(x => /Bandage/.test(x.path))[0];
  T.ok(box.length === 2 && ak && bd, 'the box holds the AKM and the Bandage, not the item from another mod');
  T.eq([ak.cond, ak.amt, ak.mode, ak.chamber, ak.nested.length, /PBS/.test(ak.nested[0])], ['89.4233', '12', '2', 'true', 1, true], 'the AKM keeps exact condition, ammo, mode, chamber and its suppressor (and not the ItemData script)');
  T.eq([ak.mod, ak.from], ['VIKEA', 'Cleaned: VIKEA'], 'each entry notes the mod and where it came from');
  r = await api.cleanTo(SAVE, 'Cleaned: VIKEA', ['VIKEA'], false, ['VIKEA'], 'live'); T.eq([r.rescued, r.already, (await api.rescueLoad()).length], [0, 2, 2], 'cleaning the same save again does not add them twice');
  T.eq(F[SAVE + '/Cabin.tres'], fx.cabin(), 'the live save is unchanged');
  T.section('A damaged or unwritable box never costs you items');
  const good = F[BOX]; F[BOX] = '{oops'; const before = snapDirs();
  await T.throws(() => api.cleanTo(SAVE, 'Cleaned: VIKEA', ['VIKEA'], false, ['VIKEA'], 'other'), /Rescue box/, 'a corrupt box stops the cleaning with a clear error');
  T.ok(snapDirs() === before && F[BOX] === '{oops', 'no stray snapshot is left and the damaged file is not overwritten'); F[BOX] = good;
  T.section('Putting an item from the box into a container (planInv)');
  put('Attic.tres', fx.attic()); put('Character.tres', fx.character());
  const ent = (await api.rescueLoad()).filter(x => /AKM/.test(x.path))[0];
  const edit = (file, cid, col, row, rot, id) => ({ add: true, file, cid, cname: 'c', path: ent.path, name: 'AKM', amount: +ent.amt, cond: +ent.cond, col, row, rot, slot: '', att: [], from: null, boxId: id, box: ent });
  let p = await api.planInv(SAVE, [edit('Attic.tres', 'FUR', 3, 2, true, ent.id)]), t = Tres.parse(p.out['Attic.tres']), nb = t.subs().filter(b => t.get(b, 'gridPosition') === 'Vector2(192, 128)')[0];
  T.ok(p.added === 1 && !!nb, 'it is written at the dropped cell'); T.eq([t.get(nb, 'condition'), t.get(nb, 'amount'), t.get(nb, 'mode'), t.get(nb, 'chamber'), t.get(nb, 'gridRotated')], ['89.4233', '12', '2', 'true', 'true'], 'with exact condition, ammo, mode, chamber and rotation');
  T.ok(/PBS/.test(t.ext().filter(e => t.get(nb, 'nested').indexOf('"' + e.attrs.id + '"') >= 0).map(e => e.attrs.path).join()), 'and its attachment'); T.eq(t.validate().concat(t.checkOrder()), [], 'the file validates');
  T.section('Fuzz: 150 random batches of box drops into a shelter container and the inventory');
  let seed = 12345; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296, ri = n => Math.floor(rnd() * n), fails = [];
  const POOL = [{ path: P.akm, cond: '89.4233', amt: '12', mode: '2', chamber: 'true', nested: [P.pbs, P.optic] }, { path: P.bandage, cond: '100', amt: '3', mode: '1', chamber: 'false', nested: [] }, { path: 'res://Items/Ammo/545/545.tres', cond: '0', amt: '60', mode: '1', chamber: 'false', nested: [] }, { path: 'res://Items/Weapons/MP5/MP5.tres', cond: '0.5', amt: '0', mode: '1', chamber: 'true', nested: [P.pbs] }];
  for (let it = 0; it < 150; it++) {
    const n = 1 + ri(6), edits = [];
    for (let k = 0; k < n; k++) { const e = POOL[ri(POOL.length)], inv = rnd() < 0.5; edits.push({ add: true, file: inv ? 'Character.tres' : 'Attic.tres', cid: inv ? '__inv' : 'FUR', cname: 'c', path: e.path, name: 'x', amount: +e.amt, cond: +e.cond, col: ri(8), row: ri(13), rot: rnd() < 0.5, slot: '', att: [], from: null, boxId: 'b' + it + k, box: Object.assign({ position: '0', zoom: '1', casing: 'false', state: '""' }, e) }); }
    let q; try { q = await api.planInv(SAVE, edits); } catch (e) { fails.push('it ' + it + ' threw ' + e.message); continue; }
    if (q.added !== n) fails.push('it ' + it + ' added ' + q.added + ' of ' + n);
    for (const fn of Object.keys(q.out)) {
      const x = Tres.parse(q.out[fn]); if (x.validate().concat(x.checkOrder()).length) fails.push('it ' + it + ' ' + fn + ' invalid'); if (x.serialize() !== q.out[fn]) fails.push('it ' + it + ' not lossless');
      const sid = {}, eid = {}; x.subs().forEach(b => { if (sid[b.attrs.id]) fails.push('dup sub'); sid[b.attrs.id] = 1; }); x.ext().forEach(b => { if (eid[b.attrs.id]) fails.push('dup ext'); eid[b.attrs.id] = 1; });
    }
    for (const e of edits) { const x = Tres.parse(q.out[e.file]); if (!x.subs().some(b => x.get(b, 'gridPosition') === 'Vector2(' + e.col * 64 + ', ' + e.row * 64 + ')' && x.get(b, 'condition') === e.box.cond && x.get(b, 'amount') === e.box.amt && x.get(b, 'gridRotated') === String(e.rot))) fails.push('it ' + it + ' item missing'); }
  }
  T.eq(fails.slice(0, 5), [], 'all valid, lossless, with exact values and no duplicate ids');
  T.done();
})().catch(e => { console.log('ERROR', e); process.exit(1); });
