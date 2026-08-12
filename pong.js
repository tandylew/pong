/* pong.js — 3D Pong (Three.js), local 2-player + online multiplayer.
 *
 * This deploys to GitHub Pages — plain static hosting, nobody answering
 * /api/data — so kstore has no shared backend to poll and localStorage
 * is private per browser. That rules out any store-and-poll approach for
 * crossing devices. Instead, online play uses real peer-to-peer WebRTC
 * (via PeerJS's free public signaling broker, id.peerjs.com) — the room
 * code IS the PeerJS id, the two browsers find each other through that
 * cloud broker just long enough to open a direct data channel, and all
 * game state after that flows browser-to-browser, no backend involved.
 * Needs a network path between the two peers (works on most home wifi;
 * strict corporate/school firewalls without STUN egress can block it).
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

  $("btnHost").addEventListener("click", async () => {
    const code = genCode();
    history.replaceState(null, "", "?room=" + code);
    await startHost(code);
  });

  $("btnJoin").addEventListener("click", async () => {
    const code = ($("joinCode").value || "").trim().toUpperCase();
    if (!code) { msgEl.textContent = "Enter a room code first."; return; }
    history.replaceState(null, "", "?room=" + code);
    await startGuest(code);
  });

  $("btnRematch").addEventListener("click", () => {
    if (state.mode === "local") { state.serve = -state.serve; resetMatch(); state.running = true; showGame(); }
    else showMenu();
  });
  $("btnMenu").addEventListener("click", () => showMenu());

  function genCode() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let s = "";
    for (let i = 0; i < 4; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
  }

  // prefill join code from URL, e.g. ?room=AB12
  const urlRoom = new URLSearchParams(location.search).get("room");
  if (urlRoom) $("joinCode").value = urlRoom.toUpperCase();

  // ---------- networking (WebRTC data channel via PeerJS) ----------
  // Namespaced so this game's room codes don't collide with other apps
  // sharing the same public broker's global id space.
  const PEER_NS = "kpong3d-";
  let peer = null, conn = null, netTimer = null, roomCode = null, joinTimeout = null;

  function teardownPeer() {
    if (netTimer) { clearInterval(netTimer); netTimer = null; }
    if (joinTimeout) { clearTimeout(joinTimeout); joinTimeout = null; }
    if (conn) { try { conn.close(); } catch (e) {} conn = null; }
    if (peer) { try { peer.destroy(); } catch (e) {} peer = null; }
    roomCode = null;
  }
  function stopNet() { teardownPeer(); }
  addEventListener("beforeunload", teardownPeer);

  function wireConnection(onOpen) {
    conn.on("open", () => {
      state.running = true;
      netEl.textContent = "Room " + roomCode + " — connected";
      if (netTimer) clearInterval(netTimer);
      netTimer = setInterval(sendState, SYNC_MS);
      if (onOpen) onOpen();
    });
    conn.on("data", (data) => {
      if (state.mode === "host") {
        netTarget.zR = data.z;
      } else if (state.mode === "guest") {
        netTarget.zL = data.zL; netTarget.bx = data.bx; netTarget.bz = data.bz;
        state.scoreL = data.sL; state.scoreR = data.sR;
      }
    });
    conn.on("close", () => {
      state.running = false;
      netEl.textContent = state.mode === "host" ? "Opponent disconnected." : "Host disconnected.";
      if (netTimer) { clearInterval(netTimer); netTimer = null; }
      conn = null;
    });
    conn.on("error", () => {
      netEl.textContent = "Connection error.";
    });
  }

  function sendState() {
    if (!conn || !conn.open) return;
    if (state.mode === "host") {
      conn.send({ zL: state.zL, bx: state.bx, bz: state.bz, sL: state.scoreL, sR: state.scoreR });
    } else if (state.mode === "guest") {
      conn.send({ z: state.zR });
    }
  }

  async function startHost(code) {
    mirrored = false; placeCamera();
    roomCode = code; state.mode = "host";
    state.serve = 1; resetMatch(); state.running = false;
    showGame();
    netEl.textContent = "Room " + code + " — opening…";

    peer = new Peer(PEER_NS + code);
    peer.on("open", () => {
      netEl.textContent = "Room " + code + " — waiting for opponent… (share via the dock's share button)";
    });
    peer.on("connection", (c) => {
      if (conn) { try { conn.close(); } catch (e) {} } // newest challenger wins
      conn = c;
      wireConnection();
    });
    peer.on("error", (err) => {
      if (err.type === "unavailable-id") {
        // vanishingly rare with a 4-char code, but don't get stuck on it
        const fresh = genCode();
        history.replaceState(null, "", "?room=" + fresh);
        teardownPeer();
        startHost(fresh);
      } else {
        netEl.textContent = "Couldn't open a room (" + err.type + "). Check your connection and try again.";
      }
    });
  }

  async function startGuest(code) {
    mirrored = true; placeCamera();
    roomCode = code; state.mode = "guest";
    resetMatch(); state.running = false;
    showGame();
    netEl.textContent = "Joining room " + code + "…";

    peer = new Peer();
    peer.on("open", () => {
      conn = peer.connect(PEER_NS + code, { reliable: true });
      wireConnection();
      conn.on("error", () => {}); // surfaced via peer's "error" below
      joinTimeout = setTimeout(() => {
        if (!state.running) {
          const msg = 'No room "' + code + '" found. Check the code (or ask the host to create one).';
          teardownPeer(); showMenu(msg);
        }
      }, 10000);
    });
    peer.on("error", (err) => {
      if (err.type === "peer-unavailable") {
        const msg = 'No room "' + code + '" found. Check the code (or ask the host to create one).';
        teardownPeer(); showMenu(msg);
      } else {
        const msg = "Couldn't connect (" + err.type + "). Check your connection and try again.";
        teardownPeer(); showMenu(msg);
      }
    });
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

  if (urlRoom) showMenu('Room "' + urlRoom + '" is ready to join below.');
})();
