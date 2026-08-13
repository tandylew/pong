/* karaoke-multiplayer.js — same-room multiplayer over WebRTC. No server.
 *
 * Two phones on one sofa, connected by pointing a camera at a screen:
 *
 *   host taps "Create game"  →  offer QR appears
 *   joiner scans it with the PHONE CAMERA APP  →  opens this page with the
 *      offer in the URL  →  their device answers and shows an answer QR
 *   host scans that back     →  data channel opens, game state flows P2P
 *
 * Exposes window.kmp:
 *   kmp.host()                start hosting; resolves when the QR is showing
 *   kmp.join(code)            answer an offer (usually automatic, from the URL)
 *   kmp.send(obj)             to every peer (host) or to the host (client)
 *   kmp.setState(obj)         host only — broadcast authoritative state
 *   kmp.on(evt, fn)           open | close | data | state | error
 *   kmp.state / kmp.isHost / kmp.peers
 *
 * ── Why not PeerJS or simple-peer ───────────────────────────────────────────
 * PeerJS is built around a broker: it needs a signalling server (its cloud one
 * by default), which is the exact thing the QR handshake exists to avoid.
 * simple-peer is an npm bundle, and this scaffold has no build step and must run
 * offline from one file. Neither compresses SDP, which is the only hard part —
 * so both would have been a dependency wrapped around code still written here.
 * This uses RTCPeerConnection directly.
 *
 * ── Making an SDP fit in a QR code ──────────────────────────────────────────
 * A WebRTC offer is 1.5–4 KB of mostly boilerplate. Scanning that off a screen
 * needs a dense version-25-ish symbol and a steady hand. But only five things in
 * it are not predictable: the ICE ufrag, the ICE password, the DTLS fingerprint,
 * the role, and the candidates. Everything else this file can regenerate, because
 * it also generated the original. Packing just those into binary gets a typical
 * offer to ~100 bytes — about 136 base64 characters, a version 9 QR, comfortable
 * across a room.
 *
 * Requires karaoke-qr.js (the encoder) and karaoke-features.js (kdock).
 */
(function () {
  "use strict";

  var FMT = 1;                          // payload format version
  var HASH = "sha-256";
  var MAX_CANDIDATES = 6;               // keeps the QR scannable
  var PING_MS = 3000, DEAD_MS = 12000;
  var CHANNEL = "kmp";
  var DROPBOX = "kmp:answer";           // localStorage hand-off, see scanBack()

  var listeners = {}, peers = {}, nextId = 1;
  var api = null, pendingHost = null, stopWatching = null;

  function emit(evt, a, b) {
    (listeners[evt] || []).forEach(function (fn) {
      try { fn(a, b); } catch (e) { console.error("kmp handler:", e); }
    });
  }

  // ── binary packing ─────────────────────────────────────────────────────────
  function b64url(bytes) {
    var s = "";
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function unb64url(text) {
    var s = text.replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    var raw = atob(s), out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  /** Pull the five unpredictable fields out of an SDP. */
  function readSdp(sdp) {
    var get = function (re) { var m = sdp.match(re); return m ? m[1] : ""; };
    var out = {
      ufrag: get(/^a=ice-ufrag:(.+)$/m).trim(),
      pwd: get(/^a=ice-pwd:(.+)$/m).trim(),
      fp: get(/^a=fingerprint:sha-256 (.+)$/mi).trim(),
      cands: [],
    };
    var re = /^a=candidate:\S+ \d+ (?:udp|UDP) \d+ (\S+) (\d+) typ host/gm, m;
    while ((m = re.exec(sdp)) && out.cands.length < MAX_CANDIDATES)
      out.cands.push({ addr: m[1], port: parseInt(m[2], 10) });
    return out;
  }

  var UUID_RE = /^([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})\.local$/i;

  function packCandidate(c, put) {
    var v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(c.addr);
    var uu = UUID_RE.exec(c.addr);
    if (v4) {
      put(0);
      for (var i = 1; i <= 4; i++) put(parseInt(v4[i], 10) & 255);
    } else if (uu) {
      // Chrome hides local IPs behind an mDNS hostname; the UUID is 16 bytes of
      // hex, so it packs to 16 rather than the 36 characters it prints as
      put(1);
      var hex = uu.slice(1).join("");
      for (var h = 0; h < 32; h += 2) put(parseInt(hex.substr(h, 2), 16));
    } else {
      return false;                     // IPv6 or a relay we can't compact
    }
    put((c.port >> 8) & 255); put(c.port & 255);
    return true;
  }

  function pack(sdp, isAnswer) {
    var f = readSdp(sdp);
    if (!f.ufrag || !f.pwd || !f.fp) throw new Error("this browser's SDP is missing ICE fields");
    var bytes = [];
    var put = function (b) { bytes.push(b & 255); };
    put(FMT | (isAnswer ? 0x10 : 0));
    put(f.ufrag.length);
    for (var i = 0; i < f.ufrag.length; i++) put(f.ufrag.charCodeAt(i));
    put(f.pwd.length);
    for (var j = 0; j < f.pwd.length; j++) put(f.pwd.charCodeAt(j));
    var fpHex = f.fp.replace(/:/g, "");
    for (var k = 0; k < 64; k += 2) put(parseInt(fpHex.substr(k, 2), 16));
    var body = [], n = 0;
    for (var c = 0; c < f.cands.length; c++) {
      var before = body.length;
      if (packCandidate(f.cands[c], function (b) { body.push(b & 255); })) n++;
      else body.length = before;
    }
    put(n);
    Array.prototype.push.apply(bytes, body);
    return b64url(Uint8Array.from(bytes));
  }

  function unpack(code) {
    var b = unb64url(code.trim()), at = 0;
    var take = function () { return b[at++]; };
    var head = take();
    if ((head & 0x0f) !== FMT) throw new Error("this code is from a different version of the game");
    var isAnswer = !!(head & 0x10);
    var ulen = take(), ufrag = "";
    for (var i = 0; i < ulen; i++) ufrag += String.fromCharCode(take());
    var plen = take(), pwd = "";
    for (var j = 0; j < plen; j++) pwd += String.fromCharCode(take());
    var fp = [];
    for (var k = 0; k < 32; k++) fp.push(("0" + take().toString(16)).slice(-2));
    var count = take(), cands = [];
    for (var c = 0; c < count; c++) {
      var kind = take(), addr;
      if (kind === 0) {
        addr = [take(), take(), take(), take()].join(".");
      } else {
        var hex = "";
        for (var h = 0; h < 16; h++) hex += ("0" + take().toString(16)).slice(-2);
        addr = hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-" + hex.slice(12, 16) +
               "-" + hex.slice(16, 20) + "-" + hex.slice(20) + ".local";
      }
      cands.push({ addr: addr, port: (take() << 8) | take() });
    }
    return { isAnswer: isAnswer, ufrag: ufrag, pwd: pwd,
             fp: fp.join(":").toUpperCase(), cands: cands };
  }

  /** Rebuild a complete, valid SDP from the packed fields. The boilerplate is
   *  fixed because both ends are this same file. */
  function buildSdp(f, kind) {
    var lines = [
      "v=0",
      "o=- " + Date.now() + " 1 IN IP4 0.0.0.0",
      "s=-", "t=0 0",
      "a=group:BUNDLE 0",
      "a=msid-semantic: WMS",
      "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
      "c=IN IP4 0.0.0.0",
      "a=mid:0",
      "a=sctp-port:5000",
      "a=max-message-size:262144",
      "a=ice-ufrag:" + f.ufrag,
      "a=ice-pwd:" + f.pwd,
      "a=fingerprint:" + HASH + " " + f.fp,
      "a=setup:" + (kind === "offer" ? "actpass" : "active"),
    ];
    for (var i = 0; i < f.cands.length; i++)
      lines.push("a=candidate:" + (i + 1) + " 1 udp " + (2130706431 - i) + " " +
                 f.cands[i].addr + " " + f.cands[i].port + " typ host");
    lines.push("a=end-of-candidates");
    return lines.join("\r\n") + "\r\n";
  }

  // ── connection plumbing ────────────────────────────────────────────────────
  function newPeerConnection() {
    // No STUN on purpose: everyone is in the same room, so host candidates are
    // all that's needed — and every server we don't contact is one fewer thing
    // to be offline, blocked, or slow.
    return new RTCPeerConnection({ iceServers: [], iceCandidatePoolSize: 0 });
  }

  /** Wait for ICE gathering to finish, because QR signalling can't trickle:
   *  whatever is in the SDP when we draw the code is all the other side gets. */
  function gathered(pc, ms) {
    return new Promise(function (resolve) {
      if (pc.iceGatheringState === "complete") return resolve();
      var done = false;
      var finish = function () {
        if (done) return;
        done = true;
        pc.removeEventListener("icegatheringstatechange", check);
        resolve();
      };
      function check() { if (pc.iceGatheringState === "complete") finish(); }
      pc.addEventListener("icegatheringstatechange", check);
      setTimeout(finish, ms || 2500);   // a slow interface must not stall the QR
    });
  }

  function track(pc, ch, id) {
    var rec = { id: id, pc: pc, ch: ch, alive: Date.now(), timer: null };
    peers[id] = rec;

    ch.addEventListener("open", function () {
      rec.alive = Date.now();
      rec.timer = setInterval(function () {
        if (Date.now() - rec.alive > DEAD_MS) return drop(id, "timed out");
        try { ch.send(JSON.stringify({ t: "ping" })); } catch (e) { drop(id, "send failed"); }
      }, PING_MS);
      emit("open", id);
      if (api.isHost && api.state !== null) sendTo(rec, { t: "state", s: api.state });
    });
    ch.addEventListener("message", function (e) {
      rec.alive = Date.now();
      var msg;
      try { msg = JSON.parse(e.data); } catch (err) { return; }
      if (msg.t === "ping") { try { ch.send(JSON.stringify({ t: "pong" })); } catch (e2) {} return; }
      if (msg.t === "pong") return;
      if (msg.t === "state") { api.state = msg.s; emit("state", msg.s, id); return; }
      if (msg.t === "msg") {
        emit("data", msg.d, id);
        // the host is the hub: a star topology means relaying, or players two
        // and three never hear each other
        if (api.isHost) broadcast({ t: "msg", d: msg.d }, id);
      }
    });
    ch.addEventListener("close", function () { drop(id, "closed"); });
    pc.addEventListener("connectionstatechange", function () {
      if (pc.connectionState === "failed" || pc.connectionState === "disconnected")
        drop(id, pc.connectionState);
    });
    return rec;
  }

  /** Losing a player must not take the game down: tear that one peer down,
   *  tell the game, and carry on. The host keeps its slot open for a re-join. */
  function drop(id, why) {
    var rec = peers[id];
    if (!rec) return;
    delete peers[id];
    if (rec.timer) clearInterval(rec.timer);
    try { rec.ch.close(); } catch (e) {}
    try { rec.pc.close(); } catch (e) {}
    emit("close", id, why);
  }

  function sendTo(rec, obj) {
    try {
      if (rec.ch.readyState === "open") rec.ch.send(JSON.stringify(obj));
    } catch (e) { drop(rec.id, "send failed"); }
  }
  function broadcast(obj, exceptId) {
    Object.keys(peers).forEach(function (id) {
      if (id !== String(exceptId)) sendTo(peers[id], obj);
    });
  }

  // ── host / join ────────────────────────────────────────────────────────────
  function baseUrl() {
    return location.origin + location.pathname + location.search;
  }

  var LOCAL_RE = /^(localhost|127\.0\.0\.1|\[::1\])$/i;
  var baseCache = null;

  /** The invite URL has to be reachable from somebody else's phone, and
   *  http://localhost:5173/ is not. The karaoke preview server answers
   *  /api/lanhost with the address it can actually be reached on; deployed sites
   *  have no such problem and skip this entirely. */
  async function resolveBase() {
    if (baseCache) return baseCache;
    baseCache = baseUrl();
    if (!LOCAL_RE.test(location.hostname)) return baseCache;
    try {
      var r = await fetch("/api/lanhost", { cache: "no-store" });
      if (r.ok) {
        var j = await r.json();
        if (j && j.host) {
          baseCache = location.protocol + "//" + j.host +
            (j.port ? ":" + j.port : "") + location.pathname + location.search;
        }
      }
    } catch (e) { /* not the karaoke preview — the warning in the UI covers it */ }
    return baseCache;
  }

  /** True when the invite URL still points at this machine only — the QR would
   *  scan fine and then fail to open on anyone else's phone. */
  function localOnly() {
    try {
      return LOCAL_RE.test(new URL(baseCache || baseUrl()).hostname);
    } catch (e) { return false; }
  }

  async function host() {
    api.isHost = true;
    var pc = newPeerConnection();
    var id = "p" + nextId++;
    var ch = pc.createDataChannel(CHANNEL, { ordered: true });
    track(pc, ch, id);
    await pc.setLocalDescription(await pc.createOffer());
    await gathered(pc);
    var code = pack(pc.localDescription.sdp, false);
    pendingHost = { pc: pc, id: id };

    // Start listening for the answer here, so a game only has to show the QR
    // and wait for "open" — the return-tab hand-off is plumbing, not gameplay.
    if (stopWatching) stopWatching();
    stopWatching = watchForAnswer(function (raw) {
      accept(codeFromText(raw)).catch(function (e) { emit("error", e); });
    });

    var base = await resolveBase();
    return { code: code, url: base + "#kmp=" + code, id: id, localOnly: localOnly() };
  }

  async function join(code) {
    api.isHost = false;
    var f = unpack(code);
    if (f.isAnswer) throw new Error("that's an answer code, not an invitation");
    var pc = newPeerConnection();
    var id = "host";
    pc.addEventListener("datachannel", function (e) { track(pc, e.channel, id); });
    await pc.setRemoteDescription({ type: "offer", sdp: buildSdp(f, "offer") });
    await pc.setLocalDescription(await pc.createAnswer());
    await gathered(pc);
    var answer = pack(pc.localDescription.sdp, true);
    var base = await resolveBase();
    return { code: answer, url: base + "#kmpa=" + answer };
  }

  async function accept(answerCode) {
    if (!pendingHost) throw new Error("no invitation is waiting for an answer");
    var f = unpack(answerCode);
    if (!f.isAnswer) throw new Error("that's an invitation code, not an answer");
    await pendingHost.pc.setRemoteDescription({ type: "answer", sdp: buildSdp(f, "answer") });
    var id = pendingHost.id;
    pendingHost = null;
    if (stopWatching) { stopWatching(); stopWatching = null; }
    return id;
  }

  // ── getting the answer back to the host ────────────────────────────────────
  /** The host has to read a QR off the joiner's phone, and no scanner API is
   *  available everywhere. Three routes, best first:
   *
   *   1. BarcodeDetector — one tap, but Chrome-on-Android and little else.
   *   2. The host's own camera app opens the answer URL in a NEW TAB of this
   *      same origin. That tab drops the answer in localStorage and posts it on
   *      a BroadcastChannel; the game tab is listening. No scanner API at all.
   *   3. Paste the code.
   *
   * Route 2 is why the answer is shown as a URL rather than bare data. */
  function watchForAnswer(onAnswer) {
    var seen = "";
    var handle = function (code) {
      if (!code || code === seen) return;
      seen = code;
      onAnswer(code);
    };
    var bc = null;
    try {
      bc = new BroadcastChannel(CHANNEL);
      bc.addEventListener("message", function (e) {
        if (e.data && e.data.t === "answer") handle(e.data.code);
      });
    } catch (e) { /* no BroadcastChannel — localStorage still covers it */ }
    var poll = setInterval(function () {
      // polling as well as listening: a backgrounded tab can miss the live
      // event while the user is off in their camera app
      try {
        var v = localStorage.getItem(DROPBOX);
        if (v) { localStorage.removeItem(DROPBOX); handle(v); }
      } catch (e) {}
    }, 400);
    window.addEventListener("storage", function (e) {
      if (e.key === DROPBOX && e.newValue) handle(e.newValue);
    });
    return function stop() {
      clearInterval(poll);
      if (bc) try { bc.close(); } catch (e) {}
    };
  }

  /** Running in the tab the host's camera opened: hand the answer to the game
   *  tab and get out of the way. */
  function relayAnswerAndExit(code) {
    try { localStorage.setItem(DROPBOX, code); } catch (e) {}
    try {
      var bc = new BroadcastChannel(CHANNEL);
      bc.postMessage({ t: "answer", code: code });
      setTimeout(function () { try { bc.close(); } catch (e) {} }, 500);
    } catch (e) {}
  }

  function scannerAvailable() {
    return typeof window.BarcodeDetector !== "undefined" &&
           !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) &&
           window.isSecureContext;
  }

  async function scanWithCamera(mount, onCode) {
    var det = new window.BarcodeDetector({ formats: ["qr_code"] });
    var stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" }, audio: false });
    var video = document.createElement("video");
    video.setAttribute("playsinline", "");
    video.srcObject = stream;
    video.style.cssText = "width:100%;border-radius:9px;background:#000";
    mount.appendChild(video);
    await video.play();
    var stop = function () {
      stream.getTracks().forEach(function (t) { t.stop(); });
      video.remove();
    };
    var loop = setInterval(async function () {
      try {
        var found = await det.detect(video);
        if (found && found.length) {
          clearInterval(loop); stop();
          onCode(found[0].rawValue);
        }
      } catch (e) { /* a frame failed to decode; try the next one */ }
    }, 300);
    return function cancel() { clearInterval(loop); stop(); };
  }

  function codeFromText(text) {
    var m = /[#&]kmpa?=([A-Za-z0-9\-_]+)/.exec(text || "");
    return m ? m[1] : (text || "").trim();
  }

  // ── public API ─────────────────────────────────────────────────────────────
  api = {
    isHost: false,
    state: null,
    get peers() { return Object.keys(peers); },
    on: function (evt, fn) { (listeners[evt] = listeners[evt] || []).push(fn); return api; },
    off: function (evt, fn) {
      listeners[evt] = (listeners[evt] || []).filter(function (f) { return f !== fn; });
    },
    host: host,
    join: join,
    accept: accept,
    send: function (obj) { broadcast({ t: "msg", d: obj }); },
    setState: function (s) {
      api.state = s;
      if (api.isHost) broadcast({ t: "state", s: s });
      emit("state", s, "self");
    },
    disconnect: function () { Object.keys(peers).forEach(function (id) { drop(id, "left"); }); },
    // exposed for the test suite — the packing is the part worth testing
    _pack: pack, _unpack: unpack, _buildSdp: buildSdp, _readSdp: readSdp,
  };
  window.kmp = api;

  // ── dock UI ────────────────────────────────────────────────────────────────
  if (!window.kdock) return;

  var hash = location.hash || "";
  var offerInUrl = /[#&]kmp=([A-Za-z0-9\-_]+)/.exec(hash);
  var answerInUrl = /[#&]kmpa=([A-Za-z0-9\-_]+)/.exec(hash);

  if (answerInUrl) {                    // route 2: this tab exists only to relay
    relayAnswerAndExit(answerInUrl[1]);
    history.replaceState(null, "", baseUrl());
  }

  function qrBlock(url, caption) {
    var svg = window.kqr && window.kqr.svg ? window.kqr.svg(url, 210) : null;
    if (!svg) {
      return '<div class="k-msg bad">That code is too long for a QR (' +
        url.length + " characters). Use the copy button below.</div>";
    }
    return '<div style="text-align:center">' + svg +
      '<div class="k-note" style="margin-top:.3rem">' + caption + "</div></div>";
  }

  function copyRow(label, text) {
    return '<button class="k-btn" data-copy="' + encodeURIComponent(text) + '">' +
      label + "</button>";
  }

  function wireCopy(el) {
    el.querySelectorAll("[data-copy]").forEach(function (btn) {
      btn.addEventListener("click", async function () {
        var text = decodeURIComponent(btn.getAttribute("data-copy"));
        try {
          await navigator.clipboard.writeText(text);
          kdock.msg(el, "copied ✓");
        } catch (e) {
          var ta = el.querySelector("textarea") || document.createElement("textarea");
          ta.style.display = "block"; ta.value = text; el.appendChild(ta); ta.select();
          var ok = false;
          try { ok = document.execCommand("copy"); } catch (e2) {}
          kdock.msg(el, ok ? "copied ✓" : "copy it from the box", !ok);
        }
      });
    });
  }

  function renderPeers(el) {
    var box = el.querySelector("#kmp-peers");
    if (!box) return;
    var ids = api.peers;
    box.innerHTML = ids.length
      ? "<b>" + ids.length + " player" + (ids.length > 1 ? "s" : "") + " connected</b>"
      : '<span style="color:#6b7280">no players yet</span>';
  }

  kdock.add({
    id: "multiplayer", emoji: "🎮", label: "play", title: "Local multiplayer",
    render: function (el) {
      el.insertAdjacentHTML("beforeend",
        '<div id="kmp-body"></div><div id="kmp-peers" style="margin:.4rem 0"></div>' +
        '<div class="k-msg"></div><textarea style="display:none"></textarea>');
      var body = el.querySelector("#kmp-body");
      renderPeers(el);
      api.on("open", function () { renderPeers(el); kdock.msg(el, "player connected ✓"); });
      api.on("close", function (id, why) {
        renderPeers(el);
        kdock.msg(el, "player " + id + " left (" + why + ")", true);
      });

      function insecureNote() {
        return window.isSecureContext ? "" :
          '<div class="k-note" style="color:#b45309">This page is on plain HTTP, so ' +
          "the browser blocks camera access. The phone-camera route below still " +
          "works; in-page scanning does not.</div>";
      }

      async function showHost() {
        body.innerHTML = '<div class="k-note">Generating invitation…</div>';
        try {
          var inv = await api.host();
          body.innerHTML = qrBlock(inv.url,
            "Point a phone camera at this. It opens the game on their device.") +
            copyRow("Copy invite link", inv.url) +
            '<button class="k-btn" id="kmp-scan">I have their answer code…</button>' +
            (inv.localOnly
              ? '<div class="k-note" style="color:#b45309">This page is on ' +
                "<b>localhost</b>, so that link only opens on this machine. Reach " +
                "the preview by its network address (or deploy the site) before " +
                "anyone else can scan in.</div>"
              : "") +
            insecureNote();
          wireCopy(el);
          renderPeers(el);
          // host() is already watching for the answer; just react to the result
          api.on("open", function () {
            body.innerHTML = '<div class="k-note">Connected. Tap “Add another ' +
              'player” for the next one.</div>' +
              '<button class="k-btn primary" id="kmp-again">Add another player</button>';
            var again = el.querySelector("#kmp-again");
            if (again) again.addEventListener("click", showHost);
          });
          api.on("error", function (e) { kdock.msg(el, e.message || String(e), true); });
          el.querySelector("#kmp-scan").addEventListener("click", function () {
            showAnswerEntry();
          });
        } catch (e) {
          body.innerHTML = "";
          kdock.msg(el, e.message || String(e), true);
        }
      }

      function showAnswerEntry() {
        body.innerHTML = '<div id="kmp-cam"></div>' +
          '<div class="k-note">Scan their answer code, or paste it here:</div>' +
          '<textarea id="kmp-paste" placeholder="paste the answer code"></textarea>' +
          '<button class="k-btn primary" id="kmp-use">Connect</button>' +
          '<button class="k-btn" id="kmp-back">Back to the invitation</button>';
        el.querySelector("#kmp-back").addEventListener("click", showHost);
        el.querySelector("#kmp-use").addEventListener("click", async function () {
          try {
            await api.accept(codeFromText(el.querySelector("#kmp-paste").value));
            kdock.msg(el, "connecting…");
          } catch (e) { kdock.msg(el, e.message || String(e), true); }
        });
        if (scannerAvailable()) {
          scanWithCamera(el.querySelector("#kmp-cam"), async function (text) {
            try {
              await api.accept(codeFromText(text));
              kdock.msg(el, "connecting…");
            } catch (e) { kdock.msg(el, e.message || String(e), true); }
          }).catch(function (e) { kdock.msg(el, "camera unavailable: " + e.message, true); });
        }
      }

      async function showJoin(code) {
        body.innerHTML = '<div class="k-note">Answering the invitation…</div>';
        try {
          var ans = await api.join(code);
          body.innerHTML = qrBlock(ans.url,
            "Show this to the host — their camera reads it and the game starts.") +
            copyRow("Copy answer code", ans.code) + insecureNote();
          wireCopy(el);
        } catch (e) {
          body.innerHTML = "";
          kdock.msg(el, e.message || String(e), true);
        }
      }

      if (offerInUrl) {
        history.replaceState(null, "", baseUrl());
        showJoin(offerInUrl[1]);
      } else if (api.peers.length) {
        body.innerHTML = '<div class="k-note">In a game.</div>' +
          '<button class="k-btn primary" id="kmp-again">Add another player</button>';
        el.querySelector("#kmp-again").addEventListener("click", showHost);
      } else {
        body.innerHTML =
          '<button class="k-btn primary" id="kmp-create">Create game</button>' +
          '<button class="k-btn" id="kmp-manual">Join with a code…</button>' +
          '<div class="k-note">Everyone plays over a direct connection between ' +
          "browsers — no server, no internet needed beyond the same Wi-Fi.</div>";
        el.querySelector("#kmp-create").addEventListener("click", showHost);
        el.querySelector("#kmp-manual").addEventListener("click", function () {
          body.innerHTML = '<textarea id="kmp-join-code" placeholder="paste the invite code"></textarea>' +
            '<button class="k-btn primary" id="kmp-join-go">Join</button>';
          el.querySelector("#kmp-join-go").addEventListener("click", function () {
            showJoin(codeFromText(el.querySelector("#kmp-join-code").value));
          });
        });
      }
    },
  });

  // A tab opened purely to relay an answer says so, rather than looking broken.
  // Not on the "load" event: this file is injected by the feature loader, which
  // usually finishes after load has already fired — so that listener never runs.
  if (answerInUrl) {
    var banner = function () {
      var note = document.createElement("div");
      note.style.cssText = "position:fixed;inset:auto 0 0 0;z-index:99960;padding:1rem;" +
        "background:#065f46;color:#fff;font:600 15px system-ui;text-align:center";
      note.textContent = "✓ Answer sent back to the game — you can close this tab.";
      document.body.appendChild(note);
    };
    if (document.body) banner();
    else document.addEventListener("DOMContentLoaded", banner);
  }
})();
