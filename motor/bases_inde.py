"""Bases estáticas obtidas pela INDE (Infraestrutura Nacional de Dados Espaciais), para o Amazonas.

  - DECEA (AISWEB): aeródromos e helipontos homologados/registrados → public/bases/aerodromos_am.json
    e marcação das pistas do OpenStreetMap (pistas_am.json) que não têm aeródromo do DECEA a até 3 km.
  - IBGE, Censo 2022: localidades indígenas → public/bases/localidades_indigenas_am.json

Uso LOCAL (rodar de tempos em tempos e publicar os arquivos):  python -m motor.bases_inde
"""
import json
import math

import requests

from . import config

BASES = config.PUBLICO.parent / "bases"
DECEA = "https://geoaisweb.decea.gov.br/geoserver/ICA/ows"
CENSO = "https://geoservicoscenso2022.ibge.gov.br/geoserver/censo2022/ows"
RAIO_HOMOLOGADA_KM = 3.0


def _wfs(url, tipo, filtro):
    r = requests.get(url, params={"service": "WFS", "version": "1.0.0", "request": "GetFeature", "typeName": tipo,
                                  "outputFormat": "application/json", "CQL_FILTER": filtro}, timeout=180)
    r.raise_for_status()
    return r.json()["features"]


def _km(a, b):
    return math.hypot((a[1] - b[1]) * 111.32, (a[0] - b[0]) * 111.32 * math.cos(math.radians(a[1])))


def aerodromos():
    feats = []
    for tipo, rot in (("ICA:airport", "aeródromo"), ("ICA:heliport", "heliponto")):
        for f in _wfs(DECEA, tipo, "uf='AM'"):
            p = f["properties"]
            lon, lat = p.get("longitude_dec"), p.get("latitude_dec")
            if lon is None or lat is None:
                lon, lat = f["geometry"]["coordinates"][:2]
            feats.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [round(lon, 6), round(lat, 6)]},
                          "properties": {"nome": p.get("nome"), "ciad": p.get("ciad"), "icao": p.get("localidade_id"), "tipo": rot,
                                         "uso": p.get("tipo_util"), "cidade": p.get("cidade"), "operacao": p.get("opr"),
                                         "efetivacao": (p.get("efetivacao") or "")[:10]}})
    fc = {"type": "FeatureCollection", "fonte": "DECEA/AISWEB via INDE (aeródromos e helipontos registrados)", "features": feats}
    (BASES / "aerodromos_am.json").write_text(json.dumps(fc, ensure_ascii=False, separators=(",", ":")))
    # pistas do OpenStreetMap sem aeródromo do DECEA por perto: indício de pista não homologada
    pistas = json.load(open(BASES / "pistas_am.json"))
    pts = [(f["geometry"]["coordinates"], f["properties"]) for f in feats]
    nao = 0
    for f in pistas["features"]:
        c = f["geometry"]["coordinates"]
        d, pr = min(((_km(c, q), p) for q, p in pts), key=lambda t: t[0], default=(None, None))
        hom = d is not None and d <= RAIO_HOMOLOGADA_KM
        f["properties"]["decea"] = {"homologada": hom, "km": round(d, 2) if d is not None else None,
                                    "ciad": pr.get("ciad") if hom else None, "nome": pr.get("nome") if hom else None}
        f["properties"]["homologada"] = hom   # campo simples para o estilo do mapa
        nao += not hom
    pistas["fonte_homologacao"] = f"DECEA/AISWEB via INDE: pista sem aeródromo registrado a até {RAIO_HOMOLOGADA_KM:g} km"
    (BASES / "pistas_am.json").write_text(json.dumps(pistas, ensure_ascii=False, separators=(",", ":")))
    print(f"DECEA: {len(feats)} aeródromos/helipontos no AM; {nao} de {len(pistas['features'])} pistas do OSM sem registro")


def localidades_indigenas():
    feats = []
    for f in _wfs(CENSO, "censo2022:cete_BR_LIs_CD2022_02062025", "CD_MUNIC LIKE '13%'"):
        p = f["properties"]
        lon, lat = f["geometry"]["coordinates"][:2]
        feats.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [round(lon, 6), round(lat, 6)]},
                      "properties": {"nome": p.get("NM_LI"), "municipio": p.get("NM_MUNIC"), "situacao": p.get("SITUACAO"),
                                     "ti": p.get("NM_TI"), "fase_ti": p.get("FASE"), "cod": p.get("CD_LI")}})
    fc = {"type": "FeatureCollection", "fonte": "IBGE, Censo Demográfico 2022 — localidades indígenas (via INDE)", "features": feats}
    (BASES / "localidades_indigenas_am.json").write_text(json.dumps(fc, ensure_ascii=False, separators=(",", ":")))
    print(f"Censo 2022: {len(feats)} localidades indígenas no AM ({sum(not x['properties']['ti'] for x in feats)} fora de TI)")


if __name__ == "__main__":
    aerodromos()
    localidades_indigenas()
