/* pong.js — Pong, local 2-player + same-room multiplayer.
 *
 * Online play is real peer-to-peer WebRTC over karaoke-multiplayer.js: the
 * host shows a QR code, the other player scans it with an ordinary phone
 * camera, and their answer travels back the same way. After that every byte
 * of game state goes browser-to-browser with nothing in between.
 *
 * This replaced a PeerJS version. PeerJS looked simpler but needs two things
 * this doesn't have: a script from a CDN, and its cloud broker at
 * id.peerjs.com to introduce the two browsers — so "no backend" was never
 * quite true, and a blocked CDN or a busy broker meant no game. The QR
 * handshake carries the introduction itself.
 *
 * Host is authoritative: it simulates the ball and owns the score, the guest
 * sends only its paddle position. Losing the opponent pauses rather than ends.
 *
 * Two things make the ball look the same on both screens, and neither is the
 * network — the data channel round-trips in under 2 ms here:
 *   • Rendering is a flat 2D canvas. As Three.js this measured 22 FPS with two
 *     windows open on one laptop, and no amount of netcode fixes a 22 FPS ball.
 *   • Snapshots carry velocity, and the guest asks kmp.sync.read() where things
 *     are NOW rather than easing towards where they were. See karaoke-multiplayer.js.
 */
(function () {
  "use strict";

  // ---------- constants ----------
  const HALF_W = 10, HALF_D = 6;         // court half-extents (X, Z)
  const WALL_Z = HALF_D - 0.3;           // z at which ball bounces off top/bottom
  const PADDLE_X = HALF_W - 0.6;         // paddle x offset from center
  const PADDLE_H = 1.8, PADDLE_W = 0.35, PADDLE_D = 0.35;
  const BALL_R = 0.22;
  const PADDLE_SPEED = 9;                // units/sec
  const BALL_SPEED0 = 6.5;
  const BALL_SPEED_MAX = 16;
  const WIN_SCORE = 7;
  const SYNC_MS = 33;                    // 30 Hz snapshots (was 12 Hz)

  // ---------- 2D canvas renderer ----------
  // This was Three.js. Two WebGL contexts on one laptop measured 22 FPS each —
  // the ball stuttered for reasons that had nothing to do with the network
  // (the data channel round-trips in under 2 ms). A flat canvas draws the same
  // game in a fraction of the budget, and pong loses nothing by being flat.
  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d");
  let mirrored = false, viewW = 0, viewH = 0, scale = 1;

  function resize() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr; canvas.height = h * dpr;
    }
    viewW = w; viewH = h;
    scale = Math.min(w / (HALF_W * 2 + 1.5), h / (HALF_D * 2 + 1.5));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  new ResizeObserver(resize).observe(canvas);

  // The guest sits at the other end of the table, so its view is flipped —
  // whoever is holding the device always drives the paddle on the left.
  function placeCamera() { /* kept: the guest's view flips via `mirrored` */ }

  const toX = (x) => viewW / 2 + (mirrored ? -x : x) * scale;
  const toY = (z) => viewH / 2 + (mirrored ? -z : z) * scale;
  // ---------- game state ----------
  const state = {
    mode: "menu",           // menu | local | host | guest
    zL: 0, zR: 0,            // paddle z positions
    bx: 0, bz: 0, bvx: 0, bvz: 0,
    scoreL: 0, scoreR: 0,
    serve: 1,                 // 1 -> serves toward right, -1 -> toward left
    running: false,
  };

  function resetBall(dir) {
    state.bx = 0; state.bz = 0;
    const ang = (Math.random() * 0.6 - 0.3);
    state.bvx = dir * BALL_SPEED0 * Math.cos(ang);
    state.bvz = BALL_SPEED0 * Math.sin(ang);
  }

  function resetMatch() {
    state.zL = 0; state.zR = 0;
    state.scoreL = 0; state.scoreR = 0;
    resetBall(state.serve);
  }

  // A debug window onto the live state. Multiplayer bugs are invisible from
  // outside — you cannot tell a stutter from a mis-prediction by looking — so
  // the test harness reads both players' idea of the ball from here.
  window.__pong = state;

  // ---------- input ----------
  const keys = new Set();
  addEventListener("keydown", (e) => keys.add(e.key));
  addEventListener("keyup", (e) => keys.delete(e.key));

  function clampZ(z) { return Math.max(-WALL_Z + PADDLE_H / 2, Math.min(WALL_Z - PADDLE_H / 2, z)); }

  // ---------- UI wiring ----------
  const $ = (id) => document.getElementById(id);
  const menu = $("menu"), hud = $("hud"), scoreEl = $("score"), msgEl = $("msg"), netEl = $("netStatus");
  const winOverlay = $("winOverlay"), winText = $("winText");

  function showMenu(msg) {
    state.mode = "menu"; state.running = false;
    menu.style.display = "grid"; hud.style.display = "none"; winOverlay.style.display = "none";
    if (msg) msgEl.textContent = msg; else msgEl.textContent = "";
    stopNet();
  }
  function showGame() {
    menu.style.display = "none"; hud.style.display = "flex"; winOverlay.style.display = "none";
  }

  $("btnLocal").addEventListener("click", () => {
    mirrored = false; placeCamera();
    state.mode = "local"; state.serve = Math.random() < 0.5 ? 1 : -1;
    resetMatch(); state.running = true; showGame();
    netEl.textContent = "Local 2-player — Left: W/S · Right: ↑/↓";
  });

  $("btnHost").addEventListener("click", () => startHost());

  // One box takes either: a short room code (server-backed sites) or a pasted
  // invite link (static hosting). Telling them apart is easy enough that asking
  // the player which one they have would be rude.
  $("btnJoin").addEventListener("click", async () => {
    const raw = ($("joinCode").value || "").trim();
    if (!raw) { msgEl.textContent = "Enter a room code, or paste the host's link."; return; }
    if (!(await netReady())) return;
    const link = /[#&]kmp=([A-Za-z0-9\-_]+)/.exec(raw);
    if (link) return startGuest(link[1]);
    if (/^[A-Za-z0-9]{4,6}$/.test(raw)) return joinByRoom(raw);
    await startGuest(raw);                     // a bare invite code
  });

  async function joinByRoom(code) {
    wireNet();
    mirrored = true; placeCamera();
    state.mode = "guest";
    resetMatch(); state.running = false;
    showGame();
    netEl.textContent = "Looking for room " + code.toUpperCase() + "…";
    try {
      const ans = await kmp.rooms.join(code);
      netEl.textContent = "Room found — connecting…";
      qrPanel(ans.url, "Connecting…", "If this stalls, show the code to the host.");
    } catch (e) {
      showMenu(e.message || String(e));
    }
  }

  $("btnRematch").addEventListener("click", () => {
    if (state.mode === "local") { state.serve = -state.serve; resetMatch(); state.running = true; showGame(); }
    else if (connected) { state.serve = -state.serve; resetMatch(); state.running = true; showGame(); }
    else showMenu();
  });
  $("btnMenu").addEventListener("click", () => showMenu());
  $("qrClose").addEventListener("click", () => hideQr());

  // ---------- networking (WebRTC data channel via karaoke-multiplayer.js) ----
  let netTimer = null, connected = false;

  function stopNet() {
    if (netTimer) { clearInterval(netTimer); netTimer = null; }
    connected = false;
    if (window.kmp) kmp.disconnect();
  }
  addEventListener("beforeunload", stopNet);

  function qrPanel(url, heading, caption, bigCode) {
    const svg = window.kqr ? kqr.svg(url, 230) : null;
    $("qrTitle").textContent = heading;
    $("qrBig").textContent = bigCode || "";
    $("qrBig").style.display = bigCode ? "block" : "none";
    $("qrCaption").textContent = caption;
    $("qrCode").innerHTML = svg ||
      "<p class='sub'>Couldn't draw the code — use the link button below.</p>";
    $("qrLink").onclick = async () => {
      try { await navigator.clipboard.writeText(url); $("msg").textContent = "Link copied."; }
      catch (e) {
        // clipboard needs a secure context; plain HTTP falls back to selection
        const ta = $("qrFallback");
        ta.style.display = "block"; ta.value = url; ta.select();
        $("msg").textContent = "Copy the link from the box.";
      }
    };
    $("qrOverlay").style.display = "grid";
  }
  function hideQr() { $("qrOverlay").style.display = "none"; }

  function wireNet() {
    if (wireNet.done) return;
    wireNet.done = true;

    // Positions get republished constantly, so the newest one makes every older
    // one worthless — exactly what the unreliable channel is for. Velocities go
    // with them so the guest can work out where the ball is NOW rather than
    // drawing where it was one packet ago.
    // Two paddles, so exactly one opponent. Without this the room would stay
    // open and a third player would end up driving the same paddle as the second.
    kmp.maxPeers = 1;

    kmp.sync.configure({
      rate: 30,
      predict: { bx: "bvx", bz: "bvz", zL: "vzL" },
      maxAheadMs: 200,
      smoothMs: 90,
      // A point resets the ball to the middle. That is a jump, not a
      // mis-prediction, and easing it sends the ball gliding the length of the
      // court — which is exactly what "the ball is glitching" looked like.
      // Anything further than this and the guest simply obeys the host.
      snapAbove: 1.2,
      // Predict with the real rules rather than a straight line, so the ball
      // bounces off the walls between snapshots instead of walking through them.
      advance: (s, dt) => {
        s.bx += s.bvx * dt;
        s.bz += s.bvz * dt;
        if (Math.abs(s.bz) > WALL_Z) {
          s.bz = Math.sign(s.bz) * WALL_Z;
          s.bvz *= -1;
        }
        // Past the end line a point has been scored and the host is about to
        // reset. Hold the ball at the edge rather than predicting it off into
        // space for the ~33 ms until that snapshot lands.
        if (Math.abs(s.bx) > HALF_W) {
          s.bx = Math.sign(s.bx) * HALF_W;
          s.bvx = 0; s.bvz = 0;
        }
        if (typeof s.zL === "number" && typeof s.vzL === "number")
          s.zL = clampZ(s.zL + s.vzL * dt);
      },
    });

    kmp.on("open", () => {
      connected = true;
      hideQr();
      state.running = true;
      netEl.textContent = "Connected — playing";
      if (netTimer) clearInterval(netTimer);
      netTimer = setInterval(sendState, SYNC_MS);
    });

    kmp.on("data", (d) => {
      // the only thing a guest sends is its paddle
      if (state.mode === "host" && typeof d.z === "number") {
        netTarget.zR = d.z; netTarget.vzR = d.vz || 0; netTarget.at = performance.now();
      }
    });

    // A dropped opponent pauses the match instead of ending it, so the host can
    // put a fresh code up and whoever wandered off can walk back in.
    kmp.on("close", () => {
      connected = false;
      state.running = false;
      if (netTimer) { clearInterval(netTimer); netTimer = null; }
      netEl.textContent = state.mode === "host"
        ? "Opponent left — tap Create Room for a new code."
        : "Host left. Back to the menu.";
      if (state.mode === "guest") setTimeout(() => showMenu("The host disconnected."), 1200);
    });

    kmp.on("error", (e) => { $("msg").textContent = e.message || String(e); });
  }

  function sendState() {
    if (!connected) return;
    if (state.mode === "host") {
      // one authoritative snapshot: where things are AND how fast they're going
      kmp.sync.publish({
        bx: state.bx, bz: state.bz, bvx: state.bvx, bvz: state.bvz,
        zL: state.zL, vzL: state.vzL || 0,
        sL: state.scoreL, sR: state.scoreR, run: state.running,
      }, true);
    } else if (state.mode === "guest") {
      kmp.sendFast({ z: state.zR, vz: state.vzR || 0 });
    }
  }

  // The feature modules are injected asynchronously, so they may not exist yet
  // when this file first runs — wait for the loader rather than poll for globals.
  async function netReady() {
    if (window.kready) { try { await window.kready; } catch (e) {} }
    if (window.kmp && window.kqr) return true;
    showMenu("Online play needs the multiplayer feature turned on for this site.");
    return false;
  }

  async function startHost() {
    if (!(await netReady())) return;
    wireNet();
    mirrored = false; placeCamera();
    state.mode = "host";
    state.serve = 1; resetMatch(); state.running = false;
    showGame();
    netEl.textContent = "Opening a room…";
    try {
      // A typed room code needs no camera at either end, so it wins whenever
      // this site has a server to keep one in. On static hosting there isn't
      // one, and the QR/link handshake carries the introduction instead.
      if (await kmp.rooms.available()) {
        const r = await kmp.rooms.create();
        netEl.textContent = "Room " + r.room + " — waiting for an opponent";
        qrPanel(r.url, "Room " + r.room,
          "They open this site on any device and type " + r.room +
          " — or point a phone camera at the code to skip the typing.", r.room);
      } else {
        const inv = await kmp.host();
        netEl.textContent = "Waiting for an opponent…";
        qrPanel(inv.url, "Scan or share to join",
          inv.localOnly
            ? "This page is on localhost, so the link only opens on this machine — deploy it or use the network address."
            : "Point their phone camera at this, or send them the link. On a computer, paste the link into Join.");
      }
    } catch (e) {
      showMenu(e.message || String(e));
    }
  }

  async function startGuest(code) {
    if (!(await netReady())) return;
    wireNet();
    mirrored = true; placeCamera();
    state.mode = "guest";
    resetMatch(); state.running = false;
    showGame();
    netEl.textContent = "Answering the invitation…";
    try {
      const ans = await kmp.join(code);
      qrPanel(ans.url, "Show this to the host",
        "Their camera reads it and the match starts. It opens a tab on their phone that closes itself.");
    } catch (e) {
      showMenu(e.message || String(e));
    }
  }

  // Arriving from a scanned invitation: the URL carries the offer, so skip the
  // menu entirely and go straight to answering it.
  const invite = /[#&]kmp=([A-Za-z0-9\-_]+)/.exec(location.hash || "");
  if (invite) {
    history.replaceState(null, "", location.pathname + location.search);
    startGuest(invite[1]);
  }

  // interpolation targets for values arriving over the network
  const netTarget = { zL: 0, zR: 0, bx: 0, bz: 0 };

  // ---------- main loop ----------
  let last = performance.now();
  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    resize();
    update(dt);
    render();
  }

  function update(dt) {
    if (state.mode === "menu") return;

    if (state.mode === "local") {
      if (keys.has("w") || keys.has("W")) state.zL -= PADDLE_SPEED * dt;
      if (keys.has("s") || keys.has("S")) state.zL += PADDLE_SPEED * dt;
      if (keys.has("ArrowUp")) state.zR -= PADDLE_SPEED * dt;
      if (keys.has("ArrowDown")) state.zR += PADDLE_SPEED * dt;
      state.zL = clampZ(state.zL); state.zR = clampZ(state.zR);
      if (state.running) stepBall(dt, true, true);
    } else if (state.mode === "host") {
      const before = state.zL;
      if (keys.has("w") || keys.has("W") || keys.has("ArrowUp")) state.zL -= PADDLE_SPEED * dt;
      if (keys.has("s") || keys.has("S") || keys.has("ArrowDown")) state.zL += PADDLE_SPEED * dt;
      state.zL = clampZ(state.zL);
      state.vzL = dt > 0 ? (state.zL - before) / dt : 0;
      // the guest's paddle arrives with its velocity too, so carry it forward
      // between packets instead of easing towards a position that's already old
      const age = Math.min(0.25, (performance.now() - (netTarget.at || 0)) / 1000);
      state.zR = clampZ(netTarget.zR + (netTarget.vzR || 0) * age);
      if (state.running) stepBall(dt, true, true);
    } else if (state.mode === "guest") {
      const before = state.zR;
      if (keys.has("w") || keys.has("W") || keys.has("ArrowUp")) state.zR -= PADDLE_SPEED * dt;
      if (keys.has("s") || keys.has("S") || keys.has("ArrowDown")) state.zR += PADDLE_SPEED * dt;
      state.zR = clampZ(state.zR);          // own paddle: never wait for the wire
      state.vzR = dt > 0 ? (state.zR - before) / dt : 0;
      // Everything else is the host's to decide. read() hands back the snapshot
      // advanced to *now* — extrapolated along the velocities that came with it
      // and offset by half the round trip — so the ball is where the host is
      // drawing it, not where it was a packet ago.
      const s = kmp.sync.read();
      if (s) {
        state.bx = s.bx; state.bz = s.bz;
        state.bvx = s.bvx; state.bvz = s.bvz;
        state.zL = clampZ(s.zL);
        state.scoreL = s.sL; state.scoreR = s.sR;
        state.running = !!s.run;
      }
    }

    scoreEl.textContent = state.scoreL + " – " + state.scoreR;
    if (state.mode !== "guest" && state.running) checkWin();
  }

  function stepBall(dt, bounceWalls, bouncePaddles) {
    state.bx += state.bvx * dt;
    state.bz += state.bvz * dt;

    if (bounceWalls && Math.abs(state.bz) > WALL_Z) {
      state.bz = Math.sign(state.bz) * WALL_Z;
      state.bvz *= -1;
    }

    if (bouncePaddles) {
      // left paddle
      if (state.bvx < 0 && state.bx - BALL_R <= -PADDLE_X + PADDLE_D / 2 && state.bx > -PADDLE_X - 1) {
        if (Math.abs(state.bz - state.zL) <= PADDLE_H / 2 + BALL_R) {
          reflect(-1, state.zL);
        }
      }
      // right paddle
      if (state.bvx > 0 && state.bx + BALL_R >= PADDLE_X - PADDLE_D / 2 && state.bx < PADDLE_X + 1) {
        if (Math.abs(state.bz - state.zR) <= PADDLE_H / 2 + BALL_R) {
          reflect(1, state.zR);
        }
      }
    }

    if (state.bx < -HALF_W) { score("R"); }
    else if (state.bx > HALF_W) { score("L"); }
  }

  function reflect(fromSide, paddleZ) {
    const rel = (state.bz - paddleZ) / (PADDLE_H / 2); // -1..1
    const speed = Math.min(BALL_SPEED_MAX, Math.hypot(state.bvx, state.bvz) * 1.06);
    const ang = rel * (Math.PI / 3.2); // up to ~56deg
    state.bvx = -fromSide * speed * Math.cos(ang);
    state.bvz = speed * Math.sin(ang);
    state.bx = fromSide === -1 ? -PADDLE_X + PADDLE_D / 2 + BALL_R : PADDLE_X - PADDLE_D / 2 - BALL_R;
  }

  function score(who) {
    if (who === "L") state.scoreL++; else state.scoreR++;
    resetBall(who === "L" ? 1 : -1);
    // Don't make the guest wait up to a whole tick to learn the ball moved: a
    // discrete event is worth a packet of its own, and it's the one moment the
    // two screens would otherwise visibly disagree.
    if (state.mode === "host" && connected) sendState();
  }

  function checkWin() {
    if (state.scoreL >= WIN_SCORE || state.scoreR >= WIN_SCORE) {
      state.running = false;
      const leftWon = state.scoreL > state.scoreR;
      winText.textContent = (state.mode === "guest")
        ? (leftWon ? "Host wins!" : "You win!")
        : (state.mode === "host")
          ? (leftWon ? "You win!" : "Opponent wins!")
          : (leftWon ? "Left wins!" : "Right wins!");
      winOverlay.style.display = "grid";
    }
  }

  function render() {
    if (!viewW) resize();
    ctx.fillStyle = "#0b1020";
    ctx.fillRect(0, 0, viewW, viewH);

    const left = toX(-HALF_W), right = toX(HALF_W);
    const top = toY(-HALF_D), bot = toY(HALF_D);
    const x0 = Math.min(left, right), y0 = Math.min(top, bot);
    const w = Math.abs(right - left), h = Math.abs(bot - top);

    ctx.fillStyle = "#131a33";
    ctx.fillRect(x0, y0, w, h);
    ctx.strokeStyle = "#6366f1";
    ctx.lineWidth = 3;
    ctx.strokeRect(x0, y0, w, h);

    ctx.strokeStyle = "#3b4270";
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 10]);
    ctx.beginPath();
    ctx.moveTo(toX(0), y0); ctx.lineTo(toX(0), y0 + h);
    ctx.stroke();
    ctx.setLineDash([]);

    const pw = Math.max(4, PADDLE_W * scale * 2);
    const ph = PADDLE_H * scale;
    const paddle = (x, z, colour) => {
      ctx.fillStyle = colour;
      ctx.fillRect(toX(x) - pw / 2, toY(z) - ph / 2, pw, ph);
    };
    paddle(-PADDLE_X, state.zL, "#22d3ee");
    paddle(PADDLE_X, state.zR, "#f472b6");

    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.arc(toX(state.bx), toY(state.bz), Math.max(3, BALL_R * scale * 1.6), 0, Math.PI * 2);
    ctx.fill();
  }

  requestAnimationFrame(frame);
})();
