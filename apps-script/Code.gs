/**
 * Code.gs — ponte entre o Painel de Parcerias (site) e esta planilha.
 * Versão 2 (24/11/2026): login seguro, status dos registros, editar/excluir,
 * proposta perdida, coluna de unidade e meta de VGV.
 *
 * COMO ATUALIZAR (a URL continua a mesma):
 *   1. Planilha "registro_parcerias" > Extensões > Apps Script.
 *   2. Abra o arquivo Código.gs (ou Code.gs), apague tudo e cole este conteúdo.
 *   3. Salvar (disquete).
 *   4. Implantar > Gerenciar implantações > lápis (editar) > Versão: "Nova versão" > Implantar.
 *   5. Se o Google pedir autorização de novo, aceite.
 *   IMPORTANTE: suba o site novo (GitHub) logo em seguida — o site antigo não
 *   conversa com este código, e vice-versa.
 *
 * O QUE MUDOU NA SEGURANÇA
 *   - Não existe mais "token" no site. Cada pessoa entra com nome + senha e
 *     recebe uma sessão própria (válida por 30 dias), guardada só no
 *     navegador dela. Tudo que lê ou grava dado exige essa sessão.
 *   - A senha é conferida AQUI, no servidor. O site nunca mais recebe a lista
 *     de senhas.
 *   - As senhas ficam embaralhadas (hash) na aba Login. As que ainda estão
 *     abertas são embaralhadas sozinhas no primeiro login de cada pessoa.
 *   - 5 senhas erradas seguidas bloqueiam aquele login por 15 minutos.
 *   - Trocar a senha de alguém (ou remover a pessoa) derruba as sessões dela.
 *   - Gerente só lê e mexe nos próprios registros e corretores. Cadastro de
 *     gerente, senhas e metas: só o Diretor.
 */

var SHEET_REGISTRO = "Registro";
var SHEET_LOGIN = "Login";
var SHEET_METAS = "Metas";

// A..P — L = proposta convertida; M = status; N = motivo; O = unidade; P = editado em
var REGISTRO_LAST_COL = 16;
var CAB_NOVAS = ["Status", "Motivo", "Unidade", "Editado em"]; // M..P

var SESSAO_DIAS = 30;
var MAX_ERROS = 5;
var BLOQUEIO_SEG = 15 * 60;

var SPREADSHEET_ID_CADASTROS = "1lUNZucpsOP_-VStslqJQr4pqUlnLQ3R-wzhpBOfPeik";
var SHEET_CADASTROS = "Cadastros";

/* =================== entrada =================== */

function doGet(e) {
  return responder_(function () {
    var p = e.parameter || {};
    if (p.action === "listLogins") return listLoginsPublico_();   // só nomes e papéis (pro login)
    var u = exigirSessao_(p.sess);
    if (p.action === "me") return { id: u.id, nome: u.nome, papel: u.papel };
    if (p.action === "listEntries") return listEntries_(podeVer_(u, p.gerenteId));
    if (p.action === "getMetas") return getMetas_();
    if (p.action === "listCorretores") return listCorretores_(u.papel === "diretor" ? p.gerenteId : u.id);
    return { error: "unknown action" };
  });
}

function doPost(e) {
  return responder_(function () {
    var b = JSON.parse((e.postData && e.postData.contents) || "{}");
    if (b.action === "login") return login_(b.id, b.senha);
    if (b.action === "setupDiretor") return setupDiretor_(b.senha);
    var u = exigirSessao_(b.sess);
    if (b.action === "logout") return logout_(b.sess);
    if (b.action === "addEntry") return addEntry_(podeVer_(u, b.gerenteId), b.entry);
    if (b.action === "updateEntry") return updateEntry_(podeVer_(u, b.gerenteId), b.id, b.patch, u);
    if (b.action === "deleteEntry") return deleteEntry_(podeVer_(u, b.gerenteId), b.id);
    exigirDiretor_(u);
    if (b.action === "setLogin") return setLogin_(b.id, b.data);
    if (b.action === "updateLogin") return updateLogin_(b.id, b.patch);
    if (b.action === "deleteLogin") return deleteLogin_(b.id, u);
    if (b.action === "setMetas") return setMetas_(b.metas);
    return { error: "unknown action" };
  });
}

function responder_(fn) {
  var out;
  try { out = fn(); }
  catch (err) { out = { error: (err && err.code) || "interno", msg: String(err && err.message || err) }; }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}
function falha_(code, msg) { var e = new Error(msg || code); e.code = code; throw e; }
function ss_() { return SpreadsheetApp.getActiveSpreadsheet(); }

/* =================== senhas =================== */

function hex_(bytes) {
  return bytes.map(function (b) { return ((b + 256) % 256).toString(16); })
    .map(function (h) { return h.length === 1 ? "0" + h : h; }).join("");
}
function hashSenha_(senha, sal) {
  var h = String(senha);
  for (var i = 0; i < 200; i++) {
    h = hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, sal + "|" + h, Utilities.Charset.UTF_8));
  }
  return h;
}
function novaSenhaGuardada_(senha) {
  var sal = Utilities.getUuid().replace(/-/g, "").slice(0, 16);
  return "h1$" + sal + "$" + hashSenha_(senha, sal);
}
function senhaConfere_(guardada, digitada) {
  guardada = String(guardada || "");
  if (guardada.indexOf("h1$") === 0) {
    var partes = guardada.split("$");
    return hashSenha_(digitada, partes[1]) === partes[2];
  }
  return guardada !== "" && guardada === String(digitada); // senha antiga, ainda aberta
}

/* =================== sessões =================== */

function props_() { return PropertiesService.getScriptProperties(); }
function versaoLogin_(id) { return Number(props_().getProperty("v_" + id) || 0); }
function derrubarSessoes_(id) { props_().setProperty("v_" + id, String(versaoLogin_(id) + 1)); }

function criarSessao_(u) {
  var token = Utilities.getUuid().replace(/-/g, "") + Utilities.getUuid().replace(/-/g, "");
  var dado = { id: u.id, exp: Date.now() + SESSAO_DIAS * 864e5, v: versaoLogin_(u.id) };
  props_().setProperty("s_" + token, JSON.stringify(dado));
  return token;
}
function exigirSessao_(token) {
  if (!token) falha_("auth", "sem sessão");
  var raw = props_().getProperty("s_" + token);
  if (!raw) falha_("auth", "sessão inválida");
  var s = JSON.parse(raw);
  if (s.exp < Date.now() || s.v !== versaoLogin_(s.id)) { props_().deleteProperty("s_" + token); falha_("auth", "sessão expirada"); }
  var u = acharLogin_(s.id);
  if (!u) { props_().deleteProperty("s_" + token); falha_("auth", "login removido"); }
  // renova a validade a cada uso (no máximo 1 gravação por dia)
  if (s.exp - Date.now() < (SESSAO_DIAS - 1) * 864e5) {
    s.exp = Date.now() + SESSAO_DIAS * 864e5;
    props_().setProperty("s_" + token, JSON.stringify(s));
  }
  return u;
}
function exigirDiretor_(u) { if (u.papel !== "diretor") falha_("proibido", "só o Diretor"); }
function podeVer_(u, gerenteId) {
  if (u.papel === "diretor") return String(gerenteId || "");
  if (String(gerenteId) !== String(u.id)) falha_("proibido", "gerente só acessa os próprios registros");
  return u.id;
}
function limparSessoesVencidas_() {
  var todas = props_().getProperties(), agora = Date.now();
  Object.keys(todas).forEach(function (k) {
    if (k.indexOf("s_") !== 0) return;
    try { if (JSON.parse(todas[k]).exp < agora) props_().deleteProperty(k); } catch (e) { props_().deleteProperty(k); }
  });
}

function login_(id, senha) {
  var cache = CacheService.getScriptCache();
  var chave = "erros_" + id;
  var erros = Number(cache.get(chave) || 0);
  if (erros >= MAX_ERROS) falha_("bloqueado", "muitas tentativas");
  var lock = LockService.getScriptLock(); lock.waitLock(10000);
  try {
    var sh = ss_().getSheetByName(SHEET_LOGIN);
    var row = acharLinhaLogin_(sh, id);
    var linha = row === -1 ? null : sh.getRange(row, 1, 1, 4).getValues()[0];
    if (!linha || !senhaConfere_(linha[2], senha)) {
      cache.put(chave, String(erros + 1), BLOQUEIO_SEG);
      falha_("senha", "nome ou senha incorretos");
    }
    cache.remove(chave);
    if (String(linha[2]).indexOf("h1$") !== 0) sh.getRange(row, 3).setValue(novaSenhaGuardada_(senha)); // embaralha a senha antiga
    if (Math.random() < 0.1) limparSessoesVencidas_();
    var u = { id: String(linha[0]), nome: String(linha[1] || ""), papel: String(linha[3] || "") };
    return { ok: true, sess: criarSessao_(u), id: u.id, nome: u.nome, papel: u.papel };
  } finally { lock.releaseLock(); }
}
function logout_(token) { props_().deleteProperty("s_" + token); return { ok: true }; }

function setupDiretor_(senha) {
  if (!senha) falha_("dados", "senha vazia");
  var temDiretor = listLogins_().some(function (l) { return l.papel === "diretor"; });
  if (temDiretor) falha_("proibido", "já existe Diretor");
  return setLogin_("diretor", { nome: "Diretor", senha: senha, papel: "diretor" });
}

/* =================== Login (aba) =================== */

function listLogins_() {
  var sh = ss_().getSheetByName(SHEET_LOGIN);
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return [];
  return sh.getRange(2, 1, lastRow - 1, 4).getValues()
    .filter(function (r) { return r[0]; })
    .map(function (r) { return { id: String(r[0]), nome: String(r[1] || ""), papel: String(r[3] || "") }; });
}
function listLoginsPublico_() { return listLogins_(); } // sem senha — de propósito
function acharLogin_(id) {
  var l = listLogins_().filter(function (x) { return x.id === String(id); });
  return l[0] || null;
}
function acharLinhaLogin_(sh, id) {
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return -1;
  var ids = sh.getRange(2, 1, lastRow - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) if (String(ids[i][0]) === String(id)) return i + 2;
  return -1;
}
function setLogin_(id, data) {
  if (!id || !data || !data.nome) falha_("dados", "faltam dados");
  var sh = ss_().getSheetByName(SHEET_LOGIN);
  var row = acharLinhaLogin_(sh, id);
  if (row === -1) row = Math.max(2, sh.getLastRow() + 1);
  var senhaG = data.senha ? novaSenhaGuardada_(data.senha) : (row <= sh.getLastRow() ? sh.getRange(row, 3).getValue() : "");
  sh.getRange(row, 1, 1, 4).setValues([[id, data.nome, senhaG, data.papel || "gerente"]]);
  if (data.senha) derrubarSessoes_(id);
  return { ok: true };
}
function updateLogin_(id, patch) {
  var sh = ss_().getSheetByName(SHEET_LOGIN);
  var row = acharLinhaLogin_(sh, id);
  if (row === -1) falha_("dados", "login não encontrado");
  var cur = sh.getRange(row, 1, 1, 4).getValues()[0];
  var nome = patch && patch.nome ? patch.nome : cur[1];
  var papel = patch && patch.papel ? patch.papel : cur[3];
  var senhaG = patch && patch.senha ? novaSenhaGuardada_(patch.senha) : cur[2];
  sh.getRange(row, 1, 1, 4).setValues([[id, nome, senhaG, papel]]);
  if (patch && patch.senha) derrubarSessoes_(id);
  return { ok: true };
}
function deleteLogin_(id, u) {
  if (String(id) === String(u.id)) falha_("proibido", "o Diretor não pode remover a si mesmo");
  var sh = ss_().getSheetByName(SHEET_LOGIN);
  var row = acharLinhaLogin_(sh, id);
  if (row === -1) falha_("dados", "login não encontrado");
  sh.deleteRow(row);
  derrubarSessoes_(id);
  return { ok: true };
}

/* =================== Registro =================== */

function abaRegistro_() {
  var sh = ss_().getSheetByName(SHEET_REGISTRO);
  if (sh.getMaxColumns() < REGISTRO_LAST_COL) sh.insertColumnsAfter(sh.getMaxColumns(), REGISTRO_LAST_COL - sh.getMaxColumns());
  var cab = sh.getRange(1, 13, 1, 4).getValues()[0];
  if (cab.join("") === "") sh.getRange(1, 13, 1, 4).setValues([CAB_NOVAS]);
  return sh;
}
function proximaLinhaVazia_(sh) {
  var max = sh.getMaxRows();
  var colA = sh.getRange(2, 1, max - 1, 1).getValues();
  for (var i = 0; i < colA.length; i++) if (!colA[i][0]) return i + 2;
  sh.insertRowAfter(max);
  return max + 1;
}
function pilarDoTipo_(tipo) { var i = String(tipo || "").indexOf(" - "); return i === -1 ? String(tipo || "") : tipo.substring(0, i); }
function nomeDoLogin_(id) { var u = acharLogin_(id); return u ? u.nome : id; }
function vgvCelula_(v) { return (v === undefined || v === null || v === "") ? "" : Number(v); }
function dataCelula_(iso) { return iso ? new Date(iso + "T00:00:00") : ""; }

function addEntry_(gerenteId, entry) {
  if (!gerenteId || !entry || !entry.tipo) falha_("dados", "registro incompleto");
  var lock = LockService.getScriptLock(); lock.waitLock(10000);
  try {
    var sh = abaRegistro_();
    var row = proximaLinhaVazia_(sh);
    sh.getRange(row, 1, 1, REGISTRO_LAST_COL).setValues([[
      dataCelula_(entry.data), nomeDoLogin_(gerenteId), pilarDoTipo_(entry.tipo), entry.estoque || "", entry.tipo || "",
      entry.parceiro || "", entry.primeiraOuRecorrente || "", entry.observacao || "", vgvCelula_(entry.vgv),
      gerenteId, entry.criadoEm || new Date().toISOString(), entry.convertidaDeProposta || "",
      entry.status || "", entry.motivo || "", entry.unidade || "", ""
    ]]);
    return { ok: true };
  } finally { lock.releaseLock(); }
}

// acha a linha pelo gerente (col. J) + "criado em" (col. K), que é único por registro
function acharLinhaRegistro_(sh, gerenteId, criadoEm) {
  var last = sh.getLastRow();
  if (last < 2) return -1;
  var jk = sh.getRange(2, 10, last - 1, 2).getValues();
  for (var i = 0; i < jk.length; i++) {
    if (String(jk[i][1]) === String(criadoEm) && (!gerenteId || String(jk[i][0]) === String(gerenteId))) return i + 2;
  }
  return -1;
}

var CAMPOS_EDITAVEIS = {
  data: 1, estoque: 4, tipo: 5, parceiro: 6, primeiraOuRecorrente: 7, observacao: 8, vgv: 9,
  convertidaDeProposta: 12, status: 13, motivo: 14, unidade: 15
};
function updateEntry_(gerenteId, criadoEm, patch, u) {
  var lock = LockService.getScriptLock(); lock.waitLock(10000);
  try {
    var sh = abaRegistro_();
    var row = acharLinhaRegistro_(sh, gerenteId, criadoEm);
    if (row === -1) falha_("dados", "registro não encontrado");
    Object.keys(patch || {}).forEach(function (k) {
      var col = CAMPOS_EDITAVEIS[k];
      if (!col) return;
      var v = patch[k];
      if (k === "data") v = dataCelula_(v);
      else if (k === "vgv") v = vgvCelula_(v);
      sh.getRange(row, col).setValue(v === undefined || v === null ? "" : v);
      if (k === "tipo") sh.getRange(row, 3).setValue(pilarDoTipo_(v));
    });
    sh.getRange(row, 16).setValue(new Date().toISOString() + " · " + u.nome);
    return { ok: true };
  } finally { lock.releaseLock(); }
}
function deleteEntry_(gerenteId, criadoEm) {
  var lock = LockService.getScriptLock(); lock.waitLock(10000);
  try {
    var sh = abaRegistro_();
    var row = acharLinhaRegistro_(sh, gerenteId, criadoEm);
    if (row === -1) falha_("dados", "registro não encontrado");
    sh.deleteRow(row);
    return { ok: true };
  } finally { lock.releaseLock(); }
}

function isDateValue_(v) {
  return !!v && Object.prototype.toString.call(v) === "[object Date]" && !isNaN(v.getTime());
}
// gerenteId vazio (só o Diretor chega aqui assim) = todos os gerentes de uma vez
function listEntries_(gerenteId) {
  var sh = abaRegistro_();
  var last = sh.getLastRow();
  if (last < 2) return [];
  var rows = sh.getRange(2, 1, last - 1, REGISTRO_LAST_COL).getValues();
  var tz = ss_().getSpreadsheetTimeZone();
  var out = [];
  rows.forEach(function (r) {
    if (!r[9]) return;
    if (gerenteId && String(r[9]) !== String(gerenteId)) return;
    var d = r[0];
    var e = {
      gerenteId: String(r[9]),
      data: isDateValue_(d) ? Utilities.formatDate(d, tz, "yyyy-MM-dd") : String(d || ""),
      tipo: String(r[4] || ""), estoque: String(r[3] || ""), primeiraOuRecorrente: String(r[6] || ""),
      parceiro: String(r[5] || ""), observacao: String(r[7] || ""), criadoEm: String(r[10] || "")
    };
    if (r[8] !== "" && r[8] !== null && r[8] !== undefined) e.vgv = Number(r[8]);
    if (r[11]) e.convertidaDeProposta = String(r[11]);
    if (r[12]) e.status = String(r[12]);
    if (r[13]) e.motivo = String(r[13]);
    if (r[14]) e.unidade = String(r[14]);
    out.push(e);
  });
  return out;
}

/* =================== Corretores (Portal) =================== */

function normalizeNome_(s) {
  return String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
}
function corretorMatchesGerente_(texto, nomeGerente) {
  var a = normalizeNome_(texto), b = normalizeNome_(nomeGerente);
  if (!a || !b) return false;
  return a === b || a.indexOf(b + " ") === 0;
}
function formatDataHora_(cell, tz) {
  return isDateValue_(cell) ? Utilities.formatDate(cell, tz, "dd/MM/yyyy HH:mm") : String(cell || "");
}
// CPF, CNPJ e senha do corretor NUNCA saem da planilha de cadastros.
function listCorretores_(gerenteId) {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID_CADASTROS);
  var sh = ss.getSheetByName(SHEET_CADASTROS);
  var last = sh.getLastRow();
  if (last < 2) return [];
  var ncol = Math.min(sh.getMaxColumns(), 16);
  var rows = sh.getRange(2, 1, last - 1, ncol).getValues();
  var tz = ss.getSpreadsheetTimeZone();
  var gerentes = listLogins_().filter(function (l) { return l.papel === "gerente"; });
  var want = (gerenteId && gerenteId !== "all") ? String(gerenteId) : null;
  var out = [];
  rows.forEach(function (r) {
    if (!r[1]) return;
    var texto = String(r[10] || ""), match = null;
    for (var i = 0; i < gerentes.length; i++) if (corretorMatchesGerente_(texto, gerentes[i].nome)) { match = gerentes[i]; break; }
    if (want && (!match || match.id !== want)) return;
    out.push({
      dataCadastro: formatDataHora_(r[0], tz), nome: String(r[1] || ""), creci: String(r[3] || ""),
      atuaComo: String(r[5] || ""), imobiliaria: String(r[6] || ""), whatsapp: String(r[8] || ""), email: String(r[9] || ""),
      gerenteEscolhidoTexto: texto, gerenteId: match ? match.id : null, gerenteNome: match ? match.nome : null,
      ultimoAcesso: formatDataHora_(r[12], tz),
      numAcessos: (r[13] === "" || r[13] == null) ? null : Number(r[13]),
      origem: String(r[15] || "") // coluna P: por qual link o corretor chegou ao Portal
    });
  });
  out.reverse();
  return out;
}

/* =================== Metas =================== */

var METAS_LABELS = {
  plantao: "Plantão de estoque",
  visita: "Visita a imobiliária",
  apresentacao: "Apresentação de lançamento",
  vgvMensal: "VGV do mês por gerente (R$)"
};
var METAS_PILAR = { plantao: "Treinamento", visita: "Treinamento", apresentacao: "Treinamento", vgvMensal: "Venda" };
var METAS_PERIODO = { plantao: "Semana", visita: "Semana", apresentacao: "Semana", vgvMensal: "Mês" };

function getMetas_() {
  var sh = ss_().getSheetByName(SHEET_METAS);
  var last = sh.getLastRow();
  var rows = last < 2 ? [] : sh.getRange(2, 1, last - 1, 3).getValues();
  var por = {};
  rows.forEach(function (r) { por[String(r[1])] = r[2]; });
  var out = {};
  Object.keys(METAS_LABELS).forEach(function (k) { out[k] = Number(por[METAS_LABELS[k]]) || 0; });
  return out;
}
function setMetas_(metas) {
  var sh = ss_().getSheetByName(SHEET_METAS);
  Object.keys(METAS_LABELS).forEach(function (k) {
    if (metas[k] === undefined) return;
    var label = METAS_LABELS[k], last = sh.getLastRow();
    var col = last < 2 ? [] : sh.getRange(2, 2, last - 1, 1).getValues();
    for (var i = 0; i < col.length; i++) {
      if (String(col[i][0]) === label) { sh.getRange(2 + i, 3).setValue(Number(metas[k]) || 0); return; }
    }
    sh.appendRow([METAS_PILAR[k], label, Number(metas[k]) || 0, METAS_PERIODO[k], ""]);
  });
  return { ok: true };
}

/* =================== teste manual =================== */
// Rode pelo editor para conferir: lista os logins (sem senha) e as metas.
function testar() {
  console.log(JSON.stringify(listLogins_()));
  console.log(JSON.stringify(getMetas_()));
}
