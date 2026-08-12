/* karaoke-qr.js — share this page as a QR code. Static + offline.
 *
 * Self-contained QR encoder (no library, no network): byte mode, error
 * correction level L, versions 1–5 (up to 106 characters — plenty for a URL).
 * Renders as inline SVG, so it prints and scales cleanly.
 *
 * Exposes window.kqr.matrix(text[, forceMask]) → array of 0/1 rows (used by
 * the test suite), and window.kqr.svg(text) → SVG string.
 *
 * Requires karaoke-features.js (kdock) for the dock button.
 */
(function () {
  "use strict";

  // ── GF(256) arithmetic for Reed–Solomon (primitive polynomial 0x11D) ──────
  var EXP = new Uint8Array(512), LOG = new Uint8Array(256);
  for (var i = 0, x = 1; i < 255; i++) {
    EXP[i] = x; LOG[x] = i;
    x <<= 1; if (x & 0x100) x ^= 0x11d;
  }
  for (var j = 255; j < 512; j++) EXP[j] = EXP[j - 255];
  function mul(a, b) { return a && b ? EXP[LOG[a] + LOG[b]] : 0; }

  function genPoly(n) {                     // (x-a^0)(x-a^1)…(x-a^(n-1))
    var g = [1];
    for (var i = 0; i < n; i++) {
      var ng = new Array(g.length + 1).fill(0);
      for (var k = 0; k < g.length; k++) {
        ng[k] ^= g[k];
        ng[k + 1] ^= mul(g[k], EXP[i]);
      }
      g = ng;
    }
    return g;
  }

  function ecc(data, n) {                   // remainder of data(x)·x^n / g(x)
    var g = genPoly(n), res = new Uint8Array(data.length + n);
    res.set(data);
    for (var i = 0; i < data.length; i++) {
      var c = res[i];
      if (!c) continue;
      for (var k = 0; k < g.length; k++) res[i + k] ^= mul(g[k], c);
    }
    return res.slice(data.length);
  }

  // ── symbol tables (EC level L, versions 1–5 — all single-block) ───────────
  var DATA_CW = [19, 34, 55, 80, 108];      // data codewords per version
  var EC_CW = [7, 10, 15, 20, 26];          // EC codewords per version

  function maskFn(m, r, c) {
    switch (m) {
      case 0: return (r + c) % 2 === 0;
      case 1: return r % 2 === 0;
      case 2: return c % 3 === 0;
      case 3: return (r + c) % 3 === 0;
      case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
      case 5: return (r * c) % 2 + (r * c) % 3 === 0;
      case 6: return ((r * c) % 2 + (r * c) % 3) % 2 === 0;
      default: return ((r + c) % 2 + (r * c) % 3) % 2 === 0;
    }
  }

  // penalty rules (ISO/IEC 18004 §8.8.2) — picks the most scannable mask
  function penalty(m) {
    var size = m.length, p = 0, r, c, run, i;
    for (r = 0; r < size; r++) {            // rule 1: runs of 5+ (rows & cols)
      run = 1;
      for (c = 1; c < size; c++) {
        if (m[r][c] === m[r][c - 1]) { run++; if (run === 5) p += 3; else if (run > 5) p++; }
        else run = 1;
      }
    }
    for (c = 0; c < size; c++) {
      run = 1;
      for (r = 1; r < size; r++) {
        if (m[r][c] === m[r - 1][c]) { run++; if (run === 5) p += 3; else if (run > 5) p++; }
        else run = 1;
      }
    }
    for (r = 0; r < size - 1; r++)          // rule 2: 2×2 blocks of one colour
      for (c = 0; c < size - 1; c++)
        if (m[r][c] === m[r][c + 1] && m[r][c] === m[r + 1][c] && m[r][c] === m[r + 1][c + 1])
          p += 3;
    var A = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0], B = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
    function hit(get, n) {                  // rule 3: finder-like 1:1:3:1:1 runs
      for (var s = 0; s + 11 <= n; s++) {
        var a = true, b = true;
        for (i = 0; i < 11; i++) {
          if (get(s + i) !== A[i]) a = false;
          if (get(s + i) !== B[i]) b = false;
        }
        if (a) p += 40;
        if (b) p += 40;
      }
    }
    for (r = 0; r < size; r++) hit((function (rr) { return function (k) { return m[rr][k]; }; })(r), size);
    for (c = 0; c < size; c++) hit((function (cc) { return function (k) { return m[k][cc]; }; })(c), size);
    var dark = 0;                           // rule 4: deviation from 50% dark
    for (r = 0; r < size; r++) for (c = 0; c < size; c++) dark += m[r][c];
    var pct = dark * 100 / (size * size);
    p += Math.floor(Math.abs(pct - 50) / 5) * 10;
    return p;
  }

  function build(text, forceMask) {
    var bytes = new TextEncoder().encode(text);
    var ver = 0;
    for (var v = 1; v <= 5; v++) if (bytes.length + 2 <= DATA_CW[v - 1]) { ver = v; break; }
    if (!ver) return null;                  // too long for version 5-L
    var cap = DATA_CW[ver - 1], size = 17 + 4 * ver;

    // -- bit stream: mode(4) + length(8) + data + terminator + pad ------------
    var bits = [];
    function push(val, len) { for (var i = len - 1; i >= 0; i--) bits.push((val >> i) & 1); }
    push(4, 4); push(bytes.length, 8);
    for (var b = 0; b < bytes.length; b++) push(bytes[b], 8);
    for (var t = 0; t < 4 && bits.length < cap * 8; t++) bits.push(0);
    while (bits.length % 8) bits.push(0);
    var cw = [];
    for (var i2 = 0; i2 < bits.length; i2 += 8) {
      var val = 0;
      for (var k2 = 0; k2 < 8; k2++) val = (val << 1) | bits[i2 + k2];
      cw.push(val);
    }
    var PAD = [0xec, 0x11], pi = 0;
    while (cw.length < cap) cw.push(PAD[pi++ & 1]);
    var all = cw.concat(Array.prototype.slice.call(ecc(Uint8Array.from(cw), EC_CW[ver - 1])));

    // -- function patterns ---------------------------------------------------
    var m = [], fn = [], r, c;
    for (r = 0; r < size; r++) { m.push(new Array(size).fill(0)); fn.push(new Array(size).fill(0)); }
    function setF(rr, cc, v) {
      if (rr >= 0 && rr < size && cc >= 0 && cc < size) { m[rr][cc] = v; fn[rr][cc] = 1; }
    }
    function finder(r0, c0) {               // 7×7 finder + 1-module separator
      for (var dr = -1; dr <= 7; dr++) for (var dc = -1; dc <= 7; dc++) {
        var inner = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
        var dark = inner && (dr === 0 || dr === 6 || dc === 0 || dc === 6 ||
                             (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4));
        setF(r0 + dr, c0 + dc, dark ? 1 : 0);
      }
    }
    for (var ti = 8; ti < size - 8; ti++) { setF(6, ti, ti % 2 === 0 ? 1 : 0); setF(ti, 6, ti % 2 === 0 ? 1 : 0); }
    finder(0, 0); finder(0, size - 7); finder(size - 7, 0);
    if (ver >= 2) {                         // one alignment pattern, bottom-right
      var ac = size - 7;
      for (var ar = -2; ar <= 2; ar++) for (var acc = -2; acc <= 2; acc++)
        setF(ac + ar, ac + acc, Math.max(Math.abs(ar), Math.abs(acc)) !== 1 ? 1 : 0);
    }
    for (var fi = 0; fi < 9; fi++) {        // reserve the format-info strips
      if (!fn[8][fi]) setF(8, fi, 0);
      if (!fn[fi][8]) setF(fi, 8, 0);
    }
    for (var fj = 0; fj < 8; fj++) { setF(8, size - 1 - fj, 0); setF(size - 1 - fj, 8, 0); }

    // -- data placement: zigzag, right to left, skipping the timing column ----
    var bi = 0, dataBits = [];
    for (var ci = 0; ci < all.length; ci++) for (var k3 = 7; k3 >= 0; k3--) dataBits.push((all[ci] >> k3) & 1);
    for (var right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (var vert = 0; vert < size; vert++) {
        for (var jj = 0; jj < 2; jj++) {
          var col = right - jj;
          var up = ((right + 1) & 2) === 0;
          var row = up ? size - 1 - vert : vert;
          if (fn[row][col] || bi >= dataBits.length) continue;
          m[row][col] = dataBits[bi++];
        }
      }
    }

    // -- mask + format info --------------------------------------------------
    function apply(mask) {
      var out = m.map(function (row) { return row.slice(); });
      for (var rr = 0; rr < size; rr++) for (var cc = 0; cc < size; cc++)
        if (!fn[rr][cc] && maskFn(mask, rr, cc)) out[rr][cc] ^= 1;
      // format bits: EC level L = 0b01, BCH(15,5), XOR 0x5412
      var d = (1 << 3) | mask, rem = d;
      for (var e = 0; e < 10; e++) rem = (rem << 1) ^ (((rem >> 9) & 1) * 0x537);
      var fbits = ((d << 10) | rem) ^ 0x5412;
      for (var i4 = 0; i4 < 15; i4++) {
        var bit = (fbits >> i4) & 1;
        if (i4 < 6) out[i4][8] = bit;                    // copy 1: down column 8
        else if (i4 === 6) out[7][8] = bit;
        else if (i4 === 7) out[8][8] = bit;
        else if (i4 === 8) out[8][7] = bit;
        else out[8][14 - i4] = bit;                      // …then left along row 8
        if (i4 < 8) out[8][size - 1 - i4] = bit;         // copy 2: row 8 right side
        else out[size - 15 + i4][8] = bit;               // …then column 8 bottom
      }
      out[size - 8][8] = 1;                              // always-dark module
      return out;
    }
    if (typeof forceMask === "number") return apply(forceMask);
    var best = null, bestScore = Infinity;
    for (var mk = 0; mk < 8; mk++) {
      var cand = apply(mk), sc = penalty(cand);
      if (sc < bestScore) { bestScore = sc; best = cand; }
    }
    return best;
  }

  function svg(text, px) {
    var m = build(text);
    if (!m) return null;
    var n = m.length, q = 4, total = n + q * 2, path = "";
    for (var r = 0; r < n; r++) for (var c = 0; c < n; c++)
      if (m[r][c]) path += "M" + (c + q) + "," + (r + q) + "h1v1h-1z";
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + total + " " + total +
      '" width="' + (px || 200) + '" height="' + (px || 200) +
      '" shape-rendering="crispEdges" role="img" aria-label="QR code">' +
      '<rect width="' + total + '" height="' + total + '" fill="#fff"/>' +
      '<path d="' + path + '" fill="#000"/></svg>';
  }

  window.kqr = { matrix: build, svg: svg };

  if (!window.kdock) return;
  kdock.add({
    id: "qr", emoji: "🔗", label: "share", title: "Share this page",
    render: function (el) {
      var url = location.href;
      var code = svg(url, 200);
      el.insertAdjacentHTML("beforeend",
        '<div style="text-align:center">' +
        (code || '<div class="k-msg bad">This URL is too long to encode.</div>') + "</div>" +
        '<div style="font-size:.72rem;word-break:break-all;margin:.5rem 0;color:#374151">' +
        url.replace(/</g, "&lt;") + "</div>" +
        '<button class="k-btn primary" id="kq-copy">Copy link</button>' +
        '<div class="k-msg"></div>' +
        '<div class="k-note">Point a phone camera at the code to open this page. ' +
        "Works offline — the code is drawn here, not fetched.</div>");
      el.querySelector("#kq-copy").addEventListener("click", async function () {
        try { await navigator.clipboard.writeText(url); kdock.msg(el, "link copied ✓"); }
        catch (e) { kdock.msg(el, "clipboard blocked — copy the link above", true); }
      });
    },
  });
})();
