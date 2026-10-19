/* Fogo Forense — painel principal (mapa, filtros, ocorrências, tempo real, estatísticas) */
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
  ignicao_desfavoravel: "Ignição em tempo desfavorável",
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
    + (!f.length ? `<p class="nota" style="padding:14px">Nenhum evento com esses filtros. Reduza a prioridade mínima ou amplie o período.</p>` : "");
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
  if (d.ignicao_desfavoravel) motivos.push(`começou em condição desfavorável ao fogo (${d.ignicao_desfavoravel.join("; ")}), quando dificilmente pegaria sozinho`);
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
      <div style="display:flex;gap:8px;flex-wrap:wrap">${Q.est.analises?.[e.id] ? `<button type="button" class="botao fogo" id="fPronta">Ver análise NDVI${Q.est.analises[e.id].quebra ? (Q.est.analises[e.id].situacao === "provavel" ? " · queda provável " : " · quebra ") + dBR(Q.est.analises[e.id].quebra) : ""}</button>` : ""}
      ${Q.estatico ? (Q.est.analises?.[e.id] ? "" : `<span class="selo pend" title="O motor calcula a análise de NDVI dos eventos com prioridade ≥ 70, começando pelos mais recentes e mais perto de Manaus.">NDVI na fila de cálculo</span>`) : `<button type="button" class="botao ${Q.est.analises?.[e.id] ? "secundario" : "fogo"}" id="fAnalisar">Analisar NDVI agora</button>`}
      <button type="button" class="botao secundario" id="fCopiar">Copiar resumo</button></div></div>
    ${porque}
    <div class="fatos">
      <div><span>Focos</span><b>${e.n}</b></div><div><span>Máx. no mesmo dia</span><b>${e.maxDia}</b></div>
      <div><span>Primeiro foco (UTC)</span><b>${e.ini}</b></div><div><span>Último foco (UTC)</span><b>${e.fim}</b></div>
      <div><span>Distância de Manaus</span><b>${fmt(e.dist)} km</b></div><div><span>Coordenadas</span><b>${lat}, ${lon}</b></div>
      <div><span>Satélites</span><b>${esc(e.sats.join(", ") || "AQUA_M-T")}</b></div>
      ${e.ia != null ? `<div><span>Atipicidade (IA)</span><b>${e.ia}/100</b></div>` : ""}
    </div>
    ${blocoConfronto(e)}
    ${blocoClima(e)}
    ${blocoCronologia(e)}
    ${blocoMudanca(e)}
    ${blocoErbs(e)}
    <div class="painel-grade">
      <div><h3 style="margin-bottom:6px">Os sinais verificados, um a um</h3>${linhas}
        <div class="formula">prioridade = ${calc} = <b>${e.score}</b></div></div>
      <div><h3 style="margin-bottom:6px">Conferir nas fontes públicas</h3>
        <div class="links">
          <a class="botao secundario pequeno" target="_blank" rel="noopener" href="https://terrabrasilis.dpi.inpe.br/queimadas/bdqueimadas/">BDQueimadas (INPE)</a>
          <a class="botao secundario pequeno" target="_blank" rel="noopener" href="https://terrabrasilis.dpi.inpe.br/app/map/deter-amz">DETER (TerraBrasilis)</a>
          <a class="botao secundario pequeno" target="_blank" rel="noopener" href="https://firms.modaps.eosdis.nasa.gov/map/#d:24hrs;@${lon},${lat},13.0z">NASA FIRMS</a>
          <a class="botao secundario pequeno" target="_blank" rel="noopener" href="https://plataforma.brasil.mapbiomas.org/">MapBiomas</a>
          <a class="botao secundario pequeno" target="_blank" rel="noopener" href="https://apps.sentinel-hub.com/eo-browser/?zoom=14&lat=${lat}&lng=${lon}">EO Browser (Sentinel)</a>
          <a class="botao secundario pequeno" target="_blank" rel="noopener" href="https://www.google.com/maps/@${lat},${lon},2000m/data=!3m1!1e3">Google Satélite</a>
          ${copernicus(e)}
          <a class="botao secundario pequeno" target="_blank" rel="noopener" href="https://www.windy.com/${lat}/${lon}?wind,${lat},${lon},9">Windy (vento)</a>
          <a class="botao secundario pequeno" target="_blank" rel="noopener" href="https://consultapublica.car.gov.br/publico/imoveis/index">Consulta CAR</a>
          <a class="botao secundario pequeno" target="_blank" rel="noopener" href="https://servicos.ibama.gov.br/ctf/publico/areasembargadas/ConsultaPublicaAreasEmbargadas.php">Embargos IBAMA</a>
        </div>
        <p class="nota" style="margin-top:10px">A prioridade soma indicadores objetivos de fontes públicas para ordenar a verificação; não é grau de certeza. Não substitui a perícia de local nem os procedimentos legais.</p></div>
    </div>`;
  if ($("#fAnalisar")) $("#fAnalisar").onclick = () => window.abrirAnalise?.(e);
  if ($("#fPronta")) $("#fPronta").onclick = () => window.mostrarAnalisePronta?.(e.id);
  $("#fCopiar").onclick = () => { const t = `Fogo Forense ${e.id} — ${e.mun}, ${dBR(e.ini)}. Prioridade ${e.score} (${e.ind.map(k => IND_TXT[k]).join("; ") || "sem indicadores"}). ${e.n} focos, ${lat}, ${lon}. ${d.ti || d.uc || ""}`;
    navigator.clipboard?.writeText(t).then(() => toast("Resumo copiado."), () => toast(t, 10000)); };
}

// ------------------------------------------------------------ confronto de hipóteses
function blocoConfronto(e) {
  const d = e.det, f = d.fogo || {}, ctx = d.contexto || [], an = Q.est.analises?.[e.id], cl = d.clima;
  const intenc = [], acid = [], inconc = [];
  if (d.desmatamento) intenc.push(`Desmatamento detectado pelo DETER ${d.desmatamento.dias_antes > 0 ? d.desmatamento.dias_antes + " dias antes" : "junto com"} do fogo`);
  if (an?.relacao === "antes_do_fogo") intenc.push("A vegetação sumiu antes dos focos (NDVI): compatível com derrubada seguida de queima");
  if (d.ignicao_desfavoravel) intenc.push("Começou em condição desfavorável ao fogo (dificilmente pegaria sozinho)");
  if (e.maxDia >= 3) intenc.push(`${e.maxDia} focos no mesmo dia: possíveis ignições distintas (confrontar com projeção de partículas e combate)`);
  if (d.anos_anteriores?.length >= 2) intenc.push(`Reincidência: fogo no local em ${d.anos_anteriores.join(", ")}`);
  if (e.ind.includes("periodo_proibitivo")) intenc.push("Período de proibição do uso do fogo");
  if (e.ind.includes("area_protegida")) intenc.push(d.ti ? `Dentro da ${d.ti}: queima por não indígenas é proibida` : `Dentro da ${d.uc} (proteção integral): uso do fogo proibido`);
  const mu = Q.mudancas?.eventos?.[e.id], muF = (Q.mudancas?.features || []).filter(f => f.properties.evento === e.id);
  const haRad = muF.filter(f => f.properties.fonte !== "optico").reduce((t, f) => t + f.properties.ha, 0);
  const radPoucas = mu?.fontes?.radar && Math.min(mu.fontes.radar[0].length, mu.fontes.radar[1].length) < 2;
  if (haRad >= 1 && !radPoucas) intenc.push(`Radar detectou abertura de dossel em ${br(haRad, 1)} ha após o fogo (compatível com derrubada/conversão)`);
  if (haRad >= 1 && radPoucas) inconc.push(`Radar indica possível abertura de dossel em ${br(haRad, 1)} ha, mas com só 1 imagem antes ou depois: confirmar com novas passagens`);
  if (mu && mu.area_total_ha >= 1 && haRad < 1) inconc.push(`Óptico mostra ${br(mu.area_total_ha, 1)} ha alterados (queima/perda de verde), sem confirmação do radar`);
  if (ctx.includes("biomassa_alta")) intenc.push("Fogo intenso e persistente: compatível com queima de muita biomassa (conversão)");
  if (ctx.includes("escape_plausivel")) acid.push("Seca forte e vento acima de 10 km/h: uma queima pode ter escapado do controle");
  if (d.ti) acid.push("Em terra indígena, a roça tradicional dos próprios indígenas com fogo é permitida");
  else if (d.uc && d.uc_grupo !== "PI") acid.push("Reserva de uso sustentável: a roça tradicional das comunidades com fogo é permitida");
  if (!d.desmatamento && an?.relacao !== "antes_do_fogo") acid.push("Sem desmatamento prévio detectado");
  if (e.n <= 2 && (f.dias_com_fogo || 1) <= 1 && (f.frp_max == null || f.frp_max < 20)) acid.push("Fogo pequeno e curto, de baixa intensidade");
  if (an && !an.quebra) acid.push("A vegetação não foi perdida de forma sustentada (NDVI)");
  if (!(e.maxDia >= 3) && e.n > 2) acid.push("Focos espalhados ao longo dos dias, sem detecções simultâneas");
  if (d.lixao) acid.push(`A ${br(d.lixao.dist_m, 0)} m de um lixão/vazadouro (${d.lixao.nome}): possível fonte térmica não vegetal ou queima de resíduos; fumaça tóxica`);
  // inconclusivos e lacunas: o que ainda não permite discriminar
  if (!an) inconc.push("Análise de vegetação (NDVI) ainda não calculada para este evento");
  else if (an.situacao === "provavel") inconc.push(`Queda de vegetação desde ${dBR(an.quebra)} ainda não confirmada (faltam imagens)`);
  if (!cl) inconc.push("Clima no início do fogo indisponível");
  if (f.risco_fogo_inicio == null) inconc.push("Risco de fogo do INPE indisponível (anos anteriores a 2026)");
  inconc.push("Satélite de referência passa poucas vezes ao dia: a primeira detecção não marca a hora nem o ponto da ignição");
  inconc.push("Sem verificação de campo, CAR/SIGEF, embargos ou autorização de queima (IPAAM)");
  const col = (cls, t, l) => `<div class="lado ${cls}"><h4>${t} (${l.length})</h4>${l.length ? `<ul>${l.map(x => `<li>${esc(x)}</li>`).join("")}</ul>` : `<p class="nota">Nenhum elemento identificado nas bases públicas.</p>`}</div>`;
  return `<div class="confronto"><h3>Matriz de hipóteses</h3>
    <div class="confronto-grade tres">
      ${col("intencional", "Favoráveis à ignição intencional", intenc)}
      ${col("acidental", "Compatíveis com acidente ou queima tradicional", acid)}
      ${col("inconclusivo", "Inconclusivos e lacunas", inconc)}
    </div>
    <p class="nota">Sem pesos ou percentuais: a quantidade de itens não decide a hipótese. Elementos derivados da mesma fonte (ex.: o mesmo foco no INPE e no FIRMS) não são independentes. Origem, causa e autoria exigem demonstrações próprias, com perícia de local.</p></div>`;
}

// Copernicus Browser: abre no local e no período do evento, já na camada escolhida.
// A linha do tempo animada fica no ícone "Timelapse" do próprio Copernicus.
function copernicus(e) {
  const d0 = new Date(e.ini.slice(0, 10) + "T00:00:00Z"), d1 = new Date(e.fim.slice(0, 10) + "T00:00:00Z");
  d0.setUTCDate(d0.getUTCDate() - 10); d1.setUTCDate(d1.getUTCDate() + 20);
  const hoje = new Date(); if (d1 > hoje) d1.setTime(hoje.getTime());
  const base = `https://browser.dataspace.copernicus.eu/?zoom=14&lat=${e.lat.toFixed(5)}&lng=${e.lon.toFixed(5)}&themeId=DEFAULT-THEME&datasetId=S2_L2A_CDAS`
    + `&dateMode=TIME%20RANGE&fromTime=${d0.toISOString().slice(0, 10)}T00%3A00%3A00.000Z&toTime=${d1.toISOString().slice(0, 10)}T23%3A59%3A59.999Z&mosaickingOrder=leastCC`;
  return [["3-WILDFIRES", "Copernicus: incêndios"], ["6-SWIR", "Copernicus: SWIR"], ["1_TRUE_COLOR", "Copernicus: cor real"], ["3_NDVI", "Copernicus: NDVI"]]
    .map(([l, t]) => `<a class="botao secundario pequeno" target="_blank" rel="noopener" href="${base}&layerId=${l}">${t}</a>`).join("");
}

function blocoMudanca(e) {
  const r = Q.mudancas?.eventos?.[e.id];
  if (!r) return (e.score >= 50 && Q.mudancas) ? `<div class="clima-bloco"><h3>Alertas de mudança</h3><p class="nota">Ainda não calculado para este evento (o motor processa os incêndios recentes com prioridade ≥ 50, alguns por ciclo).</p></div>` : "";
  const fs = (Q.mudancas.features || []).filter(f => f.properties.evento === e.id);
  const soma = k => fs.filter(f => f.properties.fonte === k).reduce((t, f) => t + f.properties.ha, 0);
  const op = r.fontes.optico, ra = r.fontes.radar;
  return `<div class="clima-bloco"><h3>Alertas de mudança (Sentinel-2 + radar Sentinel-1)</h3>
    <div class="fatos">
      <div><span>Área total alterada</span><b>${br(r.area_total_ha, 1)} ha</b></div>
      <div><span>Só óptico</span><b>${br(soma("optico"), 1)} ha</b></div>
      <div><span>Só radar</span><b>${br(soma("radar"), 1)} ha</b></div>
      <div><span>Óptico e radar</span><b>${br(soma("ambos"), 1)} ha</b></div>
      <div><span>Polígonos (≥ 1 ha)</span><b>${r.n_poligonos}</b></div>
    </div>
    <p class="nota">Antes: ${dBR(r.janela_antes[0])} a ${dBR(r.janela_antes[1])} · depois: ${dBR(r.janela_depois[0])} a ${dBR(r.janela_depois[1])}.
      Óptico: ${op ? `${op[0].length} + ${op[1].length} cenas` : "sem cenas limpas"} · radar: ${ra ? `${ra[0].length} + ${ra[1].length} cenas` : "sem cenas"}${ra && Math.min(ra[0].length, ra[1].length) < 2 ? " (poucas cenas de radar: confiança baixa)" : ""}.
      Polígonos no mapa (camada "Alertas de mudança"). Automático, não validado por analista: pode haver falso positivo por nuvem, sombra, água ou cultivo.</p></div>`;
}

function blocoErbs(e) {
  const l = e.det.erbs, n = e.det.n_erbs_15km;
  if (n == null) return "";
  const ops = l ? [...new Set(l.map(b => b.op))].join(", ") : "";
  return `<div class="clima-bloco"><h3>ERBs de telefonia próximas (Anatel)</h3>
    ${n ? `<p class="nota">${n} estação(ões) licenciada(s) a até 15 km do centro do evento${ops ? " · operadoras: " + esc(ops) : ""}. As mais próximas:</p>
    <div class="rolagem"><table class="tabela"><thead><tr><th>Estação nº</th><th>Operadora</th><th>Tecnologia</th><th>Distância</th></tr></thead><tbody>
    ${l.map(b => `<tr><td class="mono">${esc(b.id)}</td><td>${esc(b.op)}</td><td>${esc(b.ger.join(", "))}</td><td class="n">${br(b.dist_km, 1)} km</td></tr>`).join("")}</tbody></table></div>`
      : `<p class="nota">Nenhuma ERB licenciada a até 15 km: área provavelmente sem cobertura de telefonia móvel terrestre (aparelhos podem registrar GPS localmente, sem rede).</p>`}
    <p class="nota">Uso investigativo: a posição da antena não é a posição de um aparelho, e o alcance varia com relevo, vegetação e potência. Registros de conexão às ERBs dependem de ordem judicial e de vínculo individualizado com o fato; a proximidade, por si só, não fundamenta pedido coletivo (guia do NIPED).</p></div>`;
}

function blocoCronologia(e) {
  const p = e.det.passagens; if (!p?.length) return "";
  return `<div class="clima-bloco"><h3>Cronologia das detecções por passagem</h3>
    <div class="rolagem"><table class="tabela"><thead><tr><th>Hora (Manaus)</th><th>Satélite</th><th>Focos na passagem</th><th>FRP máx.</th></tr></thead><tbody>
    ${p.map(([t, sat, n, frp]) => `<tr><td class="mono">${manaus(t)}</td><td>${esc(sat)}</td><td class="n">${n}</td><td class="n">${frp != null ? br(frp, 1) + " MW" : "–"}</td></tr>`).join("")}
    </tbody></table></div>
    ${e.det.n_passagens > p.length ? `<p class="nota">Mostrando ${p.length} de ${e.det.n_passagens} passagens.</p>` : ""}
    <p class="nota">Focos da mesma passagem são simultâneos: a ordem não é sequência de ignições. A primeira detecção mostra fogo detectável até aquele instante, não a hora nem o ponto de início. Intervalos sem passagem não são trajetórias medidas.</p></div>`;
}

// ------------------------------------------------------------ clima e comportamento do fogo
const ROSA = ["norte", "nordeste", "leste", "sudeste", "sul", "sudoeste", "oeste", "noroeste"];
const rosa = g => ROSA[Math.round(((g % 360) + 360) % 360 / 45) % 8];
function blocoClima(e) {
  const cl = e.det.clima, f = e.det.fogo || {}, ctx = e.det.contexto || [];
  if (!cl && f.frp_max == null && f.risco_fogo_inicio == null) return "";
  const item = (r, v) => v == null ? "" : `<div><span>${r}</span><b>${v}</b></div>`;
  const leitura = [];
  if (e.det.ignicao_desfavoravel) leitura.push("O fogo começou em tempo desfavorável à queima: <b>pesa para ignição deliberada</b>.");
  if (ctx.includes("escape_plausivel")) leitura.push("Havia seca forte e vento acima de 10 km/h: <b>é plausível que uma queima tenha escapado</b> do controle (acidente), o que deve ser considerado na investigação.");
  if (ctx.includes("biomassa_alta")) leitura.push("Fogo intenso (FRP alto) e persistente, por mais de um dia ou à noite: indica <b>queima de muita biomassa</b>, típica de mata derrubada sendo queimada.");
  if (cl?.fumaca_rumo_manaus) leitura.push(`O vento levava a fumaça <b>em direção a Manaus</b>, com chegada estimada em cerca de ${br(cl.horas_ate_manaus, 0)} h.`);
  return `<div class="clima-bloco"><h3>Clima e comportamento do fogo</h3>
    <div class="fatos">
      ${cl ? item("Vento no 1º foco", `${br(cl.vento_kmh, 0)} km/h, de ${rosa(cl.vento_de_graus)}`) : ""}
      ${cl ? item("Umidade mínima (24 h antes)", cl.umidade_min_24h != null ? br(cl.umidade_min_24h, 0) + "%" : null) : ""}
      ${cl ? item("Umidade na hora do foco", cl.umidade != null ? br(cl.umidade, 0) + "%" : null) : ""}
      ${cl ? item("Temperatura", cl.temperatura != null ? br(cl.temperatura, 1) + " °C" : null) : ""}
      ${cl ? item("Chuva nas 72 h antes", br(cl.chuva_72h_mm, 1) + " mm") : ""}
      ${item("Dias sem chuva (INPE)", f.dias_sem_chuva_mediana != null ? br(f.dias_sem_chuva_mediana, 0) : null)}
      ${item("Risco de fogo (INPE, 0 a 1)", f.risco_fogo_inicio != null ? br(f.risco_fogo_inicio, 2) : null)}
      ${item("Intensidade máx. (FRP)", f.frp_max != null ? br(f.frp_max, 1) + " MW" : null)}
      ${item("Focos à noite", f.focos_noite)}
      ${item("Dias com fogo", f.dias_com_fogo)}
      ${cl ? item("Fumaça rumo a Manaus", cl.fumaca_rumo_manaus ? `sim, ~${br(cl.horas_ate_manaus, 0)} h` : "não") : ""}
    </div>
    ${leitura.length ? `<p class="clima-leitura">${leitura.join(" ")}</p>` : `<p class="nota">Sem sinal climático forte para acidente ou para ignição deliberada.</p>`}
    <p class="nota">Clima: ${cl ? esc(cl.fonte) + ", na hora do 1º foco" : "indisponível para este evento"}. Risco de fogo, dias sem chuva e FRP: INPE, por foco (disponíveis a partir de ${new Date().getFullYear()}).</p>
  </div>`;
}

// ------------------------------------------------------------ mapa
const BASES = {
  mapa: {nome: "Mapa (OpenStreetMap)", tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"], attr: "© OpenStreetMap"},
  satelite: {nome: "Satélite (Esri)", tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"], attr: "Esri, Maxar, Earthstar"},
  topo: {nome: "Topográfico (Esri)", tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}"], attr: "Esri"},
  claro: {nome: "Claro (CARTO)", tiles: ["https://basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png"], attr: "© CARTO © OSM"},
  escuro: {nome: "Escuro (CARTO)", tiles: ["https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png"], attr: "© CARTO © OSM"},
  s2rgb: {nome: "Sentinel-2: cor real", pc: "rgb", grupo: "sat"},
  s2fogo: {nome: "Sentinel-2: incêndios (fogo ativo)", pc: "fogo", grupo: "sat", per: "periodo_fogo",
    leg: "Cor real com o fogo ativo em vermelho/laranja (SWIR alto). Imagens mais recentes dos últimos 15 dias: só mostra o fogo que queimava na passagem do satélite."},
  s2falsa: {nome: "Sentinel-2: SWIR (cicatriz de queimada)", pc: "falsacor", grupo: "sat",
    leg: "B12-B08-B04. Vegetação em verde; área queimada e solo exposto em tons marrons/vermelhos."},
  s2ndvi: {nome: "Sentinel-2: NDVI (vigor da vegetação)", pc: "ndvi", grupo: "sat", leg: "Vermelho = sem vegetação ou queimado · amarelo = pouca · verde = floresta."},
  s2ndmi: {nome: "Sentinel-2: umidade da vegetação (NDMI)", pc: "ndmi", grupo: "sat", leg: "Vermelho = vegetação seca, mais inflamável · azul = úmida."},
  s2ndwi: {nome: "Sentinel-2: água (NDWI)", pc: "ndwi", grupo: "sat", leg: "Azul escuro = água; útil para várzeas e rios em seca."},
  s2veg: {nome: "Sentinel-2: falsa-cor (vegetação)", pc: "vegetacao", grupo: "sat", leg: "B08-B04-B03. Vegetação sadia em vermelho; desmatamento em ciano/cinza."},
  s1radar: {nome: "Sentinel-1: radar (vê através de nuvem e fumaça)", pc: "radar", grupo: "sat", per: "periodo_radar",
    leg: "Radar dos últimos 30 dias, em dB: floresta em verde-amarelo, clareiras e pasto em roxo, água em preto. Funciona com nuvem e fumaça."},
};
const CAMADAS = [
  ["eventos", "Eventos (referência)", "#c8302f", true], ["alertas", "Alertas tempo real (VIIRS)", "#ff7a00", true],
  ["focos", "Focos 7 dias (todos)", "#ffb000", false], ["calor", "Mapa de calor dos eventos", "#e07b2a", false],
  ["desmat", "DETER desmatamento", "#8e44ad", false], ["cicat", "DETER cicatriz de queimada", "#5d4037", false],
  ["tis", "Terras indígenas", "#b8860b", true], ["ucs", "Unidades de conservação", "#0a7a36", true],
  ["mun", "Municípios", "#5b6675", true],
  ["vento", "Vento (previsão, setas)", "#1e88e5", true], ["fumaca", "Fumaça rumo a Manaus", "#6d4c41", true],
  ["lixoes", "Lixões e vazadouros (fumaça tóxica)", "#8e24aa", true],
  ["mudancas", "Alertas de mudança (Sentinel-2 + radar)", "#00b8d4", true],
  ["erbs", "ERBs de telefonia (Anatel)", "#5e35b1", true],
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
  ["eventos", "alertas", "focos", "sel", "area", "vento", "fumaca", "lixoes", "perto-lixao", "mudancas", "erbs"].forEach(s => m.addSource(s, {type: "geojson", data: vazio}));
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
  m.addLayer({id: "fumaca", type: "line", source: "fumaca", paint: {"line-color": "#8d6e63", "line-width": 2, "line-opacity": .8, "line-dasharray": [2, 2]}});
  const corMud = ["match", ["get", "fonte"], "ambos", "#ff1744", "radar", "#00b8d4", "#ffd600"];
  m.addLayer({id: "mudancas", type: "fill", source: "mudancas", paint: {"fill-color": corMud, "fill-opacity": 0.35}});
  m.addLayer({id: "mudancas-l", type: "line", source: "mudancas", paint: {"line-color": corMud, "line-width": 1.6}});
  const corOp = ["match", ["get", "op"], "VIVO", "#7b1fa2", "TIM", "#1565c0", "CLARO", "#c62828", "#455a64"];
  m.addLayer({id: "erbs", type: "circle", source: "erbs", minzoom: 7, paint: {
    "circle-radius": ["interpolate", ["linear"], ["zoom"], 7, 2.5, 12, 6], "circle-color": "#fff", "circle-stroke-color": corOp, "circle-stroke-width": 2.2}});
  m.addLayer({id: "lixoes", type: "circle", source: "lixoes", paint: {"circle-radius": ["interpolate", ["linear"], ["zoom"], 5, 5, 12, 9],
    "circle-color": "#8e24aa", "circle-stroke-color": "#fff", "circle-stroke-width": 1.5}});
  m.addLayer({id: "lixoes-anel", type: "circle", source: "perto-lixao", paint: {"circle-radius": 16, "circle-color": "rgba(0,0,0,0)",
    "circle-stroke-color": "#ba68c8", "circle-stroke-width": 3, "circle-stroke-opacity": 0.9}});
  m.addLayer({id: "vento", type: "line", source: "vento", layout: {"line-cap": "round"},
    paint: {"line-width": 1.6, "line-color": ["interpolate", ["linear"], ["get", "v"], 0, "#90caf9", 10, "#1e88e5", 20, "#3949ab", 35, "#b71c1c"]}});
  m.addLayer({id: "sel", type: "circle", source: "sel", paint: {"circle-radius": 16, "circle-color": "rgba(0,0,0,0)", "circle-stroke-color": "#ffdf00", "circle-stroke-width": 3}});
  Q.layersOk = true;
  montarControles();
  atualizarCamadasDados();
  json("dados/vento.json").then(v => { Q.vento = v; const sl = $("#ventoSl"); if (sl) { sl.max = v.horas_utc.length - 1; } desenharVento(); if (sl) sl.value = Q.ventoHora; }).catch(() => {});
  json("dados/mudancas.json").then(mu => { Q.mudancas = mu; m.getSource("mudancas").setData({type: "FeatureCollection", features: mu.features}); }).catch(() => {});
  m.on("click", "mudancas", ev => { if (Q.modoPonto) return; const p = ev.features[0].properties;
    new maplibregl.Popup().setLngLat(ev.lngLat).setHTML(`<b>Alerta de mudança · ${br(p.ha, 1)} ha</b><br>${{ambos: "Óptico e radar", optico: "Óptico (Sentinel-2)", radar: "Radar (Sentinel-1)"}[p.fonte]}<br>
      Fogo a partir de ${dBR(p.inicio_fogo)} · imagens até ${dBR(p.depois_ate)}<br><span class="nota">Automático, não validado por analista.</span>`).addTo(m); });
  json("dados/erbs.json").then(b => { Q.erbs = b; m.getSource("erbs").setData({type: "FeatureCollection",
    features: b.erbs.map(e => ({type: "Feature", properties: {id: e.id, op: e.op, ger: e.ger.join(", "), mun: e.mun, desde: e.desde}, geometry: {type: "Point", coordinates: [e.lon, e.lat]}}))}); }).catch(() => {});
  m.on("click", "erbs", ev => { if (Q.modoPonto) return; const p = ev.features[0].properties;
    new maplibregl.Popup().setLngLat(ev.lngLat).setHTML(`<b>ERB ${esc(p.op)}</b> · ${esc(p.ger)}<br>Estação nº ${esc(p.id)} · ${esc(p.mun)}<br>Licenciada desde ${esc(p.desde)}<br><span class="nota">Anatel. A posição da antena não é a de um aparelho.</span>`).addTo(m); });
  json("dados/lixoes.json").then(l => { Q.lixoes = l.pontos; m.getSource("lixoes").setData({type: "FeatureCollection",
    features: l.pontos.map(p => ({type: "Feature", properties: {nome: p.nome, mun: p.municipio}, geometry: {type: "Point", coordinates: [p.lon, p.lat]}}))}); }).catch(() => {});
  m.on("click", "lixoes", ev => { const p = ev.features[0].properties; new maplibregl.Popup().setLngLat(ev.lngLat)
    .setHTML(`<b>${esc(p.nome)}</b><br>${esc(p.mun)}<br><span class="nota">Lixão/vazadouro (OpenStreetMap). Fogo aqui gera fumaça tóxica.</span>`).addTo(m); });
  json("dados/deter.json").then(d => m.getSource("deter").setData(d));

  const pop = new maplibregl.Popup({closeButton: false, offset: 8});
  for (const id of ["eventos", "alertas"]) {
    m.on("click", id, ev => { if (Q.modoPonto) return; selecionar(ev.features[0].properties.id, false); rolarPara($("#ficha")); });
    m.on("mouseenter", id, ev => { m.getCanvas().style.cursor = "pointer"; const p = ev.features[0].properties;
      pop.setLngLat(ev.lngLat).setHTML(`<b>${esc(p.mun)}</b> · ${dBR(p.ini)}<br>Prioridade <b>${p.score}</b> · ${p.n} foco(s)`).addTo(m); });
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
  m.getSource("perto-lixao")?.setData(geo([...(Q.alertasF || []), ...Q.filtrados].filter(e => e.det.lixao)));
  m.getSource("fumaca")?.setData(fumaca([...(Q.alertasF || []), ...Q.filtrados.filter(e => Date.now() - new Date(e.fim.replace(" ", "T") + "Z") < 30 * 864e5)]));
  m.getSource("focos").setData({type: "FeatureCollection", features: Q.focos.map(f => ({type: "Feature", geometry: {type: "Point", coordinates: [f[1], f[0]]}, properties: {}}))});
}
function desenharVento() {
  const v = Q.vento; if (!v || !Q.mapa) return;
  const agora = new Date().toISOString().slice(0, 13) + ":00";
  if (Q.ventoHora == null) Q.ventoHora = Math.max(0, v.horas_utc.indexOf(agora));
  const h = Q.ventoHora, feats = [];
  for (const [la, lo, vel, dir] of v.pontos) {
    const s = vel[h], d = dir[h]; if (s == null || d == null) continue;
    const para = (d + 180) * Math.PI / 180, L = 0.12 + Math.min(s, 40) / 40 * 0.45;
    const x2 = lo + Math.sin(para) * L / Math.cos(la * Math.PI / 180), y2 = la + Math.cos(para) * L;
    const pa = (ang) => [x2 - Math.sin(para + ang) * L * .3 / Math.cos(la * Math.PI / 180), y2 - Math.cos(para + ang) * L * .3];
    feats.push({type: "Feature", properties: {v: s}, geometry: {type: "MultiLineString", coordinates: [[[lo, la], [x2, y2]], [pa(.5), [x2, y2], pa(-.5)]]}});
  }
  Q.mapa.getSource("vento").setData({type: "FeatureCollection", features: feats});
  const rot = $("#ventoHora"); if (rot) rot.textContent = manaus(v.horas_utc[h].replace("T", " ")) + " (Manaus)";
}
function fumaca(lista) {
  const [mLat, mLon] = [-3.119, -60.021];
  return {type: "FeatureCollection", features: lista.filter(e => e.det.clima?.fumaca_rumo_manaus).map(e => ({type: "Feature",
    properties: {id: e.id}, geometry: {type: "LineString", coordinates: [[e.lon, e.lat], [mLon, mLat]]}}))};
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
      if (!Q.mosaico[b.pc]) throw new Error("camada indisponível");
      if (!m.getSource(id)) m.addSource(id, {type: "raster", tiles: [Q.mosaico[b.pc]], tileSize: 256, attribution: "ESA Copernicus · Microsoft Planetary Computer", minzoom: 8, maxzoom: 15});
      m.removeLayer("base"); m.addLayer({id: "base", type: "raster", source: id}, "tis");
      const per = Q.mosaico[b.per || "periodo"] || Q.mosaico.periodo;
      $("#baseLeg").innerHTML = `<b>${b.nome}</b><br>${b.leg || ""}<br><span class="nota">Imagens de ${dBR(per[0])} a ${dBR(per[1])}. ${m.getZoom() < 9 ? "Aproxime (zoom 9 ou mais) para ver." : ""}</span>`;
      $("#baseLeg").hidden = false;
      if (m.getZoom() < 9) toast(`Aproxime o mapa (zoom 9 ou mais) para ver ${b.nome}.`, 5000);
    } catch (e) { toast("Não foi possível gerar essa camada de satélite agora. Tente de novo em alguns minutos."); }
    return;
  }
  m.removeLayer("base"); m.addLayer({id: "base", type: "raster", source: "base-" + k}, "tis");
  $("#baseLeg").hidden = true;
}
function montarControles() {
  const el = $("#mapaCtl");
  el.innerHTML = `<button type="button" class="recolher" id="ctlRec" aria-expanded="true"><b>☰ Camadas do mapa</b><span>ocultar</span></button><div id="ctlCorpo">
    <p class="ctl-dica">Marque ou desmarque para <b>ligar ou desligar</b> cada camada.</p>
    <h4>Mapa de fundo</h4>${Object.entries(BASES).filter(([, b]) => !b.grupo).map(([k, b]) => `<label><input type="radio" name="base" value="${k}" ${k === "satelite" ? "checked" : ""}> ${b.nome}</label>`).join("")}
    <h4>Imagens de satélite recentes</h4>${Object.entries(BASES).filter(([, b]) => b.grupo).map(([k, b]) => `<label><input type="radio" name="base" value="${k}"> ${b.nome}</label>`).join("")}
    <h4>Camadas</h4>${CAMADAS.map(([k, t, c, on]) => `<label><input type="checkbox" data-c="${k}" ${on ? "checked" : ""}><span class="sw" style="background:${c}"></span>${t}</label>`).join("")}
    <div id="ventoCtl"><h4>Hora do vento</h4><input type="range" id="ventoSl" min="0" max="47" value="0" style="width:100%"><div class="nota" id="ventoHora"></div></div></div>`;
  el.addEventListener("change", e => {
    if (e.target.name === "base") return trocarBase(e.target.value);
    const k = e.target.dataset.c; if (!k) return;
    const ids = {tis: ["tis", "tis-l"], ucs: ["ucs", "ucs-l"]}[k] || [k];
    ids.forEach(id => Q.mapa.setLayoutProperty(id, "visibility", e.target.checked ? "visible" : "none"));
    if (k === "mudancas") Q.mapa.setLayoutProperty("mudancas-l", "visibility", e.target.checked ? "visible" : "none");
    if (k === "lixoes") Q.mapa.setLayoutProperty("lixoes-anel", "visibility", e.target.checked ? "visible" : "none");
    if (k === "vento") { $("#ventoCtl").hidden = !e.target.checked; const sl = $("#ventoSl");
      if (Q.vento) { sl.max = Q.vento.horas_utc.length - 1; sl.value = Q.ventoHora || 0; } desenharVento(); }
  });
  el.addEventListener("input", e => { if (e.target.id === "ventoSl") { Q.ventoHora = +e.target.value; desenharVento(); } });
  $("#ctlRec").onclick = () => { const c = $("#ctlCorpo"); c.hidden = !c.hidden; $("#ctlRec span").textContent = c.hidden ? "mostrar" : "ocultar"; $("#ctlRec").setAttribute("aria-expanded", !c.hidden); };
  if (matchMedia("(max-width:640px)").matches) $("#ctlRec").click();
  $("#legenda").innerHTML = `<b style="font-size:12px">Prioridade de verificação</b>` + [["--s4", "Muito alta (85+)"], ["--s3", "Alta (70–84)"], ["--s2", "Atenção (50–69)"], ["--s1", "Baixa (0–49)"]].map(([c, t]) => `<div><i style="background:var(${c})"></i>${t}</div>`).join("")
    + `<div><i style="background:transparent;border:2px solid #ff7a00"></i>Alerta de agora (VIIRS)</div><div><i style="background:#8e24aa"></i>Lixão/vazadouro</div><div><i style="background:#fff;border:2px solid #5e35b1"></i>ERB (zoom 7+): <span style="color:#7b1fa2">Vivo</span> · <span style="color:#1565c0">TIM</span> · <span style="color:#c62828">Claro</span></div><div><b style="font-size:11px">Alerta de mudança:</b></div><div><i style="background:#ffd600;border-radius:2px"></i>Óptico · <i style="background:#00b8d4;border-radius:2px;margin-left:4px"></i>Radar · <i style="background:#ff1744;border-radius:2px;margin-left:4px"></i>Ambos</div><div><i style="background:transparent;border:2px solid #ba68c8"></i>Fogo a até 1 km de lixão</div><div class="nota" style="font-size:11px">Tamanho = quantidade de focos</div>`;
}

// ------------------------------------------------------------ ocorrências (tabela)
const OC = {pag: 0, ord: "score", dir: -1};
const COLS_OC = [["score", "Prior."], ["ia", "IA"], ["id", "Nº"], ["mun", "Município"], ["ini", "Início (UTC)"], ["n", "Focos"], ["maxDia", "Máx/dia"],
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
    [fmt(al.length), "alertas VIIRS agrupados", "ouro"], [fmt(al.filter(e => e.score >= 70).length), "alertas com prioridade ≥ 70", "vermelho fogo"],
    [fmt(al.filter(e => e.det.clima?.fumaca_rumo_manaus).length), "alertas com fumaça rumo a Manaus", "vermelho fogo"],
    [Q.est ? manaus(Q.est.ultimo_foco_utc) : "–", "último foco recebido (Manaus)", "azul"]]
    .map(([v, t, c]) => `<div class="indicador ${c}"><b style="${v.length > 10 ? "font-size:18px" : ""}">${v}</b><span>${t}</span></div>`).join("");
  $("#tabTR").innerHTML = `<thead><tr><th>Prior.</th><th>Município</th><th>Área</th><th>Primeiro foco (Manaus)</th><th>Último (Manaus)</th><th>Focos</th><th>Vento</th><th>Fumaça → Manaus</th><th>Indicadores</th><th>Coord.</th></tr></thead><tbody>`
    + al.slice(0, 400).map(e => `<tr class="clicavel" data-id="${e.id}"><td><span class="pontos" style="background:${corScore(e.score)}">${e.score}</span></td><td>${esc(e.mun)}</td><td>${esc(e.det.ti || e.det.uc || "")}</td>
      <td class="mono">${manaus(e.ini)}</td><td class="mono">${manaus(e.fim)}</td><td class="n">${e.n}</td><td>${e.det.clima ? `${br(e.det.clima.vento_kmh, 0)} km/h de ${rosa(e.det.clima.vento_de_graus)}` : "–"}</td>
      <td>${e.det.clima?.fumaca_rumo_manaus ? `<span class="selo erro">sim, ~${br(e.det.clima.horas_ate_manaus, 0)} h</span>` : "–"}</td>
      <td>${e.ind.map(k => `<span class="selo">${IND_TXT[k].split(" ")[0]}</span>`).join(" ")}</td><td class="n">${e.lat.toFixed(4)}, ${e.lon.toFixed(4)}</td></tr>`).join("") + "</tbody>";
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
    + `<div class="indicador ouro"><b>${fmt(f.length)}</b><span>eventos no filtro atual</span></div><div class="indicador ouro"><b>${f.length ? br(d3.mean(f, e => e.score), 1) : "–"}</b><span>prioridade média no filtro</span></div>`;
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
    <div class="cartao"><h2>2. Prioridade de verificação (0–100)</h2>
      <table class="tabela"><thead><tr><th>Indicador</th><th>Critério</th><th>Peso</th></tr></thead><tbody>
      ${Object.keys(P).map(k => `<tr><td>${D[k][0]}</td><td class="nota">${D[k][1]}</td><td class="n">${P[k]}</td></tr>`).join("")}</tbody></table>
      <div class="formula">prioridade = Σ peso(indicador presente) · máximo = 100 · serve para ordenar a fila, não é probabilidade</div>
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
      <div class="formula">base = mediana(NDVI da linha de base) · σ = desvio-padrão<br>limiar = base − max(3σ ; 0,15)<br>quebra confirmada = 1ª de ≥ 6 observações seguidas abaixo do limiar (CCDC)<br>queda no fim da série com menos de 6 = mudança provável<br>data ∈ (última acima ; primeira abaixo]</div>
      <p>Limiar do serviço ambiental do PolicIA, com a confirmação por 6 observações consecutivas do CCDC (Zhu & Woodcock, 2014; Arévalo et al., 2020), que evita confundir quedas passageiras da estação chuvosa com perda de vegetação. É descritivo, não o CCDC completo. A cena de cada mês precisa ter ao menos 80% da área analisada limpa e, entre essas, fica a de menor nuvem na cena. Na linha de base, a triagem Tmask do CCDC remove observações com névoa ou sombra que escaparam da máscara (verde acima da mediana + 0,04 ou SWIR1 abaixo da mediana − 0,04). Diferenças deliberadas: o offset do Sentinel-2 vai pela versão de processamento da cena (há cenas de 2019 e 2021 reprocessadas com offset), e o Landsat entra só como Tier 1, sem nuvem classificada como neve.</p></div>
    <div class="cartao"><h2>5. Inteligência artificial</h2>
      <p><b>DBSCAN</b> agrupa focos em eventos. <b>Isolation Forest</b> aprende o padrão dos eventos do Amazonas (focos, duração, simultaneidade, desmatamento, reincidência, área protegida, distância) e dá a cada evento uma nota de <b>atipicidade</b> de 0 a 100. O <b>parecer preliminar</b> é redigido por um modelo de linguagem (Google Gemini) a partir dos números calculados, sem acrescentar fatos.</p>
      <p class="nota">Próximo passo: com casos confirmados pela DEMA e laudos do DPTC, treinar um classificador supervisionado que estime a probabilidade de origem criminosa.</p></div>
    <div class="cartao"><h2>6. Clima e comportamento do fogo</h2>
      <p>Para cada evento, o clima na hora do 1º foco vem do Open-Meteo (modelos ECMWF, GFS e ICON; reanálise ERA5 para datas antigas): vento, umidade, temperatura e chuva das 72 h anteriores. Do INPE vêm, por foco, o risco de fogo, os dias sem chuva e a intensidade (FRP).</p>
      <div class="formula">ignição em condição desfavorável (+10) = risco INPE &lt; 0,3 ou chuva 72 h ≥ 10 mm ou umidade mínima das 24 h anteriores ≥ 80%<br>escape plausível (contexto) = (risco ≥ 0,8 ou ≥ 30 dias sem chuva) e vento ≥ 10 km/h<br>muita biomassa (contexto) = FRP ≥ 100 MW e fogo por 2+ dias ou à noite<br>fumaça rumo a Manaus = vento soprando a ±30° da direção da cidade, até 800 km; chegada ≈ distância ÷ velocidade</div>
      <p class="nota">Na Amazônia quase todo fogo é de origem humana; raio é raro na estação seca. O clima ajuda a distinguir a ignição deliberada da queima que escapa do controle, mas é contexto e não prova.</p></div>
    <div class="cartao"><h2>7. Alertas de mudança (Sentinel-2 + radar Sentinel-1)</h2>
      <p>Para os incêndios recentes com prioridade ≥ 50, o motor compara um recorte de 3 × 3 km antes e depois do fogo.</p>
      <div class="formula">Óptico: antes = mediana das cenas limpas de 90 a 5 dias antes; depois = de 1 a 60 dias depois<br>
      mudança = NDVI antes ≥ 0,6 e sem água (NDWI &lt; 0) e (dNBR ≥ 0,27 ou ΔNDVI ≤ −0,20 com NDVI depois &lt; 0,5)<br>
      Radar: ΔVH (dB) local = ΔVH − mediana do recorte (desconta a seca); mudança = ΔVH local ≤ −3 dB<br>
      polígonos com pelo menos 1 ha · fonte = óptico, radar ou ambos</div>
      <p class="nota">Inspirado nos alertas do Brasil MAIS e do DETER, mas com satélites públicos (10 m, a cada 5 a 12 dias) e sem validação por analista. É alerta para verificar, não laudo. O radar enxerga através de nuvem e fumaça; a queda do sinal VH indica abertura de dossel.</p></div>
    <div class="cartao"><h2>Limitações</h2><ul>
      <li>O satélite detecta calor, não autoria. A prioridade orienta diligências, nunca é prova nem grau de certeza.</li>
      <li>Em TIs e RDS/RESEX há uso tradicional do fogo, permitido. A prioridade nessas áreas exige leitura cuidadosa.</li>
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
    ["Clima: vento, umidade, chuva", "Open-Meteo (ECMWF, GFS, ICON, ERA5)", "https://open-meteo.com/", Q.vento ? manaus(Q.vento.gerado_em.replace("T", " ").slice(0, 19)) : "–", "a cada 3 h (grade) · por evento", "vento no mapa e na ficha"],
    ["Sentinel-2 L2A (10 m)", "ESA Copernicus · Microsoft Planetary Computer", "https://planetarycomputer.microsoft.com/dataset/sentinel-2-l2a", "sob demanda", "~5 dias", "NDVI, NBR, NDMI, imagens"],
    ["Alertas de mudança (óptico + radar)", "Fogo Forense, a partir de Sentinel-2 e Sentinel-1", "#", Q.mudancas ? Object.keys(Q.mudancas.eventos || {}).length + " incêndios analisados" : "–", "6 incêndios por ciclo", "automático, não validado"],
    ["ERBs de telefonia móvel", "Anatel — Estações do SMP licenciadas", "https://www.anatel.gov.br/dadosabertos/paineis_de_dados/outorga_e_licenciamento/estacoes_smp.zip", Q.erbs ? fmt(Q.erbs.n) + " estações no AM" : "–", "semanal", "localização das antenas, não de aparelhos"],
    ["Sentinel-1 RTC (radar, 10 m)", "ESA Copernicus · Microsoft Planetary Computer", "https://planetarycomputer.microsoft.com/dataset/sentinel-1-rtc", "a cada 6 h (mosaico)", "~6 a 12 dias", "vê através de nuvem e fumaça"],
    ["Landsat 8/9 C2 L2 (30 m)", "NASA/USGS · Microsoft Planetary Computer", "https://planetarycomputer.microsoft.com/dataset/landsat-c2-l2", "sob demanda", "~8 dias", "série longa"],
  ];
  $("#fontes").innerHTML = `<div class="indicadores">
      <div class="indicador azul"><b style="font-size:18px">${manaus(st.gerado_em.replace("T", " ").slice(0, 19))}</b><span>último ciclo (hora de Manaus)</span></div>
      <div class="indicador azul"><b>${f.duracao_ciclo_s ?? "–"} s</b><span>duração do ciclo</span></div>
      <div class="indicador ouro"><b>${fmt(st.n_eventos)}</b><span>eventos de referência</span></div>
      <div class="indicador ouro"><b>${fmt(st.n_deter)}</b><span>polígonos DETER no mapa</span></div></div>
    <div class="cartao"><div class="cab"><h2>Fontes de dados</h2><a class="botao secundario pequeno" href="api/docs" target="_blank" rel="noopener">API do Fogo Forense</a></div>
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
