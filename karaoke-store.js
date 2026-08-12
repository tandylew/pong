/* karaoke-store.js — out-of-the-box persistence + accounts for voice-built sites.
 *
 * Where the data lives depends on what is answering:
 *   • A karaoke server (local preview, or a GCP deployment running serve_site.py)
 *     is the SOURCE OF TRUTH. Reads go to /api/data first and localStorage is
 *     only the offline copy. This matters: caching the server's answer and never
 *     re-checking it is what used to make sign-in fail everywhere except a fresh
 *     incognito window, because the browser kept answering from a users list it
 *     had cached before the account existed.
 *   • On static hosting (GitHub Pages) nobody is answering, so localStorage is
 *     the working copy and the committed data/*.json files are read-only seed.
 *
 * API (all async unless noted):
 *   kstore.set(key, value)          kstore.get(key, fallback?)
 *   kstore.del(key)                 kstore.keys()
 *   kstore.ready                    (promise — resolved once the server, if any,
 *                                    has been asked who you are)
 *   kstore.user.current()  (sync)   kstore.user.signup(name, password)
 *   kstore.user.login(name, password)                kstore.user.logout()
 *
 * Data is namespaced per signed-in user (or "guest").
 *
 * ⚠️ Honest limits: with a karaoke server, accounts are real — passwords are
 * checked server-side and the session cookie is HttpOnly and signed (see
 * site_auth.py), so one user cannot read another's data. On a PLAIN STATIC HOST
 * there is nobody to enforce any of that: the gate is cosmetic and everything
 * committed under data/ is public. Deploy to GCP if the data matters.
 */
(function () {
  "use strict";
  const SITE = "ks:" + location.pathname.replace(/[^a-z0-9]/gi, "_");
  const API = "/api/data";
  const AUTH = "/api/auth";
  const OPTS = { cache: "no-store", credentials: "same-origin" };

  // null once we know nobody is serving this site (static hosting)
  let server = null;

  async function probe() {
    try {
      const r = await fetch(AUTH + "/status", OPTS);
      if (r.ok) return await r.json();
    } catch (e) { /* fall through */ }
    try {                                   // a karaoke server from before accounts
      const r = await fetch(API, OPTS);
      if (r.ok) return { enabled: false, user: null, admin: false, first_run: true };
    } catch (e) { /* fall through */ }
    return null;                            // static host
  }

  const ready = probe().then((s) => { server = s; return s; });
  const gated = () => !!(server && server.enabled);

  async function post(path, payload) {
    const r = await fetch(path, {
      ...OPTS, method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload || {}),
    });
    let body = {};
    try { body = await r.json(); } catch (e) {}
    return { ok: r.ok, status: r.status, body };
  }

  // ---- raw path helpers (path = "seg/seg", NOT user-namespaced) ----
  const lsKey = (path) => SITE + ":" + path;
  function readLocal(path) {
    const s = localStorage.getItem(lsKey(path));
    if (s === null) return undefined;
    try { return JSON.parse(s); } catch (e) { return undefined; }
  }
  const writeLocal = (path, v) => {
    try { localStorage.setItem(lsKey(path), JSON.stringify(v)); } catch (e) {}
  };
  const dropLocal = (path) => localStorage.removeItem(lsKey(path));

  /** Forget every cached value for this site. Called on sign-in and sign-out —
   *  without it the next user would be shown the previous user's cached data. */
  function dropAllLocal() {
    const doomed = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.indexOf(SITE + ":") === 0) doomed.push(k);
    }
    doomed.forEach((k) => localStorage.removeItem(k));
  }

  async function rawGet(path, fallback) {
    await ready;
    if (server) {
      try {
        const r = await fetch(`${API}/${path}`, OPTS);
        if (r.ok) { const v = await r.json(); writeLocal(path, v); return v; }
        if (r.status === 401 || r.status === 403 || r.status === 404) {
          dropLocal(path);                  // gone, or not ours to see
          return fallback;
        }
      } catch (e) { /* offline — the cached copy is the best we have */ }
      const local = readLocal(path);
      return local === undefined ? fallback : local;
    }
    const local = readLocal(path);           // static host: local writes win
    if (local !== undefined) return local;
    try {                                    // …then the committed seed data
      const r = await fetch(`data/${path}.json`, { cache: "no-store" });
      if (r.ok) { const v = await r.json(); writeLocal(path, v); return v; }
    } catch (e) {}
    return fallback;
  }

  async function rawSet(path, value) {
    await ready;
    if (server) {
      const r = await fetch(`${API}/${path}`, {
        ...OPTS, method: "PUT", body: JSON.stringify(value),
      });
      if (!r.ok) {
        // a refused write must NOT look like it worked, or the page shows data
        // the server never accepted
        dropLocal(path);
        let msg = "save failed";
        try { msg = (await r.json()).error || msg; } catch (e) {}
        throw new Error(r.status === 401 ? "sign in first" : msg);
      }
    }
    writeLocal(path, value);
    return value;
  }

  async function rawDel(path) {
    await ready;
    if (server) {
      try { await fetch(`${API}/${path}`, { ...OPTS, method: "DELETE" }); } catch (e) {}
    }
    dropLocal(path);
  }

  // ---- users ----
  async function sha256(text) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  const USERS = "system/users";
  const clean = (name) => String(name || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
  const sessionUser = () => sessionStorage.getItem(SITE + ":user") || null;

  const user = {
    /** Sync, so ns() can use it. Await kstore.ready first if you need it to be
     *  the *server's* answer rather than a stale local one. */
    current() { return gated() ? (server.user || null) : sessionUser(); },
    /** true/false when the server knows (it owns the roles); null on a static
     *  host, where the caller falls back to the public system/auth record. */
    admin() { return gated() ? !!server.admin : null; },
    /** True when nobody has signed up yet — the gate offers to create the admin. */
    async firstRun() {
      await ready;
      if (gated()) return !!server.first_run;
      return (await user.list()).length === 0;
    },
    async list() {
      await ready;
      if (gated()) {
        if (!server.user) return [];        // the roster is not public
        const r = await fetch(AUTH + "/users", OPTS);
        if (!r.ok) return server.user ? [server.user] : [];
        return ((await r.json()).users || []).map((u) => u.name);
      }
      return Object.keys((await rawGet(USERS, {})) || {}).sort();
    },
    async create(name, password) {      // add a user WITHOUT switching the session
      await ready;
      name = clean(name);
      if (!name) throw new Error("invalid username");
      if (!password) throw new Error("password required");
      if (gated()) {
        const r = await post(AUTH + "/users", { name, password });
        if (!r.ok) throw new Error(r.body.error || "could not add that user");
        return name;
      }
      const users = (await rawGet(USERS, {})) || {};
      if (users[name]) throw new Error("user already exists");
      const salt = [...crypto.getRandomValues(new Uint8Array(8))]
        .map((b) => b.toString(16).padStart(2, "0")).join("");
      users[name] = { salt, hash: await sha256(salt + password) };
      await rawSet(USERS, users);
      return name;
    },
    async remove(name) {
      await ready;
      name = clean(name);
      if (gated()) {
        const r = await fetch(`${AUTH}/users/${encodeURIComponent(name)}`,
                              { ...OPTS, method: "DELETE" });
        if (!r.ok) throw new Error(((await r.json().catch(() => ({}))).error) || "could not remove");
        return;
      }
      const users = (await rawGet(USERS, {})) || {};
      if (!users[name]) throw new Error("no such user");
      delete users[name];
      await rawSet(USERS, users);
    },
    async signup(name, password) {
      await ready;
      if (gated()) {
        const r = await post(AUTH + "/signup", { name: clean(name), password });
        if (!r.ok) throw new Error(r.body.error || "could not create that account");
        dropAllLocal();
        server.user = r.body.user; server.admin = true; server.first_run = false;
        return r.body.user;
      }
      name = await user.create(name, password);
      sessionStorage.setItem(SITE + ":user", name);
      return name;
    },
    async login(name, password) {
      await ready;
      if (gated()) {
        const r = await post(AUTH + "/login", { name: clean(name), password });
        if (!r.ok) throw new Error(r.body.error || "wrong username or password");
        dropAllLocal();               // never show the previous user's cache
        server.user = r.body.user; server.admin = !!r.body.admin;
        return r.body.user;
      }
      name = clean(name);
      const users = (await rawGet(USERS, {})) || {};
      const rec = users[name];
      if (!rec || rec.hash !== (await sha256(rec.salt + password)))
        throw new Error("wrong username or password");
      sessionStorage.setItem(SITE + ":user", name);
      return name;
    },
    async logout() {
      sessionStorage.removeItem(SITE + ":user");
      if (gated()) {
        try { await post(AUTH + "/logout"); } catch (e) {}
        server.user = null; server.admin = false;
      }
      dropAllLocal();                 // the data goes away with the session
    },
  };

  // ---- namespaced store ----
  const ns = (key) => `u/${user.current() || "guest"}/${key}`;
  window.kstore = {
    ready,
    set: async (key, value) => { await ready; return rawSet(ns(key), value); },
    get: async (key, fallback = null) => { await ready; return rawGet(ns(key), fallback); },
    del: async (key) => { await ready; return rawDel(ns(key)); },
    async keys() {
      await ready;
      const prefix = ns("");
      const found = new Set();
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(lsKey(prefix))) found.add(k.slice(lsKey(prefix).length));
      }
      if (server) {
        try {
          const r = await fetch(API, OPTS);
          if (r.ok) for (const k of (await r.json()).keys || [])
            if (k.startsWith(prefix)) found.add(k.slice(prefix.length));
        } catch (e) {}
      }
      return [...found].sort();
    },
    user,
    // shared (NOT per-user) storage under system/ — used by karaoke-auth.js
    sys: {
      get: async (key, fallback = null) => { await ready; return rawGet("system/" + key, fallback); },
      set: async (key, value) => { await ready; return rawSet("system/" + key, value); },
    },
  };
})();
