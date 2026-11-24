/**
 * Painel de Parcerias — relatórios automáticos por e-mail.
 *
 * NÃO substitui o Code.gs: é um ARQUIVO A MAIS no mesmo Apps Script da
 * planilha "registro_parcerias".
 *
 * Como instalar (uma vez só):
 *   1. Planilha registro_parcerias > Extensões > Apps Script.
 *   2. No menu da esquerda, "+" ao lado de Arquivos > Script. Nome: relatorios
 *   3. Cole este conteúdo e salve.
 *   4. Preencha os e-mails em DESTINATARIOS logo abaixo.
 *   5. No topo, escolha a função "testarRelatorioSemanal" e clique em Executar
 *      (o Google pede autorização na primeira vez). Chega um e-mail só pra você.
 *   6. Gostou? Escolha "instalarGatilhos" e clique em Executar. Pronto:
 *      - toda segunda às 8h: resumo da semana anterior para os DESTINATARIOS;
 *      - todo dia útil às 18h: aviso pra você de quem não registrou nada no dia;
 *      - todo dia 1º às 8h: fechamento do mês anterior, gerente por gerente.
 *   Não precisa reimplantar o App da Web: isto roda sozinho pelo relógio do Google.
 */

var DESTINATARIOS = {
  semanal: ["rlopes@yuny.com.br"],   // acrescente Meyer e Pedro aqui: ["rlopes@yuny.com.br", "meyer@...", "pedro@..."]
  diario: ["rlopes@yuny.com.br"],    // aviso de quem não registrou — só pra você
  mensal: ["rlopes@yuny.com.br"]
};
var ABA_REGISTRO = "Registro";
var LINK_PAINEL = "https://produtosyuny.github.io/parcerias/";
var FUSO = "America/Sao_Paulo";

/* ---------------- leitura da planilha ---------------- */

function lerRegistros_() {
  var sh = SpreadsheetApp.getActive().getSheetByName(ABA_REGISTRO);
  var valores = sh.getDataRange().getValues();
  var out = [];
  for (var i = 1; i < valores.length; i++) {
    var r = valores[i];
    var data = paraData_(r[0]);
    if (!data || !r[4]) continue;
    out.push({
      data: data,
      gerente: String(r[1] || "").trim(),
      estoque: String(r[3] || "").trim() || "Sem produto",
      tipo: String(r[4] || "").trim(),
      parceiro: String(r[5] || "").trim(),
      obs: String(r[7] || "").trim(),
      vgv: paraNumero_(r[8]),
      criadoEm: String(r[10] || "").trim(),
      convertidaDe: String(r[11] || "").trim(),
      status: String(r[12] || "").trim(),
      motivo: String(r[13] || "").trim(),
      unidade: String(r[14] || "").trim()
    });
  }
  return out;
}
function paraData_(v) {
  if (v instanceof Date) return new Date(v.getFullYear(), v.getMonth(), v.getDate());
  var m = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(String(v || ""));
  if (m) return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
  m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v || ""));
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return null;
}
function paraNumero_(v) {
  if (typeof v === "number") return v;
  var s = String(v || "").replace(/[^\d,.-]/g, "");
  if (!s) return 0;
  s = s.replace(/\./g, "").replace(",", ".");
  var n = Number(s);
  return isNaN(n) ? 0 : n;
}

/* ---------------- contas ---------------- */

// mesma regra do Painel: visita/treino só conta quando REALIZADO (agendado e
// cancelado ficam de fora); registro antigo sem status com data futura = agendado.
function feito_(e) {
  if (e.tipo.indexOf("Venda") === 0) return true;
  if (e.status === "Agendado" || e.status === "Cancelado") return false;
  if (e.status === "Realizado") return true;
  var hoje = new Date(); hoje = new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate());
  return e.data <= hoje;
}

function totais_(lista, todos) {
  var convertidas = {};
  (todos || lista).forEach(function (e) { if (e.tipo === "Venda - Venda" && e.convertidaDe) convertidas[e.convertidaDe] = true; });
  var t = { visitas: 0, treinos: 0, propostas: 0, vendas: 0, vgv: 0, aberto: 0 };
  lista.forEach(function (e) {
    if (!feito_(e)) return;
    var pilar = e.tipo.split(" - ")[0];
    if (pilar === "Visitas") t.visitas++;
    else if (pilar === "Treinamento") t.treinos++;
    else if (e.tipo === "Venda - Proposta") { t.propostas++; if (!convertidas[e.criadoEm] && e.status !== "Perdida") t.aberto += e.vgv; }
    else if (e.tipo === "Venda - Venda") { t.vendas++; t.vgv += e.vgv; }
  });
  return t;
}
function noPeriodo_(lista, ini, fim) {
  return lista.filter(function (e) { return e.data >= ini && e.data <= fim; });
}
function agrupar_(lista, campo) {
  var g = {};
  lista.forEach(function (e) { var k = e[campo] || "—"; (g[k] = g[k] || []).push(e); });
  return g;
}
function semanaPassada_() {
  var hoje = new Date(); hoje = new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate());
  var dow = hoje.getDay(); // 0 = domingo
  var segAtual = new Date(hoje); segAtual.setDate(hoje.getDate() - (dow === 0 ? 6 : dow - 1));
  var ini = new Date(segAtual); ini.setDate(segAtual.getDate() - 7);
  var fim = new Date(segAtual); fim.setDate(segAtual.getDate() - 1);
  return { ini: ini, fim: fim };
}
function mesPassado_() {
  var h = new Date();
  return { ini: new Date(h.getFullYear(), h.getMonth() - 1, 1), fim: new Date(h.getFullYear(), h.getMonth(), 0) };
}

/* ---------------- formatação ---------------- */

function brl_(n) {
  n = Math.round(n || 0);
  return "R$ " + String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}
function dm_(d) { return Utilities.formatDate(d, FUSO, "dd/MM"); }
function delta_(a, b) {
  if (!b && !a) return "";
  if (!b) return ' <span style="color:#176b43">(novo)</span>';
  var p = Math.round((a - b) / b * 100);
  if (p === 0) return ' <span style="color:#6f6659">(estável)</span>';
  return ' <span style="color:' + (p > 0 ? "#176b43" : "#a8402c") + '">(' + (p > 0 ? "▲" : "▼") + " " + Math.abs(p) + "%)</span>";
}
function tabela_(cab, linhas) {
  var th = cab.map(function (c, i) { return '<th style="text-align:' + (i ? "right" : "left") + ';padding:6px 8px;border-bottom:2px solid #e2d9cc;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#86622f">' + c + "</th>"; }).join("");
  var tr = linhas.map(function (l) {
    return "<tr>" + l.map(function (c, i) { return '<td style="text-align:' + (i ? "right" : "left") + ';padding:6px 8px;border-bottom:1px solid #e2d9cc">' + c + "</td>"; }).join("") + "</tr>";
  }).join("");
  return '<table style="border-collapse:collapse;width:100%;font-size:13px;margin:6px 0 18px">' + "<tr>" + th + "</tr>" + tr + "</table>";
}
function moldura_(titulo, corpo) {
  return '<div style="font-family:Arial,sans-serif;color:#1a1612;max-width:640px">' +
    '<div style="font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#86622f">Yuny · Parcerias</div>' +
    '<h2 style="margin:4px 0 16px;font-weight:600">' + titulo + "</h2>" + corpo +
    '<p style="font-size:12px;color:#6f6659;margin-top:20px">Gerado automaticamente a partir do Painel de Parcerias · <a href="' + LINK_PAINEL + '">abrir o painel</a></p></div>';
}
function h3_(t) { return '<h3 style="font-size:14px;margin:18px 0 4px;color:#1a1612">' + t + "</h3>"; }

function metaVgv_() {
  var sh = SpreadsheetApp.getActive().getSheetByName("Metas");
  if (sh && sh.getLastRow() >= 2) {
    var rows = sh.getRange(2, 1, sh.getLastRow() - 1, 3).getValues();
    for (var i = 0; i < rows.length; i++) if (String(rows[i][1]).indexOf("VGV do mês") === 0 && Number(rows[i][2]) > 0) return Number(rows[i][2]);
  }
  return 3000000;
}

/* ---------------- relatório da semana ---------------- */

function montarSemanal_() {
  var todos = lerRegistros_();
  var p = semanaPassada_();
  var antIni = new Date(p.ini); antIni.setDate(p.ini.getDate() - 7);
  var antFim = new Date(p.fim); antFim.setDate(p.fim.getDate() - 7);
  var sem = noPeriodo_(todos, p.ini, p.fim);
  var ant = noPeriodo_(todos, antIni, antFim);
  var t = totais_(sem, todos), ta = totais_(ant, todos);

  var corpo = '<div style="font-size:30px;font-weight:300">' + brl_(t.vgv) + "</div>" +
    '<div style="color:#6f6659;margin-bottom:14px">VGV vendido · ' + t.vendas + (t.vendas === 1 ? " venda" : " vendas") + delta_(t.vgv, ta.vgv) +
    (t.vendas ? " · ticket " + brl_(t.vgv / t.vendas) : "") + "</div>" +
    "<p>" + t.visitas + " visitas" + delta_(t.visitas, ta.visitas) + " · " + t.treinos + " treinamentos" + delta_(t.treinos, ta.treinos) +
    " · " + t.propostas + " propostas" + delta_(t.propostas, ta.propostas) + "</p>";

  var porG = agrupar_(sem, "gerente");
  var gerentes = Object.keys(agrupar_(todos, "gerente")).sort();
  var metaG = metaVgv_();
  var hj = new Date(), iniMes = new Date(hj.getFullYear(), hj.getMonth(), 1), fimMes = new Date(hj.getFullYear(), hj.getMonth() + 1, 0);
  var noMes = agrupar_(noPeriodo_(todos, iniMes, fimMes), "gerente");
  corpo += h3_("Meta de VGV do mês (" + brl_(metaG) + " por gerente)") + tabela_(["Gerente", "Vendido no mês", "% da meta"],
    gerentes.map(function (g) { var v = totais_(noMes[g] || [], todos).vgv; return [g, v ? brl_(v) : "—", Math.round(v / metaG * 100) + "%"]; }));
  corpo += h3_("Por gerente") + tabela_(["Gerente", "Visitas", "Treinos", "Propostas", "Vendas", "VGV"],
    gerentes.map(function (g) { var x = totais_(porG[g] || [], todos); return [g, x.visitas, x.treinos, x.propostas, x.vendas, x.vgv ? brl_(x.vgv) : "—"]; }));

  var porP = agrupar_(sem, "estoque");
  corpo += h3_("Por produto") + tabela_(["Produto", "Visitas", "Treinos", "Propostas", "Vendas", "VGV"],
    Object.keys(porP).sort(function (a, b) { return porP[b].length - porP[a].length; })
      .map(function (k) { var x = totais_(porP[k], todos); return [k, x.visitas, x.treinos, x.propostas, x.vendas, x.vgv ? brl_(x.vgv) : "—"]; }));

  // propostas em aberto (todas, não só da semana), mais antigas primeiro
  var conv = {};
  todos.forEach(function (e) { if (e.tipo === "Venda - Venda" && e.convertidaDe) conv[e.convertidaDe] = true; });
  var hoje = new Date();
  var abertas = todos.filter(function (e) { return e.tipo === "Venda - Proposta" && !conv[e.criadoEm] && e.status !== "Perdida"; })
    .sort(function (a, b) { return a.data - b.data; });
  if (abertas.length) {
    var soma = abertas.reduce(function (s, e) { return s + e.vgv; }, 0);
    corpo += h3_("Propostas em aberto · " + brl_(soma)) + tabela_(["Data", "Gerente", "Produto", "Unid.", "Parceiro", "Valor", "Aberta há"],
      abertas.map(function (e) { return [dm_(e.data), e.gerente, e.estoque, e.unidade || "—", e.parceiro || "—", brl_(e.vgv), Math.max(0, Math.round((hoje - e.data) / 864e5)) + " dias"]; }));
  }

  // quem ficou parado na semana
  var semReg = gerentes.filter(function (g) { return !(porG[g] || []).length; });
  if (semReg.length) corpo += '<p style="color:#a8402c">Sem nenhum registro na semana: ' + semReg.join(", ") + ".</p>";

  return { assunto: "Parcerias · semana de " + dm_(p.ini) + " a " + dm_(p.fim) + " · " + brl_(t.vgv) + " vendidos",
    html: moldura_("Resumo da semana · " + dm_(p.ini) + " a " + dm_(p.fim), corpo) };
}
function enviarResumoSemanal() {
  var r = montarSemanal_();
  MailApp.sendEmail({ to: DESTINATARIOS.semanal.join(","), subject: r.assunto, htmlBody: r.html });
}
function testarRelatorioSemanal() {
  var r = montarSemanal_();
  MailApp.sendEmail({ to: Session.getActiveUser().getEmail() || DESTINATARIOS.semanal[0], subject: "[TESTE] " + r.assunto, htmlBody: r.html });
}

/* ---------------- aviso diário: quem não registrou hoje ---------------- */

function avisoDiario() {
  var hoje = new Date(); var dow = hoje.getDay();
  if (dow === 0 || dow === 6) return; // só dia útil
  var hojeTxt = Utilities.formatDate(hoje, FUSO, "yyyy-MM-dd");
  var todos = lerRegistros_();
  var gerentes = Object.keys(agrupar_(todos, "gerente")).sort();
  // conta o que foi LANÇADO hoje (criadoEm), não a data da ação — quem deixou
  // a agenda marcada com antecedência também está registrando.
  var lancaramHoje = {};
  todos.forEach(function (e) {
    var c = e.criadoEm ? Utilities.formatDate(new Date(e.criadoEm), FUSO, "yyyy-MM-dd") : "";
    if (c === hojeTxt) lancaramHoje[e.gerente] = (lancaramHoje[e.gerente] || 0) + 1;
  });
  var faltam = gerentes.filter(function (g) { return !lancaramHoje[g]; });
  if (!faltam.length) return;
  var corpo = "<p>Não registraram nada no painel hoje: <strong>" + faltam.join(", ") + "</strong>.</p>" +
    "<p>Lançaram hoje: " + (Object.keys(lancaramHoje).map(function (g) { return g + " (" + lancaramHoje[g] + ")"; }).join(", ") || "ninguém") + ".</p>";
  MailApp.sendEmail({ to: DESTINATARIOS.diario.join(","), subject: "Parcerias · " + faltam.length + " sem registro hoje", htmlBody: moldura_("Registros de hoje", corpo) });
}

/* ---------------- fechamento do mês, gerente por gerente ---------------- */

function fechamentoMensal() {
  var todos = lerRegistros_();
  var p = mesPassado_();
  var mes = noPeriodo_(todos, p.ini, p.fim);
  var t = totais_(mes, todos);
  var nomeMes = Utilities.formatDate(p.ini, FUSO, "MM/yyyy");
  var corpo = '<div style="font-size:30px;font-weight:300">' + brl_(t.vgv) + '</div><div style="color:#6f6659;margin-bottom:10px">VGV vendido no mês · ' + t.vendas + " vendas</div>";
  var porG = agrupar_(mes, "gerente");
  Object.keys(agrupar_(todos, "gerente")).sort().forEach(function (g) {
    var lista = porG[g] || [];
    var x = totais_(lista, todos);
    var conv = x.visitas ? Math.round(x.propostas / x.visitas * 100) + "%" : "—";
    var porP = agrupar_(lista, "estoque");
    var produtos = Object.keys(porP).sort(function (a, b) { return porP[b].length - porP[a].length; }).map(function (k) { return k + " (" + porP[k].length + ")"; }).join(" · ");
    corpo += h3_(g) + tabela_(["Visitas", "Treinos", "Propostas", "Vendas", "VGV", "Visita→proposta"],
      [[x.visitas, x.treinos, x.propostas, x.vendas, x.vgv ? brl_(x.vgv) : "—", conv]]) +
      '<p style="font-size:12px;color:#6f6659;margin-top:-10px">Produtos: ' + (produtos || "nenhum registro") + "</p>";
  });
  MailApp.sendEmail({ to: DESTINATARIOS.mensal.join(","), subject: "Parcerias · fechamento " + nomeMes + " · " + brl_(t.vgv), htmlBody: moldura_("Fechamento de " + nomeMes, corpo) });
}

/* ---------------- gatilhos ---------------- */

function instalarGatilhos() {
  var nomes = ["enviarResumoSemanal", "avisoDiario", "fechamentoMensal"];
  ScriptApp.getProjectTriggers().forEach(function (tr) {
    if (nomes.indexOf(tr.getHandlerFunction()) !== -1) ScriptApp.deleteTrigger(tr);
  });
  ScriptApp.newTrigger("enviarResumoSemanal").timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(8).inTimezone(FUSO).create();
  ScriptApp.newTrigger("avisoDiario").timeBased().everyDays(1).atHour(18).inTimezone(FUSO).create();
  ScriptApp.newTrigger("fechamentoMensal").timeBased().onMonthDay(1).atHour(8).inTimezone(FUSO).create();
}
