"""Lixões, vazadouros e aterros no Amazonas (OpenStreetMap, base colaborativa).

Não há base oficial pública com a localização dos lixões do Amazonas; o
OpenStreetMap é incompleto. Atualizado no máximo uma vez por semana.
Usado para: camada do mapa (fumaça tóxica) e, na matriz de hipóteses, como
possível fonte térmica não vegetal quando um foco está a até 1 km.
"""
import json
import math
import time

import requests
from shapely.geometry import Point
from shapely.ops import unary_union

from . import config, geo

ARQ = config.PUBLICO / "lixoes.json"
SERVIDORES = ("https://overpass.kumi.systems/api/interpreter", "https://overpass-api.de/api/interpreter")
CONSULTA = ('[out:json][timeout:180];(nwr["landuse"="landfill"]({s},{w},{n},{e});'
            'nwr["amenity"="waste_disposal"]["waste"!="trash"]({s},{w},{n},{e}););out center tags;')
RAIO_KM = 1.0


def atualizar(forcar=False):
    try:
        atual = json.load(open(ARQ))
        if not forcar and time.time() - atual.get("t", 0) < 7 * 86400:
            return atual
    except Exception:
        atual = None
    w, s, e, n = config.AM_BBOX
    q = CONSULTA.format(s=s, w=w, n=n, e=e)
    dados = None
    for srv in SERVIDORES:
        try:
            r = requests.post(srv, data={"data": q}, timeout=240,
                              headers={"User-Agent": "FogoForense/1.0 (NIPED-PCAM)"})
            if r.ok:
                dados = r.json()
                break
        except Exception:
            continue
    if dados is None:
        return atual
    am = unary_union(geo.municipios().geoms)
    pontos = []
    for el in dados.get("elements", []):
        la = el.get("lat") or el.get("center", {}).get("lat")
        lo = el.get("lon") or el.get("center", {}).get("lon")
        if la is None or not am.contains(Point(lo, la)):
            continue
        t = el.get("tags", {})
        pontos.append({"lat": round(la, 5), "lon": round(lo, 5),
                       "nome": t.get("name") or ("Aterro/lixão" if t.get("landuse") == "landfill" else "Ponto de descarte de resíduos"),
                       "tipo": t.get("landuse") or t.get("amenity"),
                       "municipio": (geo.municipio_de(la, lo) or "").title(),
                       "fonte": "OpenStreetMap", "osm": f'https://www.openstreetmap.org/{el["type"]}/{el["id"]}'})
    if atual and len(pontos) < len(atual.get("pontos", [])):   # servidor do OSM às vezes devolve menos
        return atual
    saida = {"t": time.time(), "fonte": "OpenStreetMap (colaborativo, incompleto)", "pontos": pontos}
    ARQ.write_text(json.dumps(saida, ensure_ascii=False, separators=(",", ":")))
    return saida


def marcar(eventos, base):
    """Anota e["det"]["lixao"] quando o centro do evento está a até 1 km de um lixão."""
    pts = (base or {}).get("pontos", [])
    if not pts:
        return 0
    n = 0
    for e in eventos:
        melhor = None
        for p in pts:
            if abs(p["lat"] - e["lat"]) > 0.05 or abs(p["lon"] - e["lon"]) > 0.05:
                continue
            d = math.hypot((p["lat"] - e["lat"]) * 111.32,
                           (p["lon"] - e["lon"]) * 111.32 * math.cos(math.radians(e["lat"])))
            if d <= RAIO_KM and (melhor is None or d < melhor[0]):
                melhor = (d, p)
        if melhor:
            e["det"]["lixao"] = {"nome": melhor[1]["nome"], "dist_m": round(melhor[0] * 1000), "fonte": melhor[1].get("fonte")}
            n += 1
        else:
            e["det"].pop("lixao", None)
    return n
