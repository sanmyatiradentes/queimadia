"""Estradas, vicinais e ramais do Amazonas (OpenStreetMap) e distância de cada evento até a via mais próxima.

Base colaborativa e incompleta (muitos ramais não estão mapeados): ausência de via no mapa não prova
ausência de acesso. Atualizada no máximo uma vez por semana. Publica uma versão simplificada para o mapa.
"""
import json
import math
import time

import requests
from shapely import STRtree
from shapely.geometry import LineString, Point

from . import config

ARQ = config.ESTADO / "estradas_am.json"
PUB = config.PUBLICO / "estradas.json"
SERVIDORES = ("https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter")
TIPOS = "motorway|trunk|primary|secondary|tertiary|unclassified|track"
CONSULTA = f'[out:json][timeout:300];area["ISO3166-2"="BR-AM"]->.a;way["highway"~"^({TIPOS})$"](area.a);out geom qt;'
NOME_TIPO = {"motorway": "rodovia", "trunk": "rodovia", "primary": "rodovia", "secondary": "estrada estadual/municipal",
             "tertiary": "estrada vicinal", "unclassified": "estrada vicinal", "track": "ramal"}
BUSCA_KM = 30


def tipo_via(h, nome):
    n = (nome or "").upper()
    if n.startswith("BR-") or "TRANSAMAZ" in n:
        return "rodovia federal"
    if n.startswith("AM-"):
        return "rodovia estadual"
    return NOME_TIPO.get(h, h)


def atualizar(forcar=False):
    try:
        atual = json.load(open(ARQ))
        if not forcar and time.time() - atual.get("t", 0) < 7 * 86400:
            return atual
    except Exception:
        atual = None
    dados = None
    for srv in SERVIDORES:
        try:
            r = requests.post(srv, data={"data": CONSULTA}, timeout=420, headers={"User-Agent": "FogoForense/1.0 (NIPED-PCAM)"})
            if r.ok:
                dados = r.json()
                break
        except Exception:
            continue
    if not dados:
        return atual
    linhas = []
    for el in dados.get("elements", []):
        g = el.get("geometry") or []
        if len(g) < 2:
            continue
        t = el.get("tags", {})
        ls = LineString([(p["lon"], p["lat"]) for p in g]).simplify(0.0003)
        linhas.append([t.get("highway"), t.get("name") or t.get("ref") or "", [[round(x, 5), round(y, 5)] for x, y in ls.coords]])
    if atual and len(linhas) < 0.8 * len(atual.get("linhas", [])):   # resposta parcial do servidor
        return atual
    saida = {"t": time.time(), "fonte": "OpenStreetMap (colaborativo)", "linhas": linhas}
    ARQ.write_text(json.dumps(saida, separators=(",", ":"), ensure_ascii=False))
    # versão do mapa: mais simplificada
    mapa = {"type": "FeatureCollection", "fonte": "OpenStreetMap", "features": [
        {"type": "Feature", "properties": {"t": tipo_via(h, n), "n": n},
         "geometry": {"type": "LineString", "coordinates": [[round(x, 4), round(y, 4)] for x, y in LineString(c).simplify(0.001).coords]}}
        for h, n, c in linhas]}
    PUB.write_text(json.dumps(mapa, separators=(",", ":"), ensure_ascii=False))
    return saida


def marcar(eventos, base):
    """e["det"]["estrada"] = via mais próxima (até 30 km): distância, tipo e nome."""
    linhas = (base or {}).get("linhas") or []
    if not linhas:
        return 0
    if not PUB.exists():   # garante a camada do mapa mesmo quando a base veio do cache
        try:
            atualizar(forcar=False)
        except Exception:
            pass
    geoms = [LineString(c) for _, _, c in linhas]
    arvore = STRtree(geoms)
    n = 0
    for e in eventos:
        p = Point(e["lon"], e["lat"])
        i = arvore.query_nearest(p, max_distance=BUSCA_KM / 111.32)
        if len(i) == 0:
            e["det"]["estrada"] = {"km": None, "busca_km": BUSCA_KM}
            continue
        i = int(i[0])
        # distância em km (correção da longitude pela latitude)
        q = geoms[i].interpolate(geoms[i].project(p))
        km = math.hypot((q.y - e["lat"]) * 111.32, (q.x - e["lon"]) * 111.32 * math.cos(math.radians(e["lat"])))
        h, nome, _ = linhas[i]
        e["det"]["estrada"] = {"km": round(km, 2), "tipo": tipo_via(h, nome), "nome": nome}
        n += 1
    return n
