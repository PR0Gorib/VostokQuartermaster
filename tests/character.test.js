const T = require('./lib/t')('character and world: field values (rawOf)'), { boot } = require('./lib/boot');
const B = boot(), { api } = B, raw = (t, v, label) => api.rawOf({ t, v, label: label || 'Field' });
(async () => {
  T.section('Meters (0 to 100, written the way the game writes them)');
  T.eq(raw('num', '50'), '50.0', 'a whole number gets one decimal'); T.eq(raw('num', '71.27766353875496'), '71.2777', 'long decimals are rounded to 4 places');
  T.eq(raw('num', '150'), '100.0', 'above 100 is clamped'); T.eq(raw('num', '-5'), '0.0', 'below 0 is clamped'); T.eq(raw('num', '0'), '0.0', 'zero');
  await T.throws(async () => raw('num', 'abc', 'Health'), /Health is not a number/, 'text is refused with the field name');
  T.section('Switches, text, whole numbers');
  T.eq(raw('bool', 'true'), 'true', 'booleans pass through'); T.eq(raw('str', 'Fog'), '"Fog"', 'text is quoted'); T.eq(raw('str', 'a"b\\c'), '"abc"', 'quotes and backslashes are removed from text');
  T.eq(raw('int', '14'), '14', 'day as a whole number'); await T.throws(async () => raw('int', '0', 'Day'), /Day must be 1 or more/, 'day 0 is refused'); await T.throws(async () => raw('int', 'x'), /must be 1 or more/, 'day as text is refused');
  T.eq(raw('int0', '0'), '0', 'Nomads can be 0'); T.eq(raw('int0', '100'), '100', 'and 100'); await T.throws(async () => raw('int0', '101', 'Nomads'), /between 0 and 100/, '101 is refused'); await T.throws(async () => raw('int0', '-1', 'Nomads'), /between 0 and 100/, 'negative is refused');
  T.section('Time of day (stored as hours x 100 with a decimal fraction)');
  T.eq(raw('time', '12:00'), '1200.0', '12:00'); T.eq(raw('time', '00:00'), '0.0', 'midnight'); T.eq(raw('time', '23:30'), '2350.0', '23:30');
  T.eq(parseFloat(raw('time', '12:40')).toFixed(1), '1266.7', '12:40 rounds up so the game never shows the minute before');
  await T.throws(async () => raw('time', 'noon'), /Time is not valid/, 'a bad time is refused'); await T.throws(async () => raw('mystery', '1'), /Unknown field type/, 'an unknown field type is refused');
  T.done();
})().catch(e => { console.log('ERROR', e); process.exit(1); });
