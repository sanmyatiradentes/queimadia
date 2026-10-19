/* QueimadIA — painel principal (mapa, filtros, ocorrências, tempo real, estatísticas) */
"use strict";
const Q = window.Q = {
  est: null, eventos: [], alertas: [], focos: [], ind: [], versao: null,
  filtrados: [], sel: null, layersOk: false, modoPonto: false,
};
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const fmt = n => (n ?? 0).toLocaleString("pt-BR");
const br = (v, d = 3) => v == null || Number.isNaN(v) ? "–" : Number(v).toLocaleString("pt-BR", {maximumFractionDigits: d});
const dBR = s => s ? s.slice(0, 10).split("-").reverse().join("/") : "–";
const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const nivel = s => s >= 85 ? "muito alta" : s >= 70 ? "alta" : s >= 50 ? "atenção" : "baixa";
const corScore = s => s >= 85 ? css("--s4") : s >= 70 ? css("--s3") : s >= 50 ? css("--s2") : css("--s1");
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"}[c]));
const IND_TXT = {
  desmatamento_previo: "Desmatamento prévio (DETER)", area_protegida: "TI ou UC de proteção integral",
  uso_sustentavel: "UC de uso sustentável", reincidencia: "Reincidência", multiplos_focos_dia: "≥3 focos no mesmo dia",
  periodo_proibitivo: "Período proibitivo", cicatriz_deter: "Cicatriz DETER",
};
// hora de Manaus (UTC−4)
const manaus = utc => { const d = new Date(utc.replace(" ", "T") + "Z"); d.setUTCHours(d.getUTCHours() - 4);
  return d.toISOString().slice(0, 16).replace("T", " "); };

// leva a tela até o conteúdo que acabou de abrir (no celular ele fica longe do clique)
function rolarPara(el, sempre) {
  if (!el) return;
  const estreito = matchMedia("(max-width:1100px)").matches;
  const r = el.getBoundingClientRect();
  if (!(sempre || estreito || r.top > innerHeight - 120 || r.top < 60)) return;
  const alvo = Math.max(0, r.top + scrollY - 72), inicio = scrollY, vez = (rolarPara.vez = (rolarPara.vez || 0) + 1);
  const suave = !matchMedia("(prefers-reduced-motion: reduce)").matches;
  scrollTo({top: alvo, behavior: suave ? "smooth" : "auto"});
  // plano B: se a rolagem suave não andar (aba em segundo plano, navegador antigo), salta direto
  setTimeout(() => { if (vez === rolarPara.vez && Math.abs(scrollY - inicio) < 2 && Math.abs(alvo - inicio) > 2) scrollTo(0, alvo); }, 700);
}
window.rolarPara = rolarPara;
function toast(msg, ms = 5000) { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(t._t); t._t = setTimeout(() => t.hidden = true, ms); }

async function json(url) { if (url.startsWith("dados/")) url = window.QUEIMADIA_DADOS + url.slice(6); const r = await fetch(url + (url.includes("?") ? "&" : "?") + "v=" + (Q.versao || Date.now())); if (!r.ok) throw new Error(url + " " + r.status); return r.json(); }

function descompactar(d) {
  Q.ind = d.indicadores;
  return d.eventos.map(a => ({id: a[0], lat: a[1], lon: a[2], score: a[3], n: a[4], maxDia: a[5], ini: a[6], fim: a[7],
    mun: a[8], dist: a[9], mask: a[10], det: a[11] || {}, sats: a[12] || [], ia: a[13],
    ind: Q.ind.filter((k, i) => a[10] & (1 << i))}));
}

// ------------------------------------------------------------ carga e tempo real
async function carregar(primeira) {
  const est = await json("dados/estatisticas.json");
  const mudou = est.versao !== Q.versao;
  Q.est = est;
  if (mudou) {
    const antesAlertas = Q.alertas.length;
    Q.versao = est.versao;
    const [ev, al, fo] = await Promise.all([json("dados/eventos.json"), json("dados/alertas.json"), json("dados/focos_recentes.json")]);
    Q.eventos = descompactar(ev); Q.alertas = descompactar(al); Q.focos = fo.focos;
    if (!primeira) toast(`Dados atualizados: ${fmt(Q.focos.length)} focos nos últimos 7 dias, ${fmt(Q.alertas.length)} alertas (${Q.alertas.length - antesAlertas >= 0 ? "+" : ""}${Q.alertas.length - antesAlertas}).`);
    if (primeira) montarFiltros();
    aplicar();
    if (Q.layersOk) atualizarCamadasDados();
  }
  statusAoVivo();
}
function statusAoVivo() {
  const el = $("#aoVivo"), st = Q.est;
  if (!st) return;
  const min = Math.round((Date.now() - new Date(st.gerado_em)) / 60000);
  el.classList.toggle("atrasado", min > 30);
  $("#aoVivoTxt").textContent = min <= 1 ? "Ao vivo · atualizado agora" : `Ao vivo · atualizado há ${min} min`;
  $("#nAlertas").textContent = fmt(Q.alertas.length);
}
setInterval(() => carregar(false).catch(() => {}), 60000);
setInterval(statusAoVivo, 30000);

// ------------------------------------------------------------ filtros
const F = {ini: "", fim: "", score: 50, mun: "", dist: 0, area: "", busca: "", ind: new Set()};
function periodo(v) {
  const hoje = new Date(), iso = d => d.toISOString().slice(0, 10), ano = hoje.getFullYear();
  if (/^\d+$/.test(v)) { const d = new Date(hoje); d.setDate(d.getDate() - +v); return [iso(d), iso(hoje)]; }
  if (v.startsWith("ano")) { const a = ano - +v.slice(3); return [`${a}-01-01`, `${a}-12-31`]; }
  if (v === "tudo") return ["2023-01-01", iso(hoje)];
  return [F.ini, F.fim];
}
function montarFiltros() {
  const muns = [...new Set(Q.eventos.map(e => e.mun).filter(Boolean))].sort((a, b) => a.localeCompare(b, "pt"));
  $("#fMun").insertAdjacentHTML("beforeend", muns.map(m => `<option>${esc(m)}</option>`).join(""));
  $("#fInd").innerHTML = Q.ind.map(k => `<span class="chip" role="button" tabindex="0" aria-pressed="false" data-k="${k}">${IND_TXT[k] || k}</span>`).join("");
  [F.ini, F.fim] = periodo("ano0"); $("#fIni").value = F.ini; $("#fFim").value = F.fim;
  $("#fPreset").onchange = e => { if (e.target.value !== "custom") { [F.ini, F.fim] = periodo(e.target.value); $("#fIni").value = F.ini; $("#fFim").value = F.fim; aplicar(); } };
  $("#fIni").onchange = e => { F.ini = e.target.value; $("#fPreset").value = "custom"; aplicar(); };
  $("#fFim").onchange = e => { F.fim = e.target.value; $("#fPreset").value = "custom"; aplicar(); };
  const mostraNivel = v => { const n = $("#fScoreN"); n.textContent = nivel(v); n.style.background = corScore(v); };
  mostraNivel(F.score);
  $("#fScore").oninput = e => { F.score = +e.target.value; $("#fScoreV").textContent = e.target.value; mostraNivel(F.score); aplicar(); };
  $("#btnMais").onclick = () => { const m = $("#filtrosMais"); m.hidden = !m.hidden; $("#btnMais").setAttribute("aria-expanded", !m.hidden); $("#btnMais").textContent = m.hidden ? "Mais filtros" : "Menos filtros"; };
  $("#fMun").onchange = e => { F.mun = e.target.value; aplicar(true); };
  $("#fDist").onchange = e => { F.dist = +e.target.value; aplicar(true); };
  $("#fArea").onchange = e => { F.area = e.target.value; aplicar(); };
  let tb; $("#fBusca").oninput = e => { clearTimeout(tb); tb = setTimeout(() => { F.busca = e.target.value.trim().toLowerCase(); aplicar(); }, 250); };
  $("#fInd").onclick = e => { const c = e.target.closest(".chip"); if (!c) return; const on = c.getAttribute("aria-pressed") !== "true";
    c.setAttribute("aria-pressed", on); on ? F.ind.add(c.dataset.k) : F.ind.delete(c.dataset.k); aplicar(); };
  ligarChips($("#fInd"));
}
function ligarChips(raiz) { raiz.addEventListener("keydown", e => { if ((e.key === "Enter" || e.key === " ") && e.target.classList.contains("chip")) { e.preventDefault(); e.target.click(); } }); }
function passa(e, ignorarScore, ignorarPeriodo) {
  const d = e.ini.slice(0, 10);
  if (!ignorarPeriodo && F.ini && d < F.ini) return false;
  if (!ignorarPeriodo && F.fim && d > F.fim) return false;
  if (!ignorarScore && e.score < F.score) return false;
  if (F.mun && e.mun !== F.mun) return false;
  if (F.dist && e.dist > F.dist) return false;
  if (F.area === "ti" && !e.det.ti) return false;
  if (F.area === "uc" && !e.det.uc) return false;
  if (F.area === "fora" && (e.det.ti || e.det.uc)) return false;
  for (const k of F.ind) if (!e.ind.includes(k)) return false;
  if (F.busca) { const t = `${e.id} ${e.mun} ${e.det.ti || ""} ${e.det.uc || ""}`.toLowerCase(); if (!t.includes(F.busca)) return false; }
  return true;
}
function aplicar(enquadrar) {
  Q.filtrados = Q.eventos.filter(e => passa(e)).sort((a, b) => b.score - a.score || (b.ia || 0) - (a.ia || 0) || b.n - a.n);
  Q.alertasF = Q.alertas.filter(e => passa(e, false, true));
  kpis(); fila(); ocorrencias(); tempoReal(); if (!$('[data-painel="estatisticas"]').hidden) estatisticas();
  if (Q.layersOk) { atualizarCamadasDados(); if (enquadrar) enquadrarFiltro(); }
}

// ------------------------------------------------------------ indicadores
function kpis() {
  const f = Q.filtrados, todos = Q.eventos.filter(e => passa(e, true));
  const focos = todos.reduce((t, e) => t + e.n, 0);
  const alta = todos.filter(e => e.score >= 70).length;
  const perto = todos.filter(e => e.score >= 70 && e.dist <= 250).length;
  const prot = f.filter(e => e.det.ti || e.det.uc).length;
  $("#kpis").innerHTML = [
    [fmt(focos), "focos de calor no período", "azul", "Pontos de calor detectados pelo satélite de referência do INPE."],
    [fmt(todos.length), "eventos de fogo", "azul", "Focos próximos no espaço e no tempo foram agrupados: cada evento é um incêndio."],
    [fmt(alta), "com suspeita alta (70+)", "vermelho fogo", "Eventos com vários sinais de ação intencional."],
    [fmt(perto), "suspeitos perto de Manaus", "vermelho fogo", "Suspeita alta a até 250 km de Manaus, onde a fumaça mais afeta a população."],
    [fmt(prot), "em terra indígena ou reserva", "ouro", "Eventos da lista atual dentro de TI ou unidade de conservação."],
    [fmt(Q.alertasF ? Q.alertasF.length : 0), "alertas dos últimos 7 dias", "ouro", "Detecções recentes dos satélites VIIRS, atualizadas a cada 10 minutos."],
  ].map(([v, t, c, d]) => `<div class="indicador ${c}" title="${d}"><b>${v}</b><span>${t} <span class="info" aria-label="${d}">?</span></span></div>`).join("");
}

// ------------------------------------------------------------ fila
function fila() {
  const f = Q.filtrados;
  $("#nFila").textContent = `${fmt(f.length)} eventos`;
  $("#fila").innerHTML = f.slice(0, 300).map(e => `<button type="button" class="linha${e.id === Q.sel ? " sel" : ""}" role="option" data-id="${e.id}">
    <span class="pontos" style="background:${corScore(e.score)}">${e.score}</span>
    <span style="min-width:0"><span class="t">${esc(e.mun)}${e.det.ti ? " · " + esc(e.det.ti) : e.det.uc ? " · " + esc(e.det.uc) : ""}</span><br>
    <span class="s num">${dBR(e.ini)} · ${e.n} foco${e.n > 1 ? "s" : ""} · ${fmt(e.dist)} km de Manaus</span></span>
    ${e.ia != null ? `<span class="selo" title="Atipicidade estimada pelo modelo de IA (0–100)">IA ${e.ia}</span>` : "<span></span>"}</button>`).join("")
    + (f.length > 300 ? `<p class="nota" style="padding:10px 14px">Mostrando 300 de ${fmt(f.length)}. Refine os filtros ou veja todas em Ocorrências.</p>` : "")
    + (!f.length ? `<p class="nota" style="padding:14px">Nenhum evento com esses filtros. Reduza a pontuação mínima ou amplie o período.</p>` : "");
}
$("#fila").addEventListener("click", e => { const b = e.target.closest(".linha"); if (b) { selecionar(b.dataset.id, true); rolarPara($("#ficha")); } });

// ------------------------------------------------------------ ficha
function selecionar(id, voar) {
  const e = Q.eventos.find(x => x.id === id) || Q.alertas.find(x => x.id === id);
  if (!e) return;
  Q.sel = id;
  $$("#fila .linha").forEach(l => l.classList.toggle("sel", l.dataset.id === id));
  if (Q.mapa) {
    if (voar) Q.mapa.flyTo({center: [e.lon, e.lat], zoom: Math.max(Q.mapa.getZoom(), 12), speed: 1.4});
    Q.mapa.getSource("sel")?.setData({type: "FeatureCollection", features: [{type: "Feature", geometry: {type: "Point", coordinates: [e.lon, e.lat]}}]});
  }
  const d = e.det, P = Q.est.pesos, D = Q.est.descricao_indicadores;
  const linhas = Q.ind.map(k => { const on = e.ind.includes(k); let extra = "";
    if (k === "desmatamento_previo" && d.desmatamento) extra = ` · ${d.desmatamento.alertas} alerta(s), ${br(d.desmatamento.area_km2)} km², ${d.desmatamento.dias_antes} dias antes`;
    if (k === "reincidencia" && d.anos_anteriores?.length) extra = ` · anos: ${d.anos_anteriores.join(", ")}`;
    if (k === "multiplos_focos_dia") extra = ` · máx. ${e.maxDia}/dia`;
    if (k === "cicatriz_deter" && d.cicatriz_km2 != null) extra = ` · ${br(d.cicatriz_km2)} km² em ${dBR(d.cicatriz_data)}`;
    return `<div class="ind-linha ${on ? "" : "off"}"><span class="mk">${on ? "✓" : "–"}</span><span>${D[k][0]}<small>${D[k][1]}${on ? extra : ""}</small></span><span class="w">${on ? "+" : ""}${P[k]}</span></div>`; }).join("");
  const calc = e.ind.map(k => `${P[k]} (${IND_TXT[k]})`).join(" + ") || "0";
  const motivos = [];
  if (d.desmatamento) motivos.push(`houve desmatamento detectado pelo DETER ${d.desmatamento.dias_antes <= 0 ? "no mesmo período do fogo" : d.desmatamento.dias_antes + " dias antes do fogo"} (${br(d.desmatamento.area_km2 * 100, 1)} ha)`);
  if (d.ti) motivos.push(`fica dentro da ${d.ti}`);
  else if (d.uc) motivos.push(`fica dentro da ${d.uc}${d.uc_grupo === "PI" ? ", área de proteção integral" : " (uso sustentável, onde a roça tradicional é permitida)"}`);
  if (d.anos_anteriores?.length >= 2) motivos.push(`o mesmo local já pegou fogo em ${d.anos_anteriores.join(", ")}`);
  if (e.maxDia >= 3) motivos.push(`${e.maxDia} focos surgiram no mesmo dia`);
  if (e.ind.includes("cicatriz_deter")) motivos.push("o DETER confirmou a cicatriz de queimada");
  if (e.ind.includes("periodo_proibitivo")) motivos.push("começou no período de proibição do fogo");
  const junta = l => l.length > 1 ? l.slice(0, -1).join("; ") + " e " + l[l.length - 1] : l[0];
  const porque = motivos.length
    ? `<div class="porque"><b>Por que está na lista:</b> ${junta(motivos)}. Suspeita <b>${nivel(e.score)}</b> (${e.score} de 100 pontos).</div>`
    : `<div class="porque calmo">Nenhum sinal forte de ação intencional foi encontrado nas bases públicas. Suspeita <b>${nivel(e.score)}</b> (${e.score} de 100).</div>`;
  const lat = e.lat.toFixed(5), lon = e.lon.toFixed(5);
  $("#ficha").hidden = false;
  $("#ficha").innerHTML = `
    <div class="cab"><div class="ficha-top"><span class="pontos" style="background:${corScore(e.score)}">${e.score}</span>
      <div><span class="nota">Evento ${esc(e.id)} · ${e.id.startsWith("T") ? "alerta em tempo real (VIIRS)" : "satélite de referência"}</span>
      <h2 style="font-size:20px">${esc(e.mun)}, ${dBR(e.ini)}${e.fim.slice(0, 10) !== e.ini.slice(0, 10) ? " a " + dBR(e.fim) : ""}</h2>
      <span class="muted">${esc(d.ti || d.uc || "Fora de TI/UC")}${d.uc && d.ti ? " · " + esc(d.uc) : ""}</span></div></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">${Q.est.analises?.[e.id] ? `<button type="button" class="botao fogo" id="fPronta">Ver análise NDVI${Q.est.analises[e.id].quebra ? " · quebra " + dBR(Q.est.analises[e.id].quebra) : ""}</button>` : ""}
      ${Q.estatico ? (Q.est.analises?.[e.id] ? "" : `<span class="selo pend" title="O motor calcula a análise de NDVI dos eventos com pontuação ≥ 70, começando pelos mais recentes e mais perto de Manaus.">NDVI na fila de cálculo</span>`) : `<button type="button" class="botao ${Q.est.analises?.[e.id] ? "secundario" : "fogo"}" id="fAnalisar">Analisar NDVI agora</button>`}
      <button type="button" class="botao secundario" id="fCopiar">Copiar resumo</button></div></div>
    ${porque}
    <div class="fatos">
      <div><span>Focos</span><b>${e.n}</b></div><div><span>Máx. no mesmo dia</span><b>${e.maxDia}</b></div>
      <div><span>Primeiro foco (UTC)</span><b>${e.ini}</b></div><div><span>Último foco (UTC)</span><b>${e.fim}</b></div>
      <div><span>Distância de Manaus</span><b>${fmt(e.dist)} km</b></div><div><span>Coordenadas</span><b>${lat}, ${lon}</b></div>
      <div><span>Satélites</span><b>${esc(e.sats.join(", ") || "AQUA_M-T")}</b></div>
      ${e.ia != null ? `<div><span>Atipicidade (IA)</span><b>${e.ia}/100</b></div>` : ""}
    </div>
    <div class="painel-grade">
      <div><h3 style="margin-bottom:6px">Os sinais verificados, um a um</h3>${linhas}
        <div class="formula">pontuação = ${calc} = <b>${e.score}</b></div></div>
      <div><h3 style="margin-bottom:6px">Conferir nas fontes públicas</h3>
        <div class="links">
          <a class="botao secundario pequeno" target="_blank" rel="noopener" href="https://terrabrasilis.dpi.inpe.br/queimadas/bdqueimadas/">BDQueimadas (INPE)</a>
          <a class="botao secundario pequeno" target="_blank" rel="noopener" href="https://terrabrasilis.dpi.inpe.br/app/map/deter-amz">DETER (TerraBrasilis)</a>
          <a class="botao secundario pequeno" target="_blank" rel="noopener" href="https://firms.modaps.eosdis.nasa.gov/map/#d:24hrs;@${lon},${lat},13.0z">NASA FIRMS</a>
          <a class="botao secundario pequeno" target="_blank" rel="noopener" href="https://plataforma.brasil.mapbiomas.org/">MapBiomas</a>
          <a class="botao secundario pequeno" target="_blank" rel="noopener" href="https://apps.sentinel-hub.com/eo-browser/?zoom=14&lat=${lat}&lng=${lon}">EO Browser (Sentinel)</a>
          <a class="botao secundario pequeno" target="_blank" rel="noopener" href="https://www.google.com/maps/@${lat},${lon},2000m/data=!3m1!1e3">Google Satélite</a>
          <a class="botao secundario pequeno" target="_blank" rel="noopener" href="https://consultapublica.car.gov.br/publico/imoveis/index">Consulta CAR</a>
          <a class="botao secundario pequeno" target="_blank" rel="noopener" href="https://servicos.ibama.gov.br/ctf/publico/areasembargadas/ConsultaPublicaAreasEmbargadas.php">Embargos IBAMA</a>
        </div>
        <p class="nota" style="margin-top:10px">A pontuação soma indicadores objetivos de fontes públicas e orienta onde aprofundar a investigação. Não substitui a perícia de local nem os procedimentos legais.</p></div>
    </div>`;
  if ($("#fAnalisar")) $("#fAnalisar").onclick = () => window.abrirAnalise?.(e);
  if ($("#fPronta")) $("#fPronta").onclick = () => window.mostrarAnalisePronta?.(e.id);
  $("#fCopiar").onclick = () => { const t = `QueimadIA ${e.id} — ${e.mun}, ${dBR(e.ini)}. Pontuação ${e.score} (${e.ind.map(k => IND_TXT[k]).join("; ") || "sem indicadores"}). ${e.n} focos, ${lat}, ${lon}. ${d.ti || d.uc || ""}`;
    navigator.clipboard?.writeText(t).then(() => toast("Resumo copiado."), () => toast(t, 10000)); };
}

// ------------------------------------------------------------ mapa
const BASES = {
  mapa: {nome: "Mapa (OpenStreetMap)", tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"], attr: "© OpenStreetMap"},
  satelite: {nome: "Satélite (Esri)", tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"], attr: "Esri, Maxar, Earthstar"},
  topo: {nome: "Topográfico (Esri)", tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}"], attr: "Esri"},
  claro: {nome: "Claro (CARTO)", tiles: ["https://basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png"], attr: "© CARTO © OSM"},
  escuro: {nome: "Escuro (CARTO)", tiles: ["https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png"], attr: "© CARTO © OSM"},
  s2rgb: {nome: "Sentinel-2 recente (cor real)", pc: "rgb"},
  s2ndvi: {nome: "Sentinel-2 recente (NDVI)", pc: "ndvi"},
  s2falsa: {nome: "Sentinel-2 recente (falsa-cor SWIR)", pc: "falsacor"},
};
const CAMADAS = [
  ["eventos", "Eventos (referência)", "#c8302f", true], ["alertas", "Alertas tempo real (VIIRS)", "#ff7a00", true],
  ["focos", "Focos 7 dias (todos)", "#ffb000", false], ["calor", "Mapa de calor dos eventos", "#e07b2a", false],
  ["desmat", "DETER desmatamento", "#8e44ad", false], ["cicat", "DETER cicatriz de queimada", "#5d4037", false],
  ["tis", "Terras indígenas", "#b8860b", true], ["ucs", "Unidades de conservação", "#0a7a36", true],
  ["mun", "Municípios", "#5b6675", true],
];
async function iniciarMapa() {
  const m = Q.mapa = new maplibregl.Map({container: "mapa", center: [-62.5, -4.3], zoom: 5, maxZoom: 18, attributionControl: {compact: true},
    style: {version: 8, glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf", sources: {}, layers: [{id: "fundo", type: "background", paint: {"background-color": "#dfe5ee"}}]}});
  m.addControl(new maplibregl.NavigationControl(), "bottom-left");
  m.addControl(new maplibregl.ScaleControl({unit: "metric"}), "bottom-left");
  m.addControl(new maplibregl.FullscreenControl(), "bottom-left");
  await new Promise(r => m.on("load", r));
  for (const [k, b] of Object.entries(BASES)) if (b.tiles) m.addSource("base-" + k, {type: "raster", tiles: b.tiles, tileSize: 256, attribution: b.attr, maxzoom: 19});
  m.addLayer({id: "base", type: "raster", source: "base-satelite"});
  const vazio = {type: "FeatureCollection", features: []};
  const [mun, tis, ucs] = await Promise.all(["municipios", "tis", "ucs"].map(n => json(`dados/${n}.json`)));
  m.addSource("mun", {type: "geojson", data: mun}); m.addSource("tis", {type: "geojson", data: tis}); m.addSource("ucs", {type: "geojson", data: ucs});
  m.addSource("deter", {type: "geojson", data: vazio});
  ["eventos", "alertas", "focos", "sel", "area"].forEach(s => m.addSource(s, {type: "geojson", data: vazio}));
  m.addLayer({id: "tis", type: "fill", source: "tis", paint: {"fill-color": "#b8860b", "fill-opacity": .08, "fill-outline-color": "#b8860b"}});
  m.addLayer({id: "tis-l", type: "line", source: "tis", paint: {"line-color": "#d4a017", "line-width": 1.3, "line-dasharray": [3, 2]}});
  m.addLayer({id: "ucs", type: "fill", source: "ucs", paint: {"fill-color": "#0a7a36", "fill-opacity": .07}});
  m.addLayer({id: "ucs-l", type: "line", source: "ucs", paint: {"line-color": "#2fbf71", "line-width": 1.2, "line-dasharray": [1, 1.5]}});
  m.addLayer({id: "mun", type: "line", source: "mun", paint: {"line-color": "#ffffff", "line-opacity": .55, "line-width": .7}});
  m.addLayer({id: "desmat", type: "fill", source: "deter", filter: ["!=", ["get", "c"], "CICATRIZ_DE_QUEIMADA"], paint: {"fill-color": "#8e44ad", "fill-opacity": .55}, layout: {visibility: "none"}});
  m.addLayer({id: "cicat", type: "fill", source: "deter", filter: ["==", ["get", "c"], "CICATRIZ_DE_QUEIMADA"], paint: {"fill-color": "#5d4037", "fill-opacity": .6}, layout: {visibility: "none"}});
  m.addLayer({id: "calor", type: "heatmap", source: "eventos", layout: {visibility: "none"}, paint: {"heatmap-weight": ["/", ["get", "score"], 100], "heatmap-radius": 18, "heatmap-intensity": 1.2,
    "heatmap-color": ["interpolate", ["linear"], ["heatmap-density"], 0, "rgba(0,0,0,0)", .2, "#e9b949", .5, "#e07b2a", .8, "#c8302f", 1, "#7a1420"]}});
  m.addLayer({id: "focos", type: "circle", source: "focos", layout: {visibility: "none"}, paint: {"circle-radius": ["interpolate", ["linear"], ["zoom"], 5, 1.6, 12, 4], "circle-color": "#ffb000", "circle-stroke-color": "#4a2c00", "circle-stroke-width": .4}});
  const raio = ["interpolate", ["linear"], ["zoom"], 4, ["+", 2, ["*", .6, ["sqrt", ["get", "n"]]]], 12, ["+", 6, ["*", 1.6, ["sqrt", ["get", "n"]]]]];
  m.addLayer({id: "eventos", type: "circle", source: "eventos", paint: {"circle-radius": raio,
    "circle-color": ["step", ["get", "score"], css("--s1"), 50, css("--s2"), 70, css("--s3"), 85, css("--s4")],
    "circle-stroke-color": "#fff", "circle-stroke-width": .8, "circle-opacity": .9}});
  m.addLayer({id: "alertas", type: "circle", source: "alertas", paint: {"circle-radius": raio, "circle-color": "rgba(255,122,0,.15)", "circle-stroke-color": "#ff7a00", "circle-stroke-width": 2}});
  m.addLayer({id: "area", type: "line", source: "area", paint: {"line-color": "#ffdf00", "line-width": 2.5}});
  m.addLayer({id: "sel", type: "circle", source: "sel", paint: {"circle-radius": 16, "circle-color": "rgba(0,0,0,0)", "circle-stroke-color": "#ffdf00", "circle-stroke-width": 3}});
  Q.layersOk = true;
  montarControles();
  atualizarCamadasDados();
  json("dados/deter.json").then(d => m.getSource("deter").setData(d));

  const pop = new maplibregl.Popup({closeButton: false, offset: 8});
  for (const id of ["eventos", "alertas"]) {
    m.on("click", id, ev => { if (Q.modoPonto) return; selecionar(ev.features[0].properties.id, false); rolarPara($("#ficha")); });
    m.on("mouseenter", id, ev => { m.getCanvas().style.cursor = "pointer"; const p = ev.features[0].properties;
      pop.setLngLat(ev.lngLat).setHTML(`<b>${esc(p.mun)}</b> · ${dBR(p.ini)}<br>Pontuação <b>${p.score}</b> · ${p.n} foco(s)`).addTo(m); });
    m.on("mouseleave", id, () => { m.getCanvas().style.cursor = ""; pop.remove(); });
  }
  m.on("click", "desmat", ev => { if (Q.modoPonto) return; const p = ev.features[0].properties; new maplibregl.Popup().setLngLat(ev.lngLat).setHTML(`<b>DETER ${esc(p.c)}</b><br>${dBR(p.d)} · ${br(p.a)} km²`).addTo(m); });
  m.on("click", "cicat", ev => { if (Q.modoPonto) return; const p = ev.features[0].properties; new maplibregl.Popup().setLngLat(ev.lngLat).setHTML(`<b>Cicatriz de queimada (DETER)</b><br>${dBR(p.d)} · ${br(p.a)} km²`).addTo(m); });
  m.on("click", ev => {
    if (!Q.modoPonto) return;
    Q.modoPonto = false; $("#btnPonto").classList.remove("ativo"); m.getCanvas().style.cursor = "";
    window.abrirAnalise?.({lat: ev.lngLat.lat, lon: ev.lngLat.lng, ini: null});
  });
  $("#btnPonto").onclick = () => { Q.modoPonto = !Q.modoPonto; $("#btnPonto").classList.toggle("ativo", Q.modoPonto);
    m.getCanvas().style.cursor = Q.modoPonto ? "crosshair" : ""; if (Q.modoPonto) toast("Clique no mapa para escolher o centro da área."); };
}
function geo(lista) { return {type: "FeatureCollection", features: lista.map(e => ({type: "Feature", geometry: {type: "Point", coordinates: [e.lon, e.lat]},
  properties: {id: e.id, score: e.score, n: e.n, mun: e.mun, ini: e.ini}}))}; }
function atualizarCamadasDados() {
  const m = Q.mapa; if (!m) return;
  m.getSource("eventos").setData(geo(Q.filtrados));
  m.getSource("alertas").setData(geo(Q.alertasF || []));
  m.getSource("focos").setData({type: "FeatureCollection", features: Q.focos.map(f => ({type: "Feature", geometry: {type: "Point", coordinates: [f[1], f[0]]}, properties: {}}))});
}
function enquadrarFiltro() {
  const f = Q.filtrados; if (!f.length || !Q.mapa) return;
  const b = new maplibregl.LngLatBounds(); f.slice(0, 2000).forEach(e => b.extend([e.lon, e.lat]));
  Q.mapa.fitBounds(b, {padding: 60, maxZoom: 11, duration: 600});
}
async function trocarBase(k) {
  const m = Q.mapa, b = BASES[k];
  if (b.pc) {
    try {
      if (!Q.mosaico) Q.mosaico = Q.estatico ? Q.est.mosaico : await (await fetch("api/mosaico")).json();
      if (!Q.mosaico) throw new Error("sem mosaico");
      const id = "base-" + k;
      if (!m.getSource(id)) m.addSource(id, {type: "raster", tiles: [Q.mosaico[b.pc]], tileSize: 256, attribution: "ESA Copernicus · Microsoft Planetary Computer", minzoom: 8, maxzoom: 15});
      m.removeLayer("base"); m.addLayer({id: "base", type: "raster", source: id}, "tis");
      if (m.getZoom() < 9) toast(`Sentinel-2 de ${dBR(Q.mosaico.periodo[0])} a ${dBR(Q.mosaico.periodo[1])}. Aproxime (zoom ≥ 9) para ver as imagens.`, 6000);
    } catch (e) { toast("Não foi possível gerar o mosaico Sentinel-2 agora. Tente de novo em alguns minutos."); }
    return;
  }
  m.removeLayer("base"); m.addLayer({id: "base", type: "raster", source: "base-" + k}, "tis");
}
function montarControles() {
  const el = $("#mapaCtl");
  el.innerHTML = `<button type="button" class="recolher" id="ctlRec" aria-expanded="true"><b>Camadas</b><span>−</span></button><div id="ctlCorpo">
    <h4>Mapa de fundo</h4>${Object.entries(BASES).map(([k, b]) => `<label><input type="radio" name="base" value="${k}" ${k === "satelite" ? "checked" : ""}> ${b.nome}</label>`).join("")}
    <h4>Camadas</h4>${CAMADAS.map(([k, t, c, on]) => `<label><input type="checkbox" data-c="${k}" ${on ? "checked" : ""}><span class="sw" style="background:${c}"></span>${t}</label>`).join("")}</div>`;
  el.addEventListener("change", e => {
    if (e.target.name === "base") return trocarBase(e.target.value);
    const k = e.target.dataset.c; if (!k) return;
    const ids = {tis: ["tis", "tis-l"], ucs: ["ucs", "ucs-l"]}[k] || [k];
    ids.forEach(id => Q.mapa.setLayoutProperty(id, "visibility", e.target.checked ? "visible" : "none"));
  });
  $("#ctlRec").onclick = () => { const c = $("#ctlCorpo"); c.hidden = !c.hidden; $("#ctlRec span").textContent = c.hidden ? "+" : "−"; $("#ctlRec").setAttribute("aria-expanded", !c.hidden); };
  if (matchMedia("(max-width:640px)").matches) $("#ctlRec").click();
  $("#legenda").innerHTML = `<b style="font-size:12px">Nível de suspeita</b>` + [["--s4", "Muito alta (85+)"], ["--s3", "Alta (70–84)"], ["--s2", "Atenção (50–69)"], ["--s1", "Baixa (0–49)"]].map(([c, t]) => `<div><i style="background:var(${c})"></i>${t}</div>`).join("")
    + `<div><i style="background:transparent;border:2px solid #ff7a00"></i>Alerta de agora (VIIRS)</div><div class="nota" style="font-size:11px">Tamanho = quantidade de focos</div>`;
}

// ------------------------------------------------------------ ocorrências (tabela)
const OC = {pag: 0, ord: "score", dir: -1};
const COLS_OC = [["score", "Pont."], ["ia", "IA"], ["id", "Nº"], ["mun", "Município"], ["ini", "Início (UTC)"], ["n", "Focos"], ["maxDia", "Máx/dia"],
  ["dist", "Dist. Manaus (km)"], ["area", "Área protegida"], ["inds", "Indicadores"], ["lat", "Lat"], ["lon", "Lon"]];
function valOc(e, k) { return k === "area" ? (e.det.ti || e.det.uc || "") : k === "inds" ? e.ind.length : e[k]; }
function ocorrencias() {
  const f = [...Q.filtrados].sort((a, b) => { const x = valOc(a, OC.ord), y = valOc(b, OC.ord); return (x > y ? 1 : x < y ? -1 : 0) * OC.dir; });
  const por = 100, pags = Math.max(1, Math.ceil(f.length / por)); OC.pag = Math.min(OC.pag, pags - 1);
  $("#nOcor").textContent = `${fmt(f.length)} ocorrências`;
  $("#tabOcor").innerHTML = `<thead><tr>${COLS_OC.map(([k, t]) => `<th data-ordem="${k}" class="${OC.ord === k ? (OC.dir > 0 ? "asc" : "desc") : ""}">${t}</th>`).join("")}</tr></thead><tbody>`
    + f.slice(OC.pag * por, OC.pag * por + por).map(e => `<tr class="clicavel" data-id="${e.id}"><td><span class="pontos" style="background:${corScore(e.score)}">${e.score}</span></td>
      <td class="n">${e.ia ?? "–"}</td><td class="mono">${e.id}</td><td>${esc(e.mun)}</td><td class="mono">${e.ini}</td><td class="n">${e.n}</td><td class="n">${e.maxDia}</td>
      <td class="n">${fmt(e.dist)}</td><td>${esc(e.det.ti || e.det.uc || "")}</td><td>${e.ind.map(k => `<span class="selo" title="${IND_TXT[k]}">${IND_TXT[k].split(" ")[0]}</span>`).join(" ")}</td>
      <td class="n">${e.lat.toFixed(4)}</td><td class="n">${e.lon.toFixed(4)}</td></tr>`).join("") + "</tbody>";
  $("#pagOcor").innerHTML = `<button type="button" class="botao secundario pequeno" ${OC.pag ? "" : "disabled"} data-p="-1">Anterior</button><span>Página ${OC.pag + 1} de ${pags}</span><button type="button" class="botao secundario pequeno" ${OC.pag < pags - 1 ? "" : "disabled"} data-p="1">Próxima</button>`;
}
$("#tabOcor").addEventListener("click", e => {
  const th = e.target.closest("th"); if (th) { const k = th.dataset.ordem; OC.dir = OC.ord === k ? -OC.dir : -1; OC.ord = k; return ocorrencias(); }
  const tr = e.target.closest("tr[data-id]"); if (tr) { trocarAba("mapa"); selecionar(tr.dataset.id, true); rolarPara($("#ficha"), true); }
});
$("#pagOcor").addEventListener("click", e => { const b = e.target.closest("button"); if (b) { OC.pag += +b.dataset.p; ocorrencias(); } });
function baixar(nome, txt, tipo) { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([txt], {type: tipo})); a.download = nome; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); }
function csvEventos(lista) {
  const cab = ["id", "pontuacao", "ia_atipicidade", "municipio", "inicio_utc", "fim_utc", "focos", "max_focos_dia", "dist_manaus_km", "lat", "lon", "ti", "uc", ...Q.ind];
  const q = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
  return [cab.join(";"), ...lista.map(e => [e.id, e.score, e.ia ?? "", e.mun, e.ini, e.fim, e.n, e.maxDia, e.dist, e.lat, e.lon, e.det.ti || "", e.det.uc || "", ...Q.ind.map(k => e.ind.includes(k) ? 1 : 0)].map(q).join(";"))].join("\n");
}
$("#csvOcor").onclick = () => baixar(`queimadia_ocorrencias_${F.ini}_${F.fim}.csv`, "﻿" + csvEventos(Q.filtrados), "text/csv");
$("#geoOcor").onclick = () => baixar(`queimadia_ocorrencias_${F.ini}_${F.fim}.geojson`, JSON.stringify(geo(Q.filtrados)), "application/geo+json");
$("#csvTR").onclick = () => baixar(`queimadia_alertas_tempo_real.csv`, "﻿" + csvEventos(Q.alertasF || []), "text/csv");

// ------------------------------------------------------------ tempo real
function tempoReal() {
  const al = (Q.alertasF || []).slice().sort((a, b) => b.score - a.score || b.fim.localeCompare(a.fim));
  const ult24 = Q.focos.filter(f => Date.now() - new Date(f[2].replace(" ", "T") + "Z") < 864e5).length;
  $("#kpisTR").innerHTML = [[fmt(Q.focos.length), "focos (todos os satélites) em 7 dias", "azul"], [fmt(ult24), "focos nas últimas 24 h", "vermelho fogo"],
    [fmt(al.length), "alertas VIIRS agrupados", "ouro"], [fmt(al.filter(e => e.score >= 70).length), "alertas com pontuação ≥ 70", "vermelho fogo"],
    [Q.est ? manaus(Q.est.ultimo_foco_utc) : "–", "último foco recebido (Manaus)", "azul"]]
    .map(([v, t, c]) => `<div class="indicador ${c}"><b style="${v.length > 10 ? "font-size:18px" : ""}">${v}</b><span>${t}</span></div>`).join("");
  $("#tabTR").innerHTML = `<thead><tr><th>Pont.</th><th>Município</th><th>Área</th><th>Primeiro foco (Manaus)</th><th>Último (Manaus)</th><th>Focos</th><th>Indicadores</th><th>Coord.</th></tr></thead><tbody>`
    + al.slice(0, 400).map(e => `<tr class="clicavel" data-id="${e.id}"><td><span class="pontos" style="background:${corScore(e.score)}">${e.score}</span></td><td>${esc(e.mun)}</td><td>${esc(e.det.ti || e.det.uc || "")}</td>
      <td class="mono">${manaus(e.ini)}</td><td class="mono">${manaus(e.fim)}</td><td class="n">${e.n}</td><td>${e.ind.map(k => `<span class="selo">${IND_TXT[k].split(" ")[0]}</span>`).join(" ")}</td><td class="n">${e.lat.toFixed(4)}, ${e.lon.toFixed(4)}</td></tr>`).join("") + "</tbody>";
  const rec = Q.focos.slice().sort((a, b) => b[2].localeCompare(a[2]));
  $("#nFocosRec").textContent = `${fmt(rec.length)} focos; mostrando os 300 mais recentes`;
  $("#tabFocos").innerHTML = `<thead><tr><th>Hora (Manaus)</th><th>Satélite</th><th>Município</th><th>Lat</th><th>Lon</th></tr></thead><tbody>`
    + rec.slice(0, 300).map(f => `<tr><td class="mono">${manaus(f[2])}</td><td>${esc(f[3])}</td><td>${esc(f[4])}</td><td class="n">${f[0]}</td><td class="n">${f[1]}</td></tr>`).join("") + "</tbody>";
  if (!$('[data-painel="temporeal"]').hidden) graficosTR();
}
$("#tabTR").addEventListener("click", e => { const tr = e.target.closest("tr[data-id]"); if (tr) { trocarAba("mapa"); selecionar(tr.dataset.id, true); rolarPara($("#ficha"), true); } });
function graficosTR() {
  const porDia = d3.rollups(Q.focos, v => v.length, f => manaus(f[2]).slice(0, 10)).sort();
  barras("#gTRdia", porDia.map(([d, n]) => [dBR(d).slice(0, 5), n]), css("--s2"));
  barras("#gSat", Object.entries(Q.est.focos_30d_por_satelite || {}), css("--azul"), true);
}

// ------------------------------------------------------------ estatísticas e gráficos
function eixos(g, x, y, w, h, m) {
  g.append("g").attr("transform", `translate(0,${h - m.b})`).call(d3.axisBottom(x).tickSizeOuter(0)).call(a => a.select(".domain").attr("stroke", css("--cinza-borda")));
  g.append("g").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(5).tickSize(-(w - m.l - m.r)).tickFormat(d => fmt(d)))
    .call(a => a.select(".domain").remove()).call(a => a.selectAll("line").attr("stroke", css("--grade")));
}
function barras(sel, dados, cor, horizontal) {
  const svg = d3.select(sel), w = Math.max(320, svg.node().parentNode.clientWidth);
  svg.selectAll("*").remove();
  if (!dados.length) { svg.attr("width", w).attr("height", 40).append("text").attr("x", 4).attr("y", 24).text("Sem dados no filtro atual."); return; }
  if (horizontal) {
    const h = 26 * dados.length + 30, m = {l: 150, r: 50, t: 6, b: 20};
    svg.attr("width", w).attr("height", h);
    const x = d3.scaleLinear().domain([0, d3.max(dados, d => d[1])]).nice().range([m.l, w - m.r]);
    const y = d3.scaleBand().domain(dados.map(d => d[0])).range([m.t, h - m.b]).padding(.25);
    svg.append("g").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).tickSize(0)).call(a => a.select(".domain").remove()).selectAll("text").style("fill", css("--texto"));
    svg.selectAll("rect").data(dados).join("rect").attr("x", m.l).attr("y", d => y(d[0])).attr("height", y.bandwidth()).attr("width", d => x(d[1]) - m.l).attr("fill", cor).attr("rx", 3);
    svg.selectAll(".v").data(dados).join("text").attr("x", d => x(d[1]) + 5).attr("y", d => y(d[0]) + y.bandwidth() / 2 + 4).text(d => fmt(d[1]));
    return;
  }
  const h = 220, m = {l: 46, r: 10, t: 10, b: 26};
  svg.attr("width", w).attr("height", h);
  const x = d3.scaleBand().domain(dados.map(d => d[0])).range([m.l, w - m.r]).padding(.2);
  const y = d3.scaleLinear().domain([0, d3.max(dados, d => d[1])]).nice().range([h - m.b, m.t]);
  eixos(svg, x, y, w, h, m);
  if (dados.length > 16) svg.selectAll(".tick text").filter((d, i) => i % Math.ceil(dados.length / 12)).remove();
  svg.selectAll("rect").data(dados).join("rect").attr("x", d => x(d[0])).attr("y", d => y(d[1])).attr("width", x.bandwidth()).attr("height", d => y(0) - y(d[1])).attr("fill", cor).attr("rx", 2)
    .append("title").text(d => `${d[0]}: ${fmt(d[1])}`);
}
function estatisticas() {
  const f = Q.filtrados, st = Q.est, anos = Object.keys(st.focos_por_mes);
  const anoSel = (F.ini || "").slice(0, 4);
  $("#kpisEst").innerHTML = anos.slice(-4).map(a => `<div class="indicador ${a === anoSel ? "vermelho" : "azul"}"><b>${fmt(st.total_focos_ref[a])}</b><span>focos de referência em ${a}${a == new Date().getFullYear() ? " (parcial)" : ""}</span></div>`).join("")
    + `<div class="indicador ouro"><b>${fmt(f.length)}</b><span>eventos no filtro atual</span></div><div class="indicador ouro"><b>${f.length ? br(d3.mean(f, e => e.score), 1) : "–"}</b><span>pontuação média no filtro</span></div>`;
  graficoMeses(st, anos);
  const porMun = d3.rollups(f, v => v.length, e => e.mun).sort((a, b) => b[1] - a[1]).slice(0, 12);
  barras("#gMun", porMun, css("--dptc-vermelho"), true);
  const hist = d3.range(0, 101, 5).map(s => [String(s), f.filter(e => e.score === s).length]).filter(d => +d[0] >= F.score);
  barras("#gHist", hist, css("--s2"));
  barras("#gInd", Q.ind.map(k => [IND_TXT[k], f.filter(e => e.ind.includes(k)).length]).sort((a, b) => b[1] - a[1]), css("--azul"), true);
  const faixas = [[0, 100, "até 100 km"], [100, 250, "100–250 km"], [250, 500, "250–500 km"], [500, 800, "500–800 km"], [800, 9e9, "mais de 800 km"]];
  barras("#gDist", faixas.map(([a, b, t]) => [t, f.filter(e => e.dist >= a && e.dist < b).length]), css("--pcam-ouro"), true);
  barras("#gArea", [["Terra indígena", f.filter(e => e.det.ti).length], ["UC proteção integral", f.filter(e => e.det.uc && e.det.uc_grupo === "PI").length],
    ["UC uso sustentável", f.filter(e => e.det.uc && e.det.uc_grupo !== "PI").length], ["Fora de TI/UC", f.filter(e => !e.det.ti && !e.det.uc).length]], css("--verde"), true);
}

// ------------------------------------------------------------ metodologia e fontes
// Focos por mês: uma linha por ano, legenda clicável e valores ao tocar num mês
const CORES_ANOS = ["#9aa3af", "#5fa8d3", "#2a9d8f", "#1b3faa", "#c9a227", "#8e5cc4", "#c8302f", "#e07b2a", "#3a7d44"];
function graficoMeses(st, anos) {
  const anoAtual = String(new Date().getFullYear()), mesAtual = new Date().getMonth();
  const cor = a => CORES_ANOS[(anos.indexOf(a) + CORES_ANOS.length - anos.length) % CORES_ANOS.length];
  if (!anos.includes(Q.anoDestaque)) Q.anoDestaque = anoAtual;
  const meses = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
  const serie = a => st.focos_por_mes[a].map((n, i) => ({i, n})).filter(p => a !== anoAtual || p.i <= mesAtual);
  // legenda
  $("#legMes").innerHTML = anos.map(a => `<button type="button" class="leg-ano" data-a="${a}" aria-pressed="${a === Q.anoDestaque}">
      <i style="background:${cor(a)}"></i>${a}${a === anoAtual ? " (parcial)" : ""} <span class="num">${fmt(st.total_focos_ref[a])}</span></button>`).join("");
  $("#legMes").onclick = e => { const b = e.target.closest(".leg-ano"); if (!b) return; Q.anoDestaque = b.dataset.a; graficoMeses(st, anos); };
  const svg = d3.select("#gMes"), w = Math.max(260, svg.node().parentNode.clientWidth), h = 260, m = {l: 44, r: 16, t: 14, b: 26};
  svg.attr("width", w).attr("height", h).selectAll("*").remove();
  const x = d3.scalePoint().domain(d3.range(12)).range([m.l, w - m.r]);
  const y = d3.scaleLinear().domain([0, d3.max(anos, a => d3.max(st.focos_por_mes[a]))]).nice().range([h - m.b, m.t]);
  svg.append("g").attr("transform", `translate(0,${h - m.b})`).call(d3.axisBottom(x).tickFormat(i => meses[i])).call(g => g.select(".domain").attr("stroke", css("--cinza-borda")));
  svg.append("g").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(5).tickSize(-(w - m.l - m.r)).tickFormat(d => fmt(d))).call(g => g.select(".domain").remove()).call(g => g.selectAll("line").attr("stroke", css("--grade")));
  const linha = d3.line().x(p => x(p.i)).y(p => y(p.n));
  // anos em segundo plano primeiro; o destacado por cima, mais grosso, com pontos e rótulo
  anos.filter(a => a !== Q.anoDestaque).forEach(a =>
    svg.append("path").datum(serie(a)).attr("d", linha).attr("fill", "none").attr("stroke", cor(a)).attr("stroke-width", 1.4).attr("stroke-opacity", .45));
  const d = serie(Q.anoDestaque), c = cor(Q.anoDestaque);
  svg.append("path").datum(d).attr("d", linha).attr("fill", "none").attr("stroke", c).attr("stroke-width", 3);
  svg.selectAll(".pt").data(d).join("circle").attr("cx", p => x(p.i)).attr("cy", p => y(p.n)).attr("r", 3.5).attr("fill", c);
  const pico = d.reduce((a, b) => b.n > a.n ? b : a, d[0]);
  if (pico) svg.append("text").attr("x", x(pico.i)).attr("y", y(pico.n) - 8).attr("text-anchor", "middle").style("fill", c).style("font-weight", 700)
    .text(`${Q.anoDestaque}: ${fmt(pico.n)} em ${meses[pico.i]}`);
  // toque/passagem num mês: valores de todos os anos
  const guia = svg.append("line").attr("y1", m.t).attr("y2", h - m.b).attr("stroke", css("--cinza-texto")).attr("stroke-dasharray", "3 3").style("display", "none");
  const info = $("#infoMes");
  const mostrar = ev => {
    const [px] = d3.pointer(ev); const i = Math.max(0, Math.min(11, Math.round((px - m.l) / ((w - m.l - m.r) / 11))));
    guia.attr("x1", x(i)).attr("x2", x(i)).style("display", null);
    info.innerHTML = `<b>${meses[i]}</b> · ` + anos.slice().reverse().map(a => { const v = st.focos_por_mes[a][i];
      const fut = a === anoAtual && i > mesAtual; return `<span class="info-ano"><i style="background:${cor(a)}"></i>${a}: <b class="num">${fut ? "–" : fmt(v)}</b></span>`; }).join("");
  };
  svg.append("rect").attr("x", m.l - 10).attr("y", m.t).attr("width", w - m.l - m.r + 20).attr("height", h - m.t - m.b).attr("fill", "transparent")
    .style("cursor", "crosshair").on("mousemove", mostrar).on("click", mostrar).on("touchstart", mostrar, {passive: true});
  info.innerHTML = `<span class="nota">Toque ou passe o mouse sobre um mês para ver os valores de todos os anos. Toque num ano acima para destacá-lo.</span>`;
}

function metodologia() {
  const st = Q.est, p = st.parametros, P = st.pesos, D = st.descricao_indicadores;
  $("#metodo").innerHTML = `
  <div class="painel-grade">
    <div class="cartao"><h2>1. Focos e eventos</h2>
      <p>Focos de calor do INPE (Programa Queimadas). A série histórica usa o satélite de referência <b>${p.sat_referencia}</b>, comparável entre anos. Os alertas de tempo real usam VIIRS 375 m (${p.sat_tempo_real.join(", ")}) dos últimos ${p.dias_tempo_real} dias.</p>
      <p>Focos são agrupados em <b>eventos</b> por DBSCAN espaço-temporal (aprendizado de máquina não supervisionado):</p>
      <div class="formula">x = lon·111,32·cos(φ̄) km · y = lat·111,32 km · t = dias·(${p.eps_km}/${p.eps_dias}) km<br>vizinhos se ‖(x,y,t)‖ ≤ ${p.eps_km} km  →  ${p.eps_km} km no espaço ou ${p.eps_dias} dias no tempo</div></div>
    <div class="cartao"><h2>2. Pontuação de suspeição (0–100)</h2>
      <table class="tabela"><thead><tr><th>Indicador</th><th>Critério</th><th>Peso</th></tr></thead><tbody>
      ${Object.keys(P).map(k => `<tr><td>${D[k][0]}</td><td class="nota">${D[k][1]}</td><td class="n">${P[k]}</td></tr>`).join("")}</tbody></table>
      <div class="formula">pontuação = Σ peso(indicador presente) · máximo = 100</div>
      <p class="nota">Raio de associação ao DETER: ${p.buffer_desmat_km} km. Meses do período proibitivo: ${p.meses_proibicao.join(", ")} (ajustar ao decreto vigente).</p></div>
    <div class="cartao"><h2>3. Índices espectrais</h2>
      <div class="formula">NDVI = (NIR − Red) / (NIR + Red)</div><div class="formula">NBR = (NIR − SWIR2) / (NIR + SWIR2)</div>
      <div class="formula">NDMI = (NIR − SWIR1) / (NIR + SWIR1)</div><div class="formula">dNBR = NBR(antes) − NBR(depois)</div>
      <table class="tabela"><thead><tr><th></th><th>Sentinel-2 L2A</th><th>Landsat 8/9 C2 L2</th></tr></thead><tbody>
      <tr><td>Red / NIR</td><td>B04 / B08 (10 m)</td><td>red / nir08 (30 m)</td></tr><tr><td>SWIR1 / SWIR2</td><td>B11 / B12 (20 m)</td><td>swir16 / swir22</td></tr>
      <tr><td>Reflectância</td><td>(DN − 1000)/10000 se baseline ≥ 04.00; senão DN/10000</td><td>DN · 0,0000275 − 0,2</td></tr>
      <tr><td>Máscara</td><td>SCL ∈ {4, 5, 6, 7}</td><td>QA_PIXEL sem bits 1–5, com bit 6 ou 7; só Tier 1</td></tr></tbody></table>
      <p class="nota">Valor por cena = mediana dos pixels válidos no círculo do núcleo. Classes de dNBR (USGS): &lt; 0,10 não queimado · 0,10–0,27 baixa · 0,27–0,44 moderada-baixa · 0,44–0,66 moderada-alta · ≥ 0,66 alta.</p></div>
    <div class="cartao"><h2>4. Detecção de quebra (método PolicIA)</h2>
      <div class="formula">base = mediana(NDVI da linha de base) · σ = desvio-padrão<br>limiar = base − max(3σ ; 0,15)<br>quebra = 1ª observação de ≥ 2 seguidas abaixo do limiar<br>data ∈ (última acima ; primeira abaixo]</div>
      <p>É o mesmo critério do serviço ambiental do PolicIA, descritivo, não o CCDC completo. Diferenças deliberadas: o offset do Sentinel-2 vai pela versão de processamento da cena (há cenas de 2019 e 2021 reprocessadas com offset), e o Landsat entra só como Tier 1, sem nuvem classificada como neve.</p></div>
    <div class="cartao"><h2>5. Inteligência artificial</h2>
      <p><b>DBSCAN</b> agrupa focos em eventos. <b>Isolation Forest</b> aprende o padrão dos eventos do Amazonas (focos, duração, simultaneidade, desmatamento, reincidência, área protegida, distância) e dá a cada evento uma nota de <b>atipicidade</b> de 0 a 100. O <b>parecer preliminar</b> é redigido por um modelo de linguagem (Google Gemini) a partir dos números calculados, sem acrescentar fatos.</p>
      <p class="nota">Próximo passo: com casos confirmados pela DEMA e laudos do DPTC, treinar um classificador supervisionado que estime a probabilidade de origem criminosa.</p></div>
    <div class="cartao"><h2>Limitações</h2><ul>
      <li>O satélite detecta calor, não autoria. A pontuação é indício para orientar diligência, nunca prova.</li>
      <li>Em TIs e RDS/RESEX há uso tradicional do fogo, permitido. A pontuação nessas áreas exige leitura cuidadosa.</li>
      <li>Nuvem e fumaça abrem lacunas na série de NDVI e alargam a incerteza da data.</li>
      <li>Resolução de 10 a 30 m: adequada para áreas em hectares, não para feições pequenas.</li>
      <li>CAR e SIGEF ainda não estão integrados para apontar o imóvel.</li></ul></div>
  </div>`;
}
function fontes() {
  const st = Q.est, f = st.fontes || {}, hora = s => s ? manaus(s.replace("T", " ").slice(0, 19).replace(/\+.*$/, "")) : "–";
  const linhas = [
    ["Focos de calor 10 em 10 min", "INPE · Programa Queimadas", "https://dataserver-coids.inpe.br/queimadas/queimadas/focos/csv/10min/", hora(f.tempo_real), "a cada 10 min", f.ultimo_10min],
    ["Focos diários (todos os satélites)", "INPE · Programa Queimadas", "https://dataserver-coids.inpe.br/queimadas/queimadas/focos/csv/diario/Brasil/", hora(f.diario), "a cada hora", `${fmt(f.focos_recentes)} focos no ano`],
    ["Focos anuais (satélite de referência)", "INPE · BDQueimadas", "https://terrabrasilis.dpi.inpe.br/queimadas/bdqueimadas/", "–", "anual", "2020 em diante"],
    ["DETER: desmatamento e cicatrizes", "INPE · TerraBrasilis", "https://terrabrasilis.dpi.inpe.br/app/map/deter-amz", hora(f.deter), "a cada hora", `última imagem ${dBR(f.deter_ultima_imagem)} · ${fmt(f.deter_alertas_ano)} alertas no ano`],
    ["Terras indígenas", "FUNAI via TerraBrasilis", "https://terrabrasilis.dpi.inpe.br/", "–", "estático", ""],
    ["Unidades de conservação", "ICMBio/MMA via TerraBrasilis", "https://terrabrasilis.dpi.inpe.br/", "–", "estático", ""],
    ["Municípios", "IBGE via TerraBrasilis", "https://terrabrasilis.dpi.inpe.br/", "–", "estático", ""],
    ["Sentinel-2 L2A (10 m)", "ESA Copernicus · Microsoft Planetary Computer", "https://planetarycomputer.microsoft.com/dataset/sentinel-2-l2a", "sob demanda", "~5 dias", "NDVI, NBR, NDMI, imagens"],
    ["Landsat 8/9 C2 L2 (30 m)", "NASA/USGS · Microsoft Planetary Computer", "https://planetarycomputer.microsoft.com/dataset/landsat-c2-l2", "sob demanda", "~8 dias", "série longa"],
  ];
  $("#fontes").innerHTML = `<div class="indicadores">
      <div class="indicador azul"><b style="font-size:18px">${manaus(st.gerado_em.replace("T", " ").slice(0, 19))}</b><span>último ciclo (hora de Manaus)</span></div>
      <div class="indicador azul"><b>${f.duracao_ciclo_s ?? "–"} s</b><span>duração do ciclo</span></div>
      <div class="indicador ouro"><b>${fmt(st.n_eventos)}</b><span>eventos de referência</span></div>
      <div class="indicador ouro"><b>${fmt(st.n_deter)}</b><span>polígonos DETER no mapa</span></div></div>
    <div class="cartao"><div class="cab"><h2>Fontes de dados</h2><a class="botao secundario pequeno" href="api/docs" target="_blank" rel="noopener">API do QueimadIA</a></div>
    <div class="rolagem"><table class="tabela"><thead><tr><th>Dado</th><th>Origem</th><th>Atualizado (Manaus)</th><th>Frequência</th><th>Situação</th></tr></thead><tbody>
    ${linhas.map(([d, o, u, h, fr, s]) => `<tr><td><a href="${u}" target="_blank" rel="noopener">${d}</a></td><td>${o}</td><td class="mono">${h}</td><td>${fr}</td><td class="nota">${esc(s || "")}</td></tr>`).join("")}
    </tbody></table></div></div>`;
}

// ------------------------------------------------------------ abas
function trocarAba(a) {
  $$("#abas a").forEach(x => x.classList.toggle("ativa", x.dataset.aba === a));
  $$("[data-painel]").forEach(p => p.hidden = p.dataset.painel !== a);
  $("#filtros").hidden = ["metodo", "fontes", "analise"].includes(a);
  if (a === "estatisticas") estatisticas();
  if (a === "temporeal") graficosTR();
  if (a === "metodo") metodologia();
  if (a === "fontes") fontes();
  if (a === "mapa" && Q.mapa) Q.mapa.resize();
  if (a === "analise") { window.miniMapa?.(); window.listarProntas?.(); }
  try { history.replaceState(null, "", "#" + a); } catch (e) {}
  if ($("#abas").getBoundingClientRect().top < 0) rolarPara($("#abas"), true);
}
$("#abas").addEventListener("click", e => { const a = e.target.closest("a[data-aba]"); if (a) trocarAba(a.dataset.aba); });
window.trocarAba = trocarAba;
const guardar = (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} };
const ler = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
if (ler("qia_bv_fechado") === "1") $("#boasVindas").hidden = true;
$("#bvFechar").onclick = () => { $("#boasVindas").hidden = true; guardar("qia_bv_fechado", "1"); };
const ajuda = $("#ajuda");
$("#btnAjuda").onclick = () => { ajuda.hidden = false; $("#ajudaFechar").focus(); };
$("#ajudaFechar").onclick = () => { ajuda.hidden = true; $("#btnAjuda").focus(); };
ajuda.addEventListener("click", e => { if (e.target === ajuda) ajuda.hidden = true; });
document.addEventListener("keydown", e => { if (e.key === "Escape" && !ajuda.hidden) ajuda.hidden = true; });

async function detectarModo() {
  try { const c = new AbortController(); setTimeout(() => c.abort(), 4000);
    const r = await fetch("api/cenas?lat=-3&lon=-60&inicio=2026-01-01&fim=2026-01-02&colecoes=x", {signal: c.signal});
    Q.estatico = !r.ok; } catch (e) { Q.estatico = true; }
  document.body.classList.toggle("estatico", Q.estatico);
}
(async function () {
  await detectarModo();
  try { await carregar(true); } catch (e) { $("#aoVivoTxt").textContent = "Sem dados: rode o atualizador"; $("#aoVivo").classList.add("atrasado"); console.error(e); return; }
  await iniciarMapa();
  const h = location.hash.slice(1); if (h && document.querySelector(`[data-aba="${h}"]`)) trocarAba(h);
  if (Q.filtrados[0]) selecionar(Q.filtrados[0].id, false);
})();
