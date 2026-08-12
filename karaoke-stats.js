/* karaoke-stats.js — how many people have opened this page. Static + offline.
 *
 * Counting happens on the SERVER when one is available (the karaoke preview or
 * a GCP deployment): POST /api/count/views increments data/counts/views.json
 * atomically, so every visitor is counted once and everyone sees the same
 * number. On a plain static host (GitHub Pages) there's nobody to count for
 * you, so it falls back to counting your own visits in this browser and says so.
 *
 * Requires karaoke-features.js (kdock).
 */
(function () {
  "use strict";
  if (!window.kdock) return;

  var LOCAL = "kstats:" + location.pathname;
  var state = { total: 0, today: 0, days: {}, server: false, done: false };

  function localBump() {
    var rec;
    try { rec = JSON.parse(localStorage.getItem(LOCAL) || "{}"); } catch (e) { rec = {}; }
    if (typeof rec.total !== "number") rec.total = 0;
    if (!rec.days || typeof rec.days !== "object") rec.days = {};
    var day = new Date().toISOString().slice(0, 10);
    rec.total++;
    rec.days[day] = (rec.days[day] || 0) + 1;
    try { localStorage.setItem(LOCAL, JSON.stringify(rec)); } catch (e) {}
    return rec;
  }

  var ready = (async function () {
    var day = new Date().toISOString().slice(0, 10);
    try {
      var r = await fetch("api/count/views", { method: "POST" });
      if (r.ok) {
        var rec = await r.json();
        state.total = rec.total || 0;
        state.days = rec.days || {};
        state.today = state.days[day] || 0;
        state.server = true;
        state.done = true;
        return state;
      }
    } catch (e) { /* no server — fall through */ }
    var loc = localBump();
    state.total = loc.total;
    state.days = loc.days;
    state.today = loc.days[day] || 0;
    state.done = true;
    return state;
  })();

  function bars(days) {
    var out = [], d = new Date();
    for (var i = 6; i >= 0; i--) {
      var t = new Date(d.getTime() - i * 86400000).toISOString().slice(0, 10);
      out.push({ day: t.slice(5), n: days[t] || 0 });
    }
    var max = Math.max.apply(null, out.map(function (o) { return o.n; }).concat([1]));
    return out.map(function (o) {
      var h = Math.round(o.n / max * 34) + 2;
      return '<div style="flex:1;text-align:center">' +
        '<div style="height:38px;display:flex;align-items:flex-end;justify-content:center">' +
        '<div title="' + o.n + ' on ' + o.day + '" style="width:70%;height:' + h +
        'px;background:#111827;border-radius:3px 3px 0 0"></div></div>' +
        '<div style="font-size:.58rem;color:#6b7280;margin-top:.2rem">' + o.day + "</div></div>";
    }).join("");
  }

  kdock.add({
    id: "stats", emoji: "📈", label: "visits", title: "Visits",
    render: function (el) {
      el.insertAdjacentHTML("beforeend", '<div id="ks-body">counting…</div>');
      ready.then(function (s) {
        var body = el.querySelector("#ks-body");
        if (!body) return;
        body.innerHTML =
          '<div style="display:flex;gap:.6rem;text-align:center;margin-bottom:.7rem">' +
          '<div style="flex:1;background:#f9fafb;border-radius:9px;padding:.5rem">' +
          '<div style="font-size:1.35rem;font-weight:700">' + s.total + "</div>" +
          '<div style="font-size:.66rem;color:#6b7280;text-transform:uppercase;' +
          'letter-spacing:.06em">total</div></div>' +
          '<div style="flex:1;background:#f9fafb;border-radius:9px;padding:.5rem">' +
          '<div style="font-size:1.35rem;font-weight:700">' + s.today + "</div>" +
          '<div style="font-size:.66rem;color:#6b7280;text-transform:uppercase;' +
          'letter-spacing:.06em">today</div></div></div>' +
          '<div style="display:flex;gap:.2rem;align-items:flex-end">' + bars(s.days) + "</div>" +
          '<div class="k-note">' + (s.server
            ? "Counted on the server — this is everyone's visits."
            : "No server here, so this counts only <b>your</b> visits in this browser. " +
              "Deploy to GCP for a real shared counter.") + "</div>";
      });
    },
  });
})();
