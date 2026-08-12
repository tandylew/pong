/* karaoke-pwa.js — makes this site installable and usable offline.
 *
 * Registers karaoke-sw.js (a network-first service worker: always fresh when
 * online, still opens when you're not) and links karaoke-manifest.json, which
 * the Karaoke HUD generates with this project's name.
 *
 * Network-first is deliberate: a cache-first worker would serve stale pages
 * back into the karaoke preview while you're voice-building.
 *
 * Requires karaoke-features.js (kdock) for the install button.
 */
(function () {
  "use strict";

  if (!document.querySelector('link[rel="manifest"]')) {
    var link = document.createElement("link");
    link.rel = "manifest";
    link.href = "karaoke-manifest.json";
    document.head.appendChild(link);
  }

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("karaoke-sw.js").catch(function (e) {
        console.warn("karaoke-pwa: service worker not registered —", e.message || e);
      });
    });
  }

  // Chrome/Edge fire this when the site qualifies for installation; stash it so
  // the dock button can trigger the real prompt on a user gesture.
  var deferred = null, btn = null;
  window.addEventListener("beforeinstallprompt", function (e) {
    e.preventDefault();
    deferred = e;
    if (!btn && window.kdock) {
      btn = kdock.add({
        id: "pwa", emoji: "📱", label: "install", title: "Install this app",
        render: function (el) {
          el.insertAdjacentHTML("beforeend",
            '<button class="k-btn primary" id="kp-go">Install on this device</button>' +
            '<div class="k-msg"></div>' +
            '<div class="k-note">Adds it to your home screen or app list and lets it ' +
            "open without a browser bar — and without a connection.</div>");
          el.querySelector("#kp-go").addEventListener("click", async function () {
            if (!deferred) { kdock.msg(el, "already installed, or not available here", true); return; }
            deferred.prompt();
            var res = await deferred.userChoice;
            kdock.msg(el, res.outcome === "accepted" ? "installing ✓" : "maybe later");
            deferred = null;
          });
        },
      });
    }
  });

  window.addEventListener("appinstalled", function () {
    deferred = null;
    if (btn) btn.remove();
  });
})();
