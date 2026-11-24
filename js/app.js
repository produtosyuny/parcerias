(function(){
  "use strict";

  var TIPOS_PILAR = function(tipo){ return tipo ? tipo.split(" - ")[0] : ""; };

  // Config (estoques list + default metas) lives in data/config.json so it
  // can be edited without touching code. DEFAULT_CONFIG is the fallback used
  // if that fetch fails (e.g. opening index.html directly as a file:// URL,
  // which browsers block fetch() for) — GitHub Pages serves it fine.
  var DEFAULT_CONFIG = {
    estoques: ["Uapé", "Esquina", "155", "177", "Zip", "Jesuíno", "Lorena", "Camino", "Natury", "Apê Jardim Sul", "Apê Vila Ema", "Lojas", "Multiprodutos", "Outro"],
    metasDefault: { plantao: 1, visita: 1, apresentacao: 3 }
  };
  var CONFIG = DEFAULT_CONFIG;
  var METAS_DEFAULT = DEFAULT_CONFIG.metasDefault;

  var db = null;
  var metas = METAS_DEFAULT;
  var logins = {};              // { id: {nome, senha, papel} }
  var entriesByGerente = {};    // { gerenteId: [entry,...] }
  var unsubEntries = {};        // { gerenteId: unsubscribe }
  var unsubMyEntries = null;
  var me = null;                // { id, nome, papel }
  var enteredAs = null;
  var formWired = false, metasWired = false, gerentesWired = false, corretoresWired = false;
  var myEntriesRaw = [];
  var unsubMyCorretores = null;
  var myCorretoresRaw = [];     // corretores do Portal que escolheram ESTE gerente
  var unsubCorretoresAll = null;
  var allCorretoresRaw = [];    // todos os corretores do Portal (uso do diretor)
  var dCorretoresFiltro = "";   // "" = todos | "__sem__" = não vinculados | id do gerente
  var meState = { periodo: "semana", start: null, end: null, pilarSel: null };
  var dState = { periodo: "semana", start: null, end: null, estoque: "", selected: null, knownIds: null, pilarSel: null };
  var rState = { periodo: "semana", start: null, end: null }; // aba "Resumo" — sempre time todo, sem filtro de gerente/estoque
  var iState = { periodo: "semana", start: null, end: null, gerenteId: "", funilSel: null }; // aba "Individual" — um gerente por vez

  function $(id){ return document.getElementById(id); }
  function show(el){ el.hidden = false; }
  function hide(el){ el.hidden = true; }

  function toast(msg){
    var t = $("toast");
    t.textContent = msg;
    t.classList.add("show");
    setTimeout(function(){ t.classList.remove("show"); }, 2200);
  }

  function todayISO(){
    var d = new Date();
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    return d.toISOString().slice(0,10);
  }

  function weekBounds(ref){
    var d = ref ? new Date(ref) : new Date();
    var day = d.getDay(); // 0=Sun
    var diff = (day === 0 ? -6 : 1 - day);
    var start = new Date(d.getFullYear(), d.getMonth(), d.getDate() + diff);
    var end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6);
    return { start: start, end: end };
  }
  function inWeek(dataISO, bounds){
    if (!dataISO) return false;
    var d = new Date(dataISO + "T00:00:00");
    return d >= bounds.start && d <= bounds.end;
  }
  function fmtRange(bounds){
    var f = function(d){ return String(d.getDate()).padStart(2,"0") + "/" + String(d.getMonth()+1).padStart(2,"0"); };
    return f(bounds.start) + "–" + f(bounds.end);
  }
  function fmtDM(iso){
    var parts = iso.split("-");
    return parts[2] + "/" + parts[1];
  }

  // `allEntries` (opcional) é a lista COMPLETA desse(s) gerente(s), sem filtro
  // de período — só serve pra descobrir quais propostas já viraram venda (o
  // registro da venda pode ter sido feito num período diferente do da
  // proposta original, então o link pode apontar pra fora de `entries`).
  // Sem esse 2º parâmetro, vgvPropostas soma tudo bruto (sem descontar
  // conversões) — por isso todo call site relevante passa o unfiltered junto.
  function computeTotals(entries, allEntries){
    var t = { visitas:0, treinamentos:0, propostas:0, vendas:0, vgv:0, vgvPropostas:0 };
    var convertidas = null;
    if (allEntries){
      convertidas = {};
      allEntries.forEach(function(e){
        if (e.tipo === "Venda - Venda" && e.convertidaDeProposta) convertidas[e.convertidaDeProposta] = true;
      });
    }
    entries.forEach(function(e){
      if (TIPOS_PILAR(e.tipo) === "Visitas") t.visitas++;
      else if (TIPOS_PILAR(e.tipo) === "Treinamento") t.treinamentos++;
      else if (e.tipo === "Venda - Proposta"){
        t.propostas++;
        // a CONTAGEM de propostas continua contando todas (é histórico: "N
        // propostas foram feitas nesse período") — só o VGV "em potencial"
        // desconta as que a gente já sabe que fecharam, pra não continuar
        // somando como "ainda em aberto" um negócio que já virou venda.
        var jaConvertida = convertidas && e.criadoEm && convertidas[e.criadoEm];
        if (!jaConvertida && e.status !== "Perdida"){
          t.vgvPropostas += (typeof e.vgv === "number" && !isNaN(e.vgv)) ? e.vgv : 0;
        }
      }
      else if (e.tipo === "Venda - Venda"){
        t.vendas++;
        t.vgv += (typeof e.vgv === "number" && !isNaN(e.vgv)) ? e.vgv : 0;
      }
    });
    return t;
  }
  // Rotina da semana (regra definida em 24/11):
  //  - Plantão de estoque  = treino "Em Stand" em qualquer produto, menos o Jesuíno;
  //  - Visita a imobiliária = treino "Em Imobiliária" (qualquer produto);
  //  - Apresentação de lançamento = qualquer treino com produto Jesuíno.
  // Um treino do Jesuíno dentro da imobiliária conta nas duas últimas — é
  // visita a imobiliária E apresentação de lançamento ao mesmo tempo.
  // Os nomes antigos continuam valendo, pra não zerar registros velhos.
  var LANCAMENTOS = { "Jesuíno": true };
  function computeWeek(entries, bounds){
    var w = { plantao:0, visita:0, apresentacao:0 };
    entries.forEach(function(e){
      if (!inWeek(e.data, bounds) || !contaComoFeito_(e)) return;
      var treino = TIPOS_PILAR(e.tipo) === "Treinamento";
      if (!treino) return;
      var lanc = !!LANCAMENTOS[e.estoque];
      if (e.tipo === "Treinamento - Plantão de estoque" || (e.tipo === "Treinamento - Em Stand" && !lanc)) w.plantao++;
      if (e.tipo === "Treinamento - Visita a imobiliária" || e.tipo === "Treinamento - Em Imobiliária") w.visita++;
      if (e.tipo === "Treinamento - Apresentação de lançamento" || lanc) w.apresentacao++;
    });
    return w;
  }

  // ---------- meta de VGV do mês (por gerente) ----------
  function metaVgvGerente_(){
    var m = metas && Number(metas.vgvMensal);
    if (m > 0) return m;
    return Number(CONFIG.metaVgvMensal) || 3000000;
  }
  function vgvDoMes_(entries){
    var b = monthBounds();
    return computeTotals(filterEntries(entries || [], b, ""), entries || []).vgv;
  }
  function metaBarraHTML(vgv, meta, titulo){
    var pct = meta ? Math.round(vgv / meta * 100) : 0;
    var hoje = new Date(), b = monthBounds();
    var diasMes = b.end.getDate(), dia = hoje.getDate();
    var esperado = Math.round(dia / diasMes * 100);
    var cls = pct >= esperado ? "ok" : (pct >= esperado * 0.6 ? "atencao" : "baixo");
    return '<div class="meta-vgv"><div class="meta-vgv-top"><span class="meta-vgv-tit">' + renderEscaped(titulo) + '</span>' +
      '<span class="meta-vgv-num">' + fmtBRLCurto_(vgv) + ' de ' + fmtBRLCurto_(meta) + ' · <strong>' + pct + '%</strong></span></div>' +
      '<div class="meta-vgv-trilho"><div class="meta-vgv-barra ' + cls + '" style="width:' + Math.min(100, pct) + '%"></div>' +
      '<div class="meta-vgv-marca" style="left:' + Math.min(100, esperado) + '%" title="Onde deveria estar hoje"></div></div>' +
      '<div class="meta-vgv-rodape">Pelo dia do mês, o ritmo esperado hoje é ' + esperado + '% · falta ' + fmtBRLCurto_(Math.max(0, meta - vgv)) + '</div></div>';
  }

  // 4 pilares separados (Propostas e Vendas não se somam mais num "Venda"
  // único — a mesma negociação aparecia 2x como atividade: proposta + venda).
  function pilarCounts(entries){
    var c = { "Visitas": 0, "Treinamento": 0, "Propostas": 0, "Vendas": 0 };
    entries.forEach(function(e){
      var p = TIPOS_PILAR(e.tipo);
      if (p === "Visitas") c["Visitas"]++;
      else if (p === "Treinamento") c["Treinamento"]++;
      else if (e.tipo === "Venda - Proposta") c["Propostas"]++;
      else if (e.tipo === "Venda - Venda") c["Vendas"]++;
    });
    return c;
  }

  // os 4 cards de totais (Visitas/Treinamentos/Propostas/Vendas) funcionam
  // como filtro: clicar num deles filtra os gráficos logo abaixo por aquele
  // pilar; clicar de novo no mesmo limpa o filtro.
  var PILAR_FILTERS = {
    visitas: { label: "Visitas", color: "var(--viz-cat-1)", pred: function(e){ return TIPOS_PILAR(e.tipo) === "Visitas"; } },
    treinamentos: { label: "Treinamentos", color: "var(--viz-cat-2)", pred: function(e){ return TIPOS_PILAR(e.tipo) === "Treinamento"; } },
    propostas: { label: "Propostas", color: "var(--viz-cat-3)", pred: function(e){ return e.tipo === "Venda - Proposta"; } },
    vendas: { label: "Vendas", color: "var(--viz-cat-4)", pred: function(e){ return e.tipo === "Venda - Venda"; } }
  };

  function monthBounds(ref){
    var d = ref ? new Date(ref) : new Date();
    var start = new Date(d.getFullYear(), d.getMonth(), 1);
    var end = new Date(d.getFullYear(), d.getMonth() + 1, 0);
    return { start: start, end: end };
  }
  function periodBounds(state){
    if (state.periodo === "mes"){
      // "Mês atual" é sempre do dia 1 até hoje (YTD do mês), nunca até o fim
      // do mês — como o time às vezes lança atividade com data futura
      // (visita/treinamento agendado), deixar o período ir até o fim do mês
      // inflava os números com dias que ainda nem aconteceram.
      var b = monthBounds();
      var hoje = new Date(); hoje.setHours(0, 0, 0, 0);
      if (b.end > hoje) b.end = hoje;
      return b;
    }
    if (state.periodo === "custom" && state.start && state.end){
      return { start: new Date(state.start + "T00:00:00"), end: new Date(state.end + "T00:00:00") };
    }
    return weekBounds();
  }
  function periodLabel(state){
    var b = periodBounds(state);
    if (state.periodo === "mes") return "mês atual (" + fmtRange(b) + ")";
    if (state.periodo === "custom") return "período (" + fmtRange(b) + ")";
    return "semana atual (" + fmtRange(b) + ")";
  }
  // the equal-length window immediately before the current one, for stat-tile deltas
  function previousPeriodBounds(state){
    var b = periodBounds(state);
    if (state.periodo === "mes"){
      // Compara dia-a-dia com o mesmo trecho do mês anterior (ex.: dia 1 ao
      // dia 23), em vez do mês anterior inteiro — senão a comparação fica
      // injusta (poucos dias deste mês vs. o mês passado completo).
      var prevRef = new Date(b.start.getFullYear(), b.start.getMonth() - 1, 15);
      var pm = monthBounds(prevRef);
      var ultimoDiaPrev = new Date(pm.start.getFullYear(), pm.start.getMonth() + 1, 0).getDate();
      pm.end = new Date(pm.start.getFullYear(), pm.start.getMonth(), Math.min(b.end.getDate(), ultimoDiaPrev));
      return pm;
    }
    var days = Math.round((b.end - b.start) / 86400000) + 1;
    var prevEnd = new Date(b.start.getFullYear(), b.start.getMonth(), b.start.getDate() - 1);
    var prevStart = new Date(prevEnd.getFullYear(), prevEnd.getMonth(), prevEnd.getDate() - (days - 1));
    return { start: prevStart, end: prevEnd };
  }
  // ---------- status de cada registro (item 7) ----------
  // Visita/Treinamento: Agendado → Realizado (ou Cancelado). Só conta nos
  // números quando é Realizado. Registros antigos, sem status: data futura =
  // Agendado; data de hoje pra trás = Realizado.
  // Proposta: Em negociação | Perdida (ganha = virou venda vinculada).
  function statusEfetivo_(e){
    if (e.tipo === "Venda - Venda") return "Realizado";
    if (e.tipo === "Venda - Proposta") return e.status === "Perdida" ? "Perdida" : "Em negociação";
    if (e.status === "Agendado" || e.status === "Realizado" || e.status === "Cancelado") return e.status;
    return (e.data && e.data > todayISO()) ? "Agendado" : "Realizado";
  }
  function contaComoFeito_(e){
    var st = statusEfetivo_(e);
    return st !== "Agendado" && st !== "Cancelado";
  }
  function aConfirmar_(e){ return statusEfetivo_(e) === "Agendado" && e.data && e.data <= todayISO(); }

  // incluirTodos = true: não esconde agendados/cancelados (usado nas listas de registros)
  function filterEntries(entries, bounds, estoque, incluirTodos){
    return entries.filter(function(e){
      if (!inWeek(e.data, bounds)) return false;
      if (estoque && e.estoque !== estoque) return false;
      if (!incluirTodos && !contaComoFeito_(e)) return false;
      return true;
    });
  }

  function deltaBadge(curr, prev){
    if (!prev && !curr) return "";
    if (!prev) return '<span class="d up">▲ novo</span>';
    var pct = Math.round(((curr - prev) / prev) * 100);
    if (pct === 0) return '<span class="d flat">— estável</span>';
    var up = pct > 0;
    return '<span class="d ' + (up ? "up" : "down") + '">' + (up ? "▲" : "▼") + " " + Math.abs(pct) + "% vs. período anterior</span>";
  }
  function statTile(n, l, deltaHtml, sparkHtml, key, selected){
    var cls = "stat" + (selected ? " is-selected" : "");
    var attrs = key ? ' data-pilar="' + key + '" role="button" tabindex="0" aria-pressed="' + (selected ? "true" : "false") + '"' : "";
    return '<div class="'+cls+'"'+attrs+'><div class="n">'+n+'</div><div class="l">'+l+'</div>'+(deltaHtml||"")+(sparkHtml||"")+'</div>';
  }
  function pilarFilterNoteHTML(selKey){
    if (!selKey || !PILAR_FILTERS[selKey]) return "";
    return 'Filtrando os gráficos abaixo por <b>' + renderEscaped(PILAR_FILTERS[selKey].label) + '</b> — toque no card de novo pra limpar.';
  }
  function fmtBRL(n){
    n = (typeof n === "number" && !isNaN(n)) ? n : 0;
    try{
      return n.toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
    }catch(err){
      return "R$ " + Math.round(n);
    }
  }
  // "R$ 1,53 mi" / "R$ 550 mil" — pra caber em tabela no celular
  function fmtBRLCurto_(n){
    n = Number(n) || 0;
    if (n >= 1e6) return "R$ " + (Math.round(n / 1e4) / 100).toLocaleString("pt-BR") + " mi";
    if (n >= 1e3) return "R$ " + Math.round(n / 1e3).toLocaleString("pt-BR") + " mil";
    return fmtBRL(n);
  }
  function heroMini(n, l){
    return '<div class="hk-mini"><div class="hk-mini-n">'+n+'</div><div class="hk-mini-l">'+l+'</div></div>';
  }
  function heroKpi(valueText, deltaHtml, miniHtml){
    return '<div class="hero-kpi"><div class="hk-main"><div class="hk-value">'+valueText+'</div>'+(deltaHtml||"")+'</div>'+
      (miniHtml ? '<div class="hk-side">'+miniHtml+'</div>' : "") + '</div>';
  }
  function pill(ok){
    return ok ? '<span class="pill ok">OK</span>' : '<span class="pill low">Abaixo</span>';
  }
  function weekRowsHTML(w, metasNow){
    var rows = [
      ["Plantão de estoque", w.plantao, metasNow.plantao],
      ["Visita a imobiliária", w.visita, metasNow.visita],
      ["Apresentação de lançamento", w.apresentacao, metasNow.apresentacao]
    ];
    return rows.map(function(r){
      var ok = r[1] >= r[2];
      return '<div class="mini-grid" style="grid-template-columns:1fr auto auto; align-items:center; margin-top:8px">'+
        '<div class="s">'+r[0]+'</div>'+
        '<div class="v">'+r[1]+' / '+r[2]+'</div>'+
        pill(ok) + '</div>';
    }).join("");
  }

  function renderEscaped(s){
    var d = document.createElement("div");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML;
  }

  // ---------- chart helpers ----------
  function svgEl(tag, attrs){
    var el = document.createElementNS("http://www.w3.org/2000/svg", tag);
    if (attrs) Object.keys(attrs).forEach(function(k){ el.setAttribute(k, attrs[k]); });
    return el;
  }
  function positionTooltip(evt){
    var tt = $("viz-tooltip");
    var x = (evt && evt.clientX != null) ? evt.clientX : 20;
    var y = (evt && evt.clientY != null) ? evt.clientY : 20;
    var pad = 14;
    var tw = tt.offsetWidth || 140, th = tt.offsetHeight || 40;
    var left = Math.min(window.innerWidth - tw - 8, x + pad);
    var top = Math.max(8, y - th - pad);
    tt.style.left = Math.max(8, left) + "px";
    tt.style.top = top + "px";
  }
  function tooltipContent(title, rows){
    var frag = document.createDocumentFragment();
    var b = document.createElement("b"); b.textContent = title; frag.appendChild(b);
    rows.forEach(function(r){
      var row = document.createElement("div");
      row.style.display = "flex"; row.style.alignItems = "center"; row.style.gap = "6px"; row.style.marginTop = "2px";
      if (r.color){
        var key = document.createElement("span");
        key.style.display = "inline-block"; key.style.width = "8px"; key.style.height = "2px"; key.style.background = r.color;
        row.appendChild(key);
      }
      var txt = document.createElement("span");
      txt.textContent = r.label + ": " + r.value;
      row.appendChild(txt);
      frag.appendChild(row);
    });
    return frag;
  }
  function showTooltip(evt, content){
    var tt = $("viz-tooltip");
    tt.innerHTML = "";
    tt.appendChild(content);
    tt.classList.add("show");
    positionTooltip(evt);
  }
  function hideTooltip(){ $("viz-tooltip").classList.remove("show"); }

  // one row per calendar day in bounds, counting how many (already-filtered) entries fall on it
  function dailyCounts(entries, bounds){
    var map = {};
    entries.forEach(function(e){
      if (!e.data) return;
      map[e.data] = (map[e.data] || 0) + 1;
    });
    var days = [];
    var cur = new Date(bounds.start.getFullYear(), bounds.start.getMonth(), bounds.start.getDate());
    var end = new Date(bounds.end.getFullYear(), bounds.end.getMonth(), bounds.end.getDate());
    var guard = 0;
    while (cur <= end && guard < 400){
      var iso = cur.getFullYear() + "-" + String(cur.getMonth()+1).padStart(2,"0") + "-" + String(cur.getDate()).padStart(2,"0");
      days.push({ date: iso, value: map[iso] || 0 });
      cur.setDate(cur.getDate() + 1);
      guard++;
    }
    return days;
  }

  // small decorative inline-SVG sparkline (markup string) for a stat tile — no hover, per dataviz skill's stat-tile "trend" spec
  function sparklineSVG(values, colorVar){
    var n = values.length;
    if (n < 2 || !values.some(function(v){ return v > 0; })) return "";
    var w = 120, h = 32;
    var max = Math.max.apply(null, values) || 1;
    var pts = values.map(function(v, i){
      var x = (i / (n - 1)) * w;
      var y = h - (v / max) * (h - 3) - 1.5;
      return x.toFixed(1) + "," + y.toFixed(1);
    });
    var pathD = "M" + pts.join(" L");
    var areaD = pathD + " L" + w + "," + h + " L0," + h + " Z";
    return '<svg class="spark" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none" aria-hidden="true">'
      + '<path d="' + areaD + '" style="fill:' + colorVar + ';opacity:.16;stroke:none"></path>'
      + '<path d="' + pathD + '" style="fill:none;stroke:' + colorVar + ';stroke-width:2;stroke-linejoin:round;stroke-linecap:round"></path>'
      + '</svg>';
  }

  function renderTrendChart(container, days, ariaLabel){
    container.innerHTML = "";
    if (!days.length || !days.some(function(d){ return d.value > 0; })){
      var p = document.createElement("p"); p.className = "viz-empty"; p.textContent = "Sem registros nesse período.";
      container.appendChild(p); return;
    }
    var max = Math.max.apply(null, days.map(function(d){ return d.value; })) || 1;
    var n = days.length;
    var w = Math.max(360, Math.min(n * 34, 920)), h = 190;
    var padL = 30, padR = 12, padT = 14, padB = 26;
    var plotW = w - padL - padR, plotH = h - padT - padB;
    var svg = svgEl("svg", { viewBox: "0 0 " + w + " " + h, class: "barchart", role: "img", "aria-label": ariaLabel });

    var steps = 3;
    for (var i = 0; i <= steps; i++){
      var gy = padT + plotH - (plotH * i / steps);
      svg.appendChild(svgEl("line", { x1: padL, x2: w - padR, y1: gy, y2: gy, class: "grid-line" }));
      var gl = svgEl("text", { x: padL - 6, y: gy + 3.5, "text-anchor": "end", "font-size": "10" });
      gl.textContent = String(Math.round(max * i / steps));
      svg.appendChild(gl);
    }

    var pts = days.map(function(d, idx){
      var x = padL + (n === 1 ? plotW / 2 : (idx / (n - 1)) * plotW);
      var y = padT + plotH - (d.value / max) * plotH;
      return { x: x, y: y, d: d };
    });
    var pathD = pts.map(function(pt, idx){ return (idx === 0 ? "M" : "L") + pt.x.toFixed(1) + "," + pt.y.toFixed(1); }).join(" ");
    var baseline = padT + plotH;
    var areaD = pathD + " L" + pts[n-1].x.toFixed(1) + "," + baseline + " L" + pts[0].x.toFixed(1) + "," + baseline + " Z";
    svg.appendChild(svgEl("path", { d: areaD, style: "fill:var(--viz-cat-1);opacity:.14;stroke:none" }));
    svg.appendChild(svgEl("path", { d: pathD, style: "fill:none;stroke:var(--viz-cat-1);stroke-width:2;stroke-linejoin:round;stroke-linecap:round" }));

    var labelEvery = Math.max(1, Math.ceil(n / 7));
    pts.forEach(function(pt, idx){
      var dLabel = fmtDM(pt.d.date);
      var dot = svgEl("circle", { cx: pt.x, cy: pt.y, r: 4, style: "fill:var(--viz-cat-1);stroke:var(--bg-solid);stroke-width:2;cursor:pointer", tabindex: "0" });
      var rows = [{ label: "Registros", value: pt.d.value, color: "var(--viz-cat-1)" }];
      var showTT = function(evt){ showTooltip(evt, tooltipContent(dLabel, rows)); };
      dot.addEventListener("pointermove", showTT);
      dot.addEventListener("pointerenter", showTT);
      dot.addEventListener("pointerleave", hideTooltip);
      dot.addEventListener("focus", function(){ showTooltip(null, tooltipContent(dLabel, rows)); });
      dot.addEventListener("blur", hideTooltip);
      svg.appendChild(dot);
      if (idx % labelEvery === 0 || idx === n - 1){
        var lbl = svgEl("text", { x: pt.x, y: h - 6, "text-anchor": "middle", "font-size": "10" });
        lbl.textContent = dLabel;
        svg.appendChild(lbl);
      }
    });
    container.appendChild(svg);
  }

  // produtos que só aparecem nas tabelas se tiverem registro no período
  // (não viram linha de zero permanente).
  var ESTOQUE_SO_SE_TIVER = { "Outro": true, "Multiprodutos": true };

  // ---------- nomes de parceiro: normalização ----------
  // O campo é texto livre, então a mesma imobiliária aparece de vários
  // jeitos ("Midrah", "Midrah Imobiliária", "Marcos / Midrah"). Isto gera uma
  // chave comparável; o agrupamento de nomes parecidos fica em agruparParceiros_().
  var PARCEIRO_STOP = { "imobiliaria":1, "imobiliarias":1, "imoveis":1, "imovel":1, "imob":1, "negocios":1, "imobiliarios":1,
    "corretor":1, "corretora":1, "autonomo":1, "autonoma":1, "de":1, "da":1, "do":1, "e":1, "the":1, "time":1, "equipe":1 };
  function semAcento_(t){ return String(t || "").normalize("NFD").replace(/[\u0300-\u036f]/g, ""); }
  function tokensParceiro_(nome){
    return semAcento_(nome).toLowerCase().replace(/&/g, " ").replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/)
      .filter(function(t){ return t && !PARCEIRO_STOP[t]; });
  }
  function chaveParceiro_(nome){ return tokensParceiro_(nome).join(" "); }
  function levenshtein_(a, b){
    if (a === b) return 0;
    var m = a.length, n = b.length, prev = [], cur, i, j;
    for (j = 0; j <= n; j++) prev[j] = j;
    for (i = 1; i <= m; i++){
      cur = [i];
      for (j = 1; j <= n; j++){
        cur[j] = Math.min(prev[j] + 1, cur[j-1] + 1, prev[j-1] + (a[i-1] === b[j-1] ? 0 : 1));
      }
      prev = cur;
    }
    return prev[n];
  }
  function ehNomeDeGerente_(nome){
    var k = chaveParceiro_(nome);
    if (!k) return false;
    return Object.keys(logins).some(function(id){
      var g = logins[id] || {};
      if (g.papel !== "gerente" && g.papel !== "diretor") return false;
      var kg = chaveParceiro_(g.nome || id);
      var primeiro = kg.split(" ")[0];
      return k === kg || (primeiro && k === primeiro);
    });
  }
  function hojeISO_(){ return todayISO(); }
  function diasEntre_(isoA, isoB){
    var a = new Date(isoA + "T00:00:00"), b = new Date(isoB + "T00:00:00");
    return Math.round((b - a) / 86400000);
  }
  // unidade digitada no formulário vai no começo da observação ("Unid. 1207 · ...")
  // enquanto a planilha não tem coluna própria pra ela.
  function unidadeDe_(e){
    if (e.unidade) return String(e.unidade);
    var m = /^Unid\.\s*([^·]+?)\s*(·|$)/.exec(String(e.observacao || ""));
    return m ? m[1].trim() : "";
  }

  function renderHBarList(container, items, ariaLabel, emptyMsg){
    container.innerHTML = "";
    if (!items.some(function(i){ return i.value > 0; })){
      var p = document.createElement("p"); p.className = "viz-empty"; p.textContent = emptyMsg || "Sem registros nesse período.";
      container.appendChild(p); return;
    }
    var max = Math.max.apply(null, items.map(function(i){ return i.value; })) || 1;
    var rowH = 34, barH = 20, labelW = 128, chartW = 360, plotW = chartW - labelW - 46;
    var svg = svgEl("svg", { viewBox: "0 0 " + chartW + " " + (items.length * rowH), class: "barchart", role: "img", "aria-label": ariaLabel });
    items.forEach(function(it, i){
      var cy = i * rowH + rowH / 2;
      var bw = Math.max(2, (it.value / max) * plotW);
      var label = svgEl("text", { x: labelW - 8, y: cy + 4, "text-anchor": "end", "font-size": "12.5" });
      label.textContent = it.label;
      var rect = svgEl("rect", { x: labelW, y: cy - barH / 2, width: bw, height: barH, rx: 4, ry: 4, tabindex: "0", style: "fill:" + it.color + ";cursor:pointer" });
      var titleEl = svgEl("title", {}); titleEl.textContent = it.label + ": " + it.value; rect.appendChild(titleEl);
      var val = svgEl("text", { class: "val-label", x: labelW + bw + 6, y: cy + 4, "font-size": "12.5" });
      val.textContent = String(it.value);
      var rows = [{ label: it.label, value: it.value, color: it.color }];
      var showTT = function(evt){ showTooltip(evt, tooltipContent(it.label, rows)); };
      rect.addEventListener("pointermove", showTT);
      rect.addEventListener("pointerenter", showTT);
      rect.addEventListener("pointerleave", hideTooltip);
      rect.addEventListener("focus", function(){ showTooltip(null, tooltipContent(it.label, rows)); });
      rect.addEventListener("blur", hideTooltip);
      svg.appendChild(label); svg.appendChild(rect); svg.appendChild(val);
    });
    container.appendChild(svg);
  }

  function renderPilarBars(container, counts){
    var items = [
      { label: "Visitas", value: counts["Visitas"] || 0, color: "var(--viz-cat-1)" },
      { label: "Treinamento", value: counts["Treinamento"] || 0, color: "var(--viz-cat-2)" },
      { label: "Propostas", value: counts["Propostas"] || 0, color: "var(--viz-cat-3)" },
      { label: "Vendas", value: counts["Vendas"] || 0, color: "var(--viz-cat-4)" }
    ];
    renderHBarList(container, items, "Ações por pilar", "Sem registros nesse período.");
  }

  function novoRecorrenteCounts(entries){
    var c = { novo: 0, recorrente: 0 };
    entries.forEach(function(e){
      if (e.primeiraOuRecorrente === "Primeira vez") c.novo++;
      else if (e.primeiraOuRecorrente === "Recorrente") c.recorrente++;
    });
    return c;
  }

  // só entra no card "<pilar> por projeto" quando um card de pilar está
  // selecionado — por isso só lista quem tem pelo menos 1 registro (nada de
  // barra zerada poluindo a lista).
  function estoqueCounts(entries){
    var map = {};
    entries.forEach(function(e){
      var k = e.estoque || "Sem estoque/lançamento";
      map[k] = (map[k] || 0) + 1;
    });
    var items = Object.keys(map).map(function(k){ return { label: k, value: map[k] }; });
    items.sort(function(a,b){ return b.value - a.value; });
    return items;
  }

  function renderNovoRecorrenteBars(container, counts){
    var items = [
      { label: "Primeira vez", value: counts.novo || 0, color: "var(--viz-cat-1)" },
      { label: "Recorrente", value: counts.recorrente || 0, color: "var(--viz-cat-3)" }
    ];
    renderHBarList(container, items, "Parceiros novos vs. recorrentes", "Sem registros nesse período.");
  }

  function renderRankedBarChart(container, items, ariaLabel){
    container.innerHTML = "";
    if (!items.length){
      var p = document.createElement("p"); p.className = "viz-empty"; p.textContent = "Sem dados para esse filtro.";
      container.appendChild(p); return;
    }
    var max = Math.max.apply(null, items.map(function(i){ return i.value; })) || 1;
    var rowH = 34, barH = 20, labelW = 96, chartW = 380, plotW = chartW - labelW - 46;
    var svg = svgEl("svg", { viewBox: "0 0 " + chartW + " " + (items.length * rowH), class: "barchart", role: "img", "aria-label": ariaLabel || "Gráfico de barras" });
    items.forEach(function(it, i){
      var cy = i * rowH + rowH / 2;
      var bw = Math.max(2, (it.value / max) * plotW);
      var label = svgEl("text", { x: labelW - 8, y: cy + 4, "text-anchor": "end", "font-size": "12.5" });
      label.textContent = it.label;
      var rect = svgEl("rect", { class: "bar", x: labelW, y: cy - barH / 2, width: bw, height: barH, rx: 4, ry: 4, tabindex: "0" });
      var titleEl = svgEl("title", {}); titleEl.textContent = it.label + ": " + it.value; rect.appendChild(titleEl);
      var val = svgEl("text", { class: "val-label", x: labelW + bw + 6, y: cy + 4, "font-size": "12.5" });
      val.textContent = String(it.value);
      var rows = [{ label: "Registros", value: it.value, color: "var(--viz-cat-1)" }];
      var showTT = function(evt){ showTooltip(evt, tooltipContent(it.label, rows)); rect.classList.add("hov"); };
      var hideTT = function(){ hideTooltip(); rect.classList.remove("hov"); };
      rect.addEventListener("pointermove", showTT);
      rect.addEventListener("pointerenter", showTT);
      rect.addEventListener("pointerleave", hideTT);
      rect.addEventListener("focus", function(){ showTooltip(null, tooltipContent(it.label, rows)); rect.classList.add("hov"); });
      rect.addEventListener("blur", hideTT);
      svg.appendChild(label); svg.appendChild(rect); svg.appendChild(val);
    });
    container.appendChild(svg);
  }

  // `series` e `ariaLabel` são opcionais — sem eles, mantém o comportamento
  // original (3 pilares, usado no gráfico "por gerente" da Visão geral). A
  // aba Individual passa 4 séries (visitas/treinamentos/propostas/vendas)
  // pra montar a mesma visualização como tendência ao longo de várias semanas.
  function renderGroupedBarChart(container, items, series, ariaLabel){
    container.innerHTML = "";
    if (!items.length){
      var p = document.createElement("p"); p.className = "viz-empty"; p.textContent = "Sem dados para esse filtro.";
      container.appendChild(p); return;
    }
    series = series || [
      { key: "visitas", name: "Visitas", color: "var(--viz-cat-1)" },
      { key: "treinamento", name: "Treinamento", color: "var(--viz-cat-2)" },
      { key: "propostas", name: "Propostas", color: "var(--viz-cat-3)" },
      { key: "vendas", name: "Vendas", color: "var(--viz-cat-4)" }
    ];
    ariaLabel = ariaLabel || "Atividades por pilar, por gerente";
    var max = 1;
    items.forEach(function(it){ series.forEach(function(s){ if ((it[s.key] || 0) > max) max = it[s.key]; }); });
    var groupW = Math.max(90, Math.min(130, 420 / items.length)), barW = 18, gap = 3, chartH = 190, baseline = chartH - 26, topPad = 20;
    // the chart is `width:100%; height:auto` (CSS), so the browser derives the
    // rendered height from the viewBox's own aspect ratio — with few gerentes
    // selected, items.length*groupW alone shrinks well under 420 and the chart
    // renders absurdly tall (viewBox 130x180 at 1 gerente ≈ a 0.72:1 box blown
    // up to full card width). Flooring chartW at 420 keeps the aspect ratio
    // sane regardless of how many gerentes are selected; slotW (not groupW)
    // then centers each gerente's 3 bars within its share of that width.
    var chartW = Math.max(420, items.length * groupW);
    var slotW = chartW / items.length;
    var svg = svgEl("svg", { viewBox: "0 0 " + chartW + " " + chartH, class: "barchart", role: "img", "aria-label": "Atividades por pilar, por gerente" });
    svg.appendChild(svgEl("line", { x1: 0, x2: chartW, y1: baseline, y2: baseline, class: "grid-line" }));
    items.forEach(function(it, gi){
      var gx = gi * slotW + slotW / 2 - (series.length * (barW + gap)) / 2;
      var tipRows = series.map(function(s2){ return { label: s2.name, value: it[s2.key] || 0, color: s2.color }; });
      series.forEach(function(s, si){
        var v = it[s.key] || 0;
        var h = (v / max) * (baseline - topPad);
        var x = gx + si * (barW + gap);
        var y = baseline - h;
        var rect = svgEl("rect", { x: x, y: y, width: barW, height: Math.max(h, 0), rx: 3, ry: 3, style: "fill:" + s.color + ";cursor:pointer", tabindex: "0" });
        var titleEl = svgEl("title", {}); titleEl.textContent = it.label + " · " + s.name + ": " + v; rect.appendChild(titleEl);
        var showTT = function(evt){ showTooltip(evt, tooltipContent(it.label, tipRows)); };
        rect.addEventListener("pointermove", showTT);
        rect.addEventListener("pointerenter", showTT);
        rect.addEventListener("pointerleave", hideTooltip);
        rect.addEventListener("focus", function(){ showTooltip(null, tooltipContent(it.label, tipRows)); });
        rect.addEventListener("blur", hideTooltip);
        svg.appendChild(rect);
        if (v > 0){
          var vt = svgEl("text", { class: "val-label", x: x + barW / 2, y: y - 4, "text-anchor": "middle", "font-size": "11" });
          vt.textContent = String(v);
          svg.appendChild(vt);
        }
      });
      var label = svgEl("text", { x: gi * slotW + slotW / 2, y: chartH - 6, "text-anchor": "middle", "font-size": "11.5" });
      label.textContent = it.label;
      svg.appendChild(label);
    });
    container.appendChild(svg);
    var legend = document.createElement("div"); legend.className = "legend-row";
    series.forEach(function(s){
      var item = document.createElement("div"); item.className = "legend-item";
      var sw = document.createElement("span"); sw.className = "legend-swatch"; sw.style.background = s.color;
      var txt = document.createElement("span"); txt.textContent = s.name;
      item.appendChild(sw); item.appendChild(txt);
      legend.appendChild(item);
    });
    container.appendChild(legend);
  }

  // ---------- aba "Resumo" ----------
  // Textos prontos por pilar, pra montar as frases de alerta sem precisar
  // conjugar substantivo/plural na hora (evita "muito vendas" etc.).
  var PILAR_ALERTA_TXT = {
    visitas: { alto: "muitas visitas", zero: "nenhuma visita" },
    treinamentos: { alto: "muitos treinamentos", zero: "nenhum treinamento" },
    propostas: { alto: "muitas propostas", zero: "nenhuma proposta" },
    vendas: { alto: "muitas vendas", zero: "nenhuma venda" }
  };
  var PILARES_ORDEM = ["visitas", "treinamentos", "propostas", "vendas"];

  // Tudo aqui sai direto da contagem dos 4 pilares — nada de texto digitado à
  // mão. Sempre considera TODOS os gerentes (não usa dState.selected nem
  // filtro de estoque), porque o resumo é pra visão do time inteiro.
  function computeResumo(){
    var bounds = periodBounds(rState);
    var prevBounds = previousPeriodBounds(rState);
    var ids = Object.keys(logins).filter(function(id){ return logins[id].papel === "gerente"; });

    var perGerente = [], allEntries = [], allEntriesPrev = [], allEntriesFull = [];
    ids.forEach(function(id){
      var raw = entriesByGerente[id] || [];
      var filtered = filterEntries(raw, bounds, "");
      var t = computeTotals(filtered, raw);
      perGerente.push({
        id: id, nome: (logins[id] || {}).nome || id,
        visitas: t.visitas, treinamentos: t.treinamentos, propostas: t.propostas, vendas: t.vendas,
        vgvPropostas: t.vgvPropostas, vgv: t.vgv, volume: t.visitas + t.treinamentos
      });
      allEntries = allEntries.concat(filtered);
      allEntriesPrev = allEntriesPrev.concat(filterEntries(raw, prevBounds, ""));
      allEntriesFull = allEntriesFull.concat(raw);
    });

    var totals = computeTotals(allEntries, allEntriesFull);
    var totalsPrev = computeTotals(allEntriesPrev, allEntriesFull);
    // produto destaque: o que mais VENDEU (VGV) no período; se ninguém vendeu,
    // cai pro que teve mais atividade (e o texto diz qual critério usou).
    var vgvPorProduto = {};
    allEntries.forEach(function(e){
      if (e.tipo !== "Venda - Venda") return;
      var k = e.estoque || "Sem estoque/lançamento";
      vgvPorProduto[k] = (vgvPorProduto[k] || 0) + ((typeof e.vgv === "number" && !isNaN(e.vgv)) ? e.vgv : 0);
    });
    var produtoRank;
    var rankVgv = Object.keys(vgvPorProduto).map(function(k){ return { label: k, value: vgvPorProduto[k], criterio: "vgv" }; })
      .filter(function(x){ return x.value > 0; }).sort(function(a,b){ return b.value - a.value; });
    if (rankVgv.length) produtoRank = rankVgv;
    else produtoRank = estoqueCounts(allEntries).map(function(x){ return { label: x.label, value: x.value, criterio: "atividades" }; });
    var vendedores = perGerente.map(function(g){ return g; }).filter(function(g){ return g.vgv > 0; }).sort(function(a,b){ return b.vgv - a.vgv; });

    var n = perGerente.length || 1;
    var media = { volume: 0 };
    PILARES_ORDEM.forEach(function(p){
      media[p] = perGerente.reduce(function(s, g){ return s + g[p]; }, 0) / n;
    });
    media.volume = perGerente.reduce(function(s, g){ return s + g.volume; }, 0) / n;

    // campeões — só conta se tiver pelo menos 1 registro naquele pilar
    function campeao(pilar){
      var ranked = perGerente.filter(function(g){ return g[pilar] > 0; })
        .sort(function(a,b){ return b[pilar] - a[pilar]; });
      return ranked[0] || null;
    }
    var campeaoVisitas = campeao("visitas");
    var campeaoTreino = campeao("treinamentos");

    // alertas — no máx. 1 por gerente, pra não virar lista de reclamação
    var alertas = [];
    perGerente.forEach(function(g){
      // regra 1: muita atividade (visita+treinamento) mas zero proposta
      if (media.volume > 0 && g.volume > media.volume && g.propostas === 0){
        alertas.push({ gerente: g.nome, texto: "Tem muita atividade (visitas e treinamentos), mas " + PILAR_ALERTA_TXT.propostas.zero + " no período." });
        return;
      }
      // regra 2: pilar zerado enquanto outro pilar dele está acima da média do time
      for (var i = 0; i < PILARES_ORDEM.length; i++){
        var p = PILARES_ORDEM[i];
        if (g[p] > 0) continue;
        if (media[p] === 0) continue; // ninguém do time teve esse pilar — não é uma falha específica desse gerente
        var melhorOutro = null;
        for (var j = 0; j < PILARES_ORDEM.length; j++){
          var q = PILARES_ORDEM[j];
          if (q === p) continue;
          if (media[q] > 0 && g[q] > media[q]){
            if (!melhorOutro || g[q] > melhorOutro.valor) melhorOutro = { key: q, valor: g[q] };
          }
        }
        if (melhorOutro){
          alertas.push({ gerente: g.nome, texto: "Tem " + PILAR_ALERTA_TXT[melhorOutro.key].alto + ", mas " + PILAR_ALERTA_TXT[p].zero + "." });
          break;
        }
      }
    });

    return {
      bounds: bounds, totals: totals, totalsPrev: totalsPrev,
      produtoDestaque: produtoRank[0] || null,
      campeaoVisitas: campeaoVisitas, campeaoTreino: campeaoTreino,
      alertas: alertas, temGerentes: ids.length > 0,
      campeaoVgv: vendedores[0] || null
    };
  }

  function destaqueTileHTML(valueText, label, subText, emptyMsg){
    var n = (valueText == null) ? '<div class="n n-empty">' + renderEscaped(emptyMsg || "Sem dados") + '</div>' : '<div class="n">' + renderEscaped(valueText) + '</div>';
    return '<div class="stat destaque">' + n + '<div class="l">' + renderEscaped(label) + '</div>' + (subText ? '<div class="sub">' + renderEscaped(subText) + '</div>' : '') + '</div>';
  }

  function buildResumoText(r){
    var b = r.bounds;
    var linhas = [];
    linhas.push("Resumo do período (" + fmtRange(b) + ")");
    linhas.push("");
    linhas.push("VGV vendido: " + fmtBRL(r.totals.vgv) + " em " + r.totals.vendas + (r.totals.vendas === 1 ? " venda" : " vendas") + deltaTextoSimples_(r.totals.vgv, r.totalsPrev.vgv));
    if (r.totals.vendas) linhas.push("Ticket médio: " + fmtBRL(r.totals.vgv / r.totals.vendas));
    if (r.campeaoVgv) linhas.push("Quem mais vendeu: " + r.campeaoVgv.nome + " (" + fmtBRL(r.campeaoVgv.vgv) + ")");
    linhas.push("Produto destaque: " + (r.produtoDestaque ? r.produtoDestaque.label + (r.produtoDestaque.criterio === "vgv" ? " (" + fmtBRL(r.produtoDestaque.value) + " vendidos)" : " (" + r.produtoDestaque.value + " atividades, sem venda no período)") : "sem registros no período"));
    linhas.push("Atividade: " + r.totals.visitas + " visitas · " + r.totals.treinamentos + " treinamentos");
    linhas.push("Campeão de visitas: " + (r.campeaoVisitas ? r.campeaoVisitas.nome + " (" + r.campeaoVisitas.visitas + " visitas)" : "nenhuma visita registrada"));
    linhas.push("Mais treinamento: " + (r.campeaoTreino ? r.campeaoTreino.nome + " (" + r.campeaoTreino.treinamentos + " treinamentos)" : "nenhum treinamento registrado"));
    linhas.push("Propostas no período: " + r.totals.propostas + " (" + fmtBRL(r.totals.vgvPropostas) + " ainda em aberto)" + deltaTextoSimples_(r.totals.propostas, r.totalsPrev.propostas));
    linhas.push("");
    if (r.alertas.length){
      linhas.push("Alertas:");
      r.alertas.forEach(function(a){ linhas.push("- " + a.gerente + ": " + a.texto); });
    } else {
      linhas.push("Alertas: nenhum — time equilibrado nos 4 pilares no período.");
    }
    return linhas.join("\n");
  }
  // versão em texto puro do deltaBadge (sem HTML), pra entrar no bloco de copiar
  function deltaTextoSimples_(curr, prev){
    if (!prev && !curr) return "";
    if (!prev) return " (novo no período)";
    var pct = Math.round(((curr - prev) / prev) * 100);
    if (pct === 0) return " (estável vs. período anterior)";
    return " (" + (pct > 0 ? "▲" : "▼") + " " + Math.abs(pct) + "% vs. período anterior)";
  }

  function renderResumoExecutivo(){
    if (!me || me.papel !== "diretor") return;
    var r = computeResumo();
    $("r-destaques-title").textContent = "Destaques — " + periodLabel(rState);

    $("r-destaques").innerHTML =
      destaqueTileHTML(fmtBRL(r.totals.vgv), "VGV vendido", r.totals.vendas + (r.totals.vendas === 1 ? " venda" : " vendas") + (r.totals.vendas ? " · ticket " + fmtBRLCurto_(r.totals.vgv / r.totals.vendas) : "") + deltaTextoSimples_(r.totals.vgv, r.totalsPrev.vgv)) +
      destaqueTileHTML(r.campeaoVgv ? r.campeaoVgv.nome : null, "Quem mais vendeu", r.campeaoVgv ? fmtBRL(r.campeaoVgv.vgv) : "", "Nenhuma venda no período") +
      destaqueTileHTML(r.produtoDestaque ? r.produtoDestaque.label : null, "Produto destaque", r.produtoDestaque ? (r.produtoDestaque.criterio === "vgv" ? fmtBRL(r.produtoDestaque.value) + " vendidos" : r.produtoDestaque.value + " atividades (sem venda)") : "", "Sem registros no período") +
      destaqueTileHTML(r.campeaoVisitas ? r.campeaoVisitas.nome : null, "Campeão de visitas", r.campeaoVisitas ? r.campeaoVisitas.visitas + " visitas" : "", "Nenhuma visita registrada") +
      destaqueTileHTML(r.campeaoTreino ? r.campeaoTreino.nome : null, "Mais treinamento", r.campeaoTreino ? r.campeaoTreino.treinamentos + " treinamentos" : "", "Nenhum treinamento registrado") +
      destaqueTileHTML(String(r.totals.propostas), "Propostas no período", fmtBRL(r.totals.vgvPropostas) + " ainda em aberto" + deltaTextoSimples_(r.totals.propostas, r.totalsPrev.propostas));

    if (!r.temGerentes){
      $("r-alertas").innerHTML = '<p class="empty">Ainda não há gerentes cadastrados.</p>';
    } else if (r.alertas.length){
      $("r-alertas").innerHTML = r.alertas.map(function(a){
        return '<div class="alert-row"><strong>' + renderEscaped(a.gerente) + '</strong> — ' + renderEscaped(a.texto) + '</div>';
      }).join("");
    } else {
      $("r-alertas").innerHTML = '<div class="alert-row ok">Nenhum alerta neste período — time equilibrado nos 4 pilares.</div>';
    }

    $("r-text-preview").textContent = buildResumoText(r);
  }

  function wirePeriodPills(containerId, customRangeId, state, onChange){
    var group = $(containerId);
    group.querySelectorAll(".pill-btn").forEach(function(btn){
      btn.addEventListener("click", function(){
        group.querySelectorAll(".pill-btn").forEach(function(b){ b.setAttribute("aria-pressed", b === btn ? "true" : "false"); });
        state.periodo = btn.dataset.period;
        $(customRangeId).classList.toggle("show", state.periodo === "custom");
        onChange();
      });
    });
  }
  function wireCustomRange(startId, endId, state, onChange){
    $(startId).addEventListener("change", function(){ state.start = $(startId).value; onChange(); });
    $(endId).addEventListener("change", function(){ state.end = $(endId).value; onChange(); });
  }

  // ---------- aba "Individual" (visão do Diretor) ----------
  // Mesmas 4 séries do computeTotals(), pra reusar renderGroupedBarChart() no
  // gráfico de tendência (em vez do trio visitas/treinamento/venda do gráfico
  // "por gerente" da Visão geral).
  var WEEKLY_SERIES = [
    { key: "visitas", name: "Visitas", color: "var(--viz-cat-1)" },
    { key: "treinamentos", name: "Treinamentos", color: "var(--viz-cat-2)" },
    { key: "propostas", name: "Propostas", color: "var(--viz-cat-3)" },
    { key: "vendas", name: "Vendas", color: "var(--viz-cat-4)" }
  ];

  // últimas N semanas fechadas, terminando na semana atual — sempre a mesma
  // janela, independente do período escolhido nos filtros da aba (pensado pra
  // responder "ele está melhorando, piorando ou estável", não "no período X").
  function lastNWeeksBuckets(n){
    var atual = weekBounds();
    var buckets = [];
    for (var i = n - 1; i >= 0; i--){
      var ref = new Date(atual.start.getFullYear(), atual.start.getMonth(), atual.start.getDate() - i * 7);
      buckets.push(weekBounds(ref));
    }
    return buckets;
  }

  // "1.5" -> "1,5" ; "2.0" -> "2" — pra mostrar a média do time sem zero
  // decorativo nem notação estranha.
  function fmtMedia_(n){
    var r = Math.round((n || 0) * 10) / 10;
    return Number.isInteger(r) ? String(r) : r.toFixed(1).replace(".", ",");
  }
  function statTileComMedia(n, l, mediaTxt){
    return '<div class="stat"><div class="n">' + renderEscaped(String(n)) + '</div><div class="l">' + renderEscaped(l) + '</div>' +
      '<div class="sub">Média do time: ' + renderEscaped(mediaTxt) + '</div></div>';
  }
  // Treinamento e Visita não têm conversão entre si (não existe "converter"
  // um treinamento numa visita) — por isso ficam lado a lado sem % entre
  // eles. A conversão de verdade é Visita → Proposta → Venda.
  function renderFunilHTML(treinamentos, visitas, propostas, vendas, sel){
    var pct1 = visitas > 0 ? Math.round((propostas / visitas) * 100) : null;
    var pct2 = propostas > 0 ? Math.round((vendas / propostas) * 100) : null;
    function pctCell(pct){
      return '<div class="funil-pct">' + (pct == null ? "—" : pct + "%") + '<span class="fp-label">conversão</span></div>';
    }
    function stage(html){ return '<div class="funil-stage">' + html + '</div>'; }
    return '<div class="funil-row">' +
      stage(statTile(treinamentos, "Treinamentos")) +
      stage(statTile(visitas, "Visitas")) +
      pctCell(pct1) +
      stage(statTile(propostas, "Propostas", null, null, "propostas", sel === "propostas")) +
      pctCell(pct2) +
      stage(statTile(vendas, "Vendas", null, null, "vendas", sel === "vendas")) +
      '</div>';
  }

  // clique/Enter/Espaço em "Propostas" ou "Vendas" dentro do funil da aba
  // Individual: abre embaixo a lista dos registros daquele pilar no período
  // selecionado (clicar de novo no mesmo card fecha a lista).
  function wireFunilTiles(){
    var container = $("i-funil");
    if (!container) return;
    function toggle(key){
      if (key !== "propostas" && key !== "vendas") return;
      iState.funilSel = (iState.funilSel === key) ? null : key;
      renderIndividualGerente();
    }
    container.addEventListener("click", function(ev){
      var tile = ev.target.closest ? ev.target.closest(".stat[data-pilar]") : null;
      if (!tile || !container.contains(tile)) return;
      toggle(tile.getAttribute("data-pilar"));
    });
    container.addEventListener("keydown", function(ev){
      if (ev.key !== "Enter" && ev.key !== " " && ev.key !== "Spacebar") return;
      var tile = ev.target.closest ? ev.target.closest(".stat[data-pilar]") : null;
      if (!tile || !container.contains(tile)) return;
      ev.preventDefault();
      toggle(tile.getAttribute("data-pilar"));
    });
  }

  function renderFunilLista_(filtered){
    var el = $("i-funil-lista");
    if (!el) return;
    if (!iState.funilSel){ el.innerHTML = ""; return; }
    var tipoAlvo = iState.funilSel === "propostas" ? "Venda - Proposta" : "Venda - Venda";
    var lista = filtered.filter(function(e){ return e.tipo === tipoAlvo; })
      .sort(function(a,b){ return (b.criadoEm||"").localeCompare(a.criadoEm||""); });
    if (!lista.length){
      el.innerHTML = '<p class="empty">Nenhum registro de ' + (iState.funilSel === "propostas" ? "proposta" : "venda") + ' nesse período.</p>';
      return;
    }
    el.innerHTML = '<div class="funil-lista-titulo">' + (iState.funilSel === "propostas" ? "Propostas" : "Vendas") + ' no período</div>' +
      lista.map(function(e){ return logRowHTML(e); }).join("");
  }

  function populateIndividualGerenteSelect(){
    var sel = $("i-gerente");
    if (!sel) return;
    var ids = Object.keys(logins).filter(function(id){ return logins[id].papel === "gerente"; })
      .sort(function(a,b){ return (logins[a].nome||"").localeCompare(logins[b].nome||""); });
    var current = iState.gerenteId || sel.value;
    sel.innerHTML = "";
    ids.forEach(function(id){
      var opt = document.createElement("option");
      opt.value = id; opt.textContent = logins[id].nome || id;
      sel.appendChild(opt);
    });
    if (ids.indexOf(current) !== -1) sel.value = current;
    else if (ids.length) sel.value = ids[0];
    iState.gerenteId = sel.value || "";
  }

  // Tudo calculado na hora a partir de entriesByGerente/allCorretoresRaw — nada
  // digitado à mão. A "média do time" usa sempre o mesmo período escolhido nos
  // filtros desta aba, calculada sobre todos os gerentes (não só o selecionado).
  function renderIndividualGerente(){
    if (!me || me.papel !== "diretor") return;
    var ids = Object.keys(logins).filter(function(id){ return logins[id].papel === "gerente"; });
    $("i-empty").hidden = ids.length > 0;
    $("i-filtros-card").hidden = ids.length === 0;
    if (!ids.length) return;

    if (!iState.gerenteId || ids.indexOf(iState.gerenteId) === -1) iState.gerenteId = ids[0];
    if ($("i-gerente") && $("i-gerente").value !== iState.gerenteId) $("i-gerente").value = iState.gerenteId;
    var nome = (logins[iState.gerenteId] || {}).nome || iState.gerenteId;

    var bounds = periodBounds(iState);
    var prevBounds = previousPeriodBounds(iState);
    var entries = entriesByGerente[iState.gerenteId] || [];
    var filtered = filterEntries(entries, bounds, "");
    var filteredPrev = filterEntries(entries, prevBounds, "");
    var t = computeTotals(filtered, entries);
    var tPrev = computeTotals(filteredPrev, entries);

    var perGerenteT = ids.map(function(id){ var raw = entriesByGerente[id] || []; return computeTotals(filterEntries(raw, bounds, ""), raw); });
    var n = perGerenteT.length || 1;
    var media = {};
    PILARES_ORDEM.forEach(function(p){
      media[p] = perGerenteT.reduce(function(s, g){ return s + g[p]; }, 0) / n;
    });

    $("i-vgv-title").textContent = "VGV no período — " + nome;
    var ticket = t.vendas ? (t.vgv / t.vendas) : 0;
    $("i-vgv-hero").innerHTML = heroKpi(
      fmtBRL(t.vgv),
      deltaBadge(t.vgv, tPrev.vgv),
      heroMini(t.vendas, "Vendas") + heroMini(fmtBRL(ticket), "Ticket médio") + heroMini(fmtBRL(t.vgvPropostas), "Potencial em propostas abertas")
    );

    if ($("i-meta-vgv")) $("i-meta-vgv").innerHTML = metaBarraHTML(vgvDoMes_(entries), metaVgvGerente_(), "Meta de VGV do mês — " + nome);
    if ($("i-week")){
      var wbI = weekBounds();
      $("i-week").innerHTML = '<p class="hint" style="margin-bottom:8px">Semana de ' + fmtRange(wbI) + '</p>' + weekRowsHTML(computeWeek(entries, wbI), metas);
    }

    $("i-kpi-title").textContent = "Totais de " + nome + " — " + periodLabel(iState);
    $("i-kpi").innerHTML =
      statTileComMedia(t.visitas, "Visitas", fmtMedia_(media.visitas)) +
      statTileComMedia(t.treinamentos, "Treinamentos", fmtMedia_(media.treinamentos)) +
      statTileComMedia(t.propostas, "Propostas", fmtMedia_(media.propostas)) +
      statTileComMedia(t.vendas, "Vendas", fmtMedia_(media.vendas));

    var trendItems = lastNWeeksBuckets(8).map(function(b){
      var te = computeTotals(filterEntries(entries, b, ""));
      return { label: fmtRange(b), visitas: te.visitas, treinamentos: te.treinamentos, propostas: te.propostas, vendas: te.vendas };
    });
    renderGroupedBarChart($("i-trend-chart"), trendItems, WEEKLY_SERIES, "Tendência das últimas 8 semanas — " + nome);

    $("i-funil").innerHTML = renderFunilHTML(t.treinamentos, t.visitas, t.propostas, t.vendas, iState.funilSel);
    renderFunilLista_(filtered);

    var corretoresDele = allCorretoresRaw.filter(function(c){ return c.gerenteId === iState.gerenteId; });
    $("i-corretores-resumo").innerHTML =
      statTile(corretoresDele.length, "Corretores dele");
  }

  // ---------- aba "Produtos" (visão do Diretor) ----------
  // Mesma ideia da aba Resumo (time inteiro, sem filtro de gerente), só que
  // agrupado por produto/lançamento em vez de por gerente — pensado pra
  // substituir o relatório "produto × 4 pilares" que era preenchido à mão.
  var pState = { periodo: "semana", start: null, end: null };

  function computeProdutos(){
    var bounds = periodBounds(pState);
    var ids = Object.keys(logins).filter(function(id){ return logins[id].papel === "gerente"; });
    var allEntries = [], fullEntries = [];
    ids.forEach(function(id){
      allEntries = allEntries.concat(filterEntries(entriesByGerente[id] || [], bounds, ""));
      fullEntries = fullEntries.concat(entriesByGerente[id] || []);
    });
    var convertidas = {};
    fullEntries.forEach(function(e){ if (e.tipo === "Venda - Venda" && e.convertidaDeProposta) convertidas[e.convertidaDeProposta] = true; });

    var porProduto = {};
    function bucket(nome){
      if (!porProduto[nome]) porProduto[nome] = { visitas: 0, treinamentos: 0, propostas: 0, vendas: 0, vgv: 0, vgvAberto: 0 };
      return porProduto[nome];
    }
    // garante que todo produto cadastrado apareça, mesmo zerado — igual ao
    // papel, onde "Uapé = 0 0 0 0" também é uma informação (ninguém foi lá).
    // "Outro" fica de fora da lista fixa: só aparece se tiver registro de
    // verdade, pra não virar uma linha de zero permanente e sem sentido.
    (CONFIG.estoques || []).forEach(function(nome){ if (!ESTOQUE_SO_SE_TIVER[nome]) bucket(nome); });

    allEntries.forEach(function(e){
      var nome = e.estoque || "Sem estoque/lançamento";
      var b = bucket(nome);
      if (TIPOS_PILAR(e.tipo) === "Visitas") b.visitas++;
      else if (TIPOS_PILAR(e.tipo) === "Treinamento") b.treinamentos++;
      else if (e.tipo === "Venda - Proposta"){
        b.propostas++;
        if (!(e.criadoEm && convertidas[e.criadoEm]) && e.status !== "Perdida") b.vgvAberto += (typeof e.vgv === "number" && !isNaN(e.vgv)) ? e.vgv : 0;
      }
      else if (e.tipo === "Venda - Venda"){
        b.vendas++;
        b.vgv += (typeof e.vgv === "number" && !isNaN(e.vgv)) ? e.vgv : 0;
      }
    });

    // ordem: segue a ordem do config.json primeiro (é a ordem que o time já
    // conhece); o que não está lá (ex.: "Sem estoque/lançamento") vai depois,
    // ordenado por volume total, maior primeiro.
    var ordemConfig = (CONFIG.estoques || []).filter(function(n){ return !ESTOQUE_SO_SE_TIVER[n]; });
    function totalDe(n){ var b = porProduto[n]; return b.visitas + b.treinamentos + b.propostas + b.vendas; }
    var nomes = Object.keys(porProduto).sort(function(a, b){
      var ia = ordemConfig.indexOf(a), ib = ordemConfig.indexOf(b);
      if (ia !== -1 || ib !== -1) return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
      return totalDe(b) - totalDe(a);
    });

    var total = { visitas: 0, treinamentos: 0, propostas: 0, vendas: 0, vgv: 0, vgvAberto: 0 };
    nomes.forEach(function(n){
      var b = porProduto[n];
      total.visitas += b.visitas; total.treinamentos += b.treinamentos;
      total.propostas += b.propostas; total.vendas += b.vendas;
      total.vgv += b.vgv; total.vgvAberto += b.vgvAberto;
    });

    return { bounds: bounds, nomes: nomes, porProduto: porProduto, total: total, temGerentes: ids.length > 0 };
  }

  function renderProdutosTable(){
    if (!me || me.papel !== "diretor") return;
    var r = computeProdutos();
    $("p-empty").hidden = r.temGerentes;
    $("p-table-title").textContent = "Ações por produto — " + periodLabel(pState);

    function cell(n){ return '<td class="' + (n ? "" : "zero") + '">' + n + '</td>'; }
    function cellBRL(n){ return '<td class="' + (n ? "" : "zero") + '">' + (n ? fmtBRLCurto_(n) : "—") + '</td>'; }
    function cellPct(num, den){ return '<td class="' + (den ? "" : "zero") + '">' + (den ? Math.round(num / den * 100) + "%" : "—") + '</td>'; }
    function linha(nome, b, cls){
      var parado = !cls && (b.visitas + b.treinamentos + b.propostas + b.vendas) === 0;
      return '<tr' + (cls ? ' class="' + cls + '"' : (parado ? ' class="is-parado"' : '')) + '><td class="produto-nome">' + renderEscaped(nome) + (parado ? ' <span class="tag-parado">parado</span>' : '') + '</td>' +
        cell(b.visitas) + cell(b.treinamentos) + cell(b.propostas) + cell(b.vendas) +
        cellBRL(b.vgv) + cellBRL(b.vgvAberto) + cellPct(b.propostas, b.visitas) + '</tr>';
    }
    var rows = r.nomes.map(function(nome){ return linha(nome, r.porProduto[nome]); }).join("");
    var totalRow = linha("Total", r.total, "is-total");
    var wrap = $("p-table");
    wrap.innerHTML = r.nomes.length ?
      '<table class="prod-table"><thead><tr><th>Produto</th><th>Visitas</th><th>Treinamentos</th><th>Propostas</th><th>Vendas</th><th>VGV vendido</th><th>Em aberto</th><th>Visita → proposta</th></tr></thead>' +
      '<tbody>' + rows + totalRow + '</tbody></table>' :
      '<p class="empty">Sem produtos cadastrados em data/config.json.</p>';
    // sombra de "tem mais pra esse lado" só quando a tabela não cabe inteira
    // na largura da tela (típico no celular) — recalcula depois do innerHTML
    // acima já ter aplicado layout.
    requestAnimationFrame(function(){
      wrap.classList.toggle("has-overflow", wrap.scrollWidth > wrap.clientWidth + 1);
    });
  }

  // ---------- "Exportar imagem" — funciona em qualquer aba aberta (gerente ou diretor) ----------
  function slugArquivo_(s){
    var r = String(s || "").toLowerCase()
      .normalize("NFD").replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-").replace(/(^-+|-+$)/g, "");
    return r || "painel";
  }
  // acha a <section> visível de dentro de quem estiver logado agora (gerente ou
  // diretor) e o nome da aba selecionada — exporta sempre "o que está na tela",
  // não um card fixo, porque o usuário pode estar em qualquer uma das abas.
  function abaAtivaParaExportar_(){
    var view = null;
    if (!$("view-diretor").hidden) view = $("view-diretor");
    else if (!$("view-gerente").hidden) view = $("view-gerente");
    if (!view) return null;
    var secoes = view.querySelectorAll(":scope > section");
    var ativa = null;
    secoes.forEach(function(sec){ if (!sec.hidden) ativa = sec; });
    if (!ativa) return null;
    var label = "painel";
    var tabAtiva = view.querySelector('.tabs .tab[aria-selected="true"]');
    if (tabAtiva && tabAtiva.textContent) label = tabAtiva.textContent.trim();
    return { section: ativa, label: label };
  }
  function exportarAbaComoImagem(){
    var btn = $("export-img-btn");
    if (typeof html2canvas !== "function"){
      toast("Não foi possível carregar a ferramenta de exportação. Verifique sua conexão e tente de novo.");
      return;
    }
    var alvo = abaAtivaParaExportar_();
    if (!alvo){ toast("Não foi possível identificar o que exportar."); return; }
    var textoOriginal = btn.textContent;
    btn.disabled = true; btn.textContent = "Gerando…";
    var bg = getComputedStyle(document.body).backgroundColor || "#f7f4f0";
    function restaurarBotao(){ btn.disabled = false; btn.textContent = textoOriginal; }
    html2canvas(alvo.section, { backgroundColor: bg, scale: 2, useCORS: true }).then(function(canvas){
      canvas.toBlob(function(blob){
        if (!blob){ toast("Não foi possível gerar a imagem."); restaurarBotao(); return; }
        var url = URL.createObjectURL(blob);
        var a = document.createElement("a");
        a.href = url;
        a.download = "painel-parcerias-" + slugArquivo_(alvo.label) + "-" + todayISO() + ".png";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function(){ URL.revokeObjectURL(url); }, 4000);
        restaurarBotao();
      }, "image/png");
    }).catch(function(){
      toast("Não foi possível gerar a imagem. Tente de novo.");
      restaurarBotao();
    });
  }

  function slugify(nome){
    var s = String(nome || "").toLowerCase()
      .normalize("NFD").replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-").replace(/(^-+|-+$)/g, "");
    return s || "gerente";
  }
  function uniqueId(base){
    var id = base, n = 2;
    while (logins[id]) { id = base + "-" + n; n++; }
    return id;
  }

  function resetTabs(container){
    var group = container.querySelector(".tabs");
    if (!group) return;
    var tabs = group.querySelectorAll(".tab");
    tabs.forEach(function(t, i){ t.setAttribute("aria-selected", i === 0 ? "true" : "false"); });
    container.querySelectorAll(":scope > section").forEach(function(sec, i){ sec.hidden = i !== 0; });
  }

  // ---------- config (data/config.json) ----------
  function loadConfig(){
    return fetch("data/config.json").then(function(res){
      if (!res.ok) throw new Error("config fetch failed: " + res.status);
      return res.json();
    }).then(function(json){
      return {
        estoques: (Array.isArray(json.estoques) && json.estoques.length) ? json.estoques : DEFAULT_CONFIG.estoques,
        metasDefault: (json.metasDefault && typeof json.metasDefault === "object") ? json.metasDefault : DEFAULT_CONFIG.metasDefault,
        metaVgvMensal: Number(json.metaVgvMensal) || 3000000
      };
    }).catch(function(){
      // most likely opened as a file:// URL (fetch of local files is blocked
      // by the browser there) — GitHub Pages serves this fine. Either way,
      // fall back to the built-in defaults so the app still works.
      return DEFAULT_CONFIG;
    });
  }
  function populateEstoqueSelects(list){
    [$("f-estoque"), $("d-estoque-filter")].forEach(function(sel){
      if (!sel) return;
      var keepFirst = sel.querySelector("option"); // "Escolha…" / "Todos"
      sel.innerHTML = "";
      if (keepFirst) sel.appendChild(keepFirst);
      list.forEach(function(nome){
        var opt = document.createElement("option");
        opt.textContent = nome;
        sel.appendChild(opt);
      });
    });
  }

  // ---------- boot ----------
  function boot(){
    Promise.all([
      Promise.race([
        Promise.resolve(window.PainelDB.create()),
        new Promise(function(res){ setTimeout(function(){ res(null); }, 11000); })
      ]),
      loadConfig()
    ]).then(function(results){
      var res = results[0];
      CONFIG = results[1];
      METAS_DEFAULT = CONFIG.metasDefault;
      if (!res){ hide($("boot")); show($("noaccess")); return; }
      db = res;
      populateEstoqueSelects(CONFIG.estoques);
      me = tryRestoreSession();
      if (me && db.auth) db.auth.setSession(me.sess);
      window.PainelDB.onAuthError = function(){
        if (!me) return;
        toast("Sua sessão expirou ou a senha foi trocada. Entre de novo.");
        fazerLogout_();
      };
      hide($("boot")); show($("app"));
      wireTabs();
      wireStaticHandlers();
      watchLogins();
    }).catch(function(){
      hide($("boot")); show($("noaccess"));
    });
  }

  // ---------- sessão lembrada no navegador ----------
  // Fica no localStorage por 30 dias, renovados a cada visita. Guarda a
  // SESSÃO que o servidor (Code.gs v2) entregou no login — nunca a senha. O
  // gerente só faz login de novo se clicar em "Sair", se ficar 30 dias sem
  // abrir, ou se o Diretor trocar a senha dele (o servidor derruba a sessão).
  var SESSAO_KEY = "painel-me";
  var SESSAO_DIAS = 30;
  function salvarSessao_(m){
    var dado = { id: m.id, nome: m.nome, papel: m.papel, sess: m.sess,
      expira: Date.now() + SESSAO_DIAS * 86400000 };
    try { localStorage.setItem(SESSAO_KEY, JSON.stringify(dado)); } catch(e){}
    return dado;
  }
  function apagarSessao_(){
    try { localStorage.removeItem(SESSAO_KEY); } catch(e){}
    try { sessionStorage.removeItem(SESSAO_KEY); } catch(e){}
  }
  function tryRestoreSession(){
    try {
      var raw = localStorage.getItem(SESSAO_KEY) || sessionStorage.getItem(SESSAO_KEY);
      if (!raw) return null;
      var m = JSON.parse(raw);
      if (!m || !m.id || !m.sess || (m.expira && m.expira < Date.now())){ apagarSessao_(); return null; }
      return salvarSessao_(m); // renova os 30 dias e migra quem vinha do sessionStorage
    } catch(e){}
    return null;
  }

  function wireTabs(){
    document.querySelectorAll(".tabs").forEach(function(group){
      var tabs = group.querySelectorAll(".tab");
      tabs.forEach(function(tab){
        tab.addEventListener("click", function(){
          tabs.forEach(function(t){ t.setAttribute("aria-selected", t === tab ? "true" : "false"); });
          var parent = group.parentElement;
          parent.querySelectorAll(":scope > section").forEach(function(sec){
            sec.hidden = sec.id !== tab.dataset.tab;
          });
          // a aba "Produtos" mede a largura da tabela pra decidir se mostra a
          // sombra de "arrasta pro lado" — enquanto a aba está escondida
          // (hidden), scrollWidth/clientWidth dão os dois 0, então a medição
          // de quando ela foi renderizada (ainda escondida) não vale nada;
          // refaz agora que a aba realmente ficou visível.
          if (tab.dataset.tab === "d-produtos" && typeof renderProdutosTable === "function") renderProdutosTable();
          if (["d-propostas", "d-parceiros", "d-agenda", "d-mercado"].indexOf(tab.dataset.tab) !== -1) renderAbasNovas_();
        });
      });
    });
  }

  // ---------- login / setup ----------
  function watchLogins(){
    db.collection("login").onSnapshot(function(snap){
      logins = {};
      snap.docs.forEach(function(d){ logins[d.id] = d.data() || {}; });
      var ids = Object.keys(logins);

      if (!ids.length){
        me = null; enteredAs = null;
        apagarSessao_();
        hide($("view-login")); hide($("view-gerente")); hide($("view-diretor"));
        $("role-badge").hidden = true; $("logout-btn").hidden = true; $("export-img-btn").hidden = true;
        show($("view-setup"));
        return;
      }

      if (me && (!logins[me.id] || logins[me.id].papel !== me.papel)){
        me = null;
        apagarSessao_();
        if (db.auth) db.auth.setSession(null);
      }

      if (!me){
        enteredAs = null;
        hide($("view-setup")); hide($("view-gerente")); hide($("view-diretor"));
        $("role-badge").hidden = true; $("logout-btn").hidden = true; $("export-img-btn").hidden = true;
        populateLoginSelect();
        show($("view-login"));
        return;
      }

      hide($("view-setup")); hide($("view-login"));
      $("role-badge").hidden = false; $("logout-btn").hidden = false; $("export-img-btn").hidden = false;

      if (me.id !== enteredAs){
        enteredAs = me.id;
        enterApp();
      }

      if (me.papel === "diretor"){
        syncGerenteEntrySubscriptions();
        renderGerentesList();
        populateCorretoresFiltro();
        populateIndividualGerenteSelect();
        watchCorretoresAll();
      }
    }, function(){ toast("Não foi possível carregar os logins."); });
  }

  function fazerLogout_(){
    if (unsubMyEntries){ try{ unsubMyEntries(); }catch(e){} unsubMyEntries = null; }
    if (unsubMyCorretores){ try{ unsubMyCorretores(); }catch(e){} unsubMyCorretores = null; }
    if (unsubCorretoresAll){ try{ unsubCorretoresAll(); }catch(e){} unsubCorretoresAll = null; }
    Object.keys(unsubEntries).forEach(function(id){ try{ unsubEntries[id](); }catch(e){} });
    unsubEntries = {}; entriesByGerente = {};
    myCorretoresRaw = []; allCorretoresRaw = []; myEntriesRaw = [];
    me = null; enteredAs = null;
    apagarSessao_();
    if (db && db.auth) db.auth.logout();
    watchLogins_apply();
  }

  function populateLoginSelect(){
    var sel = $("login-nome");
    var current = sel.value;
    sel.innerHTML = '<option value="" disabled selected>Escolha…</option>';
    Object.keys(logins).sort(function(a,b){
      return (logins[a].nome||"").localeCompare(logins[b].nome||"");
    }).forEach(function(id){
      var opt = document.createElement("option");
      opt.value = id; opt.textContent = logins[id].nome || id;
      sel.appendChild(opt);
    });
    if (current) sel.value = current;
  }

  function wireStaticHandlers(){
    $("setup-save").addEventListener("click", function(){
      var senha = $("setup-senha").value;
      if (!senha){ toast("Digite uma senha."); return; }
      $("setup-save").disabled = true;
      db.auth.setupDiretor(senha).then(function(){
        $("setup-senha").value = "";
        $("setup-save").disabled = false;
        toast("Acesso de Diretor criado. Entre com a senha.");
      }).catch(function(){
        toast("Não foi possível criar o acesso. Tente de novo.");
        $("setup-save").disabled = false;
      });
    });

    // a senha é conferida no servidor (Code.gs v2): o site nunca recebe senhas
    $("login-btn").addEventListener("click", function(){
      var id = $("login-nome").value;
      var senha = $("login-senha").value;
      hide($("login-error"));
      if (!id || !senha){ $("login-error").textContent = "Escolha o nome e digite a senha."; show($("login-error")); return; }
      var btn = $("login-btn"); btn.disabled = true;
      db.auth.login(id, senha).then(function(r){
        btn.disabled = false;
        me = salvarSessao_({ id: r.id || id, nome: r.nome || (logins[id] || {}).nome, papel: r.papel || (logins[id] || {}).papel, sess: r.sess });
        $("login-senha").value = "";
        watchLogins_apply();
      }).catch(function(err){
        btn.disabled = false;
        $("login-error").textContent = (err && err.code === "bloqueado")
          ? "Muitas tentativas erradas. Esse login fica bloqueado por 15 minutos."
          : (err && err.code === "senha") ? "Nome ou senha incorretos." : "Não foi possível entrar agora. Tente de novo.";
        show($("login-error"));
      });
    });

    $("logout-btn").addEventListener("click", function(){ fazerLogout_(); });

    $("ng-save").addEventListener("click", function(){
      var nome = $("ng-nome").value.trim();
      var senha = $("ng-senha").value;
      if (!nome || !senha){ toast("Preencha nome e senha."); return; }
      var id = uniqueId(slugify(nome));
      $("ng-save").disabled = true;
      db.doc("login/" + id).set({ nome: nome, senha: senha, papel: "gerente" }).then(function(){
        $("ng-nome").value = ""; $("ng-senha").value = "";
        $("ng-save").disabled = false;
        toast("Gerente adicionado.");
      }).catch(function(){
        toast("Não foi possível adicionar.");
        $("ng-save").disabled = false;
      });
    });

    $("dp-save").addEventListener("click", function(){
      var val = $("dp-newpass").value;
      if (!val){ toast("Digite a nova senha."); return; }
      db.doc("login/diretor").update({ senha: val }).then(function(){
        $("dp-newpass").value = "";
        toast("Senha do Diretor atualizada.");
      }).catch(function(){ toast("Não foi possível atualizar."); });
    });

    $("gerentes-list").addEventListener("click", function(ev){
      var removeId = ev.target.getAttribute("data-remove");
      var setId = ev.target.getAttribute("data-setpass");
      if (removeId){
        db.doc("login/" + removeId).delete().then(function(){
          toast("Gerente removido.");
        }).catch(function(){ toast("Não foi possível remover."); });
      } else if (setId){
        var input = document.querySelector('[data-newpass="'+setId+'"]');
        var val = input ? input.value : "";
        if (!val){ toast("Digite a nova senha."); return; }
        db.doc("login/" + setId).update({ senha: val }).then(function(){
          toast("Senha atualizada.");
          if (input) input.value = "";
        }).catch(function(){ toast("Não foi possível atualizar a senha."); });
      }
    });

    wirePeriodPills("me-period-pills", "me-custom-range", meState, renderMeAll);
    wireCustomRange("me-start", "me-end", meState, renderMeAll);
    wirePeriodPills("d-period-pills", "d-custom-range", dState, renderDiretorDashboard);
    wireCustomRange("d-start", "d-end", dState, renderDiretorDashboard);
    $("d-estoque-filter").addEventListener("change", function(){
      dState.estoque = $("d-estoque-filter").value;
      renderDiretorDashboard();
    });

    wirePilarFilterTiles("me-totals", meState, renderMeAll);
    wirePilarFilterTiles("d-kpi", dState, renderDiretorDashboard);

    wirePeriodPills("r-period-pills", "r-custom-range", rState, renderResumoExecutivo);
    wireCustomRange("r-start", "r-end", rState, renderResumoExecutivo);

    $("i-gerente").addEventListener("change", function(){
      iState.gerenteId = $("i-gerente").value;
      renderIndividualGerente();
    });
    wirePeriodPills("i-period-pills", "i-custom-range", iState, renderIndividualGerente);
    wireCustomRange("i-start", "i-end", iState, renderIndividualGerente);
    wireFunilTiles();
    $("i-ver-corretores-btn").addEventListener("click", function(){
      dCorretoresFiltro = iState.gerenteId || "";
      var selFiltro = $("d-corretores-filtro");
      if (selFiltro) selFiltro.value = dCorretoresFiltro;
      renderDiretorCorretores();
      var tabCorretores = document.querySelector('#view-diretor > .tabs .tab[data-tab="d-corretores"]');
      if (tabCorretores) tabCorretores.click();
    });

    wirePeriodPills("p-period-pills", "p-custom-range", pState, renderProdutosTable);
    wireCustomRange("p-start", "p-end", pState, renderProdutosTable);
    $("r-copy-btn").addEventListener("click", function(){
      var texto = $("r-text-preview").textContent;
      function okToast(){ toast("Texto copiado."); }
      function fallbackCopy(){
        var ta = document.createElement("textarea");
        ta.value = texto; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.opacity = "0";
        document.body.appendChild(ta); ta.select();
        try { document.execCommand("copy"); okToast(); } catch(e){ toast("Não foi possível copiar. Selecione o texto manualmente."); }
        document.body.removeChild(ta);
      }
      if (navigator.clipboard && navigator.clipboard.writeText){
        navigator.clipboard.writeText(texto).then(okToast).catch(fallbackCopy);
      } else {
        fallbackCopy();
      }
    });

    $("export-img-btn").addEventListener("click", exportarAbaComoImagem);
    $("d-propostas").addEventListener("click", acaoRegistro_);
    $("d-log").addEventListener("click", acaoRegistro_);
  }

  // delega o clique/Enter/Espaço nos cards de total (Visitas/Treinamentos/
  // Propostas/Vendas): clicar seleciona aquele pilar como filtro dos
  // gráficos abaixo; clicar de novo no mesmo card limpa o filtro.
  function wirePilarFilterTiles(containerId, state, rerender){
    var container = $(containerId);
    function toggle(key){
      if (!key || !PILAR_FILTERS[key]) return;
      state.pilarSel = (state.pilarSel === key) ? null : key;
      rerender();
    }
    container.addEventListener("click", function(ev){
      var tile = ev.target.closest ? ev.target.closest(".stat[data-pilar]") : null;
      if (!tile || !container.contains(tile)) return;
      toggle(tile.getAttribute("data-pilar"));
    });
    container.addEventListener("keydown", function(ev){
      if (ev.key !== "Enter" && ev.key !== " " && ev.key !== "Spacebar") return;
      var tile = ev.target.closest ? ev.target.closest(".stat[data-pilar]") : null;
      if (!tile || !container.contains(tile)) return;
      ev.preventDefault();
      toggle(tile.getAttribute("data-pilar"));
    });
  }

  // re-runs the same branching logic as the onSnapshot handler, using the last-known `logins`
  function watchLogins_apply(){
    var ids = Object.keys(logins);
    if (!ids.length){
      hide($("view-login")); hide($("view-gerente")); hide($("view-diretor"));
      $("role-badge").hidden = true; $("logout-btn").hidden = true; $("export-img-btn").hidden = true;
      show($("view-setup"));
      return;
    }
    if (!me){
      enteredAs = null;
      hide($("view-setup")); hide($("view-gerente")); hide($("view-diretor"));
      $("role-badge").hidden = true; $("logout-btn").hidden = true; $("export-img-btn").hidden = true;
      populateLoginSelect();
      show($("view-login"));
      return;
    }
    hide($("view-setup")); hide($("view-login"));
    $("role-badge").hidden = false; $("logout-btn").hidden = false; $("export-img-btn").hidden = false;
    if (me.id !== enteredAs){
      enteredAs = me.id;
      enterApp();
    }
    if (me.papel === "diretor"){
      syncGerenteEntrySubscriptions();
      renderGerentesList();
      populateCorretoresFiltro();
      watchCorretoresAll();
    }
  }

  // ---------- entering a role ----------
  function initials(nome){
    var parts = (nome || "").trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return "?";
    var s = parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : "");
    return s.toUpperCase();
  }
  function enterApp(){
    if (me.papel === "diretor"){
      $("role-badge").textContent = "Diretor";
      $("hdr-sub").textContent = "Visão consolidada do time";
      $("d-side-avatar").textContent = initials(me.nome);
      $("d-side-name").textContent = me.nome;
      hide($("view-gerente")); show($("view-diretor"));
      resetTabs($("view-diretor"));
      watchMetas();
    } else {
      $("role-badge").textContent = "Gerente";
      $("hdr-sub").textContent = me.nome;
      $("g-side-avatar").textContent = initials(me.nome);
      $("g-side-name").textContent = me.nome;
      hide($("view-diretor")); show($("view-gerente"));
      resetTabs($("view-gerente"));
      enterGerenteView();
      watchMetas();
    }
  }

  // ---------- gerente view ----------
  // Propostas desse gerente que ainda não foram vinculadas a nenhuma venda —
  // usado pra popular o "isso veio de uma proposta já registrada?" na hora de
  // lançar uma Venda (ver f-conversao abaixo). `entries` deve ser a lista
  // completa (sem filtro de período), senão uma proposta de outro período
  // nem aparece como opção.
  function propostasAbertas_(entries){
    var convertidas = {};
    entries.forEach(function(e){
      if (e.tipo === "Venda - Venda" && e.convertidaDeProposta) convertidas[e.convertidaDeProposta] = true;
    });
    return entries.filter(function(e){ return e.tipo === "Venda - Proposta" && e.criadoEm && !convertidas[e.criadoEm] && e.status !== "Perdida"; })
      .sort(function(a,b){ return (b.data||"").localeCompare(a.data||""); });
  }
  function populateConversaoSelect_(){
    var sel = $("f-conversao");
    if (!sel) return;
    var current = sel.value;
    var abertas = propostasAbertas_(myEntriesRaw);
    sel.innerHTML = '<option value="">Não / proposta não estava no Painel</option>';
    abertas.forEach(function(e){
      var opt = document.createElement("option");
      opt.value = e.criadoEm;
      var un = unidadeDe_(e);
      opt.textContent = fmtDM(e.data) + " · " + (e.parceiro || "sem parceiro") + " · " + (e.estoque || "—") + (un ? " · un. " + un : "") +
        (typeof e.vgv === "number" ? " · " + fmtBRL(e.vgv) : "");
      sel.appendChild(opt);
    });
    if (abertas.some(function(e){ return e.criadoEm === current; })) sel.value = current;
  }
  function enterGerenteView(){
    $("f-data").value = todayISO();
    if (!formWired){
      formWired = true;
      $("f-tipo").addEventListener("change", function(){
        var tipo = $("f-tipo").value;
        var isRetorno = tipo === "Visitas - Retorno";
        $("f-primeira").disabled = isRetorno;
        if (isRetorno) $("f-primeira").value = "Recorrente";

        var isVenda = tipo === "Venda - Venda";
        var isProposta = tipo === "Venda - Proposta";
        var showVgv = isVenda || isProposta;
        $("f-vgv-wrap").hidden = !showVgv;
        if ($("f-unidade-wrap")) $("f-unidade-wrap").hidden = !showVgv;
        if (!showVgv && $("f-unidade")) $("f-unidade").value = "";
        if (!showVgv) $("f-vgv").value = "";
        if (isVenda) $("f-vgv-label").textContent = "VGV da venda (R$)";
        else if (isProposta) $("f-vgv-label").textContent = "VGV estimado da proposta (R$)";

        // só faz sentido vincular numa Venda — uma Proposta não "converte" nada
        if ($("f-conversao-wrap")) $("f-conversao-wrap").hidden = !isVenda;
        if (isVenda) populateConversaoSelect_();
        else if ($("f-conversao")) $("f-conversao").value = "";
      });
      $("entry-form").addEventListener("submit", function(ev){
        ev.preventDefault();
        var tipo = $("f-tipo").value;
        var needsVgv = (tipo === "Venda - Venda" || tipo === "Venda - Proposta");
        var vgvRaw = $("f-vgv").value;
        // validated by hand (not via the native `required` attribute): a required
        // field with no value makes the browser swallow the submit event entirely
        // before any of our JS runs, so the entry silently never reaches the db —
        // show it plainly instead and let the gerente fix it and try again.
        if (needsVgv && vgvRaw.trim() === ""){
          toast(tipo === "Venda - Venda" ? "Informe o VGV da venda para registrar." : "Informe o VGV estimado da proposta para registrar.");
          $("f-vgv").focus();
          return;
        }
        var unidadeRaw = $("f-unidade") ? $("f-unidade").value.trim() : "";
        if (needsVgv && !unidadeRaw){
          toast("Informe a unidade (ex.: 1207). Se for mais de uma, separe por vírgula.");
          $("f-unidade").focus();
          return;
        }
        if (!$("f-primeira").value){
          toast("Marque se o parceiro é novo (primeira vez) ou recorrente.");
          $("f-primeira").focus();
          return;
        }
        var parceiroRaw = $("f-parceiro").value.trim();
        if (ehNomeDeGerente_(parceiroRaw)){
          toast("No parceiro vai o corretor ou a imobiliária, não o nome do gerente.");
          $("f-parceiro").focus();
          return;
        }
        var btn = $("f-submit");
        btn.disabled = true;
        var obsRaw = $("f-obs").value.trim();
        var entry = {
          data: $("f-data").value,
          tipo: tipo,
          estoque: $("f-estoque").value,
          primeiraOuRecorrente: $("f-primeira").value,
          parceiro: parceiroRaw,
          observacao: obsRaw,
          criadoEm: new Date().toISOString()
        };
        if (needsVgv && unidadeRaw) entry.unidade = unidadeRaw;
        var pilarNovo = TIPOS_PILAR(tipo);
        if (pilarNovo === "Visitas" || pilarNovo === "Treinamento"){
          entry.status = (entry.data > todayISO()) ? "Agendado" : "Realizado";
          if (editando && editando.status === "Cancelado" && entry.data <= todayISO()) entry.status = "Cancelado";
        } else if (tipo === "Venda - Proposta"){
          entry.status = (editando && editando.status === "Perdida") ? "Perdida" : "Em negociação";
        }
        if (needsVgv){
          var vgvVal = parseFloat(vgvRaw);
          entry.vgv = (isNaN(vgvVal) || vgvVal < 0) ? 0 : vgvVal;
        }
        if (tipo === "Venda - Venda" && $("f-conversao") && $("f-conversao").value){
          entry.convertidaDeProposta = $("f-conversao").value;
        }
        var col = db.collection("registros/" + me.id + "/entries");
        var salvar;
        if (editando){
          var patch = {};
          ["data","tipo","estoque","primeiraOuRecorrente","parceiro","observacao","vgv","unidade","status","convertidaDeProposta"].forEach(function(k){
            patch[k] = (entry[k] === undefined) ? "" : entry[k];
          });
          salvar = col.update(editando.criadoEm, patch);
        } else {
          salvar = col.add(entry);
        }
        salvar.then(function(){
          toast(editando ? "Alteração salva." : (entry.status === "Agendado" ? "Agendado. Depois da data, confirme se aconteceu." : "Registrado."));
          sairDoModoEdicao_();
          limparForm_();
          btn.disabled = false;
        }).catch(function(){
          toast("Não foi possível salvar. Tente de novo.");
          btn.disabled = false;
        });
      });
      $("f-cancelar-edicao").addEventListener("click", function(){ sairDoModoEdicao_(); limparForm_(); });
      $("me-log").addEventListener("click", acaoRegistro_);
      $("g-pendentes").addEventListener("click", acaoRegistro_);
    }

    if (unsubMyEntries){ try{ unsubMyEntries(); }catch(e){} }
    unsubMyEntries = db.collection("registros/" + me.id + "/entries").onSnapshot(function(snap){
      myEntriesRaw = snap.docs.map(function(d){ return d.data(); });
      atualizarSugestoesParceiro_();
      renderPendentes_();
      renderMeAll();
      renderMeLog(myEntriesRaw);
      // se o form estiver aberto numa Venda, mantém a lista de propostas em
      // aberto atualizada (ex.: uma proposta nova chegou de outra sessão)
      if ($("f-tipo").value === "Venda - Venda") populateConversaoSelect_();
    }, function(){ toast("Não foi possível carregar seus registros."); });

    if (unsubMyCorretores){ try{ unsubMyCorretores(); }catch(e){} }
    unsubMyCorretores = db.collection("corretores/" + me.id).onSnapshot(function(snap){
      myCorretoresRaw = snap.docs.map(function(d){ return d.data(); });
      renderMeCorretores(myCorretoresRaw);
      renderMeAll(); // o KPI "Cadastros" nos Totais também depende disso
    }, function(){ toast("Não foi possível carregar os corretores."); });
  }

  // datalist do campo "Parceiro": os nomes que o próprio gerente já usou, um
  // por imobiliária (o jeito mais usado de escrever) — pra ele escolher em vez
  // de digitar de novo de outro jeito.
  function atualizarSugestoesParceiro_(){
    var dl = $("f-parceiro-lista");
    if (!dl) return;
    var grupos = agruparParceiros_(myEntriesRaw);
    dl.innerHTML = grupos.map(function(g){ return '<option value="' + renderEscaped(g.nome) + '"></option>'; }).join("");
  }

  function renderMeAll(){
    if (!me || me.papel !== "gerente") return;
    var bounds = periodBounds(meState);
    var filtered = filterEntries(myEntriesRaw, bounds, "");
    var prevFiltered = filterEntries(myEntriesRaw, previousPeriodBounds(meState), "");
    $("me-totals-title").textContent = "Totais — " + periodLabel(meState);
    renderMeTotals(filtered, prevFiltered, bounds);
    var meSel = meState.pilarSel;
    var chartEntries = (meSel && PILAR_FILTERS[meSel]) ? filtered.filter(PILAR_FILTERS[meSel].pred) : filtered;
    renderPilarBars($("me-pilar-chart"), pilarCounts(chartEntries));
    renderNovoRecorrenteBars($("me-novo-chart"), novoRecorrenteCounts(chartEntries));
    renderTrendChart($("me-trend-chart"), dailyCounts(chartEntries, bounds), "Atividade ao longo do período");
    if (meSel && PILAR_FILTERS[meSel]){
      show($("me-estoque-card"));
      $("me-estoque-title").textContent = PILAR_FILTERS[meSel].label + " por projeto";
      renderRankedBarChart($("me-estoque-chart"), estoqueCounts(chartEntries), PILAR_FILTERS[meSel].label + " por projeto");
    } else {
      hide($("me-estoque-card"));
    }

    var wBounds = weekBounds();
    var w = computeWeek(myEntriesRaw, wBounds);
    $("me-week").innerHTML = '<p class="hint" style="margin-bottom:8px">Semana de ' + fmtRange(wBounds) + '</p>' + weekRowsHTML(w, metas);
    if ($("me-meta-vgv")) $("me-meta-vgv").innerHTML = metaBarraHTML(vgvDoMes_(myEntriesRaw), metaVgvGerente_(), "Meta de VGV do mês");
  }

  function renderMeTotals(entries, prevEntries, bounds){
    var t = computeTotals(entries, myEntriesRaw);
    var pt = computeTotals(prevEntries || [], myEntriesRaw);
    var spark = function(pred, colorVar){ return sparklineSVG(dailyCounts(entries.filter(pred), bounds).map(function(d){ return d.value; }), colorVar); };
    var sel = meState.pilarSel;
    var cadAtual = myCorretoresRaw.filter(function(c){ return corretorInBounds_(c, bounds); }).length;
    var cadAnterior = myCorretoresRaw.filter(function(c){ return corretorInBounds_(c, previousPeriodBounds(meState)); }).length;
    var cadSpark = sparklineSVG(corretoresDailyCounts_(myCorretoresRaw, bounds).map(function(d){ return d.value; }), "var(--viz-cat-4)");
    $("me-totals").innerHTML =
      statTile(t.visitas, "Visitas", deltaBadge(t.visitas, pt.visitas), spark(PILAR_FILTERS.visitas.pred, PILAR_FILTERS.visitas.color), "visitas", sel === "visitas") +
      statTile(t.treinamentos, "Treinamentos", deltaBadge(t.treinamentos, pt.treinamentos), spark(PILAR_FILTERS.treinamentos.pred, PILAR_FILTERS.treinamentos.color), "treinamentos", sel === "treinamentos") +
      statTile(t.propostas, "Propostas", deltaBadge(t.propostas, pt.propostas), spark(PILAR_FILTERS.propostas.pred, PILAR_FILTERS.propostas.color), "propostas", sel === "propostas") +
      statTile(t.vendas, "Vendas", deltaBadge(t.vendas, pt.vendas), spark(PILAR_FILTERS.vendas.pred, PILAR_FILTERS.vendas.color), "vendas", sel === "vendas") +
      cadastroStatTileHTML(cadAtual, deltaBadge(cadAtual, cadAnterior), cadSpark);
    if ($("me-pilar-filter-note")) $("me-pilar-filter-note").innerHTML = pilarFilterNoteHTML(sel);

    var ticket = t.vendas ? (t.vgv / t.vendas) : 0;
    $("me-vgv-hero").innerHTML = heroKpi(
      fmtBRL(t.vgv),
      deltaBadge(t.vgv, pt.vgv),
      heroMini(t.vendas, "Vendas") + heroMini(fmtBRL(ticket), "Ticket médio") + heroMini(fmtBRL(t.vgvPropostas), "Potencial em propostas abertas")
    );
  }

  function renderMeLog(entries){
    var sorted = entries.slice().sort(function(a,b){ return (b.criadoEm||"").localeCompare(a.criadoEm||""); }).slice(0,40);
    if (!sorted.length){ $("me-log").innerHTML = '<p class="empty">Nenhum registro ainda.</p>'; return; }
    $("me-log").innerHTML = sorted.map(function(e){ return registroRowHTML(e, { gid: me.id, podeEditar: true, podeExcluir: true }); }).join("");
  }

  // ---------- editar / excluir / confirmar (itens 7, 8 e 21) ----------
  var editando = null; // registro sendo editado no formulário (null = registro novo)
  var MOTIVOS_PERDA = ["Preço", "Desistiu da compra", "Comprou outro imóvel", "Crédito / financiamento", "Unidade vendida a outro", "Outro"];

  function limparForm_(){
    $("f-tipo").value = ""; $("f-estoque").value = "";
    $("f-primeira").disabled = false;
    $("f-primeira").value = ""; $("f-parceiro").value = ""; $("f-obs").value = "";
    if ($("f-unidade")) $("f-unidade").value = "";
    if ($("f-unidade-wrap")) $("f-unidade-wrap").hidden = true;
    $("f-vgv-wrap").hidden = true; $("f-vgv").value = "";
    if ($("f-conversao-wrap")) $("f-conversao-wrap").hidden = true;
    if ($("f-conversao")) $("f-conversao").value = "";
    $("f-data").value = todayISO();
  }
  function sairDoModoEdicao_(){
    editando = null;
    $("f-submit").textContent = "Registrar";
    $("f-cancelar-edicao").hidden = true;
    $("form-titulo").textContent = "Registrar ação";
  }
  function entrarNoModoEdicao_(e){
    editando = e;
    limparForm_();
    $("f-data").value = e.data || todayISO();
    $("f-tipo").value = e.tipo || "";
    $("f-tipo").dispatchEvent(new Event("change"));
    $("f-estoque").value = e.estoque || "";
    $("f-primeira").value = e.primeiraOuRecorrente || "";
    $("f-parceiro").value = e.parceiro || "";
    $("f-obs").value = e.observacao || "";
    if (typeof e.vgv === "number") $("f-vgv").value = e.vgv;
    if ($("f-unidade")) $("f-unidade").value = unidadeDe_(e);
    if (e.convertidaDeProposta && $("f-conversao")){
      var opt = document.createElement("option"); opt.value = e.convertidaDeProposta; opt.textContent = "Proposta já vinculada";
      $("f-conversao").appendChild(opt); $("f-conversao").value = e.convertidaDeProposta;
    }
    $("f-submit").textContent = "Salvar alteração";
    $("f-cancelar-edicao").hidden = false;
    $("form-titulo").textContent = "Editar registro de " + fmtDM(e.data);
    var aba = document.querySelector('#view-gerente > .tabs .tab[data-tab="g-novo"]');
    if (aba) aba.click();
    window.scrollTo(0, 0);
  }
  function acharRegistro_(gid, criadoEm){
    var lista = (me && me.papel === "gerente") ? myEntriesRaw : (entriesByGerente[gid] || []);
    return lista.filter(function(e){ return e.criadoEm === criadoEm; })[0] || null;
  }
  function acaoRegistro_(ev){
    var b = ev.target.closest ? ev.target.closest("[data-acao]") : null;
    if (!b) return;
    var acao = b.getAttribute("data-acao"), gid = b.getAttribute("data-gid"), id = b.getAttribute("data-id");
    var col = db.collection("registros/" + gid + "/entries");
    var e = acharRegistro_(gid, id);
    function feito(msg){ return function(){ toast(msg); }; }
    function erro(){ toast("Não foi possível salvar. Tente de novo."); }
    if (acao === "editar" && e) return entrarNoModoEdicao_(e);
    if (acao === "excluir"){
      if (b.getAttribute("data-confirma") !== "1"){
        b.setAttribute("data-confirma", "1"); b.textContent = "Confirmar exclusão";
        setTimeout(function(){ if (b.isConnected){ b.removeAttribute("data-confirma"); b.textContent = "Excluir"; } }, 4000);
        return;
      }
      b.disabled = true;
      return col.remove(id).then(feito("Registro excluído.")).catch(erro);
    }
    if (acao === "aconteceu") return col.update(id, { status: "Realizado" }).then(feito("Confirmado.")).catch(erro);
    if (acao === "naoaconteceu") return col.update(id, { status: "Cancelado" }).then(feito("Marcado como não aconteceu.")).catch(erro);
    if (acao === "reabrir") return col.update(id, { status: "Em negociação", motivo: "" }).then(feito("Proposta reaberta.")).catch(erro);
    if (acao === "perdida"){
      var wrap = b.parentNode;
      if (wrap.querySelector(".perda-box")) return;
      var box = document.createElement("div"); box.className = "perda-box";
      box.innerHTML = '<select class="perda-motivo"><option value="">Motivo da perda…</option>' +
        MOTIVOS_PERDA.map(function(m){ return '<option>' + renderEscaped(m) + '</option>'; }).join("") + '</select>' +
        '<button type="button" class="btn secondary btn-sm perda-ok">Marcar perdida</button>';
      wrap.appendChild(box);
      box.querySelector(".perda-ok").addEventListener("click", function(){
        var motivo = box.querySelector(".perda-motivo").value;
        if (!motivo){ toast("Escolha o motivo."); return; }
        col.update(id, { status: "Perdida", motivo: motivo }).then(feito("Proposta marcada como perdida.")).catch(erro);
      });
    }
  }
  function statusTagHTML_(e){
    var st = statusEfetivo_(e);
    if (e.tipo === "Venda - Venda") return "";
    if (aConfirmar_(e)) return '<span class="st st-confirmar">a confirmar</span>';
    var cls = { "Agendado": "st-agendado", "Cancelado": "st-cancelado", "Perdida": "st-perdida", "Em negociação": "st-negociacao" }[st];
    return cls ? '<span class="st ' + cls + '">' + renderEscaped(st.toLowerCase()) + '</span>' : "";
  }
  // linha de registro com ações (gerente: editar/excluir/confirmar; diretor: excluir)
  function registroRowHTML(e, o){
    o = o || {};
    var d = e.data ? e.data.slice(8,10) + "/" + e.data.slice(5,7) : "—";
    var un = unidadeDe_(e);
    var label = renderEscaped(e.tipo) + (e.estoque ? " · " + renderEscaped(e.estoque) : "") + (un ? " · un. " + renderEscaped(un) : "") +
      (e.parceiro ? " · " + renderEscaped(e.parceiro) : "") + (typeof e.vgv === "number" && e.vgv ? " · " + fmtBRLCurto_(e.vgv) : "");
    var base = ' data-gid="' + renderEscaped(o.gid || "") + '" data-id="' + renderEscaped(e.criadoEm || "") + '"';
    var acoes = [];
    if (aConfirmar_(e) && o.podeEditar){
      acoes.push('<button type="button" class="lnk ok" data-acao="aconteceu"' + base + '>Aconteceu</button>');
      acoes.push('<button type="button" class="lnk" data-acao="naoaconteceu"' + base + '>Não aconteceu</button>');
    }
    if (e.tipo === "Venda - Proposta" && e.status !== "Perdida" && o.podeEditar) acoes.push('<button type="button" class="lnk" data-acao="perdida"' + base + '>Perdida</button>');
    if (e.tipo === "Venda - Proposta" && e.status === "Perdida" && o.podeEditar) acoes.push('<button type="button" class="lnk" data-acao="reabrir"' + base + '>Reabrir</button>');
    if (o.podeEditar) acoes.push('<button type="button" class="lnk" data-acao="editar"' + base + '>Editar</button>');
    if (o.podeExcluir && e.criadoEm) acoes.push('<button type="button" class="lnk perigo" data-acao="excluir"' + base + '>Excluir</button>');
    return '<div class="log-row"><div class="d">' + d + '</div><div class="t">' +
      (o.who ? '<span class="who">' + renderEscaped(o.who) + '</span> · ' : '') + label + ' ' + statusTagHTML_(e) +
      (e.motivo ? '<div class="sub-nomes">Motivo: ' + renderEscaped(e.motivo) + '</div>' : '') +
      (acoes.length ? '<div class="acoes">' + acoes.join("") + '</div>' : '') + '</div></div>';
  }
  // avisos no topo do "Novo registro": o que estava agendado e já passou da data
  function renderPendentes_(){
    var box = $("g-pendentes");
    if (!box || !me) return;
    var pend = myEntriesRaw.filter(aConfirmar_).sort(function(a,b){ return (a.data||"").localeCompare(b.data||""); });
    box.hidden = !pend.length;
    if (!pend.length){ box.innerHTML = ""; return; }
    box.innerHTML = '<h2>Confirme o que aconteceu (' + pend.length + ')</h2><p class="hint">Estavam agendados e a data já chegou. Só entram nos números depois de confirmados.</p>' +
      pend.map(function(e){ return registroRowHTML(e, { gid: me.id, podeEditar: true }); }).join("");
  }

  function logRowHTML(e, who){
    var d = e.data ? e.data.slice(8,10) + "/" + e.data.slice(5,7) : "—";
    var label = renderEscaped(e.tipo) + (e.parceiro ? " · " + renderEscaped(e.parceiro) : "");
    return '<div class="log-row"><div class="d">' + d + '</div><div class="t">' +
      (who ? '<span class="who">' + renderEscaped(who) + '</span> · ' : '') + label + '</div></div>';
  }

  // ---------- corretores (cadastro do Portal Parcerias) ----------
  // CPF e senha (hash) nunca chegam até aqui — o Code.gs já não manda esses
  // campos (ver comentário lá). Aqui só exibe o que veio.

  // dataCadastro vem como "dd/mm/aaaa HH:MM" (texto do Portal) — diferente do
  // "aaaa-mm-dd" usado nos registros do Painel — por isso tem seu próprio
  // parser/contador em vez de reaproveitar inWeek()/dailyCounts() direto.
  function parseDataCadastro_(s){
    var m = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(String(s || ""));
    if (!m) return null;
    return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
  }
  function corretorInBounds_(c, bounds){
    var d = parseDataCadastro_(c.dataCadastro);
    return !!d && d >= bounds.start && d <= bounds.end;
  }
  // monta uma lista "entries-like" (só com .data em aaaa-mm-dd) pra poder
  // reaproveitar dailyCounts()/sparklineSVG() do resto do Painel
  function corretoresDailyCounts_(list, bounds){
    var synthetic = list.map(function(c){
      var d = parseDataCadastro_(c.dataCadastro);
      if (!d) return null;
      return { data: d.getFullYear() + "-" + String(d.getMonth()+1).padStart(2,"0") + "-" + String(d.getDate()).padStart(2,"0") };
    }).filter(Boolean);
    return dailyCounts(synthetic, bounds);
  }
  // tile de KPI "Cadastros" — fora do PILAR_FILTERS de propósito: cadastro no
  // Portal não é uma "ação" do Registro, então não clica pra filtrar os
  // gráficos de pilar abaixo (só informa).
  function cadastroStatTileHTML(n, deltaHtml, sparkHtml){
    return '<div class="stat stat-cadastros"><div class="n">'+n+'</div><div class="l">Cadastros</div>'+(deltaHtml||"")+(sparkHtml||"")+'</div>';
  }

  function waLink(whatsapp){
    var digits = String(whatsapp || "").replace(/\D/g, "");
    return digits ? "https://wa.me/55" + digits : null;
  }
  function creciStatusPillHTML(status){
    var s = String(status || "").trim();
    var norm = s.toLowerCase();
    if (!s) return '<span class="pill low">Sem status</span>';
    if (norm.indexOf("a validar") !== -1) return '<span class="pill low">A validar</span>';
    if (norm.indexOf("valid") !== -1) return '<span class="pill ok">' + renderEscaped(s) + '</span>';
    return '<span class="pill low">' + renderEscaped(s) + '</span>';
  }
  function corretorCardHTML(c, opts){
    opts = opts || {};
    var atua = c.atuaComo === "Imobiliária"
      ? ("Imobiliária" + (c.imobiliaria ? " · " + renderEscaped(c.imobiliaria) : ""))
      : "Autônomo (PF)";
    var creci = c.creci ? "CRECI " + renderEscaped(c.creci) : "Sem CRECI informado";
    var wa = waLink(c.whatsapp);
    var contactBits = [];
    if (wa) contactBits.push('<a href="' + wa + '" target="_blank" rel="noopener">' + renderEscaped(c.whatsapp || "WhatsApp") + '</a>');
    else if (c.whatsapp) contactBits.push(renderEscaped(c.whatsapp));
    if (c.email) contactBits.push('<a href="mailto:' + renderEscaped(c.email) + '">' + renderEscaped(c.email) + '</a>');
    var gerenteLine = "";
    if (opts.showGerente){
      gerenteLine = c.gerenteNome
        ? '<div class="cc-gerente">Gerente: ' + renderEscaped(c.gerenteNome) + '</div>'
        : '<div class="cc-gerente cc-gerente-missing">Não vinculado a um gerente (escolheu: "' + renderEscaped(c.gerenteEscolhidoTexto || "—") + '")</div>';
    }
    return '<div class="corretor-card">' +
      '<div class="cc-head"><div class="cc-nome">' + renderEscaped(c.nome) + '</div></div>' +
      '<div class="cc-meta">' + atua + ' · ' + creci + '</div>' +
      (contactBits.length ? '<div class="cc-contact">' + contactBits.join(' · ') + '</div>' : "") +
      gerenteLine +
      (c.origem ? '<div class="cc-foot">Chegou por: ' + renderEscaped(c.origem) + '</div>' : '') +
      '<div class="cc-foot">Cadastrado em ' + renderEscaped(c.dataCadastro || "—") + '</div>' +
    '</div>';
  }

  // -- visão do gerente: só os corretores que escolheram ele --
  function renderMeCorretores(list){
    var countEl = $("g-corretores-count");
    if (countEl) countEl.textContent = list.length + (list.length === 1 ? " corretor" : " corretores");
    if (!list.length){ $("g-corretores-list").innerHTML = '<p class="empty">Nenhum corretor escolheu você ainda no Portal Parcerias.</p>'; return; }
    $("g-corretores-list").innerHTML = list.map(function(c){ return corretorCardHTML(c, {}); }).join("");
  }

  // -- visão do diretor: todos os corretores, com filtro por gerente --
  function populateCorretoresFiltro(){
    var sel = $("d-corretores-filtro");
    if (!sel) return;
    var current = sel.value || dCorretoresFiltro;
    var ids = Object.keys(logins).filter(function(id){ return logins[id].papel === "gerente"; })
      .sort(function(a,b){ return (logins[a].nome||"").localeCompare(logins[b].nome||""); });
    sel.innerHTML = '<option value="">Todos os gerentes</option>';
    ids.forEach(function(id){
      var opt = document.createElement("option");
      opt.value = id; opt.textContent = logins[id].nome || id;
      sel.appendChild(opt);
    });
    var optSem = document.createElement("option");
    optSem.value = "__sem__"; optSem.textContent = "Não vinculado a um gerente";
    sel.appendChild(optSem);
    sel.value = current;
    if (sel.value !== current) sel.value = ""; // a opção salva sumiu (gerente removido) — volta pra "Todos"
  }

  function watchCorretoresAll(){
    if (!corretoresWired){
      corretoresWired = true;
      $("d-corretores-filtro").addEventListener("change", function(){
        dCorretoresFiltro = $("d-corretores-filtro").value;
        renderDiretorCorretores();
      });
    }
    if (unsubCorretoresAll) return; // já tem uma assinatura ativa, não duplica
    unsubCorretoresAll = db.collection("corretores").onSnapshot(function(snap){
      allCorretoresRaw = snap.docs.map(function(d){ return d.data(); });
      renderDiretorCorretores();
      renderDiretorDashboard(); // o KPI "Cadastros" nos Totais do time também depende disso
      renderIndividualGerente(); // o bloco "Corretores dele" também depende disso
    }, function(){ toast("Não foi possível carregar os corretores."); });
  }

  function renderDiretorCorretores(){
    if (!me || me.papel !== "diretor") return;
    var list = allCorretoresRaw;
    var naoVinculados = list.filter(function(c){ return !c.gerenteId; }).length;
    // por qual link chegaram (item 30) — só os que já têm a coluna Origem preenchida
    var porOrigem = {};
    list.forEach(function(c){ if (c.origem) porOrigem[c.origem] = (porOrigem[c.origem] || 0) + 1; });
    var origens = Object.keys(porOrigem).sort(function(a,b){ return porOrigem[b] - porOrigem[a]; }).slice(0, 3);
    $("d-corretores-resumo").innerHTML =
      statTile(list.length, "Corretores cadastrados") +
      origens.map(function(o){ return statTile(porOrigem[o], o.replace("Link do gerente: ", "Pelo link: ")); }).join("") +
      statTile(naoVinculados, "Não vinculados a um gerente");

    var filtro = dCorretoresFiltro;
    var filtered = list;
    if (filtro === "__sem__") filtered = list.filter(function(c){ return !c.gerenteId; });
    else if (filtro) filtered = list.filter(function(c){ return c.gerenteId === filtro; });

    if (!filtered.length){ $("d-corretores-list").innerHTML = '<p class="empty">Nenhum corretor nesse filtro.</p>'; return; }
    $("d-corretores-list").innerHTML = filtered.map(function(c){ return corretorCardHTML(c, { showGerente: true }); }).join("");
  }

  // ---------- diretor view ----------
  function watchMetas(){
    db.doc("config/metas").onSnapshot(function(snap){
      metas = (snap.exists && snap.data()) ? snap.data() : METAS_DEFAULT;
      $("m-plantao").value = metas.plantao;
      $("m-visita").value = metas.visita;
      $("m-apresentacao").value = metas.apresentacao;
      if ($("m-vgv")) $("m-vgv").value = metaVgvGerente_();
      if (me && me.papel === "gerente") renderMeAll();
      else { renderMetasTime_(); renderDiretorDashboard(); renderIndividualGerente(); }
    });
    if (metasWired) return;
    metasWired = true;
    $("m-save").addEventListener("click", function(){
      var novo = {
        plantao: Number($("m-plantao").value) || 0,
        visita: Number($("m-visita").value) || 0,
        apresentacao: Number($("m-apresentacao").value) || 0
      };
      var vgvMeta = Number($("m-vgv") && $("m-vgv").value) || 0;
      if (vgvMeta > 0) novo.vgvMensal = vgvMeta;
      $("m-save").disabled = true;
      db.doc("config/metas").set(novo).then(function(){
        toast("Metas atualizadas.");
        $("m-save").disabled = false;
      }).catch(function(){
        toast("Não foi possível salvar as metas.");
        $("m-save").disabled = false;
      });
    });
  }

  // aba Metas: como cada gerente está na semana e no mês
  function renderMetasTime_(){
    if (!me || me.papel !== "diretor" || !$("m-time")) return;
    var ids = Object.keys(logins).filter(function(id){ return (logins[id] || {}).papel === "gerente"; })
      .sort(function(a,b){ return ((logins[a] || {}).nome || "").localeCompare((logins[b] || {}).nome || ""); });
    var wb = weekBounds(), meta = metaVgvGerente_();
    function cel(v, m){ return '<td class="' + (v >= m ? "ok-txt" : "baixo-txt") + '">' + v + ' / ' + m + '</td>'; }
    $("m-time").innerHTML = ids.length ? '<table class="prod-table"><thead><tr><th>Gerente</th><th>Plantão</th><th>Visita imob.</th><th>Apres. Jesuíno</th><th>VGV do mês</th></tr></thead><tbody>' +
      ids.map(function(id){
        var raw = entriesByGerente[id] || [], w = computeWeek(raw, wb), v = vgvDoMes_(raw);
        return '<tr><td class="produto-nome">' + renderEscaped((logins[id] || {}).nome || id) + '</td>' +
          cel(w.plantao, metas.plantao) + cel(w.visita, metas.visita) + cel(w.apresentacao, metas.apresentacao) +
          '<td>' + fmtBRLCurto_(v) + ' <span class="hint-inline">' + Math.round(v / meta * 100) + '%</span></td></tr>';
      }).join("") + '</tbody></table>' : '<p class="empty">Sem gerentes.</p>';
    $("m-time-tit").textContent = "Esta semana (" + fmtRange(wb) + ") e este mês, por gerente";
    marcarOverflow_($("m-time"));
  }

  function syncGerenteEntrySubscriptions(){
    var ids = Object.keys(logins).filter(function(id){ return logins[id].papel === "gerente"; });
    $("d-empty").hidden = ids.length > 0;
    ids.forEach(function(id){
      if (unsubEntries[id]) return;
      unsubEntries[id] = db.collection("registros/" + id + "/entries").onSnapshot(function(esnap){
        entriesByGerente[id] = esnap.docs.map(function(d){ return d.data(); });
        renderDiretorDashboard();
        renderResumoExecutivo();
        renderIndividualGerente();
        renderProdutosTable();
        renderTeamLog();
        renderAbasNovas_();
        renderMetasTime_();
      });
    });
    Object.keys(unsubEntries).forEach(function(id){
      if (ids.indexOf(id) === -1){
        try{ unsubEntries[id](); }catch(e){}
        delete unsubEntries[id];
        delete entriesByGerente[id];
      }
    });
    renderGerenteChips();
    renderDiretorDashboard();
    renderResumoExecutivo();
    populateIndividualGerenteSelect();
    renderIndividualGerente();
    renderProdutosTable();
    renderTeamLog();
    renderAbasNovas_();
    renderMetasTime_();
  }

  function renderGerenteChips(){
    var ids = Object.keys(logins).filter(function(id){ return logins[id].papel === "gerente"; })
      .sort(function(a,b){ return (logins[a].nome||"").localeCompare(logins[b].nome||""); });
    if (!dState.selected) dState.selected = new Set();
    if (!dState.knownIds) dState.knownIds = new Set();
    ids.forEach(function(id){
      if (!dState.knownIds.has(id)){ dState.selected.add(id); dState.knownIds.add(id); }
    });
    Array.from(dState.selected).forEach(function(id){ if (ids.indexOf(id) === -1) dState.selected["delete"](id); });
    Array.from(dState.knownIds).forEach(function(id){ if (ids.indexOf(id) === -1) dState.knownIds["delete"](id); });

    var container = $("d-gerente-chips");
    container.innerHTML = "";
    var allOn = ids.length > 0 && ids.every(function(id){ return dState.selected.has(id); });
    var allBtn = document.createElement("button");
    allBtn.type = "button"; allBtn.className = "chip-multi";
    allBtn.setAttribute("aria-pressed", allOn ? "true" : "false");
    allBtn.textContent = "Todos";
    allBtn.addEventListener("click", function(){
      if (allOn){ dState.selected.clear(); } else { ids.forEach(function(id){ dState.selected.add(id); }); }
      renderGerenteChips(); renderDiretorDashboard(); renderTeamLog();
    });
    container.appendChild(allBtn);

    ids.forEach(function(id){
      var btn = document.createElement("button");
      btn.type = "button"; btn.className = "chip-multi";
      btn.setAttribute("aria-pressed", dState.selected.has(id) ? "true" : "false");
      btn.textContent = logins[id].nome || id;
      btn.addEventListener("click", function(){
        if (dState.selected.has(id)) dState.selected["delete"](id); else dState.selected.add(id);
        renderGerenteChips(); renderDiretorDashboard(); renderTeamLog();
      });
      container.appendChild(btn);
    });
  }

  function renderDiretorDashboard(){
    if (!me || me.papel !== "diretor") return;
    if (!dState.selected) return;
    var bounds = periodBounds(dState);
    var prevBounds = previousPeriodBounds(dState);
    var ids = Array.from(dState.selected);
    $("d-kpi-title").textContent = "Totais do time — " + periodLabel(dState);

    var agg = { visitas: 0, treinamentos: 0, propostas: 0, vendas: 0, vgv: 0, vgvPropostas: 0 };
    var prevAgg = { visitas: 0, treinamentos: 0, propostas: 0, vendas: 0, vgv: 0, vgvPropostas: 0 };
    var sel = dState.pilarSel;
    var pilarPred = (sel && PILAR_FILTERS[sel]) ? PILAR_FILTERS[sel].pred : null;
    var ranked = [], grouped = [], allFiltered = [];
    ids.forEach(function(id){
      var raw = entriesByGerente[id] || [];
      var filtered = filterEntries(raw, bounds, dState.estoque);
      var t = computeTotals(filtered, raw);
      agg.visitas += t.visitas; agg.treinamentos += t.treinamentos;
      agg.propostas += t.propostas; agg.vendas += t.vendas; agg.vgv += t.vgv; agg.vgvPropostas += t.vgvPropostas;
      var prevT = computeTotals(filterEntries(raw, prevBounds, dState.estoque), raw);
      prevAgg.visitas += prevT.visitas; prevAgg.treinamentos += prevT.treinamentos;
      prevAgg.propostas += prevT.propostas; prevAgg.vendas += prevT.vendas; prevAgg.vgv += prevT.vgv; prevAgg.vgvPropostas += prevT.vgvPropostas;
      var nome = (logins[id] || {}).nome || id;
      var chartFiltered = pilarPred ? filtered.filter(pilarPred) : filtered;
      ranked.push({ id: id, label: nome, value: chartFiltered.length });
      var pc = pilarCounts(chartFiltered);
      grouped.push({ id: id, label: nome, visitas: pc["Visitas"], treinamento: pc["Treinamento"], propostas: pc["Propostas"], vendas: pc["Vendas"] });
      allFiltered = allFiltered.concat(chartFiltered);
    });
    ranked.sort(function(a,b){ return b.value - a.value; });

    // os sparklines de cada card usam sempre o pilar do próprio card (não
    // mudam com o filtro — eles já SÃO o filtro de cada categoria).
    var allUnfiltered = [];
    ids.forEach(function(id){ allUnfiltered = allUnfiltered.concat(filterEntries(entriesByGerente[id] || [], bounds, dState.estoque)); });
    var spark = function(pred, colorVar){ return sparklineSVG(dailyCounts(allUnfiltered.filter(pred), bounds).map(function(d){ return d.value; }), colorVar); };
    // Cadastros segue o mesmo filtro de gerentes dos outros cards: com todos
    // marcados, conta tudo (inclusive quem não tem gerente vinculado); com
    // uma seleção parcial, conta só quem está vinculado a um gerente marcado.
    var totalGerentesConhecidos = dState.knownIds ? dState.knownIds.size : 0;
    var cadList = (ids.length > 0 && ids.length === totalGerentesConhecidos)
      ? allCorretoresRaw
      : allCorretoresRaw.filter(function(c){ return ids.indexOf(c.gerenteId) !== -1; });
    var cadAtual = cadList.filter(function(c){ return corretorInBounds_(c, bounds); }).length;
    var cadAnterior = cadList.filter(function(c){ return corretorInBounds_(c, prevBounds); }).length;
    var cadSpark = sparklineSVG(corretoresDailyCounts_(cadList, bounds).map(function(d){ return d.value; }), "var(--viz-cat-4)");
    $("d-kpi").innerHTML =
      statTile(agg.visitas, "Visitas", deltaBadge(agg.visitas, prevAgg.visitas), spark(PILAR_FILTERS.visitas.pred, PILAR_FILTERS.visitas.color), "visitas", sel === "visitas") +
      statTile(agg.treinamentos, "Treinamentos", deltaBadge(agg.treinamentos, prevAgg.treinamentos), spark(PILAR_FILTERS.treinamentos.pred, PILAR_FILTERS.treinamentos.color), "treinamentos", sel === "treinamentos") +
      statTile(agg.propostas, "Propostas", deltaBadge(agg.propostas, prevAgg.propostas), spark(PILAR_FILTERS.propostas.pred, PILAR_FILTERS.propostas.color), "propostas", sel === "propostas") +
      statTile(agg.vendas, "Vendas", deltaBadge(agg.vendas, prevAgg.vendas), spark(PILAR_FILTERS.vendas.pred, PILAR_FILTERS.vendas.color), "vendas", sel === "vendas") +
      cadastroStatTileHTML(cadAtual, deltaBadge(cadAtual, cadAnterior), cadSpark);
    if ($("d-pilar-filter-note")) $("d-pilar-filter-note").innerHTML = pilarFilterNoteHTML(sel);

    var ticket = agg.vendas ? (agg.vgv / agg.vendas) : 0;
    $("d-vgv-hero").innerHTML = heroKpi(
      fmtBRL(agg.vgv),
      deltaBadge(agg.vgv, prevAgg.vgv),
      heroMini(agg.vendas, "Vendas") + heroMini(fmtBRL(ticket), "Ticket médio") + heroMini(fmtBRL(agg.vgvPropostas), "Potencial em propostas abertas")
    );

    if ($("d-meta-vgv")){
      var vgvMesTime = ids.reduce(function(sum, id){ return sum + vgvDoMes_(entriesByGerente[id]); }, 0);
      $("d-meta-vgv").innerHTML = ids.length ? metaBarraHTML(vgvMesTime, metaVgvGerente_() * ids.length,
        "Meta do mês · " + ids.length + (ids.length === 1 ? " gerente" : " gerentes") + " × " + fmtBRLCurto_(metaVgvGerente_())) : "";
    }

    if (sel && PILAR_FILTERS[sel]){
      show($("d-estoque-card"));
      $("d-estoque-title").textContent = PILAR_FILTERS[sel].label + " por projeto";
      renderRankedBarChart($("d-estoque-chart"), estoqueCounts(allFiltered), PILAR_FILTERS[sel].label + " por projeto");
    } else {
      hide($("d-estoque-card"));
    }

    renderTrendChart($("d-trend-chart"), dailyCounts(allFiltered, bounds), "Atividade do time ao longo do período");
    renderPilarBars($("d-pilar-chart"), pilarCounts(allFiltered));
    renderNovoRecorrenteBars($("d-novo-chart"), novoRecorrenteCounts(allFiltered));
    renderRankedBarChart($("d-ranked-chart"), ranked, "Volume de registros por gerente");
    renderGroupedBarChart($("d-grouped-chart"), grouped);
  }

  function renderTeamLog(){
    if (!me || me.papel !== "diretor" || !dState.selected) return;
    var bounds = periodBounds(dState);
    var ids = Array.from(dState.selected);
    var all = [];
    ids.forEach(function(id){
      filterEntries(entriesByGerente[id] || [], bounds, dState.estoque, true).forEach(function(e){
        all.push({ e: e, who: (logins[id] || {}).nome, gid: id });
      });
    });
    all.sort(function(a,b){ return (b.e.criadoEm||"").localeCompare(a.e.criadoEm||""); });
    all = all.slice(0, 30);
    if (!all.length){ $("d-log").innerHTML = '<p class="empty">Nenhum registro do time nesse filtro.</p>'; return; }
    $("d-log").innerHTML = all.map(function(x){ return registroRowHTML(x.e, { who: x.who, gid: x.gid, podeExcluir: true }); }).join("");
  }

  // =====================================================================
  // Abas novas do Diretor: Propostas, Parceiros, Agenda e Mercado.
  // Todas só LEEM os registros que já existem — não mudam nada na planilha.
  // =====================================================================
  function todosRegistros_(){
    var out = [];
    Object.keys(logins).forEach(function(id){
      if ((logins[id] || {}).papel !== "gerente") return;
      (entriesByGerente[id] || []).forEach(function(e){ out.push({ e: e, gid: id, who: (logins[id] || {}).nome || id }); });
    });
    return out;
  }
  function vgvNum_(e){ return (typeof e.vgv === "number" && !isNaN(e.vgv)) ? e.vgv : 0; }

  // agrupa nomes de parceiro parecidos (mesma imobiliária escrita de jeitos
  // diferentes). Regras, de propósito conservadoras (nome de uma palavra só precisa ter 6+ letras):
  //  1) mesma chave depois de tirar acento, pontuação e palavras genéricas
  //     ("imobiliária", "imóveis"...);
  //  2) todas as palavras de um nome estão dentro do outro ("Midrah" ⊂ "Marcos / Midrah");
  //  3) nomes longos (8+ letras) com até 2 letras de diferença ("Bellotto" × "Belloto").
  function agruparParceiros_(entries){
    var porChave = {};
    entries.forEach(function(e){
      var nome = String(e.parceiro || "").trim();
      if (!nome || ehNomeDeGerente_(nome)) return;
      var k = chaveParceiro_(nome);
      if (!k) return;
      if (!porChave[k]) porChave[k] = { chave: k, tokens: k.split(" "), nomes: {}, entries: [] };
      porChave[k].nomes[nome] = (porChave[k].nomes[nome] || 0) + 1;
      porChave[k].entries.push(e);
    });
    var chaves = Object.keys(porChave).sort(function(a,b){ return a.length - b.length; });
    var pai = {};
    chaves.forEach(function(k){ pai[k] = k; });
    function raiz(k){ while (pai[k] !== k){ pai[k] = pai[pai[k]]; k = pai[k]; } return k; }
    function unir(a, b){ var ra = raiz(a), rb = raiz(b); if (ra !== rb) pai[rb] = ra; }
    for (var i = 0; i < chaves.length; i++){
      var A = porChave[chaves[i]];
      for (var j = i + 1; j < chaves.length; j++){
        var B = porChave[chaves[j]];
        var contido = (A.tokens.length >= 2 ? A.chave.length >= 5 : A.chave.length >= 6) && A.tokens.every(function(t){ return B.tokens.indexOf(t) !== -1; });
        var parecido = A.chave.length >= 8 && Math.abs(A.chave.length - B.chave.length) <= 2 && levenshtein_(A.chave, B.chave) <= 2;
        if (contido || parecido) unir(chaves[i], chaves[j]);
      }
    }
    var grupos = {};
    chaves.forEach(function(k){
      var r = raiz(k);
      if (!grupos[r]) grupos[r] = { nomes: {}, entries: [] };
      Object.keys(porChave[k].nomes).forEach(function(n){ grupos[r].nomes[n] = (grupos[r].nomes[n] || 0) + porChave[k].nomes[n]; });
      grupos[r].entries = grupos[r].entries.concat(porChave[k].entries);
    });
    return Object.keys(grupos).map(function(r){
      var g = grupos[r];
      var nomes = Object.keys(g.nomes).sort(function(a,b){ return (g.nomes[b] - g.nomes[a]) || (a.length - b.length); });
      return { nome: nomes[0], variantes: nomes.slice(1), entries: g.entries };
    });
  }

  // ---------- Propostas ----------
  function renderPropostasTab(){
    if (!me || me.papel !== "diretor" || !$("pp-abertas")) return;
    var todos = todosRegistros_();
    var hoje = hojeISO_();
    var convertidas = {};
    todos.forEach(function(x){ if (x.e.tipo === "Venda - Venda" && x.e.convertidaDeProposta) convertidas[x.e.convertidaDeProposta] = x; });
    var props = todos.filter(function(x){ return x.e.tipo === "Venda - Proposta"; });
    var abertas = props.filter(function(x){ return !(x.e.criadoEm && convertidas[x.e.criadoEm]) && x.e.status !== "Perdida"; });
    var fechadas = props.filter(function(x){ return x.e.criadoEm && convertidas[x.e.criadoEm]; });
    var perdidas = props.filter(function(x){ return !(x.e.criadoEm && convertidas[x.e.criadoEm]) && x.e.status === "Perdida"; });
    abertas.forEach(function(x){ x.dias = Math.max(0, diasEntre_(x.e.data, hoje)); });
    abertas.sort(function(a,b){ return b.dias - a.dias || vgvNum_(b.e) - vgvNum_(a.e); });

    var totalAberto = abertas.reduce(function(s, x){ return s + vgvNum_(x.e); }, 0);
    var idadeMedia = abertas.length ? Math.round(abertas.reduce(function(s, x){ return s + x.dias; }, 0) / abertas.length) : 0;
    var maior = abertas.reduce(function(m, x){ return vgvNum_(x.e) > m ? vgvNum_(x.e) : m; }, 0);
    var concentracao = totalAberto ? Math.round(maior / totalAberto * 100) : 0;
    var diasFechar = fechadas.map(function(x){ var v = convertidas[x.e.criadoEm].e; return Math.max(0, diasEntre_(x.e.data, v.data)); });
    var mediaFechar = diasFechar.length ? Math.round(diasFechar.reduce(function(a,b){ return a + b; }, 0) / diasFechar.length) : null;

    var decididas = fechadas.length + perdidas.length;
    $("pp-resumo").innerHTML =
      statTile(fmtBRLCurto_(totalAberto), "Em aberto (" + abertas.length + ")") +
      statTile(idadeMedia + " dias", "Idade média das abertas") +
      statTile(concentracao + "%", "Peso da maior proposta") +
      statTile(mediaFechar == null ? "—" : mediaFechar + " dias", "Proposta → venda (média)") +
      statTile(decididas ? Math.round(fechadas.length / decididas * 100) + "%" : "—", "Ganhas entre as decididas (" + fechadas.length + " de " + decididas + ")");

    function botaoProp(x, acao, txt){
      return '<button type="button" class="lnk" data-acao="' + acao + '" data-gid="' + renderEscaped(x.gid) + '" data-id="' + renderEscaped(x.e.criadoEm || "") + '">' + txt + '</button>';
    }
    function linhaProp(x, extra){
      var e = x.e, un = unidadeDe_(e);
      var idadeCls = x.dias >= 15 ? "idade alta" : (x.dias >= 7 ? "idade media" : "idade");
      return '<tr><td>' + fmtDM(e.data) + '</td>' +
        (extra === "aberta" ? '<td><span class="' + idadeCls + '">' + x.dias + 'd</span></td>' : '<td>' + extra + '</td>') +
        '<td>' + renderEscaped(x.who) + '</td><td>' + renderEscaped(e.estoque || "—") + '</td><td>' + renderEscaped(un || "—") + '</td>' +
        '<td class="txt">' + renderEscaped(e.parceiro || "—") + (e.motivo ? '<div class="sub-nomes">' + renderEscaped(e.motivo) + '</div>' : '') + '</td><td>' + fmtBRLCurto_(vgvNum_(e)) + '</td>' +
        '<td class="acao-cel">' + (extra === "aberta" ? botaoProp(x, "perdida", "Perdida") : (e.status === "Perdida" ? botaoProp(x, "reabrir", "Reabrir") : "")) + '</td></tr>';
    }
    var cab = '<thead><tr><th>Data</th><th>%s</th><th>Gerente</th><th>Produto</th><th>Unid.</th><th>Parceiro</th><th>Valor</th><th></th></tr></thead>';
    $("pp-abertas").innerHTML = abertas.length
      ? '<table class="prod-table lista-table">' + cab.replace("%s", "Aberta há") + '<tbody>' + abertas.map(function(x){ return linhaProp(x, "aberta"); }).join("") + '</tbody></table>'
      : '<p class="empty">Nenhuma proposta em aberto.</p>';
    $("pp-fechadas").innerHTML = fechadas.length
      ? '<table class="prod-table lista-table">' + cab.replace("%s", "Virou venda") + '<tbody>' + fechadas.map(function(x){
          var v = convertidas[x.e.criadoEm].e; return linhaProp(x, fmtDM(v.data) + " (" + Math.max(0, diasEntre_(x.e.data, v.data)) + "d)");
        }).join("") + '</tbody></table>'
      : '<p class="empty">Nenhuma proposta ligada a uma venda ainda.</p>';
    $("pp-perdidas").innerHTML = perdidas.length
      ? '<table class="prod-table lista-table">' + cab.replace("%s", "Perdida") + '<tbody>' + perdidas.map(function(x){ return linhaProp(x, "—"); }).join("") + '</tbody></table>'
      : '<p class="empty">Nenhuma proposta marcada como perdida.</p>';
    marcarOverflow_($("pp-abertas")); marcarOverflow_($("pp-fechadas")); marcarOverflow_($("pp-perdidas"));
  }

  // ---------- Parceiros ----------
  var parState = { ordem: "vgv" };
  function renderParceirosTab(){
    if (!me || me.papel !== "diretor" || !$("par-lista")) return;
    var ordSel = $("par-ordem");
    if (ordSel && !ordSel.dataset.ok){
      ordSel.dataset.ok = "1";
      ordSel.addEventListener("change", function(){ parState.ordem = ordSel.value; renderParceirosTab(); });
    }
    var hoje = hojeISO_();
    var todos = todosRegistros_();
    var quem = new Map();
    todos.forEach(function(x){ quem.set(x.e, x.who); });
    var grupos = agruparParceiros_(todos.map(function(x){ return x.e; }));
    var linhas = grupos.map(function(g){
      var r = { nome: g.nome, variantes: g.variantes, reg: g.entries.length, visitas: 0, treinos: 0, propostas: 0, vendas: 0, vgv: 0, ultimo: null, gerentes: {} };
      g.entries.forEach(function(e){
        var p = TIPOS_PILAR(e.tipo);
        if (p === "Visitas") r.visitas++;
        else if (p === "Treinamento") r.treinos++;
        else if (e.tipo === "Venda - Proposta") r.propostas++;
        else if (e.tipo === "Venda - Venda"){ r.vendas++; r.vgv += vgvNum_(e); }
        if (e.data && e.data <= hoje && (!r.ultimo || e.data > r.ultimo)) r.ultimo = e.data;
        var w = quem.get(e); if (w) r.gerentes[w] = true;
      });
      r.dias = r.ultimo ? diasEntre_(r.ultimo, hoje) : null;
      return r;
    });
    var ord = parState.ordem;
    linhas.sort(function(a,b){
      if (ord === "dias") return (b.dias == null ? -1 : b.dias) - (a.dias == null ? -1 : a.dias);
      if (ord === "reg") return b.reg - a.reg;
      return (b.vgv - a.vgv) || (b.propostas - a.propostas) || (b.reg - a.reg);
    });
    var comVenda = linhas.filter(function(r){ return r.vendas > 0; }).length;
    var esfriando = linhas.filter(function(r){ return r.dias != null && r.dias > 15; }).length;
    var multi = linhas.filter(function(r){ return Object.keys(r.gerentes).length > 1; }).length;
    $("par-resumo").innerHTML =
      statTile(linhas.length, "Parceiros com registro") +
      statTile(comVenda, "Já geraram venda") +
      statTile(esfriando, "Mais de 15 dias sem contato") +
      statTile(multi, "Atendidos por 2+ gerentes");
    $("par-lista").innerHTML = linhas.length ? '<table class="prod-table lista-table"><thead><tr><th>Parceiro</th><th>Gerente(s)</th><th>Reg.</th><th>Visitas</th><th>Treinos</th><th>Propostas</th><th>Vendas</th><th>VGV</th><th>Último contato</th></tr></thead><tbody>' +
      linhas.map(function(r){
        var diasTxt = r.dias == null ? "—" : (r.dias === 0 ? "hoje" : r.dias + "d");
        var cls = r.dias != null && r.dias > 15 ? "idade alta" : (r.dias != null && r.dias > 7 ? "idade media" : "idade");
        return '<tr><td class="txt"><strong>' + renderEscaped(r.nome) + '</strong>' +
          (r.variantes.length ? '<div class="sub-nomes">também escrito: ' + r.variantes.map(renderEscaped).join(" · ") + '</div>' : '') + '</td>' +
          '<td class="txt">' + Object.keys(r.gerentes).map(renderEscaped).join(", ") + '</td>' +
          '<td>' + r.reg + '</td><td class="' + (r.visitas ? "" : "zero") + '">' + r.visitas + '</td><td class="' + (r.treinos ? "" : "zero") + '">' + r.treinos + '</td>' +
          '<td class="' + (r.propostas ? "" : "zero") + '">' + r.propostas + '</td><td class="' + (r.vendas ? "" : "zero") + '">' + r.vendas + '</td>' +
          '<td class="' + (r.vgv ? "" : "zero") + '">' + (r.vgv ? fmtBRLCurto_(r.vgv) : "—") + '</td>' +
          '<td>' + (r.ultimo ? fmtDM(r.ultimo) + ' <span class="' + cls + '">' + diasTxt + '</span>' : "só agendado") + '</td></tr>';
      }).join("") + '</tbody></table>' : '<p class="empty">Nenhum parceiro registrado ainda.</p>';
    marcarOverflow_($("par-lista"));
  }

  // ---------- Agenda ----------
  function renderAgendaTab(){
    if (!me || me.papel !== "diretor" || !$("ag-lista")) return;
    var hoje = hojeISO_();
    var lim = new Date(); lim.setDate(lim.getDate() + 14);
    var limISO = lim.getFullYear() + "-" + String(lim.getMonth() + 1).padStart(2, "0") + "-" + String(lim.getDate()).padStart(2, "0");
    var itens = todosRegistros_().filter(function(x){ return x.e.data && x.e.data >= hoje && x.e.data <= limISO; })
      .sort(function(a,b){ return a.e.data.localeCompare(b.e.data) || a.who.localeCompare(b.who); });
    var porGerente = {};
    itens.forEach(function(x){ porGerente[x.who] = (porGerente[x.who] || 0) + 1; });
    var ids = Object.keys(logins).filter(function(id){ return (logins[id] || {}).papel === "gerente"; });
    $("ag-resumo").innerHTML = ids.map(function(id){
      var n = (logins[id] || {}).nome || id;
      return statTile(porGerente[n] || 0, n);
    }).join("");
    if (!itens.length){ $("ag-lista").innerHTML = '<p class="empty">Nada marcado para os próximos 14 dias.</p>'; return; }
    var DIAS = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
    var html = "", atual = null;
    itens.forEach(function(x){
      if (x.e.data !== atual){
        if (atual) html += '</div>';
        atual = x.e.data;
        var d = new Date(atual + "T00:00:00");
        html += '<div class="ag-dia"><div class="ag-dia-tit">' + (atual === hoje ? "Hoje · " : "") + DIAS[d.getDay()] + " " + fmtDM(atual) + '</div>';
      }
      html += '<div class="log-row"><div class="d">' + renderEscaped(x.who) + '</div><div class="t">' + renderEscaped(x.e.tipo) +
        (x.e.estoque ? " · " + renderEscaped(x.e.estoque) : "") + (x.e.parceiro ? " · " + renderEscaped(x.e.parceiro) : "") +
        (x.e.observacao ? '<div class="sub-nomes">' + renderEscaped(x.e.observacao) + '</div>' : '') + '</div></div>';
    });
    html += '</div>';
    $("ag-lista").innerHTML = html;
  }

  // ---------- Mercado (o que os clientes dizem, tirado das observações) ----------
  var MERCADO_TEMAS = [
    { id: "obra", nome: "Obra e barulho no entorno", re: /obra|barulh/i },
    { id: "andar", nome: "Andar, vista e altura", re: /\bandar|vista\b|altura/i },
    { id: "preco", nome: "Preço e proposta abaixo", re: /pre[çc]o|caro|proposta baixa|abaixo de|mil o metro|invi[aá]vel|desconto|leil[aã]o/i },
    { id: "planta", nome: "Tamanho e planta", re: /pequen|planta|p[ée][ -]?direito|duplex|metragem|dormit/i },
    { id: "credito", nome: "Financiamento, FGTS e HIS", re: /fgts|\bhis\b|financi|renda/i },
    { id: "permuta", nome: "Permuta", re: /permuta/i },
    { id: "regiao", nome: "Região e localização", re: /regi[aã]o|localiza/i },
    { id: "invest", nome: "Investimento", re: /invest/i },
    { id: "fora", nome: "Cliente de fora de SP", re: /fora de s(p|[aã]o paulo)|\bde bh\b|do sul\b|bahia|itatiba|porto alegre|interior/i }
  ];
  var mkState = { produto: "" };
  function renderMercadoTab(){
    if (!me || me.papel !== "diretor" || !$("mk-temas")) return;
    var todos = todosRegistros_().filter(function(x){
      var o = String(x.e.observacao || "").replace(/^Unid\.[^·]*·?\s*/, "");
      x.obs = o;
      return o.length >= 12 && (!mkState.produto || x.e.estoque === mkState.produto);
    });
    var sel = $("mk-produto");
    if (sel && !sel.dataset.ok){
      sel.dataset.ok = "1";
      sel.innerHTML = '<option value="">Todos os produtos</option>' + (CONFIG.estoques || []).map(function(n){ return '<option>' + renderEscaped(n) + '</option>'; }).join("");
      sel.addEventListener("change", function(){ mkState.produto = sel.value; renderMercadoTab(); });
    }
    var html = "";
    MERCADO_TEMAS.forEach(function(t){
      var hits = todos.filter(function(x){ return t.re.test(x.obs); })
        .sort(function(a,b){ return (b.e.data || "").localeCompare(a.e.data || ""); });
      if (!hits.length) return;
      var porProd = {};
      hits.forEach(function(x){ var k = x.e.estoque || "—"; porProd[k] = (porProd[k] || 0) + 1; });
      var prodTxt = Object.keys(porProd).sort(function(a,b){ return porProd[b] - porProd[a]; }).map(function(k){ return k + " (" + porProd[k] + ")"; }).join(" · ");
      html += '<details class="mk-tema"><summary><span class="mk-n">' + hits.length + '</span> <strong>' + t.nome + '</strong><span class="mk-prod">' + renderEscaped(prodTxt) + '</span></summary>' +
        hits.map(function(x){
          return '<div class="log-row"><div class="d">' + fmtDM(x.e.data) + '</div><div class="t"><span class="who">' + renderEscaped(x.who) + '</span> · ' +
            renderEscaped(x.e.estoque || "—") + ' — ' + renderEscaped(x.obs) + '</div></div>';
        }).join("") + '</details>';
    });
    $("mk-temas").innerHTML = html || '<p class="empty">Nenhuma observação com esses temas ainda.</p>';
  }

  function marcarOverflow_(wrap){
    if (!wrap) return;
    requestAnimationFrame(function(){ wrap.classList.toggle("has-overflow", wrap.scrollWidth > wrap.clientWidth + 1); });
  }
  function renderAbasNovas_(){
    renderPropostasTab(); renderParceirosTab(); renderAgendaTab(); renderMercadoTab();
  }

  function renderGerentesList(){
    var ids = Object.keys(logins).filter(function(id){ return logins[id].papel === "gerente"; })
      .sort(function(a,b){ return (logins[a].nome||"").localeCompare(logins[b].nome||""); });
    if (!ids.length){ $("gerentes-list").innerHTML = '<p class="empty">Nenhum gerente cadastrado ainda.</p>'; return; }
    $("gerentes-list").innerHTML = ids.map(function(id){
      return '<div class="roster-item">' +
        '<div style="display:flex; justify-content:space-between; align-items:center; gap:10px">' +
          '<strong>' + renderEscaped(logins[id].nome || id) + '</strong>' +
          '<button class="btn secondary btn-sm" data-remove="' + id + '">Remover</button>' +
        '</div>' +
        '<div class="row2" style="margin-top:10px">' +
          '<input type="password" placeholder="Nova senha" data-newpass="' + id + '">' +
          '<button class="btn secondary btn-sm" data-setpass="' + id + '">Trocar senha</button>' +
        '</div>' +
      '</div>';
    }).join("");
  }

  boot();
})();
