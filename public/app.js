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
  ignicao_desfavoravel: "Ignição em tempo desfavorável", conversao_florestal: "Conversão de floresta (MapBiomas)",
  floresta_publica_nd: "Floresta pública não destinada",
};
// nome curto de um indicador; tolera indicadores novos vindos do motor (nunca quebra a tela)
const indTxt = k => IND_TXT[k] || window.Q?.est?.descricao_indicadores?.[k]?.[0] || String(k).replace(/_/g, " ");
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
  $("#fInd").innerHTML = Q.ind.map(k => `<span class="chip" role="button" tabindex="0" aria-pressed="false" data-k="${k}">${indTxt(k) || k}</span>`).join("");
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
    return `<div class="ind-linha ${on ? "" : "off"}"><span class="mk">${on ? "✓" : "–"}</span><span>${(D[k] || [indTxt(k)])[0]}<small>${(D[k] || ["", ""])[1]}${on ? extra : ""}</small></span><span class="w">${on ? "+" : ""}${P[k]}</span></div>`; }).join("");
  const calc = e.ind.map(k => `${P[k]} (${indTxt(k)})`).join(" + ") || "0";
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
      <a class="botao secundario" href="https://www.ventusky.com/?p=${lat};${lon};9&l=radar" target="_blank" rel="noopener" title="Tempo agora, radar e previsão no local do evento">Abrir no Ventusky</a>
      <button type="button" class="botao secundario" id="fCopiar">Copiar resumo</button>
      <button type="button" class="botao" id="fRelatorio" title="Um clique: faz a análise de satélite que faltar, redige o parecer e monta o relatório em PDF com mapas, bases consultadas e matriz de hipóteses">Gerar relatório completo</button></div></div>
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
    ${blocoTerritorio(e)}
    ${blocoEntorno(e)}
    ${blocoCronologia(e)}
    ${blocoMudanca(e)}
    ${blocoErbs(e)}
    ${blocoBrmais(e)}
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
  recolherBlocos($("#ficha"));
  if ($("#fAnalisar")) $("#fAnalisar").onclick = () => window.abrirAnalise?.(e);
  if ($("#fPronta")) $("#fPronta").onclick = () => window.mostrarAnalisePronta?.(e.id);
  $("#fRelatorio").onclick = () => {
    try { localStorage.setItem("ff_rel_" + e.id, JSON.stringify({porque, confronto: blocoConfronto(e), clima: blocoClima(e), territorio: blocoTerritorio(e), entorno: blocoEntorno(e), cronologia: blocoCronologia(e),
      mudanca: blocoMudanca(e), erbs: blocoErbs(e), brmais: blocoBrmais(e), restrito: !!Q.usuario, t: Date.now()})); } catch (x) {}
    window.open("relatorio.html?id=" + encodeURIComponent(e.id), "_blank");
  };
  $("#fCopiar").onclick = () => { const t = `Fogo Forense ${e.id} — ${e.mun}, ${dBR(e.ini)}. Prioridade ${e.score} (${e.ind.map(k => indTxt(k)).join("; ") || "sem indicadores"}). ${e.n} focos, ${lat}, ${lon}. ${d.ti || d.uc || ""}`;
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
  const tr = d.territorio, c1 = tr?.cobertura?.fracao || {}, fh = tr?.fogo_historico || {};
  if (tr?.conversao) intenc.push(`MapBiomas: ${br(tr.conversao.ha_convertidos, 1)} ha de floresta convertidos em ${(GRUPO_TXT[tr.conversao.para] || tr.conversao.para).toLowerCase()} entre ${tr.conversao.de} e ${tr.conversao.ate}: padrão de desmatamento seguido de queima (não é independente do DETER, quando os dois existem)`);
  if (fh.anos_p90 >= 3) intenc.push(`MapBiomas Fogo: parte da área queimou em ${fh.anos_max} anos desde 1985 (última em ${fh.ultimo_ano}): uso recorrente do fogo no local`);
  if (tr && (c1.pastagem || 0) + (c1.agricultura || 0) + (c1.mosaico || 0) >= 0.5 && !tr.conversao)
    acid.push(`Uso agropecuário consolidado (MapBiomas ${tr.cobertura.ano}: ${tr.cobertura.classe_dominante.toLowerCase()}): compatível com queima de manejo de pasto ou roça; verificar autorização de queima`);
  if (tr && (c1.floresta || 0) >= 0.8 && !fh.anos_max)
    inconc.push(`Floresta natural sem queima registrada desde 1985 (MapBiomas): floresta úmida raramente queima sem fonte humana; falta discriminar ignição no local de escape de queima vizinha`);
  const cc = d.car_camadas || {};
  if (cc.app?.no_ponto) intenc.push(`Fogo em APP declarada no CAR (imóvel ${cc.app.imovel}): uso do fogo vedado`);
  else if (cc.app?.ha_500m) inconc.push(`APP declarada no CAR a até 500 m (${br(cc.app.ha_500m, 1)} ha): conferir se o fogo a atingiu`);
  if (cc.rl?.no_ponto) intenc.push(`Fogo em Reserva Legal declarada no CAR (imóvel ${cc.rl.imovel}): supressão vedada sem plano de manejo`);
  if (cc.consolidada?.no_ponto && !cc.app?.no_ponto && !cc.rl?.no_ponto) acid.push(`Área consolidada declarada no CAR (imóvel ${cc.consolidada.imovel}): uso agropecuário já existente; verificar autorização de queima`);
  if (tr?.app?.dentro) intenc.push(`Fogo em provável APP de margem (água a ${fmt(tr.app.dist_agua_m)} m de rio ou lago com ~${fmt(tr.app.largura_m)} m de largura; faixa de ${tr.app.faixa_m} m pela Lei 12.651/2012, art. 4º): uso do fogo vedado — APP estimada, confirmar com o CAR e em campo`);
  if (tr?.relevo?.declividade_p90_graus >= 12) inconc.push(`Relevo inclinado (declividade de até ${br(tr.relevo.declividade_p90_graus, 0)}°): o fogo tende a subir a encosta; na perícia, procurar a região de início na parte baixa`);
  if (d.estrada?.km != null && d.estrada.km <= 1) inconc.push(`Via a ${br(d.estrada.km * 1000, 0)} m (${d.estrada.tipo}${d.estrada.nome ? " " + d.estrada.nome : ""}; OpenStreetMap): acesso humano fácil, compatível tanto com ignição deliberada quanto com escape de queima à beira da via`);
  else if (d.estrada && (d.estrada.km == null || d.estrada.km > 10)) inconc.push(`Sem estrada ou ramal mapeado a até ${d.estrada.km == null ? d.estrada.busca_km : br(d.estrada.km, 0)} km (OpenStreetMap incompleto): acesso provável por rio ou trilha`);
  if (d.fpnd) intenc.push(`Em floresta pública não destinada (${d.fpnd.nome}, ${(d.fpnd.governo || "").toLowerCase()}; Serviço Florestal Brasileiro): desmatamento e fogo nessas glebas são associados à grilagem de terras públicas`);
  if (d.prodes?.total_ha) intenc.push(`PRODES: ${br(d.prodes.total_ha, 1)} ha desmatados a até 1 km em ${Object.keys(d.prodes.anos_ha).join(", ")}: histórico de conversão (não independente do DETER e do MapBiomas)`);
  if (d.sigef?.no_ponto?.length) inconc.push(`Imóvel certificado no SIGEF no ponto: ${d.sigef.no_ponto[0].nome_area} (código ${d.sigef.no_ponto[0].codigo_imo}): pista para identificar o detentor, não prova autoria`);
  if (d.mineracao?.garimpo_ha_3km) inconc.push(`Garimpo mapeado a ${br(d.mineracao.mais_perto_km, 1)} km (${br(d.mineracao.garimpo_ha_3km, 1)} ha a até 3 km; MapBiomas 2023): contexto de atividade ilícita a esclarecer`);
  if (d.pista?.km <= 5) inconc.push(`Pista de pouso a ${br(d.pista.km, 1)} km (${d.pista.nome}; OpenStreetMap): acesso aéreo ao local`);
  if (d.assentamento) acid.push(`Dentro do assentamento ${d.assentamento.nome} (INCRA, ${d.assentamento.familias ?? "?"} famílias): o fogo na agricultura familiar é comum; verificar o lote e a autorização de queima`);
  if (d.goes?.antecede_h > 0) inconc.push(`GOES: fogo já detectável ${br(d.goes.antecede_h, 1)} h antes do satélite de referência (${manaus(d.goes.primeira)}, Manaus): estreita o horário, mas não é a hora da ignição`);
  if (ctx.includes("escape_plausivel")) acid.push("Seca forte e vento acima de 10 km/h: uma queima pode ter escapado do controle");
  if (d.ti) acid.push("Em terra indígena, a roça tradicional dos próprios indígenas com fogo é permitida");
  else if (d.uc && d.uc_grupo !== "PI") acid.push("Reserva de uso sustentável: a roça tradicional das comunidades com fogo é permitida");
  if (!d.desmatamento && an?.relacao !== "antes_do_fogo") acid.push("Sem desmatamento prévio detectado");
  if (e.n <= 2 && (f.dias_com_fogo || 1) <= 1 && (f.frp_max == null || f.frp_max < 20)) acid.push("Fogo pequeno e curto, de baixa intensidade");
  const frac = d.territorio?.cobertura?.fracao, jaSemFloresta = !!frac && (frac.floresta || 0) < 0.3;
  if (an && !an.quebra) {
    if (jaSemFloresta) inconc.push(`A área já não era floresta antes do fogo (MapBiomas ${d.territorio.cobertura.ano}: ${d.territorio.cobertura.classe_dominante.toLowerCase()}): o critério de perda de vegetação do NDVI, feito para floresta, não discrimina as hipóteses aqui`);
    else acid.push("A vegetação não foi perdida de forma sustentada (NDVI)");
  }
  if (!(e.maxDia >= 3) && e.n > 2) acid.push("Focos espalhados ao longo dos dias, sem detecções simultâneas");
  if (d.lixao) acid.push(`A ${br(d.lixao.dist_m, 0)} m de um lixão/vazadouro (${d.lixao.nome}): possível fonte térmica não vegetal ou queima de resíduos; fumaça tóxica`);
  // inconclusivos e lacunas: o que ainda não permite discriminar
  const brD = desmPerto(e).filter(x => x.a[4] <= e.ini.slice(0, 10));
  if (brD.length) { const ha = brD.reduce((t, x) => t + x.a[2], 0), gar = brD.some(x => x.a[1] === "G");
    intenc.push(`Brasil MAIS (restrito): ${brD.length} alerta(s) de ${gar ? "desmatamento/garimpo" : "desmatamento"} a até ${BRM_RAIO_KM} km nos 12 meses antes do fogo (${br(ha, 1)} ha; o mais recente com imagem de ${dBR(brD.map(x => x.a[4]).sort().pop())})`); }
  const brI = brmaisPerto(e).filter(x => x.a[1] === "I");
  if (brI.length) inconc.push(`Brasil MAIS (restrito): ${brI.length} indício(s) de local de início por IA, o mais próximo a ${br(brI[0].km, 1)} km. É hipótese espacial do produto (só em vegetação primária), não ponto de ignição demonstrado: confrontar em campo`);
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

const GRUPO_TXT = {floresta: "Floresta natural", natural_nao_florestal: "Vegetação natural não florestal", pastagem: "Pastagem", agricultura: "Agricultura",
  mosaico: "Mosaico de usos", urbano: "Área urbana", mineracao: "Mineração", agua: "Água", nao_vegetado: "Não vegetado", outros: "Outros"};
function blocoTerritorio(e) {
  const t = e.det.territorio; if (!t) return "";
  const c1 = t.cobertura || {}, c0 = t.cobertura_antes || {}, fh = t.fogo_historico || {}, rv = t.relevo, cv = t.conversao;
  const grupos = [...new Set([...Object.keys(c0.fracao || {}), ...Object.keys(c1.fracao || {})])];
  const pct = v => v == null ? "–" : br(v * 100, 0) + "%";
  return `<div class="clima-bloco"><h3>Território: uso da terra, fogo histórico e relevo</h3>
    ${cv ? `<p class="clima-leitura"><b>Conversão de floresta</b>: a floresta natural a até ${t.raio_m} m caiu de ${pct(cv.floresta_antes)} (${cv.de}) para ${pct(cv.floresta_depois)} (${cv.ate}), cerca de <b>${br(cv.ha_convertidos, 1)} ha</b> que viraram ${esc(GRUPO_TXT[cv.para] || cv.para).toLowerCase()}. Compatível com desmatamento seguido de queima para formar ${cv.para === "pastagem" ? "pasto" : "área de uso"}.</p>` : ""}
    <div class="rolagem"><table class="tabela"><thead><tr><th>Uso e cobertura (MapBiomas)</th><th>${c0.ano || "–"}</th><th>${c1.ano || "–"}</th></tr></thead><tbody>
      ${grupos.map(g => `<tr><td>${esc(GRUPO_TXT[g] || g)}</td><td class="n">${pct((c0.fracao || {})[g])}</td><td class="n">${pct((c1.fracao || {})[g])}</td></tr>`).join("")}</tbody></table></div>
    <div class="fatos">
      <div><span>Classe dominante (${c1.ano || "–"})</span><b>${esc(c1.classe_dominante || "–")}</b></div>
      <div><span>Anos com fogo desde 1985 (máx.)</span><b>${fh.anos_max ?? "–"}</b></div>
      <div><span>Área que já queimou</span><b>${pct(fh.fracao_ja_queimada)}</b></div>
      <div><span>Última queima registrada</span><b>${fh.ultimo_ano || "nenhuma"}</b></div>
      ${rv ? `<div><span>Altitude</span><b>${br(rv.altitude_m, 0)} m</b></div><div><span>Declividade média</span><b>${br(rv.declividade_media_graus, 1)}°</b></div>` : ""}
      ${t.app ? `<div><span>APP de margem (estimada)</span><b>${t.app.dist_agua_m == null ? "sem rio ou lago visível a até 600 m" : `${t.app.dentro ? "DENTRO" : "fora"} · água a ${fmt(t.app.dist_agua_m)} m · faixa de ${t.app.faixa_m} m`}</b></div>` : ""}
    </div>
    ${t.app?.dentro ? `<p class="clima-leitura"><b>Provável APP de margem</b>: o centro do evento está a ${fmt(t.app.dist_agua_m)} m de um corpo d'água com cerca de ${fmt(t.app.largura_m)} m de largura; pelo art. 4º, I, da Lei 12.651/2012, a faixa de preservação seria de ${t.app.faixa_m} m. O uso do fogo em APP é vedado.</p>` : ""}
    <p class="nota">APP estimada: água do MapBiomas (30 m) e faixas do Código Florestal pela largura do rio; rios com menos de ~30 m e nascentes não aparecem, e lagos têm faixa própria (100 m em área rural). É cálculo, não a APP declarada no CAR. Círculo de ${t.raio_m} m no centro do evento. Uso da terra no ano anterior ao fogo e 5 anos antes: MapBiomas Coleção 10 (Souza et al., 2020), 30 m. Fogo histórico até ${fh.ate}: MapBiomas Fogo Coleção 5. Relevo: Copernicus DEM GLO-30. Classificações de satélite têm erro e não substituem a verificação de campo.</p></div>`;
}
const IUCN_TXT = {CR: "Criticamente em perigo", EN: "Em perigo", VU: "Vulnerável"};
function blocoEntorno(e) {
  const es = e.det.estrada, as = e.det.assentamento, ba = e.det.bacia, bio = e.det.biodiversidade;
  const fp = e.det.fpnd, sg = e.det.sigef, al = e.det.aldeias, mi = e.det.mineracao, pi = e.det.pista, bo = e.det.bombeiros, pr = e.det.prodes;
  if (!es && !as && !ba && !bio && !fp && !sg) return "";
  const am = bio?.ameacadas || [];
  return `<div class="clima-bloco"><h3>Entorno: acesso, fundiário, água e biodiversidade</h3>
    <div class="fatos">
      ${es ? `<div><span>Via mais próxima (OSM)</span><b>${es.km == null ? `nenhuma a até ${es.busca_km} km` : `${br(es.km, es.km < 1 ? 2 : 1)} km · ${esc(es.tipo)}${es.nome ? " · " + esc(es.nome) : ""}`}</b></div>` : ""}
      <div><span>Assentamento (INCRA)</span><b>${as ? `${esc(as.nome)} · ${as.familias ?? "–"} famílias` : "fora de assentamento"}</b></div>
      ${ba ? `<div><span>Sub-bacia (ANA)</span><b>${esc(ba.nome)}</b></div>` : ""}
      <div><span>Floresta pública não destinada</span><b>${fp ? `${esc(fp.nome)} (${esc(fp.governo || "").toLowerCase()})` : "não"}</b></div>
      ${e.det.car_camadas ? `<div><span>CAR declarado no ponto</span><b>${[["app", "APP"], ["rl", "Reserva Legal"], ["consolidada", "área consolidada"], ["rvn", "vegetação nativa"], ["uso_restrito", "uso restrito"], ["pousio", "pousio"]]
        .filter(([k]) => e.det.car_camadas[k]?.no_ponto).map(([, t]) => t).join(", ") || "nenhuma camada no ponto"}</b></div>` : ""}
      ${sg ? `<div><span>Imóveis SIGEF a até 500 m</span><b>${sg.a_500m}${sg.no_ponto?.length ? ` · no ponto: ${esc(sg.no_ponto[0].nome_area)}` : ""}</b></div>` : ""}
      ${pr ? `<div><span>PRODES a até 1 km, antes do fogo</span><b>${pr.total_ha ? `${br(pr.total_ha, 1)} ha (${Object.keys(pr.anos_ha).length} ano(s))` : "nenhum"}</b></div>` : ""}
      ${al ? `<div><span>Aldeias a até 10 km (FUNAI)</span><b>${al.n_10km} · mais perto: ${esc(al.nome)}, ${br(al.mais_perto_km, 1)} km</b></div>` : ""}
      ${mi ? `<div><span>Mineração a até 3 km (MapBiomas)</span><b>${mi.garimpo_ha_3km ? br(mi.garimpo_ha_3km, 1) + " ha de garimpo" : ""}${mi.garimpo_ha_3km && mi.industrial_ha_3km ? " · " : ""}${mi.industrial_ha_3km ? br(mi.industrial_ha_3km, 1) + " ha industrial" : ""}</b></div>` : ""}
      ${pi ? `<div><span>Pista de pouso mais próxima (OSM)</span><b>${br(pi.km, 1)} km · ${esc(pi.nome)}</b></div>` : ""}
      ${bo ? `<div><span>Bombeiros mais próximos (OSM)</span><b>${fmt(bo.km)} km · ${esc(bo.nome)}</b></div>` : ""}
      ${bio ? `<div><span>Espécies registradas a até ${bio.raio_km} km (GBIF)</span><b>${fmt(bio.especies)} · ${am.length} ameaçada(s)</b></div>` : ""}
    </div>
    ${sg?.no_ponto?.length ? `<p class="clima-leitura"><b>Imóvel certificado no ponto (SIGEF/INCRA)</b>: ${sg.no_ponto.map(x => `${esc(x.nome_area)} · código ${esc(x.codigo_imo)}${x.registro_m && x.registro_m !== "None" ? ` · matrícula ${esc(x.registro_m)}` : ""} · ${esc(x.status)} ${x.parcela_co ? `<a class="botao secundario pequeno" href="${sigefUrl(x.parcela_co)}" target="_blank" rel="noopener" title="Abre a consulta pública do INCRA, que mostra o detentor">Consultar detentor no SIGEF</a>` : ""}`).join("<br>")}</p>` : ""}
    ${am.length ? `<p class="clima-leitura"><b>Espécies ameaçadas registradas no entorno</b> (Lista Vermelha da IUCN): ${am.slice(0, 12).map(a => `<i>${esc(a.nome)}</i> (${IUCN_TXT[a.categoria] || a.categoria}${a.classe ? ", " + esc(a.classe) : ""})`).join("; ")}${am.length > 12 ? `; e mais ${am.length - 12}` : ""}.</p>` : ""}
    <p class="nota">Florestas públicas: Serviço Florestal Brasileiro (CNFP 2025). SIGEF e assentamentos: INCRA (imóvel é pista para identificar o detentor, não prova autoria). PRODES: INPE. Aldeias: FUNAI. Mineração: MapBiomas (2023). Vias, pistas e bombeiros: OpenStreetMap, base colaborativa e incompleta (falta de ramal no mapa não prova falta de acesso). Sub-bacias: ANA (DNAEE). Biodiversidade: registros de ocorrência do GBIF, esparsos na Amazônia — ausência de registro não é ausência de espécie; serve para dimensionar o dano potencial.</p></div>`;
}
function blocoCronologia(e) {
  const p = e.det.passagens; if (!p?.length) return "";
  const go = e.det.goes;
  return `<div class="clima-bloco"><h3>Cronologia das detecções por passagem</h3>
    ${go ? `<p class="clima-leitura">Satélite geoestacionário (${esc(go.satelite)}, imagem a cada 10 min): ${go.deteccoes} detecção(ões) a até 4 km; a primeira em <b>${manaus(go.primeira)}</b> (Manaus)${go.antecede_h > 0 ? `, <b>${br(go.antecede_h, 1)} h antes</b> do 1º foco do satélite de referência` : ", depois do 1º foco de referência"}. Estreita o horário em que o fogo já era detectável; pixel de ~2 km, não marca o ponto nem a hora da ignição.</p>` : ""}
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
  const ar = e.det.ar;
  if (ar?.dias_acima_oms) leitura.push(`Fumaça (CAMS): o PM2,5 médio diário no local chegou a <b>${br(ar.pm25_media_dia_max, 0)} µg/m³</b> em ${dBR(ar.dia_pior)}, ${ar.dias_acima_oms} dia(s) acima do limite da OMS (15 µg/m³)${ar.manaus?.dias_acima_oms ? `; em Manaus, ${br(ar.manaus.pm25_media_dia_max, 0)} µg/m³ no pior dia do período (a fumaça na capital tem várias origens)` : ""}.`);
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
      ${ar ? item("PM2,5 no local (CAMS)", `${br(ar.pm25_media_dia_max, 0)} µg/m³ (pico ${br(ar.pm25_max, 0)})`) : ""}
      ${ar?.manaus ? item("PM2,5 em Manaus", `${br(ar.manaus.pm25_media_dia_max, 0)} µg/m³`) : ""}
    </div>
    ${leitura.length ? `<p class="clima-leitura">${leitura.join(" ")}</p>` : `<p class="nota">Sem sinal climático forte para acidente ou para ignição deliberada.</p>`}
    <p class="nota">Clima: ${cl ? esc(cl.fonte) + ", na hora do 1º foco" : "indisponível para este evento"}.${ar ? " Fumaça: Copernicus CAMS (Open-Meteo), média diária de PM2,5." : ""} Risco de fogo, dias sem chuva e FRP: INPE, por foco (disponíveis a partir de ${new Date().getFullYear()}).</p>
  </div>`;
}

// ------------------------------------------------------------ mapa
const BASES = {
  mapa: {nome: "Mapa (OpenStreetMap)", tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"], attr: "© OpenStreetMap"},
  satelite: {nome: "Satélite (Esri)", tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"], attr: "Esri, Maxar, Earthstar"},
  topo: {nome: "Topográfico (Esri)", tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}"], attr: "Esri"},
  claro: {nome: "Claro (Esri)", tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}"], attr: "Esri, HERE, Garmin", max: 16},
  escuro: {nome: "Escuro (Esri)", tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}"], attr: "Esri, HERE, Garmin", max: 16},
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
  ["vento", "Vento (previsão, setas)", "#1e88e5", true],
  ["chuva", "Radar de chuva (RainViewer, agora) <span class=\"nota\" id=\"chuvaHora\"></span>", "#2979ff", false],
  ["nuvens", "Nuvens (satélite GOES-16, a cada 10 min)", "#90a4ae", false],
  ["imerg", "Chuva por satélite (NASA GPM IMERG, 30 min)", "#5c6bc0", false],
  ["riscoprev", "Risco de fogo previsto (INPE, até 3 dias)", "#f57c00", false],
  ["fauna", "Fauna: registros de ocorrência (GBIF)", "#e65100", false],
  ["flora", "Flora: registros de ocorrência (GBIF)", "#2e7d32", false],
  ["bacias", "Sub-bacias hidrográficas (ANA)", "#0277bd", false],
  ["rios", "Rios (ANA)", "#29b6f6", false],
  ["assentamentos", "Assentamentos (INCRA)", "#a1887f", false],
  ["estradas", "Estradas e ramais (OpenStreetMap)", "#ff7043", false],
  ["prodes", "PRODES: desmatamento anual (INPE)", "#c2185b", false],
  ["fpnd", "Florestas públicas não destinadas (SFB)", "#7cb342", false],
  ["sigef", "Imóveis certificados SIGEF (INCRA, zoom 9+)", "#ffb300", false],
  ["aldeias", "Aldeias indígenas (FUNAI)", "#6d4c41", false],
  ["mineracao", "Garimpo e mineração (MapBiomas 2023)", "#d50000", false],
  ["pistas", "Pistas de pouso (OpenStreetMap)", "#37474f", false],
  ["bombeiros", "Bombeiros (OpenStreetMap)", "#e53935", false], ["fumaca", "Fumaça rumo a Manaus", "#6d4c41", true],
  ["lixoes", "Lixões e vazadouros (fumaça tóxica)", "#8e24aa", true],
  ["mudancas", "Alertas de mudança (Sentinel-2 + radar)", "#00b8d4", true],
  ["erbs", "ERBs de telefonia (Anatel)", "#5e35b1", true],
  ["sel", "Evento selecionado (anel amarelo)", "#ffdf00", true],
];
// grupos do menu de camadas (abrem e fecham; o primeiro começa aberto)
const GRUPOS_CAMADAS = [
  ["Fogo e desmatamento", ["eventos", "alertas", "focos", "calor", "mudancas", "riscoprev", "desmat", "cicat", "prodes"]],
  ["Áreas protegidas e fundiário", ["tis", "ucs", "aldeias", "assentamentos", "fpnd", "sigef"]],
  ["Meio ambiente", ["fauna", "flora", "bacias", "rios"]],
  ["Tempo e fumaça", ["vento", "fumaca", "chuva", "nuvens", "imerg"]],
  ["Pressão e infraestrutura", ["estradas", "mineracao", "pistas", "lixoes", "erbs", "bombeiros"]],
  ["Referência", ["mun", "sel"]],
];
async function iniciarMapa() {
  const m = Q.mapa = new maplibregl.Map({container: "mapa", center: [-62.5, -4.3], zoom: 5, maxZoom: 18, attributionControl: {compact: true},
    style: {version: 8, glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf", sources: {}, layers: [{id: "fundo", type: "background", paint: {"background-color": "#dfe5ee"}}]}});
  m.addControl(new maplibregl.NavigationControl(), "bottom-left");
  m.addControl(new maplibregl.ScaleControl({unit: "metric"}), "bottom-left");
  m.addControl(new maplibregl.FullscreenControl(), "bottom-left");
  // exame de local: mostra e acompanha a posição do aparelho (GPS)
  Q.geo = new maplibregl.GeolocateControl({positionOptions: {enableHighAccuracy: true, timeout: 20000}, trackUserLocation: true, showAccuracyCircle: true, fitBoundsOptions: {maxZoom: 15}});
  m.addControl(Q.geo, "bottom-left");
  Q.geo.on("error", err => toast(err.code === 1 ? "Permita o acesso à localização no navegador para o mapa seguir você." : "Não foi possível obter a sua localização."));
  Q.geo.on("geolocate", p => { const el = $("#btnAqui"); if (el) el.textContent = `📍 Seguindo você (±${Math.round(p.coords.accuracy)} m)`; maisPerto(p.coords); });
  await new Promise(r => m.on("load", r));
  for (const [k, b] of Object.entries(BASES)) if (b.tiles) m.addSource("base-" + k, {type: "raster", tiles: b.tiles, tileSize: 256, attribution: b.attr, maxzoom: b.max || 19});
  m.addLayer({id: "base", type: "raster", source: "base-satelite"});
  const vazio = {type: "FeatureCollection", features: []};
  const [mun, tis, ucs] = await Promise.all(["municipios", "tis", "ucs"].map(n => json(`dados/${n}.json`)));
  m.addSource("mun", {type: "geojson", data: mun}); m.addSource("tis", {type: "geojson", data: tis}); m.addSource("ucs", {type: "geojson", data: ucs});
  m.addSource("deter", {type: "geojson", data: vazio});
  ["eventos", "alertas", "focos", "sel", "area", "vento", "fumaca", "lixoes", "perto-lixao", "mudancas", "erbs", "brmais", "desm", "desm-res"].forEach(s => m.addSource(s, {type: "geojson", data: vazio}));
  m.addLayer({id: "tis", type: "fill", source: "tis", paint: {"fill-color": "#b8860b", "fill-opacity": .08, "fill-outline-color": "#b8860b"}});
  m.addLayer({id: "tis-l", type: "line", source: "tis", paint: {"line-color": "#d4a017", "line-width": 1.3, "line-dasharray": [3, 2]}});
  m.addLayer({id: "ucs", type: "fill", source: "ucs", paint: {"fill-color": "#0a7a36", "fill-opacity": .07}});
  m.addLayer({id: "ucs-l", type: "line", source: "ucs", paint: {"line-color": "#2fbf71", "line-width": 1.2, "line-dasharray": [1, 1.5]}});
  // tempo agora: nuvens (GOES-16 GeoColor, NASA GIBS) e radar de chuva (RainViewer)
  m.addSource("nuvens", {type: "raster", tileSize: 256, maxzoom: 7, attribution: "NASA GIBS · GOES-16",
    tiles: ["https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GOES-East_ABI_GeoColor/default/default/GoogleMapsCompatible_Level7/{z}/{y}/{x}.png"]});
  m.addLayer({id: "nuvens", type: "raster", source: "nuvens", layout: {visibility: "none"}, paint: {"raster-opacity": .6}});
  m.addSource("imerg", {type: "raster", tileSize: 256, maxzoom: 6, attribution: "NASA GPM IMERG · GIBS",
    tiles: ["https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/IMERG_Precipitation_Rate/default/default/GoogleMapsCompatible_Level6/{z}/{y}/{x}.png"]});
  m.addLayer({id: "imerg", type: "raster", source: "imerg", layout: {visibility: "none"}, paint: {"raster-opacity": .75}});
  atualizarChuva(); setInterval(atualizarChuva, 10 * 60e3);
  // biodiversidade (GBIF), bacias e rios (ANA, via /camadas para contornar CORS)
  const gbif = (k, estilo) => ({type: "raster", tileSize: 512, attribution: "GBIF.org",
    tiles: [`https://api.gbif.org/v2/map/occurrence/density/{z}/{x}/{y}@2x.png?style=${estilo}&taxonKey=${k}`]});
  m.addSource("fauna", gbif(1, "orangeHeat.point")); m.addSource("flora", gbif(6, "green.point"));
  const ana = s => ({type: "raster", tileSize: 256, attribution: "ANA/SNIRH",
    tiles: [`${location.origin}/camadas/ana/${s}?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857&size=256,256&format=png32&transparent=true&f=image`]});
  m.addSource("bacias", ana("DNAEE_Sub_Bacias")); m.addSource("rios", ana("Hidrografia"));

  m.addLayer({id: "mun", type: "line", source: "mun", paint: {"line-color": "#ffffff", "line-opacity": .55, "line-width": .7}});
  for (const k of ["bacias", "rios", "fauna", "flora"]) m.addLayer({id: k, type: "raster", source: k, layout: {visibility: "none"}, paint: {"raster-opacity": k === "bacias" ? .6 : .85}}, "mun");
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
  const corMud = ["match", ["get", "fonte"], "ambos", "#ffffff", "radar", "#00b8d4", "#ffd600"];
  m.addLayer({id: "mudancas", type: "fill", source: "mudancas", paint: {"fill-color": corMud, "fill-opacity": 0.35}});
  m.addLayer({id: "mudancas-l", type: "line", source: "mudancas", paint: {"line-color": corMud, "line-width": 1.6}});
  const corOp = ["match", ["get", "op"], "VIVO", "#7b1fa2", "TIM", "#1565c0", "CLARO", "#c62828", "#455a64"];
  m.addLayer({id: "erbs", type: "circle", source: "erbs", minzoom: 7, paint: {
    "circle-radius": ["interpolate", ["linear"], ["zoom"], 7, 2.5, 12, 6], "circle-color": "#fff", "circle-stroke-color": corOp, "circle-stroke-width": 2.2}});
  // PRODES (WMS do TerraBrasilis, com CORS)
  m.addSource("prodes", {type: "raster", tileSize: 256, attribution: "INPE PRODES · TerraBrasilis",
    tiles: ["https://terrabrasilis.dpi.inpe.br/geoserver/ows?service=WMS&version=1.1.1&request=GetMap&layers=prodes-legal-amz:yearly_deforestation&styles=&bbox={bbox-epsg-3857}&srs=EPSG:3857&width=256&height=256&format=image/png&transparent=true"]});
  m.addLayer({id: "prodes", type: "raster", source: "prodes", minzoom: 7, layout: {visibility: "none"}, paint: {"raster-opacity": .75}}, "eventos");
  // bases estáticas carregadas só quando ligadas
  for (const k of ["fpnd", "sigef", "aldeias", "mineracao", "pistas", "bombeiros"]) m.addSource(k, {type: "geojson", data: vazio});
  m.addLayer({id: "fpnd", type: "fill", source: "fpnd", layout: {visibility: "none"}, paint: {"fill-color": "#7cb342", "fill-opacity": .14}}, "eventos");
  m.addLayer({id: "fpnd-l", type: "line", source: "fpnd", layout: {visibility: "none"}, paint: {"line-color": "#9ccc65", "line-width": 1.2}}, "eventos");
  m.addLayer({id: "sigef", type: "line", source: "sigef", minzoom: 9, layout: {visibility: "none"}, paint: {"line-color": "#ffb300", "line-width": 1}}, "eventos");
  m.addLayer({id: "aldeias", type: "circle", source: "aldeias", layout: {visibility: "none"}, paint: {"circle-radius": ["interpolate", ["linear"], ["zoom"], 5, 2.5, 12, 6], "circle-color": "#6d4c41", "circle-stroke-color": "#fff", "circle-stroke-width": 1}});
  m.addLayer({id: "mineracao", type: "circle", source: "mineracao", layout: {visibility: "none"}, paint: {"circle-radius": ["interpolate", ["linear"], ["zoom"], 5, 1.5, 12, 6],
    "circle-color": ["match", ["get", "t"], "garimpo", "#d50000", "#78909c"], "circle-opacity": .8}});
  m.addLayer({id: "pistas", type: "circle", source: "pistas", layout: {visibility: "none"}, paint: {"circle-radius": 5, "circle-color": "#37474f", "circle-stroke-color": "#ffeb3b", "circle-stroke-width": 2}});
  m.addLayer({id: "bombeiros", type: "circle", source: "bombeiros", layout: {visibility: "none"}, paint: {"circle-radius": 6, "circle-color": "#e53935", "circle-stroke-color": "#fff", "circle-stroke-width": 2}});
  const popCamada = (id, f) => m.on("click", id, ev => { if (Q.modoPonto) return; new maplibregl.Popup({maxWidth: "300px"}).setLngLat(ev.lngLat).setHTML(f(ev.features[0].properties)).addTo(m); });
  popCamada("fpnd", p => `<b>${esc(p.nome)}</b><br>Floresta pública não destinada · ${esc(p.categoria)} (${esc(p.governo)})<br>${br(+p.area_ha, 0)} ha · ${esc(p.municipio)}<br><span class="nota">Serviço Florestal Brasileiro, CNFP 2025</span>`);
  popCamada("sigef", p => `<b>${esc(p.nome_area)}</b><br>SIGEF/INCRA · ${esc(p.status)} · ${esc(p.situacao_i)}<br>Código do imóvel ${esc(p.codigo_imo)}${p.registro_m && p.registro_m !== "None" ? ` · matrícula ${esc(p.registro_m)}` : ""}<br>Aprovado em ${esc(p.data_aprov)}<br>
    <a class="botao secundario pequeno" style="margin-top:6px" href="${sigefUrl(p.parcela_co)}" target="_blank" rel="noopener">Consultar detentor no SIGEF</a>`);
  popCamada("aldeias", p => `<b>Aldeia ${esc(p.nome)}</b><br>${esc(p.municipio)} · ${esc(p.cr)}<br><span class="nota">FUNAI</span>`);
  popCamada("mineracao", p => `<b>${p.t === "garimpo" ? "Garimpo" : "Mineração industrial"}</b><br>${br(+p.ha, 1)} ha na célula de ~500 m (2023)<br><span class="nota">MapBiomas Coleção 9, código ${esc(p.cod)}</span>`);
  popCamada("pistas", p => `<b>${esc(p.nome)}</b><br>${p.tipo === "airstrip" ? "Pista de pouso" : "Aeródromo"}${p.icao ? " · " + esc(p.icao) : ""}${p.superficie ? " · " + esc(p.superficie) : ""}<br><span class="nota">OpenStreetMap (incompleto)</span>`);
  popCamada("bombeiros", p => `<b>${esc(p.nome)}</b><br>${esc(p.operador || "")}<br><span class="nota">OpenStreetMap (incompleto)</span>`);
  // assentamentos (INCRA) e estradas (OSM): carregados só quando ligados
  m.addSource("assentamentos", {type: "geojson", data: vazio}); m.addSource("estradas", {type: "geojson", data: vazio});
  m.addLayer({id: "assentamentos", type: "fill", source: "assentamentos", layout: {visibility: "none"}, paint: {"fill-color": "#a1887f", "fill-opacity": .18}}, "eventos");
  m.addLayer({id: "assentamentos-l", type: "line", source: "assentamentos", layout: {visibility: "none"}, paint: {"line-color": "#d7ccc8", "line-width": 1.4, "line-dasharray": [2, 1]}}, "eventos");
  m.addLayer({id: "estradas", type: "line", source: "estradas", layout: {visibility: "none", "line-cap": "round"}, paint: {
    "line-color": ["match", ["get", "t"], "rodovia federal", "#ff3d00", "rodovia", "#ff3d00", "rodovia estadual", "#ff7043", "ramal", "#ffcc80", "#ffab91"],
    "line-width": ["interpolate", ["linear"], ["zoom"], 6, ["match", ["get", "t"], "ramal", .5, 1.2], 13, ["match", ["get", "t"], "ramal", 1.5, 3]]}}, "eventos");
  m.on("click", "assentamentos", ev => { if (Q.modoPonto) return; const p = ev.features[0].properties;
    new maplibregl.Popup().setLngLat(ev.lngLat).setHTML(`<b>${esc(p.nome_proje)}</b><br>Assentamento do INCRA · ${esc(p.municipio)}<br>${p.num_famili ?? "–"} famílias · ${br(+p.area_calc_, 0)} ha · fase ${esc(p.fase)}<br>Criado em ${esc(p.data_de_cr)} · código ${esc(p.cd_sipra)}`).addTo(m); });
  m.on("click", "estradas", ev => { if (Q.modoPonto) return; const p = ev.features[0].properties;
    new maplibregl.Popup().setLngLat(ev.lngLat).setHTML(`<b>${esc(p.n || "Via sem nome")}</b><br>${esc(p.t)} · OpenStreetMap (base colaborativa, incompleta)`).addTo(m); });
  m.addLayer({id: "lixoes", type: "circle", source: "lixoes", paint: {"circle-radius": ["interpolate", ["linear"], ["zoom"], 5, 5, 12, 9],
    "circle-color": "#8e24aa", "circle-stroke-color": "#fff", "circle-stroke-width": 1.5}});
  m.addLayer({id: "lixoes-anel", type: "circle", source: "perto-lixao", paint: {"circle-radius": 16, "circle-color": "rgba(0,0,0,0)",
    "circle-stroke-color": "#ba68c8", "circle-stroke-width": 3, "circle-stroke-opacity": 0.9}});
  m.addLayer({id: "vento", type: "line", source: "vento", layout: {"line-cap": "round"},
    paint: {"line-width": 1.6, "line-color": ["interpolate", ["linear"], ["get", "v"], 0, "#90caf9", 10, "#1e88e5", 20, "#3949ab", 35, "#b71c1c"]}});
  for (const k of Object.keys(BRM_COR)) if (!m.hasImage("brm-" + k)) m.addImage("brm-" + k, iconeForma(BRM_FORMA[k], BRM_COR[k], BRM_BORDA[k]), {pixelRatio: 2});
  const simb = (img, tam, extra = {}) => ({visibility: "none", "icon-image": img, "icon-size": tam, "icon-allow-overlap": true, "icon-ignore-placement": true, ...extra});
  m.addLayer({id: "brmais", type: "symbol", source: "brmais", layout: simb(["match", ["get", "t"], "C", "brm-C", "F", "brm-F", "brm-I"],
    ["interpolate", ["linear"], ["zoom"], 5, .45, 12, 1], {"symbol-sort-key": ["match", ["get", "t"], "I", 3, "F", 2, 1]})});
  m.addLayer({id: "desm-res", type: "symbol", source: "desm-res", maxzoom: 9, layout: simb(["match", ["get", "g"], "G", "brm-G", "brm-D"],
    ["interpolate", ["linear"], ["get", "n"], 1, .35, 20, .6, 200, 1.1]), paint: {"icon-opacity": .8}}, "brmais");
  m.addLayer({id: "desm", type: "symbol", source: "desm", minzoom: 9, layout: simb(["match", ["get", "t"], "G", "brm-G", "brm-D"],
    ["interpolate", ["linear"], ["zoom"], 9, .5, 14, 1])}, "brmais");
  m.on("click", "desm", ev => { if (Q.modoPonto) return; const p = ev.features[0].properties, a = DESM.porId.get(String(p.id));
    if (a) new maplibregl.Popup({maxWidth: "300px"}).setLngLat(ev.lngLat).setHTML(popupDesm(a)).addTo(m); });
  m.on("click", "desm-res", ev => { if (Q.modoPonto) return; const p = ev.features[0].properties;
    new maplibregl.Popup().setLngLat(ev.lngLat).setHTML(`<b>Brasil MAIS · ${p.g === "G" ? "garimpo" : "desmatamento"}</b><br>${p.n} alerta(s) em ${p.y}, ${br(p.ha, 1)} ha nesta área<br><span class="nota">Aproxime o mapa para ver cada alerta. Dado restrito.</span>`).addTo(m); });
  m.on("moveend", () => carregarCelulasVisiveis());
  m.on("click", "brmais", ev => { if (Q.modoPonto) return; const a = BRM.porId.get(String(ev.features[0].properties.id));
    if (a) new maplibregl.Popup({maxWidth: "300px"}).setLngLat(ev.lngLat).setHTML(popupBrmais(a)).addTo(m); });
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
// ------------------------------------------------------------ coordenadas digitadas
// Aceita decimal ("-3.347, -59.446", "-3,347 -59,446") e graus/minutos/segundos ("3°20'49,3\"S 59°26'44,9\"W", "3 20 49 S 59 26 44 W").
function lerCoord(txt) {
  const t = String(txt || "").trim().toUpperCase().replace(/[″”“]/g, '"').replace(/[′’‘]/g, "'").replace(/º/g, "°");
  const gms = [...t.matchAll(/(\d+(?:[.,]\d+)?)\s*°?\s*(?:(\d+(?:[.,]\d+)?)\s*'?\s*)?(?:(\d+(?:[.,]\d+)?)\s*(?:"|'')?\s*)?([NSLEOW])/g)];
  let lat, lon;
  if (gms.length >= 2) {
    const v = m => { const n = s => s ? +s.replace(",", ".") : 0, x = n(m[1]) + n(m[2]) / 60 + n(m[3]) / 3600; return /[SOW]/.test(m[4]) ? -x : x; };
    for (const m of gms) (/[NS]/.test(m[4]) ? (lat = v(m)) : (lon = v(m)));
  } else {
    const nums = t.replace(/;|,\s+/g, " ").replace(/,/g, ".").match(/-?\d+(?:\.\d+)?/g);
    if (!nums || nums.length < 2) return null;
    [lat, lon] = nums.slice(0, 2).map(Number);
    if (Math.abs(lat) > 30 && Math.abs(lon) <= 30) [lat, lon] = [lon, lat];   // digitou longitude primeiro
    if (lon > 0 && lon >= 55 && lon <= 75) lon = -lon;                        // esqueceu o sinal (oeste)
    if (lat > 2.5 && lat <= 12) lat = -lat;                                   // esqueceu o sinal (sul): o AM vai de +2,3 a −9,9
  }
  return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? {lat: +lat.toFixed(6), lon: +lon.toFixed(6)} : null;
}
window.lerCoord = lerCoord;
const gmsTxt = (v, p, n) => { const a = Math.abs(v), g = Math.floor(a), m = Math.floor((a - g) * 60), s = ((a - g) * 60 - m) * 60;
  return `${g}°${m}'${s.toFixed(1).replace(".", ",")}"${v < 0 ? n : p}`; };
function irPara(c) {
  const m = Q.mapa, foraAM = c.lat > 2.5 || c.lat < -10.5 || c.lon < -74.5 || c.lon > -56;
  Q.marcaPonto?.remove();
  const hoje = new Date().toLocaleDateString("sv-SE", {timeZone: "America/Manaus"});
  const pop = new maplibregl.Popup({offset: 24, maxWidth: "300px"}).setHTML(`<b>Ponto informado</b><br><span class="mono">${c.lat.toFixed(5)}, ${c.lon.toFixed(5)}</span><br>
    <span class="mono">${gmsTxt(c.lat, "N", "S")} ${gmsTxt(c.lon, "E", "W")}</span>${foraAM ? `<br><b style="color:var(--vermelho)">Atenção: fora do Amazonas. Confira os sinais e a ordem (latitude, longitude).</b>` : ""}
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px"><button type="button" class="botao pequeno" id="pAnalisar">Analisar satélite aqui</button>
    <button type="button" class="botao secundario pequeno" id="pRelatorio">Relatório deste ponto</button></div>`);
  Q.marcaPonto = new maplibregl.Marker({color: "#ffdf00"}).setLngLat([c.lon, c.lat]).setPopup(pop).addTo(m);
  m.flyTo({center: [c.lon, c.lat], zoom: Math.max(m.getZoom(), 14), speed: 1.6});
  pop.on("open", () => {
    $("#pAnalisar").onclick = () => { window.abrirAnalise?.({lat: c.lat, lon: c.lon, raio: +$("#raioPonto").value}); setTimeout(() => $("#aRodar")?.click(), 300); };
    $("#pRelatorio").onclick = () => window.open(`relatorio.html?lat=${c.lat}&lon=${c.lon}&data=${hoje}&raio=${$("#raioPonto").value}`, "_blank");
  });
  Q.marcaPonto.togglePopup();
  maisPerto({latitude: c.lat, longitude: c.lon}, true);
}

// no exame de local: avisa qual evento está mais perto da posição do aparelho (uma vez por ativação)
let avisouPerto = false;
function maisPerto(c, sempre) {
  if (avisouPerto && !sempre) return; if (!sempre) avisouPerto = true; setTimeout(() => avisouPerto = false, 10 * 60e3);
  const l = (Q.filtrados.length ? Q.filtrados : Q.eventos).map(e => ({e, km: Math.hypot(e.lat - c.latitude, (e.lon - c.longitude) * Math.cos(c.latitude * Math.PI / 180)) * 111}))
    .sort((a, b) => a.km - b.km);
  if (l[0]) toast(`Evento mais perto de você: ${l[0].e.mun}, ${dBR(l[0].e.ini)}, a ${br(l[0].km, 1)} km (prioridade ${l[0].e.score}). Clique no círculo para abrir a ficha.`.replace("perto de você", sempre ? "perto do ponto" : "perto de você"), 9000);
}
function montarControles() {
  const el = $("#mapaCtl");
  el.innerHTML = `<button type="button" class="recolher" id="ctlRec" aria-expanded="true"><b>☰ Camadas do mapa</b><span>ocultar</span></button><div id="ctlCorpo">
    <p class="ctl-dica">Marque ou desmarque para <b>ligar ou desligar</b> cada camada.</p>
    <div class="ctl-acoes"><button type="button" class="botao pequeno" id="btnAqui" style="flex:1" title="Exame de local: centraliza o mapa na sua posição e acompanha enquanto você se desloca">📍 Onde estou</button>
      <button type="button" class="botao fogo pequeno" id="btnAnalisarAqui" style="flex:1" title="Pega a posição do GPS e já roda a análise de satélite do local">🛰️ Analisar onde estou</button></div>
    <label class="raio-ponto">Raio da análise <select id="raioPonto"><option>300</option><option selected>600</option><option>1000</option><option>2000</option><option>3000</option></select> m</label>
    <div class="ctl-acoes"><button type="button" class="botao secundario pequeno" id="desCirc" style="flex:1" title="Clique no centro e arraste até a borda">⭕ Desenhar círculo</button>
      <button type="button" class="botao secundario pequeno" id="desLivre" style="flex:1" title="Pressione e contorne a área; solte para fechar">✏️ Mão livre</button></div>
    <div id="areaSel" class="area-sel" hidden></div>
    <form id="irCoord" class="ir-coord" autocomplete="off"><input id="irTxt" type="text" inputmode="text" placeholder="Coordenadas: -3.347, -59.446" aria-label="Ir para coordenadas (decimal ou graus, minutos e segundos)"><button type="submit" class="botao secundario pequeno">Ir</button></form>
    <p class="nota" style="margin:2px 0 8px;font-size:11px">Decimal ou graus/minutos/segundos, ex.: 3°20'49"S 59°26'44"W</p>
    <div class="ctl-acoes"><button type="button" class="botao secundario pequeno" id="ctlNenhuma">Desmarcar todas</button><button type="button" class="botao secundario pequeno" id="ctlPadrao">Voltar ao padrão</button></div>
    <h4>Mapa de fundo</h4>${Object.entries(BASES).filter(([, b]) => !b.grupo).map(([k, b]) => `<label><input type="radio" name="base" value="${k}" ${k === "satelite" ? "checked" : ""}> ${b.nome}</label>`).join("")}
    <h4>Imagens de satélite recentes</h4>${Object.entries(BASES).filter(([, b]) => b.grupo).map(([k, b]) => `<label><input type="radio" name="base" value="${k}"> ${b.nome}</label>`).join("")}
    ${GRUPOS_CAMADAS.map(([titulo, ks], i) => `<details class="ctl-grupo"${i === 0 ? " open" : ""}><summary>${titulo}</summary>${CAMADAS.filter(c => ks.includes(c[0])).map(([k, t, c, on]) =>
      `<label><input type="checkbox" data-c="${k}" ${on ? "checked" : ""}><span class="sw" style="background:${c}"></span>${t}</label>`).join("")}</details>`).join("")}
    <div id="riscoCtl" hidden><h4>Risco previsto (INPE)</h4><select id="riscoDia" style="width:100%"></select><div class="nota" id="riscoInfo"></div>
      <div class="nota" style="font-size:11px"><i style="display:inline-block;width:10px;height:10px;background:#66bb6a"></i> baixo · <i style="display:inline-block;width:10px;height:10px;background:#ffd54f"></i> médio · <i style="display:inline-block;width:10px;height:10px;background:#f57c00"></i> alto · <i style="display:inline-block;width:10px;height:10px;background:#b71c1c"></i> crítico</div></div>
    <div id="ventoCtl"><h4>Hora do vento</h4><input type="range" id="ventoSl" min="0" max="47" value="0" style="width:100%"><div class="nota" id="ventoHora"></div></div></div>`;
  el.addEventListener("change", e => {
    if (e.target.name === "base") return trocarBase(e.target.value);
    if (e.target.dataset.b) { BRM.vis[e.target.dataset.b] = e.target.checked; return filtrarBrmais(); }
    if (e.target.id === "brmAno") { BRM.ano = e.target.value; return filtrarBrmais(); }
    const k = e.target.dataset.c; if (!k) return;
    const ids = {tis: ["tis", "tis-l"], ucs: ["ucs", "ucs-l"], sel: ["sel", "area"], assentamentos: ["assentamentos", "assentamentos-l"], fpnd: ["fpnd", "fpnd-l"]}[k] || [k];
    if (e.target.checked) sobDemanda(k);
    if (k === "riscoprev") $("#riscoCtl").hidden = !e.target.checked;
    ids.forEach(id => Q.mapa.getLayer(id) && Q.mapa.setLayoutProperty(id, "visibility", e.target.checked ? "visible" : "none"));
    if (k === "mudancas") Q.mapa.setLayoutProperty("mudancas-l", "visibility", e.target.checked ? "visible" : "none");
    if (k === "lixoes") Q.mapa.setLayoutProperty("lixoes-anel", "visibility", e.target.checked ? "visible" : "none");
    if (k === "vento") { $("#ventoCtl").hidden = !e.target.checked; const sl = $("#ventoSl");
      if (Q.vento) { sl.max = Q.vento.horas_utc.length - 1; sl.value = Q.ventoHora || 0; } desenharVento(); }
  });
  const marcar = padrao => $$("#ctlCorpo input[type=checkbox]").forEach(c => {
    const k = c.dataset.c, v = padrao && k ? CAMADAS.find(x => x[0] === k)?.[3] ?? false : false;   // Brasil MAIS (data-b) fica desligado no padrão
    if (c.checked !== v) { c.checked = v; c.dispatchEvent(new Event("change", {bubbles: true})); } });
  $("#ctlNenhuma").onclick = () => marcar(false);
  $("#btnAnalisarAqui").onclick = () => {
    if (!navigator.geolocation) return toast("Este aparelho não informa a localização.");
    const bt = $("#btnAnalisarAqui"); bt.disabled = true; bt.textContent = "🛰️ Localizando…";
    navigator.geolocation.getCurrentPosition(p => {
      bt.disabled = false; bt.textContent = "🛰️ Analisar onde estou";
      toast(`Analisando a sua posição (±${Math.round(p.coords.accuracy)} m). Ao terminar, use "Relatório completo (PDF)" no fim da página.`, 7000);
      window.abrirAnalise?.({lat: p.coords.latitude, lon: p.coords.longitude, raio: +$("#raioPonto").value}); setTimeout(() => $("#aRodar")?.click(), 300);
    }, err => { bt.disabled = false; bt.textContent = "🛰️ Analisar onde estou";
      toast(err.code === 1 ? "Permita o acesso à localização no navegador para usar este botão." : "Não foi possível obter a localização."); },
    {enableHighAccuracy: true, timeout: 20000, maximumAge: 30000});
  };
  $("#desCirc").onclick = () => iniciarDesenho("circulo");
  $("#desLivre").onclick = () => iniciarDesenho("livre");
  $("#irCoord").onsubmit = ev => { ev.preventDefault(); const c = lerCoord($("#irTxt").value);
    if (!c) return toast("Não entendi as coordenadas. Exemplos: -3.347, -59.446  ou  3°20'49\"S 59°26'44\"W"); irPara(c); };
  $("#btnAqui").onclick = () => { $("#btnAqui").textContent = "📍 Localizando…"; Q.geo?.trigger(); };
  $("#ctlPadrao").onclick = () => marcar(true);
  el.addEventListener("input", e => { if (e.target.id === "ventoSl") { Q.ventoHora = +e.target.value; desenharVento(); } });
  $("#ctlRec").onclick = () => { const c = $("#ctlCorpo"); c.hidden = !c.hidden; $("#ctlRec span").textContent = c.hidden ? "mostrar" : "ocultar"; $("#ctlRec").setAttribute("aria-expanded", !c.hidden); };
  if (matchMedia("(max-width:640px)").matches) $("#ctlRec").click();
  $("#legenda").innerHTML = `<button type="button" class="recolher" id="legRec" aria-expanded="true"><b>Legenda</b><span>ocultar</span></button><div id="legCorpo">` + `<div class="nota" style="font-size:11px;margin-bottom:4px"><b>Pela forma:</b> ● evento · ○ alerta de agora · ▭ área de mudança${Q.usuario ? " · ◆ ■ Brasil MAIS" : ""}</div><b style="font-size:12px">Prioridade de verificação (círculos cheios)</b>` + [["--s4", "Muito alta (85+)"], ["--s3", "Alta (70–84)"], ["--s2", "Atenção (50–69)"], ["--s1", "Baixa (0–49)"]].map(([c, t]) => `<div><i style="background:var(${c})"></i>${t}</div>`).join("")
    + `<div><i style="background:transparent;border:2px solid #ff7a00"></i>Alerta de agora (VIIRS)</div><div><i style="background:#8e24aa"></i>Lixão/vazadouro</div><div><i style="background:#fff;border:2px solid #5e35b1"></i>ERB (zoom 7+): <span style="color:#7b1fa2">Vivo</span> · <span style="color:#1565c0">TIM</span> · <span style="color:#c62828">Claro</span></div><div><b style="font-size:11px">Alerta de mudança (áreas):</b></div><div><i style="background:#ffd600;border-radius:2px"></i>Óptico · <i style="background:#00b8d4;border-radius:2px;margin-left:4px"></i>Radar · <i style="background:#fff;border:1px solid #777;border-radius:2px;margin-left:4px"></i>Ambos</div><div><i style="background:transparent;border:2px solid #ba68c8"></i>Fogo a até 1 km de lixão</div><div class="nota" style="font-size:11px">Tamanho = quantidade de focos</div>` + `</div>`;
  $("#legRec").onclick = () => { const c = $("#legCorpo"); c.hidden = !c.hidden; $("#legRec span").textContent = c.hidden ? "mostrar" : "ocultar"; $("#legRec").setAttribute("aria-expanded", !c.hidden); };
  if (matchMedia("(max-width:640px)").matches) $("#legRec").click();
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
      <td class="n">${fmt(e.dist)}</td><td>${esc(e.det.ti || e.det.uc || "")}</td><td>${e.ind.map(k => `<span class="selo" title="${indTxt(k)}">${indTxt(k).split(" ")[0]}</span>`).join(" ")}</td>
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
      <td>${e.ind.map(k => `<span class="selo">${indTxt(k).split(" ")[0]}</span>`).join(" ")}</td><td class="n">${e.lat.toFixed(4)}, ${e.lon.toFixed(4)}</td></tr>`).join("") + "</tbody>";
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
  barras("#gInd", Q.ind.map(k => [indTxt(k), f.filter(e => e.ind.includes(k)).length]).sort((a, b) => b[1] - a[1]), css("--azul"), true);
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
      ${Object.keys(P).map(k => `<tr><td>${(D[k] || [indTxt(k)])[0]}</td><td class="nota">${(D[k] || ["", ""])[1]}</td><td class="n">${P[k]}</td></tr>`).join("")}</tbody></table>
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
    <div class="cartao"><h2>4. Detecção de quebra na vegetação</h2>
      <div class="formula">base = mediana(NDVI da linha de base) · σ robusto = 1,4826 × mediana dos desvios absolutos (MAD)<br>limiar = base − 3σ robusto, limitado entre 0,15 e 0,30<br>quebra confirmada = 1ª de ≥ 6 observações seguidas abaixo do limiar<br>queda no fim da série com menos de 6 = mudança provável<br>data ∈ (última acima ; primeira abaixo]</div>
      <p>O limiar de três desvios (em escala robusta: 1,4826 × MAD, Leys et al., 2013, que não se deixa inflar por queimadas e desmatamentos antigos na linha de base; a queda exigida fica entre 0,15 e 0,30 de NDVI) e a confirmação por 6 observações consecutivas seguem o CCDC — <i>Continuous Change Detection and Classification</i> (Zhu &amp; Woodcock, 2014a; Arévalo et al., 2020): uma queda só é tratada como mudança quando persiste, o que evita confundir quedas passageiras da estação chuvosa com perda de vegetação. A queda mínima de 0,15 no NDVI evita alarmes por pequenas oscilações em floresta densa. É uma versão descritiva do critério, não o CCDC completo com modelo harmônico. A cena de cada mês precisa ter ao menos 80% da área analisada limpa e, entre essas, fica a de menor nuvem na cena. Na linha de base, o teste Tmask (Zhu &amp; Woodcock, 2014b) remove observações com névoa ou sombra que escaparam da máscara (verde acima da mediana + 0,04 ou SWIR1 abaixo da mediana − 0,04). O offset do Sentinel-2 vai pela versão de processamento da cena, e o Landsat entra só como Tier 1.</p>
      <p class="nota"><b>Referências.</b> Rouse, J. W. et al. (1974) <i>Monitoring vegetation systems in the Great Plains with ERTS</i>. NASA SP-351. · Tucker, C. J. (1979) Red and photographic infrared linear combinations for monitoring vegetation. <i>Remote Sensing of Environment</i> 8:127–150. · Key, C. H. &amp; Benson, N. C. (2006) Landscape Assessment: ground measure of severity, the Composite Burn Index; and remote sensing of severity, the Normalized Burn Ratio. FIREMON, USDA Forest Service RMRS-GTR-164-CD. · Zhu, Z. &amp; Woodcock, C. E. (2014a) Continuous change detection and classification of land cover using all available Landsat data. <i>Remote Sensing of Environment</i> 144:152–171. · Zhu, Z. &amp; Woodcock, C. E. (2014b) Automated cloud, cloud shadow, and snow detection in multitemporal Landsat data. <i>Remote Sensing of Environment</i> 152:217–234. · Arévalo, P. et al. (2020) A suite of tools for continuous land change monitoring in Google Earth Engine. <i>Frontiers in Climate</i> 2:576740.</p></div>
    <div class="cartao"><h2>5. Inteligência artificial</h2>
      <p><b>Onde há IA.</b> <b>Isolation Forest</b> (aprendizado de máquina não supervisionado) aprende o padrão dos eventos do Amazonas (focos, duração, simultaneidade, desmatamento, reincidência, área protegida, distância e, do MapBiomas, floresta, conversão e fogo histórico) e dá a cada evento uma nota de <b>atipicidade</b> de 0 a 100, mostrada ao lado da prioridade sem alterá-la. O <b>parecer técnico preliminar</b> é redigido por um modelo de linguagem (Google Gemini) a partir dos números já calculados: não acrescenta fatos, não atribui autoria, apresenta as hipóteses sem pesos, cita a literatura e declara as limitações; exige revisão de perito. O <b>foco de queimada por IA</b> é um produto do Brasil MAIS (Polícia Federal), tratado aqui como hipótese espacial do local de início.</p>
      <p><b>Onde não há IA.</b> O agrupamento dos focos em eventos (<b>DBSCAN</b>, algoritmo de densidade), a prioridade de verificação (indicadores explícitos), o NDVI, a quebra e o dNBR (métodos publicados), a matriz de hipóteses e a consulta às bases seguem regras fixas e reproduzíveis. Os alertas do Brasil MAIS e os dados de usuários não são enviados ao modelo de linguagem.</p>
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
    <div class="cartao"><h2>8. Território, horário e fumaça</h2>
      <p>Para cada evento, o motor lê só o recorte em volta do centro, direto dos arquivos públicos:</p>
      <div class="formula">MapBiomas Coleção 10 (30 m), círculo de 500 m: fração de cada uso no ano anterior ao fogo e 5 anos antes<br>
      conversão florestal (+15) = floresta antes ≥ 50% e queda ≥ 20 pontos e uso antrópico depois ≥ 20%<br>
      MapBiomas Fogo Coleção 5: anos com queima desde 1985; reincidência se ≥ 10% da área queimou em 3+ anos<br>
      Copernicus DEM (30 m), círculo de 300 m: altitude e declividade (média e percentil 90)<br>
      GOES-16/19 (10 min, pixel ~2 km): 1ª detecção a até 4 km, de 48 h antes do 1º foco ao último foco<br>
      Copernicus CAMS: PM2,5 médio diário no local e em Manaus nos dias do evento, comparado à OMS (15 µg/m³)<br>
      OpenStreetMap: distância até a via mais próxima (rodovia, vicinal ou ramal), busca até 30 km<br>
      INCRA: dentro de assentamento · ANA: sub-bacia hidrográfica · GBIF: espécies a até 10 km e as ameaçadas (IUCN CR, EN, VU)<br>
      APP de margem estimada: água do MapBiomas (até 600 m); largura = diâmetro do maior círculo inscrito no corpo d'água; faixa pelo art. 4º, I, da Lei 12.651/2012 (30, 50, 100, 200 ou 500 m)</div>
      <p class="nota">Na matriz: conversão e fogo recorrente apoiam a ignição intencional; uso agropecuário consolidado é compatível com queima de manejo; floresta sem queima desde 1985 e declividade alta orientam a perícia; o GOES estreita o horário, sem marcar a ignição. A fumaça mede o impacto e não entra na hipótese. Os eventos novos recebem o território aos poucos, a cada ciclo.</p></div>
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
    ["Desmatamento anual", "INPE — PRODES (TerraBrasilis)", "https://terrabrasilis.dpi.inpe.br/", "anual", "anual", "camada e histórico a até 1 km"],
    ["Florestas públicas não destinadas", "Serviço Florestal Brasileiro — CNFP 2025", "https://www.gov.br/florestal/pt-br/assuntos/cadastro-nacional-de-florestas-publicas", "326 glebas no AM", "anual", "indicador de prioridade (+15)"],
    ["Imóveis certificados", "INCRA — SIGEF", "https://sigef.incra.gov.br/", "9.212 no AM", "mensal", "mapa, ficha e relatório"],
    ["Aldeias", "FUNAI — aldeias", "https://www.gov.br/funai/", "1.137 no AM", "anual", "comunidades a até 10 km"],
    ["Garimpo e mineração", "MapBiomas Coleção 9 — mineração (2023)", "https://brasil.mapbiomas.org/", "células de ~500 m", "anual", "garimpo a até 3 km"],
    ["Pistas de pouso e bombeiros", "OpenStreetMap (colaborativo)", "https://www.openstreetmap.org/", "70 e 11 no AM", "manual", "base incompleta"],
    ["Fauna e flora", "GBIF — ocorrências de espécies", "https://www.gbif.org/", "registros", "contínua", "mapa e espécies (e ameaçadas IUCN) a até 10 km"],
    ["Bacias e rios", "ANA/SNIRH — sub-bacias DNAEE e hidrografia", "https://www.snirh.gov.br/", "1:1.000.000", "estático", "camadas do mapa e sub-bacia do evento"],
    ["Assentamentos", "INCRA — Acervo Fundiário", "https://certificacao.incra.gov.br/", "132 no AM", "mensal", "mapa, ficha e relatório"],
    ["Estradas e ramais", "OpenStreetMap (colaborativo)", "https://www.openstreetmap.org/", "14 mil trechos", "semanal", "distância do fogo à via mais próxima"],
    ["Risco de fogo previsto", "INPE — Programa Queimadas", "https://terrabrasilis.dpi.inpe.br/queimadas/", "1 km", "6 h", "hoje e até 3 dias à frente"],
    ["Uso e cobertura da terra", "MapBiomas Coleção 10 (Souza et al., 2020)", "https://brasil.mapbiomas.org/", "30 m, 1985–2024", "anual", "500 m em volta de cada evento: conversão de floresta"],
    ["Fogo histórico", "MapBiomas Fogo Coleção 5", "https://brasil.mapbiomas.org/monitor-do-fogo/", "30 m, 1985–2025", "anual", "frequência e último ano de queima"],
    ["Relevo", "Copernicus DEM GLO-30 (ESA)", "https://registry.opendata.aws/copernicus-dem/", "30 m", "estático", "altitude e declividade"],
    ["Fogo geoestacionário", "GOES-16/19 (NOAA), via INPE", "https://terrabrasilis.dpi.inpe.br/queimadas/", "2 km", "10 min", "hora da 1ª detecção"],
    ["Fumaça e PM2,5", "Copernicus CAMS, via Open-Meteo", "https://open-meteo.com/en/docs/air-quality-api", "~40 km", "horária", "no local e em Manaus, desde ago/2022"],
    ["Chuva por satélite", "NASA GPM IMERG, via GIBS", "https://gpm.nasa.gov/data/imerg", "~10 km", "30 min", "camada do mapa"],
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
  try { await carregar(true); } catch (e) {   // mesmo com falha nos dados, o topo mostra a conta (sair, administração)
    $("#aoVivoTxt").textContent = "Falha ao carregar os dados"; $("#aoVivo").classList.add("atrasado"); console.error(e);
    toast("Não foi possível carregar os dados do painel. Recarregue a página; se persistir, avise a administração.", 10000);
    iniciarConta(); return;
  }
  try { await iniciarMapa(); } catch (e) { console.error(e); toast("O mapa não carregou. Recarregue a página.", 8000); }
  iniciarConta();
  const h = location.hash.slice(1); if (h && document.querySelector(`[data-aba="${h}"]`)) trocarAba(h);
  if (Q.filtrados[0]) selecionar(Q.filtrados[0].id, false);
})();

// ------------------------------------------------------------ área restrita (login) e alertas Brasil MAIS
// Os alertas do Brasil MAIS são de convênio: ficam no armazenamento privado e só chegam a usuários aprovados.
const BRM = {meta: null, lista: [], porId: new Map(), vis: {C: false, F: false, I: false, D: false, G: false}, ano: ""};   // desligado por padrão: polui o mapa
// cores fora da escala de prioridade (amarelo → vinho) e formas próprias: losango = fogo, quadrado = desmatamento
const BRM_COR = {C: "#b388ff", F: "#ff00d4", I: "#ffffff", D: "#76ff03", G: "#00e5ff"};
const BRM_FORMA = {C: "losango", F: "losango", I: "losango", D: "quadrado", G: "quadrado"};
const BRM_BORDA = {C: "#311b92", F: "#4a0040", I: "#ff00d4", D: "#1b5e20", G: "#004d61"};
// ícone desenhado em canvas (losango ou quadrado), para a camada de símbolos
function iconeForma(forma, cor, borda, lado = 44) {
  const c = document.createElement("canvas"); c.width = c.height = lado; const x = c.getContext("2d"), m = lado / 2, b = forma === "losango" ? 5 : 7;
  x.beginPath();
  if (forma === "losango") { x.moveTo(m, 3); x.lineTo(lado - 3, m); x.lineTo(m, lado - 3); x.lineTo(3, m); } else x.rect(b, b, lado - 2 * b, lado - 2 * b);
  x.closePath(); x.fillStyle = cor; x.fill(); x.lineWidth = forma === "losango" && cor === "#ffffff" ? 7 : 4; x.strokeStyle = borda; x.stroke();
  return x.getImageData(0, 0, lado, lado);
}
// a mesma forma em SVG, para a legenda e o menu de camadas
const svgForma = (k, t = 14) => BRM_FORMA[k] === "losango"
  ? `<svg width="${t}" height="${t}" viewBox="0 0 22 22" style="vertical-align:-2px;margin-right:4px;flex:none"><path d="M11 1.5 20.5 11 11 20.5 1.5 11Z" fill="${BRM_COR[k]}" stroke="${BRM_BORDA[k]}" stroke-width="${k === "I" ? 3.5 : 2}"/></svg>`
  : `<svg width="${t}" height="${t}" viewBox="0 0 22 22" style="vertical-align:-2px;margin-right:4px;flex:none"><rect x="3.5" y="3.5" width="15" height="15" fill="${BRM_COR[k]}" stroke="${BRM_BORDA[k]}" stroke-width="2"/></svg>`;
const DESM = {meta: null, celulas: new Set(), cel: new Map(), carregando: new Map(), porId: new Map()};
const DESM_TIPOS_D = ["R", "D", "A", "S", "Q"];
const BRM_RAIO_KM = 5, BRM_DIAS_ANTES = 30, BRM_DIAS_DEPOIS = 60;
async function iniciarConta() {
  let u = null;
  try { const r = await fetch("api/conta?acao=eu", {credentials: "same-origin"}); if (r.ok) u = (await r.json()).usuario; } catch (e) {}
  Q.usuario = u;
  if (!u) return;
  $("#conta").innerHTML = `<span class="quem" title="${esc(u.email)}">${esc(u.nome.split(" ")[0])}</span>
    ${u.papel === "admin" ? `<a class="botao claro pequeno" href="admin.html">Administração</a>` : ""}
    <button type="button" class="botao claro pequeno" id="btnSenha" title="Trocar a sua senha"><span class="txt-longo">Trocar senha</span><span class="txt-curto">Senha</span></button>
    <button type="button" class="botao claro pequeno" id="btnSair">Sair</button>`;
  $("#btnSair").onclick = async () => { await fetch("api/conta?acao=sair", {method: "POST", credentials: "same-origin"}); location.reload(); };
  $("#btnSenha").onclick = () => { const d = $("#dlgTroca"); d.querySelector("form").reset(); $("#trMsg").textContent = ""; d.showModal(); };
  carregarBrmais();
}
async function restrito(qual) {
  const r = await fetch("api/restrito?dados=" + qual, {credentials: "same-origin"});
  if (!r.ok) throw new Error("restrito " + r.status);
  return r.json();
}
async function carregarBrmais() {
  try {
    BRM.meta = await restrito("brmais_indice");
    const anos = await Promise.all(Object.keys(BRM.meta.anos).map(a => restrito("brmais_" + a).catch(() => null)));
    BRM.lista = anos.filter(Boolean).flatMap(a => a.alertas);
    DESM.meta = await restrito("desm_resumo").catch(() => null);
  } catch (e) { console.error(e); return; }
  if (DESM.meta) {
    DESM.celulas = new Set(DESM.meta.celulas);
    m0().getSource("desm-res").setData({type: "FeatureCollection", features: DESM.meta.resumo.map(([la, lo, y, g, n, ha]) =>
      ({type: "Feature", properties: {y, g, n, ha}, geometry: {type: "Point", coordinates: [lo, la]}}))});
  }
  BRM.porId = new Map(BRM.lista.map(a => [String(a[0]), a]));
  const m = Q.mapa;
  m.getSource("brmais").setData({type: "FeatureCollection",
    features: BRM.lista.map(a => ({type: "Feature", properties: {id: a[0], t: a[1], y: a[4].slice(0, 4)}, geometry: {type: "Point", coordinates: [a[6], a[5]]}}))});
  const anos = [...new Set([...Object.keys(BRM.meta.anos), ...(DESM.meta ? DESM.meta.resumo.map(r => r[2]) : [])])].sort().reverse();
  const it = (b, t) => `<label><input type="checkbox" data-b="${b}">${svgForma(b)}${t}</label>`;
  BRM.ano = anos[0] || "";   // ao ligar, começa pelo ano mais recente
  $("#ctlCorpo h4 + label input[data-c='eventos']")?.closest("label").previousElementSibling.insertAdjacentHTML("beforebegin",
    `<div class="brm-grupo"><h4>Brasil MAIS <span class="tarja">RESTRITO</span></h4>
      ${it("F", "Foco de queimada")}${it("I", "Foco de queimada por IA (início provável)")}${it("C", "Cicatriz de queimada")}
      ${DESM.meta ? it("D", "Desmatamento (corte raso, degradação, ramal)") + it("G", "Garimpo / extração mineral") : ""}
      <label class="brm-ano">Ano da imagem <select id="brmAno">${anos.map(a => `<option${a === BRM.ano ? " selected" : ""}>${a}</option>`).join("")}<option value="">todos os anos</option></select></label>
      <p class="nota">Desligado por padrão. Marque o tipo que quiser ver; o ano começa no mais recente. Desmatamento: aproxime o mapa para ver cada alerta.</p></div>`);
  $("#legCorpo")?.insertAdjacentHTML("beforeend", `<div><b style="font-size:11px">Brasil MAIS (restrito) · losango = fogo:</b></div>
    <div>${svgForma("F")}Foco · ${svgForma("I")}Foco por IA · ${svgForma("C")}Cicatriz</div>`
    + (DESM.meta ? `<div><b style="font-size:11px">quadrado = desmatamento:</b></div><div>${svgForma("D")}Desmatamento · ${svgForma("G")}Garimpo</div>` : ""));
  filtrarBrmais();
  if (Q.sel) selecionar(Q.sel, false);
}
const m0 = () => Q.mapa;
// aplica os tipos marcados e o ano escolhido às três camadas do Brasil MAIS
function filtrarBrmais() {
  const m = Q.mapa, v = BRM.vis, ano = BRM.ano ? [["==", ["get", "y"], BRM.ano]] : [];
  const fogo = ["C", "F", "I"].filter(t => v[t]), grupos = ["D", "G"].filter(g => v[g]);
  const tiposDesm = [...(v.D ? DESM_TIPOS_D : []), ...(v.G ? ["G"] : [])];
  m.setLayoutProperty("brmais", "visibility", fogo.length ? "visible" : "none");
  m.setFilter("brmais", ["all", ["in", ["get", "t"], ["literal", fogo]], ...ano]);
  m.setLayoutProperty("desm-res", "visibility", grupos.length && DESM.meta ? "visible" : "none");
  m.setFilter("desm-res", ["all", ["in", ["get", "g"], ["literal", grupos]], ...ano]);
  m.setLayoutProperty("desm", "visibility", tiposDesm.length && DESM.meta ? "visible" : "none");
  m.setFilter("desm", ["all", ["in", ["get", "t"], ["literal", tiposDesm]], ...ano]);
  carregarCelulasVisiveis();
}
// quadrículas de 0,5° com os alertas de desmatamento, sob demanda
const celDe = (la, lo) => `${Math.floor(la / 0.5)}_${Math.floor(lo / 0.5)}`;
function carregarCelula(c) {
  if (DESM.cel.has(c)) return Promise.resolve(false);
  if (!DESM.celulas.has(c)) { DESM.cel.set(c, []); return Promise.resolve(false); }
  if (!DESM.carregando.has(c)) DESM.carregando.set(c, restrito("desm/c_" + c).then(d => {
    DESM.cel.set(c, d.alertas); d.alertas.forEach(a => DESM.porId.set(String(a[0]), a)); return true;
  }).catch(() => false).finally(() => DESM.carregando.delete(c)));
  return DESM.carregando.get(c);
}
function desenharDesm() {
  Q.mapa.getSource("desm").setData({type: "FeatureCollection", features: [...DESM.cel.values()].flat().map(a =>
    ({type: "Feature", properties: {id: a[0], t: a[1], y: a[4].slice(0, 4)}, geometry: {type: "Point", coordinates: [a[6], a[5]]}}))});
}
async function carregarCelulasVisiveis() {
  const m = Q.mapa;
  if (!DESM.meta || m.getZoom() < 9 || !(BRM.vis.D || BRM.vis.G)) return;
  const b = m.getBounds(), l = [];
  for (let i = Math.floor(b.getSouth() / 0.5); i <= Math.floor(b.getNorth() / 0.5); i++)
    for (let j = Math.floor(b.getWest() / 0.5); j <= Math.floor(b.getEast() / 0.5); j++) l.push(`${i}_${j}`);
  if (l.length > 16) return;
  if ((await Promise.all(l.map(carregarCelula))).some(Boolean)) desenharDesm();
}
// alertas de desmatamento a até BRM_RAIO_KM do evento, com imagem "depois" de 12 meses antes do 1º foco a 60 dias depois do último
function desmPerto(e) {
  if (!DESM.meta) return [];
  const g = BRM_RAIO_KM / 111, gl = g / Math.max(Math.cos(e.lat * Math.PI / 180), .2), cs = new Set();
  for (const la of [e.lat - g, e.lat + g]) for (const lo of [e.lon - gl, e.lon + gl]) cs.add(celDe(la, lo));
  const falta = [...cs].filter(c => !DESM.cel.has(c));
  if (falta.length) { Promise.all(falta.map(carregarCelula)).then(r => { if (r.some(Boolean)) { desenharDesm(); if (Q.sel === e.id) selecionar(e.id, false); } }); return []; }
  const dia = 864e5, t0 = new Date(e.ini.slice(0, 10)) - 365 * dia, t1 = +new Date(e.fim.slice(0, 10)) + BRM_DIAS_DEPOIS * dia;
  return [...cs].flatMap(c => DESM.cel.get(c)).filter(a => Math.abs(a[5] - e.lat) < g && Math.abs(a[6] - e.lon) < gl)
    .filter(a => { const t = +new Date(a[4]); return t >= t0 && t <= t1; })
    .map(a => ({a, km: kmEntre(e.lat, e.lon, a[5], a[6])})).filter(x => x.km <= BRM_RAIO_KM).sort((x, y) => x.a[4] < y.a[4] ? 1 : -1);
}
function popupDesm(a) {
  return `<b>Brasil MAIS · ${esc(DESM.meta.tipos[a[1]] || a[1])}</b><br>Alerta nº ${esc(a[0])} · ${esc(a[7])}<br>${br(a[2], 2)} ha · imagens de ${dBR(a[3])} e ${dBR(a[4])}<br>
    ${a[8] ? `<a href="${brmImg({10: a[8]}, "before")}" target="_blank" rel="noopener">Imagem antes</a> · <a href="${brmImg({10: a[8]}, "after")}" target="_blank" rel="noopener">Imagem depois</a> · ` : ""}<a href="${brmRaa(a)}" target="_blank" rel="noopener">RAA</a>
    <br><span class="nota">Dado restrito (convênio). Não divulgar.</span>`;
}
const brmImg = (a, qual) => BRM.meta.img.replace("{uuid}", a[10]).replace("{qual}", qual);
const brmRaa = a => BRM.meta.raa.replace("{id}", a[0]);
function popupBrmais(a) {
  return `<b>Brasil MAIS · ${esc(BRM.meta.tipos[a[1]] || a[1])}</b><br>Alerta nº ${esc(a[0])} · ${esc(a[7])}<br>${br(a[2], 2)} ha · imagens de ${dBR(a[3])} e ${dBR(a[4])}<br>
    ${a[10] ? `<a href="${brmImg(a, "before")}" target="_blank" rel="noopener">Imagem antes</a> · <a href="${brmImg(a, "after")}" target="_blank" rel="noopener">Imagem depois</a> · ` : ""}<a href="${brmRaa(a)}" target="_blank" rel="noopener">RAA</a>
    <br><span class="nota">Dado restrito (convênio). Não divulgar.</span>`;
}
function kmEntre(la1, lo1, la2, lo2) {
  const r = Math.PI / 180, dla = (la2 - la1) * r, dlo = (lo2 - lo1) * r;
  const h = Math.sin(dla / 2) ** 2 + Math.cos(la1 * r) * Math.cos(la2 * r) * Math.sin(dlo / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}
// alertas a até BRM_RAIO_KM do evento, com imagem "depois" entre 30 dias antes do 1º foco e 60 dias depois do último
function brmaisPerto(e) {
  if (!BRM.lista.length) return [];
  const dia = 864e5, t0 = new Date(e.ini.slice(0, 10)) - BRM_DIAS_ANTES * dia, t1 = +new Date(e.fim.slice(0, 10)) + BRM_DIAS_DEPOIS * dia;
  const g = BRM_RAIO_KM / 111, gl = g / Math.max(Math.cos(e.lat * Math.PI / 180), .2);
  return BRM.lista.filter(a => Math.abs(a[5] - e.lat) < g && Math.abs(a[6] - e.lon) < gl)
    .filter(a => { const t = +new Date(a[4]); return t >= t0 && t <= t1; })
    .map(a => ({a, km: kmEntre(e.lat, e.lon, a[5], a[6])})).filter(x => x.km <= BRM_RAIO_KM).sort((x, y) => x.km - y.km);
}
function blocoBrmais(e) {
  if (!Q.usuario || !BRM.lista.length) return "";
  const l = brmaisPerto(e);
  return `<div class="clima-bloco restrito-bloco"><h3>Alertas Brasil MAIS próximos <span class="tarja">RESTRITO</span></h3>
    ${l.length ? `<p class="nota">${l.length} alerta(s) a até ${BRM_RAIO_KM} km, com imagem posterior entre ${BRM_DIAS_ANTES} dias antes do primeiro foco e ${BRM_DIAS_DEPOIS} dias depois do último.</p>
    <div class="rolagem"><table class="tabela"><thead><tr><th>Alerta nº</th><th>Tipo</th><th>Área</th><th>Antes</th><th>Depois</th><th>Distância</th><th>Imagens Planet</th></tr></thead><tbody>
    ${l.slice(0, 20).map(({a, km}) => `<tr><td class="mono"><a href="${brmRaa(a)}" target="_blank" rel="noopener" title="Abrir o RAA na plataforma da PF">${esc(a[0])}</a></td><td>${esc(BRM.meta.tipos[a[1]] || a[1])}</td>
      <td class="n">${br(a[2], 2)} ha</td><td class="mono">${dBR(a[3])}</td><td class="mono">${dBR(a[4])}</td><td class="n">${br(km, 1)} km</td>
      <td>${a[10] ? `<a href="${brmImg(a, "before")}" target="_blank" rel="noopener">antes</a> · <a href="${brmImg(a, "after")}" target="_blank" rel="noopener">depois</a>` : "–"}</td></tr>`).join("")}</tbody></table></div>
    ${l.length > 20 ? `<p class="nota">Mostrando 20 de ${l.length}.</p>` : ""}`
      : `<p class="nota">Nenhum alerta de queimada do Brasil MAIS a até ${BRM_RAIO_KM} km nesse período.</p>`}
    ${blocoDesm(e)}
    <p class="nota">Fonte: Brasil MAIS (Polícia Federal), imagens Planet de 3 m. Imagens e RAA exigem login na plataforma da PF. O "foco de queimada (IA)" indica a área provável de início segundo o produto, só em vegetação primária: é hipótese a confrontar, não ponto de ignição demonstrado. Dado de convênio: uso restrito, não divulgar.</p></div>`;
}
function blocoDesm(e) {
  if (!DESM.meta) return "";
  const l = desmPerto(e);
  return `<h4 style="margin:12px 0 4px">Desmatamento e garimpo a até ${BRM_RAIO_KM} km</h4>
    ${l.length ? `<p class="nota">${l.length} alerta(s) com imagem posterior entre 12 meses antes do primeiro foco e ${BRM_DIAS_DEPOIS} dias depois do último (${br(l.reduce((t, x) => t + x.a[2], 0), 1)} ha). Mais recentes primeiro:</p>
    <div class="rolagem"><table class="tabela"><thead><tr><th>Alerta nº</th><th>Tipo</th><th>Área</th><th>Antes</th><th>Depois</th><th>Distância</th><th>Imagens Planet</th></tr></thead><tbody>
    ${l.slice(0, 20).map(({a, km}) => `<tr><td class="mono"><a href="${brmRaa(a)}" target="_blank" rel="noopener">${esc(a[0])}</a></td><td>${esc(DESM.meta.tipos[a[1]] || a[1])}</td>
      <td class="n">${br(a[2], 2)} ha</td><td class="mono">${dBR(a[3])}</td><td class="mono">${dBR(a[4])}</td><td class="n">${br(km, 1)} km</td>
      <td>${a[8] ? `<a href="${brmImg({10: a[8]}, "before")}" target="_blank" rel="noopener">antes</a> · <a href="${brmImg({10: a[8]}, "after")}" target="_blank" rel="noopener">depois</a>` : "–"}</td></tr>`).join("")}</tbody></table></div>
    ${l.length > 20 ? `<p class="nota">Mostrando 20 de ${l.length}.</p>` : ""}`
      : `<p class="nota">Nenhum alerta de desmatamento ou garimpo nesse raio e período.</p>`}`;
}

// radar de chuva mais recente do RainViewer (lista de quadros renovada a cada 10 min)
async function atualizarChuva() {
  try {
    const d = await (await fetch("https://api.rainviewer.com/public/weather-maps.json")).json();
    const q = d.radar.past.at(-1), url = `${d.host}${q.path}/256/{z}/{x}/{y}/2/1_1.png`, m = Q.mapa;
    if (m.getSource("chuva")) m.getSource("chuva").setTiles([url]);
    else {
      m.addSource("chuva", {type: "raster", tiles: [url], tileSize: 256, maxzoom: 7, attribution: "RainViewer"});
      m.addLayer({id: "chuva", type: "raster", source: "chuva", layout: {visibility: $("#ctlCorpo input[data-c='chuva']")?.checked ? "visible" : "none"}, paint: {"raster-opacity": .75}}, "mun");
    }
    const h = $("#chuvaHora"); if (h) h.textContent = "· " + new Date(q.time * 1000).toLocaleTimeString("pt-BR", {timeZone: "America/Manaus", hour: "2-digit", minute: "2-digit"});
  } catch (e) { console.warn("RainViewer indisponível", e); }
}

// ------------------------------------------------------------ trocar a própria senha
document.body.insertAdjacentHTML("beforeend", `<dialog id="dlgTroca" style="max-width:400px;width:calc(100% - 32px);border:1px solid var(--cinza-borda);border-radius:10px;padding:20px">
  <form method="dialog" style="display:grid;gap:10px">
    <h2 style="margin:0">Trocar a sua senha</h2>
    <label style="display:grid;gap:4px;font-size:13px;font-weight:600">Senha atual<input type="password" name="senha" required autocomplete="current-password"></label>
    <label style="display:grid;gap:4px;font-size:13px;font-weight:600">Senha nova (mínimo 10 caracteres)<input type="password" name="nova" required minlength="10" autocomplete="new-password"></label>
    <label style="display:grid;gap:4px;font-size:13px;font-weight:600">Repita a senha nova<input type="password" name="nova2" required minlength="10" autocomplete="new-password"></label>
    <p id="trMsg" class="nota" style="margin:0;color:var(--vermelho)"></p>
    <div style="display:flex;gap:8px;justify-content:flex-end"><button type="button" class="botao secundario pequeno" id="trCancelar">Cancelar</button><button type="submit" class="botao pequeno" id="trSalvar">Salvar</button></div>
  </form></dialog>`);
$("#trCancelar").onclick = () => $("#dlgTroca").close();
$("#dlgTroca form").addEventListener("submit", async ev => {
  ev.preventDefault();
  const f = Object.fromEntries(new FormData(ev.target)), m = $("#trMsg");
  if (f.nova !== f.nova2) return m.textContent = "As duas senhas novas não são iguais.";
  $("#trSalvar").disabled = true; m.textContent = "";
  try {
    const r = await fetch("api/conta?acao=trocar", {method: "POST", credentials: "same-origin", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({email: Q.usuario?.email, senha: f.senha, nova: f.nova})});
    const d = await r.json();
    if (!r.ok) { m.textContent = d.erro || "Não foi possível trocar a senha."; return; }
    $("#dlgTroca").close(); toast("Senha trocada. Use a nova senha no próximo acesso.");
  } catch (x) { m.textContent = "Sem conexão. Tente de novo."; }
  finally { $("#trSalvar").disabled = false; }
});

// ------------------------------------------------------------ camadas carregadas só quando ligadas
const carregadas = new Set();
async function sobDemanda(k) {
  if (carregadas.has(k)) return;
  try {
    const BASE = {assentamentos: "assentamentos_am", fpnd: "fpnd_am", sigef: "sigef_am", aldeias: "aldeias_am", mineracao: "mineracao_am", pistas: "pistas_am", bombeiros: "bombeiros_am"};
    if (BASE[k]) { if (["sigef", "fpnd", "mineracao"].includes(k)) toast("Carregando a camada…", 2500); Q.mapa.getSource(k).setData(await (await fetch(`bases/${BASE[k]}.json`)).json()); }
    else if (k === "estradas") { toast("Carregando estradas e ramais…", 3000); Q.mapa.getSource("estradas").setData(await json("dados/estradas.json")); }
    else if (k === "riscoprev") await riscoPrevisto();
    else return;
    carregadas.add(k);
  } catch (e) { toast("Camada indisponível no momento."); console.warn(k, e); }
}
async function riscoPrevisto() {
  const r = await json("dados/risco_previsto.json"), [w, s, e, n] = r.limites, m = Q.mapa;
  const rot = ["hoje", "amanhã", "em 2 dias", "em 3 dias"];
  $("#riscoDia").innerHTML = r.dias.map(d => `<option value="${d.t}">${rot[d.t]} (${dBR(d.data)}) · ${br(d.alto_ou_critico_pct, 1)}% alto/crítico</option>`).join("");
  const url = t => window.QD(r.dias.find(d => d.t === t).arquivo, Math.round(r.t));
  const coord = [[w, n], [e, n], [e, s], [w, s]];
  const t0 = r.dias.some(d => d.t === 1) ? 1 : r.dias[0].t;
  $("#riscoDia").value = t0;
  if (!m.getSource("riscoprev")) {
    m.addSource("riscoprev", {type: "image", url: url(t0), coordinates: coord});
    m.addLayer({id: "riscoprev", type: "raster", source: "riscoprev", paint: {"raster-opacity": .8, "raster-resampling": "nearest"}}, "mun");
  }
  $("#riscoDia").onchange = ev => m.getSource("riscoprev").updateImage({url: url(+ev.target.value), coordinates: coord});
  $("#riscoInfo").textContent = `${r.fonte}. Grade de 1 km; atualizado a cada 6 h.`;
}

// ------------------------------------------------------------ selecionar uma área no mapa (círculo ou mão livre)
const DES = {modo: null, ativo: false, pts: [], centro: null, pop: null};
const mPorGrau = 111320;
function areaHa(pts) {   // fórmula do laço em coordenadas locais (m)
  const lat0 = pts.reduce((t, p) => t + p[1], 0) / pts.length, c = Math.cos(lat0 * Math.PI / 180);
  let a = 0; for (let i = 0; i < pts.length; i++) { const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length]; a += (x1 * c * mPorGrau) * (y2 * mPorGrau) - (x2 * c * mPorGrau) * (y1 * mPorGrau); }
  return Math.abs(a) / 2 / 1e4;
}
const circuloPts = (lon, lat, r, n = 64) => Array.from({length: n}, (_, i) => { const a = i / n * 2 * Math.PI;
  return [lon + r / mPorGrau / Math.cos(lat * Math.PI / 180) * Math.cos(a), lat + r / mPorGrau * Math.sin(a)]; });
const kmEntrePts = (a, b) => Math.hypot((a[1] - b[1]) * 111.32, (a[0] - b[0]) * 111.32 * Math.cos(a[1] * Math.PI / 180));
function desenhar(pts, fechado = true) {
  const m = Q.mapa;
  if (!m.getSource("desenho")) {
    m.addSource("desenho", {type: "geojson", data: {type: "FeatureCollection", features: []}});
    m.addLayer({id: "desenho-f", type: "fill", source: "desenho", filter: ["==", ["geometry-type"], "Polygon"], paint: {"fill-color": "#ffdf00", "fill-opacity": .15}});
    m.addLayer({id: "desenho-l", type: "line", source: "desenho", paint: {"line-color": "#ffdf00", "line-width": 2.5, "line-dasharray": [2, 1]}});
  }
  const g = fechado && pts.length > 2 ? {type: "Polygon", coordinates: [[...pts, pts[0]]]} : {type: "LineString", coordinates: pts};
  m.getSource("desenho").setData({type: "Feature", geometry: g});
}
function iniciarDesenho(modo) {
  const m = Q.mapa; DES.modo = modo; DES.pts = []; DES.pop?.remove();
  m.dragPan.disable(); m.getCanvas().style.cursor = "crosshair";
  toast(modo === "circulo" ? "Clique (ou toque) no centro e arraste até a borda do círculo." : "Pressione e contorne a área com o mouse ou o dedo; solte para fechar.", 7000);
  rolarPara($("#mapa"), true);
}
function pontoEv(ev) { return [ev.lngLat.lng, ev.lngLat.lat]; }
function desenhoInicio(ev) {
  if (!DES.modo) return;
  ev.preventDefault(); DES.ativo = true; DES.centro = pontoEv(ev); DES.pts = [DES.centro];
}
function desenhoMove(ev) {
  if (!DES.ativo) return;
  const p = pontoEv(ev);
  if (DES.modo === "circulo") { DES.raio = kmEntrePts(DES.centro, p) * 1000; desenhar(circuloPts(DES.centro[0], DES.centro[1], DES.raio)); return; }
  const ult = Q.mapa.project(DES.pts[DES.pts.length - 1]), atual = Q.mapa.project(p);
  if (Math.hypot(ult.x - atual.x, ult.y - atual.y) > 4) { DES.pts.push(p); desenhar(DES.pts, false); }
}
function desenhoFim() {
  if (!DES.ativo) return;
  const m = Q.mapa; DES.ativo = false; const modo = DES.modo; DES.modo = null;
  m.dragPan.enable(); m.getCanvas().style.cursor = "";
  let pts, raio = null;
  if (modo === "circulo") { raio = Math.round(DES.raio || 0); if (raio < 50) return toast("Círculo pequeno demais: arraste do centro até a borda."); pts = circuloPts(DES.centro[0], DES.centro[1], raio); }
  else { pts = DES.pts; if (pts.length < 4) return toast("Contorno curto demais: pressione e desenhe a área."); const k = Math.ceil(pts.length / 150); pts = pts.filter((_, i) => i % k === 0); }
  const ha = areaHa(pts), raioEq = Math.round(Math.sqrt(ha * 1e4 / Math.PI));
  if (raioEq > 5000) { desenhar([]); return toast("Área grande demais para a análise de satélite (máximo ~7.800 ha, raio de 5 km). Desenhe uma área menor."); }
  desenhar(pts);
  const c = modo === "circulo" ? DES.centro : [pts.reduce((t, p) => t + p[0], 0) / pts.length, pts.reduce((t, p) => t + p[1], 0) / pts.length];
  const poliTxt = pts.map(p => p[0].toFixed(5) + "," + p[1].toFixed(5)).join(";"), hoje = new Date().toLocaleDateString("sv-SE", {timeZone: "America/Manaus"});
  DES.pop = new maplibregl.Popup({maxWidth: "300px", closeOnClick: false}).setLngLat(c).setHTML(`<b>Área selecionada</b><br>${modo === "circulo" ? `Círculo de ${fmt(raio)} m de raio · ` : "Desenho à mão livre · "}${br(ha, 1)} ha
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px"><button type="button" class="botao pequeno" id="dAnalisar">Analisar satélite desta área</button>
    <button type="button" class="botao secundario pequeno" id="dRelatorio">Relatório desta área</button><button type="button" class="botao secundario pequeno" id="dApagar">Apagar</button></div>`).addTo(m);
  const analisarArea = () => { window.abrirAnalise?.(modo === "circulo" ? {lat: c[1], lon: c[0], raio} : {lat: c[1], lon: c[0], raio: raioEq, poli: pts}); setTimeout(() => $("#aRodar")?.click(), 300); };
  const relatorioArea = () => window.open(`relatorio.html?lat=${c[1].toFixed(5)}&lon=${c[0].toFixed(5)}&data=${hoje}` + (modo === "circulo" ? `&raio=${raio}` : `&poli=${encodeURIComponent(poliTxt)}`), "_blank");
  const apagarArea = () => { desenhar([]); DES.pop?.remove(); $("#areaSel").hidden = true; };
  $("#dAnalisar").onclick = analisarArea; $("#dRelatorio").onclick = relatorioArea; $("#dApagar").onclick = apagarArea;
  // os mesmos botões ficam fixos no menu de camadas (o balão pode ser fechado sem querer)
  const box = $("#areaSel");
  box.innerHTML = `<b>Área selecionada</b> · ${br(ha, 1)} ha<div class="ctl-acoes" style="margin-top:4px"><button type="button" class="botao pequeno" id="aSelAnalisar" style="flex:1">Analisar satélite</button>
    <button type="button" class="botao secundario pequeno" id="aSelRelatorio" style="flex:1">Gerar relatório</button><button type="button" class="botao secundario pequeno" id="aSelApagar">Apagar</button></div>`;
  box.hidden = false;
  $("#aSelAnalisar").onclick = analisarArea; $("#aSelRelatorio").onclick = relatorioArea; $("#aSelApagar").onclick = apagarArea;
  maisPerto({latitude: c[1], longitude: c[0]}, true);
}
(function ligarDesenho() {
  const espera = setInterval(() => {
    const m = Q.mapa; if (!m) return; clearInterval(espera);
    m.on("mousedown", desenhoInicio); m.on("touchstart", desenhoInicio);
    m.on("mousemove", desenhoMove); m.on("touchmove", desenhoMove);
    m.on("mouseup", desenhoFim); m.on("touchend", desenhoFim);
  }, 300);
})();

// ficha enxuta: cada quadro mostra título e resumo; "ver detalhes" abre e fecha
function recolherBlocos(raiz) {
  raiz.querySelectorAll(".clima-bloco, .painel-grade").forEach(b => {
    if (b.tagName === "DETAILS" || b.closest("details")) return;
    const h = b.querySelector("h3"); if (!h) return;
    const resumo = (b.querySelector(".clima-leitura")?.textContent || [...b.querySelectorAll(".fatos b")].slice(0, 3).map(x => x.textContent).join(" · ")
      || b.querySelector("p")?.textContent || "").replace(/\s+/g, " ").trim();
    const d = document.createElement("details"); d.className = b.className + " recolhivel";
    const sm = document.createElement("summary");
    sm.innerHTML = `<span class="tit">${b.classList.contains("painel-grade") ? "Sinais verificados um a um e fontes públicas" : h.innerHTML}</span><span class="res">${esc(resumo.slice(0, 150))}${resumo.length > 150 ? "…" : ""}</span><span class="ver">ver detalhes</span>`;
    if (b.classList.contains("painel-grade")) { d.className = "clima-bloco recolhivel"; b.replaceWith(d); d.append(sm, b); return; }
    h.remove(); d.append(sm, ...b.childNodes); b.replaceWith(d);
  });
}

// consulta pública do INCRA (o detentor aparece lá; acesso só por pessoa, no navegador)
const sigefUrl = parcela => `https://sigef.incra.gov.br/geo/parcela/detalhe/${encodeURIComponent(parcela)}/`;
