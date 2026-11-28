const T = require('./lib/t')('edits: planInv (condition, quantity, remove, move, add, shared loose items)'), { boot } = require('./lib/boot'), fx = require('./lib/fixtures');
const B = boot(), { api, F, Tres, SAVE } = B, P = fx.P;
const put = (name, text) => { B.mk(SAVE); F[SAVE + '/' + name] = text; };
const reset = () => { put('Attic.tres', fx.attic()); put('Character.tres', fx.character()); };
const parse = (plan, f) => Tres.parse(plan.out[f]);
const names = (t) => t.subs().map(b => (/ExtResource\("([^"]+)"\)/.exec(t.get(b, 'itemData') || '') || [])[1]).filter(Boolean).map(id => Tres.itemName(t.extById(id).attrs.path)).sort();
const rd = async f => F[SAVE + '/' + f];
const refs = raw => Array.from(String(raw || '').matchAll(/SubResource\("([^"]+)"\)/g)).map(m => m[1]);
// every item a player can see: container and inventory slots (with what they hold) plus each loose item
function count(t) {
  const walk = id => { const b = t.subById(id); return b ? 1 + refs(t.get(b, 'storage')).reduce((n, c) => n + walk(c), 0) : 0; }; let n = 0, m = t.main();
  ['inventory', 'equipment'].forEach(k => { if (t.get(m, k) !== undefined) refs(t.get(m, k)).forEach(i => { n += walk(i); }); });
  refs(t.get(m, 'furnitures')).forEach(f => refs(t.get(t.subById(f), 'storage')).forEach(i => { n += walk(i); }));
  n += refs(t.get(m, 'items')).length; return n;
}
(async () => {
  reset();
  T.section('Condition and quantity');
  let p = await api.planInv(SAVE, [{ file: 'Attic.tres', rid: 'S_akm', sid: 'S_akm', name: 'AKM', cond: 50 }]), t = parse(p, 'Attic.tres');
  T.eq([p.edited, parseFloat(t.get(t.subById('S_akm'), 'condition'))], [1, 50], 'condition is changed');
  T.eq([t.get(t.subById('S_akm'), 'amount'), t.get(t.subById('S_akm'), 'chamber'), t.get(t.subById('S_akm'), 'mode')], ['12', 'true', '2'], 'nothing else about the item changes');
  p = await api.planInv(SAVE, [{ file: 'Attic.tres', rid: 'S_band', sid: 'S_band', name: 'Bandage', amt: 7 }]); t = parse(p, 'Attic.tres');
  T.eq(parseFloat(t.get(t.subById('S_band'), 'amount')), 7, 'quantity is changed');
  T.ok(t.serialize().split('\r\n').length === fx.attic().split('\r\n').length, 'an edit only rewrites the lines it changes');
  T.eq(F[SAVE + '/Attic.tres'], fx.attic(), 'the source file is never modified');
  T.section('Moving inside a container');
  p = await api.planInv(SAVE, [{ file: 'Attic.tres', rid: 'S_pill', sid: 'S_pill', name: 'Painkillers', gx: 192, gy: 128, rot: true }]); t = parse(p, 'Attic.tres');
  T.eq([t.get(t.subById('S_pill'), 'gridPosition'), t.get(t.subById('S_pill'), 'gridRotated')], ['Vector2(192, 128)', 'true'], 'position and rotation are written');
  T.section('Removing');
  p = await api.planInv(SAVE, [{ file: 'Attic.tres', rid: 'S_pill', sid: 'S_pill', name: 'Painkillers', remove: true }]); t = parse(p, 'Attic.tres');
  T.eq(p.removed, 1, 'one item removed'); T.ok(!t.subById('S_pill') && t.get(t.subById('FUR'), 'storage').indexOf('S_pill') === -1, 'the slot and its list entry are gone');
  T.ok(!t.ext().some(e => /Painkillers/.test(e.attrs.path)), 'the now-unused item file reference is dropped'); T.eq(t.validate().concat(t.checkOrder()), [], 'the result is valid');
  p = await api.planInv(SAVE, [{ file: 'Attic.tres', rid: 'S_bag', sid: 'S_bag', name: 'Bag', remove: true }]); t = parse(p, 'Attic.tres');
  T.eq(p.removed, 2, 'removing a bag counts the bag and what it held'); T.ok(!t.subById('S_inbag'), 'its contents are gone too');
  await T.throws(() => api.planInv(SAVE, [{ file: 'Attic.tres', rid: 'NOPE', sid: 'NOPE', name: 'Ghost', remove: true }]), /was not found/, 'removing something that no longer exists is an error, not silence');
  await T.throws(() => api.planInv(SAVE, [{ file: 'Attic.tres', rid: 'NOPE', sid: 'NOPE', name: 'Ghost', cond: 5 }]), /was not found/, 'editing something that no longer exists is an error');
  T.section('Loose items that share one slot block');
  p = await api.planInv(SAVE, [{ file: 'Attic.tres', rid: 'L1', sid: 'S_soup', name: 'Canned Soup', amt: 9 }]); t = parse(p, 'Attic.tres');
  const slotOf = id => /SubResource\("([^"]+)"\)/.exec(t.get(t.subById(id), 'slotData'))[1];
  T.ok(slotOf('L1') !== slotOf('L2'), 'editing one of two sharing items gives it its own block');
  T.eq([parseFloat(t.get(t.subById(slotOf('L1')), 'amount')), parseFloat(t.get(t.subById(slotOf('L2')), 'amount'))], [9, 2], 'the edited item has the new value and its neighbour keeps the old one');
  T.eq(t.validate().concat(t.checkOrder()), [], 'valid');
  p = await api.planInv(SAVE, [{ file: 'Attic.tres', rid: 'L1', sid: 'S_soup', name: 'Canned Soup', amt: 5 }, { file: 'Attic.tres', rid: 'L2', sid: 'S_soup', name: 'Canned Soup', amt: 6 }]); t = parse(p, 'Attic.tres');
  T.eq([parseFloat(t.get(t.subById(slotOf('L1')), 'amount')), parseFloat(t.get(t.subById(slotOf('L2')), 'amount'))], [5, 6], 'editing both gives each its own value');
  T.ok(slotOf('L1') !== slotOf('L2'), 'the two items no longer share a block'); T.eq(api.brokenIn(t, 'Attic.tres'), [], 'and nothing is left dangling'); T.eq(t.validate().concat(t.checkOrder()), [], 'valid');
  p = await api.planInv(SAVE, [{ file: 'Attic.tres', rid: 'L1', sid: 'S_soup', name: 'Canned Soup', remove: true }]); t = parse(p, 'Attic.tres');
  T.ok(!t.subById('L1') && !!t.subById('L2') && !!t.subById('S_soup'), 'removing one loose item keeps the shared block for the other'); T.eq(api.brokenIn(t, 'Attic.tres'), [], 'and nothing is left broken');
  p = await api.planInv(SAVE, [{ file: 'Attic.tres', rid: 'L1', sid: 'S_soup', name: 'x', remove: true }, { file: 'Attic.tres', rid: 'L2', sid: 'S_soup', name: 'x', remove: true }]); t = parse(p, 'Attic.tres');
  T.ok(!t.subById('S_soup') && !t.subById('L1') && !t.subById('L2'), 'removing both removes the block too'); T.eq(api.brokenIn(t, 'Attic.tres'), [], 'nothing broken');
  T.section('Adding a base-game item');
  p = await api.planInv(SAVE, [{ add: true, file: 'Attic.tres', cid: 'FUR', cname: 'Locker (Gray)', path: P.matches, name: 'Matches', amount: 20, cond: 0, col: 3, row: 4, rot: true, slot: '', att: [] }]); t = parse(p, 'Attic.tres');
  const nu = t.subs().filter(b => t.get(b, 'gridPosition') === 'Vector2(192, 256)')[0];
  T.ok(p.added === 1 && !!nu, 'the item is added at the chosen cell'); T.eq([t.get(nu, 'amount'), t.get(nu, 'gridRotated')], ['20', 'true'], 'with its quantity and rotation');
  T.ok(t.get(t.subById('FUR'), 'storage').indexOf(nu.attrs.id) > 0, 'and listed in the container'); T.eq(t.validate().concat(t.checkOrder()), [], 'the file stays valid and in the right order');
  T.eq(F[SAVE + '/Attic.tres'], fx.attic(), 'the source file is not modified');
  await T.throws(() => api.planInv(SAVE, [{ add: true, file: 'Attic.tres', cid: 'GONE', cname: 'Locker', path: P.matches, name: 'Matches', amount: 1, cond: 0, col: 0, row: 0, rot: false, slot: '', att: [] }]), /was not found/, 'adding to a container that no longer exists is an error');
  T.section('Adding to the carried inventory and equipment');
  p = await api.planInv(SAVE, [{ add: true, file: 'Character.tres', cid: '__inv', cname: 'Inventory', path: P.pills, name: 'Painkillers', amount: 1, cond: 0, col: 1, row: 1, rot: false, slot: '', att: [] }]); t = parse(p, 'Character.tres');
  T.eq(names(t).filter(n => n === 'Painkillers').length, 1, 'a new item appears in the inventory'); T.eq(t.get(t.main(), 'inventory').split('SubResource').length - 1, 2, 'the inventory list has one more entry');
  T.section('Moving between containers and files (copy everything, remove the original)');
  F[SAVE + '/Attic.tres'] = fx.attic(); F[SAVE + '/Character.tres'] = fx.character();
  p = await api.planInv(SAVE, [{ file: 'Attic.tres', rid: 'S_akm', sid: 'S_akm', name: 'AKM', remove: true, movedTo: 'Inventory' }, { add: true, file: 'Character.tres', cid: '__inv', cname: 'Inventory', path: P.akm, name: 'AKM', amount: NaN, cond: NaN, col: 2, row: 2, rot: false, slot: '', att: [], from: { file: 'Attic.tres', sid: 'S_akm' } }], rd);
  const ta = parse(p, 'Attic.tres'), tc = parse(p, 'Character.tres'); const moved = tc.subs().filter(b => tc.get(b, 'gridPosition') === 'Vector2(128, 128)')[0];
  T.ok(!ta.subById('S_akm'), 'the original is removed'); T.eq([tc.get(moved, 'condition'), tc.get(moved, 'amount'), tc.get(moved, 'mode'), tc.get(moved, 'chamber')], ['89.4233', '12', '2', 'true'], 'the copy keeps condition, ammo, mode and chamber exactly');
  T.ok(/PBS/.test(tc.ext().map(e => e.attrs.path).join()) && tc.get(moved, 'nested').indexOf('ExtResource') > 0, 'and its attachment'); T.eq([p.removed, p.added], [0, 1], 'a move counts as a move, not as a removal');
  T.eq(names(ta).concat(names(tc)).filter(n => n === 'AKM').length, 1, 'there is still exactly one AKM in total');
  await T.throws(() => api.planInv(SAVE, [{ add: true, file: 'Character.tres', cid: '__inv', cname: 'Inventory', path: P.bag, name: 'Bag', amount: NaN, cond: NaN, col: 0, row: 5, rot: false, slot: '', att: [], from: { file: 'Attic.tres', sid: 'S_bag' } }], rd), /holds other items/, 'an item that holds other items is refused (not silently emptied)');
  T.section('Weapon attachments and chamber');
  p = await api.planInv(SAVE, [{ weapon: true, file: 'Attic.tres', sid: 'S_akm', name: 'AKM', attOut: [P.pbs], attIn: [P.optic], chamber: false }]); t = parse(p, 'Attic.tres');
  const nest = t.get(t.subById('S_akm'), 'nested'); T.ok(nest.indexOf('ExtResource') > 0 && /Optic/.test(t.ext().map(e => e.attrs.path).join()) && !/PBS/.test(t.ext().map(e => e.attrs.path).join()), 'the suppressor is swapped for the optic and the unused reference is dropped');
  T.eq(t.get(t.subById('S_akm'), 'chamber'), 'false', 'chamber is set'); T.eq(t.validate().concat(t.checkOrder()), [], 'valid');
  T.section('Conservation under random mixed batches (fixed seeds)');
  let bad = 0;
  for (let seed = 1; seed <= 20; seed++) {
    let s = seed * 7919; const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296, ri = n => Math.floor(rnd() * n);
    const edits = []; let removedN = 0, addedN = 0;
    if (rnd() < 0.6) { edits.push({ file: 'Attic.tres', rid: 'S_pill', sid: 'S_pill', name: 'Painkillers', remove: true }); removedN++; }
    if (rnd() < 0.5) { edits.push({ file: 'Attic.tres', rid: 'S_band', sid: 'S_band', name: 'Bandage', amt: 1 + ri(9), cond: ri(100) }); }
    if (rnd() < 0.5) { edits.push({ file: 'Attic.tres', rid: 'L3', sid: 'S_batt', name: 'Batteries', cond: ri(100) }); }
    if (rnd() < 0.5) { edits.push({ file: 'Attic.tres', rid: 'L1', sid: 'S_soup', name: 'Canned Soup', amt: 1 + ri(5) }); }
    const k = ri(4); for (let i = 0; i < k; i++) { edits.push({ add: true, file: i % 2 ? 'Character.tres' : 'Attic.tres', cid: i % 2 ? '__inv' : 'FUR', cname: 'c', path: [P.matches, P.pills, P.bandage][ri(3)], name: 'x', amount: 1 + ri(9), cond: 0, col: ri(8), row: ri(13), rot: rnd() < 0.5, slot: '', att: [] }); addedN++; }
    F[SAVE + '/Attic.tres'] = fx.attic(); F[SAVE + '/Character.tres'] = fx.character();
    if (!edits.length) continue;
    let q; try { q = await api.planInv(SAVE, edits); } catch (e) { bad++; console.log('  seed', seed, 'threw', e.message); continue; }
    const before = count(Tres.parse(fx.attic())) + count(Tres.parse(fx.character()));
    const after = Object.keys(q.out).reduce((n, f) => n + count(Tres.parse(q.out[f])), 0) + (q.out['Attic.tres'] ? 0 : count(Tres.parse(fx.attic()))) + (q.out['Character.tres'] ? 0 : count(Tres.parse(fx.character())));
    const ok = after === before - removedN + addedN && Object.keys(q.out).every(f => { const x = Tres.parse(q.out[f]); return x.validate().concat(x.checkOrder()).length === 0 && x.serialize() === q.out[f]; });
    if (!ok) { bad++; console.log('  seed', seed, 'before', before, 'after', after, 'removed', removedN, 'added', addedN); }
  }
  T.ok(bad === 0, '20 random batches: item counts conserved, every file valid and lossless');
  T.done();
})().catch(e => { console.log('ERROR', e); process.exit(1); });
