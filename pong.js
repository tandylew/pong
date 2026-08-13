/* pong.js — 3D Pong (Three.js), local 2-player + same-room multiplayer.
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
  const SYNC_MS = 80;                    // ~12Hz state exchange

  // ---------- three.js setup ----------
  const canvas = document.getElementById("game");
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b1020);
  scene.fog = new THREE.Fog(0x0b1020, 20, 42);

  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);

  scene.add(new THREE.AmbientLight(0x8899ff, 0.55));
  const key = new THREE.DirectionalLight(0xffffff, 1.1);
  key.position.set(6, 14, 8);
  scene.add(key);
  const rim = new THREE.PointLight(0x6366f1, 1.2, 40);
  rim.position.set(0, 6, 0);
  scene.add(rim);

  // court
  const court = new THREE.Mesh(
    new THREE.PlaneGeometry(HALF_W * 2, HALF_D * 2),
    new THREE.MeshStandardMaterial({ color: 0x131a33, roughness: 0.9 })
  );
  court.rotation.x = -Math.PI / 2;
  scene.add(court);

  // center line
  const centerLine = new THREE.Mesh(
    new THREE.PlaneGeometry(0.08, HALF_D * 2),
    new THREE.MeshBasicMaterial({ color: 0x3b4270 })
  );
  centerLine.rotation.x = -Math.PI / 2;
  centerLine.position.y = 0.01;
  scene.add(centerLine);

  // walls (top/bottom)
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x6366f1, emissive: 0x2a2f6b, emissiveIntensity: 0.6 });
  [-1, 1].forEach((s) => {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(HALF_W * 2 + 0.4, 0.4, 0.25), wallMat);
    wall.position.set(0, 0.2, s * (HALF_D + 0.1));
    scene.add(wall);
  });

  function makePaddle(color) {
    const m = new THREE.Mesh(
      new THREE.BoxGeometry(PADDLE_D, PADDLE_H * 0.5, PADDLE_H),
      new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.35 })
    );
    m.position.y = PADDLE_H * 0.25;
    scene.add(m);
    return m;
  }
  const paddleL = makePaddle(0x22d3ee);
  const paddleR = makePaddle(0xf472b6);
  paddleL.position.x = -PADDLE_X;
  paddleR.position.x = PADDLE_X;

  const ball = new THREE.Mesh(
    new THREE.SphereGeometry(BALL_R, 20, 16),
    new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xaaaaaa, emissiveIntensity: 0.4 })
  );
  ball.position.y = BALL_R + 0.05;
  scene.add(ball);

  function resize() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(canvas);

  // camera: top-down-ish, angled from the local player's side so "their"
  // paddle reads on the left. mirrored flips the whole court left/right.
  let mirrored = false;
  function placeCamera() {
    const side = mirrored ? -1 : 1;   // opposite side of the court flips apparent left/right
    camera.position.set(0.5, 13, side * 11);
    camera.lookAt(0, 0, 0);
  }
  placeCamera();

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

    kmp.on("open", () => {
      connected = true;
      hideQr();
      state.running = true;
      netEl.textContent = "Connected — playing";
      if (netTimer) clearInterval(netTimer);
      netTimer = setInterval(sendState, SYNC_MS);
    });

    kmp.on("data", (d) => {
      if (state.mode === "host") {
        netTarget.zR = d.z;
      } else if (state.mode === "guest") {
        netTarget.zL = d.zL; netTarget.bx = d.bx; netTarget.bz = d.bz;
        state.scoreL = d.sL; state.scoreR = d.sR;
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
      kmp.send({ zL: state.zL, bx: state.bx, bz: state.bz, sL: state.scoreL, sR: state.scoreR });
    } else if (state.mode === "guest") {
      kmp.send({ z: state.zR });
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
      if (keys.has("w") || keys.has("W") || keys.has("ArrowUp")) state.zL -= PADDLE_SPEED * dt;
      if (keys.has("s") || keys.has("S") || keys.has("ArrowDown")) state.zL += PADDLE_SPEED * dt;
      state.zL = clampZ(state.zL);
      state.zR += (netTarget.zR - state.zR) * Math.min(1, dt * 10);
      if (state.running) stepBall(dt, true, true);
    } else if (state.mode === "guest") {
      if (keys.has("w") || keys.has("W") || keys.has("ArrowUp")) state.zR -= PADDLE_SPEED * dt;
      if (keys.has("s") || keys.has("S") || keys.has("ArrowDown")) state.zR += PADDLE_SPEED * dt;
      state.zR = clampZ(state.zR);
      state.zL += (netTarget.zL - state.zL) * Math.min(1, dt * 10);
      // ball + score are host-authoritative: smoothly follow, don't simulate
      state.bx += (netTarget.bx - state.bx) * Math.min(1, dt * 12);
      state.bz += (netTarget.bz - state.bz) * Math.min(1, dt * 12);
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
    paddleL.position.z = state.zL;
    paddleR.position.z = state.zR;
    ball.position.x = state.bx;
    ball.position.z = state.bz;
    renderer.render(scene, camera);
  }

  requestAnimationFrame(frame);
})();
