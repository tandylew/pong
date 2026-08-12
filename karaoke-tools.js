/* karaoke-tools.js — clipboard import/export for karaoke sites. Static + offline.
 *
 *   Export → copies EVERYTHING the signed-in user stored via kstore to the
 *            clipboard as plain text (pretty-printed JSON, one object).
 *   Import → paste that text back (same site, another browser, another site…)
 *            and every key is written into kstore.
 *
 * Requires karaoke-store.js (window.kstore) and karaoke-features.js (kdock).
 */
(function () {
  "use strict";
  if (!window.kstore || !window.kdock) return;
  var k = window.kstore;

  async function collect() {
    var keys = await k.keys();
    var out = {};
    for (var i = 0; i < keys.length; i++) out[keys[i]] = await k.get(keys[i]);
    return out;
  }
  window.kcollect = collect;               // reused by karaoke-backup.js

  kdock.add({
    id: "tools", emoji: "📋", label: "copy", title: "Copy my data",
    render: function (el) {
      el.insertAdjacentHTML("beforeend",
        '<button class="k-btn primary" id="kt-ex">Copy all my data</button>' +
        '<button class="k-btn" id="kt-im">Paste data to import…</button>' +
        '<textarea style="display:none" placeholder="paste exported data here"></textarea>' +
        '<button class="k-btn" id="kt-go" style="display:none">Import now</button>' +
        '<div class="k-msg"></div>' +
        '<div class="k-note">Plain text (JSON) — move your data to another browser, ' +
        'device, or site by copying it out and pasting it back in.</div>');

      el.querySelector("#kt-ex").addEventListener("click", async function () {
        var data = await collect();
        var n = Object.keys(data).length;
        var text = JSON.stringify(data, null, 2);
        try {
          await navigator.clipboard.writeText(text);
          kdock.msg(el, "copied " + n + " item" + (n === 1 ? "" : "s") + " ✓");
        } catch (e) {                       // clipboard blocked → manual copy
          var ta = el.querySelector("textarea");
          ta.style.display = "block"; ta.value = text; ta.select();
          var ok = false;
          try { ok = document.execCommand("copy"); } catch (e2) {}
          kdock.msg(el, ok ? "copied " + n + " ✓" : "clipboard blocked — copy from the box", !ok);
        }
      });
      el.querySelector("#kt-im").addEventListener("click", function () {
        el.querySelector("textarea").style.display = "block";
        el.querySelector("#kt-go").style.display = "block";
        el.querySelector("textarea").focus();
      });
      el.querySelector("#kt-go").addEventListener("click", async function () {
        try {
          var data = JSON.parse(el.querySelector("textarea").value);
          var keys = Object.keys(data);
          for (var i = 0; i < keys.length; i++) await k.set(keys[i], data[keys[i]]);
          kdock.msg(el, "imported " + keys.length + " ✓ — reloading…");
          setTimeout(function () { location.reload(); }, 700);
        } catch (e) {
          kdock.msg(el, "that isn't valid exported data: " + (e.message || e), true);
        }
      });
    },
  });
})();
