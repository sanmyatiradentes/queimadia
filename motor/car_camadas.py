"""Cruza cada evento com as camadas declaradas no CAR (APP, Reserva Legal, área consolidada, vegetação nativa,
uso restrito, pousio), lidas das quadrículas que car_sicar.py enviou ao armazenamento privado.

Sem as camadas enviadas, não faz nada. Resultado em cache por evento.
"""
import gzip
import json
import math
import os
import time

import requests
from shapely.geometry import Point, shape

from . import config

BASE = os.environ.get("QUEIMADIA_BLOB_PRIVADO", "https://agamu57tqypirdzt.private.blob.vercel-storage.com/") + "restrito/car/"
CACHE = config.ESTADO / "car_camadas_eventos.json"
CEL = 0.25
RAIO_M = 500
TEMPO_S = 60


def _get(caminho):
    try:
        r = requests.get(BASE + caminho, headers={"Authorization": "Bearer " + os.environ.get("BLOB_READ_WRITE_TOKEN", "")}, timeout=60)
    except requests.RequestException:
        return None
    if not r.ok:
        return None
    return json.loads(gzip.decompress(r.content) if r.content[:2] == b"\x1f\x8b" else r.content)


def enriquecer(eventos, score_min=50):
    try:
        cache = json.load(open(CACHE))
    except Exception:
        cache = {}
    try:
        indice = _get("indice.json")
    except Exception:
        indice = None
    if indice and cache.get("_versao") != indice.get("gerado"):  # camadas reprocessadas: refaz o cruzamento
        cache = {"_versao": indice.get("gerado")}
    faltam = [e for e in eventos if e["id"] not in cache and (e["score"] >= score_min or e.get("trilha") == "tempo_real")]
    if indice and faltam:
        celulas, t0, feitos = {}, time.time(), 0

        def cel(cod, c):
            if (cod, c) not in celulas:
                fc = _get(f"{cod}/c_{c}.json" + (".gz" if indice.get("gz") else "")) if c in indice["camadas"][cod]["celulas"] else None
                celulas[(cod, c)] = [(shape(f["geometry"]), f["properties"]) for f in (fc or {}).get("features", [])]
            return celulas[(cod, c)]

        for e in sorted(faltam, key=lambda e: (e.get("trilha") != "tempo_real", -e["score"])):
            if time.time() - t0 > TEMPO_S:
                break
            p = Point(e["lon"], e["lat"])
            raio = RAIO_M / 111320
            circ = p.buffer(raio)
            area_circ = circ.area
            r = {}
            for cod in indice["camadas"]:
                cs = {f"{math.floor(y / CEL)}_{math.floor(x / CEL)}" for x in (e["lon"] - raio, e["lon"] + raio) for y in (e["lat"] - raio, e["lat"] + raio)}
                no_ponto, tema, frac, imoveis = None, None, 0.0, set()
                for c in cs:
                    for g, pr in cel(cod, c):
                        if not g.intersects(circ):
                            continue
                        frac += g.intersection(circ).area / area_circ
                        imoveis.add(pr.get("cod"))
                        if no_ponto is None and g.contains(p):
                            no_ponto, tema = pr.get("cod"), pr.get("tema")
                if frac > 0 or no_ponto:
                    ha_circ = math.pi * RAIO_M ** 2 / 1e4
                    r[cod] = {"no_ponto": bool(no_ponto), "imovel": no_ponto, "ha_500m": round(min(frac, 1) * ha_circ, 1), "imoveis": len(imoveis)}
                    if tema:
                        r[cod]["tema"] = indice.get("temas", {}).get(tema, tema)
            cache[e["id"]] = r
            feitos += 1
        print("CAR (camadas declaradas):", feitos, "novos")
    json.dump(cache, open(CACHE, "w"))
    n = 0
    for e in eventos:
        if cache.get(e["id"]):
            e["det"]["car_camadas"] = cache[e["id"]]
            n += 1
    return n
