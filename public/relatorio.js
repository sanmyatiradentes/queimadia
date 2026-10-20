/* Fogo Forense — relatório analítico imprimível de um evento de fogo (modelo: relatório de alertas do Brasil MAIS).
   Aberto pelo botão "Gerar relatório" da ficha: lê o evento e os dados já carregados no painel (window.opener).
   Dados restritos (Brasil MAIS) só existem na memória do painel de quem fez login aprovado; nada é gravado. */
"use strict";
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"}[c]));
const br = (v, d = 2) => v == null || Number.isNaN(+v) ? "–" : Number(v).toLocaleString("pt-BR", {minimumFractionDigits: 0, maximumFractionDigits: d});
const ha2 = v => v == null ? "–" : Number(v).toLocaleString("pt-BR", {minimumFractionDigits: 2, maximumFractionDigits: 2});
const dBR = s => s ? String(s).slice(0, 10).split("-").reverse().join("/") : "–";
const manaus = utc => { const d = new Date(utc.replace(" ", "T") + "Z"); d.setUTCHours(d.getUTCHours() - 4); return d.toISOString().slice(0, 16).replace("T", " "); };
const DADOS = window.QUEIMADIA_DADOS;
const RAIO_PROX_KM = 10;
const COR = {ai: "#ffdf00", raio: "#ffffff", ti: "#d4a017", uc: "#2fbf71", car: "#7ab8ff", emb: "#ff1744", quil: "#ff9100", mud: "#00e5ff", foco: "#c8302f"};

function dms(v, eixo) {
  const h = eixo === "lat" ? (v < 0 ? "S" : "N") : (v < 0 ? "W" : "E");
  const a = Math.abs(v), g = Math.floor(a), m = Math.floor((a - g) * 60), s = ((a - g) * 60 - m) * 60;
  return `${g}°${m}'${s.toFixed(2).replace(".", ",")}"${h}`;
}
async function getJSON(url, ms = 30000) {
  const c = new AbortController(), t = setTimeout(() => c.abort(), ms);
  try { const r = await fetch(url, {signal: c.signal}); if (!r.ok) throw new Error(r.status); return await r.json(); }
  finally { clearTimeout(t); }
}
const estado = (t, ok) => { $("#estadoTxt").textContent = t; $("#estado").classList.toggle("atualizando", !ok); };

// ------------------------------------------------------------ evento e contexto vindos do painel
const P = (() => { for (const w of [window.opener, window.parent !== window ? window.parent : null]) { try { if (w && w.Q) return w; } catch (e) {} } return null; })();
const ID = new URLSearchParams(location.search).get("id");
const R = {};   // resultados das consultas

async function iniciar() {
  if (!P) return semPainel();
  const Q = P.Q, e = Q.eventos.find(x => x.id === ID) || Q.alertas.find(x => x.id === ID);
  if (!e) return semPainel();
  R.e = e; R.Q = Q;
  R.usuario = Q.usuario || null;
  R.brm = R.usuario && P.BRM?.lista?.length && typeof P.brmaisPerto === "function" ? P.brmaisPerto(e) : [];
  R.desm = R.usuario && P.DESM?.meta && typeof P.desmPerto === "function" ? P.desmPerto(e) : [];
  document.title = `Relatório ${e.id} — Fogo Forense`;
  await montar();
}
function semPainel() {
  estado("Abra pelo painel", true);
  $("#folha").innerHTML = `<div class="cartao"><h2>Abra o relatório pela ficha do evento</h2>
    <p>Este relatório é montado com os dados que o painel já carregou. No <a href="./">Fogo Forense</a>, selecione um evento e clique em <b>Gerar relatório</b> na ficha.</p></div>`;
}

async function montar() {
  const e = R.e;
  R.raio = Math.max(100, Math.min(5000, +$("#raio").value || 1000));
  const c = turf.point([e.lon, e.lat]);
  R.ai = turf.circle(c, R.raio / 1000, {steps: 96, units: "kilometers"});
  R.ai_ha = Math.PI * R.raio * R.raio / 1e4;
  R.prox = turf.circle(c, RAIO_PROX_KM, {steps: 128, units: "kilometers"});
  R.bbox10 = turf.bbox(R.prox);
  R.bboxAI = turf.bbox(R.ai);
  estado("Consultando bases…", false);
  $("#folha").innerHTML = html();
  desenharMapas();
  const tarefas = [consultarTIUC(), consultarCAR(), consultarEmbargos(), consultarQuilombolas(), imagens()];
  await Promise.allSettled(tarefas);
  $("#secBases").innerHTML = htmlBases();
  desenharMapas(true);
  estado("Pronto para imprimir", true);
}

// ------------------------------------------------------------ consultas espaciais
function relacao(feat) {
  // sobreposição com a AI (ha) e distância da borda da AI até o polígono (m), limitada a 10 km
  let ha = 0, dist = null;
  try {
    if (turf.booleanIntersects(R.ai, feat)) {
      const i = turf.intersect(turf.featureCollection([R.ai, feat]));
      ha = i ? turf.area(i) / 1e4 : 0; dist = 0;
    }
  } catch (err) { ha = null; }
  if (dist == null) {
    try {
      const pt = turf.point([R.e.lon, R.e.lat]);
      if (turf.booleanPointInPolygon(pt, feat)) dist = 0;
      else {
        let m = Infinity;
        turf.flatten(turf.polygonToLine(feat)).features.forEach(l => { m = Math.min(m, turf.pointToLineDistance(pt, l, {units: "meters"})); });
        dist = Math.max(0, m - R.raio);
      }
    } catch (err) { dist = null; }
  }
  return {ha, dist};
}
const pertoBbox = (f, b) => { try { const x = turf.bbox(f); return !(x[0] > b[2] || x[2] < b[0] || x[1] > b[3] || x[3] < b[1]); } catch (e) { return false; } };

async function consultarTIUC() {
  const [tis, ucs] = await Promise.all([getJSON(DADOS + "tis.json"), getJSON(DADOS + "ucs.json")]);
  R.tis = tis.features.filter(f => pertoBbox(f, R.bbox10)).map(f => ({f, ...relacao(f)})).filter(x => x.dist != null && x.dist <= RAIO_PROX_KM * 1000);
  R.ucs = ucs.features.filter(f => pertoBbox(f, R.bbox10)).map(f => ({f, ...relacao(f)})).filter(x => x.dist != null && x.dist <= RAIO_PROX_KM * 1000);
  R.geoTI = turf.featureCollection(tis.features.filter(f => pertoBbox(f, R.bbox10)));
  R.geoUC = turf.featureCollection(ucs.features.filter(f => pertoBbox(f, R.bbox10)));
}
async function consultarCAR() {
  const [x0, y0, x1, y1] = R.bboxAI;
  const u = `https://geoserver.car.gov.br/geoserver/sicar/wfs?service=WFS&version=2.0.0&request=GetFeature&typeNames=sicar:sicar_imoveis_am&count=300&outputFormat=application/json&bbox=${y0},${x0},${y1},${x1},urn:ogc:def:crs:EPSG::4326`;
  try {
    const d = await getJSON(u, 40000);
    R.car = d.features.map(f => ({f, ...relacao(f)})).filter(x => x.ha == null || x.ha > 0).sort((a, b) => (b.ha || 0) - (a.ha || 0));
    R.geoCAR = turf.featureCollection(d.features);
  } catch (err) { R.car = null; R.carErro = true; }
}
async function consultarEmbargos() {
  const [x0, y0, x1, y1] = R.bbox10;
  const campos = "num_tad,serie_tad,num_processo,dat_embargo,qtd_area_embargada,des_tad,municipio,unid_controle";
  const u = `https://pamgia.ibama.gov.br/server/rest/services/01_Publicacoes_Bases/adm_embargos_ibama_a/MapServer/0/query?f=geojson&where=1%3D1&geometry=${x0},${y0},${x1},${y1}&geometryType=esriGeometryEnvelope&inSR=4326&outSR=4326&spatialRel=esriSpatialRelIntersects&outFields=${campos}&resultRecordCount=500`;
  try {
    const d = await getJSON(u, 40000);
    const fs = d.features.filter(f => f.geometry);
    R.emb = fs.map(f => ({f, ...relacao(f)})).filter(x => x.dist != null && x.dist <= RAIO_PROX_KM * 1000).sort((a, b) => a.dist - b.dist);
    R.geoEMB = turf.featureCollection(fs);
  } catch (err) { R.emb = null; R.embErro = true; }
}
async function consultarQuilombolas() {
  const d = await getJSON("bases/quilombolas_am.json");
  R.quil = d.features.filter(f => pertoBbox(f, R.bbox10)).map(f => ({f, ...relacao(f)})).filter(x => x.dist != null && x.dist <= RAIO_PROX_KM * 1000);
  R.geoQUIL = turf.featureCollection(d.features.filter(f => pertoBbox(f, R.bbox10)));
}

// ------------------------------------------------------------ imagens de antes e depois
async function imagens() {
  const e = R.e, alvo = $("#figImagens");
  if (R.Q.est.analises?.[e.id]) {
    try {
      const a = await getJSON(DADOS + "analises/" + e.id + ".json");
      const rgb = (a.imagens || []).filter(i => i.produto === "rgb");
      const ini = e.ini.slice(0, 10), fim = e.fim.slice(0, 10);
      const antes = rgb.filter(i => i.data < ini).pop(), depois = rgb.find(i => i.data > fim);
      const figs = [];
      if (antes) figs.push(fig(DADOS + "analises/" + antes.arquivo, `Figura 04 — Imagem anterior ao evento: <b>${dBR(antes.data)}</b>`, `${a.dnbr?.cena_antes && antes.data === a.dnbr.antes ? a.dnbr.cena_antes : "Sentinel-2/Landsat"} · cor verdadeira · NDVI ${br(antes.ndvi, 3)}`));
      if (depois) figs.push(fig(DADOS + "analises/" + depois.arquivo, `Figura 05 — Imagem posterior ao evento: <b>${dBR(depois.data)}</b>`, `${a.dnbr?.cena_depois && depois.data === a.dnbr.depois ? a.dnbr.cena_depois : "Sentinel-2/Landsat"} · cor verdadeira · NDVI ${br(depois.ndvi, 3)}`));
      if (a.dnbr?.arquivo) figs.push(fig(DADOS + "analises/" + a.dnbr.arquivo, `Figura 06 — Severidade da queima (dNBR) entre <b>${dBR(a.dnbr.antes)}</b> e <b>${dBR(a.dnbr.depois)}</b>`,
        `Área queimada com severidade moderada ou maior: <b>${br(a.dnbr.queimado_ha, 1)} ha</b> no recorte de ${br((a.area?.lado_m || 4000) / 1000, 1)} km × ${br((a.area?.lado_m || 4000) / 1000, 1)} km. Cobertura válida ${br((a.dnbr.cobertura_valida || 0) * 100, 0)}%.`, true));
      if (figs.length) { alvo.innerHTML = figs.join(""); R.imgFonte = "análise NDVI pré-calculada pelo motor"; return; }
    } catch (err) { /* cai para a busca ao vivo */ }
  }
  // sem análise pronta: busca ao vivo a cena Sentinel-2 menos nublada antes e depois
  try {
    const dia = 864e5, iso = d => new Date(d).toISOString().slice(0, 10);
    const t0 = +new Date(e.ini.slice(0, 10)), t1 = +new Date(e.fim.slice(0, 10));
    const q = (a, b) => `api/cenas?lat=${e.lat}&lon=${e.lon}&inicio=${a}&fim=${b}&colecoes=sentinel-2-l2a&modo=todas&raio_m=${R.raio}`;
    const [ca, cd] = await Promise.all([getJSON(q(iso(t0 - 60 * dia), iso(t0 - dia)), 60000), getJSON(q(iso(t1 + dia), iso(Math.min(Date.now(), t1 + 45 * dia))), 60000)]);
    const melhor = (l, alvoT) => l.slice().sort((x, y) => (x.nuvem_cena - y.nuvem_cena) || (Math.abs(+new Date(x.data) - alvoT) - Math.abs(+new Date(y.data) - alvoT)))[0];
    const a = ca.length && melhor(ca, t0), d = cd.length && melhor(cd, t1);
    const url = c => `api/imagem?colecao=${c.colecao}&id=${encodeURIComponent(c.id)}&lat=${e.lat}&lon=${e.lon}&lado_m=4000&produto=rgb&raio_m=${R.raio}`;
    const figs = [];
    figs.push(a ? fig(url(a), `Figura 04 — Imagem anterior ao evento: <b>${dBR(a.data)}</b>`, `${esc(a.id)} · ${esc(a.plataforma || "Sentinel-2")} · cor verdadeira · nuvem na cena ${br(a.nuvem_cena, 0)}%`)
      : `<figure><p class="nota">Sem cena Sentinel-2 nos 60 dias anteriores ao primeiro foco.</p></figure>`);
    figs.push(d ? fig(url(d), `Figura 05 — Imagem posterior ao evento: <b>${dBR(d.data)}</b>`, `${esc(d.id)} · ${esc(d.plataforma || "Sentinel-2")} · cor verdadeira · nuvem na cena ${br(d.nuvem_cena, 0)}%`)
      : `<figure><p class="nota">Ainda sem cena Sentinel-2 posterior ao último foco.</p></figure>`);
    alvo.innerHTML = figs.join("");
    R.imgFonte = "Sentinel-2 L2A (Microsoft Planetary Computer), escolhida a cena de menor nuvem na janela";
  } catch (err) {
    alvo.innerHTML = `<p class="nota">Não foi possível obter imagens Sentinel-2 agora (${esc(err.message || err)}). Tente "Recalcular" em alguns minutos.</p>`;
  }
}
const fig = (src, tit, leg, larga) => `<figure class="${larga ? "larga" : ""}"><img src="${src}" alt="" loading="eager"><figcaption>${tit}<br>${leg}</figcaption></figure>`;

// ------------------------------------------------------------ mapas (convertidos em imagem para imprimir)
const MAPAS = [];
function desenharMapas(refazer) {
  MAPAS.splice(0).forEach(m => { try { m.remove(); } catch (e) {} });
  const e = R.e;
  const geo = (k, fc) => fc ? fc : turf.featureCollection([]);
  const muds = turf.featureCollection((R.Q.mudancas?.features || []).filter(f => f.properties.evento === e.id));
  const brm = turf.featureCollection([...(R.brm || []), ...(R.desm || []).map(x => ({a: x.a, d: 1}))].map(({a, d}) => turf.point([a[6], a[5]], {t: d ? "D" : a[1]})));
  const camadas = (m, comRaio) => {
    m.addSource("ti", {type: "geojson", data: geo("ti", R.geoTI)}); m.addLayer({id: "ti", type: "line", source: "ti", paint: {"line-color": COR.ti, "line-width": 2, "line-dasharray": [3, 2]}});
    m.addSource("uc", {type: "geojson", data: geo("uc", R.geoUC)}); m.addLayer({id: "uc", type: "line", source: "uc", paint: {"line-color": COR.uc, "line-width": 2, "line-dasharray": [1, 1.5]}});
    m.addSource("quil", {type: "geojson", data: geo("quil", R.geoQUIL)}); m.addLayer({id: "quil", type: "line", source: "quil", paint: {"line-color": COR.quil, "line-width": 2}});
    m.addSource("car", {type: "geojson", data: geo("car", R.geoCAR)}); m.addLayer({id: "car", type: "line", source: "car", paint: {"line-color": COR.car, "line-width": 1.4}});
    m.addSource("emb", {type: "geojson", data: geo("emb", R.geoEMB)}); m.addLayer({id: "emb", type: "fill", source: "emb", paint: {"fill-color": COR.emb, "fill-opacity": .25, "fill-outline-color": COR.emb}});
    m.addSource("mud", {type: "geojson", data: muds}); m.addLayer({id: "mud", type: "fill", source: "mud", paint: {"fill-color": COR.mud, "fill-opacity": .35, "fill-outline-color": COR.mud}});
    if (comRaio) { m.addSource("raio", {type: "geojson", data: R.prox}); m.addLayer({id: "raio", type: "line", source: "raio", paint: {"line-color": COR.raio, "line-width": 1.5, "line-dasharray": [4, 3]}}); }
    m.addSource("ai", {type: "geojson", data: R.ai}); m.addLayer({id: "ai", type: "line", source: "ai", paint: {"line-color": COR.ai, "line-width": 3}});
    m.addSource("brm", {type: "geojson", data: brm}); m.addLayer({id: "brm", type: "circle", source: "brm", paint: {"circle-radius": 5, "circle-color": ["match", ["get", "t"], "C", "#ff8a65", "F", "#ff1744", "D", "#76ff03", "#ffea00"], "circle-stroke-color": "#000", "circle-stroke-width": .8}});
    m.addSource("c", {type: "geojson", data: turf.point([e.lon, e.lat])}); m.addLayer({id: "c", type: "circle", source: "c", paint: {"circle-radius": 5, "circle-color": COR.foco, "circle-stroke-color": "#fff", "circle-stroke-width": 2}});
  };
  const esri = {type: "raster", tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"], tileSize: 256, maxzoom: 19, attribution: "Esri, Maxar, Earthstar"};
  const carto = {type: "raster", tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}"], tileSize: 256, maxzoom: 16, attribution: "Esri, HERE, Garmin"};
  const novo = (id, fonte, bounds, extra) => {
    const el = document.getElementById(id); if (!el) return;
    el.innerHTML = "";
    const m = new maplibregl.Map({container: el, style: {version: 8, sources: {base: fonte}, layers: [{id: "base", type: "raster", source: "base"}]},
      bounds, fitBoundsOptions: {padding: 24}, interactive: false, attributionControl: {compact: true}, preserveDrawingBuffer: true, fadeDuration: 0});
    m.on("load", () => { extra(m); m.once("idle", () => congelar(m, el)); });
    MAPAS.push(m);
  };
  novo("mapaEstado", carto, [[-73.9, -9.9], [-56.0, 2.3]], m => {
    getJSON(DADOS + "municipios.json").then(mun => { m.addSource("mun", {type: "geojson", data: mun}); m.addLayer({id: "mun", type: "line", source: "mun", paint: {"line-color": "#0a1f56", "line-opacity": .35, "line-width": .6}}, "c"); }).catch(() => {});
    m.addSource("c", {type: "geojson", data: turf.point([e.lon, e.lat])});
    m.addLayer({id: "c", type: "circle", source: "c", paint: {"circle-radius": 7, "circle-color": COR.foco, "circle-stroke-color": "#fff", "circle-stroke-width": 2}});
  });
  const b10 = R.bbox10, bai = turf.bbox(turf.buffer(R.ai, R.raio / 1000 * .6, {units: "kilometers"}));
  novo("mapaProx", esri, [[b10[0], b10[1]], [b10[2], b10[3]]], m => camadas(m, true));
  novo("mapaAI", esri, [[bai[0], bai[1]], [bai[2], bai[3]]], m => camadas(m, false));
}
function congelar(m, el) {
  // troca o mapa por uma imagem estática (a impressão de canvas WebGL é instável)
  try {
    const url = m.getCanvas().toDataURL("image/png");
    const img = new Image(); img.src = url; img.style.cssText = "width:100%;height:100%;object-fit:cover;display:block";
    const attr = el.querySelector(".maplibregl-ctrl-attrib-inner")?.textContent || "";
    m.remove(); el.innerHTML = ""; el.appendChild(img);
    if (attr) el.insertAdjacentHTML("beforeend", `<div style="font-size:9px;color:#5b6675;text-align:right">${esc(attr)}</div>`);
  } catch (err) { /* mantém o mapa vivo */ }
}

// ------------------------------------------------------------ HTML
function html() {
  const e = R.e, d = e.det, Q = R.Q, D = Q.est.descricao_indicadores || {};
  const hoje = new Date().toLocaleDateString("pt-BR", {timeZone: "America/Manaus"});
  const restrito = !!R.usuario;
  const muds = (Q.mudancas?.features || []).filter(f => f.properties.evento === e.id);
  const mu = Q.mudancas?.eventos?.[e.id];
  const nivel = s => s >= 85 ? "muito alta" : s >= 70 ? "alta" : s >= 50 ? "atenção" : "baixa";
  const periodo = `${dBR(e.ini)}${e.fim.slice(0, 10) !== e.ini.slice(0, 10) ? " a " + dBR(e.fim) : ""}`;
  return `
  ${restrito ? `<div class="faixa-restrito">CONTÉM DADO RESTRITO (convênio Brasil MAIS) — uso interno, não divulgar</div>` : ""}
  <section class="cartao rel-capa inteiro">
    <div class="cab"><div>
      <span class="selo">Evento ${esc(e.id)}</span> <span class="selo ${e.score >= 70 ? "erro" : e.score >= 50 ? "pend" : "ok"}">Prioridade de verificação ${nivel(e.score)} · ${e.score}/100</span>
      <h1>Relatório analítico de evento de fogo</h1>
      <p class="sub">Documento automatizado gerado pelo Fogo Forense a partir de focos de calor (INPE/NASA), alertas DETER, imagens Sentinel-2/Landsat e bases públicas. Não substitui o exame pericial de local.</p>
    </div></div>
    <div class="linha-meta">
      <span>Município: <b>${esc(e.mun)} - AM</b></span>
      <span>Período do evento: <b>${periodo}</b></span>
      <span>Data do relatório: <b>${hoje}</b></span>
      <span>Dados de: <b>${Q.est.gerado_em ? new Date(Q.est.gerado_em).toLocaleString("pt-BR", {timeZone: "America/Manaus"}) : "–"}</b></span>
      ${R.usuario ? `<span>Emitido por: <b>${esc(R.usuario.nome)}</b> (${esc(R.usuario.orgao)})</span>` : ""}
    </div>
  </section>

  <section class="cartao">
    <h2><span class="num-sec">1</span>Dados da área de interesse (AI)</h2>
    <div class="indicadores">
      <div class="indicador vermelho"><b>${e.n}</b><span>focos de calor no evento</span></div>
      <div class="indicador ouro"><b>${e.maxDia}</b><span>máximo no mesmo dia</span></div>
      <div class="indicador azul"><b>${ha2(R.ai_ha)}</b><span>hectares na AI (raio ${br(R.raio, 0)} m)</span></div>
      <div class="indicador azul"><b>${mu ? br(mu.area_total_ha, 1) : "–"}</b><span>ha com mudança detectada (S2/S1)</span></div>
    </div>
    <div class="rotulo">Tabela 01 — Localização e identificação do evento</div>
    <table class="tabela kv"><tbody>
      <tr><td>Município</td><td>${esc(e.mun)} - AM · ${br(e.dist, 0)} km de Manaus</td></tr>
      <tr><td>Centroide do evento</td><td class="mono">${dms(e.lat, "lat")}; ${dms(e.lon, "lon")} &nbsp;(${e.lat.toFixed(5)}, ${e.lon.toFixed(5)})</td></tr>
      <tr><td>Área de interesse (AI)</td><td>Círculo de ${br(R.raio, 0)} m de raio em torno do centroide dos focos (${ha2(R.ai_ha)} ha). A AI é convencional: os focos têm resolução de 375 m a 1 km e não delimitam a área queimada.</td></tr>
      <tr><td>Sistema de referência</td><td>WGS 84 (EPSG:4326); diferença para SIRGAS 2000 (EPSG:4674) inferior a 1 m, desprezível nesta escala</td></tr>
      <tr><td>Primeira detecção</td><td class="mono">${esc(e.ini)} UTC · ${manaus(e.ini)} Manaus</td></tr>
      <tr><td>Última detecção</td><td class="mono">${esc(e.fim)} UTC · ${manaus(e.fim)} Manaus</td></tr>
      <tr><td>Satélites</td><td>${esc((e.sats || []).join(", ") || "AQUA_M-T")}</td></tr>
      <tr><td>Áreas protegidas no centroide</td><td>${esc(d.ti || "")}${d.ti && d.uc ? " · " : ""}${esc(d.uc || "")}${!d.ti && !d.uc ? "Fora de terra indígena e de unidade de conservação" : ""}</td></tr>
      <tr><td>Indicadores presentes</td><td>${e.ind.length ? e.ind.map(k => esc(D[k]?.[0] || k)).join("; ") : "Nenhum"}</td></tr>
    </tbody></table>
    <div class="figs">
      <figure><div class="mapa" id="mapaEstado"></div><figcaption><b>Figura 01 — Localização no estado</b></figcaption></figure>
      <figure><div class="mapa" id="mapaAI"></div><figcaption><b>Figura 02 — Área de interesse</b> (círculo amarelo) sobre imagem de satélite</figcaption></figure>
      <figure class="larga"><div class="mapa alto" id="mapaProx"></div><figcaption><b>Figura 03 — Entorno de ${RAIO_PROX_KM} km</b> (tracejado branco): bases consultadas e alertas</figcaption>
        <div class="leg-rel"><span><i style="background:${COR.foco}"></i>Centroide do evento</span><span><i style="border:3px solid ${COR.ai}"></i>AI</span>
          <span><i style="border:2px dashed ${COR.ti}"></i>Terra indígena</span><span><i style="border:2px dotted ${COR.uc}"></i>Unidade de conservação</span>
          <span><i style="border:2px solid ${COR.car}"></i>CAR (imóveis na AI)</span><span><i style="background:${COR.emb};opacity:.6"></i>Embargo IBAMA</span>
          <span><i style="border:2px solid ${COR.quil}"></i>Território quilombola</span><span><i style="background:${COR.mud};opacity:.7"></i>Mudança detectada (S2/S1)</span>
          ${restrito && (R.brm.length || R.desm.length) ? `<span><i style="background:#ff1744;border-radius:50%"></i>Brasil MAIS: fogo · <i style="background:#ff8a65;border-radius:50%"></i>cicatriz · <i style="background:#ffea00;border-radius:50%"></i>foco IA · <i style="background:#76ff03;border-radius:50%"></i>desmatamento/garimpo <span class="tarja">RESTRITO</span></span>` : ""}</div></figure>
    </div>
  </section>

  <section class="cartao">
    <h2><span class="num-sec">2</span>Detecções e alertas</h2>
    <div class="rotulo">Tabela 02 — Cronologia das detecções por passagem de satélite</div>
    ${d.passagens?.length ? `<table class="tabela"><thead><tr><th>#</th><th>Data e hora (UTC)</th><th>Hora de Manaus</th><th>Satélite</th><th>Focos na passagem</th><th>FRP máx.</th></tr></thead><tbody>
      ${d.passagens.map(([t, sat, n, frp], i) => `<tr><td>${i + 1}</td><td class="mono">${esc(t)}</td><td class="mono">${manaus(t)}</td><td>${esc(sat)}</td><td class="n">${n}</td><td class="n">${frp != null ? br(frp, 1) + " MW" : "–"}</td></tr>`).join("")}</tbody></table>
      ${d.n_passagens > d.passagens.length ? `<p class="nota">Mostrando ${d.passagens.length} de ${d.n_passagens} passagens.</p>` : ""}` : `<p class="nota">Sem detalhamento por passagem para este evento.</p>`}
    <p class="nota">Focos da mesma passagem são simultâneos. A primeira detecção registra fogo detectável naquele instante: não é a hora nem o ponto da ignição.</p>

    <div class="rotulo">Tabela 03 — Alertas oficiais e automáticos associados</div>
    <table class="tabela"><thead><tr><th>Fonte</th><th>Classe</th><th>Data</th><th>Área</th><th>Observação</th></tr></thead><tbody>
      ${d.desmatamento ? `<tr><td>DETER (INPE)</td><td>Desmatamento (${esc((d.desmatamento.classes || []).join(", "))})</td><td>${d.desmatamento.dias_antes > 0 ? d.desmatamento.dias_antes + " dias antes do fogo" : "mesmo período"}</td><td class="n">${br(d.desmatamento.area_km2 * 100, 1)} ha</td><td>${d.desmatamento.alertas} alerta(s)</td></tr>` : ""}
      ${d.cicatriz_km2 != null ? `<tr><td>DETER (INPE)</td><td>Cicatriz de queimada</td><td class="mono">${dBR(d.cicatriz_data)}</td><td class="n">${br(d.cicatriz_km2 * 100, 1)} ha</td><td>Polígono generalizado</td></tr>` : ""}
      ${muds.map(f => `<tr><td>Fogo Forense (automático)</td><td>Mudança · ${{ambos: "óptico e radar", optico: "óptico (Sentinel-2)", radar: "radar (Sentinel-1)"}[f.properties.fonte] || esc(f.properties.fonte)}</td><td class="mono">${dBR(f.properties.inicio_fogo)} a ${dBR(f.properties.depois_ate)}</td><td class="n">${br(f.properties.ha, 1)} ha</td><td>Não validado por analista</td></tr>`).join("")}
      ${!d.desmatamento && d.cicatriz_km2 == null && !muds.length ? `<tr><td colspan="5" class="nota">Nenhum alerta DETER ou de mudança associado a este evento.</td></tr>` : ""}
    </tbody></table>
    <p class="nota">Os polígonos de cicatriz e de mudança abrangem a região da ocorrência e podem conter vegetação remanescente: as áreas são aproximações.</p>
    ${blocoBrmais()}
  </section>

  <section class="cartao quebra">
    <h2><span class="num-sec">3</span>Imagens de antes e depois</h2>
    <div class="figs" id="figImagens"><p class="carregando">Buscando imagens…</p></div>
    ${restrito && R.brm.some(x => x.a[10]) ? `<p class="nota">Imagens Planet (3 m) dos alertas Brasil MAIS: links na Tabela 04 <span class="tarja">RESTRITO</span>.</p>` : ""}
  </section>

  <section class="cartao" id="secBases"><h2><span class="num-sec">4</span>Consultas às bases de dados</h2><p class="carregando">Consultando CAR, embargos, terras indígenas, unidades de conservação e territórios quilombolas…</p></section>

  <section class="cartao quebra">
    <h2><span class="num-sec">5</span>Matriz de hipóteses</h2>
    ${typeof P.blocoConfronto === "function" ? P.blocoConfronto(e) : ""}
    <div class="porque calmo" style="font-size:13px">Este relatório reúne indícios técnicos e não atribui origem, causa ou autoria. Seguindo os guias do NIPED: <b>origem</b> (onde o fogo começou), <b>causa</b> (como começou) e <b>autoria</b> (quem o provocou) exigem demonstrações próprias, com perícia de local; a primeira detecção por satélite não marca o ponto nem a hora da ignição; a prioridade de verificação ordena o trabalho e não é prova.</div>
  </section>

  <section class="cartao">
    <h2><span class="num-sec">6</span>Fontes dos dados</h2>
    <table class="tabela"><thead><tr><th>Camada</th><th>Fonte</th><th>Endereço</th><th>Situação</th></tr></thead><tbody>
      ${FONTES.map(([c, f, u, s]) => `<tr><td>${c}</td><td>${f}</td><td style="word-break:break-all;font-size:11.5px">${u}</td><td>${s}</td></tr>`).join("")}
      ${restrito ? `<tr><td>Alertas Brasil MAIS <span class="tarja">RESTRITO</span></td><td>Polícia Federal (convênio) · Planet 3 m</td><td style="font-size:11.5px">plataforma-pf.sccon.com.br</td><td>Exportação recebida pelo NIPED</td></tr>` : ""}
    </tbody></table>
    <p class="nota">Os resultados das consultas dependem da qualidade topológica de cada base e do momento da consulta.</p>
  </section>

  <section class="cartao">
    <h2><span class="num-sec">7</span>Glossário</h2>
    <dl class="glossario">${GLOSSARIO.map(([t, d]) => `<div><dt>${t}</dt><dd>${d}</dd></div>`).join("")}</dl>
  </section>
  <p class="rodape-rel">Fogo Forense · Desenvolvido pelo NIPED/PCAM · DPTC</p>`;
}

function blocoBrmais() {
  if (!R.usuario) return "";
  const l = R.brm, M = P.BRM?.meta || {tipos: {}};
  const tI = P.BRM?.meta?.img || "https://imagens-alertas.sccon.com.br/api/images/v2/alerts/generate?alertUUID={uuid}&imageDescription={qual}";
  const tR = P.BRM?.meta?.raa || "https://plataforma-pf.sccon.com.br/#/dashboard/view-raa/{id}";
  const img = (a, q) => tI.replace("{uuid}", a[10]).replace("{qual}", q), raa = a => tR.replace("{id}", a[0]);
  return `<div class="clima-bloco restrito">
    <div class="rotulo" style="margin-top:0">Tabela 04 — Alertas Brasil MAIS próximos <span class="tarja">RESTRITO</span></div>
    ${l.length ? `<table class="tabela"><thead><tr><th>ID do alerta</th><th>Classe</th><th>Imagem antes</th><th>Imagem depois</th><th>Centroide</th><th>Área</th><th>Distância</th><th>Planet / RAA</th></tr></thead><tbody>
      ${l.map(({a, km}) => `<tr><td class="mono">${esc(a[0])}</td><td>${esc(M.tipos[a[1]] || a[1])}</td><td class="mono">${dBR(a[3])}</td><td class="mono">${dBR(a[4])}</td>
        <td class="mono" style="font-size:11.5px">${dms(a[5], "lat")}<br>${dms(a[6], "lon")}</td><td class="n">${ha2(a[2])} ha</td><td class="n">${br(km, 2)} km</td>
        <td>${a[10] ? `<a href="${img(a, "before")}" target="_blank" rel="noopener">antes</a> · <a href="${img(a, "after")}" target="_blank" rel="noopener">depois</a> · ` : ""}<a href="${raa(a)}" target="_blank" rel="noopener">RAA</a></td></tr>`).join("")}
      </tbody></table>
      <p class="nota">Alertas a até 5 km do centroide, com imagem posterior entre 30 dias antes do primeiro foco e 60 dias depois do último. IDs Planet: ${l.slice(0, 6).map(({a}) => `${esc(a[8])} → ${esc(a[9])}`).join("; ")}${l.length > 6 ? "…" : ""}.</p>`
      : `<p class="nota">Nenhum alerta Brasil MAIS a até 5 km nesse período.</p>`}
    ${blocoDesmRel(img, raa)}
    <p class="nota">O "foco de queimada (IA)" do Brasil MAIS indica a área provável de início segundo o produto, só em vegetação primária: é hipótese espacial a confrontar, não ponto de ignição demonstrado. Imagens e RAA exigem login na plataforma da PF. Dado de convênio: uso restrito.</p></div>`;
}

function blocoDesmRel(img, raa) {
  const l = R.desm, M = P.DESM?.meta;
  if (!M) return "";
  return `<div class="rotulo">Tabela 04b — Alertas Brasil MAIS de desmatamento e garimpo a até 5 km <span class="tarja">RESTRITO</span></div>
    ${l.length ? `<table class="tabela"><thead><tr><th>ID do alerta</th><th>Classe</th><th>Imagem antes</th><th>Imagem depois</th><th>Área</th><th>Distância</th><th>Planet / RAA</th></tr></thead><tbody>
      ${l.map(({a, km}) => `<tr><td class="mono">${esc(a[0])}</td><td>${esc(M.tipos[a[1]] || a[1])}</td><td class="mono">${dBR(a[3])}</td><td class="mono">${dBR(a[4])}</td><td class="n">${ha2(a[2])} ha</td><td class="n">${br(km, 2)} km</td>
        <td>${a[8] ? `<a href="${img({10: a[8]}, "before")}" target="_blank" rel="noopener">antes</a> · <a href="${img({10: a[8]}, "after")}" target="_blank" rel="noopener">depois</a> · ` : ""}<a href="${raa(a)}" target="_blank" rel="noopener">RAA</a></td></tr>`).join("")}</tbody></table>
      <p class="nota">Imagem posterior entre 12 meses antes do primeiro foco e 60 dias depois do último. Desmatamento anterior ao fogo é compatível com derrubada seguida de queima, mas não demonstra a causa.</p>`
      : `<p class="nota">Nenhum alerta de desmatamento ou garimpo nesse raio e período.</p>`}`;
}

function htmlBases() {
  const res = (ha, dist, erro, nao) => nao ? `<span class="res-nd">Não consultado</span>` : erro ? `<span class="res-nd">Falha na consulta</span>`
    : ha > 0 ? `<span class="res-sim">Sobrepõe a AI</span>` : dist != null && dist <= RAIO_PROX_KM * 1000 ? `<span class="res-nd">A ${br(dist / 1000, 2)} km</span>` : `<span class="res-nao">Fora do raio de ${RAIO_PROX_KM} km</span>`;
  const agg = (l, filtro = () => true) => {
    if (l == null) return {erro: true};
    const x = l.filter(o => filtro(o.f));
    return {ha: x.reduce((t, o) => t + (o.ha || 0), 0), dist: x.length ? Math.min(...x.map(o => o.dist ?? Infinity)) : null, n: x.length};
  };
  const linhas = [
    ["CAR — área declarada (imóveis)", R.car == null ? {erro: true} : {ha: R.car.reduce((t, o) => Math.max(t, o.ha || 0), 0), dist: R.car.length ? 0 : null, n: R.car.length}, "Sobreposição: maior área de um imóvel (imóveis do CAR se sobrepõem entre si)"],
    ["UC — Proteção Integral", agg(R.ucs, f => f.properties.grupo === "PI")],
    ["UC — Uso Sustentável", agg(R.ucs, f => f.properties.grupo !== "PI")],
    ["Terras Indígenas", agg(R.tis)],
    ["Territórios Quilombolas", agg(R.quil)],
    ["Embargos IBAMA", R.emb == null ? {erro: true} : agg(R.emb)],
    ["Embargos ICMBio", {nao: true}],
    ["ANM (processos minerários)", {nao: true}],
  ];
  const tab = `<div class="rotulo">Tabela 05 — Resumo das consultas (sobreposição com a AI e proximidade até ${RAIO_PROX_KM} km)</div>
    <table class="tabela"><thead><tr><th>Base</th><th>Feições no raio</th><th>Sobreposição com a AI (ha)</th><th>Menor distância da AI</th><th>Resultado</th></tr></thead><tbody>
    ${linhas.map(([t, r, obs]) => `<tr><td>${t}${obs ? `<br><span class="nota">${obs}</span>` : ""}</td><td class="n">${r.nao || r.erro ? "–" : r.n}</td><td class="n">${r.nao || r.erro ? "–" : ha2(r.ha)}</td>
      <td class="n">${r.nao || r.erro || r.dist == null || !isFinite(r.dist) ? "–" : r.dist === 0 ? "0 m" : br(r.dist, 0) + " m"}</td><td>${res(r.ha, r.dist, r.erro, r.nao)}</td></tr>`).join("")}
    </tbody></table>
    <p class="nota">Distância medida da borda da AI até o polígono. ICMBio e ANM não oferecem serviço público acessível pelo navegador nesta versão.</p>`;

  const det = [];
  if (R.car?.length) det.push(`<div class="rotulo">Tabela 06 — Imóveis do CAR que sobrepõem a AI</div>
    <table class="tabela"><thead><tr><th>Código do imóvel (CAR)</th><th>Área do imóvel</th><th>Situação</th><th>Condição</th><th>Sobreposição com a AI</th></tr></thead><tbody>
    ${R.car.map(({f, ha}) => { const p = f.properties; return `<tr><td class="mono" style="font-size:11.5px">${esc(p.cod_imovel)}</td><td class="n">${br(p.area, 2)} ha</td><td>${esc({AT: "Ativo", PE: "Pendente", SU: "Suspenso", CA: "Cancelado"}[p.status_imovel] || p.status_imovel)}</td><td>${esc(p.condicao)}</td><td class="n">${ha == null ? "erro topológico" : ha2(ha) + " ha"}</td></tr>`; }).join("")}
    </tbody></table>`);
  else if (R.car) det.push(`<p class="nota">Nenhum imóvel do CAR sobrepõe a AI.</p>`);
  const prot = [...(R.tis || []).map(o => ["Terra Indígena", `${esc(o.f.properties.terrai_nom)} (${esc(o.f.properties.etnia_nome)}) · ${esc(o.f.properties.fase_ti)}`, o]),
    ...(R.ucs || []).map(o => [o.f.properties.grupo === "PI" ? "UC — Proteção Integral" : "UC — Uso Sustentável", `${esc(o.f.properties.nome)} · ${esc(o.f.properties.categoria)} · esfera ${esc(o.f.properties.esfera)}`, o]),
    ...(R.quil || []).map(o => ["Território Quilombola", `${esc(o.f.properties.nm_comunid)} · ${esc(o.f.properties.nm_municip)} · processo ${esc(o.f.properties.nr_process)}`, o])];
  if (prot.length) det.push(`<div class="rotulo">Tabela 07 — Áreas protegidas e territórios até ${RAIO_PROX_KM} km</div>
    <table class="tabela"><thead><tr><th>Tipo</th><th>Descrição</th><th>Sobreposição com a AI</th><th>Distância da AI</th></tr></thead><tbody>
    ${prot.map(([t, ds, o]) => `<tr><td>${t}</td><td>${ds}</td><td class="n">${o.ha == null ? "–" : ha2(o.ha) + " ha"}</td><td class="n">${o.dist === 0 ? "0 m" : br(o.dist, 0) + " m"}</td></tr>`).join("")}</tbody></table>`);
  if (R.emb?.length) det.push(`<div class="rotulo">Tabela 08 — Embargos do IBAMA até ${RAIO_PROX_KM} km</div>
    <table class="tabela"><thead><tr><th>Termo de embargo</th><th>Processo</th><th>Data</th><th>Área embargada</th><th>Descrição</th><th>Distância da AI</th></tr></thead><tbody>
    ${R.emb.map(({f, dist, ha}) => { const p = f.properties; return `<tr><td class="mono">${esc(p.num_tad)}${p.serie_tad ? "-" + esc(p.serie_tad) : ""}</td><td class="mono" style="font-size:11.5px">${esc(p.num_processo)}</td>
      <td class="mono">${p.dat_embargo ? new Date(p.dat_embargo).toLocaleDateString("pt-BR") : "–"}</td><td class="n">${br(p.qtd_area_embargada, 2)} ha</td><td style="font-size:12px">${esc((p.des_tad || "").slice(0, 160))}</td>
      <td class="n">${ha > 0 ? "sobrepõe" : br(dist, 0) + " m"}</td></tr>`; }).join("")}</tbody></table>
    <p class="nota">Dados pessoais do embargado (nome, CPF/CNPJ) omitidos neste relatório; constam na base pública do IBAMA.</p>`);
  return `<h2><span class="num-sec">4</span>Consultas às bases de dados</h2>${tab}${det.join("")}`;
}

const FONTES = [
  ["Focos de calor", "INPE — Programa Queimadas (satélite de referência e todos os satélites)", "https://terrabrasilis.dpi.inpe.br/queimadas/", "Atualizado a cada 10 min"],
  ["Alertas tempo real", "NASA FIRMS (VIIRS)", "https://firms.modaps.eosdis.nasa.gov/", "Atualizado a cada 10 min"],
  ["DETER (desmatamento e cicatriz)", "INPE — TerraBrasilis", "https://terrabrasilis.dpi.inpe.br/", "Diário"],
  ["Imagens Sentinel-2 / Landsat / Sentinel-1", "ESA Copernicus · USGS · Microsoft Planetary Computer", "https://planetarycomputer.microsoft.com/", "Consulta no momento"],
  ["CAR — imóveis (área declarada)", "SICAR / Serviço Florestal Brasileiro", "https://geoserver.car.gov.br/geoserver/sicar/wfs", "Consulta no momento"],
  ["Embargos IBAMA", "IBAMA — PAMGIA", "https://pamgia.ibama.gov.br/server/rest/services/01_Publicacoes_Bases/adm_embargos_ibama_a", "Consulta no momento"],
  ["Terras Indígenas", "FUNAI", "https://www.gov.br/funai/pt-br/atuacao/terras-indigenas/geoprocessamento-e-mapas", "Base do motor"],
  ["Unidades de Conservação", "MMA — CNUC", "https://www.gov.br/mma/pt-br/assuntos/biodiversidade-e-biomas/areas-protegidas/plataforma-cnuc-1", "Base do motor"],
  ["Territórios Quilombolas", "INCRA — Acervo Fundiário", "https://acervofundiario.incra.gov.br/", "Baixado em 19/10/2026"],
  ["Embargos ICMBio · ANM", "ICMBio · ANM", "–", "Não consultado"],
];
const GLOSSARIO = [
  ["AI (área de interesse)", "Círculo em torno do centroide dos focos usado para as consultas de sobreposição; o raio é escolhido no topo do relatório."],
  ["Centroide do evento", "Média das coordenadas dos focos agrupados no evento (DBSCAN), em graus, minutos e segundos."],
  ["Foco de calor", "Pixel do sensor (375 m a 1 km) com anomalia térmica; indica fogo ativo na passagem, não a área queimada."],
  ["Passagem", "Momento em que o satélite imageia a região; focos da mesma passagem são simultâneos."],
  ["Prioridade de verificação", "Ordenação do trabalho a partir de indicadores públicos (0 a 100). Não é probabilidade de crime nem prova."],
  ["DETER", "Sistema de alertas de desmatamento e degradação do INPE, inclusive cicatrizes de queimada."],
  ["Mudança detectada (S2/S1)", "Polígono automático de perda de vegetação ou queima (Sentinel-2, dNBR/ΔNDVI) e/ou abertura de dossel no radar Sentinel-1 (queda de VH)."],
  ["dNBR", "Diferença do índice de queima normalizado entre antes e depois: mede a severidade da queima."],
  ["NDVI", "Índice de vegetação; quedas sustentadas indicam perda de cobertura vegetal."],
  ["Sobreposição", "Área (ha) em comum entre a AI e o polígono da base consultada."],
  ["Proximidade", "Menor distância entre a borda da AI e o polígono, até 10 km."],
  ["Origem, causa e autoria", "Questões periciais distintas: onde começou, como começou e quem provocou. Cada uma exige demonstração própria."],
];

$("#imprimir").onclick = () => window.print();
$("#refazer").onclick = () => montar();
iniciar().catch(err => { console.error(err); estado("Erro", true); $("#folha").insertAdjacentHTML("afterbegin", `<div class="cartao"><p class="res-sim">Erro ao montar o relatório: ${esc(err.message)}</p></div>`); });
