// Fogo Forense — consulta bases fundiárias e ambientais públicas para o relatório do evento.
// Os serviços oficiais não liberam acesso direto pelo navegador (CORS); esta função repassa só as
// bases listadas abaixo, para um retângulo pequeno, e devolve GeoJSON.
//   GET /api/bases?base=car|embargos|anm|autos|apreensoes|icmbio&bbox=oeste,sul,leste,norte
import { json, usuarioAtual } from "./_conta.js";

const ARCGIS = (url, campos) => b =>
  `${url}/query?geometry=${b.join(",")}&geometryType=esriGeometryEnvelope&inSR=4326&outSR=4326&spatialRel=esriSpatialRelIntersects&outFields=${campos}&f=geojson&resultRecordCount=200`;
const BASES = {
  // SICAR: imóveis do CAR no Amazonas (WFS 2.0 com eixo lat,lon no bbox)
  car: b => `https://geoserver.car.gov.br/geoserver/sicar/wfs?service=WFS&version=2.0.0&request=GetFeature&typeNames=sicar:sicar_imoveis_am&outputFormat=application/json&count=200&srsName=EPSG:4326&bbox=${b[1]},${b[0]},${b[3]},${b[2]},urn:ogc:def:crs:EPSG::4326`,
  // IBAMA: áreas embargadas. Nome e CPF/CNPJ do embargado (publicados pelo IBAMA) só para usuário logado
  embargos: ARCGIS("https://pamgia.ibama.gov.br/server/rest/services/01_Publicacoes_Bases/adm_embargos_ibama_a/MapServer/0",
    "num_tad,serie_tad,dat_embargo,municipio,des_infracao,num_auto_infracao,num_processo,qtd_area_embargada,unid_controle,sit_desmatamento,nome_imovel,nome_embargado,cpf_cnpj_embargado"),
  // IBAMA (SISCOM, via INDE): autos de infração e termos de apreensão. Autuado e documento só para usuário logado
  autos: ARCGIS("https://pamgia.ibama.gov.br/server/rest/services/SISCOM/publico/MapServer/0",
    "num_auto_infracao,ser_auto_infracao,dat_hora_auto_infracao,dt_fato_infracional,tipo_infracao,des_auto_infracao,val_auto_infracao,sit_cancelado,des_status_formulario,nu_processo_formatado,qt_area,municipio,nome_infrator,cpf_cnpj_infrator"),
  apreensoes: ARCGIS("https://pamgia.ibama.gov.br/server/rest/services/SISCOM/publico/MapServer/1",
    "cd_tad,cd_serie_tad,dt_apreensao,ds_sit_apreensao,st_cancelado,nu_processo_formatado,ds_tad,no_municipio,no_pessoa_apreensao,nu_cpf_cnpj_pessoa_apreensao"),
  // ICMBio (via INDE): áreas embargadas em UC federais (WFS 1.0: bbox em lon,lat)
  icmbio: b => `https://geoservicos.inde.gov.br/geoserver/ICMBio/ows?service=WFS&version=1.0.0&request=GetFeature&typeName=ICMBio:embargos_icmbio&outputFormat=application/json&maxFeatures=200&bbox=${b.join(",")}`,
  // ANM: processos minerários (SIGMINE)
  anm: ARCGIS("https://geo.anm.gov.br/arcgis/rest/services/SIGMINE/dados_anm/MapServer/0", "PROCESSO,FASE,SUBS,USO,AREA_HA,ULT_EVENTO"),
};
// dados pessoais publicados pelos órgãos: [campos só para logado, campo de documento a mascarar]
const PESSOAIS = {
  embargos: [["nome_embargado", "cpf_cnpj_embargado"], "cpf_cnpj_embargado"],
  autos: [["nome_infrator", "cpf_cnpj_infrator", "des_auto_infracao"], "cpf_cnpj_infrator"],
  apreensoes: [["no_pessoa_apreensao", "nu_cpf_cnpj_pessoa_apreensao", "ds_tad"], "nu_cpf_cnpj_pessoa_apreensao"],
  icmbio: [["autuado", "cpf_cnpj", "obs"], "cpf_cnpj"],
};
// CPF (pessoa física) mascarado; CNPJ (empresa) completo
function documento(v) {
  const d = String(v || "").replace(/\D/g, "");
  if (d.length === 14) return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
  if (d.length === 11) return `${d.slice(0, 3)}.***.***-${d.slice(9)}`;
  return d ? "***" : "";
}

export default async function handler(req, res) {
  const q = new URL(req.url, "http://x").searchParams;
  const base = q.get("base"), b = String(q.get("bbox") || "").split(",").map(Number);
  if (!BASES[base]) return json(res, 400, { erro: "Base inválida." });
  if (b.length !== 4 || b.some(v => !Number.isFinite(v)) || b[2] - b[0] > 0.6 || b[3] - b[1] > 0.6 || b[2] <= b[0] || b[3] <= b[1]
      || b[0] < -75 || b[2] > -55 || b[1] < -11 || b[3] > 3)
    return json(res, 400, { erro: "Retângulo inválido (máx. 0,6° no Amazonas)." });
  try {
    const c = new AbortController(); const t = setTimeout(() => c.abort(), 25000);
    const r = await fetch(BASES[base](b), { signal: c.signal, headers: { "User-Agent": "FogoForense/1.0 (NIPED/PCAM)" } });
    clearTimeout(t);
    if (!r.ok) return json(res, 502, { erro: `Serviço respondeu ${r.status}.` });
    const d = await r.json();
    const pes = PESSOAIS[base], logado = pes && await usuarioAtual(req).catch(() => null);
    for (const f of d.features || []) {
      if (!f.properties) continue;
      if (pes && logado) f.properties[pes[1]] = documento(f.properties[pes[1]]);
      else if (pes) for (const k of pes[0]) delete f.properties[k];
      delete f.properties.NOME;
    }
    // autos e apreensões: sem coordenada no serviço, ficam fora (não dá para posicionar)
    const feats = (d.features || []).filter(f => f.geometry || !["autos", "apreensoes"].includes(base));
    return json(res, 200, { type: "FeatureCollection", features: feats, consultado_em: new Date().toISOString() },
      // bases com dados pessoais nunca no cache compartilhado: a resposta depende de quem está logado
      { "Cache-Control": pes ? "private, no-store" : "public, s-maxage=86400, stale-while-revalidate=604800" });
  } catch (e) {
    return json(res, 504, { erro: "Serviço indisponível no momento." });
  }
}
