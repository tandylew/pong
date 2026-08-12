/* karaoke-features.js — loads this site's optional features from
 * karaoke-features.json, and gives them one shared UI: a small dock in the
 * bottom-right corner that each feature adds a button to.
 *
 * Everything here is static + offline: turning a feature on or off is just
 * editing that JSON file (the Karaoke HUD does it with a switch) — no Claude,
 * no internet, no build step.
 *
 * Features:
 *   auth   → karaoke-auth.js    login gate; first user = admin; admin adds users
 *   tools  → karaoke-tools.js   copy all my data to/from the clipboard
 *   backup → karaoke-backup.js  download/restore a .json backup file
 *   pwa    → karaoke-pwa.js     installable app + offline cache (karaoke-sw.js)
 *   qr     → karaoke-qr.js      share this page as a QR code
 *   stats  → karaoke-stats.js   visit counter
 *
 * Dock API for features:  kdock.add({id, emoji, label, title, render(el)})
 */
(function () {
  "use strict";

  /* ---------- the veil: no data on screen before the gate decides ----------
   * This runs at parse time, BEFORE the page has painted, because the login gate
   * can only be shown after two async steps (read the feature file, ask the
   * server who you are) and until then the page would be sitting there in plain
   * view with everybody's data in it.
   *
   * `visibility` is inherited and re-overridable, so the gate itself stays
   * visible while everything behind it does not. If auth turns out to be off, or
   * nothing ever claims the veil, it lifts on its own. */
  var veiled = false, held = false, veilTimer = null;
  var veilCss = document.createElement("style");
  veilCss.textContent =
    "html.ka-veil body{visibility:hidden!important}" +
    "html.ka-veil #ka-gate,html.ka-veil #ka-gate *{visibility:visible!important}";
  (document.head || document.documentElement).appendChild(veilCss);
  document.documentElement.classList.add("ka-veil");
  veiled = true;
  window.kveil = {
    hold: function () { held = true; clearTimeout(veilTimer); },
    release: function () {
      clearTimeout(veilTimer);
      if (veiled) { document.documentElement.classList.remove("ka-veil"); veiled = false; }
    },
    held: function () { return held; },
  };
  // failsafe: if karaoke-auth.js never loads (feature off, 404, blocked), the
  // page must not stay blank. Auth, once loaded, owns the veil instead.
  veilTimer = setTimeout(function () { if (!held) window.kveil.release(); }, 5000);

  /* Injected panels set their own color everywhere they set a background: this
   * UI lands inside somebody else's stylesheet, and a site with `body{color:#fff}`
   * would otherwise paint white text onto these white cards. */
  var css = document.createElement("style");
  css.textContent =
    "#kdock,#kpanel{color-scheme:light}" +
    "#kdock{position:fixed;bottom:.75rem;right:.75rem;z-index:99970;display:flex;gap:.3rem;" +
    "font-family:system-ui,-apple-system,sans-serif;font-size:.8rem}" +
    "#kdock button{display:flex;align-items:center;gap:.3rem;border:1px solid #d1d5db;" +
    "background:#ffffffe8;backdrop-filter:blur(6px);border-radius:99px;padding:.4rem .7rem;" +
    "cursor:pointer;font:inherit;font-size:.8rem;color:#111827;box-shadow:0 2px 10px #0002;transition:.12s}" +
    "#kdock button:hover{border-color:#9ca3af;transform:translateY(-1px)}" +
    "#kdock button.on{background:#111827;color:#fff;border-color:#111827}" +
    "#kpanel{position:fixed;bottom:3.3rem;right:.75rem;z-index:99975;background:#fff;color:#111827;" +
    "border:1px solid #d1d5db;border-radius:14px;padding:1rem;width:min(300px,92vw);" +
    "max-height:min(70vh,520px);overflow:auto;font-family:system-ui,-apple-system,sans-serif;" +
    "font-size:.82rem;box-shadow:0 14px 44px #0004}" +
    "#kpanel h3{margin:0 0 .6rem;font-size:.85rem;color:#111827}" +
    "#kpanel .k-btn{display:block;width:100%;margin:.25rem 0;padding:.5rem;border:1px solid #d1d5db;" +
    "border-radius:9px;background:#f9fafb;color:#111827;cursor:pointer;font:inherit;font-size:.82rem;" +
    "text-align:center}" +
    "#kpanel .k-btn:hover{background:#f3f4f6}" +
    "#kpanel .k-btn.primary{background:#111827;border-color:#111827;color:#fff}" +
    "#kpanel .k-msg{min-height:1.1em;font-size:.75rem;color:#059669;margin-top:.4rem;word-break:break-word}" +
    "#kpanel .k-msg.bad{color:#dc2626}" +
    "#kpanel .k-note{font-size:.72rem;color:#6b7280;line-height:1.5;margin-top:.5rem}" +
    "#kpanel textarea{width:100%;box-sizing:border-box;height:110px;margin:.3rem 0;" +
    "font:.72rem ui-monospace,monospace;background:#fff;color:#111827;" +
    "border:1px solid #d1d5db;border-radius:8px;padding:.4rem}" +
    "#kpanel textarea::placeholder{color:#6b7280;opacity:1}" +
    "@media print{#kdock,#kpanel{display:none}}";
  document.head.appendChild(css);

  var dock = null, panel = null, openId = null;
  var items = [];

  function ensureDock() {
    if (dock) return dock;
    dock = document.createElement("div");
    dock.id = "kdock";
    document.body.appendChild(dock);
    return dock;
  }

  function closePanel() {
    if (panel) { panel.remove(); panel = null; }
    openId = null;
    Array.prototype.forEach.call(dock ? dock.children : [], function (b) {
      b.classList.remove("on");
    });
  }

  function openPanel(item, btn) {
    closePanel();
    openId = item.id;
    btn.classList.add("on");
    panel = document.createElement("div");
    panel.id = "kpanel";
    panel.innerHTML = "<h3>" + item.emoji + " " + (item.title || item.label) + "</h3>";
    document.body.appendChild(panel);
    item.render(panel);
  }

  window.kdock = {
    add: function (item) {
      items.push(item);
      var d = ensureDock();
      var btn = document.createElement("button");
      btn.type = "button";
      btn.setAttribute("data-k", item.id);      // stable hook for styling & tests
      btn.title = item.title || item.label;
      btn.innerHTML = "<span>" + item.emoji + "</span><span>" + item.label + "</span>";
      btn.addEventListener("click", function () {
        if (openId === item.id) closePanel();
        else openPanel(item, btn);
      });
      d.appendChild(btn);
      return btn;
    },
    close: closePanel,
    // features call this to report a result inside their panel
    msg: function (el, text, bad) {
      var m = el.querySelector(".k-msg");
      if (!m) { m = document.createElement("div"); m.className = "k-msg"; el.appendChild(m); }
      m.textContent = text;
      m.classList.toggle("bad", !!bad);
    },
  };

  document.addEventListener("click", function (e) {
    if (!panel) return;
    if (!panel.contains(e.target) && !(dock && dock.contains(e.target))) closePanel();
  });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") closePanel(); });

  function load(src) {
    return new Promise(function (res) {
      var s = document.createElement("script");
      s.src = src; s.onload = res; s.onerror = res;
      document.head.appendChild(s);
    });
  }

  async function boot() {
    var f = {};
    try {
      var r = await fetch("karaoke-features.json", { cache: "no-store" });
      if (r.ok) f = await r.json();
    } catch (e) { /* file:// or missing config — nothing to enable */ }
    window.kfeatures = f || {};
    if (window.kfeatures.auth) await load("karaoke-auth.js");   // gate first
    else window.kveil.release();          // nothing to gate — show the page now
    if (!window.kveil.held()) window.kveil.release();  // auth script failed to load
    if (window.kfeatures.tools) await load("karaoke-tools.js");
    if (window.kfeatures.backup) await load("karaoke-backup.js");
    if (window.kfeatures.qr) await load("karaoke-qr.js");
    if (window.kfeatures.stats) await load("karaoke-stats.js");
    if (window.kfeatures.pwa) await load("karaoke-pwa.js");
    else if ("serviceWorker" in navigator) {
      // feature turned OFF — make sure a previously installed worker/cache goes away
      navigator.serviceWorker.getRegistrations().then(function (rs) {
        rs.forEach(function (r) { r.unregister(); });
      }).catch(function () {});
      if (window.caches) caches.keys().then(function (ks) {
        ks.forEach(function (k) { if (k.indexOf("karaoke-") === 0) caches.delete(k); });
      }).catch(function () {});
    }
  }
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
