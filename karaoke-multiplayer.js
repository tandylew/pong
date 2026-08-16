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
  var DROPBOX = "kmp:answer";           // localStorage hand-off, see watchForAnswer()
  var HOST_BEAT = "kmp:hosting";        // "a game tab here is waiting for one"

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

  function handleMessage(rec, id, raw) {
    rec.alive = Date.now();
    var msg;
    try { msg = JSON.parse(raw); } catch (err) { return; }
    if (msg.t === "ping") {
      // echo the sender's clock back untouched; they turn it into RTT
      try { rec.ch.send(JSON.stringify({ t: "pong", c: msg.c })); } catch (e2) {}
      return;
    }
    if (msg.t === "pong") {
      if (typeof msg.c === "number") {
        var sample = Math.max(0, now() - msg.c);
        // a rolling median would be nicer; an EMA is one line and good enough
        rec.rtt = rec.rtt == null ? sample : rec.rtt * 0.7 + sample * 0.3;
        api.rtt = rec.rtt;
      }
      return;
    }
    if (msg.t === "state") { api.state = msg.s; emit("state", msg.s, id); return; }
    if (msg.t === "snap") { takeSnapshot(msg, rec); return; }
    if (msg.t === "msg") {
      emit("data", msg.d, id);
      // the host is the hub: a star topology means relaying, or players two
      // and three never hear each other
      if (api.isHost) broadcast({ t: "msg", d: msg.d }, id);
    }
  }

  function track(pc, id) {
    var rec = { id: id, pc: pc, ch: null, fast: null, alive: Date.now(),
                timer: null, rtt: null };
    peers[id] = rec;
    pc.addEventListener("connectionstatechange", function () {
      if (pc.connectionState === "failed" || pc.connectionState === "disconnected")
        drop(id, pc.connectionState);
    });
    return rec;
  }

  /** Attach one of a peer's two channels. `kind` is "ch" (reliable, ordered —
   *  chat, control, joins) or "fast" (unreliable, unordered — position
   *  snapshots). Splitting them matters on real Wi-Fi: a lost position packet
   *  retransmitted in order arrives too late to be useful AND holds up every
   *  fresher one behind it, which is what rubber-banding actually is. */
  function attach(rec, channel, kind) {
    rec[kind] = channel;
    channel.addEventListener("message", function (e) { handleMessage(rec, rec.id, e.data); });
    channel.addEventListener("close", function () {
      if (kind === "ch") drop(rec.id, "closed");
    });
    if (kind !== "ch") return;
    channel.addEventListener("open", function () {
      rec.alive = Date.now();
      rec.timer = setInterval(function () {
        if (Date.now() - rec.alive > DEAD_MS) return drop(rec.id, "timed out");
        try { channel.send(JSON.stringify({ t: "ping", c: now() })); }
        catch (e) { drop(rec.id, "send failed"); }
      }, PING_MS);
      emit("open", rec.id);
      if (api.isHost && api.state !== null) sendTo(rec, { t: "state", s: api.state });
    });
  }

  /** Losing a player must not take the game down: tear that one peer down,
   *  tell the game, and carry on. The host keeps its slot open for a re-join. */
  function drop(id, why) {
    var rec = peers[id];
    if (!rec) return;
    delete peers[id];
    if (rec.timer) clearInterval(rec.timer);
    try { rec.ch.close(); } catch (e) {}
    try { rec.fast.close(); } catch (e) {}
    try { rec.pc.close(); } catch (e) {}
    if (!Object.keys(peers).length) api.rtt = null;
    emit("close", id, why);
  }

  function sendTo(rec, obj) {
    try {
      if (rec.ch && rec.ch.readyState === "open") rec.ch.send(JSON.stringify(obj));
    } catch (e) { drop(rec.id, "send failed"); }
  }
  /** Snapshots go over the unreliable channel and are simply dropped if it isn't
   *  ready — a stale position is worse than a missing one, and the next tick is
   *  milliseconds away. */
  function sendFast(rec, obj) {
    var c = rec.fast && rec.fast.readyState === "open" ? rec.fast : rec.ch;
    try {
      if (c && c.readyState === "open") c.send(JSON.stringify(obj));
    } catch (e) { /* let the heartbeat decide whether this peer is really gone */ }
  }
  function broadcast(obj, exceptId) {
    Object.keys(peers).forEach(function (id) {
      if (id !== String(exceptId)) sendTo(peers[id], obj);
    });
  }
  function broadcastFast(obj, exceptId) {
    Object.keys(peers).forEach(function (id) {
      if (id !== String(exceptId)) sendFast(peers[id], obj);
    });
  }

  // ── sync: making a moving object look the same on both screens ─────────────
  /* Sending positions 12 times a second and easing towards whatever arrived is
   * the obvious approach, and it always looks bad: the follower is a fixed lag
   * behind and moves in steps. Three things fix it, and none of them are the
   * network — the data channel here measures under 2 ms.
   *
   *   1. Send VELOCITY alongside position. The receiver can then work out where
   *      the object is *now* instead of drawing where it was.
   *   2. Subtract the wire time. A snapshot describes the world as of when it
   *      was sent, which was rtt/2 ago, so that has to be added back or every
   *      follower is permanently half a round-trip behind.
   *   3. Ease the CORRECTION, not the position. Predictions are wrong at every
   *      bounce; snapping is jarring and easing the position reintroduces lag.
   *      Easing only the error keeps latency at zero and hides the seam.
   *
   * Configure once, publish on the host, read on every frame:
   *
   *   kmp.sync.configure({ rate: 30, predict: { bx: "bvx", by: "bvy" } });
   *   kmp.sync.publish({ bx, by, bvx, bvy, score });   // host
   *   const s = kmp.sync.read();                       // anyone, every frame
   */
  var syncCfg = {
    rate: 30,
    predict: {},          // { positionKey: velocityKey } for linear prediction
    advance: null,        // optional (state, dtSeconds) => void — real physics
    maxAheadMs: 200,
    smoothMs: 90,
    /** Above this much error, TELEPORT instead of easing. Easing assumes the
     *  prediction drifted; when the host resets a ball to the centre, or a piece
     *  jumps, nothing drifted — and easing sends the object gliding across the
     *  board. Getting this wrong is the single most visible netcode bug there
     *  is, so the default is deliberately small. */
    snapAbove: 1.5,
  };
  var snap = null;            // newest snapshot + when it landed
  var corr = {};              // per-key correction still being eased away
  var lastPublish = 0;

  var now = (typeof performance !== "undefined" && performance.now)
    ? function () { return performance.now(); }
    : function () { return Date.now(); };

  function takeSnapshot(msg, rec) {
    var incoming = msg.s || {};
    if (snap) {
      // Where did we *say* things were a moment ago? The difference is either a
      // small mis-prediction to be smoothed away, or a genuine jump to be
      // obeyed at once. Telling those two apart is the whole job.
      var predicted = predictInto({}, snap, 0);
      var jumped = false, errs = {};
      for (var k in syncCfg.predict) {
        if (typeof predicted[k] !== "number" || typeof incoming[k] !== "number") continue;
        errs[k] = predicted[k] - incoming[k];
        if (Math.abs(errs[k]) > syncCfg.snapAbove) jumped = true;
      }
      if (jumped) {
        corr = {};            // a teleport: show it where it now is, immediately
        emit("jump", incoming, rec ? rec.id : null);
      } else {
        for (var e in errs) corr[e] = (corr[e] || 0) + errs[e];
      }
    }
    snap = { s: incoming, at: now(), t: msg.c };
    api.sync.seq = msg.n;
    emit("snapshot", incoming, rec ? rec.id : null);
  }

  function predictInto(out, from, extraMs) {
    var s = from.s, ageMs = Math.min(syncCfg.maxAheadMs, now() - from.at + extraMs);
    for (var k in s) out[k] = s[k];
    if (typeof syncCfg.advance === "function") {
      // The game's own integrator. Straight-line prediction walks a ball
      // through the wall it was about to bounce off; real physics doesn't.
      try {
        syncCfg.advance(out, ageMs / 1000);
        return out;
      } catch (err) { /* fall back to the linear form below */ }
    }
    for (var key in syncCfg.predict) {
      var vk = syncCfg.predict[key];
      if (typeof s[key] === "number" && typeof s[vk] === "number")
        out[key] = s[key] + s[vk] * (ageMs / 1000);
    }
    return out;
  }

  function readSync() {
    if (!snap) return null;
    // half the round trip is how stale the snapshot already was on arrival
    var lead = api.rtt ? api.rtt / 2 : 0;
    var out = predictInto({}, snap, lead);
    var decay = Math.exp(-16 / Math.max(1, syncCfg.smoothMs));   // ~per 16 ms frame
    for (var k in corr) {
      if (Math.abs(corr[k]) < 1e-4) { delete corr[k]; continue; }
      out[k] += corr[k];
      corr[k] *= decay;
    }
    return out;
  }

  function publishSync(state, force) {
    api.state = state;
    var t = now();
    if (!force && t - lastPublish < 1000 / syncCfg.rate) return false;
    lastPublish = t;
    broadcastFast({ t: "snap", s: state, c: t, n: ++api.sync.seq });
    return true;
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
    var rec = track(pc, id);
    // reliable for control, unreliable for the position firehose
    attach(rec, pc.createDataChannel(CHANNEL, { ordered: true }), "ch");
    attach(rec, pc.createDataChannel(CHANNEL + "-fast",
                                     { ordered: false, maxRetransmits: 0 }), "fast");
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
    var rec = track(pc, id);
    pc.addEventListener("datachannel", function (e) {
      attach(rec, e.channel, e.channel.label.endsWith("-fast") ? "fast" : "ch");
    });
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
    stopRoomWatch();      // roomAfterJoin decides whether to re-arm or close
    return id;
  }

  // ── room codes: signalling through /api/data when a server is there ────────
  /* A camera handshake is wonderful on two phones and miserable on a desktop
   * with no webcam. But every server-backed deployment already carries a
   * key-value store — the preview, the VM, Cloud Run + Firestore — and
   * signalling is nothing more than leaving a note somewhere both sides can
   * reach. So a "room" is one key:
   *
   *     rooms/<CODE> = {offer, answer, created}
   *
   * The host claims a code and polls for the answer; the joiner types the code
   * and writes one back. Nothing new to deploy, no camera, and it works the same
   * on the VM (files) and Cloud Run (Firestore) because the API is the same.
   * Static hosting has no such store — that is exactly when the QR path earns
   * its keep, and `rooms.available()` says which you've got.
   */
  var ROOM_KEY = "rooms/";
  var ROOM_TTL_MS = 15 * 60 * 1000;
  var ROOM_POLL_MS = 1500;
  var ROOM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";   // no O/0/I/1
  var apiState = null, roomTimer = null, myRoom = null, roomOrigin = null;

  /** Where room notes live. Normally this site's own /api/data — but a statically
   *  hosted copy has no server at all, so it can borrow one: point this at a
   *  deployment of the same game (Cloud Run or the VM) and typed room codes work
   *  on GitHub Pages too. That server is a MAILBOX, nothing more; play still goes
   *  browser-to-browser, and only `rooms/` is cross-origin readable.
   *
   *  `deploy_pages.py` wires this automatically when the project is also
   *  deployed somewhere with a server, via karaoke-rooms.json. */
  function roomBase() {
    return (roomOrigin ? roomOrigin.replace(/\/+$/, "") + "/" : "") + "api/data/";
  }

  async function loadRoomConfig() {
    if (roomOrigin !== null) return roomOrigin;
    roomOrigin = "";
    try {
      var r = await fetch("karaoke-rooms.json", { cache: "no-store" });
      if (r.ok) {
        var j = await r.json();
        if (j && j.origin) roomOrigin = String(j.origin);
      }
    } catch (e) { /* no config — this site's own API, or none at all */ }
    return roomOrigin;
  }

  async function apiAvailable() {
    if (apiState !== null) return apiState;
    await loadRoomConfig();
    try {
      var url = roomOrigin ? roomBase() + "rooms/probe" : "api/data";
      var r = await fetch(url, { cache: "no-store",
                                 credentials: roomOrigin ? "omit" : "same-origin" });
      // 401/403 still means a server is answering — it just wants a sign-in
      // first; 404 on the probe key means the store is there and simply empty
      apiState = r.ok || r.status === 401 || r.status === 403 ||
                 (!!roomOrigin && r.status === 404);
    } catch (e) { apiState = false; }
    return apiState;
  }

  function newCode(len) {
    var out = "", n = len || 4;
    var rnd = crypto.getRandomValues(new Uint8Array(n));
    for (var i = 0; i < n; i++) out += ROOM_ALPHABET[rnd[i] % ROOM_ALPHABET.length];
    return out;
  }

  async function readRoom(code) {
    var r = await fetch(roomBase() + ROOM_KEY + code,
                        { cache: "no-store", credentials: roomOrigin ? "omit" : "same-origin" });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(r.status === 401
      ? "sign in first — rooms live in this site's data store" : "room lookup failed");
    var rec = await r.json();
    if (!rec || (!rec.offer && !rec.full)) return null;
    if (Date.now() - (rec.created || 0) > ROOM_TTL_MS) return null;   // stale
    return rec;
  }

  async function writeRoom(code, rec) {
    var r = await fetch(roomBase() + ROOM_KEY + code, {
      method: "PUT", credentials: roomOrigin ? "omit" : "same-origin",
      body: JSON.stringify(rec) });
    if (!r.ok) throw new Error(r.status === 401
      ? "sign in first — rooms live in this site's data store" : "could not save the room");
  }

  function forgetRoom(code) {
    // the note has been read; leaving it lying around only invites confusion
    try { fetch(roomBase() + ROOM_KEY + code,
                { method: "DELETE", credentials: roomOrigin ? "omit" : "same-origin" }); } catch (e) {}
  }

  /** Put a fresh offer in the room under the code it already has.
   *
   *  A WebRTC offer answers exactly one peer, so a room that holds a single
   *  offer is a room exactly two people can ever use. Re-arming after each join
   *  is what lets one code seat a whole table — without it a four-player game
   *  built on this could never fill up. */
  async function armRoom(code) {
    var inv = await host();
    await writeRoom(code, { offer: inv.code, answer: null, created: Date.now() });
    return inv;
  }

  function watchRoom(code) {
    stopRoomWatch();
    var until = Date.now() + ROOM_TTL_MS;
    roomTimer = setInterval(async function () {
      if (Date.now() > until || myRoom !== code) return stopRoomWatch();
      try {
        var rec = await readRoom(code);
        if (rec && rec.answer) {
          stopRoomWatch();
          await accept(rec.answer);       // "open" fires next; roomAfterJoin re-arms
        }
      } catch (e) { /* a blip shouldn't end the wait */ }
    }, ROOM_POLL_MS);
  }

  /** Once a player is in: re-open the room for the next one, or close it. */
  async function roomAfterJoin() {
    if (!myRoom) return;
    var code = myRoom;
    if (api.peers.length >= api.maxPeers) {
      // leave a marker rather than deleting, so a latecomer is told the game is
      // full instead of "no such room", which reads like they typed it wrong
      try { await writeRoom(code, { full: true, created: Date.now() }); } catch (e) {}
      stopRoomWatch();
      myRoom = null;
      emit("full", code);
      return;
    }
    try {
      await armRoom(code);
      watchRoom(code);
    } catch (e) { emit("error", e); }
  }

  async function createRoom() {
    if (!(await apiAvailable()))
      throw new Error("this site has no server, so it can't hold room codes — share the link or QR instead");
    var code = "";
    for (var tries = 0; tries < 5 && !code; tries++) {
      var candidate = newCode(4);
      if (!(await readRoom(candidate))) code = candidate;      // free, or expired
    }
    if (!code) throw new Error("couldn't find a free room code — try again");
    myRoom = code;
    var inv = await armRoom(code);
    watchRoom(code);
    return { room: code, code: inv.code, url: inv.url, id: inv.id,
             localOnly: inv.localOnly };
  }

  function stopRoomWatch() {
    if (roomTimer) { clearInterval(roomTimer); roomTimer = null; }
  }

  async function joinRoom(code) {
    code = String(code || "").trim().toUpperCase();
    if (!code) throw new Error("enter a room code");
    if (!(await apiAvailable()))
      throw new Error("this site has no server, so room codes don't work here — paste the invite link instead");
    var rec = await readRoom(code);
    if (rec && rec.full) throw new Error('room "' + code + '" is full');
    if (!rec) throw new Error('no room "' + code + '" — check the code, or ask for a new one');
    var ans = await join(rec.offer);
    await writeRoom(code, { offer: rec.offer, answer: ans.code, created: rec.created });
    return ans;
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
    // Announce that a game tab is sitting here waiting. The relay tab checks
    // this before claiming success: if the hosting tab was closed — or the
    // player pasted the answer into it and navigated it away, which destroys the
    // connection — there is nobody to hand the answer to, and saying "sent back
    // to the game" would be a lie.
    var beat = setInterval(function () {
      try { localStorage.setItem(HOST_BEAT, String(Date.now())); } catch (e) {}
    }, 500);
    try { localStorage.setItem(HOST_BEAT, String(Date.now())); } catch (e) {}
    // Leaving the page takes the connection with it, so retract the claim at
    // once — otherwise the relay tab loads inside the heartbeat's grace window
    // and reports success to a game that no longer exists.
    var bye = function () { try { localStorage.removeItem(HOST_BEAT); } catch (e) {} };
    window.addEventListener("pagehide", bye);
    window.addEventListener("beforeunload", bye);
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
      clearInterval(beat);
      try { localStorage.removeItem(HOST_BEAT); } catch (e) {}
      if (bc) try { bc.close(); } catch (e) {}
    };
  }

  /** Is a game tab on this device actually waiting for an answer right now? */
  function hostIsWaiting() {
    try {
      var t = parseInt(localStorage.getItem(HOST_BEAT) || "0", 10);
      return Date.now() - t < 3000;
    } catch (e) { return false; }
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
    /** How many players this game seats, besides the host. A room code stays
     *  live until that many have joined, then reports itself full. Games with a
     *  fixed shape (pong is two paddles) must set this, or a third player
     *  silently ends up driving somebody else's piece. */
    maxPeers: Infinity,
    /** Peers you can actually talk to. A peer record exists from the moment its
     *  connection is created, which is well before the channel opens — reporting
     *  those as connected invites everyone to send into a socket that isn't
     *  listening yet, and then wonder where the message went. */
    get peers() {
      return Object.keys(peers).filter(function (id) {
        return peers[id].ch && peers[id].ch.readyState === "open";
      });
    },
    /** Everyone including those still handshaking — for "connecting…" UI. */
    get pending() {
      return Object.keys(peers).filter(function (id) {
        return !(peers[id].ch && peers[id].ch.readyState === "open");
      });
    },
    on: function (evt, fn) { (listeners[evt] = listeners[evt] || []).push(fn); return api; },
    off: function (evt, fn) {
      listeners[evt] = (listeners[evt] || []).filter(function (f) { return f !== fn; });
    },
    host: host,
    join: join,
    accept: accept,
    /** Room codes, when this site has a server to hold them. `available()` is
     *  what a game should branch on — it decides whether to offer a typed code
     *  or fall back to the QR/link handshake. */
    rooms: {
      available: apiAvailable,
      create: createRoom,
      join: joinRoom,
      current: function () { return myRoom; },
      cancel: function () {
        stopRoomWatch();
        if (myRoom) { forgetRoom(myRoom); myRoom = null; }
      },
    },
    send: function (obj) { broadcast({ t: "msg", d: obj }); },
    /** Fire-and-forget, over the unreliable channel. For anything sent every
     *  frame — paddle positions, cursor moves — where the newest value makes
     *  every older one irrelevant. */
    sendFast: function (obj) { broadcastFast({ t: "msg", d: obj }); },
    setState: function (s) {
      api.state = s;
      if (api.isHost) broadcast({ t: "state", s: s });
      emit("state", s, "self");
    },
    /** Round-trip time in ms, measured off the heartbeat. null until known. */
    rtt: null,
    sync: {
      seq: 0,
      configure: function (opts) {
        for (var k in (opts || {})) syncCfg[k] = opts[k];
        return syncCfg;
      },
      /** Host: hand over the authoritative state. Rate-limited to `rate`, so
       *  calling it every frame is fine and correct. */
      publish: publishSync,
      /** Anyone: the state advanced to right now. Call it per frame. */
      read: readSync,
      raw: function () { return snap && snap.s; },
      reset: function () { snap = null; corr = {}; },
    },
    disconnect: function () {
      stopRoomWatch();
      if (myRoom) { forgetRoom(myRoom); myRoom = null; }
      if (stopWatching) { stopWatching(); stopWatching = null; }
      Object.keys(peers).forEach(function (id) { drop(id, "left"); });
    },
    // exposed for the test suite — the packing is the part worth testing
    _pack: pack, _unpack: unpack, _buildSdp: buildSdp, _readSdp: readSdp,
  };
  window.kmp = api;

  // Once a player is in, the room either re-opens for the next one or closes.
  // Driven off "open" so it covers every route in — typed code, QR, or paste.
  api.on("open", function () { roomAfterJoin(); });

  /* Pasting the answer link into the address bar of the tab that is hosting is
   * the obvious thing to try, and it used to do nothing at all: the URL differs
   * only by its #fragment, so the browser changes the hash WITHOUT reloading,
   * and this file — which read the hash once at startup — never noticed.
   *
   * That same-document behaviour is a gift, though: the connection is still
   * alive, so the answer can simply be accepted on the spot. The instinct turns
   * out to be the fastest route there is. */
  window.addEventListener("hashchange", function () {
    var m = /[#&]kmpa=([A-Za-z0-9\-_]+)/.exec(location.hash || "");
    if (!m) return;
    history.replaceState(null, "", baseUrl());
    if (pendingHost) {
      accept(m[1]).catch(function (e) { emit("error", e); });
    } else {
      // no offer outstanding here — pass it to whichever tab is waiting
      relayAnswerAndExit(m[1]);
      emit("error", new Error(hostIsWaiting()
        ? "answer handed to the game tab that's waiting"
        : "no game on this device is waiting for an answer — create a room first"));
    }
  });

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

  /* The panel is re-rendered every time it opens, so its event handlers are
   * registered ONCE here against whichever element is currently mounted.
   * Registering them inside render() instead added a fresh set on every open,
   * each closed over a detached node — a leak that also fired the same message
   * N times after the panel had been opened N times. */
  var panel = { el: null, body: null, onConnected: null, showHost: null };
  api.on("open", function () {
    if (!panel.el) return;
    renderPeers(panel.el);
    kdock.msg(panel.el, "player connected ✓");
    if (panel.onConnected) panel.onConnected();
  });
  api.on("close", function (id, why) {
    if (!panel.el) return;
    renderPeers(panel.el);
    kdock.msg(panel.el, "player " + id + " left (" + why + ")", true);
  });
  api.on("error", function (e) {
    if (panel.el) kdock.msg(panel.el, e.message || String(e), true);
  });

  kdock.add({
    id: "multiplayer", emoji: "🎮", label: "play", title: "Local multiplayer",
    render: function (el) {
      el.insertAdjacentHTML("beforeend",
        '<div id="kmp-body"></div><div id="kmp-peers" style="margin:.4rem 0"></div>' +
        '<div class="k-msg"></div><textarea style="display:none"></textarea>');
      var body = el.querySelector("#kmp-body");
      panel.el = el; panel.body = body;
      renderPeers(el);

      function insecureNote() {
        return window.isSecureContext ? "" :
          '<div class="k-note" style="color:#b45309">This page is on plain HTTP, so ' +
          "the browser blocks camera access. The phone-camera route below still " +
          "works; in-page scanning does not.</div>";
      }

      function onConnected() {
        body.innerHTML = '<div class="k-note">Connected. Add another player for ' +
          "the next one.</div>" +
          '<button class="k-btn primary" id="kmp-again">Add another player</button>';
        var again = el.querySelector("#kmp-again");
        if (again) again.addEventListener("click", showHost);
      }
      panel.onConnected = onConnected;

      async function showHost() {
        body.innerHTML = '<div class="k-note">Opening a game…</div>';
        try {
          // Prefer a typed room code when this site has a server to hold one:
          // it's the only route that needs no camera at either end.
          if (await api.rooms.available()) {
            var r = await api.rooms.create();
            body.innerHTML =
              '<div style="text-align:center;margin:.3rem 0 .6rem">' +
              '<div class="k-note" style="margin:0">room code</div>' +
              '<div style="font:700 2.1rem/1.1 ui-monospace,monospace;letter-spacing:.18em;' +
              'color:#111827">' + r.room + "</div></div>" +
              '<div class="k-note">Other players open this site and enter that code. ' +
              "No camera needed.</div>" +
              qrBlock(r.url, "…or point a phone camera at this to skip the typing.") +
              copyRow("Copy invite link", r.url) +
              '<button class="k-btn" id="kmp-scan">Paste an answer code instead…</button>' +
              (r.localOnly ? localNote() : "");
          } else {
            var inv = await api.host();
            body.innerHTML = qrBlock(inv.url,
              "Point a phone camera at this. It opens the game on their device.") +
              copyRow("Copy invite link", inv.url) +
              '<button class="k-btn" id="kmp-scan">Paste an answer code instead…</button>' +
              '<div class="k-note">This site is statically hosted, so there is no ' +
              "server to keep room codes in — send the link any way you like " +
              "(message, email) and they can paste it.</div>" +
              (inv.localOnly ? localNote() : "") + insecureNote();
          }
          wireCopy(el);
          renderPeers(el);
          el.querySelector("#kmp-scan").addEventListener("click", showAnswerEntry);
        } catch (e) {
          body.innerHTML = "";
          kdock.msg(el, e.message || String(e), true);
        }
      }

      function localNote() {
        return '<div class="k-note" style="color:#b45309">This page is on ' +
          "<b>localhost</b>, so that link only opens on this machine. Reach the " +
          "preview by its network address (or deploy the site) first.</div>";
      }

      function showAnswerEntry() {
        var canScan = scannerAvailable();
        var canRead = !!(navigator.clipboard && navigator.clipboard.readText) &&
                      window.isSecureContext;
        body.innerHTML = '<div id="kmp-cam"></div>' +
          '<div class="k-note">' + (canScan
            ? "Hold their answer code up to the camera, or paste it:"
            : "Ask them to send you their answer code, then paste it here:") + "</div>" +
          '<textarea id="kmp-paste" placeholder="paste the answer code or link"></textarea>' +
          (canRead ? '<button class="k-btn" id="kmp-read">Paste from clipboard</button>' : "") +
          '<button class="k-btn primary" id="kmp-use">Connect</button>' +
          '<button class="k-btn" id="kmp-back">Back</button>';
        var paste = el.querySelector("#kmp-paste");
        el.querySelector("#kmp-back").addEventListener("click", showHost);

        var connect = async function (text) {
          try {
            await api.accept(codeFromText(text));
            kdock.msg(el, "connecting…");
          } catch (e) { kdock.msg(el, e.message || String(e), true); }
        };
        el.querySelector("#kmp-use").addEventListener("click", function () {
          connect(paste.value);
        });
        var read = el.querySelector("#kmp-read");
        if (read) read.addEventListener("click", async function () {
          try { paste.value = await navigator.clipboard.readText(); connect(paste.value); }
          catch (e) { kdock.msg(el, "clipboard not readable — paste it by hand", true); }
        });
        if (canScan) {
          scanWithCamera(el.querySelector("#kmp-cam"), function (text) { connect(text); })
            .catch(function (e) { kdock.msg(el, "camera unavailable: " + e.message, true); });
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

      async function showJoinEntry() {
        var hasRooms = await api.rooms.available();
        body.innerHTML =
          (hasRooms
            ? '<div class="k-note">Enter the host\'s room code:</div>' +
              '<input id="kmp-room" placeholder="CODE" maxlength="6" ' +
              'style="width:100%;box-sizing:border-box;margin:.25rem 0;padding:.5rem;' +
              'font:700 1.3rem/1 ui-monospace,monospace;text-align:center;' +
              "letter-spacing:.2em;text-transform:uppercase;background:#fff;color:#111827;" +
              'border:1px solid #d1d5db;border-radius:8px">' +
              '<button class="k-btn primary" id="kmp-room-go">Join room</button>' +
              '<div class="k-note" style="margin-top:.6rem">…or paste an invite link:</div>'
            : '<div class="k-note">Paste the invite link the host sent you:</div>') +
          '<textarea id="kmp-join-code" placeholder="paste the invite link or code"></textarea>' +
          '<button class="k-btn" id="kmp-join-go">Join with link</button>';
        var roomGo = el.querySelector("#kmp-room-go");
        if (roomGo) {
          var input = el.querySelector("#kmp-room");
          input.focus();
          var go = async function () {
            body.innerHTML = '<div class="k-note">Looking for that room…</div>';
            try {
              var ans = await api.rooms.join(input.value);
              body.innerHTML = '<div class="k-note">Found it — connecting…</div>' +
                qrBlock(ans.url, "If it stalls, show this to the host instead.");
            } catch (e) {
              await showJoinEntry();
              kdock.msg(el, e.message || String(e), true);
            }
          };
          roomGo.addEventListener("click", go);
          input.addEventListener("keydown", function (e) { if (e.key === "Enter") go(); });
        }
        el.querySelector("#kmp-join-go").addEventListener("click", function () {
          showJoin(codeFromText(el.querySelector("#kmp-join-code").value));
        });
      }

      if (offerInUrl) {
        history.replaceState(null, "", baseUrl());
        showJoin(offerInUrl[1]);
      } else if (api.peers.length) {
        onConnected();
      } else {
        body.innerHTML =
          '<button class="k-btn primary" id="kmp-create">Create game</button>' +
          '<button class="k-btn" id="kmp-manual">Join a game…</button>' +
          '<div class="k-note">Players connect directly, browser to browser — no ' +
          "game server, and no internet needed beyond the same Wi-Fi.</div>";
        el.querySelector("#kmp-create").addEventListener("click", showHost);
        el.querySelector("#kmp-manual").addEventListener("click", showJoinEntry);
      }
    },
  });

  // A tab opened purely to relay an answer says so, rather than looking broken.
  // Not on the "load" event: this file is injected by the feature loader, which
  // usually finishes after load has already fired — so that listener never runs.
  if (answerInUrl) {
    var delivered = hostIsWaiting();
    var banner = function () {
      var note = document.createElement("div");
      note.style.cssText = "position:fixed;inset:auto 0 0 0;z-index:99960;padding:1rem;" +
        "font:600 15px/1.5 system-ui;text-align:center;color:#fff;background:" +
        (delivered ? "#065f46" : "#7c2d12");
      if (delivered) {
        note.textContent = "✓ Answer sent back to the game — you can close this tab.";
      } else {
        // Almost always: they pasted the answer into the tab that was hosting,
        // which navigated it away and took the connection with it.
        note.innerHTML = "⚠ No game is waiting on this device.<br>" +
          "<span style='font-weight:400;font-size:14px'>The tab that created the " +
          "room was closed, or this link was opened in it. Create a room again and " +
          "use <b>“Paste their answer”</b> on that screen instead of opening the " +
          "link.</span>";
      }
      document.body.appendChild(note);
    };
    if (document.body) banner();
    else document.addEventListener("DOMContentLoaded", banner);
  }
})();
