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
const ID = new URLSearchParams(location.search).get("id");
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

// ------------------------------------------------------------ montagem
async function montar() {
  if (!ID) { $("#folha").innerHTML = `<div class="cartao"><p>Abra o relatório pelo botão <b>Gerar relatório</b> na ficha de um evento.</p></div>`; return; }
  estado("Carregando dados…");
  const raioM = Math.min(5000, Math.max(100, +$("#raio").value || 1000));
  const [est, ev, al, mun, tis, ucs, quil] = await Promise.all([dj("estatisticas.json"), dj("eventos.json"), dj("alertas.json"),
    dj("municipios.json"), dj("tis.json"), dj("ucs.json"), fetch("bases/quilombolas_am.json").then(r => r.json()).catch(() => null)]);
  const e = [...descompactar(ev), ...descompactar(al)].find(x => x.id === ID);
  if (!e) { $("#folha").innerHTML = `<div class="cartao"><p>Evento ${esc(ID)} não encontrado nos dados atuais.</p></div>`; estado("Evento não encontrado", false); return; }
  let usuario = null; try { usuario = (await api("api/conta?acao=eu")).usuario; } catch (x) {}
  let guardado = null; try { guardado = JSON.parse(localStorage.getItem("ff_rel_" + ID) || "null"); } catch (x) {}

  const centro = turf.point([e.lon, e.lat]);
  const ai = turf.circle(centro, raioM / 1000, {steps: 96, units: "kilometers"});
  const aiHa = turf.area(ai) / 1e4;
  const dla = (PROX_KM + raioM / 1000) / 111, dlo = dla / Math.cos(e.lat * Math.PI / 180);
  const bb = [e.lon - dlo, e.lat - dla, e.lon + dlo, e.lat + dla];
  const bbStr = bb.map(v => v.toFixed(4)).join(",");

  estado("Consultando bases públicas…");
  const remota = n => api(`api/bases?base=${n}&bbox=${bbStr}`).then(d => d.features).catch(() => null);
  const [car, emb, anm] = await Promise.all([remota("car"), remota("embargos"), remota("anm")]);

  const tisP = noRetangulo(tis, bb), ucsP = noRetangulo(ucs, bb), quilP = quil ? noRetangulo(quil, bb) : null;
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
    {k: "emb", nome: "Embargos IBAMA", l: emb, cor: COR.emb, prox: true, alerta: "sim",
      desc: p => `TAD ${esc(p.num_tad)}-${esc(p.serie_tad)} de ${p.dat_embargo ? new Date(p.dat_embargo).toLocaleDateString("pt-BR") : "–"} · ${br(p.qtd_area_embargada, 2)} ha · ${esc(p.des_infracao || "")} · processo ${esc(p.num_processo || "")}`},
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

  // parecer: o mais recente entre o redigido no painel (memória do navegador) e o do motor
  let parecer = null; try { parecer = JSON.parse(localStorage.getItem("ff_parecer_" + ID) || "null"); } catch (x) {}
  if (!parecer?.texto && ndvi?.parecer?.texto) parecer = {...ndvi.parecer, gerado_em: ndvi.parecer.gerado_em || ndvi.gerado_em};
  const antigo = parecer?.texto && /polic\s*ia|queimadia/i.test(parecer.texto);   // citava o sistema, não a literatura
  R = {e, est, mun, ai, aiHa, raioM, centro, bb, camadas, brm, ndvi, usuario, guardado, parecer: antigo ? null : parecer};
  estado("Desenhando…");
  render();
  desenharMapas();
  if (ndvi && !R.parecer?.texto && usuario) gerarParecer();
  estado("Pronto para imprimir");
}

// ------------------------------------------------------------ método e parecer (literatura científica)
const METODO_LIT = "NDVI (Rouse et al., 1974; Tucker, 1979) como mediana dos pixels válidos num círculo de 600 m; uma cena por mês, com ao menos 80% da área sem nuvem e a menor nuvem na cena; triagem Tmask de névoa e sombra residuais na linha de base (Zhu &amp; Woodcock, 2014b); quebra quando o NDVI fica abaixo de mediana − max(3σ; 0,15) em 6 observações consecutivas, critério de confirmação do CCDC (Zhu &amp; Woodcock, 2014a; Arévalo et al., 2020); severidade da queima por dNBR com as classes do USGS (Key &amp; Benson, 2006). Sentinel-2 L2A e Landsat 8/9 Coleção 2 Nível 2.";
const REFS_LIT = [
  "Rouse, J. W.; Haas, R. H.; Schell, J. A.; Deering, D. W. (1974). Monitoring vegetation systems in the Great Plains with ERTS. NASA SP-351, p. 309–317.",
  "Tucker, C. J. (1979). Red and photographic infrared linear combinations for monitoring vegetation. <i>Remote Sensing of Environment</i>, 8, 127–150.",
  "Zhu, Z.; Woodcock, C. E. (2014a). Continuous change detection and classification of land cover using all available Landsat data. <i>Remote Sensing of Environment</i>, 144, 152–171.",
  "Zhu, Z.; Woodcock, C. E. (2014b). Automated cloud, cloud shadow, and snow detection in multitemporal Landsat data. <i>Remote Sensing of Environment</i>, 152, 217–234.",
  "Arévalo, P.; Bullock, E. L.; Woodcock, C. E.; Olofsson, P. (2020). A suite of tools for continuous land change monitoring in Google Earth Engine. <i>Frontiers in Climate</i>, 2, 576740.",
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
    <h1>Relatório analítico de evento de fogo</h1>
    <p class="sub">Documento automatizado gerado pelo Fogo Forense a partir de focos de calor por satélite, imagens Sentinel-2/Landsat e bases públicas${restrito ? ", com alertas do Brasil MAIS (imagens Planet de 3 m)" : ""}. Não substitui laudo pericial.</p>
    <div class="linha-meta"><span><b>Evento:</b> ${esc(e.id)}</span><span><b>Município:</b> ${esc(e.mun)} - AM</span>
      <span><b>Período dos focos:</b> ${dBR(e.ini)} a ${dBR(e.fim)}</span><span><b>Data do relatório:</b> ${hoje}</span>
      ${usuario ? `<span><b>Gerado por:</b> ${esc(usuario.nome)} (${esc(usuario.orgao)})</span>` : ""}</div></section>`);

  // 1. área de interesse
  html.push(sec(N(), "Dados da área de interesse (AI)", `
    <table class="tabela kv"><tbody>
      <tr><td>Município</td><td>${esc(e.mun)} - AM</td></tr>
      <tr><td>Área de interesse</td><td>Círculo de ${fmt(raioM)} m de raio no centro do evento · ${br(aiHa, 2)} ha</td></tr>
      <tr><td>Centroide da AI</td><td class="mono">${centroide(e.lat, e.lon)} (${e.lat.toFixed(5)}, ${e.lon.toFixed(5)})</td></tr>
      <tr><td>Sistema de referência</td><td>WGS 84 (EPSG:4326), compatível com SIRGAS 2000 na escala do relatório</td></tr>
      <tr><td>Focos de calor no evento</td><td>${e.n} focos · até ${e.maxDia} no mesmo dia · primeiro ${esc(e.ini)} UTC · último ${esc(e.fim)} UTC</td></tr>
      <tr><td>Satélites</td><td>${esc(e.sats.join(", ") || "AQUA_M-T")}</td></tr>
      <tr><td>Prioridade de verificação</td><td>${e.score} de 100${e.ia != null ? ` · atipicidade (IA) ${e.ia}/100` : ""}</td></tr>
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
  if (ndvi) {
    const img = (ndvi.imagens || []).filter(i => i.produto === "rgb");
    const dn = ndvi.dnbr;
    html.push(sec(N(), "Imagens de satélite e vegetação (NDVI e dNBR)", `
      <div class="figs">${img.map((i, k) => `<figure><img src="${DADOS}analises/${encodeURIComponent(i.arquivo)}" alt="Imagem ${esc(i.rotulo)}"><figcaption><b>Figura ${4 + k}</b> — ${esc(i.rotulo)}: ${dBR(i.data)} · ${esc(i.colecao)} · NDVI médio ${br(i.ndvi, 3)}</figcaption></figure>`).join("")}
      ${dn?.arquivo ? `<figure><img src="${DADOS}analises/${encodeURIComponent(dn.arquivo)}" alt="dNBR"><figcaption><b>Figura ${4 + img.length}</b> — Severidade da queima (dNBR) entre ${dBR(dn.antes)} e ${dBR(dn.depois)}: ${br(dn.queimado_ha, 1)} ha queimados.</figcaption></figure>` : ""}</div>
      ${dn?.areas_ha ? `<p class="rotulo">Área por classe de severidade (dNBR)</p>${tab(["Classe", "Área (ha)"], Object.entries(dn.areas_ha).map(([k, v]) => `<tr><td>${esc(k)}</td><td class="n">${br(v, 1)}</td></tr>`))}` : ""}
      <p class="rotulo">Quebra na série de NDVI (limiar de 3σ e 6 observações consecutivas; Zhu &amp; Woodcock, 2014a)</p>
      <p>${ndvi.quebra?.detectada ? `Queda sustentada detectada a partir de <b>${dBR(ndvi.quebra.data || ndvi.quebra.inicio)}</b>.` : esc(ndvi.quebra?.motivo || "Sem quebra detectada.")} NDVI de base ${br(ndvi.quebra?.ndvi_base, 3)} ± ${br(ndvi.quebra?.desvio_base, 3)} (limiar ${br(ndvi.quebra?.limiar, 3)}, ${ndvi.quebra?.n_base ?? "–"} observações).</p>
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
    <p class="nota">Resultados dependem da qualidade topológica de cada base e da data de consulta. CAR é autodeclaratório e não comprova posse ou propriedade. A base de embargos do ICMBio não oferece serviço público consultável.</p>`));
  const det = camadas.filter(c => c.itens?.length);
  if (det.length) html.push(sec(N(), "Detalhamento das consultas", det.map(c => `<p class="rotulo">${esc(c.nome)}</p>
    ${tab(["Descrição", "Sobreposição com a AI (ha)", "Distância da AI (m)"], c.itens.slice(0, 25).map(x => `<tr><td>${c.desc(x.f.properties || {})}</td><td class="n">${br(x.ha, 2)}</td><td class="n">${x.m == null ? "–" : br(x.m, 0)}</td></tr>`))}
    ${c.itens.length > 25 ? `<p class="nota">Mostrando 25 de ${c.itens.length}.</p>` : ""}`).join("")));

  // 6. contexto do painel (clima, cronologia, ERBs) e matriz
  const ctx = [guardado?.clima, guardado?.cronologia, guardado?.erbs].filter(Boolean).join("");
  if (ctx) html.push(sec(N(), "Clima, cronologia das detecções e telefonia", ctx));
  if (guardado?.brmais && usuario) html.push(sec(N(), "Alertas Brasil MAIS próximos (ficha do painel)", guardado.brmais, "restrito"));
  html.push(sec(N(), "Matriz de hipóteses", guardado?.confronto ||
    `<p class="nota">Abra o relatório pelo botão da ficha para incluir a matriz de hipóteses calculada no painel.</p>`));

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
$("#imprimir").onclick = async () => { estado("Aguardando mapas…"); await quandoProntos(); estado("Pronto para imprimir"); window.print(); };
$("#refazer").onclick = () => montar().catch(erro);
function erro(x) { console.error(x); estado("Erro ao montar", false); $("#folha").innerHTML = `<div class="cartao"><p>Não foi possível montar o relatório: ${esc(x.message)}</p></div>`; }
montar().catch(erro);
