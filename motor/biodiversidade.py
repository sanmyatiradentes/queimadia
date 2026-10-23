"""Biodiversidade registrada no entorno do evento (GBIF): espécies de fauna e flora e as ameaçadas (IUCN).

Registros de ocorrência são esparsos na Amazônia: ausência de registro não é ausência de espécie.
Serve para dimensionar o dano ambiental potencial, não como prova da presença no momento do fogo.
GBIF.org — Global Biodiversity Information Facility (ocorrências com coordenadas, sem problemas geoespaciais).
"""
import json
import time

import requests

from . import config

URL = "https://api.gbif.org/v1/occurrence/search"
CACHE = config.ESTADO / "biodiversidade_eventos.json"
RAIO_KM = 10
AMEACA = {"CR": "Criticamente em perigo", "EN": "Em perigo", "VU": "Vulnerável"}
MAX_NOVOS = 80
TEMPO_S = 60          # orçamento por ciclo (o atualizador reduz nos ciclos rápidos)


def _carregar():
    try:
        return json.load(open(CACHE))
    except Exception:
        return {}


def consultar(lat, lon):
    d = RAIO_KM / 111.32
    base = {"decimalLatitude": f"{lat - d:.4f},{lat + d:.4f}", "decimalLongitude": f"{lon - d:.4f},{lon + d:.4f}",
            "hasCoordinate": "true", "hasGeospatialIssue": "false", "occurrenceStatus": "PRESENT"}
    r = requests.get(URL, params={**base, "limit": 0, "facet": ["kingdomKey", "speciesKey"], "facetLimit": 1000}, timeout=60)
    r.raise_for_status()
    j = r.json()
    fac = {f["field"]: f["counts"] for f in j.get("facets", [])}
    reinos = {c["name"]: c["count"] for c in fac.get("KINGDOM_KEY", [])}
    n_especies = len(fac.get("SPECIES_KEY", []))
    amea, vistos = [], set()
    rr = requests.get(URL, params={**base, "iucnRedListCategory": list(AMEACA), "limit": 300}, timeout=60)
    if rr.ok:
        for o in rr.json().get("results", []):
            nome = o.get("species") or o.get("scientificName")
            if nome and nome not in vistos:
                vistos.add(nome)
                amea.append({"nome": nome, "categoria": o.get("iucnRedListCategory"), "classe": o.get("class"), "reino": o.get("kingdom")})
    ordem = list(AMEACA)
    amea.sort(key=lambda a: ordem.index(a["categoria"]) if a["categoria"] in ordem else 9)
    return {"raio_km": RAIO_KM, "registros": j.get("count", 0), "especies": n_especies,
            "fauna_registros": reinos.get("1", 0), "flora_registros": reinos.get("6", 0), "ameacadas": amea[:40],
            "fonte": "GBIF.org", "consultado_em": time.strftime("%Y-%m-%d")}


def enriquecer(eventos, score_min=70):
    cache = _carregar()
    faltam = sorted([e for e in eventos if e["id"] not in cache and (e["score"] >= score_min or e.get("trilha") == "tempo_real")],
                    key=lambda e: (e.get("trilha") != "tempo_real", -e["score"]))[:MAX_NOVOS]
    feitos = 0
    t0 = time.time()
    for e in faltam:
        if time.time() - t0 > TEMPO_S:
            break
        try:
            cache[e["id"]] = consultar(e["lat"], e["lon"])
            feitos += 1
        except Exception as exc:
            print("biodiversidade: falha", type(exc).__name__)
            break
        time.sleep(0.3)
    json.dump(cache, open(CACHE, "w"), ensure_ascii=False)
    n = 0
    for e in eventos:
        if e["id"] in cache:
            e["det"]["biodiversidade"] = cache[e["id"]]
            n += 1
    return f"{feitos} novos, {n} com biodiversidade"
