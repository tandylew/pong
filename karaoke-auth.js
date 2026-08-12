/* karaoke-auth.js — drop-in login gate for karaoke sites.
 *
 * Rules:
 *   • The FIRST person to sign in creates the account — they become the admin.
 *   • After that, sign-up is closed: only the admin can add (or remove) users,
 *     via the 👑 Users panel shown when the admin is signed in.
 *   • Turn it off any time (karaoke-features.json → "auth": false) — data stays.
 *
 * The page stays veiled (karaoke-features.js hides it before first paint) until
 * this script has decided who you are, so a signed-out visitor never sees a
 * flash of somebody else's data on the way to the gate.
 *
 * Requires karaoke-store.js (window.kstore). Against a karaoke server the check
 * is real — the password is verified server-side and /api/data refuses to answer
 * without the session cookie. On a plain static host there is no server to
 * enforce anything, so the gate only separates users; see karaoke-store.js.
 */
(function () {
  "use strict";
  if (window.kveil) window.kveil.hold();     // keep the page hidden — we decide
  if (!window.kstore) {
    console.warn("karaoke-auth: kstore missing");
    if (window.kveil) window.kveil.release();
    return;
  }
  var k = window.kstore;

  /* Every rule below sets its own color as well as its background. These panels
   * are injected into someone else's page, and voice-built sites routinely set
   * `body{color:#fff}` or `input{color:#fff}` for a dark theme — inheriting that
   * onto a white card renders white-on-white, i.e. invisible. */
  var INK = "#111827", MUTED = "#6b7280", LINE = "#d1d5db", BAD = "#dc2626";
  var css = document.createElement("style");
  css.textContent =
    "#ka-gate,#ka-users,.ka-chip{color-scheme:light}" +
    "#ka-gate{position:fixed;inset:0;z-index:99990;background:#111827f2;display:flex;" +
    "align-items:center;justify-content:center;font-family:system-ui,sans-serif}" +
    "#ka-gate .card{background:#fff;color:" + INK + ";border-radius:14px;padding:1.6rem;" +
    "width:min(330px,92vw);box-shadow:0 20px 60px #0008}" +
    "#ka-gate h2{margin:0 0 .3rem;font-size:1.15rem;color:" + INK + "}" +
    "#ka-gate p{margin:0 0 1rem;font-size:.82rem;color:" + MUTED + ";line-height:1.45}" +
    "#ka-gate input{display:block;width:100%;box-sizing:border-box;margin:0 0 .6rem;" +
    "padding:.55rem .7rem;font:inherit;font-size:1rem;background:#fff;color:" + INK + ";" +
    "border:1px solid " + LINE + ";border-radius:8px}" +
    "#ka-gate input::placeholder{color:" + MUTED + ";opacity:1}" +
    "#ka-gate button{width:100%;padding:.6rem;font:inherit;font-size:1rem;font-weight:600;border:0;" +
    "border-radius:8px;background:" + INK + ";color:#fff;cursor:pointer}" +
    "#ka-gate button[disabled]{opacity:.6;cursor:progress}" +
    "#ka-gate .err{color:" + BAD + ";font-size:.8rem;min-height:1.1em;margin:.4rem 0 0}" +
    ".ka-chip{position:fixed;top:.6rem;right:.6rem;z-index:99980;display:flex;gap:.4rem;" +
    "font-family:system-ui,sans-serif;font-size:.78rem}" +
    ".ka-chip button{border:1px solid " + LINE + ";background:#ffffffe6;color:" + INK + ";" +
    "border-radius:99px;padding:.28rem .7rem;cursor:pointer;font:inherit;font-size:.78rem}" +
    ".ka-chip button:hover{background:#fff;border-color:#9ca3af}" +
    "#ka-users{position:fixed;top:2.6rem;right:.6rem;z-index:99985;background:#fff;" +
    "color:" + INK + ";border:1px solid " + LINE + ";border-radius:12px;padding:.9rem;width:230px;" +
    "font-family:system-ui,sans-serif;font-size:.82rem;box-shadow:0 12px 40px #0005}" +
    "#ka-users h3{margin:0 0 .5rem;font-size:.8rem;color:" + INK + "}" +
    "#ka-users .u{display:flex;justify-content:space-between;padding:.15rem 0;color:" + INK + "}" +
    "#ka-users .u b{font-weight:600}" +
    "#ka-users .u button{border:0;background:none;color:" + BAD + ";cursor:pointer;font:inherit}" +
    "#ka-users input{width:100%;box-sizing:border-box;margin:.25rem 0;padding:.4rem .5rem;" +
    "font:inherit;background:#fff;color:" + INK + ";border:1px solid " + LINE + ";border-radius:6px}" +
    "#ka-users input::placeholder{color:" + MUTED + ";opacity:1}" +
    "#ka-users .add{width:100%;margin-top:.3rem;padding:.45rem;border:0;border-radius:6px;" +
    "font:inherit;background:" + INK + ";color:#fff;cursor:pointer}";
  document.head.appendChild(css);

  function el(html) {
    var d = document.createElement("div");
    d.innerHTML = html;
    return d.firstElementChild;
  }
  function reveal() { if (window.kveil) window.kveil.release(); }

  async function showGate(first) {
    var gate = el(
      '<div id="ka-gate"><div class="card">' +
      "<h2>" + (first ? "Welcome — create the admin account" : "Sign in") + "</h2>" +
      "<p>" + (first
        ? "You're the first one here, so this account becomes the <b>admin</b>. Only the admin can add more users."
        : "Accounts are added by the admin. Ask them if you need one.") + "</p>" +
      '<input id="ka-name" placeholder="name" autocomplete="username">' +
      '<input id="ka-pass" type="password" placeholder="password" autocomplete="current-password">' +
      "<button id='ka-go'>" + (first ? "Create admin account" : "Sign in") + "</button>" +
      '<div class="err" id="ka-err"></div></div></div>');
    document.body.appendChild(gate);
    var busy = false;
    async function go() {
      if (busy) return;
      var btn = gate.querySelector("#ka-go");
      var name = gate.querySelector("#ka-name").value;
      var pass = gate.querySelector("#ka-pass").value;
      busy = true; btn.disabled = true;
      gate.querySelector("#ka-err").textContent = "";
      try {
        if (first) {
          name = await k.user.signup(name, pass);
          try { await k.sys.set("auth", { admin: name }); } catch (e) { /* server tracks roles */ }
        } else {
          await k.user.login(name, pass);
        }
        location.reload();
      } catch (e) {
        gate.querySelector("#ka-err").textContent = e.message || String(e);
        busy = false; btn.disabled = false;
      }
    }
    gate.querySelector("#ka-go").addEventListener("click", go);
    gate.addEventListener("keydown", function (e) { if (e.key === "Enter") go(); });
    gate.querySelector("#ka-name").focus();
  }

  async function isAdmin(me) {
    // With a server the role comes from the session, which the page can't forge.
    // Static hosting has no such thing, so fall back to the public marker.
    var flag = typeof k.user.admin === "function" ? k.user.admin() : null;
    if (typeof flag === "boolean") return flag;
    var rec = (await k.sys.get("auth", {})) || {};
    return rec.admin === me;
  }

  async function showChip(me) {
    var adm = await isAdmin(me);
    var chip = el('<div class="ka-chip">' +
      (adm ? "<button id='ka-adm'>👑 users</button>" : "") +
      "<button id='ka-out'>" + me + " ⏻</button></div>");
    document.body.appendChild(chip);
    chip.querySelector("#ka-out").addEventListener("click", async function () {
      await k.user.logout(); location.reload();
    });
    var admBtn = chip.querySelector("#ka-adm");
    if (admBtn) admBtn.addEventListener("click", function () {
      var open = document.getElementById("ka-users");
      if (open) { open.remove(); return; }
      usersPanel(me);
    });
  }

  async function usersPanel(me) {
    var users = await k.user.list();
    var panel = el('<div id="ka-users"><h3>👑 Users</h3>' +
      users.map(function (u) {
        return '<div class="u"><b>' + u + (u === me ? " (you)" : "") + "</b>" +
          (u === me ? "" : '<button data-del="' + u + '">✕</button>') + "</div>";
      }).join("") +
      '<input id="ka-nu" placeholder="new user name">' +
      '<input id="ka-np" type="password" placeholder="their password">' +
      '<button class="add" id="ka-add">Add user</button></div>');
    document.body.appendChild(panel);
    panel.addEventListener("click", async function (e) {
      var del = e.target.getAttribute && e.target.getAttribute("data-del");
      if (del && confirm("Remove user '" + del + "'? Their data stays in storage.")) {
        try { await k.user.remove(del); } catch (err) { alert(err.message || String(err)); }
        panel.remove(); usersPanel(me);
      }
    });
    panel.querySelector("#ka-add").addEventListener("click", async function () {
      try {
        await k.user.create(panel.querySelector("#ka-nu").value,
                            panel.querySelector("#ka-np").value);
        panel.remove(); usersPanel(me);
      } catch (e) { alert(e.message || String(e)); }
    });
  }

  (async function () {
    try {
      if (k.ready) await k.ready;
      var me = k.user.current();
      if (me) { reveal(); showChip(me); return; }
      var first = typeof k.user.firstRun === "function"
        ? await k.user.firstRun()
        : (await k.user.list()).length === 0;
      await showGate(first);                 // page stays veiled behind the gate
    } catch (e) {
      console.warn("karaoke-auth:", e);
      await showGate(false);
    }
  })();
})();
