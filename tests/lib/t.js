// Tiny test helper: ok / eq / throws, a summary, and a non-zero exit code on any failure.
module.exports = function (name) {
  let pass = 0, fail = 0;
  const log = (good, msg, extra) => { if (good) { pass++; console.log('  ok   ' + msg); } else { fail++; console.log('  FAIL ' + msg + (extra ? '\n         ' + extra : '')); } };
  const T = {
    ok: (c, msg) => log(!!c, msg),
    eq: (a, b, msg) => log(JSON.stringify(a) === JSON.stringify(b), msg, 'got ' + JSON.stringify(a) + ', expected ' + JSON.stringify(b)),
    has: (s, sub, msg) => log(String(s).indexOf(sub) !== -1, msg, 'text did not contain ' + JSON.stringify(sub) + '\n         ' + String(s).slice(0, 300)),
    hasNot: (s, sub, msg) => log(String(s).indexOf(sub) === -1, msg, 'text contained ' + JSON.stringify(sub)),
    async throws(fn, re, msg) { let e = null; try { await fn(); } catch (x) { e = x; } log(!!e && (!re || re.test(String(e.message || e))), msg, e ? 'threw: ' + (e.message || e) : 'did not throw'); return e; },
    section: (s) => console.log('\n' + s),
    done() { console.log('\n' + name + ': ' + pass + ' passed, ' + fail + ' failed'); if (fail) process.exitCode = 1; return fail; }
  };
  console.log('== ' + name);
  return T;
};
