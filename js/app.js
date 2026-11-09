(function(){
  "use strict";

  var TIPOS_PILAR = function(tipo){ return tipo ? tipo.split(" - ")[0] : ""; };

  // Config (estoques list + default metas) lives in data/config.json so it
  // can be edited without touching code. DEFAULT_CONFIG is the fallback used
  // if that fetch fails (e.g. opening index.html directly as a file:// URL,
  // which browsers block fetch() for) — GitHub Pages serves it fine.
  var DEFAULT_CONFIG = {
    estoques: ["Uapé", "Esquina", "155", "Zip", "Jesuíno", "Lorena", "Outro"],
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

  function computeTotals(entries){
    var t = { visitas:0, treinamentos:0, propostas:0, vendas:0, vgv:0, vgvPropostas:0 };
    entries.forEach(function(e){
      if (TIPOS_PILAR(e.tipo) === "Visitas") t.visitas++;
      else if (TIPOS_PILAR(e.tipo) === "Treinamento") t.treinamentos++;
      else if (e.tipo === "Venda - Proposta"){
        t.propostas++;
        t.vgvPropostas += (typeof e.vgv === "number" && !isNaN(e.vgv)) ? e.vgv : 0;
      }
      else if (e.tipo === "Venda - Venda"){
        t.vendas++;
        t.vgv += (typeof e.vgv === "number" && !isNaN(e.vgv)) ? e.vgv : 0;
      }
    });
    return t;
  }
  function computeWeek(entries, bounds){
    var w = { plantao:0, visita:0, apresentacao:0 };
    entries.forEach(function(e){
      if (!inWeek(e.data, bounds)) return;
      if (e.tipo === "Treinamento - Plantão de estoque") w.plantao++;
      else if (e.tipo === "Treinamento - Visita a imobiliária") w.visita++;
      else if (e.tipo === "Treinamento - Apresentação de lançamento") w.apresentacao++;
    });
    return w;
  }

  function pilarCounts(entries){
    var c = { "Visitas": 0, "Treinamento": 0, "Venda": 0 };
    entries.forEach(function(e){
      var p = TIPOS_PILAR(e.tipo);
      if (c.hasOwnProperty(p)) c[p]++;
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
    vendas: { label: "Vendas", color: "var(--viz-cat-3)", pred: function(e){ return e.tipo === "Venda - Venda"; } }
  };

  function monthBounds(ref){
    var d = ref ? new Date(ref) : new Date();
    var start = new Date(d.getFullYear(), d.getMonth(), 1);
    var end = new Date(d.getFullYear(), d.getMonth() + 1, 0);
    return { start: start, end: end };
  }
  function periodBounds(state){
    if (state.periodo === "mes") return monthBounds();
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
      var prevRef = new Date(b.start.getFullYear(), b.start.getMonth() - 1, 15);
      return monthBounds(prevRef);
    }
    var days = Math.round((b.end - b.start) / 86400000) + 1;
    var prevEnd = new Date(b.start.getFullYear(), b.start.getMonth(), b.start.getDate() - 1);
    var prevStart = new Date(prevEnd.getFullYear(), prevEnd.getMonth(), prevEnd.getDate() - (days - 1));
    return { start: prevStart, end: prevEnd };
  }
  function filterEntries(entries, bounds, estoque){
    return entries.filter(function(e){
      if (!inWeek(e.data, bounds)) return false;
      if (estoque && e.estoque !== estoque) return false;
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
      { label: "Venda", value: counts["Venda"] || 0, color: "var(--viz-cat-3)" }
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

  function renderNovoRecorrenteBars(container, counts){
    var items = [
      { label: "Primeira vez", value: counts.novo || 0, color: "var(--viz-cat-1)" },
      { label: "Recorrente", value: counts.recorrente || 0, color: "var(--viz-cat-3)" }
    ];
    renderHBarList(container, items, "Parceiros novos vs. recorrentes", "Sem registros nesse período.");
  }

  function renderRankedBarChart(container, items){
    container.innerHTML = "";
    if (!items.length){
      var p = document.createElement("p"); p.className = "viz-empty"; p.textContent = "Sem dados para esse filtro.";
      container.appendChild(p); return;
    }
    var max = Math.max.apply(null, items.map(function(i){ return i.value; })) || 1;
    var rowH = 34, barH = 20, labelW = 96, chartW = 380, plotW = chartW - labelW - 46;
    var svg = svgEl("svg", { viewBox: "0 0 " + chartW + " " + (items.length * rowH), class: "barchart", role: "img", "aria-label": "Volume de registros por gerente" });
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

  function renderGroupedBarChart(container, items){
    container.innerHTML = "";
    if (!items.length){
      var p = document.createElement("p"); p.className = "viz-empty"; p.textContent = "Sem dados para esse filtro.";
      container.appendChild(p); return;
    }
    var series = [
      { key: "visitas", name: "Visitas", color: "var(--viz-cat-1)" },
      { key: "treinamento", name: "Treinamento", color: "var(--viz-cat-2)" },
      { key: "venda", name: "Venda", color: "var(--viz-cat-3)" }
    ];
    var max = 1;
    items.forEach(function(it){ series.forEach(function(s){ if ((it[s.key] || 0) > max) max = it[s.key]; }); });
    var groupW = Math.max(90, Math.min(130, 420 / items.length)), barW = 18, gap = 3, chartH = 180, baseline = chartH - 26, topPad = 10;
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
        metasDefault: (json.metasDefault && typeof json.metasDefault === "object") ? json.metasDefault : DEFAULT_CONFIG.metasDefault
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
      hide($("boot")); show($("app"));
      wireTabs();
      wireStaticHandlers();
      watchLogins();
    }).catch(function(){
      hide($("boot")); show($("noaccess"));
    });
  }

  function tryRestoreSession(){
    try {
      var raw = sessionStorage.getItem("painel-me");
      if (raw) return JSON.parse(raw);
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
        try { sessionStorage.removeItem("painel-me"); } catch(e){}
        hide($("view-login")); hide($("view-gerente")); hide($("view-diretor"));
        $("role-badge").hidden = true; $("logout-btn").hidden = true;
        show($("view-setup"));
        return;
      }

      if (me && (!logins[me.id] || logins[me.id].papel !== me.papel)){
        me = null;
        try { sessionStorage.removeItem("painel-me"); } catch(e){}
      }

      if (!me){
        enteredAs = null;
        hide($("view-setup")); hide($("view-gerente")); hide($("view-diretor"));
        $("role-badge").hidden = true; $("logout-btn").hidden = true;
        populateLoginSelect();
        show($("view-login"));
        return;
      }

      hide($("view-setup")); hide($("view-login"));
      $("role-badge").hidden = false; $("logout-btn").hidden = false;

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
    }, function(){ toast("Não foi possível carregar os logins."); });
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
      db.doc("login/diretor").set({ nome: "Diretor", senha: senha, papel: "diretor" }).then(function(){
        $("setup-senha").value = "";
        $("setup-save").disabled = false;
        toast("Acesso de Diretor criado. Entre com a senha.");
      }).catch(function(){
        toast("Não foi possível criar o acesso. Tente de novo.");
        $("setup-save").disabled = false;
      });
    });

    $("login-btn").addEventListener("click", function(){
      var id = $("login-nome").value;
      var senha = $("login-senha").value;
      var entry = logins[id];
      hide($("login-error"));
      if (!entry || entry.senha !== senha){
        show($("login-error"));
        return;
      }
      me = { id: id, nome: entry.nome, papel: entry.papel };
      try { sessionStorage.setItem("painel-me", JSON.stringify(me)); } catch(e){}
      $("login-senha").value = "";
      watchLogins_apply();
    });

    $("logout-btn").addEventListener("click", function(){
      if (unsubMyEntries){ try{ unsubMyEntries(); }catch(e){} unsubMyEntries = null; }
      if (unsubMyCorretores){ try{ unsubMyCorretores(); }catch(e){} unsubMyCorretores = null; }
      if (unsubCorretoresAll){ try{ unsubCorretoresAll(); }catch(e){} unsubCorretoresAll = null; }
      Object.keys(unsubEntries).forEach(function(id){ try{ unsubEntries[id](); }catch(e){} });
      unsubEntries = {}; entriesByGerente = {};
      myCorretoresRaw = []; allCorretoresRaw = [];
      me = null; enteredAs = null;
      try { sessionStorage.removeItem("painel-me"); } catch(e){}
      watchLogins_apply();
    });

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
      $("role-badge").hidden = true; $("logout-btn").hidden = true;
      show($("view-setup"));
      return;
    }
    if (!me){
      enteredAs = null;
      hide($("view-setup")); hide($("view-gerente")); hide($("view-diretor"));
      $("role-badge").hidden = true; $("logout-btn").hidden = true;
      populateLoginSelect();
      show($("view-login"));
      return;
    }
    hide($("view-setup")); hide($("view-login"));
    $("role-badge").hidden = false; $("logout-btn").hidden = false;
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
    }
  }

  // ---------- gerente view ----------
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
        if (!showVgv) $("f-vgv").value = "";
        if (isVenda) $("f-vgv-label").textContent = "VGV da venda (R$)";
        else if (isProposta) $("f-vgv-label").textContent = "VGV estimado da proposta (R$)";
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
        var btn = $("f-submit");
        btn.disabled = true;
        var entry = {
          data: $("f-data").value,
          tipo: tipo,
          estoque: $("f-estoque").value,
          primeiraOuRecorrente: $("f-primeira").value,
          parceiro: $("f-parceiro").value.trim(),
          observacao: $("f-obs").value.trim(),
          criadoEm: new Date().toISOString()
        };
        if (needsVgv){
          var vgvVal = parseFloat(vgvRaw);
          entry.vgv = (isNaN(vgvVal) || vgvVal < 0) ? 0 : vgvVal;
        }
        db.collection("registros/" + me.id + "/entries").add(entry).then(function(){
          toast("Registrado.");
          $("f-tipo").value = ""; $("f-estoque").value = "";
          $("f-primeira").disabled = false;
          $("f-primeira").value = "Primeira vez"; $("f-parceiro").value = ""; $("f-obs").value = "";
          $("f-vgv-wrap").hidden = true; $("f-vgv").value = "";
          btn.disabled = false;
        }).catch(function(){
          toast("Não foi possível registrar. Tente de novo.");
          btn.disabled = false;
        });
      });
    }

    if (unsubMyEntries){ try{ unsubMyEntries(); }catch(e){} }
    unsubMyEntries = db.collection("registros/" + me.id + "/entries").onSnapshot(function(snap){
      myEntriesRaw = snap.docs.map(function(d){ return d.data(); });
      renderMeAll();
      renderMeLog(myEntriesRaw);
    }, function(){ toast("Não foi possível carregar seus registros."); });

    if (unsubMyCorretores){ try{ unsubMyCorretores(); }catch(e){} }
    unsubMyCorretores = db.collection("corretores/" + me.id).onSnapshot(function(snap){
      myCorretoresRaw = snap.docs.map(function(d){ return d.data(); });
      renderMeCorretores(myCorretoresRaw);
    }, function(){ toast("Não foi possível carregar os corretores."); });
  }

  function renderMeAll(){
    if (!me || me.papel !== "gerente") return;
    var bounds = periodBounds(meState);
    var filtered = filterEntries(myEntriesRaw, bounds, "");
    var prevFiltered = filterEntries(myEntriesRaw, previousPeriodBounds(meState), "");
    $("me-totals-title").textContent = "Totais — " + periodLabel(meState);
    renderMeTotals(filtered, prevFiltered, bounds);
    var chartEntries = (meState.pilarSel && PILAR_FILTERS[meState.pilarSel]) ? filtered.filter(PILAR_FILTERS[meState.pilarSel].pred) : filtered;
    renderPilarBars($("me-pilar-chart"), pilarCounts(chartEntries));
    renderNovoRecorrenteBars($("me-novo-chart"), novoRecorrenteCounts(chartEntries));
    renderTrendChart($("me-trend-chart"), dailyCounts(chartEntries, bounds), "Atividade ao longo do período");

    var wBounds = weekBounds();
    var w = computeWeek(myEntriesRaw, wBounds);
    $("me-week").innerHTML = '<p class="hint" style="margin-bottom:8px">Semana de ' + fmtRange(wBounds) + '</p>' + weekRowsHTML(w, metas);
  }

  function renderMeTotals(entries, prevEntries, bounds){
    var t = computeTotals(entries);
    var pt = computeTotals(prevEntries || []);
    var spark = function(pred, colorVar){ return sparklineSVG(dailyCounts(entries.filter(pred), bounds).map(function(d){ return d.value; }), colorVar); };
    var sel = meState.pilarSel;
    $("me-totals").innerHTML =
      statTile(t.visitas, "Visitas", deltaBadge(t.visitas, pt.visitas), spark(PILAR_FILTERS.visitas.pred, PILAR_FILTERS.visitas.color), "visitas", sel === "visitas") +
      statTile(t.treinamentos, "Treinamentos", deltaBadge(t.treinamentos, pt.treinamentos), spark(PILAR_FILTERS.treinamentos.pred, PILAR_FILTERS.treinamentos.color), "treinamentos", sel === "treinamentos") +
      statTile(t.propostas, "Propostas", deltaBadge(t.propostas, pt.propostas), spark(PILAR_FILTERS.propostas.pred, PILAR_FILTERS.propostas.color), "propostas", sel === "propostas") +
      statTile(t.vendas, "Vendas", deltaBadge(t.vendas, pt.vendas), spark(PILAR_FILTERS.vendas.pred, PILAR_FILTERS.vendas.color), "vendas", sel === "vendas");
    if ($("me-pilar-filter-note")) $("me-pilar-filter-note").innerHTML = pilarFilterNoteHTML(sel);

    var ticket = t.vendas ? (t.vgv / t.vendas) : 0;
    $("me-vgv-hero").innerHTML = heroKpi(
      fmtBRL(t.vgv),
      deltaBadge(t.vgv, pt.vgv),
      heroMini(t.vendas, "Vendas") + heroMini(fmtBRL(ticket), "Ticket médio") + heroMini(fmtBRL(t.vgvPropostas), "Potencial em propostas")
    );
  }

  function renderMeLog(entries){
    var sorted = entries.slice().sort(function(a,b){ return (b.criadoEm||"").localeCompare(a.criadoEm||""); }).slice(0,15);
    if (!sorted.length){ $("me-log").innerHTML = '<p class="empty">Nenhum registro ainda.</p>'; return; }
    $("me-log").innerHTML = sorted.map(function(e){ return logRowHTML(e); }).join("");
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
      '<div class="cc-head"><div class="cc-nome">' + renderEscaped(c.nome) + '</div>' + creciStatusPillHTML(c.creciValidado) + '</div>' +
      '<div class="cc-meta">' + atua + ' · ' + creci + '</div>' +
      (contactBits.length ? '<div class="cc-contact">' + contactBits.join(' · ') + '</div>' : "") +
      gerenteLine +
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
    }, function(){ toast("Não foi possível carregar os corretores."); });
  }

  function renderDiretorCorretores(){
    if (!me || me.papel !== "diretor") return;
    var list = allCorretoresRaw;
    var aValidar = list.filter(function(c){ return String(c.creciValidado || "").toLowerCase().indexOf("a validar") !== -1; }).length;
    var naoVinculados = list.filter(function(c){ return !c.gerenteId; }).length;
    $("d-corretores-resumo").innerHTML =
      statTile(list.length, "Corretores cadastrados") +
      statTile(aValidar, "CRECI a validar") +
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
    });
    if (metasWired) return;
    metasWired = true;
    $("m-save").addEventListener("click", function(){
      var novo = {
        plantao: Number($("m-plantao").value) || 0,
        visita: Number($("m-visita").value) || 0,
        apresentacao: Number($("m-apresentacao").value) || 0
      };
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

  function syncGerenteEntrySubscriptions(){
    var ids = Object.keys(logins).filter(function(id){ return logins[id].papel === "gerente"; });
    $("d-empty").hidden = ids.length > 0;
    ids.forEach(function(id){
      if (unsubEntries[id]) return;
      unsubEntries[id] = db.collection("registros/" + id + "/entries").onSnapshot(function(esnap){
        entriesByGerente[id] = esnap.docs.map(function(d){ return d.data(); });
        renderDiretorDashboard();
        renderTeamLog();
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
    renderTeamLog();
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
      var filtered = filterEntries(entriesByGerente[id] || [], bounds, dState.estoque);
      var t = computeTotals(filtered);
      agg.visitas += t.visitas; agg.treinamentos += t.treinamentos;
      agg.propostas += t.propostas; agg.vendas += t.vendas; agg.vgv += t.vgv; agg.vgvPropostas += t.vgvPropostas;
      var prevT = computeTotals(filterEntries(entriesByGerente[id] || [], prevBounds, dState.estoque));
      prevAgg.visitas += prevT.visitas; prevAgg.treinamentos += prevT.treinamentos;
      prevAgg.propostas += prevT.propostas; prevAgg.vendas += prevT.vendas; prevAgg.vgv += prevT.vgv; prevAgg.vgvPropostas += prevT.vgvPropostas;
      var nome = (logins[id] || {}).nome || id;
      var chartFiltered = pilarPred ? filtered.filter(pilarPred) : filtered;
      ranked.push({ id: id, label: nome, value: chartFiltered.length });
      var pc = pilarCounts(chartFiltered);
      grouped.push({ id: id, label: nome, visitas: pc["Visitas"], treinamento: pc["Treinamento"], venda: pc["Venda"] });
      allFiltered = allFiltered.concat(chartFiltered);
    });
    ranked.sort(function(a,b){ return b.value - a.value; });

    // os sparklines de cada card usam sempre o pilar do próprio card (não
    // mudam com o filtro — eles já SÃO o filtro de cada categoria).
    var allUnfiltered = [];
    ids.forEach(function(id){ allUnfiltered = allUnfiltered.concat(filterEntries(entriesByGerente[id] || [], bounds, dState.estoque)); });
    var spark = function(pred, colorVar){ return sparklineSVG(dailyCounts(allUnfiltered.filter(pred), bounds).map(function(d){ return d.value; }), colorVar); };
    $("d-kpi").innerHTML =
      statTile(agg.visitas, "Visitas", deltaBadge(agg.visitas, prevAgg.visitas), spark(PILAR_FILTERS.visitas.pred, PILAR_FILTERS.visitas.color), "visitas", sel === "visitas") +
      statTile(agg.treinamentos, "Treinamentos", deltaBadge(agg.treinamentos, prevAgg.treinamentos), spark(PILAR_FILTERS.treinamentos.pred, PILAR_FILTERS.treinamentos.color), "treinamentos", sel === "treinamentos") +
      statTile(agg.propostas, "Propostas", deltaBadge(agg.propostas, prevAgg.propostas), spark(PILAR_FILTERS.propostas.pred, PILAR_FILTERS.propostas.color), "propostas", sel === "propostas") +
      statTile(agg.vendas, "Vendas", deltaBadge(agg.vendas, prevAgg.vendas), spark(PILAR_FILTERS.vendas.pred, PILAR_FILTERS.vendas.color), "vendas", sel === "vendas");
    if ($("d-pilar-filter-note")) $("d-pilar-filter-note").innerHTML = pilarFilterNoteHTML(sel);

    var ticket = agg.vendas ? (agg.vgv / agg.vendas) : 0;
    $("d-vgv-hero").innerHTML = heroKpi(
      fmtBRL(agg.vgv),
      deltaBadge(agg.vgv, prevAgg.vgv),
      heroMini(agg.vendas, "Vendas") + heroMini(fmtBRL(ticket), "Ticket médio") + heroMini(fmtBRL(agg.vgvPropostas), "Potencial em propostas")
    );

    renderTrendChart($("d-trend-chart"), dailyCounts(allFiltered, bounds), "Atividade do time ao longo do período");
    renderPilarBars($("d-pilar-chart"), pilarCounts(allFiltered));
    renderNovoRecorrenteBars($("d-novo-chart"), novoRecorrenteCounts(allFiltered));
    renderRankedBarChart($("d-ranked-chart"), ranked);
    renderGroupedBarChart($("d-grouped-chart"), grouped);
  }

  function renderTeamLog(){
    if (!me || me.papel !== "diretor" || !dState.selected) return;
    var bounds = periodBounds(dState);
    var ids = Array.from(dState.selected);
    var all = [];
    ids.forEach(function(id){
      filterEntries(entriesByGerente[id] || [], bounds, dState.estoque).forEach(function(e){
        all.push({ e: e, who: (logins[id] || {}).nome });
      });
    });
    all.sort(function(a,b){ return (b.e.criadoEm||"").localeCompare(a.e.criadoEm||""); });
    all = all.slice(0, 30);
    if (!all.length){ $("d-log").innerHTML = '<p class="empty">Nenhum registro do time nesse filtro.</p>'; return; }
    $("d-log").innerHTML = all.map(function(x){ return logRowHTML(x.e, x.who); }).join("");
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
