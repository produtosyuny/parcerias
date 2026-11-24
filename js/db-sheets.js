/* db-sheets.js — v2 (24/11/2026)
 * ---------------------------------------------------------------------
 * Camada de dados que fala com a planilha Google Sheets via Apps Script
 * (Code.gs v2). Mesma interface de antes (collection()/doc() com
 * onSnapshot/add/set/update/delete) + duas coisas novas:
 *
 *  - db.auth: login / logout / criar o Diretor. Não existe mais token fixo
 *    no site: cada pessoa recebe uma SESSÃO própria do servidor quando entra
 *    com a senha, e toda chamada leva essa sessão. Se a sessão cair (senha
 *    trocada, 30 dias sem uso, login removido), PainelDB.onAuthError avisa o
 *    app, que volta pra tela de login.
 *  - collection("registros/<id>/entries").update(criadoEm, patch) e
 *    .remove(criadoEm): editar e excluir um registro.
 *
 * Atualização: busca os dados de novo a cada 20 s, e PARA de buscar quando a
 * aba do navegador está em segundo plano (economiza a cota do Google).
 * Depois de qualquer gravação, atualiza tudo na hora.
 * ---------------------------------------------------------------------
 */
(function (global) {
  "use strict";

  var POLL_MS = 20000;
  var CONNECT_TIMEOUT_MS = 9000;

  var WEB_APP_URL = null;
  var SESS = null;

  var activePollers = [];
  function pokeAll() {
    activePollers.slice().forEach(function (p) { try { p.tick(); } catch (e) {} });
  }
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") pokeAll(); // voltou pra aba: atualiza na hora
  });

  function tratar(json) {
    if (json && json.error) {
      if (json.error === "auth" && typeof global.PainelDB.onAuthError === "function") global.PainelDB.onAuthError();
      var err = new Error(json.msg || json.error);
      err.code = json.error;
      throw err;
    }
    return json;
  }

  function apiGet(action, params) {
    var qs = "action=" + encodeURIComponent(action) + (SESS ? "&sess=" + encodeURIComponent(SESS) : "");
    Object.keys(params || {}).forEach(function (k) {
      qs += "&" + encodeURIComponent(k) + "=" + encodeURIComponent(params[k]);
    });
    return fetch(WEB_APP_URL + "?" + qs).then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    }).then(tratar);
  }

  function apiPost(action, payload, semPoke) {
    var body = Object.assign({ action: action, sess: SESS }, payload || {});
    return fetch(WEB_APP_URL, {
      method: "POST",
      // text/plain evita o preflight CORS (OPTIONS), que o Apps Script não responde
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(body)
    }).then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    }).then(tratar).then(function (json) {
      if (!semPoke) pokeAll();
      return json;
    });
  }

  function makePoller(fetchFn, buildSnap, precisaSessao) {
    return {
      onSnapshot: function (cb, errCb) {
        var stopped = false, hadFirstResult = false, emVoo = false;
        function tick() {
          if (stopped || emVoo) return;
          if (precisaSessao && !SESS) return;
          if (hadFirstResult && document.visibilityState === "hidden") return;
          emVoo = true;
          fetchFn().then(function (value) {
            emVoo = false;
            if (stopped) return;
            hadFirstResult = true;
            cb(buildSnap(value));
          }).catch(function (err) {
            emVoo = false;
            if (stopped) return;
            if (!hadFirstResult && errCb && (!err || err.code !== "auth")) errCb(err);
          });
        }
        var entry = { tick: tick };
        activePollers.push(entry);
        var interval = setInterval(tick, POLL_MS);
        setTimeout(tick, 0);
        return function unsubscribe() {
          stopped = true;
          clearInterval(interval);
          var i = activePollers.indexOf(entry);
          if (i > -1) activePollers.splice(i, 1);
        };
      }
    };
  }

  function listaDocs(list, prefixo) {
    return { docs: (list || []).map(function (x, i) { return { id: x.id || (prefixo + i), data: function () { return x; } }; }) };
  }

  function collection(path) {
    if (path === "login") {
      var poller = makePoller(function () { return apiGet("listLogins"); }, function (l) { return listaDocs(l, "l"); }, false);
      return { onSnapshot: poller.onSnapshot };
    }

    if (path === "corretores" || /^corretores\/(.+)$/.test(path)) {
      var cm = path.match(/^corretores\/(.+)$/);
      var gid = cm ? cm[1] : null;
      var pollerC = makePoller(function () { return apiGet("listCorretores", gid ? { gerenteId: gid } : {}); },
        function (l) { return listaDocs(l, "c"); }, true);
      return { onSnapshot: pollerC.onSnapshot };
    }

    var m = path.match(/^registros\/(.+)\/entries$/);
    if (m) {
      var gerenteId = m[1];
      var poller2 = makePoller(function () { return apiGet("listEntries", { gerenteId: gerenteId }); },
        function (l) { return listaDocs(l, "r"); }, true);
      return {
        onSnapshot: poller2.onSnapshot,
        add: function (entry) { return apiPost("addEntry", { gerenteId: gerenteId, entry: entry }).then(function () { return { id: "new" }; }); },
        update: function (criadoEm, patch) { return apiPost("updateEntry", { gerenteId: gerenteId, id: criadoEm, patch: patch }); },
        remove: function (criadoEm) { return apiPost("deleteEntry", { gerenteId: gerenteId, id: criadoEm }); }
      };
    }

    return {
      onSnapshot: function (cb) { setTimeout(function () { cb({ docs: [] }); }, 0); return function () {}; },
      add: function () { return Promise.reject(new Error("collection não suportada: " + path)); }
    };
  }

  function doc(path) {
    if (path === "config/metas") {
      var poller = makePoller(function () { return apiGet("getMetas"); },
        function (metas) { return { exists: true, data: function () { return metas; } }; }, true);
      return {
        onSnapshot: poller.onSnapshot,
        set: function (obj) { return apiPost("setMetas", { metas: obj }); },
        update: function (patch) { return apiPost("setMetas", { metas: patch }); },
        delete: function () { return Promise.resolve(); }
      };
    }
    var m = path.match(/^login\/(.+)$/);
    if (m) {
      var id = m[1];
      return {
        set: function (obj) { return apiPost("setLogin", { id: id, data: obj }); },
        update: function (patch) { return apiPost("updateLogin", { id: id, patch: patch }); },
        delete: function () { return apiPost("deleteLogin", { id: id }); }
      };
    }
    return {
      onSnapshot: function (cb) { setTimeout(function () { cb({ exists: false, data: function () { return null; } }); }, 0); return function () {}; },
      set: function () { return Promise.reject(new Error("doc não suportado: " + path)); },
      update: function () { return Promise.reject(new Error("doc não suportado: " + path)); },
      delete: function () { return Promise.reject(new Error("doc não suportado: " + path)); }
    };
  }

  var auth = {
    setSession: function (s) { SESS = s || null; if (SESS) pokeAll(); },
    hasSession: function () { return !!SESS; },
    login: function (id, senha) {
      return apiPost("login", { id: id, senha: senha }, true).then(function (r) { SESS = r.sess; pokeAll(); return r; });
    },
    logout: function () {
      var s = SESS; SESS = null;
      if (!s) return Promise.resolve();
      return apiPost("logout", { sess: s }, true).catch(function () {});
    },
    setupDiretor: function (senha) { return apiPost("setupDiretor", { senha: senha }); }
  };

  global.PainelDB = {
    onAuthError: null,
    create: function () {
      return fetch("data/config.json").then(function (res) { return res.json(); }).then(function (cfg) {
        WEB_APP_URL = cfg.sheetsWebAppUrl;
        if (!WEB_APP_URL) { console.error("db-sheets: falta sheetsWebAppUrl em data/config.json"); return null; }
        var controller = (typeof AbortController !== "undefined") ? new AbortController() : null;
        var timer = setTimeout(function () { if (controller) controller.abort(); }, CONNECT_TIMEOUT_MS);
        return fetch(WEB_APP_URL + "?action=listLogins", controller ? { signal: controller.signal } : {})
          .then(function (res) { return res.json(); })
          .then(function (json) {
            clearTimeout(timer);
            if (json && json.error) { console.error("db-sheets: " + json.error + " — o Code.gs da planilha é a versão 2?"); return null; }
            return { collection: collection, doc: doc, auth: auth };
          }).catch(function (err) {
            clearTimeout(timer);
            console.error("db-sheets: não foi possível conectar ao Apps Script.", err);
            return null;
          });
      }).catch(function (err) {
        console.error("db-sheets: não foi possível ler data/config.json.", err);
        return null;
      });
    }
  };
})(window);
