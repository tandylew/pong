/* karaoke-backup.js — download / restore a real backup FILE. Static + offline.
 *
 *   Download → saves <site>-backup-<date>.json to your Downloads folder.
 *   Restore  → pick a backup file; every key in it is written back into kstore.
 *
 * The clipboard export (karaoke-tools.js) is for moving small data around; this
 * is the one you keep. Backups are plain JSON — readable, diffable, portable.
 *
 * Requires karaoke-store.js (window.kstore) and karaoke-features.js (kdock).
 */
(function () {
  "use strict";
  if (!window.kstore || !window.kdock) return;
  var k = window.kstore;

  async function collect() {
    if (window.kcollect) return window.kcollect();     // shared with tools.js
    var keys = await k.keys(), out = {};
    for (var i = 0; i < keys.length; i++) out[keys[i]] = await k.get(keys[i]);
    return out;
  }

  var siteName = (location.pathname.replace(/\/+$/, "").split("/").pop() || "site")
    .replace(/\.html?$/, "") || "site";

  kdock.add({
    id: "backup", emoji: "💾", label: "backup", title: "Backup & restore",
    render: function (el) {
      el.insertAdjacentHTML("beforeend",
        '<button class="k-btn primary" id="kb-dl">Download backup file</button>' +
        '<button class="k-btn" id="kb-pick">Restore from a file…</button>' +
        '<input type="file" id="kb-file" accept=".json,application/json" style="display:none">' +
        '<div class="k-msg"></div>' +
        '<div class="k-note">A dated .json file with everything you\'ve saved here. ' +
        'Keep it somewhere safe — restoring re-adds every item it contains.</div>');

      el.querySelector("#kb-dl").addEventListener("click", async function () {
        var data = await collect();
        var n = Object.keys(data).length;
        var payload = {
          karaokeBackup: 1,
          site: location.origin + location.pathname,
          user: k.user.current() || "guest",
          exported: new Date().toISOString(),
          data: data,
        };
        var blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
        var url = URL.createObjectURL(blob);
        var a = document.createElement("a");
        a.href = url;
        a.download = siteName + "-backup-" + new Date().toISOString().slice(0, 10) + ".json";
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
        kdock.msg(el, "saved " + n + " item" + (n === 1 ? "" : "s") + " to your downloads ✓");
      });

      el.querySelector("#kb-pick").addEventListener("click", function () {
        el.querySelector("#kb-file").click();
      });
      el.querySelector("#kb-file").addEventListener("change", function (ev) {
        var file = ev.target.files && ev.target.files[0];
        if (!file) return;
        var fr = new FileReader();
        fr.onload = async function () {
          try {
            var parsed = JSON.parse(fr.result);
            // accept a full backup file OR a bare clipboard-style object
            var data = parsed && parsed.data && parsed.karaokeBackup ? parsed.data : parsed;
            var keys = Object.keys(data);
            if (!keys.length) throw new Error("that file has no data in it");
            for (var i = 0; i < keys.length; i++) await k.set(keys[i], data[keys[i]]);
            kdock.msg(el, "restored " + keys.length + " item" +
                          (keys.length === 1 ? "" : "s") + " ✓ — reloading…");
            setTimeout(function () { location.reload(); }, 800);
          } catch (e) {
            kdock.msg(el, "couldn't read that backup: " + (e.message || e), true);
          }
        };
        fr.readAsText(file);
      });
    },
  });
})();
