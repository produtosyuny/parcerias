/* db-sheets.js
 * ---------------------------------------------------------------------
 * Camada de dados que fala com a planilha Google Sheets (via Apps Script
 * Web App) em vez do localStorage. Implementa a MESMA interface que
 * js/db-local.js (collection()/doc() com onSnapshot/add/set/update/delete),
 * então js/app.js e index.html não precisam mudar — só a tag
 * <script src="js/db-local.js"> em index.html precisa trocar para
 * <script src="js/db-sheets.js">.
 *
 * Como não existe "tempo real" de verdade aqui (o Apps Script não avisa o
 * navegador quando algo muda), cada onSnapshot busca os dados de novo a
 * cada poucos segundos (polling) — suficiente para um time pequeno. Depois
 * de qualquer escrita (add/set/update/delete), todas as "assinaturas" ativas
 * são atualizadas na hora, sem esperar o próximo ciclo.
 *
 * Configuração: data/config.json precisa ter "sheetsWebAppUrl" (a URL do
 * Apps Script publicado como Web App) e "sheetsToken" (o mesmo valor da
 * variável TOKEN em Code.gs). Veja o README para o passo a passo.
 * ---------------------------------------------------------------------
 */
(function (global) {
  "use strict";

  var POLL_MS = 4000;
  var CONNECT_TIMEOUT_MS = 8000;

  var WEB_APP_URL = null;
  var TOKEN = null;

  var activePollers = []; // { tick: fn }
  function pokeAll() {
    activePollers.slice().forEach(function (p) { try { p.tick(); } catch (e) {} });
  }

  function withTimeout(promise, ms) {
    var controller = (typeof AbortController !== "undefined") ? new AbortController() : null;
    var timer = setTimeout(function () { if (controller) controller.abort(); }, ms);
    return { promise: promise(controller && controller.signal), clear: function () { clearTimeout(timer); } };
  }

  function apiGet(action, params) {
    var qs = "action=" + encodeURIComponent(action) + "&token=" + encodeURIComponent(TOKEN);
    Object.keys(params || {}).forEach(function (k) {
      qs += "&" + encodeURIComponent(k) + "=" + encodeURIComponent(params[k]);
    });
    return fetch(WEB_APP_URL + "?" + qs).then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    }).then(function (json) {
      if (json && json.error) throw new Error(json.error);
      return json;
    });
  }

  function apiPost(action, payload) {
    var body = Object.assign({ action: action, token: TOKEN }, payload || {});
    return fetch(WEB_APP_URL, {
      method: "POST",
      // text/plain evita o preflight CORS (OPTIONS), que o Apps Script não
      // responde bem — o próprio Code.gs lê o corpo como JSON de qualquer jeito.
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(body)
    }).then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    }).then(function (json) {
      if (json && json.error) throw new Error(json.error);
      pokeAll();
      return json;
    });
  }

  function makePoller(fetchFn, buildSnap) {
    return {
      onSnapshot: function (cb, errCb) {
        var stopped = false;
        var hadFirstResult = false;
        var lastValue = null;
        function tick() {
          fetchFn().then(function (value) {
            if (stopped) return;
            hadFirstResult = true;
            lastValue = value;
            cb(buildSnap(value));
          }).catch(function (err) {
            if (stopped) return;
            if (!hadFirstResult && errCb) errCb(err);
            // falha passageira (rede/sheets instável): mantém o último valor
            // conhecido e tenta de novo no próximo ciclo, sem incomodar com
            // toasts repetidos.
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

  function collection(path) {
    var m;
    if (path === "login") {
      var poller = makePoller(
        function () { return apiGet("listLogins"); },
        function (list) {
          return { docs: (list || []).map(function (l) { return { id: l.id, data: function () { return l; } }; }) };
        }
      );
      return {
        onSnapshot: poller.onSnapshot,
        add: function (obj) {
          var id = "id" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
          return apiPost("setLogin", { id: id, data: obj }).then(function () { return { id: id }; });
        }
      };
    }

    m = path.match(/^registros\/(.+)\/entries$/);
    if (m) {
      var gerenteId = m[1];
      var poller2 = makePoller(
        function () { return apiGet("listEntries", { gerenteId: gerenteId }); },
        function (list) {
          return { docs: (list || []).map(function (entry, i) { return { id: "r" + i, data: function () { return entry; } }; }) };
        }
      );
      return {
        onSnapshot: poller2.onSnapshot,
        add: function (entry) {
          return apiPost("addEntry", { gerenteId: gerenteId, entry: entry }).then(function () { return { id: "new" }; });
        }
      };
    }

    // caminho não usado por js/app.js — devolve uma coleção vazia e inerte
    // em vez de travar a página, caso algo chame isso no futuro.
    return {
      onSnapshot: function (cb) { setTimeout(function () { cb({ docs: [] }); }, 0); return function () {}; },
      add: function () { return Promise.reject(new Error("collection não suportada: " + path)); }
    };
  }

  function doc(path) {
    if (path === "config/metas") {
      var poller = makePoller(
        function () { return apiGet("getMetas"); },
        function (metas) { return { exists: true, data: function () { return metas; } }; }
      );
      return {
        onSnapshot: poller.onSnapshot,
        set: function (obj) { return apiPost("setMetas", { metas: obj }); },
        update: function (patch) {
          return apiGet("getMetas").then(function (cur) {
            var next = Object.assign({}, cur, patch);
            return apiPost("setMetas", { metas: next });
          });
        },
        delete: function () { return Promise.resolve(); }
      };
    }

    var m = path.match(/^login\/(.+)$/);
    if (m) {
      var id = m[1];
      var poller2 = makePoller(
        function () { return apiGet("listLogins"); },
        function (list) {
          var found = (list || []).filter(function (l) { return l.id === id; })[0];
          return { exists: !!found, data: function () { return found; } };
        }
      );
      return {
        onSnapshot: poller2.onSnapshot,
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

  global.PainelDB = {
    create: function () {
      return fetch("data/config.json").then(function (res) { return res.json(); }).then(function (cfg) {
        WEB_APP_URL = cfg.sheetsWebAppUrl;
        TOKEN = cfg.sheetsToken;
        if (!WEB_APP_URL || !TOKEN) {
          console.error("db-sheets: faltam sheetsWebAppUrl/sheetsToken em data/config.json");
          return null;
        }
        var t = withTimeout(function (signal) {
          return fetch(WEB_APP_URL + "?action=getMetas&token=" + encodeURIComponent(TOKEN), { signal: signal })
            .then(function (res) { return res.json(); });
        }, CONNECT_TIMEOUT_MS);
        return t.promise.then(function (json) {
          t.clear();
          if (json && json.error) { console.error("db-sheets: " + json.error); return null; }
          return { collection: collection, doc: doc };
        }).catch(function (err) {
          t.clear();
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
