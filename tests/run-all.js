// Runs every *.test.js in this folder and prints a summary:  node tests/run-all.js   (from the repository root)
const { spawnSync } = require('child_process'), fs = require('fs'), path = require('path');
const files = fs.readdirSync(__dirname).filter(f => /\.test\.js$/.test(f)).sort(); let bad = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, [path.join(__dirname, f)], { encoding: 'utf8', env: process.env, cwd: process.cwd() });
  const out = (r.stdout || '') + (r.stderr || ''), line = out.split('\n').filter(l => / passed, \d+ failed/.test(l)).pop() || '(no summary: the test crashed)';
  const fails = out.split('\n').filter(l => /^\s+FAIL |^ERROR|Error:/.test(l));
  console.log((r.status === 0 ? 'PASS ' : 'FAIL ') + f.padEnd(24) + line.trim());
  if (r.status !== 0) { bad++; fails.slice(0, 8).forEach(l => console.log('       ' + l.trim())); if (!fails.length) console.log(out.split('\n').slice(-12).join('\n')); }
}
console.log('\n' + (bad ? bad + ' of ' + files.length + ' test files failed' : 'All ' + files.length + ' test files passed')); process.exit(bad ? 1 : 0);
