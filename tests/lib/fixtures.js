// Synthetic save files (CRLF, like the game writes them). Ids here are readable; the game uses random ones, which the app never relies on.
const crlf = s => s.replace(/\n/g, '\r\n');
const ext = (id, type, p) => `[ext_resource type="${type}" path="${p}" id="${id}"]\n`;
function slot(id, itemExt, o) {
  o = Object.assign({ cond: '100', amt: '1', x: 0, y: 0, rot: false, nested: [], storage: [], mode: '1', chamber: 'false', slot: '' }, o || {});
  return `[sub_resource type="Resource" id="${id}"]
script = ExtResource("1")
itemData = ExtResource("${itemExt}")
nested = Array[ExtResource("2")]([${o.nested.map(n => 'ExtResource("' + n + '")').join(', ')}])
storage = Array[ExtResource("1")]([${o.storage.map(s => 'SubResource("' + s + '")').join(', ')}])
condition = ${o.cond}
amount = ${o.amt}
position = 0
mode = ${o.mode}
zoom = 1
chamber = ${o.chamber}
casing = false
state = ""
gridPosition = Vector2(${o.x * 64}, ${o.y * 64})
gridRotated = ${o.rot}
slot = "${o.slot}"

`;
}
const P = { akm: 'res://Items/Weapons/AKM/AKM.tres', pbs: 'res://Items/Attachments/PBS/PBS.tres', optic: 'res://Items/Attachments/Optic/Optic.tres', bandage: 'res://Items/Medical/Bandage/Bandage.tres', pills: 'res://Items/Medical/Painkillers/Painkillers.tres',
  soup: 'res://Items/Consumables/Canned_Soup/Canned_Soup.tres', batt: 'res://Items/Electronics/Batteries/Batteries.tres', matches: 'res://Items/Misc/Matches/Matches.tres', bag: 'res://Items/Backpacks/Bag/Bag.tres', vest: 'res://Items/Armor/Vest/Vest.tres',
  locker: 'res://Assets/Locker/Locker_F.tres', vikeaLocker: 'res://mods/VIKEA/Assets/Locker_Blue/Locker_Blue_F.tres', euro: 'res://mods/CashMoney/Items/Money/Stack_Euro_1/Stack_Euro_1.tres' };

// A shelter with one base-game locker (AKM with a suppressor, bandages, painkillers, a bag holding a bandage) and three loose items,
// two of which share ONE slot block (the real saves do this).
function attic() {
  return crlf(`[gd_resource type="Resource" script_class="ShelterSave" format=3]

[ext_resource type="Script" path="res://Scripts/SlotData.gd" id="1"]
[ext_resource type="Script" path="res://Scripts/ItemData.gd" id="2"]
` + ext(3, 'Resource', P.locker) + ext(4, 'Resource', P.akm) + ext(5, 'Resource', P.pbs) + ext(6, 'Resource', P.bandage) + ext(7, 'Resource', P.pills) + ext(8, 'Resource', P.soup) + ext(9, 'Resource', P.batt) + ext(10, 'Resource', P.bag) + `[ext_resource type="Script" path="res://Scripts/FurnitureSave.gd" id="30"]
[ext_resource type="Script" path="res://Scripts/ShelterSave.gd" id="31"]
[ext_resource type="Script" path="res://Scripts/ItemSave.gd" id="32"]

` + slot('S_akm', 4, { cond: '89.4233', amt: '12', x: 0, y: 0, nested: [5], mode: '2', chamber: 'true' }) + slot('S_band', 6, { amt: '3', x: 6, y: 0 }) + slot('S_pill', 7, { amt: '1', x: 7, y: 0 }) +
  slot('S_inbag', 6, { amt: '2', x: 0, y: 0 }) + slot('S_bag', 10, { cond: '100', amt: '0', x: 0, y: 3, storage: ['S_inbag'] }) +
  slot('S_soup', 8, { amt: '2', cond: '100' }) + slot('S_batt', 9, { cond: '60', amt: '1' }) +
  `[sub_resource type="Resource" id="L1"]
script = ExtResource("32")
name = "Canned Soup"
slotData = SubResource("S_soup")
position = Vector3(1, 0, 1)
rotation = Vector3(0, 0, 0)

[sub_resource type="Resource" id="L2"]
script = ExtResource("32")
name = "Canned Soup"
slotData = SubResource("S_soup")
position = Vector3(2, 0, 1)
rotation = Vector3(0, 0, 0)

[sub_resource type="Resource" id="L3"]
script = ExtResource("32")
name = "Batteries"
slotData = SubResource("S_batt")
position = Vector3(3, 0, 1)
rotation = Vector3(0, 0, 0)

[sub_resource type="Resource" id="FUR"]
script = ExtResource("30")
name = "Locker (Gray)"
container = true
itemData = ExtResource("3")
storage = Array[ExtResource("1")]([SubResource("S_akm"), SubResource("S_band"), SubResource("S_pill"), SubResource("S_bag")])
gridPosition = Vector2(0, 0)
gridRotated = false

[resource]
script = ExtResource("31")
initialVisit = false
lastVisit = 1
furnitures = Array[ExtResource("30")]([SubResource("FUR")])
items = Array[ExtResource("32")]([SubResource("L1"), SubResource("L2"), SubResource("L3")])
`);
}
// A cabin whose Blue locker comes from the mod VIKEA (holding two base-game items and one item from the mod CashMoney)
function cabin() {
  return crlf(`[gd_resource type="Resource" script_class="ShelterSave" format=3]

[ext_resource type="Script" path="res://Scripts/SlotData.gd" id="1"]
[ext_resource type="Script" path="res://Scripts/ItemData.gd" id="2"]
` + ext(3, 'Resource', P.vikeaLocker) + ext(4, 'Resource', P.akm) + ext(5, 'Resource', P.pbs) + ext(6, 'Resource', P.bandage) + ext(7, 'Resource', P.euro) + `[ext_resource type="Script" path="res://Scripts/FurnitureSave.gd" id="30"]
[ext_resource type="Script" path="res://Scripts/ShelterSave.gd" id="31"]

` + slot('V_akm', 4, { cond: '89.4233', amt: '12', nested: [5], mode: '2', chamber: 'true' }) + slot('V_band', 6, { amt: '3', x: 6 }) + slot('V_euro', 7, { cond: '0', amt: '50', x: 2 }) +
  `[sub_resource type="Resource" id="VFUR"]
script = ExtResource("30")
name = "Locker (Blue)"
container = true
itemData = ExtResource("3")
storage = Array[ExtResource("1")]([SubResource("V_akm"), SubResource("V_band"), SubResource("V_euro")])
gridPosition = Vector2(0, 0)
gridRotated = false

[resource]
script = ExtResource("31")
initialVisit = false
lastVisit = 1
furnitures = Array[ExtResource("30")]([SubResource("VFUR")])
`);
}
function character(o) {
  o = Object.assign({ health: '71.27766353875496', day: 14 }, o || {});
  return crlf(`[gd_resource type="Resource" script_class="CharacterSave" format=3]

[ext_resource type="Script" path="res://Scripts/SlotData.gd" id="1"]
[ext_resource type="Script" path="res://Scripts/ItemData.gd" id="2"]
[ext_resource type="Script" path="res://Scripts/CharacterSave.gd" id="9"]
` + ext(10, 'Resource', P.matches) + ext(11, 'Resource', P.vest) + `
` + slot('C_match', 10, { amt: '20', x: 0, y: 0 }) + slot('C_vest', 11, { cond: '75', amt: '0', slot: 'Vest' }) + `[resource]
script = ExtResource("9")
health = ${o.health}
energy = 64.2
hydration = 41.43
temperature = 100.0
mental = 77.75
reputation = 62.0
cat = 100.0
catFound = false
catDead = false
bodyStamina = 100.0
armStamina = 100.0
overweight = false
starvation = false
dehydration = true
bleeding = false
fracture = false
burn = false
poisoning = false
frostbite = false
insanity = false
rupture = false
headshot = false
initialSpawn = false
inventory = Array[ExtResource("1")]([SubResource("C_match")])
equipment = Array[ExtResource("1")]([SubResource("C_vest")])
catalog = Array[ExtResource("1")]([])
primary = false
secondary = false
knife = false
grenade1 = false
grenade2 = false
flashlight = false
NVG = false
weaponPosition = 1
`);
}
function world(o) {
  o = Object.assign({ day: 14, time: '1267.6', weather: 'Fog', difficulty: 3, season: 2 }, o || {});
  return crlf(`[gd_resource type="Resource" script_class="WorldSave" format=3]

[ext_resource type="Script" path="res://Scripts/WorldSave.gd" id="1"]

[resource]
script = ExtResource("1")
difficulty = ${o.difficulty}
season = ${o.season}
day = ${o.day}
time = ${o.time}
weather = "${o.weather}"
weatherTime = 500.0
shelters = 0
nomadsRemaining = 74
`);
}
const TASK = n => 'res://Resources/Tasks/Traders/Generalist/' + n + '.tres';
function traders(done, notes) {
  done = done || []; notes = notes || [];
  return crlf(`[gd_resource type="Resource" script_class="TraderSave" format=3]

[ext_resource type="Script" path="res://Scripts/TraderSave.gd" id="1"]
[ext_resource type="Script" path="res://Resources/TaskData.gd" id="2"]
` + notes.map((n, i) => ext(20 + i, 'Resource', TASK(n))).join('') + `
[resource]
script = ExtResource("1")
generalist = Array[String]([${done.map(d => '"' + d + '"').join(', ')}])
doctor = Array[String]([])
gunsmith = Array[String]([])
driver = Array[String]([])
hunter = Array[String]([])
taskNotes = Array[ExtResource("2")]([${notes.map((n, i) => 'ExtResource("' + (20 + i) + '")').join(', ')}])
`);
}
// the damage the old Remove bug could leave: one loose item whose slot block is gone, and a list pointing at a block that is not in the file
function damaged() {
  return attic().replace(/\[sub_resource type="Resource" id="S_batt"\][\s\S]*?\r\n\r\n/, '').replace('SubResource("S_pill"), SubResource("S_bag")', 'SubResource("S_pill"), SubResource("S_bag"), SubResource("S_GHOST")');
}
module.exports = { crlf, attic, cabin, character, world, traders, damaged, P, TASK, slot };
