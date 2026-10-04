/*
 * tres.js - lossless reader/editor for Godot .tres text resources (Road to Vostok saves).
 *
 * Design rules:
 *  - The file is kept as its original lines. Blocks only point at lines, nothing is re-serialised,
 *    so an untouched file round-trips byte-for-byte (spacing, number formats, line endings).
 *  - Edits replace single lines or remove whole blocks; everything else stays exactly as the game wrote it.
 *  - Plain script, no modules/bundler: works in the Tauri webview (window.Tres) and in Node (module.exports).
 */
(function (root) {
  'use strict';

  var HEADER_RE = /^\[(gd_resource|ext_resource|sub_resource|resource|node|connection|editable)(\s[^\]]*)?\]\s*$/;
  var PROP_RE = /^([A-Za-z_][\w\/.:\-]*)\s=\s(.*)$/;
  var ATTR_RE = /([\w]+)=("(?:[^"\\]|\\.)*"|[^\s\]]+)/g;
  var MOD_PATH_RE = /^res:\/\/mods\/([^\/]+)\//i;

  function parseAttrs(header) {
    var attrs = {}, m;
    ATTR_RE.lastIndex = 0;
    while ((m = ATTR_RE.exec(header))) {
      var v = m[2];
      if (v.charAt(0) === '"') v = v.slice(1, -1);
      attrs[m[1]] = v;
    }
    return attrs;
  }

  function Tres(text) {
    var eol = text.indexOf('\r\n') !== -1 ? '\r\n' : '\n';
    var lines = text.split(eol);
    this.eol = eol;
    this.blocks = [];
    var cur = null;
    for (var i = 0; i < lines.length; i++) {
      var hm = HEADER_RE.exec(lines[i]);
      if (hm) {
        cur = { kind: hm[1], lines: [lines[i]], attrs: parseAttrs(lines[i]) };
        this.blocks.push(cur);
      } else {
        if (!cur) { cur = { kind: 'preamble', lines: [], attrs: {} }; this.blocks.push(cur); }
        cur.lines.push(lines[i]);
      }
    }
  }

  Tres.parse = function (text) { return new Tres(text); };

  Tres.prototype.serialize = function () {
    var out = [];
    for (var i = 0; i < this.blocks.length; i++) out.push.apply(out, this.blocks[i].lines);
    return out.join(this.eol);
  };

  /* ---------- lookups ---------- */
  Tres.prototype.ext = function () { return this.blocks.filter(function (b) { return b.kind === 'ext_resource'; }); };
  Tres.prototype.subs = function () { return this.blocks.filter(function (b) { return b.kind === 'sub_resource'; }); };
  Tres.prototype.main = function () { return this.blocks.filter(function (b) { return b.kind === 'resource'; })[0] || null; };
  Tres.prototype.extById = function (id) { return this.ext().filter(function (b) { return b.attrs.id === id; })[0] || null; };
  Tres.prototype.subById = function (id) { return this.subs().filter(function (b) { return b.attrs.id === id; })[0] || null; };

  /* ---------- properties (key = value on one line; continuation lines belong to the previous key) ---------- */
  function propIndex(block, key) {
    for (var i = 1; i < block.lines.length; i++) {
      var m = PROP_RE.exec(block.lines[i]);
      if (m && m[1] === key) return i;
    }
    return -1;
  }
  Tres.prototype.keys = function (block) {
    var ks = [];
    for (var i = 1; i < block.lines.length; i++) { var m = PROP_RE.exec(block.lines[i]); if (m) ks.push(m[1]); }
    return ks;
  };
  Tres.prototype.get = function (block, key) {
    var i = propIndex(block, key);
    return i < 0 ? undefined : PROP_RE.exec(block.lines[i])[2];
  };
  Tres.prototype.set = function (block, key, rawValue) {
    var i = propIndex(block, key);
    if (i < 0) throw new Error('No such property: ' + key);
    block.lines[i] = key + ' = ' + rawValue;
  };
  // insert a new property right after `afterKey` (or at the end of the block's content, before trailing blank lines)
  Tres.prototype.insert = function (block, key, rawValue, afterKey) {
    var at = afterKey ? propIndex(block, afterKey) : -1;
    if (at >= 0) { block.lines.splice(at + 1, 0, key + ' = ' + rawValue); return; }
    var end = block.lines.length;
    while (end > 1 && block.lines[end - 1].trim() === '') end--;
    block.lines.splice(end, 0, key + ' = ' + rawValue);
  };

  /* ---------- reference helpers ---------- */
  function refIds(raw, fn) {
    var re = new RegExp(fn + '\\("([^"]+)"\\)', 'g'), out = [], m;
    while ((m = re.exec(raw))) out.push(m[1]);
    return out;
  }
  Tres.prototype.blockRefs = function (block, fn) {
    var out = [];
    for (var i = 1; i < block.lines.length; i++) out.push.apply(out, refIds(block.lines[i], fn));
    return out;
  };

  // readable name from an item path: res://Items/Food/Canned_Pineapple/Canned_Pineapple.tres -> "Canned Pineapple"
  Tres.itemName = function (path) {
    var f = path.split('/').pop().replace(/\.tres$/i, '').replace(/_/g, ' ');
    return f;
  };
  Tres.modOf = function (path) { var m = MOD_PATH_RE.exec(path); return m ? m[1] : null; };

  // every res:// dependency, with the mod it belongs to (null = base game)
  Tres.prototype.dependencies = function () {
    return this.ext().map(function (b) {
      return { id: b.attrs.id, type: b.attrs.type, path: b.attrs.path, mod: Tres.modOf(b.attrs.path || ''), name: Tres.itemName(b.attrs.path || '') };
    });
  };

  // dependencies that come from mods which are not installed (installed = array of mod folder names, case-insensitive)
  Tres.prototype.orphans = function (installed) {
    var have = {};
    (installed || []).forEach(function (n) { have[String(n).toLowerCase()] = true; });
    return this.dependencies().filter(function (d) { return d.mod && !have[d.mod.toLowerCase()]; });
  };

  // how many sub_resources point at an ext_resource
  Tres.prototype.usesOf = function (extId) {
    var n = 0;
    this.subs().concat(this.main() ? [this.main()] : []).forEach(function (b) {
      for (var i = 1; i < b.lines.length; i++) if (b.lines[i].indexOf('ExtResource("' + extId + '")') !== -1 && !/^script = /.test(b.lines[i])) n++;
    });
    return n;
  };

  /* ---------- removal ---------- */
  function removeFromArrays(self, subId) {
    var token = 'SubResource("' + subId + '")';
    self.blocks.forEach(function (b) {
      for (var i = 1; i < b.lines.length; i++) {
        var l = b.lines[i];
        if (l.indexOf(token) === -1) continue;
        var n = l.replace(', ' + token, '');
        if (n === l) n = l.replace(token + ', ', '');
        if (n === l) n = l.replace(token, '');
        b.lines[i] = n;
      }
    });
  }

  // Remove every item slot that uses ext_resource `extId` (plus anything nested/stored inside those slots),
  // then drop the now unused ext_resource. Returns a report of what was removed.
  Tres.prototype.removeItemsUsing = function (extId) {
    var self = this, report = { slots: [], children: [], ext: null };
    var target = this.extById(extId);
    if (!target) throw new Error('No ext_resource with id ' + extId);
    report.ext = { id: extId, path: target.attrs.path };

    var doomed = [];
    this.subs().forEach(function (b) {
      if (self.get(b, 'itemData') === 'ExtResource("' + extId + '")') doomed.push(b.attrs.id);
    });
    report.slots = doomed.slice();

    // collect everything those slots own (nested attachments, storage contents), recursively
    var queue = doomed.slice(), seen = {};
    doomed.forEach(function (d) { seen[d] = true; });
    while (queue.length) {
      var sb = this.subById(queue.shift());
      if (!sb) continue;
      this.blockRefs(sb, 'SubResource').forEach(function (cid) {
        if (!seen[cid]) { seen[cid] = true; doomed.push(cid); queue.push(cid); report.children.push(cid); }
      });
    }

    doomed.forEach(function (sid) {
      removeFromArrays(self, sid);
      var blk = self.subById(sid);
      if (blk) self.blocks.splice(self.blocks.indexOf(blk), 1);
    });

    if (this.usesOf(extId) === 0) this.blocks.splice(this.blocks.indexOf(target), 1);
    return report;
  };

  // convenience: strip everything that depends on uninstalled mods
  Tres.prototype.removeOrphans = function (installed) {
    var self = this, reports = [];
    this.orphans(installed).forEach(function (o) { reports.push(self.removeItemsUsing(o.id)); });
    return reports;
  };

  /* ---------- migration ---------- */
  // Add properties that exist in a reference save (e.g. a fresh Build 2 file) but not in this one,
  // placed right after the property that precedes them in the reference. Values are copied from the reference.
  Tres.prototype.addMissingFrom = function (reference) {
    var mine = this.main(), theirs = reference.main(), added = [];
    if (!mine || !theirs) return added;
    var have = {};
    this.keys(mine).forEach(function (k) { have[k] = true; });
    var theirKeys = reference.keys(theirs), prev = null;
    for (var i = 0; i < theirKeys.length; i++) {
      var k = theirKeys[i];
      if (!have[k]) {
        this.insert(mine, k, reference.get(theirs, k), prev);
        have[k] = true;
        added.push({ key: k, value: reference.get(theirs, k), after: prev });
      }
      prev = k;
    }
    return added;
  };

  /* ---------- integrity check ---------- */
  Tres.prototype.validate = function () {
    var problems = [], self = this;
    var extIds = {}, subIds = {};
    this.ext().forEach(function (b) { extIds[b.attrs.id] = true; });
    this.subs().forEach(function (b) { subIds[b.attrs.id] = true; });
    this.blocks.forEach(function (b) {
      self.blockRefs(b, 'ExtResource').forEach(function (id) { if (!extIds[id]) problems.push('dangling ExtResource("' + id + '") in ' + b.kind); });
      self.blockRefs(b, 'SubResource').forEach(function (id) { if (!subIds[id]) problems.push('dangling SubResource("' + id + '") in ' + b.kind); });
    });
    var seen = {};
    this.ext().concat(this.subs()).forEach(function (b) {
      var k = b.kind + ':' + b.attrs.id;
      if (seen[k]) problems.push('duplicate id ' + k);
      seen[k] = true;
    });
    return problems;
  };

  root.Tres = Tres;
  if (typeof module !== 'undefined' && module.exports) module.exports = Tres;
})(typeof window !== 'undefined' ? window : globalThis);
