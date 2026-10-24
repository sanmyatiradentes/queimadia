/* Fogo Forense — relatório analítico de evento de fogo (imprimível), no formato do relatório do Brasil MAIS:
   área de interesse, alertas, imagens, consulta às bases por sobreposição e proximidade, matriz de hipóteses,
   referências e glossário. Abre com relatorio.html?id=EVENTO, a partir do botão da ficha. */
"use strict";
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"}[c]));
const br = (v, d = 2) => v == null || Number.isNaN(v) ? "–" : Number(v).toLocaleString("pt-BR", {minimumFractionDigits: d, maximumFractionDigits: d});
const fmt = n => (n ?? 0).toLocaleString("pt-BR");
const dBR = s => s ? String(s).slice(0, 10).split("-").reverse().join("/") : "–";
const DADOS = window.QUEIMADIA_DADOS;
const PQ = new URLSearchParams(location.search);
// por evento (?id=) ou por ponto de interesse (?lat=&lon=&data=), quando a análise foi feita numa coordenada
const PONTO = !PQ.get("id") && PQ.get("lat") && PQ.get("lon") ? {lat: +PQ.get("lat"), lon: +PQ.get("lon"), data: (PQ.get("data") || new Date().toISOString()).slice(0, 10)} : null;
// área desenhada no mapa (mão livre): 'lon,lat;lon,lat;...'
const POLI = (() => { const t = PQ.get("poli"); if (!t) return null;
  const p = t.split(";").map(x => x.split(",").map(Number)).filter(x => x.length === 2 && x.every(Number.isFinite)); return p.length >= 3 ? p : null; })();
const hashTxt = t => { let h = 0; for (const c of t) h = (h * 31 + c.charCodeAt(0)) | 0; return (h >>> 0).toString(36); };
const ID = PQ.get("id") || (PONTO && Number.isFinite(PONTO.lat + PONTO.lon) ? `P${PONTO.lat.toFixed(4)}_${PONTO.lon.toFixed(4)}_${PONTO.data}${POLI ? "_" + hashTxt(PQ.get("poli")) : ""}` : null);
const RAIO_INICIAL = +PQ.get("raio") || null;
const RAIO_ALERTAS_KM = 5, PROX_KM = 10;
const COR = {ai: "#ffdf00", car: "#ffffff", emb: "#ff1744", ti: "#d4a017", ucpi: "#00c853", ucus: "#69f0ae", quil: "#ff9100", anm: "#40c4ff",
  brC: "#ff8a65", brF: "#ff1744", brI: "#ffea00", brD: "#76ff03", brG: "#e040fb"};
let R = {}; const mapas = [];

async function dj(n) { const r = await fetch(window.QD(n, Date.now())); if (!r.ok) throw new Error(n + " " + r.status); return r.json(); }
async function api(u) { const r = await fetch(u, {credentials: "same-origin"}); if (!r.ok) throw new Error(u + " " + r.status); return r.json(); }
function estado(t, ok) { $("#estadoTxt").textContent = t; $("#estado").classList.toggle("atrasado", ok === false); }
function descompactar(d) {
  return d.eventos.map(a => ({id: a[0], lat: a[1], lon: a[2], score: a[3], n: a[4], maxDia: a[5], ini: a[6], fim: a[7],
    mun: a[8], dist: a[9], det: a[11] || {}, sats: a[12] || [], ia: a[13], ind: d.indicadores.filter((k, i) => a[10] & (1 << i))}));
}
function dms(v, pos, neg) {
  const a = Math.abs(v), g = Math.floor(a), m = Math.floor((a - g) * 60), s = ((a - g) * 60 - m) * 60;
  return `${g}°${m}'${br(s, 2)}"${v < 0 ? neg : pos}`;
}
const centroide = (la, lo) => `${dms(la, "N", "S")}; ${dms(lo, "E", "W")}`;
const kmEntre = (la1, lo1, la2, lo2) => turf.distance([lo1, la1], [lo2, la2], {units: "kilometers"});

// ------------------------------------------------------------ geometria: sobreposição e proximidade
function sobreposicaoHa(f, ai) {
  try { const i = turf.intersect(turf.featureCollection([f, ai])); return i ? turf.area(i) / 1e4 : 0; } catch (e) { return null; }
}
function distanciaM(f, centro, raioM) {   // da borda da AI até o polígono (0 se sobrepõe)
  try {
    if (turf.booleanPointInPolygon(centro, f)) return 0;
    const linhas = turf.flatten(turf.polygonToLine(f)).features;
    const d = Math.min(...linhas.map(l => turf.pointToLineDistance(centro, l, {units: "meters"})));
    return Math.max(0, d - raioM);
  } catch (e) { return null; }
}
function noRetangulo(fc, bb) {
  const caixa = turf.bboxPolygon(bb);
  return (fc?.features || []).filter(f => { try { return turf.booleanIntersects(f, caixa); } catch (e) { return false; } });
}

function eventoDoPonto(p, mun) {
  const pt = turf.point([p.lon, p.lat]);
  const m = mun.features.find(f => { try { return turf.booleanPointInPolygon(pt, f); } catch (x) { return false; } });
  return {id: ID, ponto: true, lat: p.lat, lon: p.lon, ini: p.data + " 00:00", fim: p.data + " 00:00", n: 0, maxDia: 0,
    mun: m?.properties?.nome || "Município não identificado", dist: Math.round(kmEntre(p.lat, p.lon, -3.119, -60.0217)),
    det: {}, sats: [], score: null, ia: null, ind: []};
}

// ------------------------------------------------------------ montagem
async function montar() {
  if (!ID) { $("#folha").innerHTML = `<div class="cartao"><p>Abra o relatório pelo botão <b>Gerar relatório</b> na ficha de um evento.</p></div>`; return; }
  estado("Carregando dados…");
  if (RAIO_INICIAL && !montar.feito) $("#raio").value = RAIO_INICIAL;
  montar.feito = true;
  let raioM = Math.min(5000, Math.max(100, +$("#raio").value || 1000));
  const [est, ev, al, mun, tis, ucs, quil, assent, fpnd, sigef] = await Promise.all([dj("estatisticas.json"), dj("eventos.json"), dj("alertas.json"),
    dj("municipios.json"), dj("tis.json"), dj("ucs.json"), fetch("bases/quilombolas_am.json").then(r => r.json()).catch(() => null), fetch("bases/assentamentos_am.json").then(r => r.json()).catch(() => null),
    fetch("bases/fpnd_am.json").then(r => r.json()).catch(() => null), fetch("bases/sigef_am.json").then(r => r.json()).catch(() => null)]);
  const e = PONTO ? eventoDoPonto(PONTO, mun) : [...descompactar(ev), ...descompactar(al)].find(x => x.id === ID);
  if (!e) { $("#folha").innerHTML = `<div class="cartao"><p>Evento ${esc(ID)} não encontrado nos dados atuais.</p></div>`; estado("Evento não encontrado", false); return; }
  let usuario = null; try { usuario = (await api("api/conta?acao=eu")).usuario; } catch (x) {}
  let guardado = null; try { guardado = JSON.parse(localStorage.getItem("ff_rel_" + ID) || "null"); } catch (x) {}

  const centro = turf.point([e.lon, e.lat]);
  const ai = POLI ? turf.polygon([[...POLI, POLI[0]]]) : turf.circle(centro, raioM / 1000, {steps: 96, units: "kilometers"});
  if (POLI) { raioM = Math.round(Math.sqrt(turf.area(ai) / Math.PI)); $("#raio").closest("label").hidden = true; }
  const aiHa = turf.area(ai) / 1e4;
  const dla = (PROX_KM + raioM / 1000) / 111, dlo = dla / Math.cos(e.lat * Math.PI / 180);
  const bb = [e.lon - dlo, e.lat - dla, e.lon + dlo, e.lat + dla];
  const bbStr = bb.map(v => v.toFixed(4)).join(",");

  estado("Consultando bases públicas…");
  const remota = n => api(`api/bases?base=${n}&bbox=${bbStr}`).then(d => d.features).catch(() => null);
  const [car, emb, anm] = await Promise.all([remota("car"), remota("embargos"), remota("anm")]);

  const tisP = noRetangulo(tis, bb), ucsP = noRetangulo(ucs, bb), quilP = quil ? noRetangulo(quil, bb) : null, assentP = assent ? noRetangulo(assent, bb) : null,
    fpndP = fpnd ? noRetangulo(fpnd, bb) : null, sigefP = sigef ? noRetangulo(sigef, bb) : null;
  const camadas = [
    {k: "car", nome: "CAR — imóveis declarados (SICAR)", l: car, cor: COR.car, prox: false, alerta: "atencao",
      desc: p => `CAR ${esc(p.cod_imovel)} · ${br(p.area, 2)} ha declarados · ${esc(p.tipo_imovel || "")} · ${esc(p.condicao || "")} · situação ${esc(p.status_imovel || "")}`},
    {k: "ucpi", nome: "UC — Proteção Integral", l: ucsP.filter(f => f.properties.grupo === "PI"), cor: COR.ucpi, prox: true, alerta: "sim",
      desc: p => `${esc(p.nome)} · ${esc(p.categoria)} · esfera ${esc(p.esfera)}`},
    {k: "ucus", nome: "UC — Uso Sustentável", l: ucsP.filter(f => f.properties.grupo !== "PI"), cor: COR.ucus, prox: true, alerta: "atencao",
      desc: p => `${esc(p.nome)} · ${esc(p.categoria)} · esfera ${esc(p.esfera)}`},
    {k: "ti", nome: "Terras Indígenas (FUNAI)", l: tisP, cor: COR.ti, prox: true, alerta: "sim",
      desc: p => `TI ${esc(p.terrai_nom)} · povo ${esc(p.etnia_nome)} · ${esc(p.fase_ti)}`},
    {k: "quil", nome: "Comunidades quilombolas (INCRA)", l: quilP, cor: COR.quil, prox: true, alerta: "sim",
      desc: p => `${esc(p.nm_comunid)} · ${esc(p.nm_municip)} · processo ${esc(p.nr_process)} · ${esc(p.esfera || "")}`},
    {k: "fpnd", nome: "Florestas públicas não destinadas (SFB)", l: fpndP, cor: "#7cb342", prox: true, alerta: "sim",
      desc: p => `${esc(p.nome)} · ${esc(p.categoria)} · ${esc(p.governo)} · ${br(+p.area_ha, 0)} ha · ${esc(p.municipio)}`},
    {k: "sigef", nome: "Imóveis certificados SIGEF (INCRA)", l: sigefP, cor: "#ffb300", prox: false, alerta: "atencao",
      desc: p => `${esc(p.nome_area)} · código do imóvel ${esc(p.codigo_imo)}${p.registro_m && p.registro_m !== "None" ? ` · matrícula ${esc(p.registro_m)}` : ""} · ${esc(p.status)} · ${esc(p.situacao_i)} · aprovado em ${esc(p.data_aprov)} · <a href="https://sigef.incra.gov.br/geo/parcela/detalhe/${encodeURIComponent(p.parcela_co)}/" target="_blank" rel="noopener">consultar detentor no SIGEF</a>`},
    {k: "assent", nome: "Assentamentos (INCRA)", l: assentP, cor: "#a1887f", prox: true, alerta: "atencao",
      desc: p => `${esc(p.nome_proje)} · ${esc(p.municipio)} · ${p.num_famili ?? "–"} famílias · ${br(+p.area_calc_, 0)} ha · fase ${esc(p.fase)} · código ${esc(p.cd_sipra)}`},
    {k: "emb", nome: "Embargos IBAMA", l: emb, cor: COR.emb, prox: true, alerta: "sim",
      desc: p => `${p.nome_embargado ? `<b>Embargado: ${esc(p.nome_embargado)}</b>${p.cpf_cnpj_embargado ? ` (${esc(p.cpf_cnpj_embargado)})` : ""} · ` : ""}${p.nome_imovel ? `imóvel ${esc(p.nome_imovel)} · ` : ""}TAD ${esc(p.num_tad)}-${esc(p.serie_tad)} de ${p.dat_embargo ? new Date(p.dat_embargo).toLocaleDateString("pt-BR") : "–"} · ${br(p.qtd_area_embargada, 2)} ha · ${esc(p.des_infracao || "")} · processo ${esc(p.num_processo || "")}`},
    {k: "icmbio", nome: "Embargos ICMBio", l: null, cor: COR.emb, prox: false, alerta: "sim", desc: () => ""},
    {k: "anm", nome: "Processos minerários (ANM/SIGMINE)", l: anm, cor: COR.anm, prox: true, alerta: "atencao",
      desc: p => `Processo ${esc(p.PROCESSO)} · ${esc(p.FASE)} · ${esc(p.SUBS)} (${esc(p.USO)}) · ${br(p.AREA_HA, 2)} ha`},
  ];
  for (const c of camadas) {
    if (!c.l) continue;
    c.itens = c.l.map(f => ({f, ha: sobreposicaoHa(f, ai), m: distanciaM(f, centro, raioM)}))
      .filter(x => (x.ha ?? 0) > 0 || (x.m != null && x.m <= PROX_KM * 1000)).sort((a, b) => (a.m ?? 1e9) - (b.m ?? 1e9));
    c.ha = c.itens.reduce((t, x) => t + (x.ha || 0), 0);
    c.min = c.itens.length ? Math.min(...c.itens.map(x => x.m ?? 1e9)) : null;
  }

  // Brasil MAIS (restrito: só com login aprovado)
  let brm = null;
  if (usuario) {
    estado("Carregando alertas Brasil MAIS (restrito)…");
    try {
      const idx = await api("api/restrito?dados=brmais_indice");
      const anos = [...new Set([e.ini.slice(0, 4), e.fim.slice(0, 4), String(+e.ini.slice(0, 4) - 1)])].filter(a => idx.anos[a]);
      const fogo = (await Promise.all(anos.map(a => api("api/restrito?dados=brmais_" + a).catch(() => ({alertas: []}))))).flatMap(x => x.alertas);
      const cels = new Set(); for (const la of [bb[1], bb[3]]) for (const lo of [bb[0], bb[2]]) cels.add(`${Math.floor(la / .5)}_${Math.floor(lo / .5)}`);
      let dmeta = null; try { dmeta = await api("api/restrito?dados=desm_resumo"); } catch (x) {}
      const desm = dmeta ? (await Promise.all([...cels].filter(c => dmeta.celulas.includes(c)).map(c => api("api/restrito?dados=desm/c_" + c).catch(() => ({alertas: []}))))).flatMap(x => x.alertas) : [];
      const dia = 864e5, t = s => +new Date(String(s).slice(0, 10));
      const perto = (a, la, lo) => ({a, km: kmEntre(e.lat, e.lon, la, lo)});
      brm = {
        idx, dmeta,
        fogo: fogo.filter(a => t(a[4]) >= t(e.ini) - 30 * dia && t(a[4]) <= t(e.fim) + 60 * dia).map(a => perto(a, a[5], a[6])).filter(x => x.km <= RAIO_ALERTAS_KM),
        desm: desm.filter(a => t(a[4]) >= t(e.ini) - 365 * dia && t(a[4]) <= t(e.fim) + 60 * dia).map(a => perto(a, a[5], a[6])).filter(x => x.km <= RAIO_ALERTAS_KM),
      };
      brm.fogo.sort((x, y) => x.km - y.km); brm.desm.sort((x, y) => x.km - y.km);
    } catch (x) { console.error(x); }
  }

  let ndvi = null;
  if (est.analises?.[e.id]) try { ndvi = await dj(`analises/${e.id}.json`); } catch (x) {}
  if (!ndvi) try { const g = JSON.parse(localStorage.getItem("ff_ndvi_" + ID) || "null"); if (g && Date.now() - g.t < 7 * 864e5) ndvi = g.ndvi; } catch (x) {}

  // parecer: o mais recente entre o redigido no painel (memória do navegador) e o do motor
  let parecer = null; try { parecer = JSON.parse(localStorage.getItem("ff_parecer_" + ID) || "null"); } catch (x) {}
  if (!parecer?.texto && ndvi?.parecer?.texto) parecer = {...ndvi.parecer, gerado_em: ndvi.parecer.gerado_em || ndvi.gerado_em};
  const antigo = parecer?.texto && /polic\s*ia|queimadia/i.test(parecer.texto);   // citava o sistema, não a literatura
  R = {e, est, mun, ai, aiHa, raioM, centro, bb, camadas, brm, ndvi, usuario, guardado, parecer: antigo ? null : parecer};
  estado("Desenhando…");
  R.analisando = !ndvi;
  render();
  desenharMapas();
  // um clique: o que faltar (análise de satélite e parecer) é feito aqui mesmo, em sequência
  R.tarefas = (async () => {
    if (!R.ndvi) {
      let cenas = null; try { cenas = JSON.parse(localStorage.getItem("ff_cenas_" + ID) || "null")?.cenas; } catch (x) {}
      try { R.ndvi = await analisarAgora(e, cenas); } catch (x) { console.error(x); R.erroAnalise = x.message; }
      R.analisando = false; render(); desenharMapas();
    }
    if (R.ndvi && !R.parecer?.texto) await gerarParecer();
  })();
  await R.tarefas;
  estado("Pronto para imprimir");
}

// ------------------------------------------------------------ análise de satélite feita pelo próprio relatório
const iso = d => d.toISOString().slice(0, 10);
const somaDias = (s, n) => { const d = new Date(s + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
function progresso(t, f) {
  estado(t);
  const el = $("#progAnalise"); if (!el) return;
  el.querySelector(".txt").textContent = t; el.querySelector("i").style.width = Math.round((f || 0) * 100) + "%";
}
async function postar(u, corpo) {
  const r = await fetch(u, {method: "POST", credentials: "same-origin", headers: {"Content-Type": "application/json"}, body: JSON.stringify(corpo)});
  const d = await r.json(); if (!r.ok) throw new Error(d.detail || d.erro || r.status); return d;
}
async function analisarAgora(e, cenasProntas) {
  const RAIO = e.ponto ? R.raioM || 600 : 600, LADO = Math.max(4000, Math.ceil(RAIO * 2.6 / 500) * 500), ini = e.ini.slice(0, 10), fim = e.fim.slice(0, 10), hoje = iso(new Date());
  const pq = POLI ? "&poli=" + encodeURIComponent(PQ.get("poli")) : "";
  const aIni = somaDias(ini, -730), refFim = somaDias(ini, -60), f = somaDias(fim, 120), aFim = e.ponto || f > hoje ? hoje : f;
  const loc = `lat=${e.lat}&lon=${e.lon}`;
  let med = cenasProntas;
  if (!med?.length) {
    progresso("Análise de satélite · buscando imagens Sentinel-2 e Landsat dos últimos 2 anos…", .03);
    const [c1, c2] = await Promise.all([api(`api/cenas?${loc}&inicio=${aIni}&fim=${refFim}&modo=mes&nuvem_max=70&raio_m=${RAIO}`),
      api(`api/cenas?${loc}&inicio=${refFim}&fim=${aFim}&modo=todas&nuvem_max=80`)]);
    const vistos = new Set(), cenas = [...c1, ...c2].filter(c => !vistos.has(c.id) && vistos.add(c.id));
    if (!cenas.length) throw new Error("nenhuma imagem encontrada para o local e o período");
    med = []; let k = 0, feitos = 0;
    await Promise.all(Array.from({length: 6}, async () => { while (k < cenas.length) { const c = cenas[k++];
      const r = await api(`api/medir?colecao=${c.colecao}&id=${encodeURIComponent(c.id)}&${loc}&raio_m=${RAIO}${pq}`).catch(x => ({erro: x.message}));
      med.push({...c, ...r}); feitos++;
      progresso(`Análise de satélite · medindo a vegetação em ${feitos} de ${cenas.length} imagens…`, .05 + .7 * feitos / cenas.length); } }));
  }
  progresso("Análise de satélite · procurando quebra na série de NDVI…", .78);
  const s = await postar("api/serie", {cenas: med, ref_ini: aIni, ref_fim: refFim, inicio: e.ini, fim: e.fim});
  const imagens = s.periodos.flatMap(p => ["rgb", "ndvi"].map(prod => ({produto: prod, data: p.data, colecao: p.colecao, rotulo: p.rotulo, ndvi: p.ndvi,
    src: `api/imagem?colecao=${p.colecao}&id=${encodeURIComponent(p.id)}&${loc}&lado_m=${LADO}&produto=${prod}&raio_m=${RAIO}${pq}`})));
  let dnbr = null;
  if (s.par_dnbr) {
    progresso("Análise de satélite · calculando a severidade da queima (dNBR)…", .88);
    const [a, b] = s.par_dnbr;
    try {
      const d = await api(`api/dnbr?col_a=${a.colecao}&id_a=${encodeURIComponent(a.id)}&col_b=${b.colecao}&id_b=${encodeURIComponent(b.id)}&${loc}&lado_m=${LADO}&raio_m=${RAIO}${pq}`);
      dnbr = {...d, png: undefined, src: "data:image/png;base64," + d.png, antes: a.data, depois: b.data, cena_antes: a.id, cena_depois: b.id};
    } catch (x) { console.warn("dNBR", x); }
  }
  const ndvi = {evento: {id: e.id, municipio: e.mun, inicio: e.ini, fim: e.fim, score: e.score, lat: e.lat, lon: e.lon},
    area: {lat: e.lat, lon: e.lon, raio_m: RAIO, lado_m: LADO, ...(POLI ? {poligono: POLI} : {})}, periodo: [aIni, aFim], linha_base: [aIni, refFim],
    quebra: s.quebra, dnbr, imagens, cenas: med, n_validas: s.n_validas, gerado_em: new Date().toISOString(), origem: "relatório"};
  try { localStorage.setItem("ff_ndvi_" + e.id, JSON.stringify({t: Date.now(), ndvi})); } catch (x) {}
  progresso("Análise de satélite concluída", 1);
  return ndvi;
}
// ------------------------------------------------------------ gráfico da série de NDVI (SVG, imprimível)
function serieValida(ndvi) {
  const rem = new Set((ndvi.quebra?.removidas_tmask || []).map(r => r.data + r.colecao));
  return (ndvi.cenas || []).filter(c => c.ndvi != null && (c.frac_valida ?? 1) >= .5)
    .map(c => ({...c, tm: c.tmask || rem.has(c.data + c.colecao)})).sort((a, b) => a.data.localeCompare(b.data));
}
function graficoNDVI(ndvi, e) {
  const pts = serieValida(ndvi); if (pts.length < 2) return "";
  const q = ndvi.quebra || {}, W = 900, H = 320, m = {l: 46, r: 14, t: 18, b: 34}, w = W - m.l - m.r, h = H - m.t - m.b;
  const t = d => +new Date(String(d).slice(0, 10) + "T12:00:00Z");
  const t0 = Math.min(t(ndvi.periodo?.[0] || pts[0].data), t(pts[0].data)), t1 = Math.max(t(ndvi.periodo?.[1] || pts.at(-1).data), t(pts.at(-1).data));
  const vmin = Math.max(-.1, Math.floor((Math.min(...pts.map(p => p.ndvi_p10 ?? p.ndvi), q.limiar ?? 1) - .05) * 10) / 10);
  const X = d => m.l + (t(d) - t0) / (t1 - t0) * w, Y = v => m.t + (1 - (v - vmin) / (1 - vmin)) * h;
  const g = [];
  // faixas: linha de base, fogo, quebra
  const faixa = (a, b, cor, op, rot) => { const xa = Math.max(m.l, X(a)), xb = Math.min(m.l + w, Math.max(X(b), X(a) + 3));
    g.push(`<rect x="${xa}" y="${m.t}" width="${xb - xa}" height="${h}" fill="${cor}" opacity="${op}"/>`);
    if (rot) g.push(`<text x="${xa + 4}" y="${m.t + 12}" font-size="11" fill="${cor}" font-weight="700">${rot}</text>`); };
  if (ndvi.linha_base) faixa(ndvi.linha_base[0], ndvi.linha_base[1], "#1b3faa", .07, "Linha de base");
  faixa(e.ini, e.fim, "#c8302f", .28, e.ponto ? "Referência" : "Fogo");
  if (q.data_primeira_abaixo) faixa(q.data_ultima_estavel || q.data_primeira_abaixo, q.data_primeira_abaixo, "#7a1420", .35, q.situacao === "provavel" ? "Queda provável" : "Quebra");
  // grade e eixos
  for (let v = Math.ceil(vmin * 10) / 10; v <= 1.0001; v += .1) g.push(`<line x1="${m.l}" x2="${m.l + w}" y1="${Y(v)}" y2="${Y(v)}" stroke="#e6e9ef"/><text x="${m.l - 6}" y="${Y(v) + 4}" font-size="11" text-anchor="end" fill="#5b6675">${v.toFixed(1).replace(".", ",")}</text>`);
  const d0 = new Date(t0); for (let d = new Date(Date.UTC(d0.getUTCFullYear(), Math.floor(d0.getUTCMonth() / 3) * 3 + 3, 1)); +d <= t1; d.setUTCMonth(d.getUTCMonth() + 3)) {
    const x = m.l + (+d - t0) / (t1 - t0) * w;
    g.push(`<line x1="${x}" x2="${x}" y1="${m.t + h}" y2="${m.t + h + 4}" stroke="#5b6675"/><text x="${x}" y="${m.t + h + 17}" font-size="11" text-anchor="middle" fill="#5b6675">${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCFullYear()).slice(2)}</text>`); }
  g.push(`<line x1="${m.l}" x2="${m.l + w}" y1="${m.t + h}" y2="${m.t + h}" stroke="#5b6675"/><text x="12" y="${m.t + h / 2}" font-size="11" fill="#5b6675" transform="rotate(-90 12 ${m.t + h / 2})" text-anchor="middle">NDVI</text>`);
  // base e limiar
  if (q.ndvi_base != null) g.push(`<line x1="${m.l}" x2="${m.l + w}" y1="${Y(q.ndvi_base)}" y2="${Y(q.ndvi_base)}" stroke="#1b3faa" stroke-dasharray="6 4" stroke-width="1.5"/><text x="${m.l + w - 4}" y="${Y(q.ndvi_base) - 5}" font-size="11" text-anchor="end" fill="#1b3faa">base ${br(q.ndvi_base, 3)}</text>`);
  if (q.limiar != null) g.push(`<line x1="${m.l}" x2="${m.l + w}" y1="${Y(q.limiar)}" y2="${Y(q.limiar)}" stroke="#c8302f" stroke-dasharray="3 3" stroke-width="1.5"/><text x="${m.l + w - 4}" y="${Y(q.limiar) + 14}" font-size="11" text-anchor="end" fill="#c8302f">limiar ${br(q.limiar, 3)}</text>`);
  // linha da série (sem as removidas) e pontos com a variação dentro do círculo (p10–p90)
  const ok = pts.filter(p => !p.tm);
  g.push(`<polyline points="${ok.map(p => `${X(p.data).toFixed(1)},${Y(p.ndvi).toFixed(1)}`).join(" ")}" fill="none" stroke="#14284f" stroke-width="1.2" opacity=".55"/>`);
  for (const p of pts) {
    const x = X(p.data), y = Y(p.ndvi), s2 = String(p.colecao).startsWith("sentinel"), cor = p.tm ? "#9aa4b2" : s2 ? "#0a7a36" : "#b86a00";
    if (p.ndvi_p10 != null && p.ndvi_p90 != null && !p.tm) g.push(`<line x1="${x}" x2="${x}" y1="${Y(p.ndvi_p90)}" y2="${Y(p.ndvi_p10)}" stroke="${cor}" opacity=".35"/>`);
    g.push(s2 ? `<circle cx="${x}" cy="${y}" r="3.6" fill="${p.tm ? "#fff" : cor}" stroke="${cor}" stroke-width="1.4"><title>${dBR(p.data)} · Sentinel-2 · NDVI ${br(p.ndvi, 3)}</title></circle>`
      : `<rect x="${x - 3.4}" y="${y - 3.4}" width="6.8" height="6.8" fill="${p.tm ? "#fff" : cor}" stroke="${cor}" stroke-width="1.4"><title>${dBR(p.data)} · Landsat · NDVI ${br(p.ndvi, 3)}</title></rect>`);
  }
  return `<figure class="larga grafico-ndvi"><svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Série temporal de NDVI" style="display:block;font-family:'Segoe UI',system-ui,sans-serif">${g.join("")}</svg>
    <div class="leg-rel"><span><svg width="10" height="10"><circle cx="5" cy="5" r="4" fill="#0a7a36"/></svg> Sentinel-2</span><span><svg width="10" height="10"><rect x="1" y="1" width="8" height="8" fill="#b86a00"/></svg> Landsat 8/9</span>
      <span><svg width="10" height="10"><circle cx="5" cy="5" r="4" fill="#fff" stroke="#9aa4b2" stroke-width="1.4"/></svg> removida pela triagem Tmask</span><span>| traço vertical: variação no círculo (10%–90%)</span>
      <span><i style="background:#1b3faa;opacity:.25"></i>linha de base</span><span><i style="background:#c8302f;opacity:.45"></i>${e.ponto ? "data de referência" : "período do fogo"}</span>${q.data_primeira_abaixo ? `<span><i style="background:#7a1420;opacity:.6"></i>intervalo da quebra</span>` : ""}</div>
    <figcaption><b>Gráfico</b> — Série temporal do NDVI (mediana dos pixels válidos num círculo de ${ndvi.area?.raio_m || 600} m), ${dBR(pts[0].data)} a ${dBR(pts.at(-1).data)}.</figcaption></figure>`;
}
// leitura do gráfico: os números que sustentam a interpretação
function leituraNDVI(ndvi, e) {
  const pts = serieValida(ndvi).filter(p => !p.tm); if (pts.length < 2) return "";
  const q = ndvi.quebra || {}, ini = e.ini.slice(0, 10), fim = e.fim.slice(0, 10), dia = 864e5, t = d => +new Date(d.slice(0, 10));
  const med = l => { if (!l.length) return null; const v = l.map(p => p.ndvi).sort((a, b) => a - b), k = Math.floor(v.length / 2); return v.length % 2 ? v[k] : (v[k - 1] + v[k]) / 2; };
  const antes = pts.filter(p => p.data < ini && t(p.data) >= t(ini) - 90 * dia), depois = pts.filter(p => p.data > fim && t(p.data) <= t(fim) + 90 * dia);
  const ma = med(antes), md = med(depois), s2 = pts.filter(p => String(p.colecao).startsWith("sentinel")).length;
  const minimo = pts.filter(p => p.data >= ini).sort((a, b) => a.ndvi - b.ndvi)[0];
  const itens = [
    `<b>${pts.length} observações válidas</b> (${s2} Sentinel-2 e ${pts.length - s2} Landsat)${q.removidas_tmask?.length ? `; ${q.removidas_tmask.length} retirada(s) da linha de base pela triagem Tmask (névoa ou sombra residual)` : ""}.`,
    q.ndvi_base != null ? `<b>Linha de base</b> (${dBR(ndvi.linha_base?.[0])} a ${dBR(ndvi.linha_base?.[1])}): NDVI mediano ${br(q.ndvi_base, 3)}, desvio-padrão ${br(q.desvio_base, 3)}, em ${q.n_base} observações. <b>Limiar</b> de perda: ${br(q.limiar, 3)} (base − max(3σ; 0,15)).` : "",
    ma != null || md != null ? `<b>${e.ponto ? "Em torno da data de referência" : "Em torno do fogo"}</b>: NDVI mediano ${ma != null ? br(ma, 3) : "–"} nos 90 dias antes (${antes.length} obs.) e ${md != null ? br(md, 3) : "–"} nos 90 dias depois (${depois.length} obs.)${ma != null && md != null ? ` — variação de <b>${md - ma >= 0 ? "+" : ""}${br(md - ma, 3)}</b>${q.limiar != null && md < q.limiar ? ", abaixo do limiar" : ""}` : ""}.` : "",
    minimo ? `<b>Menor valor</b> ${e.ponto ? "após a referência" : "a partir do fogo"}: ${br(minimo.ndvi, 3)} em ${dBR(minimo.data)}${q.limiar != null ? (minimo.ndvi < q.limiar ? " (abaixo do limiar)" : " (acima do limiar)") : ""}.` : "",
    `<b>Situação</b>: ${textoQuebra(q)}`,
    q.limiar != null && pts.at(-1).ndvi < q.limiar && q.situacao !== "confirmada" ? `<b>Atenção</b>: a observação mais recente (${dBR(pts.at(-1).data)}, NDVI ${br(pts.at(-1).ndvi, 3)}) já está abaixo do limiar. Ainda não há as 6 observações seguidas exigidas para confirmar perda de vegetação: as próximas imagens dirão se a queda se mantém.` : "",
    q.quedas_transitorias?.length ? `<b>Quedas passageiras</b> (com recuperação, não contam como perda): ${q.quedas_transitorias.map(x => `${dBR(x.de)} a ${dBR(x.ate)} (${x.obs} obs.)`).join("; ")}.` : "",
  ].filter(Boolean);
  return `<p class="rotulo">Leitura do gráfico</p><ul class="leitura">${itens.map(i => `<li>${i}</li>`).join("")}</ul>
    <p class="nota">Valores de NDVI acima de ~0,8 são típicos de floresta densa; quedas abruptas e persistentes indicam remoção da vegetação (corte, queima intensa), enquanto quedas curtas seguidas de recuperação costumam ser nuvem fina, fumaça ou variação sazonal.</p>`;
}
function textoQuebra(q) {
  if (!q) return "Sem resultado de quebra.";
  const base = `NDVI de base ${br(q.ndvi_base, 3)} ± ${br(q.desvio_base, 3)} (limiar ${br(q.limiar, 3)}, ${q.n_base ?? "–"} observações na linha de base).`;
  const rel = {antes_do_fogo: " A perda de vegetação começou <b>antes</b> dos focos: compatível com derrubada seguida de queima.",
    no_fogo: " A perda de vegetação coincide com o período do fogo.", indefinida: " A relação temporal com o fogo é indefinida pelo intervalo entre imagens."}[q.relacao_fogo] || "";
  if (q.situacao === "confirmada") return `<b>Quebra confirmada</b>: o NDVI caiu para ${br(q.ndvi_apos, 3)} (queda de ${br(q.queda, 3)}) entre ${dBR(q.data_ultima_estavel)} (última imagem estável) e ${dBR(q.data_primeira_abaixo)} (primeira abaixo do limiar), com ${q.obs_abaixo} observações seguidas abaixo do limiar.${rel} ${base}`;
  if (q.situacao === "provavel") return `<b>Queda provável</b> desde ${dBR(q.data_primeira_abaixo)} (${q.obs_abaixo} observação(ões) abaixo do limiar no fim da série); a confirmação exige 6 consecutivas e aguarda novas imagens.${rel} ${base}`;
  return `${esc(q.motivo || "Sem queda sustentada abaixo do limiar.")} ${base}${q.quedas_transitorias?.length ? ` Houve ${q.quedas_transitorias.length} queda(s) passageira(s), com recuperação.` : ""}`;
}

// ------------------------------------------------------------ método e parecer (literatura científica)
const METODO_LIT = "NDVI (Rouse et al., 1974; Tucker, 1979) como mediana dos pixels válidos num círculo de 600 m; uma cena por mês, com ao menos 80% da área sem nuvem e a menor nuvem na cena; triagem Tmask de névoa e sombra residuais na linha de base (Zhu &amp; Woodcock, 2014b); quebra quando o NDVI fica abaixo de mediana − max(3σ; 0,15) em 6 observações consecutivas, critério de confirmação do CCDC (Zhu &amp; Woodcock, 2014a; Arévalo et al., 2020); severidade da queima por dNBR com as classes do USGS (Key &amp; Benson, 2006). Sentinel-2 L2A e Landsat 8/9 Coleção 2 Nível 2.";
const REFS_LIT = [
  "Rouse, J. W.; Haas, R. H.; Schell, J. A.; Deering, D. W. (1974). Monitoring vegetation systems in the Great Plains with ERTS. NASA SP-351, p. 309–317.",
  "Tucker, C. J. (1979). Red and photographic infrared linear combinations for monitoring vegetation. <i>Remote Sensing of Environment</i>, 8, 127–150.",
  "Zhu, Z.; Woodcock, C. E. (2014a). Continuous change detection and classification of land cover using all available Landsat data. <i>Remote Sensing of Environment</i>, 144, 152–171.",
  "Zhu, Z.; Woodcock, C. E. (2014b). Automated cloud, cloud shadow, and snow detection in multitemporal Landsat data. <i>Remote Sensing of Environment</i>, 152, 217–234.",
  "Arévalo, P.; Bullock, E. L.; Woodcock, C. E.; Olofsson, P. (2020). A suite of tools for continuous land change monitoring in Google Earth Engine. <i>Frontiers in Climate</i>, 2, 576740.",
  "Souza, C. M. et al. (2020). Reconstructing three decades of land use and land cover changes in Brazilian biomes with Landsat archive and Earth Engine. <i>Remote Sensing</i>, 12(17), 2735.",
  "Key, C. H.; Benson, N. C. (2006). Landscape Assessment: sampling and analysis methods. In: <i>FIREMON</i>. USDA Forest Service, RMRS-GTR-164-CD.",
];
const SECOES = "Objeto|Dados e m[ée]todo|Dados|M[ée]todo|Resultados|Matriz de hip[óo]teses|Interpreta[çc][ãa]o t[ée]cnica|Interpreta[çc][ãa]o|Limita[çc][õo]es|Dilig[êe]ncias sugeridas|Dilig[êe]ncias|Refer[êe]ncias";
function parecerHTML(p) {
  if (p?.carregando) return `<p class="carregando">Redigindo o parecer com IA a partir dos números deste relatório…</p>`;
  if (!p?.texto) return `<p class="nota">${p?.erro ? "Parecer indisponível: " + esc(p.erro) + ". " : "O parecer ainda não foi redigido para este evento. "}</p>
    <button type="button" class="botao nao-imprime" id="gerarParecer">Gerar parecer com IA</button>`;
  let t = p.texto.replace(/\r/g, "").replace(/\*\*|__|^#+\s*/gm, "");
  t = t.replace(new RegExp(`\\s+(?=[1-9]\\.\\s+(?:${SECOES})\\b)`, "g"), "\n");
  const linhas = t.split(/\n+/).map(l => l.trim()).filter(Boolean);
  const tit = new RegExp(`^([1-9])\\.\\s+(${SECOES})\\s*[:.–-]?\\s*(.*)$`, "i");
  let ref = false;
  const html = linhas.map(l => {
    const m = l.match(tit);
    if (m) { ref = /^refer/i.test(m[2]); return `<h3><span>${m[1]}.</span> ${esc(m[2])}</h3>${m[3] ? `<p>${esc(m[3])}</p>` : ""}`; }
    return ref ? `<p class="ref">${esc(l)}</p>` : `<p>${esc(l)}</p>`;
  }).join("");
  const quando = p.gerado_em ? new Date(p.gerado_em).toLocaleString("pt-BR", {timeZone: "America/Manaus"}) : null;
  return `<div class="parecer-txt">${html}</div>
    <p class="nota assinatura">Texto redigido por modelo de linguagem${p.modelo ? ` (${esc(p.modelo)})` : ""}${quando ? ` em ${quando}` : ""}, exclusivamente a partir dos números deste relatório. Exige revisão de perito ou analista antes de qualquer uso; não substitui laudo pericial.</p>
    <button type="button" class="botao secundario pequeno nao-imprime" id="gerarParecer">Redigir de novo</button>`;
}
async function gerarParecer() {
  const {e, ndvi} = R;
  R.parecer = {carregando: true}; $("#parecerCorpo").innerHTML = parecerHTML(R.parecer);
  try {
    const corpo = {...ndvi, imagens: undefined, parecer: undefined,
      evento: {...(ndvi.evento || {}), id: e.id, municipio: e.mun, inicio: e.ini, fim: e.fim, pontuacao: e.score, indicadores: e.ind, det: e.det}};
    const r = await fetch("api/parecer", {method: "POST", credentials: "same-origin", headers: {"Content-Type": "application/json"}, body: JSON.stringify(corpo)});
    const d = await r.json();
    if (!r.ok) throw new Error(d.detail || d.erro || "serviço indisponível");
    R.parecer = {...d, gerado_em: new Date().toISOString()};
    try { localStorage.setItem("ff_parecer_" + e.id, JSON.stringify(R.parecer)); } catch (x) {}
  } catch (x) { R.parecer = {erro: x.message}; }
  $("#parecerCorpo").innerHTML = parecerHTML(R.parecer);
}
document.addEventListener("click", ev => { if (ev.target.id === "gerarParecer") gerarParecer(); });

// ------------------------------------------------------------ HTML
const sec = (n, t, corpo, extra = "") => `<section class="cartao ${extra}"><h2><span class="num-sec">${n}</span>${t}</h2>${corpo}</section>`;
const resultado = c => {
  if (!c.l) return `<span class="res-nd">NÃO ANALISADO</span>`;
  if (c.ha > 0) return `<span class="${c.alerta === "sim" ? "res-sim" : "res-nd"}">SOBREPÕE</span>`;
  return `<span class="res-nao">NÃO SOBREPÕE</span>`;
};
function render() {
  const {e, est, aiHa, raioM, camadas, brm, ndvi, usuario, guardado} = R, d = e.det;
  const restrito = !!(usuario && (brm || guardado?.restrito));
  const hoje = new Date().toLocaleDateString("pt-BR", {timeZone: "America/Manaus"});
  const tab = (cab, linhas) => `<div class="rolagem"><table class="tabela"><thead><tr>${cab.map(c => `<th>${c}</th>`).join("")}</tr></thead><tbody>${linhas.join("") || `<tr><td colspan="${cab.length}" class="nota">Nenhum registro.</td></tr>`}</tbody></table></div>`;
  let n = 0; const N = () => ++n;
  const html = [];
  if (restrito) html.push(`<div class="faixa-restrito">DOCUMENTO COM DADOS DE ACESSO RESTRITO (CONVÊNIO BRASIL MAIS) · USO INTERNO · NÃO DIVULGAR</div>`);

  html.push(`<section class="cartao rel-capa inteiro"><span class="nota">PC/AM — Polícia Civil do Amazonas · DPTC · NIPED</span>
    <h1>${e.ponto ? "Relatório analítico de ponto de interesse" : "Relatório analítico de evento de fogo"}</h1>
    <p class="sub">Documento automatizado gerado pelo Fogo Forense a partir de focos de calor por satélite, imagens Sentinel-2/Landsat e bases públicas${restrito ? ", com alertas do Brasil MAIS (imagens Planet de 3 m)" : ""}. Não substitui laudo pericial.</p>
    <div class="linha-meta"><span><b>${e.ponto ? "Ponto" : "Evento"}:</b> ${e.ponto ? `${e.lat.toFixed(5)}, ${e.lon.toFixed(5)}` : esc(e.id)}</span><span><b>Município:</b> ${esc(e.mun)} - AM</span>
      <span><b>${e.ponto ? "Data de referência" : "Período dos focos"}:</b> ${e.ponto ? dBR(e.ini) : `${dBR(e.ini)} a ${dBR(e.fim)}`}</span><span><b>Data do relatório:</b> ${hoje}</span>
      ${usuario ? `<span><b>Gerado por:</b> ${esc(usuario.nome)} (${esc(usuario.orgao)})</span>` : ""}</div></section>`);

  // 1. área de interesse
  html.push(sec(N(), "Dados da área de interesse (AI)", `
    <table class="tabela kv"><tbody>
      <tr><td>Município</td><td>${esc(e.mun)} - AM</td></tr>
      <tr><td>Área de interesse</td><td>${POLI ? `Polígono desenhado no mapa (${POLI.length} vértices)` : `Círculo de ${fmt(raioM)} m de raio no centro ${e.ponto ? "do ponto" : "do evento"}`} · ${br(aiHa, 2)} ha</td></tr>
      <tr><td>Centroide da AI</td><td class="mono">${centroide(e.lat, e.lon)} (${e.lat.toFixed(5)}, ${e.lon.toFixed(5)})</td></tr>
      <tr><td>Sistema de referência</td><td>WGS 84 (EPSG:4326), compatível com SIRGAS 2000 na escala do relatório</td></tr>
      ${e.ponto ? `
      <tr><td>Data de referência</td><td>${dBR(e.ini)} · análise de satélite de 2 anos antes a 120 dias depois</td></tr>
      <tr><td>Origem do ponto</td><td>Coordenada informada na análise de satélite, sem evento de foco de calor associado a até 3 km</td></tr>
` : `
      <tr><td>Focos de calor no evento</td><td>${e.n} focos · até ${e.maxDia} no mesmo dia · primeiro ${esc(e.ini)} UTC · último ${esc(e.fim)} UTC</td></tr>
      <tr><td>Satélites</td><td>${esc(e.sats.join(", ") || "AQUA_M-T")}</td></tr>
      <tr><td>Prioridade de verificação</td><td>${e.score} de 100${e.ia != null ? ` · atipicidade (IA) ${e.ia}/100` : ""}</td></tr>
`}
      <tr><td>Área protegida (painel)</td><td>${esc(d.ti || d.uc || "Fora de TI/UC")}</td></tr>
      <tr><td>Distância de Manaus</td><td>${fmt(e.dist)} km</td></tr>
    </tbody></table>
    <div class="figs">
      <figure><div class="mapa" id="mEstado"></div><figcaption><b>Figura 1</b> — Localização no estado do Amazonas.</figcaption></figure>
      <figure><div class="mapa" id="mLocal"></div><figcaption><b>Figura 2</b> — Área de interesse (amarelo) sobre imagem de satélite (Esri), com as bases consultadas.</figcaption></figure>
      <figure class="larga"><div class="mapa alto" id="mSentinel"></div><figcaption><b>Figura 3</b> — Mosaico Sentinel-2 recente (${dBR(est.mosaico?.periodo?.[0])} a ${dBR(est.mosaico?.periodo?.[1])}, cor verdadeira) com a AI.</figcaption>
        <div class="leg-rel"><span><i style="background:${COR.ai}"></i>AI</span><span><i style="background:${COR.car}"></i>CAR</span><span><i style="background:${COR.emb}"></i>Embargo IBAMA</span>
        <span><i style="background:${COR.ti}"></i>TI</span><span><i style="background:${COR.ucpi}"></i>UC PI</span><span><i style="background:${COR.ucus}"></i>UC US</span><span><i style="background:${COR.quil}"></i>Quilombola</span><span><i style="background:${COR.anm}"></i>ANM</span>
        ${brm ? `<span><i style="background:${COR.brF}"></i>Brasil MAIS fogo</span><span><i style="background:${COR.brD}"></i>Brasil MAIS desmatamento</span>` : ""}</div></figure>
    </div>`));

  // 2. por que está na lista (do painel)
  if (guardado?.porque) html.push(sec(N(), "Sinais que levaram o evento à lista", guardado.porque));

  // 3. alertas
  const mud = guardado?.mudanca || "";
  const brTab = brm ? `
    <p class="rotulo">Alertas de queimada do Brasil MAIS a até ${RAIO_ALERTAS_KM} km (imagem posterior entre 30 dias antes do 1º foco e 60 dias depois do último) <span class="tarja">RESTRITO</span></p>
    ${tab(["Nº", "ID do alerta", "Classe", "Antes", "Depois", "Centroide", "Distância", "Área (ha)"], brm.fogo.slice(0, 40).map(({a, km}, i) =>
      `<tr><td class="n">${i + 1}</td><td class="mono">${esc(a[0])}</td><td>${esc(brm.idx.tipos[a[1]] || a[1])}</td><td class="mono">${dBR(a[3])}</td><td class="mono">${dBR(a[4])}</td><td class="mono">${centroide(a[5], a[6])}</td><td class="n">${br(km, 2)} km</td><td class="n">${br(a[2], 2)}</td></tr>`))}
    ${brm.dmeta ? `<p class="rotulo">Alertas de desmatamento e garimpo do Brasil MAIS a até ${RAIO_ALERTAS_KM} km (12 meses antes do 1º foco a 60 dias depois do último) <span class="tarja">RESTRITO</span></p>
    ${tab(["Nº", "ID do alerta", "Classe", "Antes", "Depois", "Centroide", "Distância", "Área (ha)"], brm.desm.slice(0, 40).map(({a, km}, i) =>
      `<tr><td class="n">${i + 1}</td><td class="mono">${esc(a[0])}</td><td>${esc(brm.dmeta.tipos[a[1]] || a[1])}</td><td class="mono">${dBR(a[3])}</td><td class="mono">${dBR(a[4])}</td><td class="mono">${centroide(a[5], a[6])}</td><td class="n">${br(km, 2)} km</td><td class="n">${br(a[2], 2)}</td></tr>`))}
    <p class="nota">Área total: ${br(brm.desm.reduce((t, x) => t + x.a[2], 0), 2)} ha em ${brm.desm.length} alerta(s)${brm.desm.length > 40 ? " (tabela com os 40 mais próximos)" : ""}.</p>` : ""}
    <p class="nota">As classes Degradação, Corte Seletivo e Cicatriz de Queimada têm delimitação generalizada no Brasil MAIS: o polígono abrange a região da ocorrência e pode conter vegetação remanescente. O "foco de queimada (IA)" indica a área provável de início segundo o produto (só em vegetação primária): é hipótese espacial a confrontar, não ponto de ignição demonstrado.</p>` : "";
  html.push(sec(N(), "Alertas na área e no entorno", `${mud || `<p class="nota">Sem alertas automáticos de mudança (Sentinel-2 e radar Sentinel-1) calculados para este evento.</p>`}${brTab}
    ${!usuario ? `<p class="nota">Alertas do Brasil MAIS (Planet, 3 m) aparecem apenas para usuários com login aprovado.</p>` : ""}`, brm ? "restrito" : ""));

  // 4. imagens e vegetação
  if (!ndvi && R.analisando) {
    html.push(sec(N(), "Imagens de satélite e vegetação (NDVI e dNBR)", `<div id="progAnalise" class="prog-analise"><div class="barra"><i></i></div><p class="txt">Preparando a análise de satélite…</p>
      <p class="nota">Este evento ainda não tinha análise pronta: ela está sendo feita agora (de 1 a 3 minutos). O parecer é redigido em seguida. Pode aguardar nesta página.</p></div>`));
    html.push(sec(N(), "Parecer técnico preliminar (IA)", `<p class="nota">Aguardando a análise de satélite para redigir o parecer.</p>`, "parecer-sec"));
  } else if (!ndvi && R.erroAnalise) {
    html.push(sec(N(), "Imagens de satélite e vegetação (NDVI e dNBR)", `<p class="nota">Não foi possível fazer a análise de satélite agora (${esc(R.erroAnalise)}). Clique em <b>Recalcular</b> no topo para tentar de novo.</p>`));
  }
  if (ndvi) {
    const img = (ndvi.imagens || []).filter(i => i.produto === "rgb");
    const dn = ndvi.dnbr;
    html.push(sec(N(), "Imagens de satélite e vegetação (NDVI e dNBR)", `
      <div class="figs">${graficoNDVI(ndvi, e)}</div>${leituraNDVI(ndvi, e)}
      <div class="figs">${img.map((i, k) => `<figure><img src="${i.src || DADOS + "analises/" + encodeURIComponent(i.arquivo)}" alt="Imagem ${esc(i.rotulo)}"><figcaption><b>Figura ${4 + k}</b> — ${esc(i.rotulo)}: ${dBR(i.data)} · ${esc(i.colecao)} · NDVI médio ${br(i.ndvi, 3)}</figcaption></figure>`).join("")}
      ${dn?.arquivo || dn?.src ? `<figure><img src="${dn.src || DADOS + "analises/" + encodeURIComponent(dn.arquivo)}" alt="dNBR"><figcaption><b>Figura ${4 + img.length}</b> — Severidade da queima (dNBR) entre ${dBR(dn.antes)} e ${dBR(dn.depois)}: ${br(dn.queimado_ha, 1)} ha queimados.</figcaption></figure>` : ""}</div>
      ${dn?.areas_ha ? `<p class="rotulo">Área por classe de severidade (dNBR)</p>${tab(["Classe", "Área (ha)"], Object.entries(dn.areas_ha).map(([k, v]) => `<tr><td>${esc(k)}</td><td class="n">${br(v, 1)}</td></tr>`))}` : ""}
      <p class="nota">Período analisado: ${dBR(ndvi.periodo?.[0])} a ${dBR(ndvi.periodo?.[1])} · ${ndvi.n_validas ?? "–"} cenas válidas.</p>
      <p class="nota"><b>Método.</b> ${METODO_LIT}</p>`));
    html.push(sec(N(), "Parecer técnico preliminar (IA)", `<div id="parecerCorpo">${parecerHTML(R.parecer)}</div>`, "parecer-sec"));
  }

  // 5. bases
  const cab = c => `${esc(c.nome)}`;
  html.push(sec(N(), "Consulta às bases de dados", `
    <p class="rotulo">Tabela — Resultado da consulta por sobreposição com a AI (${br(aiHa, 2)} ha)</p>
    ${tab(["Base", "Área de sobreposição com a AI (ha)", "Resultado"], camadas.map(c => `<tr><td>${cab(c)}</td><td class="n">${c.l ? br(c.ha, 2) : "–"}</td><td>${resultado(c)}</td></tr>`))}
    <p class="rotulo">Tabela — Resultado da consulta por proximidade (até ${PROX_KM} km da borda da AI)</p>
    ${tab(["Base", "Distância (m)", "Resultado"], camadas.filter(c => c.prox).map(c => `<tr><td>${cab(c)}</td><td class="n">${!c.l ? "–" : c.min == null || c.min > PROX_KM * 1000 ? "Fora do raio" : br(c.min, 0)}</td>
      <td>${!c.l ? `<span class="res-nd">NÃO ANALISADO</span>` : c.min === 0 ? resultado(c) : c.min != null && c.min <= PROX_KM * 1000 ? `<span class="res-nd">NO ENTORNO</span>` : `<span class="res-nao">FORA DO RAIO</span>`}</td></tr>`))}
    <div class="leg-rel"><span class="res-sim">SOBREPÕE</span> área com restrição legal ao uso do fogo ou embargo · <span class="res-nd">SOBREPÕE / NO ENTORNO</span> requer atenção · <span class="res-nao">NÃO SOBREPÕE</span> · <span class="res-nd">NÃO ANALISADO</span> base indisponível</div>
    <p class="nota">Resultados dependem da qualidade topológica de cada base e da data de consulta. CAR é autodeclaratório e não comprova posse ou propriedade. Nome do embargado e documento vêm da base pública do IBAMA; o detentor do imóvel SIGEF é consultado na página pública do INCRA. Dados pessoais: uso restrito à investigação. A base de embargos do ICMBio não oferece serviço público consultável.</p>`));
  const det = camadas.filter(c => c.itens?.length);
  if (det.length) html.push(sec(N(), "Detalhamento das consultas", det.map(c => `<p class="rotulo">${esc(c.nome)}</p>
    ${tab(["Descrição", "Sobreposição com a AI (ha)", "Distância da AI (m)"], c.itens.slice(0, 25).map(x => `<tr><td>${c.desc(x.f.properties || {})}</td><td class="n">${br(x.ha, 2)}</td><td class="n">${x.m == null ? "–" : br(x.m, 0)}</td></tr>`))}
    ${c.itens.length > 25 ? `<p class="nota">Mostrando 25 de ${c.itens.length}.</p>` : ""}`).join("")));

  // 6. contexto do painel (clima, cronologia, ERBs) e matriz
  if (guardado?.entorno) html.push(sec(N(), "Entorno: acesso, fundiário, água e biodiversidade", guardado.entorno));
  if (guardado?.territorio) html.push(sec(N(), "Território: uso da terra, fogo histórico e relevo", guardado.territorio));
  const ctx = [guardado?.clima, guardado?.cronologia, guardado?.erbs].filter(Boolean).join("");
  if (ctx) html.push(sec(N(), "Clima, cronologia das detecções e telefonia", ctx));
  if (guardado?.brmais && usuario) html.push(sec(N(), "Alertas Brasil MAIS próximos (ficha do painel)", guardado.brmais, "restrito"));
  html.push(sec(N(), "Matriz de hipóteses", guardado?.confronto || (e.ponto
    ? `<p class="nota">Não há evento de foco de calor associado a este ponto, então a matriz de hipóteses (que confronta focos, clima, desmatamento e área protegida de um evento) não se aplica. A análise de satélite, o parecer e a consulta às bases acima orientam o exame de local.</p>`
    : `<p class="nota">Abra o relatório pelo botão da ficha para incluir a matriz de hipóteses calculada no painel.</p>`)));

  // 7. limitações, referências e glossário
  html.push(sec(N(), "Limitações", `<ul>
    <li>Foco de calor indica fogo ativo no pixel no instante da passagem do satélite; a primeira detecção <b>não</b> marca a hora nem o ponto de ignição.</li>
    <li>Origem, causa e autoria exigem demonstrações próprias, com exame de local; este documento organiza indícios e lacunas para orientar a verificação.</li>
    <li>A prioridade de verificação ordena o trabalho e não é grau de certeza. A matriz de hipóteses não usa pesos nem percentuais.</li>
    <li>Sobreposições foram calculadas com a AI circular; o perímetro real da área queimada pode ser maior ou menor.</li>
    <li>Imagens Planet e RAA do Brasil MAIS exigem acesso à plataforma da Polícia Federal.</li></ul>`));
  html.push(sec(N(), "Referências e fontes", `<ul>
    <li>INPE — Programa Queimadas (BDQueimadas) e DETER/TerraBrasilis.</li>
    <li>NASA FIRMS (VIIRS/MODIS) — alertas em tempo real.</li>
    <li>ESA Copernicus Sentinel-1 e Sentinel-2; USGS Landsat 8/9 — via Microsoft Planetary Computer.</li>
    ${REFS_LIT.map(r => `<li>${r}</li>`).join("")}
    <li>Open-Meteo — clima e vento; INPE — risco de fogo.</li>
    <li>FUNAI — terras indígenas; MMA/CNUC — unidades de conservação; INCRA — comunidades quilombolas.</li>
    <li>SICAR — Cadastro Ambiental Rural; IBAMA — áreas embargadas; ANM — SIGMINE; Anatel — estações do SMP.</li>
    ${usuario ? `<li>Brasil MAIS (Polícia Federal / convênio) — alertas de queimada e desmatamento, imagens Planet 3 m. Acesso restrito.</li>` : ""}
    <li>NIPED/PCAM — guias de metodologia e de protocolo de autoria em crimes de fogo.</li></ul>`));
  html.push(sec(N(), "Glossário", `<dl class="glossario">
    <div><dt>Área de interesse (AI)</dt><dd>Círculo em torno do centro do evento usado nas consultas.</dd></div>
    <div><dt>Foco de calor</dt><dd>Pixel com anomalia térmica detectado por satélite numa passagem.</dd></div>
    <div><dt>Evento</dt><dd>Agrupamento de focos próximos no espaço e no tempo (DBSCAN).</dd></div>
    <div><dt>Prioridade de verificação</dt><dd>Ordenação de 0 a 100 dos eventos a verificar; não é probabilidade.</dd></div>
    <div><dt>NDVI</dt><dd>Índice de vegetação; queda sustentada indica perda de cobertura verde.</dd></div>
    <div><dt>dNBR</dt><dd>Diferença do índice de queima antes e depois; estima a severidade.</dd></div>
    <div><dt>CAR</dt><dd>Cadastro Ambiental Rural, autodeclaratório.</dd></div>
    <div><dt>TAD</dt><dd>Termo de Apreensão e Depósito / Embargo lavrado pelo IBAMA.</dd></div>
    <div><dt>UC PI / UC US</dt><dd>Unidade de conservação de Proteção Integral / Uso Sustentável.</dd></div>
    <div><dt>ERB</dt><dd>Estação rádio base de telefonia móvel.</dd></div>
    <div><dt>RAA</dt><dd>Relatório de Alerta Analítico da plataforma Brasil MAIS.</dd></div>
    <div><dt>Hipótese espacial</dt><dd>Local provável indicado por um produto, a ser confrontado em campo.</dd></div></dl>`));
  html.push(`<p class="rodape-rel">Fogo Forense · Desenvolvido pelo NIPED/PCAM · DPTC — documento automatizado, não substitui laudo pericial · gerado em ${new Date().toLocaleString("pt-BR", {timeZone: "America/Manaus"})}</p>`);
  $("#folha").innerHTML = html.join("");
  document.title = `Relatório ${e.id} — Fogo Forense`;
}

// ------------------------------------------------------------ mapas
function desenharMapas() {
  mapas.splice(0).forEach(m => m.remove());
  const {e, mun, ai, camadas, brm, est} = R;
  const fc = l => ({type: "FeatureCollection", features: l});
  const novo = (id, base, z) => {
    const m = new maplibregl.Map({container: id, center: [e.lon, e.lat], zoom: z, interactive: false, attributionControl: {compact: true},
      canvasContextAttributes: {preserveDrawingBuffer: true}, preserveDrawingBuffer: true,
      style: {version: 8, sources: base ? {base: {type: "raster", tiles: [base], tileSize: 256, attribution: id === "mSentinel" ? "ESA Copernicus · Planetary Computer" : "Esri, Maxar"}} : {},
        layers: [{id: "fundo", type: "background", paint: {"background-color": "#dfe5ee"}}, ...(base ? [{id: "base", type: "raster", source: "base"}] : [])]}});
    mapas.push(m); return m;
  };
  const sobre = m => {
    for (const c of camadas) if (c.itens?.length) {
      m.addSource(c.k, {type: "geojson", data: fc(c.itens.map(x => x.f))});
      m.addLayer({id: c.k, type: "line", source: c.k, paint: {"line-color": c.cor, "line-width": 1.6}});
    }
    if (brm) {
      const pts = [...brm.fogo.map(x => ["br" + x.a[1], x.a]), ...brm.desm.map(x => [x.a[1] === "G" ? "brG" : "brD", x.a])];
      m.addSource("brm", {type: "geojson", data: fc(pts.map(([k, a]) => ({type: "Feature", properties: {c: COR[k] || COR.brF}, geometry: {type: "Point", coordinates: [a[6], a[5]]}})))});
      m.addLayer({id: "brm", type: "circle", source: "brm", paint: {"circle-radius": 4, "circle-color": ["get", "c"], "circle-stroke-color": "#000", "circle-stroke-width": .6}});
    }
    m.addSource("ai", {type: "geojson", data: ai});
    m.addLayer({id: "ai", type: "line", source: "ai", paint: {"line-color": COR.ai, "line-width": 2.5}});
    m.addSource("c", {type: "geojson", data: R.centro});
    m.addLayer({id: "c", type: "circle", source: "c", paint: {"circle-radius": 3, "circle-color": COR.ai, "circle-stroke-color": "#000", "circle-stroke-width": 1}});
    m.fitBounds(turf.bbox(turf.buffer(ai, Math.max(1.5, R.raioM / 1000 * 2.2), {units: "kilometers"})), {padding: 10, duration: 0});
  };
  const me = novo("mEstado", null, 4.2);
  me.on("load", () => {
    me.addSource("mun", {type: "geojson", data: mun});
    me.addLayer({id: "munf", type: "fill", source: "mun", paint: {"fill-color": ["case", ["==", ["get", "nome"], e.mun], "#f4b400", "#ffffff"], "fill-opacity": .9}});
    me.addLayer({id: "mun", type: "line", source: "mun", paint: {"line-color": "#5b6675", "line-width": .5}});
    me.addSource("p", {type: "geojson", data: R.centro});
    me.addLayer({id: "p", type: "circle", source: "p", paint: {"circle-radius": 5, "circle-color": "#c8302f", "circle-stroke-color": "#fff", "circle-stroke-width": 1.5}});
    me.fitBounds(turf.bbox(mun), {padding: 8, duration: 0});
  });
  const ml = novo("mLocal", "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", 13);
  ml.on("load", () => sobre(ml));
  if (est.mosaico?.rgb) { const ms = novo("mSentinel", est.mosaico.rgb, 13); ms.on("load", () => sobre(ms)); }
  else $("#mSentinel").closest("figure").remove();
}

function quandoProntos() {
  return Promise.all(mapas.map(m => new Promise(r => { if (m.loaded() && m.areTilesLoaded()) return r(); m.once("idle", r); setTimeout(r, 15000); })));
}
$("#imprimir").onclick = async () => { if (R.tarefas) { estado("Concluindo análise e parecer…"); await R.tarefas; } estado("Aguardando mapas e imagens…"); await quandoProntos();
  await Promise.all([...document.querySelectorAll("#folha img")].map(im => im.complete ? 0 : new Promise(r => { im.onload = im.onerror = r; setTimeout(r, 20000); }))); estado("Pronto para imprimir"); window.print(); };
$("#refazer").onclick = () => montar().catch(erro);
function erro(x) { console.error(x); estado("Erro ao montar", false); $("#folha").innerHTML = `<div class="cartao"><p>Não foi possível montar o relatório: ${esc(x.message)}</p></div>`; }
montar().catch(erro);
