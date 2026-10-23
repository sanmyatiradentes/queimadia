"""Contexto fundiário e hidrográfico de cada evento: assentamento do INCRA e sub-bacia hidrográfica (ANA).

  Assentamentos: INCRA, Acervo Fundiário (public/bases/assentamentos_am.json).
  Sub-bacias: ANA/SNIRH, sub-bacias do DNAEE (atualizadas no máximo uma vez por mês).
"""
import json
import time

import requests
from shapely.geometry import Point, shape
from shapely.strtree import STRtree

from . import config

ASSENT = config.PUBLICO.parent / "bases" / "assentamentos_am.json"
BACIAS = config.ESTADO / "subbacias_am.json"
URL_BACIAS = ("https://portal1.snirh.gov.br/server/rest/services/dados_abertos/DNAEE_Sub_Bacias/MapServer/0/query"
              "?geometry=-73.8,-9.9,-56.1,2.3&geometryType=esriGeometryEnvelope&inSR=4326&outSR=4326"
              "&spatialRel=esriSpatialRelIntersects&outFields=DNS_NM,DNS_NU_SUB&returnGeometry=true&maxAllowableOffset=0.005&f=geojson")


def _bacias():
    try:
        d = json.load(open(BACIAS))
        if time.time() - d.get("t", 0) < 30 * 86400:
            return d
    except Exception:
        d = None
    try:
        r = requests.get(URL_BACIAS, timeout=120)
        r.raise_for_status()
        novo = r.json()
        if novo.get("features"):
            novo["t"] = time.time()
            BACIAS.write_text(json.dumps(novo, separators=(",", ":"), ensure_ascii=False))
            return novo
    except Exception as exc:
        print("sub-bacias: falha", type(exc).__name__)
    return d


def _indice(fc):
    feats = [(shape(f["geometry"]), f["properties"]) for f in (fc or {}).get("features", []) if f.get("geometry")]
    return (STRtree([g for g, _ in feats]), feats) if feats else (None, [])


def marcar(eventos):
    arv_a, assent = _indice(json.load(open(ASSENT)) if ASSENT.exists() else None)
    arv_b, bacias = _indice(_bacias())
    na = nb = 0
    for e in eventos:
        p = Point(e["lon"], e["lat"])
        e["det"].pop("assentamento", None)
        if arv_a is not None:
            for i in arv_a.query(p, predicate="intersects"):
                pr = assent[int(i)][1]
                e["det"]["assentamento"] = {"nome": pr.get("nome_proje"), "codigo": pr.get("cd_sipra"), "municipio": pr.get("municipio"),
                                            "familias": pr.get("num_famili"), "area_ha": pr.get("area_calc_"), "fase": pr.get("fase"),
                                            "criado": pr.get("data_de_cr")}
                na += 1
                break
        if arv_b is not None:
            for i in arv_b.query(p, predicate="intersects"):
                pr = bacias[int(i)][1]
                e["det"]["bacia"] = {"nome": pr.get("DNS_NM"), "codigo": pr.get("DNS_NU_SUB"), "fonte": "ANA — sub-bacias DNAEE"}
                nb += 1
                break
    return f"{na} em assentamento, {nb} com sub-bacia"
