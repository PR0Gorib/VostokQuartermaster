/*
 * pck.js - read-only access to a Godot 4 .pck and decoding of S3TC (DXT) .ctex icons.
 *
 * Plain script, no modules/bundler: window.Pck in the Tauri webview, module.exports in Node.
 * Never loads the whole pack: it reads the file table once and single files on demand through a reader:
 *   reader = { size: <bytes>, read: async function (pos, len) -> Uint8Array }
 *
 * UNVERIFIED against the real game until icon-probe.js has been run on it (see the notes in decodeCtex).
 */
(function (root) {
  'use strict';

  var MAGIC = 0x43504447; // "GDPC"
  var TD = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8') : null;

  function view(u8) { return new DataView(u8.buffer, u8.byteOffset, u8.byteLength); }
  function str(u8, a, b) { if (b === undefined) b = u8.length; return TD ? TD.decode(u8.subarray(a, b)) : Buffer.from(u8.subarray(a, b)).toString('utf8'); }

  /* ---------- pack ---------- */
  async function open(reader) {
    var size = reader.size, start = -1, how = '';
    var head = await reader.read(0, 4);
    if (head.length === 4 && view(head).getUint32(0, true) === MAGIC) { start = 0; how = 'file'; }
    else if (size >= 12) {
      var t = await reader.read(size - 12, 12), tv = view(t);
      if (tv.getUint32(8, true) === MAGIC) {
        var ps = Number(tv.getBigUint64(0, true)), s = size - 12 - ps;
        if (s >= 0) { var h2 = await reader.read(s, 4); if (view(h2).getUint32(0, true) === MAGIC) { start = s; how = 'embedded'; } }
      }
    }
    if (start < 0) throw new Error('No Godot pack found in this file');

    var hb = await reader.read(start, 128), hv = view(hb), ver = hv.getUint32(4, true);
    var info = { start: start, how: how, formatVersion: ver, godot: hv.getUint32(8, true) + '.' + hv.getUint32(12, true) + '.' + hv.getUint32(16, true), flags: 0, fileBase: 0, dirOffset: 0 };
    var dirPos;
    if (ver <= 1) dirPos = start + 20 + 64;
    else if (ver === 2) { info.flags = hv.getUint32(20, true); info.fileBase = Number(hv.getBigUint64(24, true)); dirPos = start + 32 + 64; }
    else { info.flags = hv.getUint32(20, true); info.fileBase = Number(hv.getBigUint64(24, true)); info.dirOffset = Number(hv.getBigUint64(32, true)); dirPos = start + info.dirOffset; }
    if (info.flags & 1) throw new Error('The pack file table is encrypted');

    // v3 keeps the table at the end of the pack; v2 puts it right after the header. Read a generous window.
    var want = Math.min(size - dirPos, 32 * 1048576);
    var buf = await reader.read(dirPos, want), dv = view(buf), count = dv.getUint32(0, true);
    if (count < 1 || count > 3000000) throw new Error('Unexpected file count ' + count + ' (unknown pack layout)');
    var o = 4, files = {}, names = [];
    for (var i = 0; i < count; i++) {
      var plen = dv.getUint32(o, true); o += 4;
      if (plen > 4096) throw new Error('Corrupt file table at entry ' + i);
      var name = str(buf, o, o + plen).replace(/\0+$/, ''); o += plen;
      var off = Number(dv.getBigUint64(o, true)); o += 8;
      var sz = Number(dv.getBigUint64(o, true)); o += 8;
      o += 16;
      var fl = 0; if (ver >= 2) { fl = dv.getUint32(o, true); o += 4; }
      name = name.replace(/^res:\/\//, '');
      files[name] = { off: off, size: sz, flags: fl };
      names.push(name);
    }
    return {
      info: info, names: names, files: files,
      has: function (n) { return Object.prototype.hasOwnProperty.call(files, n); },
      read: function (n) {
        var f = files[n]; if (!f) throw new Error('Not in pack: ' + n);
        if (f.flags & 1) throw new Error('File is encrypted: ' + n);
        return reader.read(start + info.fileBase + f.off, f.size);
      }
    };
  }

  /* ---------- icon lookup ---------- */
  // .godot/imported/Icon_AK-12.png-<md5>.s3tc.ctex  ->  key "icon_ak-12"
  var ICON_RE = /(?:^|\/)(Icon_[^\/]+?)\.png-[0-9a-f]{32}\.[a-z0-9.]*ctex$/i;
  function iconIndex(pack) {
    var idx = {};
    pack.names.forEach(function (n) { var m = ICON_RE.exec(n); if (m) idx[m[1].toLowerCase()] = n; });
    return idx;
  }
  // itemName is the item file name without extension, e.g. "AK-12" or "Backpack_Jaeger_Black"
  function iconFor(idx, itemName) {
    var k = 'icon_' + String(itemName).toLowerCase();
    if (idx[k]) return idx[k];
    var pre = k + '_', keys = Object.keys(idx).filter(function (x) { return x.indexOf(pre) === 0; }).sort();
    return keys.length ? idx[keys[0]] : null;
  }

  /* ---------- S3TC decoding ---------- */
  var FMT = { DXT1: 17, DXT3: 18, DXT5: 19 };

  function chainSize(w, h, fmt) {
    var bpb = fmt === FMT.DXT1 ? 8 : 16, total = 0;
    for (;;) {
      total += Math.ceil(w / 4) * Math.ceil(h / 4) * bpb;
      if (w === 1 && h === 1) break;
      w = Math.max(1, w >> 1); h = Math.max(1, h >> 1);
    }
    return total;
  }

  function dxtDecode(d, off, w, h, fmt) {
    var out = new Uint8ClampedArray(w * h * 4), bw = Math.ceil(w / 4), bh = Math.ceil(h / 4);
    var bpb = fmt === FMT.DXT1 ? 8 : 16, al = new Uint8Array(16), pal = new Uint8Array(16), a8 = new Uint8Array(8);
    var pos = off;
    for (var by = 0; by < bh; by++) for (var bx = 0; bx < bw; bx++, pos += bpb) {
      var co = pos, i;
      for (i = 0; i < 16; i++) al[i] = 255;
      if (fmt === FMT.DXT5) {
        var a0 = d[pos], a1 = d[pos + 1];
        a8[0] = a0; a8[1] = a1;
        if (a0 > a1) for (i = 1; i <= 6; i++) a8[i + 1] = Math.floor(((7 - i) * a0 + i * a1) / 7);
        else { for (i = 1; i <= 4; i++) a8[i + 1] = Math.floor(((5 - i) * a0 + i * a1) / 5); a8[6] = 0; a8[7] = 255; }
        var lo = d[pos + 2] | (d[pos + 3] << 8) | (d[pos + 4] << 16), hi = d[pos + 5] | (d[pos + 6] << 8) | (d[pos + 7] << 16);
        for (i = 0; i < 16; i++) al[i] = a8[i < 8 ? (lo >>> (3 * i)) & 7 : (hi >>> (3 * (i - 8))) & 7];
        co = pos + 8;
      } else if (fmt === FMT.DXT3) {
        for (i = 0; i < 16; i++) al[i] = ((d[pos + (i >> 1)] >> ((i & 1) * 4)) & 15) * 17;
        co = pos + 8;
      }
      var c0 = d[co] | (d[co + 1] << 8), c1 = d[co + 2] | (d[co + 3] << 8);
      var r0 = (c0 >> 11) & 31, g0 = (c0 >> 5) & 63, b0 = c0 & 31, r1 = (c1 >> 11) & 31, g1 = (c1 >> 5) & 63, b1 = c1 & 31;
      r0 = (r0 << 3) | (r0 >> 2); g0 = (g0 << 2) | (g0 >> 4); b0 = (b0 << 3) | (b0 >> 2);
      r1 = (r1 << 3) | (r1 >> 2); g1 = (g1 << 2) | (g1 >> 4); b1 = (b1 << 3) | (b1 >> 2);
      pal[0] = r0; pal[1] = g0; pal[2] = b0; pal[3] = 255; pal[4] = r1; pal[5] = g1; pal[6] = b1; pal[7] = 255;
      var three = fmt === FMT.DXT1 && c0 <= c1;
      if (three) {
        pal[8] = (r0 + r1) >> 1; pal[9] = (g0 + g1) >> 1; pal[10] = (b0 + b1) >> 1; pal[11] = 255;
        pal[12] = 0; pal[13] = 0; pal[14] = 0; pal[15] = 0;
      } else {
        pal[8] = Math.floor((2 * r0 + r1) / 3); pal[9] = Math.floor((2 * g0 + g1) / 3); pal[10] = Math.floor((2 * b0 + b1) / 3); pal[11] = 255;
        pal[12] = Math.floor((r0 + 2 * r1) / 3); pal[13] = Math.floor((g0 + 2 * g1) / 3); pal[14] = Math.floor((b0 + 2 * b1) / 3); pal[15] = 255;
      }
      var bits = (d[co + 4] | (d[co + 5] << 8) | (d[co + 6] << 16) | (d[co + 7] << 24)) >>> 0;
      for (var py = 0; py < 4; py++) for (var px = 0; px < 4; px++) {
        var x = bx * 4 + px, y = by * 4 + py; if (x >= w || y >= h) continue;
        var k = (py * 4 + px), ci = ((bits >>> (2 * k)) & 3) * 4, q = (y * w + x) * 4;
        out[q] = pal[ci]; out[q + 1] = pal[ci + 1]; out[q + 2] = pal[ci + 2];
        out[q + 3] = three ? pal[ci + 3] : al[k];
      }
    }
    return out;
  }

  /*
   * Godot 4 .ctex: "GST2", version, width, height, flags, mipmap_limit, 3 reserved (36 bytes), then a small
   * per-image header and the mip chain, largest level first. Rather than trust the exact header layout, the first
   * level is located from the END: data = whole chain, so its start is  length - chainSize(w, h, format), and the
   * 4 bytes just before it must hold the Image format id (17 DXT1, 18 DXT3, 19 DXT5). If that does not hold,
   * this throws with the raw numbers so the layout can be corrected.
   */
  function decodeCtex(u8) {
    var v = view(u8);
    if (u8.length < 40 || v.getUint32(0, true) !== 0x32545347) throw new Error('Not a GST2 texture');
    var w = v.getUint32(8, true), h = v.getUint32(12, true), tried = [];
    for (var fi = 0; fi < 3; fi++) {
      var fmt = [FMT.DXT5, FMT.DXT3, FMT.DXT1][fi], hdr = u8.length - chainSize(w, h, fmt);
      tried.push('fmt ' + fmt + ' -> header ' + hdr);
      if (hdr >= 40 && hdr <= 96 && v.getUint32(hdr - 4, true) === fmt)
        return { width: w, height: h, format: fmt, headerBytes: hdr, rgba: dxtDecode(u8, hdr, w, h, fmt) };
    }
    var raw = []; for (var o = 36; o <= 52 && o + 4 <= u8.length; o += 4) raw.push(v.getUint32(o, true));
    throw new Error('Unsupported texture layout: ' + w + 'x' + h + ', ' + u8.length + ' bytes; ' + tried.join('; ') + '; u32 at 36..52 = ' + raw.join(','));
  }

  /*
   * Per-item icon lookup. Each item lives in its own folder (Items/<Category>/<Item>/) with its art in Files/.
   * The icon is found there, and the .import file next to it names the exact texture, which avoids clashes
   * between textures that share a file name elsewhere (e.g. the Coffee item and a UI sprite).
   *   1. Files/Icon_<ItemFile>.png.import  (exact name)
   *   2. otherwise the folder icon sharing the most name parts with the item (STANAG_Magazine -> Icon_M4A1_Magazine)
   * Returns the .ctex path inside the pack, or null (mods, unknown items).
   */
  function folderIcons(pack) {
    if (!pack._fi) {
      var m = {};
      pack.names.forEach(function (n) {
        var x = /^(.+)\/Files\/(Icon_[^\/]+)\.png\.import$/.exec(n);
        if (x) (m[x[1]] = m[x[1]] || []).push({ key: x[2], imp: n });
      });
      pack._fi = m;
    }
    return pack._fi;
  }
  function tokens(s) { var o = {}; String(s).toLowerCase().split(/[_\-\s]+/).forEach(function (t) { if (t) o[t] = true; }); return o; }
  async function itemIcon(pack, itemPath) {
    var p = String(itemPath).replace(/^res:\/\//, ''), dir = p.replace(/\/[^\/]*$/, ''), name = p.split('/').pop().replace(/\.tres$/i, '');
    var list = folderIcons(pack)[dir];
    if (!list || !list.length) return null;
    var want = ('Icon_' + name).toLowerCase(), pick = null, i;
    for (i = 0; i < list.length; i++) if (list[i].key.toLowerCase() === want) { pick = list[i]; break; }
    if (!pick) {
      var t = tokens(name), best = 0;
      list.slice().sort(function (a, b) { return a.key.length - b.key.length || (a.key < b.key ? -1 : 1); }).forEach(function (e) {
        var k = tokens(e.key.slice(5)), sc = 0; for (var w in t) if (k[w]) sc++;
        if (sc > best) { best = sc; pick = e; }
      });
    }
    if (!pick) return null;
    var txt = str(await pack.read(pick.imp), 0, undefined), re = /res:\/\/(\.godot\/imported\/[^"\s]+\.ctex)/g, found = [], m;
    while ((m = re.exec(txt))) found.push(m[1]);
    var good = found.filter(function (f) { return pack.has(f); });
    var s3 = good.filter(function (f) { return /\.s3tc\./.test(f); });
    return (s3[0] || good[0]) || null;
  }

  var Pck = { open: open, iconIndex: iconIndex, iconFor: iconFor, itemIcon: itemIcon, decodeCtex: decodeCtex, _dxtDecode: dxtDecode, _chainSize: chainSize, FMT: FMT };
  root.Pck = Pck;
  if (typeof module !== 'undefined' && module.exports) module.exports = Pck;
})(typeof window !== 'undefined' ? window : globalThis);
