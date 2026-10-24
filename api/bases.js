// Fogo Forense — consulta bases fundiárias e ambientais públicas para o relatório do evento.
// Os serviços oficiais não liberam acesso direto pelo navegador (CORS); esta função repassa só as
// bases listadas abaixo, para um retângulo pequeno, e devolve GeoJSON.
//   GET /api/bases?base=car|embargos|anm&bbox=oeste,sul,leste,norte
import { json, usuarioAtual } from "./_conta.js";

const ARCGIS = (url, campos) => b =>
  `${url}/query?geometry=${b.join(",")}&geometryType=esriGeometryEnvelope&inSR=4326&outSR=4326&spatialRel=esriSpatialRelIntersects&outFields=${campos}&f=geojson&resultRecordCount=200`;
const BASES = {
  // SICAR: imóveis do CAR no Amazonas (WFS 2.0 com eixo lat,lon no bbox)
  car: b => `https://geoserver.car.gov.br/geoserver/sicar/wfs?service=WFS&version=2.0.0&request=GetFeature&typeNames=sicar:sicar_imoveis_am&outputFormat=application/json&count=200&srsName=EPSG:4326&bbox=${b[1]},${b[0]},${b[3]},${b[2]},urn:ogc:def:crs:EPSG::4326`,
  // IBAMA: áreas embargadas. Nome e CPF/CNPJ do embargado (publicados pelo IBAMA) só para usuário logado
  embargos: ARCGIS("https://pamgia.ibama.gov.br/server/rest/services/01_Publicacoes_Bases/adm_embargos_ibama_a/MapServer/0",
    "num_tad,serie_tad,dat_embargo,municipio,des_infracao,num_auto_infracao,num_processo,qtd_area_embargada,unid_controle,sit_desmatamento,nome_imovel,nome_embargado,cpf_cnpj_embargado"),
  // ANM: processos minerários (SIGMINE)
  anm: ARCGIS("https://geo.anm.gov.br/arcgis/rest/services/SIGMINE/dados_anm/MapServer/0", "PROCESSO,FASE,SUBS,USO,AREA_HA,ULT_EVENTO"),
};
const PRIVADOS = ["nome_embargado", "cpf_cnpj_embargado", "NOME"];
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
    const logado = base === "embargos" && await usuarioAtual(req).catch(() => null);
    for (const f of d.features || []) {
      if (!f.properties) continue;
      if (logado) f.properties.cpf_cnpj_embargado = documento(f.properties.cpf_cnpj_embargado);
      else for (const k of PRIVADOS) delete f.properties[k];
      delete f.properties.NOME;
    }
    return json(res, 200, { type: "FeatureCollection", features: d.features || [], consultado_em: new Date().toISOString() },
      // embargos nunca no cache compartilhado: a resposta depende de quem está logado
      { "Cache-Control": base === "embargos" ? "private, no-store" : "public, s-maxage=86400, stale-while-revalidate=604800" });
  } catch (e) {
    return json(res, 504, { erro: "Serviço indisponível no momento." });
  }
}
