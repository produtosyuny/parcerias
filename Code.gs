/**
 * Code.gs — ponte entre o Painel de Parcerias (HTML estático) e esta planilha.
 *
 * COMO INSTALAR (passo a passo):
 *   1. Abra a planilha "registro_parcerias" no navegador.
 *   2. Menu Extensões → Apps Script.
 *   3. Apague o conteúdo de "Código.gs" (ou Code.gs) que aparecer e cole TODO
 *      o conteúdo deste arquivo no lugar.
 *   4. Clique no ícone de disquete (Salvar projeto).
 *   5. Clique em "Implantar" (Deploy) → "Nova implantação" (New deployment).
 *   6. No tipo, escolha "App da Web" (Web app).
 *   7. Em "Executar como" (Execute as): "Eu" (sua conta).
 *      Em "Quem pode acessar" (Who has access): "Qualquer pessoa" (Anyone).
 *   8. Clique em "Implantar". O Google vai pedir autorização — aceite (é o seu
 *      próprio script acessando a sua própria planilha).
 *   9. Copie a "URL do app da Web" (Web app URL) que aparece — algo como
 *      https://script.google.com/macros/s/AKfycb.../exec
 *  10. Cole essa URL no arquivo data/config.json do Painel, no campo
 *      "sheetsWebAppUrl" (veja as instruções nesse arquivo).
 *
 * Se depois você alterar este código, repita os passos 5–9 escolhendo
 * "Gerenciar implantações" → editar a implantação existente → Nova versão,
 * para manter a MESMA URL em vez de gerar uma nova.
 */

// Token simples para dificultar que alguém que não seja o Painel chame este
// endereço. Não é uma senha forte — qualquer pessoa com este código-fonte vê
// o token — mas evita que a URL, se descoberta por acaso, seja usada por
// qualquer um sem esforço nenhum.
var TOKEN = "Lg-7lrc1_HHNaPkYuoo-PrmG";

var SHEET_REGISTRO = "Registro";
var SHEET_LOGIN = "Login";
var SHEET_METAS = "Metas";

var REGISTRO_LAST_COL = 11; // A..K

// Planilha SEPARADA onde o Portal Parcerias grava os cadastros de corretor
// (não é esta planilha — é a "Cadastros do Portal Parcerias (PRIVADA)").
// Como o Code.gs roda preso a ESTA planilha (registro_parcerias), pra ler a
// outra a gente abre ela pelo ID com SpreadsheetApp.openById — só funciona
// porque é a mesma conta Google que tem acesso às duas.
var SPREADSHEET_ID_CADASTROS = "1lUNZucpsOP_-VStslqJQr4pqUlnLQ3R-wzhpBOfPeik";
var SHEET_CADASTROS = "Cadastros";

function doGet(e) {
  try {
    if (!checkToken_(e.parameter && e.parameter.token)) return jsonOut_({ error: "unauthorized" });
    var action = e.parameter.action;
    if (action === "listLogins") return jsonOut_(listLogins_());
    if (action === "listEntries") return jsonOut_(listEntries_(e.parameter.gerenteId));
    if (action === "getMetas") return jsonOut_(getMetas_());
    if (action === "listCorretores") return jsonOut_(listCorretores_(e.parameter.gerenteId));
    return jsonOut_({ error: "unknown action" });
  } catch (err) {
    return jsonOut_({ error: String(err) });
  }
}

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents || "{}");
    if (!checkToken_(body.token)) return jsonOut_({ error: "unauthorized" });
    var action = body.action;
    if (action === "setLogin") return jsonOut_(setLogin_(body.id, body.data));
    if (action === "updateLogin") return jsonOut_(updateLogin_(body.id, body.patch));
    if (action === "deleteLogin") return jsonOut_(deleteLogin_(body.id));
    if (action === "addEntry") return jsonOut_(addEntry_(body.gerenteId, body.entry));
    if (action === "setMetas") return jsonOut_(setMetas_(body.metas));
    return jsonOut_({ error: "unknown action" });
  } catch (err) {
    return jsonOut_({ error: String(err) });
  }
}

function checkToken_(t) {
  return t === TOKEN;
}

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function ss_() {
  return SpreadsheetApp.getActiveSpreadsheet();
}

// ---------- Login ----------

function listLogins_() {
  var sh = ss_().getSheetByName(SHEET_LOGIN);
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return [];
  var rows = sh.getRange(2, 1, lastRow - 1, 4).getValues();
  var out = [];
  rows.forEach(function (r) {
    if (!r[0]) return; // id vazio = linha não usada
    out.push({ id: String(r[0]), nome: String(r[1] || ""), senha: String(r[2] || ""), papel: String(r[3] || "") });
  });
  return out;
}

function findLoginRow_(sh, id) {
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return -1;
  var ids = sh.getRange(2, 1, lastRow - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(id)) return i + 2; // linha real na planilha
  }
  return -1;
}

function setLogin_(id, data) {
  var sh = ss_().getSheetByName(SHEET_LOGIN);
  var row = findLoginRow_(sh, id);
  if (row === -1) row = sh.getLastRow() + 1 < 2 ? 2 : sh.getLastRow() + 1;
  sh.getRange(row, 1, 1, 4).setValues([[id, data.nome || "", data.senha || "", data.papel || ""]]);
  return { ok: true };
}

function updateLogin_(id, patch) {
  var sh = ss_().getSheetByName(SHEET_LOGIN);
  var row = findLoginRow_(sh, id);
  if (row === -1) return { ok: false, error: "not found" };
  var current = sh.getRange(row, 1, 1, 4).getValues()[0];
  var next = {
    nome: current[1],
    senha: current[2],
    papel: current[3]
  };
  Object.keys(patch || {}).forEach(function (k) { next[k] = patch[k]; });
  sh.getRange(row, 1, 1, 4).setValues([[id, next.nome, next.senha, next.papel]]);
  return { ok: true };
}

function deleteLogin_(id) {
  var sh = ss_().getSheetByName(SHEET_LOGIN);
  var row = findLoginRow_(sh, id);
  if (row === -1) return { ok: false, error: "not found" };
  sh.deleteRow(row);
  return { ok: true };
}

// ---------- Registro / entries ----------

function nextEmptyRegistroRow_(sh) {
  var maxRows = sh.getMaxRows();
  var colA = sh.getRange(2, 1, maxRows - 1, 1).getValues();
  for (var i = 0; i < colA.length; i++) {
    if (!colA[i][0]) return i + 2;
  }
  return maxRows + 1;
}

function pilarFromTipo_(tipo) {
  if (!tipo) return "";
  var idx = tipo.indexOf(" - ");
  return idx === -1 ? tipo : tipo.substring(0, idx);
}

function nomeFromLoginId_(id) {
  var logins = listLogins_();
  for (var i = 0; i < logins.length; i++) {
    if (logins[i].id === id) return logins[i].nome;
  }
  return id;
}

function addEntry_(gerenteId, entry) {
  var sh = ss_().getSheetByName(SHEET_REGISTRO);
  var row = nextEmptyRegistroRow_(sh);
  var nome = nomeFromLoginId_(gerenteId);
  var dataValue = entry.data ? new Date(entry.data + "T00:00:00") : "";
  var criadoEm = entry.criadoEm || new Date().toISOString();
  sh.getRange(row, 1, 1, REGISTRO_LAST_COL).setValues([[
    dataValue,
    nome,
    pilarFromTipo_(entry.tipo),
    entry.estoque || "",
    entry.tipo || "",
    entry.parceiro || "",
    entry.primeiraOuRecorrente || "",
    entry.observacao || "",
    (entry.vgv === undefined || entry.vgv === null || entry.vgv === "") ? "" : Number(entry.vgv),
    gerenteId,
    criadoEm
  ]]);
  return { ok: true };
}

// Checagem robusta de "é uma data": em alguns casos o Apps Script devolve
// objetos Date que vêm de outro "realm" (ex.: quando o Web App é chamado
// via doGet/doPost), e aí "dataCell instanceof Date" dá false mesmo sendo
// uma data de verdade — o que fazia cair no String(dataCell) e mostrar
// coisas como "Tue Oct 27 2026 00:00:00 GMT-0300 (...)" em vez de
// "2026-10-27" (e o Painel então exibia "27/ct" em vez de "27/10").
// Object.prototype.toString.call(...) funciona entre realms diferentes.
function isDateValue_(v) {
  return !!v && Object.prototype.toString.call(v) === "[object Date]" && !isNaN(v.getTime());
}

function listEntries_(gerenteId) {
  var sh = ss_().getSheetByName(SHEET_REGISTRO);
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return [];
  var rows = sh.getRange(2, 1, lastRow - 1, REGISTRO_LAST_COL).getValues();
  var tz = ss_().getSpreadsheetTimeZone();
  var out = [];
  rows.forEach(function (r) {
    var rowGerenteId = r[9];
    if (!rowGerenteId || String(rowGerenteId) !== String(gerenteId)) return;
    var dataCell = r[0];
    var dataStr = "";
    if (isDateValue_(dataCell)) dataStr = Utilities.formatDate(dataCell, tz, "yyyy-MM-dd");
    else if (dataCell) dataStr = String(dataCell);
    var entry = {
      data: dataStr,
      tipo: String(r[4] || ""),
      estoque: String(r[3] || ""),
      primeiraOuRecorrente: String(r[6] || ""),
      parceiro: String(r[5] || ""),
      observacao: String(r[7] || ""),
      criadoEm: String(r[10] || "")
    };
    if (r[8] !== "" && r[8] !== null && r[8] !== undefined) entry.vgv = Number(r[8]);
    out.push(entry);
  });
  return out;
}

// ---------- Corretores (cadastro do Portal Parcerias) ----------
// Lê a planilha "Cadastros do Portal Parcerias" (separada desta) e devolve
// só o que o gerente/diretor precisa pra contatar e validar o corretor.
// DE PROPÓSITO não traz CPF, CNPJ nem a senha (hash) pro Painel — esses
// campos nunca saem desta planilha. O endpoint do Web App é protegido só
// por um token simples (ver comentário no topo do arquivo), então quanto
// menos dado sensível passar por ele, melhor.

// tira acento e deixa minúsculo, pra comparar nomes sem depender de
// maiúscula/minúscula ou acentuação digitada diferente
function normalizeNome_(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .trim();
}

// o corretor escolhe o gerente digitando/selecionando um texto livre no
// Portal (ex.: "Alberto Monteiro", "Antonela Vieira") que não bate 100% com
// o nome curto cadastrado na aba Login (ex.: "Alberto", "Antonela") — aqui a
// gente casa pelo primeiro nome: considera visto se o texto do Portal é
// igual ao nome do gerente, ou começa com "nome do gerente " (plus espaço,
// pra não confundir "Elano" com um "Elanovaldo" hipotético).
function corretorMatchesGerente_(gerenteEscolhidoTexto, loginNomeGerente) {
  var a = normalizeNome_(gerenteEscolhidoTexto);
  var b = normalizeNome_(loginNomeGerente);
  if (!a || !b) return false;
  if (a === b) return true;
  return a.indexOf(b + " ") === 0;
}

// gerenteId: id de login (ex. "elano") pra ver só os corretores dele, ou
// vazio/"all" pra ver todo mundo (uso do diretor) — nesse caso cada
// corretor já vem com o gerenteId/gerenteNome que casou, ou null se o texto
// que ele escolheu no Portal não bateu com nenhum gerente cadastrado.
function listCorretores_(gerenteId) {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID_CADASTROS);
  var sh = ss.getSheetByName(SHEET_CADASTROS);
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return [];
  var rows = sh.getRange(2, 1, lastRow - 1, 15).getValues();
  var gerentesLogins = listLogins_().filter(function (l) { return l.papel === "gerente"; });
  var wantId = (gerenteId && gerenteId !== "all") ? String(gerenteId) : null;

  var out = [];
  rows.forEach(function (r) {
    if (!r[1]) return; // sem nome = linha vazia/não usada

    var gerenteEscolhidoTexto = String(r[10] || "");
    var matched = null;
    for (var i = 0; i < gerentesLogins.length; i++) {
      if (corretorMatchesGerente_(gerenteEscolhidoTexto, gerentesLogins[i].nome)) { matched = gerentesLogins[i]; break; }
    }

    if (wantId && (!matched || matched.id !== wantId)) return;

    out.push({
      dataCadastro: String(r[0] || ""),
      nome: String(r[1] || ""),
      creci: String(r[3] || ""),
      creciValidado: String(r[4] || ""),
      atuaComo: String(r[5] || ""),
      imobiliaria: String(r[6] || ""),
      whatsapp: String(r[8] || ""),
      email: String(r[9] || ""),
      gerenteEscolhidoTexto: gerenteEscolhidoTexto,
      gerenteId: matched ? matched.id : null,
      gerenteNome: matched ? matched.nome : null,
      ultimoAcesso: String(r[12] || ""),
      numAcessos: (r[13] === "" || r[13] === null || r[13] === undefined) ? null : Number(r[13])
    });
  });

  out.reverse(); // a planilha cresce de cima pra baixo (mais antigo primeiro) — aqui inverte pra mostrar o mais recente primeiro
  return out;
}

// ---------- Metas ----------
// A aba "Metas" guarda cada meta como uma linha (Pilar | Tipo de ação | Meta |
// Período | Observação). O Painel só conhece 3 números (plantao/visita/
// apresentacao), então aqui a gente traduz nos dois sentidos.

var METAS_LABELS = {
  plantao: "Plantão de estoque",
  visita: "Visita a imobiliária",
  apresentacao: "Apresentação de lançamento"
};

function getMetas_() {
  var sh = ss_().getSheetByName(SHEET_METAS);
  var lastRow = sh.getLastRow();
  var rows = lastRow < 2 ? [] : sh.getRange(2, 1, lastRow - 1, 3).getValues();
  var byLabel = {};
  rows.forEach(function (r) { byLabel[String(r[1])] = r[2]; });
  return {
    plantao: Number(byLabel[METAS_LABELS.plantao]) || 0,
    visita: Number(byLabel[METAS_LABELS.visita]) || 0,
    apresentacao: Number(byLabel[METAS_LABELS.apresentacao]) || 0
  };
}

function setMetas_(metas) {
  var sh = ss_().getSheetByName(SHEET_METAS);
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return { ok: false, error: "aba Metas vazia" };
  var labelCol = sh.getRange(2, 2, lastRow - 1, 1).getValues();
  Object.keys(METAS_LABELS).forEach(function (key) {
    var label = METAS_LABELS[key];
    for (var i = 0; i < labelCol.length; i++) {
      if (String(labelCol[i][0]) === label) {
        sh.getRange(2 + i, 3).setValue(Number(metas[key]) || 0);
        break;
      }
    }
  });
  return { ok: true };
}
