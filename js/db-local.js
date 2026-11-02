/* db-local.js
 * ---------------------------------------------------------------------
 * A tiny localStorage-backed data layer that mimics the collection()/doc()
 * API the app (js/app.js) was built against on claude.ai (the Artifact
 * `db` capability: odd path segments are collections, even ones are docs).
 *
 * This lets the Painel run fully standalone on GitHub Pages while we don't
 * have the Google Sheets backend wired up yet — every gerente/diretor who
 * opens the page gets their OWN local copy of the data (nothing is shared
 * between browsers/devices with this file in place).
 *
 * Swapping this out later for Google Sheets: write a new file (e.g.
 * js/db-sheets.js) that defines the SAME window.PainelDB.create() entry
 * point — it may return a Promise (e.g. while it authenticates / fetches
 * from the Apps Script Web App) — and implements collection()/doc() with
 * the same methods used below (onSnapshot/add/set/update/delete). Nothing
 * in js/app.js needs to change as long as that shape is kept; just swap
 * the <script src="js/db-local.js"> tag in index.html for the new file.
 * ---------------------------------------------------------------------
 */
(function (global) {
  "use strict";

  var STORAGE_KEY = "painel-parcerias-db-v1";

  function loadStore() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (e) {
      return {};
    }
  }
  function saveStore(store) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
    } catch (e) {
      // storage full / disabled (e.g. private browsing) — data just won't
      // persist across reloads, but the app keeps working for this session
    }
  }

  function createLocalDb() {
    var store = loadStore();
    var listeners = {}; // "coll:<path>" | "doc:<path>" -> [{cb}]

    function getColl(path) {
      if (!store[path]) store[path] = {};
      return store[path];
    }
    function splitDoc(path) {
      var parts = path.split("/");
      var id = parts.pop();
      return { collPath: parts.join("/"), id: id };
    }
    function notifyCollection(path) {
      var subs = listeners["coll:" + path] || [];
      var docsObj = getColl(path);
      var snap = {
        docs: Object.keys(docsObj).map(function (id) {
          return { id: id, data: function () { return docsObj[id]; } };
        })
      };
      subs.slice().forEach(function (s) { s.cb(snap); });
    }
    function notifyDoc(path) {
      var subs = listeners["doc:" + path] || [];
      var sd = splitDoc(path);
      var docsObj = getColl(sd.collPath);
      var exists = docsObj.hasOwnProperty(sd.id);
      var val = docsObj[sd.id];
      var snap = { exists: exists, data: function () { return val; } };
      subs.slice().forEach(function (s) { s.cb(snap); });
    }

    function collection(path) {
      return {
        onSnapshot: function (cb, errCb) {
          var key = "coll:" + path;
          listeners[key] = listeners[key] || [];
          var entry = { cb: cb, errCb: errCb };
          listeners[key].push(entry);
          // async, like a real backend, so callers that wire onSnapshot and
          // then immediately touch other DOM in the same tick behave the
          // same standalone as they did on claude.ai
          setTimeout(function () { notifyCollection(path); }, 0);
          return function () {
            var i = listeners[key].indexOf(entry);
            if (i > -1) listeners[key].splice(i, 1);
          };
        },
        add: function (obj) {
          return new Promise(function (resolve) {
            var id = "id" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
            getColl(path)[id] = obj;
            saveStore(store);
            notifyCollection(path);
            resolve({ id: id });
          });
        }
      };
    }

    function doc(path) {
      var sd = splitDoc(path);
      return {
        onSnapshot: function (cb, errCb) {
          var key = "doc:" + path;
          listeners[key] = listeners[key] || [];
          var entry = { cb: cb, errCb: errCb };
          listeners[key].push(entry);
          setTimeout(function () { notifyDoc(path); }, 0);
          return function () {
            var i = listeners[key].indexOf(entry);
            if (i > -1) listeners[key].splice(i, 1);
          };
        },
        set: function (obj) {
          return new Promise(function (resolve) {
            getColl(sd.collPath)[sd.id] = obj;
            saveStore(store);
            notifyDoc(path);
            notifyCollection(sd.collPath);
            resolve();
          });
        },
        update: function (patch) {
          return new Promise(function (resolve) {
            var cur = getColl(sd.collPath)[sd.id] || {};
            var next = {};
            Object.keys(cur).forEach(function (k) { next[k] = cur[k]; });
            Object.keys(patch).forEach(function (k) { next[k] = patch[k]; });
            getColl(sd.collPath)[sd.id] = next;
            saveStore(store);
            notifyDoc(path);
            notifyCollection(sd.collPath);
            resolve();
          });
        },
        delete: function () {
          return new Promise(function (resolve) {
            delete getColl(sd.collPath)[sd.id];
            saveStore(store);
            notifyDoc(path);
            notifyCollection(sd.collPath);
            resolve();
          });
        }
      };
    }

    return { collection: collection, doc: doc };
  }

  global.PainelDB = {
    // js/app.js calls this once at boot and accepts either a plain object
    // or a Promise — kept async-friendly on purpose so a future Sheets
    // backend (which needs to authenticate / fetch first) is a drop-in swap.
    create: function () {
      return createLocalDb();
    }
  };
})(window);
