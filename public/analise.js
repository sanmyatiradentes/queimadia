/* QueimadIA — análise de NDVI sob demanda (série, quebra, imagens, dNBR, proveniência) */
"use strict";
(function () {
  const A = {cenas: [], med: [], quebra: null, evento: null, rodando: false};
  const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
  const br = (v, d = 3) => v == null || Number.isNaN(v) ? "–" : Number(v).toLocaleString("pt-BR", {maximumFractionDigits: d});
  const dBR = s => s ? s.slice(0, 10).split("-").reverse().join("/") : "–";
  const iso = d => d.toISOString().slice(0, 10);
  const addDias = (s, n) => { const d = new Date(s + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
  const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const MIN_VALIDO = 0.5;

  // valores padrão: últimos 24 meses
  (function padrao() {
    const hoje = iso(new Date());
    $("#aFim").value = hoje; $("#aIni").value = addDias(hoje, -730);
    $("#aRefIni").value = $("#aIni").value; $("#aRefFim").value = addDias(hoje, -240);
  
  // ------------------------------------------------------------ análises pré-calculadas (modo estático)
  window.listarProntas = function () {
    const idx = window.Q?.est?.analises || {}, evs = window.Q?.eventos || [];
    const linhas = Object.entries(idx).map(([id, r]) => ({id, r, e: evs.find(x => x.id === id)})).filter(x => x.e)
      .sort((a, b) => b.e.ini.localeCompare(a.e.ini));
    $("#tabProntas").innerHTML = `<thead><tr><th>Pont.</th><th>Município</th><th>1º foco</th><th>Quebra</th><th>Relação</th><th>Queimado</th></tr></thead><tbody>`
      + linhas.map(({id, r, e}) => `<tr class="clicavel" data-id="${id}"><td><span class="pontos" style="background:${e.score >= 85 ? css("--s4") : css("--s3")}">${e.score}</span></td>
        <td>${e.mun}</td><td class="mono">${dBR(e.ini)}</td><td class="mono">${r.quebra ? dBR(r.quebra) : "–"}</td>
        <td>${{antes_do_fogo: '<span class="selo erro">antes do fogo</span>', no_fogo: '<span class="selo pend">junto com o fogo</span>'}[r.relacao] || ""}</td>
        <td class="n">${r.queimado_ha != null ? br(r.queimado_ha, 1) + " ha" : "–"}</td></tr>`).join("")
      + (linhas.length ? "" : `<tr><td colspan="6" class="nota">Nenhuma análise publicada ainda.</td></tr>`) + "</tbody>";
  };
  document.addEventListener("click", ev => { const tr = ev.target.closest("#tabProntas tr[data-id]"); if (tr) window.mostrarAnalisePronta(tr.dataset.id); });

  window.mostrarAnalisePronta = async function (id) {
    window.trocarAba("analise"); window.listarProntas();
    const base = window.QUEIMADIA_DADOS + "analises/";
    $("#aStatus").hidden = false; prog(0.3, 1, "Carregando análise pronta…");
    let r;
    try { r = await (await fetch(base + id + ".json?v=" + (window.Q?.versao || ""))).json(); }
    catch (e) { prog(0, 1, "Análise não encontrada."); return; }
    const ev = window.Q.eventos.find(x => x.id === id) || window.Q.alertas.find(x => x.id === id);
    A.evento = ev || {id, ini: r.evento.inicio, fim: r.evento.fim, mun: r.evento.municipio, score: r.evento.score};
    $("#aLat").value = r.area.lat; $("#aLon").value = r.area.lon; $("#aRaio").value = r.area.raio_m; $("#aLado").value = r.area.lado_m / 1000;
    [$("#aIni").value, $("#aFim").value] = r.periodo; [$("#aRefIni").value, $("#aRefFim").value] = r.linha_base;
    A.med = r.cenas; A.quebra = quebra(validas(), r.linha_base[0], r.linha_base[1]); A.dnbrRes = r.dnbr; A.pronta = r;
    $("#aTitulo").textContent = `${A.evento.mun || r.evento.municipio} · evento ${id} · calculada em ${dBR(r.gerado_em)}`;
    prog(1, 1, `${r.n_validas} observações válidas de ${r.cenas.length} cenas · ${r.metodo}`);
    $("#aSerieC").hidden = false; serie(); kpis(); calculo();
    // galeria estática
    const nomes = {rgb: "Cor real", ndvi: "NDVI"};
    $("#aGalC").hidden = false;
    $("#aGal").innerHTML = r.imagens.map(i => `<figure><a href="${base + i.arquivo}" target="_blank" rel="noopener"><img loading="lazy" src="${base + i.arquivo}" alt="${nomes[i.produto]} em ${dBR(i.data)}"></a>
      <figcaption><b>${nomes[i.produto] || i.produto}</b> · ${dBR(i.data)}${i.rotulo ? " · " + i.rotulo : ""}<br>${i.colecao.startsWith("sentinel") ? "Sentinel-2" : "Landsat"} · NDVI ${br(i.ndvi)}</figcaption></figure>`).join("");
    // dNBR estático
    $("#aDnbrC").hidden = !r.dnbr; $$("#aDnbrC .cab > div").forEach(d => d.hidden = true);
    if (r.dnbr) {
      const d = r.dnbr, cores = {"Não queimado": "#1a9850", "Baixa": "#fee08b", "Moderada-baixa": "#fdae61", "Moderada-alta": "#f46d43", "Alta": "#a50026"};
      $("#dRes").innerHTML = `<div class="painel-grade"><figure style="margin:0"><img style="width:100%;border-radius:8px;border:1px solid var(--cinza-borda)" src="${base + d.arquivo}" alt="dNBR">
        <div class="leg-dnbr">${Object.entries(cores).map(([k, c]) => `<span><i style="background:${c}"></i>${k}</span>`).join("")}<span><i style="background:#787c84"></i>Nuvem/sem dado</span></div></figure>
        <div><div class="indicadores"><div class="indicador vermelho"><b>${br(d.queimado_ha, 1)} ha</b><span>queimado (dNBR ≥ 0,27)</span></div>
        <div class="indicador azul"><b>${br(d.dnbr_mediana_nucleo)}</b><span>dNBR mediano no núcleo</span></div>
        <div class="indicador azul"><b>${Math.round(d.cobertura_valida * 100)}%</b><span>recorte com dado válido</span></div></div>
        <table class="tabela"><thead><tr><th>Classe (USGS)</th><th>Área (ha)</th></tr></thead><tbody>${Object.entries(d.areas_ha).map(([k, v]) => `<tr><td>${k}</td><td class="n">${br(v, 1)}</td></tr>`).join("")}</tbody></table>
        <div class="formula">dNBR = NBR(${dBR(d.antes)}) − NBR(${dBR(d.depois)})</div></div></div>`;
    }
    tabela();
    $("#aParecerC").hidden = false; $("#aParecer").hidden = true;
    const p = r.parecer || {};
    $("#aParecerTxt").innerHTML = p.texto
      ? `<div style="white-space:pre-wrap;color:var(--texto);font-size:14.5px">${p.texto.replace(/[&<>]/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;"}[c]))}</div><p class="nota" style="margin-top:8px">Texto gerado por IA (${p.modelo}) a partir dos números acima. Revise antes de usar.</p>`
      : `Parecer por IA não gerado para este evento${p.indisponivel ? " (" + p.indisponivel + ")" : ""}.`;
    window.miniMapa();
    window.rolarPara($("#aStatus"), true);
  };
})();
  for (const g of ["#aProd", "#aIdx"]) $(g).addEventListener("click", e => { const c = e.target.closest(".chip"); if (!c) return;
    if (g === "#aIdx") { $$("#aIdx .chip").forEach(x => x.setAttribute("aria-pressed", x === c)); return serie(); }
    c.setAttribute("aria-pressed", c.getAttribute("aria-pressed") !== "true"); });
  $$('[data-col]').forEach(c => c.addEventListener("click", () => c.setAttribute("aria-pressed", c.getAttribute("aria-pressed") !== "true")));
  document.querySelector('[data-painel="analise"]').addEventListener("keydown", e => { if ((e.key === "Enter" || e.key === " ") && e.target.classList.contains("chip")) { e.preventDefault(); e.target.click(); } });
  ["#aLat", "#aLon", "#aRaio"].forEach(s => $(s).addEventListener("change", () => window.miniMapa()));

  // ------------------------------------------------------------ mini mapa
  let mini;
  function circulo(lat, lon, r) {
    const pts = [], n = 64;
    for (let i = 0; i <= n; i++) { const a = i / n * 2 * Math.PI;
      pts.push([lon + (r / 111320 / Math.cos(lat * Math.PI / 180)) * Math.cos(a), lat + (r / 111320) * Math.sin(a)]); }
    return {type: "Feature", geometry: {type: "Polygon", coordinates: [pts]}};
  }
  window.miniMapa = function () {
    const lat = +$("#aLat").value, lon = +$("#aLon").value, r = +$("#aRaio").value, lado = +$("#aLado").value * 1000;
    const dados = {type: "FeatureCollection", features: [circulo(lat, lon, r)]};
    const g = lado / 2 / 111320, c = Math.cos(lat * Math.PI / 180);
    const caixa = {type: "Feature", geometry: {type: "Polygon", coordinates: [[[lon - g / c, lat - g], [lon + g / c, lat - g], [lon + g / c, lat + g], [lon - g / c, lat + g], [lon - g / c, lat - g]]]}};
    if (!mini) {
      mini = new maplibregl.Map({container: "miniMapa", center: [lon, lat], zoom: 12, attributionControl: false,
        style: {version: 8, sources: {s: {type: "raster", tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"], tileSize: 256}},
          layers: [{id: "s", type: "raster", source: "s"}]}});
      mini.on("load", () => {
        mini.addSource("c", {type: "geojson", data: dados}); mini.addSource("b", {type: "geojson", data: caixa});
        mini.addLayer({id: "b", type: "line", source: "b", paint: {"line-color": "#fff", "line-dasharray": [2, 2], "line-width": 1.2}});
        mini.addLayer({id: "c", type: "line", source: "c", paint: {"line-color": "#ffdf00", "line-width": 2.5}});
      });
      mini.on("click", ev => { $("#aLat").value = ev.lngLat.lat.toFixed(5); $("#aLon").value = ev.lngLat.lng.toFixed(5); window.miniMapa(); });
    } else if (mini.getSource("c")) {
      mini.getSource("c").setData(dados); mini.getSource("b").setData(caixa); mini.resize(); mini.easeTo({center: [lon, lat]});
    }
    window.Q?.mapa?.getSource("area")?.setData({type: "FeatureCollection", features: [circulo(lat, lon, r)]});
  };

  // ------------------------------------------------------------ abrir a partir do mapa/evento
  window.abrirAnalise = function (e) {
    $("#aLat").value = (+e.lat).toFixed(5); $("#aLon").value = (+e.lon).toFixed(5);
    const hoje = iso(new Date());
    if (e.ini) {
      const ini = e.ini.slice(0, 10), fim = e.fim.slice(0, 10);
      $("#aIni").value = addDias(ini, -730);
      const f = addDias(fim, 120); $("#aFim").value = f > hoje ? hoje : f;
      $("#aRefIni").value = $("#aIni").value; $("#aRefFim").value = addDias(ini, -60);
      A.evento = e;
    } else {
      A.evento = null;
      $("#aFim").value = hoje; $("#aIni").value = addDias(hoje, -730);
      $("#aRefIni").value = $("#aIni").value; $("#aRefFim").value = addDias(hoje, -240);
    }
    window.trocarAba("analise"); window.miniMapa();
    if (e.ini) rodar();
  };

  // ------------------------------------------------------------ execução
  function prog(i, n, txt) { $("#aProg").style.width = (n ? 100 * i / n : 0) + "%"; $("#aProgTxt").textContent = txt; }
  async function pool(itens, n, fn) {
    let k = 0; const res = new Array(itens.length);
    await Promise.all(Array.from({length: Math.min(n, itens.length)}, async () => { while (k < itens.length) { const i = k++; res[i] = await fn(itens[i], i); } }));
    return res;
  }
  $("#aRodar").onclick = () => rodar();
  async function rodar() {
    if (A.rodando) return;
    A.rodando = true; $("#aRodar").disabled = true;
    const lat = +$("#aLat").value, lon = +$("#aLon").value, raio = +$("#aRaio").value;
    const cols = $$('[data-col][aria-pressed="true"]').map(c => c.dataset.col);
    $("#aStatus").hidden = false; ["#aSerieC", "#aQuebraC", "#aGalC", "#aDnbrC", "#aTabC", "#aParecerC"].forEach(s => $(s).hidden = true);
    $("#aKpis").innerHTML = ""; A.med = []; A.quebra = null;
    $("#aTitulo").textContent = `Análise em ${lat.toFixed(4)}, ${lon.toFixed(4)} · raio ${raio} m`;
    window.rolarPara($("#aStatus"), true);
    try {
      prog(0, 1, "Buscando cenas no catálogo STAC…");
      const q = new URLSearchParams({lat, lon, inicio: $("#aIni").value, fim: $("#aFim").value, colecoes: cols.join(","), modo: $("#aModo").value, nuvem_max: $("#aNuvem").value});
      A.cenas = await (await fetch("api/cenas?" + q)).json();
      if (!Array.isArray(A.cenas) || !A.cenas.length) throw new Error("Nenhuma cena encontrada para o período e os satélites escolhidos.");
      $("#aSerieC").hidden = false;
      let feitos = 0;
      await pool(A.cenas, 6, async c => {
        const r = await fetch(`api/medir?colecao=${c.colecao}&id=${encodeURIComponent(c.id)}&lat=${lat}&lon=${lon}&raio_m=${raio}`).then(r => r.json()).catch(e => ({erro: String(e)}));
        A.med.push({...c, ...r}); feitos++;
        prog(feitos, A.cenas.length, `Medindo cenas: ${feitos} de ${A.cenas.length}`);
        if (feitos % 3 === 0 || feitos === A.cenas.length) serie();
      });
      A.med.sort((a, b) => a.data.localeCompare(b.data) || a.colecao.localeCompare(b.colecao));
      A.quebra = quebra(validas(), $("#aRefIni").value, $("#aRefFim").value);
      prog(1, 1, `Concluído: ${validas().length} observações válidas de ${A.cenas.length} cenas.`);
      serie(); kpis(); calculo(); galeria(); prepararDnbr(); tabela();
      $("#aParecerC").hidden = false;
      window.rolarPara($("#aConclusao"));
    } catch (e) {
      prog(0, 1, "Erro: " + e.message);
    } finally { A.rodando = false; $("#aRodar").disabled = false; }
  }
  const validas = () => A.med.filter(m => m.ndvi != null && m.frac_valida >= MIN_VALIDO);

  // ------------------------------------------------------------ quebra (método PolicIA, em JS para mostrar a conta)
  function quebra(serie, refIni, refFim) {
    if (serie.length < 6) return {detectada: false, motivo: "Série curta demais (menos de 6 observações válidas)."};
    const vals = serie.map(p => p.ndvi), datas = serie.map(p => p.data);
    let baseIdx = serie.map((p, i) => refIni <= p.data && p.data <= refFim ? i : -1).filter(i => i >= 0);
    if (!baseIdx.length) baseIdx = d3.range(Math.max(3, Math.floor(serie.length / 3)));
    const bv = baseIdx.map(i => vals[i]);
    const base = d3.median(bv), media = d3.mean(bv);
    const desv = bv.length > 1 ? Math.sqrt(d3.mean(bv, v => (v - media) ** 2)) : 0.05;   // desvio populacional (np.std)
    const limiar = base - Math.max(3 * desv, 0.15);
    const r = {base, desv, limiar, nBase: bv.length, baseVals: bv, baseDatas: baseIdx.map(i => datas[i]), refIni, refFim};
    for (let i = baseIdx[baseIdx.length - 1] + 1; i < vals.length - 1; i++) {
      if (vals[i] < limiar && vals[i + 1] < limiar) {
        const apos = d3.median(vals.slice(i, i + 3));
        return {...r, detectada: true, i, ultimaOk: datas[i - 1] || datas[0], primeira: datas[i], segunda: datas[i + 1], apos, queda: base - apos, v1: vals[i], v2: vals[i + 1]};
      }
    }
    return {...r, detectada: false, motivo: "Sem queda sustentada abaixo do limiar depois da linha de base."};
  }

  // ------------------------------------------------------------ gráfico da série
  function serie() {
    const idx = $("#aIdx .chip[aria-pressed=true]")?.dataset.i || "ndvi";
    const pts = A.med.filter(m => m[idx] != null).map(m => ({d: new Date(m.data + "T12:00:00Z"), v: m[idx], p10: m[idx + "_p10"], p90: m[idx + "_p90"],
      s2: m.colecao.startsWith("sentinel"), ok: m.frac_valida >= MIN_VALIDO, m})).sort((a, b) => a.d - b.d);
    const svg = d3.select("#gSerie"), w = Math.max(360, svg.node().parentNode.clientWidth), h = 300, mg = {l: 42, r: 14, t: 14, b: 28};
    svg.attr("width", w).attr("height", h).selectAll("*").remove();
    if (!pts.length) return;
    const x = d3.scaleTime().domain([new Date($("#aIni").value), new Date($("#aFim").value)]).range([mg.l, w - mg.r]);
    const y = d3.scaleLinear().domain([Math.min(-0.1, d3.min(pts, p => p.p10 ?? p.v)), 1]).nice().range([h - mg.b, mg.t]);
    svg.append("g").attr("transform", `translate(0,${h - mg.b})`).call(d3.axisBottom(x).ticks(Math.floor(w / 90)).tickFormat(d3.timeFormat("%m/%Y"))).call(a => a.select(".domain").attr("stroke", css("--cinza-borda")));
    svg.append("g").attr("transform", `translate(${mg.l},0)`).call(d3.axisLeft(y).ticks(6).tickSize(-(w - mg.l - mg.r))).call(a => a.select(".domain").remove()).call(a => a.selectAll("line").attr("stroke", css("--grade")));
    // linha de base
    const rb = [new Date($("#aRefIni").value), new Date($("#aRefFim").value)];
    svg.append("rect").attr("x", x(rb[0])).attr("width", Math.max(0, x(rb[1]) - x(rb[0]))).attr("y", mg.t).attr("height", h - mg.b - mg.t).attr("fill", css("--azul")).attr("opacity", .05);
    svg.append("text").attr("x", x(rb[0]) + 4).attr("y", mg.t + 11).text("linha de base");
    if (A.evento) { const a = x(new Date(A.evento.ini.slice(0, 10))), b = x(new Date(A.evento.fim.slice(0, 10)));
      svg.append("rect").attr("x", a - 2).attr("width", Math.max(4, b - a + 4)).attr("y", mg.t).attr("height", h - mg.b - mg.t).attr("fill", css("--dptc-vermelho")).attr("opacity", .2);
      svg.append("text").attr("x", a - 4).attr("y", mg.t + 24).attr("text-anchor", "end").text("focos").style("fill", css("--dptc-vermelho")); }
    const q = A.quebra;
    if (q && idx === "ndvi") {
      svg.append("line").attr("x1", mg.l).attr("x2", w - mg.r).attr("y1", y(q.base)).attr("y2", y(q.base)).attr("stroke", css("--verde")).attr("stroke-opacity", .6);
      svg.append("text").attr("x", w - mg.r - 4).attr("y", y(q.base) - 4).attr("text-anchor", "end").text(`base ${br(q.base)}`);
      svg.append("line").attr("x1", mg.l).attr("x2", w - mg.r).attr("y1", y(q.limiar)).attr("y2", y(q.limiar)).attr("stroke", css("--texto")).attr("stroke-dasharray", "5 4");
      svg.append("text").attr("x", w - mg.r - 4).attr("y", y(q.limiar) - 4).attr("text-anchor", "end").text(`limiar ${br(q.limiar)}`);
      if (q.detectada) { const a = x(new Date(q.ultimaOk)), b = x(new Date(q.primeira));
        svg.append("rect").attr("x", a).attr("width", Math.max(3, b - a)).attr("y", mg.t).attr("height", h - mg.b - mg.t).attr("fill", css("--azul-escuro")).attr("opacity", .15);
        svg.append("text").attr("x", b + 4).attr("y", mg.t + 38).text("quebra").style("fill", css("--azul-escuro")).style("font-weight", 700); }
    }
    const ok = pts.filter(p => p.ok);
    svg.append("path").datum(ok.filter(p => p.p10 != null)).attr("d", d3.area().x(p => x(p.d)).y0(p => y(p.p10)).y1(p => y(p.p90)).curve(d3.curveMonotoneX)).attr("fill", css("--verde")).attr("opacity", .08);
    svg.append("path").datum(ok).attr("d", d3.line().x(p => x(p.d)).y(p => y(p.v))).attr("fill", "none").attr("stroke", css("--verde")).attr("stroke-opacity", .5);
    const tip = p => `${dBR(p.m.data)} · ${p.s2 ? "Sentinel-2" : "Landsat"}\n${idx.toUpperCase()} ${br(p.v)} (p10 ${br(p.p10)} · p90 ${br(p.p90)})\nválidos ${Math.round(p.m.frac_valida * 100)}%`;
    svg.selectAll(".s2").data(pts.filter(p => p.s2)).join("circle").attr("cx", p => x(p.d)).attr("cy", p => y(p.v)).attr("r", 3.5)
      .attr("fill", p => p.ok ? css("--verde") : "#c9ced6").append("title").text(tip);
    svg.selectAll(".ls").data(pts.filter(p => !p.s2)).join("rect").attr("x", p => x(p.d) - 3.5).attr("y", p => y(p.v) - 3.5).attr("width", 7).attr("height", 7)
      .attr("fill", "#fff").attr("stroke", p => p.ok ? css("--azul") : "#c9ced6").attr("stroke-width", 1.6).append("title").text(tip);
    const lg = svg.append("g").attr("transform", `translate(${mg.l + 8},${h - mg.b - 12})`);
    lg.append("circle").attr("r", 3.5).attr("fill", css("--verde")); lg.append("text").attr("x", 8).attr("y", 4).text("Sentinel-2");
    lg.append("rect").attr("x", 82).attr("y", -3.5).attr("width", 7).attr("height", 7).attr("fill", "#fff").attr("stroke", css("--azul")).attr("stroke-width", 1.6); lg.append("text").attr("x", 94).attr("y", 4).text("Landsat 8/9");
    lg.append("circle").attr("cx", 180).attr("r", 3.5).attr("fill", "#c9ced6"); lg.append("text").attr("x", 188).attr("y", 4).text(`descartada (< ${MIN_VALIDO * 100}% válido)`);
  }

  // ------------------------------------------------------------ indicadores e cálculo
  function kpis() {
    const v = validas(), q = A.quebra, s2 = v.filter(m => m.colecao.startsWith("sentinel")).length;
    const ndvi = v.map(m => m.ndvi);
    $("#aKpis").innerHTML = [
      [q?.detectada ? dBR(q.primeira) : "Sem quebra", q?.detectada ? `quebra · após ${dBR(q.ultimaOk)}` : "no período analisado", "vermelho"],
      [q?.detectada ? br(q.queda) : "–", "queda de NDVI", "vermelho"],
      [br(q?.base), `NDVI de base (σ ${br(q?.desv)})`, "azul"],
      [`${v.length}`, `observações válidas (${s2} S2, ${v.length - s2} Landsat)`, "azul"],
      [`${br(d3.min(ndvi))} a ${br(d3.max(ndvi))}`, "NDVI mínimo a máximo", "ouro"],
      [br(d3.mean(ndvi)), "NDVI médio", "ouro"],
    ].map(([a, b, c]) => `<div class="indicador ${c}"><b style="${a.length > 9 ? "font-size:19px" : ""}">${a}</b><span>${b}</span></div>`).join("");
  }
  function conclusao() {
    const q = A.quebra, v = validas(), d = A.dnbrRes;
    let t = "";
    if (!v.length) t = "Não houve imagens sem nuvem suficientes para avaliar a vegetação neste local e período.";
    else if (q?.detectada) {
      t = `<b>A vegetação foi perdida.</b> O "verde" (NDVI) no local era ${br(q.base, 2)}, típico de ${q.base >= 0.75 ? "floresta" : "vegetação"}, e caiu para ${br(q.apos, 2)} entre ${dBR(q.ultimaOk)} e ${dBR(q.primeira)}.`;
      if (A.evento) { const ini = A.evento.ini.slice(0, 10);
        t += q.primeira < addDias(ini, -5) ? ` Isso aconteceu <b>antes</b> dos focos de calor (${dBR(ini)}): a vegetação já tinha sido derrubada quando o fogo apareceu, padrão típico de desmatamento seguido de queima.`
          : ` A queda coincide com os focos de calor (${dBR(ini)}).`; }
    } else t = `<b>Não houve perda sustentada de vegetação</b> no círculo de ${$("#aRaio").value} m. O "verde" (NDVI) ficou em torno de ${br(q?.base, 2)}. Pode ter sido fogo rasteiro, ou a queima ocorreu fora do círculo analisado.`;
    if (d?.queimado_ha != null) t += ` As imagens antes e depois indicam cerca de <b>${br(d.queimado_ha, 0)} hectares queimados</b> com intensidade moderada ou maior no recorte de ${$("#aLado").value} × ${$("#aLado").value} km.`;
    let el = $("#aConclusao");
    if (!el) { el = document.createElement("div"); el.id = "aConclusao"; el.className = "conclusao"; $("#aKpis").before(el); }
    el.innerHTML = t + `<div class="como-ler">Como ler: NDVI perto de 0,85 é floresta; abaixo de 0,5 é solo exposto ou área queimada. É um indício para orientar a investigação, não prova de crime.</div>`;
  }
  function calculo() {
    conclusao();
    const q = A.quebra; $("#aQuebraC").hidden = false;
    if (!q || q.motivo && !q.base) { $("#aCalc").textContent = q?.motivo || "–"; return; }
    const lista = q.baseVals.map((v, i) => `${dBR(q.baseDatas[i])}: ${br(v, 4)}`).join(" · ");
    let t = `<b>1. Linha de base</b> (${dBR(q.refIni)} a ${dBR(q.refFim)}): ${q.nBase} observações válidas
   ${lista}
<b>2. Mediana</b> = ${br(q.base, 4)}      <b>Desvio-padrão (σ)</b> = ${br(q.desv, 4)}
<b>3. Limiar</b> = base − max(3σ ; 0,15) = ${br(q.base, 4)} − max(${br(3 * q.desv, 4)} ; 0,15) = <b>${br(q.limiar, 4)}</b>
<b>4. Busca</b> após o fim da linha de base: primeira observação de duas seguidas abaixo de ${br(q.limiar, 4)}
`;
    t += q.detectada
      ? `   ${dBR(q.primeira)}: ${br(q.v1, 4)} < ${br(q.limiar, 4)}  e  ${dBR(q.segunda)}: ${br(q.v2, 4)} < ${br(q.limiar, 4)}  →  <b>quebra detectada</b>
<b>5. Data</b>: entre ${dBR(q.ultimaOk)} (última acima) e ${dBR(q.primeira)} (primeira abaixo)
<b>6. NDVI depois</b> (mediana das 3 primeiras abaixo) = ${br(q.apos, 4)}  →  <b>queda = ${br(q.queda, 4)}</b>`
      : `   ${q.motivo}`;
    if (A.evento && q.detectada) {
      const ini = A.evento.ini.slice(0, 10);
      const rel = q.primeira < addDias(ini, -5) ? "ANTES dos focos: a vegetação já tinha sido removida (padrão de derrubada seguida de queima)"
        : q.ultimaOk >= addDias(ini, -5) ? "JUNTO com os focos: queda causada pelo próprio fogo ou por derrubada imediatamente anterior" : "perto dos focos";
      t += `\n<b>7. Relação com o fogo</b> (1º foco em ${dBR(ini)}): ${rel}`;
    }
    $("#aCalc").innerHTML = t;
  }

  // ------------------------------------------------------------ galeria
  function escolherPeriodos(n) {
    const v = validas().filter(m => m.colecao.startsWith("sentinel") || !validas().some(o => o.colecao.startsWith("sentinel")));
    if (!v.length) return [];
    const q = A.quebra, marcas = new Map();
    marcas.set(v[0].data, "Início"); marcas.set(v[v.length - 1].data, "Fim");
    if (q?.detectada) {
      const antes = v.filter(m => m.data <= q.ultimaOk).pop(), depois = v.find(m => m.data >= q.primeira);
      if (antes) marcas.set(antes.data, "Antes da quebra"); if (depois) marcas.set(depois.data, "Depois da quebra");
    }
    for (let j = 1; marcas.size < n && j < n * 3; j++) {
      const m = v[Math.round(j * (v.length - 1) / (n))]; if (m && !marcas.has(m.data)) marcas.set(m.data, "");
    }
    return [...marcas.entries()].sort().slice(0, Math.max(n, 2)).map(([d, rot]) => ({...v.find(m => m.data === d), rotulo: rot}));
  }
  function galeria() {
    const prods = $$("#aProd .chip[aria-pressed=true]").map(c => c.dataset.p);
    const per = escolherPeriodos(+$("#aNRec").value);
    const lat = +$("#aLat").value, lon = +$("#aLon").value, raio = +$("#aRaio").value, lado = +$("#aLado").value * 1000;
    const nomes = {rgb: "Cor real", falsacor: "Falsa-cor", ndvi: "NDVI", nbr: "NBR", ndmi: "NDMI"};
    $("#aGalC").hidden = false;
    $("#aGal").innerHTML = per.flatMap(p => prods.map(pr => {
      const u = `api/imagem?colecao=${p.colecao}&id=${encodeURIComponent(p.id)}&lat=${lat}&lon=${lon}&lado_m=${lado}&produto=${pr}&raio_m=${raio}`;
      return `<figure><a href="${u}" target="_blank" rel="noopener"><img loading="lazy" src="${u}" alt="${nomes[pr]} em ${dBR(p.data)}"></a>
        <figcaption><b>${nomes[pr]}</b> · ${dBR(p.data)}${p.rotulo ? " · " + p.rotulo : ""}<br>${p.colecao.startsWith("sentinel") ? "Sentinel-2" : "Landsat"} · NDVI ${br(p.ndvi)}</figcaption></figure>`;
    })).join("") || `<p class="nota">Nenhum período com imagem válida.</p>`;
  }

  // ------------------------------------------------------------ dNBR
  function prepararDnbr() {
    const v = validas().filter(m => m.nbr != null);
    const op = v.map((m, i) => `<option value="${i}">${dBR(m.data)} · ${m.colecao.startsWith("sentinel") ? "S2" : "L8/9"} · NBR ${br(m.nbr)}</option>`).join("");
    $("#dA").innerHTML = op; $("#dB").innerHTML = op; A.pronta = null;
    $$("#aDnbrC .cab > div").forEach(d => d.hidden = false); $("#aParecer").hidden = false;
    const q = A.quebra;
    let ia = 0, ib = v.length - 1;
    if (q?.detectada) { ia = Math.max(0, v.findLastIndex(m => m.data <= q.ultimaOk)); ib = v.findIndex(m => m.data >= q.primeira); if (ib < 0) ib = v.length - 1; }
    else if (A.evento) { const ini = A.evento.ini.slice(0, 10), fim = A.evento.fim.slice(0, 10);
      ia = Math.max(0, v.findLastIndex(m => m.data < ini)); ib = v.findIndex(m => m.data > fim); if (ib < 0) ib = v.length - 1; }
    $("#dA").value = ia; $("#dB").value = ib; A.dnbrV = v;
    $("#aDnbrC").hidden = v.length < 2; $("#dRes").innerHTML = "";
    if (v.length >= 2) dnbr();
  }
  $("#dRodar").onclick = () => dnbr();
  async function dnbr() {
    const a = A.dnbrV[+$("#dA").value], b = A.dnbrV[+$("#dB").value];
    if (!a || !b) return;
    $("#dRes").innerHTML = `<p class="nota">Calculando dNBR entre ${dBR(a.data)} e ${dBR(b.data)}…</p>`;
    const q = new URLSearchParams({col_a: a.colecao, id_a: a.id, col_b: b.colecao, id_b: b.id, lat: $("#aLat").value, lon: $("#aLon").value,
      lado_m: +$("#aLado").value * 1000, raio_m: $("#aRaio").value});
    try {
      const r = await (await fetch("api/dnbr?" + q)).json();
      if (!r.png) throw new Error(r.detail || "falha");
      A.dnbrRes = {...r, antes: a.data, depois: b.data}; delete A.dnbrRes.png; conclusao();
      const cores = {"Não queimado": "#1a9850", "Baixa": "#fee08b", "Moderada-baixa": "#fdae61", "Moderada-alta": "#f46d43", "Alta": "#a50026"};
      $("#dRes").innerHTML = `<div class="painel-grade"><figure style="margin:0"><img style="width:100%;border-radius:8px;border:1px solid var(--cinza-borda)" src="data:image/png;base64,${r.png}" alt="dNBR">
        <div class="leg-dnbr">${Object.entries(cores).map(([k, c]) => `<span><i style="background:${c}"></i>${k}</span>`).join("")}<span><i style="background:#787c84"></i>Nuvem/sem dado</span></div></figure>
        <div><div class="indicadores"><div class="indicador vermelho"><b>${br(r.queimado_ha, 1)} ha</b><span>queimado (dNBR ≥ 0,27)</span></div>
        <div class="indicador azul"><b>${br(r.dnbr_mediana_nucleo)}</b><span>dNBR mediano no núcleo</span></div>
        <div class="indicador azul"><b>${Math.round(r.cobertura_valida * 100)}%</b><span>recorte com dado válido</span></div></div>
        <table class="tabela"><thead><tr><th>Classe (USGS)</th><th>Área (ha)</th></tr></thead><tbody>${Object.entries(r.areas_ha).map(([k, v]) => `<tr><td><i style="display:inline-block;width:10px;height:10px;background:${cores[k]};margin-right:6px"></i>${k}</td><td class="n">${br(v, 1)}</td></tr>`).join("")}</tbody></table>
        <div class="formula">dNBR = NBR(${dBR(a.data)}) − NBR(${dBR(b.data)}) · pixel = ${br(r.pixel_ha, 4)} ha</div></div></div>`;
    } catch (e) { $("#dRes").innerHTML = `<p class="nota">Não foi possível calcular o dNBR (${e.message}). Tente outro par de datas.</p>`; }
  }

  // ------------------------------------------------------------ tabela e exportação
  function tabela() {
    $("#aTabC").hidden = false;
    $("#aTab").innerHTML = `<thead><tr><th>Data</th><th>Satélite</th><th>NDVI</th><th>NBR</th><th>NDMI</th><th>Válido</th><th>Pixels</th><th>Nuvem cena</th><th>Baseline</th><th>Cena (ID)</th></tr></thead><tbody>`
      + A.med.map(m => `<tr style="${m.frac_valida >= MIN_VALIDO ? "" : "color:var(--cinza-texto)"}"><td class="mono">${dBR(m.data)}</td><td>${m.colecao.startsWith("sentinel") ? "Sentinel-2" : "Landsat " + (m.plataforma || "").replace("landsat-", "")}</td>
        <td class="n">${br(m.ndvi)}</td><td class="n">${br(m.nbr)}</td><td class="n">${br(m.ndmi)}</td><td class="n">${m.frac_valida != null ? Math.round(m.frac_valida * 100) + "%" : (m.erro ? "erro" : "–")}</td>
        <td class="n">${m.n_validos ?? "–"}</td><td class="n">${br(m.nuvem_cena, 1)}%</td><td class="mono">${m.baseline || "–"}</td><td class="mono" style="font-size:11px">${m.id}</td></tr>`).join("") + "</tbody>";
  }
  function proveniencia() {
    return {sistema: "QueimadIA (NIPED/PCAM/DPTC)", gerado_em: new Date().toISOString(),
      area: {lat: +$("#aLat").value, lon: +$("#aLon").value, raio_m: +$("#aRaio").value}, periodo: [$("#aIni").value, $("#aFim").value],
      linha_base: [$("#aRefIni").value, $("#aRefFim").value], modo: $("#aModo").value, min_fracao_valida: MIN_VALIDO,
      metodo: "NDVI = mediana dos pixels válidos no círculo; quebra pelo método do PolicIA (limiar = base − max(3σ; 0,15), ≥2 observações).",
      fonte: "Microsoft Planetary Computer (STAC): sentinel-2-l2a, landsat-c2-l2 (Landsat 8/9, Tier 1)",
      quebra: A.quebra && {...A.quebra, baseVals: undefined}, dnbr: A.dnbrRes || null, evento: A.evento && {id: A.evento.id, municipio: A.evento.mun, inicio: A.evento.ini, fim: A.evento.fim, pontuacao: A.evento.score},
      cenas: A.med};
  }
  const baixar = (n, t, tp) => { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([t], {type: tp})); a.download = n; a.click(); };
  $("#aJson").onclick = () => baixar(`queimadia_ndvi_${$("#aLat").value}_${$("#aLon").value}.json`, JSON.stringify(proveniencia(), null, 1), "application/json");
  $("#aCsv").onclick = () => baixar(`queimadia_ndvi_${$("#aLat").value}_${$("#aLon").value}.csv`, "﻿" + ["data;colecao;plataforma;ndvi;nbr;ndmi;frac_valida;n_validos;nuvem_cena;baseline;cena",
    ...A.med.map(m => [m.data, m.colecao, m.plataforma, m.ndvi, m.nbr, m.ndmi, m.frac_valida, m.n_validos, m.nuvem_cena, m.baseline, m.id].map(v => v ?? "").join(";"))].join("\n"), "text/csv");

  // ------------------------------------------------------------ parecer por IA
  $("#aParecer").onclick = async () => {
    $("#aParecer").disabled = true; $("#aParecerTxt").textContent = "Redigindo o parecer…";
    try {
      const r = await fetch("api/parecer", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(proveniencia())});
      const d = await r.json();
      if (!r.ok) throw new Error(d.detail || "indisponível");
      $("#aParecerTxt").innerHTML = `<div style="white-space:pre-wrap;color:var(--texto);font-size:14.5px">${d.texto.replace(/[&<>]/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;"}[c]))}</div><p class="nota" style="margin-top:8px">Texto gerado por IA (${d.modelo}) a partir dos números acima. Revise antes de usar.</p>`;
    } catch (e) { $("#aParecerTxt").textContent = "Parecer indisponível: " + e.message; }
    finally { $("#aParecer").disabled = false; }
  };

  // ------------------------------------------------------------ análises pré-calculadas (modo estático)
  window.listarProntas = function () {
    const idx = window.Q?.est?.analises || {}, evs = window.Q?.eventos || [];
    const linhas = Object.entries(idx).map(([id, r]) => ({id, r, e: evs.find(x => x.id === id)})).filter(x => x.e)
      .sort((a, b) => b.e.ini.localeCompare(a.e.ini));
    $("#tabProntas").innerHTML = `<thead><tr><th>Pont.</th><th>Município</th><th>1º foco</th><th>Quebra</th><th>Relação</th><th>Queimado</th></tr></thead><tbody>`
      + linhas.map(({id, r, e}) => `<tr class="clicavel" data-id="${id}"><td><span class="pontos" style="background:${e.score >= 85 ? css("--s4") : css("--s3")}">${e.score}</span></td>
        <td>${e.mun}</td><td class="mono">${dBR(e.ini)}</td><td class="mono">${r.quebra ? dBR(r.quebra) : "–"}</td>
        <td>${{antes_do_fogo: '<span class="selo erro">antes do fogo</span>', no_fogo: '<span class="selo pend">junto com o fogo</span>'}[r.relacao] || ""}</td>
        <td class="n">${r.queimado_ha != null ? br(r.queimado_ha, 1) + " ha" : "–"}</td></tr>`).join("")
      + (linhas.length ? "" : `<tr><td colspan="6" class="nota">Nenhuma análise publicada ainda.</td></tr>`) + "</tbody>";
  };
  document.addEventListener("click", ev => { const tr = ev.target.closest("#tabProntas tr[data-id]"); if (tr) window.mostrarAnalisePronta(tr.dataset.id); });

  window.mostrarAnalisePronta = async function (id) {
    window.trocarAba("analise"); window.listarProntas();
    const base = window.QUEIMADIA_DADOS + "analises/";
    $("#aStatus").hidden = false; prog(0.3, 1, "Carregando análise pronta…");
    let r;
    try { r = await (await fetch(base + id + ".json?v=" + (window.Q?.versao || ""))).json(); }
    catch (e) { prog(0, 1, "Análise não encontrada."); return; }
    const ev = window.Q.eventos.find(x => x.id === id) || window.Q.alertas.find(x => x.id === id);
    A.evento = ev || {id, ini: r.evento.inicio, fim: r.evento.fim, mun: r.evento.municipio, score: r.evento.score};
    $("#aLat").value = r.area.lat; $("#aLon").value = r.area.lon; $("#aRaio").value = r.area.raio_m; $("#aLado").value = r.area.lado_m / 1000;
    [$("#aIni").value, $("#aFim").value] = r.periodo; [$("#aRefIni").value, $("#aRefFim").value] = r.linha_base;
    A.med = r.cenas; A.quebra = quebra(validas(), r.linha_base[0], r.linha_base[1]); A.dnbrRes = r.dnbr; A.pronta = r;
    $("#aTitulo").textContent = `${A.evento.mun || r.evento.municipio} · evento ${id} · calculada em ${dBR(r.gerado_em)}`;
    prog(1, 1, `${r.n_validas} observações válidas de ${r.cenas.length} cenas · ${r.metodo}`);
    $("#aSerieC").hidden = false; serie(); kpis(); calculo();
    // galeria estática
    const nomes = {rgb: "Cor real", ndvi: "NDVI"};
    $("#aGalC").hidden = false;
    $("#aGal").innerHTML = r.imagens.map(i => `<figure><a href="${base + i.arquivo}" target="_blank" rel="noopener"><img loading="lazy" src="${base + i.arquivo}" alt="${nomes[i.produto]} em ${dBR(i.data)}"></a>
      <figcaption><b>${nomes[i.produto] || i.produto}</b> · ${dBR(i.data)}${i.rotulo ? " · " + i.rotulo : ""}<br>${i.colecao.startsWith("sentinel") ? "Sentinel-2" : "Landsat"} · NDVI ${br(i.ndvi)}</figcaption></figure>`).join("");
    // dNBR estático
    $("#aDnbrC").hidden = !r.dnbr; $$("#aDnbrC .cab > div").forEach(d => d.hidden = true);
    if (r.dnbr) {
      const d = r.dnbr, cores = {"Não queimado": "#1a9850", "Baixa": "#fee08b", "Moderada-baixa": "#fdae61", "Moderada-alta": "#f46d43", "Alta": "#a50026"};
      $("#dRes").innerHTML = `<div class="painel-grade"><figure style="margin:0"><img style="width:100%;border-radius:8px;border:1px solid var(--cinza-borda)" src="${base + d.arquivo}" alt="dNBR">
        <div class="leg-dnbr">${Object.entries(cores).map(([k, c]) => `<span><i style="background:${c}"></i>${k}</span>`).join("")}<span><i style="background:#787c84"></i>Nuvem/sem dado</span></div></figure>
        <div><div class="indicadores"><div class="indicador vermelho"><b>${br(d.queimado_ha, 1)} ha</b><span>queimado (dNBR ≥ 0,27)</span></div>
        <div class="indicador azul"><b>${br(d.dnbr_mediana_nucleo)}</b><span>dNBR mediano no núcleo</span></div>
        <div class="indicador azul"><b>${Math.round(d.cobertura_valida * 100)}%</b><span>recorte com dado válido</span></div></div>
        <table class="tabela"><thead><tr><th>Classe (USGS)</th><th>Área (ha)</th></tr></thead><tbody>${Object.entries(d.areas_ha).map(([k, v]) => `<tr><td>${k}</td><td class="n">${br(v, 1)}</td></tr>`).join("")}</tbody></table>
        <div class="formula">dNBR = NBR(${dBR(d.antes)}) − NBR(${dBR(d.depois)})</div></div></div>`;
    }
    tabela();
    $("#aParecerC").hidden = false; $("#aParecer").hidden = true;
    const p = r.parecer || {};
    $("#aParecerTxt").innerHTML = p.texto
      ? `<div style="white-space:pre-wrap;color:var(--texto);font-size:14.5px">${p.texto.replace(/[&<>]/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;"}[c]))}</div><p class="nota" style="margin-top:8px">Texto gerado por IA (${p.modelo}) a partir dos números acima. Revise antes de usar.</p>`
      : `Parecer por IA não gerado para este evento${p.indisponivel ? " (" + p.indisponivel + ")" : ""}.`;
    window.miniMapa();
    window.rolarPara($("#aStatus"), true);
  };
})();
