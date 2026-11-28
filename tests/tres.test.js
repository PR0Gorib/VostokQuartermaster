const T = require('./lib/t')('tres.js: parser and serializer'), { boot } = require('./lib/boot'), fx = require('./lib/fixtures');
const B = boot(), Tres = B.Tres;
(async () => {
  T.section('Lossless round trip');
  const samples = { attic: fx.attic(), cabin: fx.cabin(), character: fx.character(), world: fx.world(), traders: fx.traders(['Prime Time'], ['Prime_Time']), damaged: fx.damaged(),
    lf: '[gd_resource type="Resource" format=3]\n\n[resource]\na = 1\n', noEol: '[gd_resource type="Resource" format=3]\r\n\r\n[resource]\r\na = 1', empty: '', bom: '\ufeff[gd_resource type="Resource" format=3]\r\n\r\n[resource]\r\na = 1\r\n',
    multiline: '[gd_resource type="Resource" format=3]\r\n\r\n[resource]\r\ntxt = "line1\r\nline2"\r\nz = 2\r\n' };
  for (const k of Object.keys(samples)) T.ok(Tres.parse(samples[k]).serialize() === samples[k], k + ' parses and serializes to identical text');
  T.section('Validation');
  for (const k of ['attic', 'cabin', 'character', 'world', 'traders']) { const t = Tres.parse(samples[k]); T.eq(t.validate().concat(t.checkOrder()), [], k + ' validates with no problems'); }
  T.ok(Tres.parse(fx.damaged()).validate().length > 0, 'a file with a dangling reference is reported by validate()');
  const dup = Tres.parse(fx.attic().replace('id="L2"', 'id="L1"')); T.ok(dup.validate().length > 0, 'a duplicate sub-resource id is reported');
  const late = fx.attic().replace('[sub_resource type="Resource" id="FUR"]', '[sub_resource type="Resource" id="EARLY"]\r\nscript = ExtResource("30")\r\nstorage = Array[ExtResource("1")]([SubResource("LATE")])\r\n\r\n[sub_resource type="Resource" id="LATE"]\r\nscript = ExtResource("1")\r\n\r\n[sub_resource type="Resource" id="FUR"]');
  T.ok(Tres.parse(late).checkOrder().length > 0, 'a sub-resource used before it is defined is reported by checkOrder()');
  T.section('Reading and writing values');
  let t = Tres.parse(fx.attic()), m = t.main();
  T.eq(t.get(t.subById('S_akm'), 'condition'), '89.4233', 'get() returns the raw text of a value');
  T.eq(t.get(m, 'nothere'), undefined, 'get() of a missing key is undefined');
  t.set(t.subById('S_akm'), 'condition', '50.0'); T.has(t.serialize(), 'condition = 50.0\r\n', 'set() rewrites one line and keeps CRLF');
  T.eq(t.serialize().split('\r\n').length, fx.attic().split('\r\n').length, 'set() does not add or remove lines');
  t.insert(m, 'extra', '5', 'lastVisit'); T.eq(t.keys(m).slice(0, 4), ['script', 'initialVisit', 'lastVisit', 'extra'], 'insert() places a key after the one named');
  T.section('Ids and resources');
  t = Tres.parse(fx.attic());
  const a = t.newSubId(), b2 = t.newSubId(); T.ok(a && !t.subById(a), 'newSubId() gives an unused id');
  const e1 = t.extFor(fx.P.akm, 'Resource'); T.eq(e1, '4', 'extFor() reuses an existing resource');
  const e2 = t.extFor('res://Items/New/New.tres', 'Resource'); T.ok(!!e2 && t.extById(e2).attrs.path === 'res://Items/New/New.tres', 'extFor() adds a new resource');
  T.eq(t.extFor('res://Items/New/New.tres', 'Resource'), e2, 'asking again returns the same id');
  T.section('Removing slots, including shared ones (the old Remove bug)');
  t = Tres.parse(fx.attic()); let r = t.removeSlot('L1');
  T.ok(!t.subById('L1') && !!t.subById('S_soup'), 'removing one of two loose items sharing a slot block keeps the block for the other');
  T.eq(t.validate(), [], 'the file is still valid');
  r = t.removeSlot('L2'); T.ok(!t.subById('L2') && !t.subById('S_soup'), 'removing the last user of the shared block removes the block too');
  T.eq(t.validate(), [], 'still valid after removing both');
  t = Tres.parse(fx.attic()); t.removeSlot('S_bag'); T.ok(!t.subById('S_bag') && !t.subById('S_inbag'), 'removing a container item also removes what it holds');
  T.ok(t.get(t.subById('FUR'), 'storage').indexOf('S_bag') === -1, 'and its entry in the furniture storage list');
  T.eq(t.validate(), [], 'valid after removing a bag with contents');
  T.section('Removing everything that uses a mod');
  t = Tres.parse(fx.cabin()); const vid = t.ext().filter(e => /VIKEA/.test(e.attrs.path))[0].attrs.id;
  T.eq(t.dependencies().filter(d => d.mod).map(d => d.mod).sort(), ['CashMoney', 'VIKEA'], 'dependencies() lists the mods the file needs');
  t.removeItemsUsing(vid); T.ok(!/VIKEA/.test(t.serialize()), 'nothing mentioning the removed mod is left'); T.eq(t.validate(), [], 'the file is valid afterwards');
  T.ok(Tres.modOf('res://mods/VIKEA/x.tres') === 'VIKEA' && Tres.modOf('res://Items/a.tres') === null, 'modOf() tells mod paths from game paths');
  T.eq(Tres.itemName('res://Items/Medical/Painkillers/Painkillers.tres'), 'Painkillers', 'itemName() reads the file name');
  T.done();
})().catch(e => { console.log('ERROR', e); process.exit(1); });
