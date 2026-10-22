"""Território do evento: uso e cobertura da terra e histórico de fogo (MapBiomas) e relevo (Copernicus DEM).

Lê só o recorte de 500 m em volta do centro de cada evento, direto dos arquivos COG públicos
(sem baixar o Brasil inteiro). Resultado em cache por evento; os novos entram aos poucos, por ciclo.

  MapBiomas Coleção 10 (uso e cobertura, 30 m, 1985–2024) e MapBiomas Fogo Coleção 5 (1985–2025).
  Souza, C. M. et al. (2020) Reconstructing three decades of land use and land cover changes in
  Brazilian biomes with Landsat archive and Earth Engine. Remote Sensing 12(17):2735.
  Copernicus DEM GLO-30 (ESA), cópia aberta na AWS.
"""
import json
import math
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import numpy as np

from . import config

os.environ.setdefault("GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR")
os.environ.setdefault("GDAL_HTTP_MAX_RETRY", "3")
os.environ.setdefault("GDAL_HTTP_TIMEOUT", "30")
os.environ.setdefault("CPL_VSIL_CURL_ALLOWED_EXTENSIONS", ".tif")
os.environ.setdefault("VSI_CACHE", "TRUE")

MB = "https://storage.googleapis.com/mapbiomas-public/initiatives/brasil"
COBERTURA = MB + "/collection_10/lulc/coverage/brazil_coverage_{ano}.tif"
FREQUENCIA = MB + "/collection_10/fire-col5/mapbiomas_fire_collection5_fire_frequency_v1/fire_frequency_1985_{ano}.tif"
ULTIMO_FOGO = MB + "/collection_10/fire-col5/mapbiomas_fire_collection5_year_last_fire_v1/year_last_fire_{ano}.tif"
DEM = "https://copernicus-dem-30m.s3.amazonaws.com/{n}/{n}.tif"
ANO_MAX_COB, ANO_MAX_FOGO = 2024, 2025
ANOS_CONVERSAO = 5
RAIO_M = 500
CACHE = config.ESTADO / "territorio_eventos.json"
MAX_SEGUNDOS = 150          # orçamento por ciclo; o resto fica para os próximos

# legenda MapBiomas Coleção 10 → grupos usados nas hipóteses
CLASSES = {3: "Formação florestal", 4: "Formação savânica", 5: "Mangue", 6: "Floresta alagável", 49: "Restinga arbórea",
           11: "Campo alagado e área pantanosa", 12: "Formação campestre", 32: "Apicum", 29: "Afloramento rochoso",
           50: "Restinga herbácea", 13: "Outra formação não florestal", 15: "Pastagem", 9: "Silvicultura",
           19: "Lavoura temporária", 39: "Soja", 20: "Cana", 40: "Arroz", 62: "Algodão", 41: "Outras lavouras temporárias",
           36: "Lavoura perene", 46: "Café", 47: "Citrus", 35: "Dendê", 48: "Outras lavouras perenes",
           21: "Mosaico de usos", 23: "Praia, duna e areal", 24: "Área urbanizada", 30: "Mineração",
           25: "Outra área não vegetada", 33: "Rio, lago e oceano", 31: "Aquicultura", 27: "Não observado"}
GRUPO = {**{c: "floresta" for c in (3, 4, 5, 6, 49)}, **{c: "natural_nao_florestal" for c in (11, 12, 32, 29, 50, 13)},
         15: "pastagem", **{c: "agricultura" for c in (9, 19, 39, 20, 40, 62, 41, 36, 46, 47, 35, 48)},
         21: "mosaico", 24: "urbano", 30: "mineracao", **{c: "agua" for c in (33, 31)}, 23: "nao_vegetado", 25: "nao_vegetado"}
ANTROPICO = ("pastagem", "agricultura", "mosaico", "urbano", "mineracao", "nao_vegetado")

_local = threading.local()


def _abrir(url):
    import rasterio
    cache = getattr(_local, "abertos", None)
    if cache is None:
        cache = _local.abertos = {}
    if url not in cache:
        cache[url] = rasterio.open("/vsicurl/" + url)
    return cache[url]


def _recorte(url, lat, lon, raio_m=RAIO_M):
    """Pixels dentro do círculo de raio_m em volta do ponto (máscara circular). Até 3 tentativas (rede)."""
    for k in range(3):
        try:
            return _recorte1(url, lat, lon, raio_m)
        except Exception:
            getattr(_local, "abertos", {}).pop(url, None)
            if k == 2:
                raise
            time.sleep(2 * (k + 1))


def _recorte1(url, lat, lon, raio_m):
    from rasterio.windows import from_bounds
    r = _abrir(url)
    dla = raio_m / 111320
    dlo = dla / max(math.cos(math.radians(lat)), 0.2)
    w = from_bounds(lon - dlo, lat - dla, lon + dlo, lat + dla, r.transform).round_offsets().round_lengths()
    a = r.read(1, window=w, boundless=True, fill_value=0)
    ny, nx = a.shape
    yy, xx = np.mgrid[0:ny, 0:nx]
    cy, cx = (ny - 1) / 2, (nx - 1) / 2
    dentro = ((yy - cy) / max(cy, 1)) ** 2 + ((xx - cx) / max(cx, 1)) ** 2 <= 1
    return a, dentro, abs(r.res[0]) * 111320 * abs(r.res[1]) * 111320 * math.cos(math.radians(lat))


def _cobertura(ano, lat, lon):
    a, m, px_m2 = _recorte(COBERTURA.format(ano=ano), lat, lon)
    v = a[m]
    v = v[v > 0]
    if not len(v):
        return None
    cls, n = np.unique(v, return_counts=True)
    tot = n.sum()
    grupos = {}
    for c, k in zip(cls.tolist(), n.tolist()):
        g = GRUPO.get(c, "outros")
        grupos[g] = grupos.get(g, 0) + k
    dom = int(cls[n.argmax()])
    return {"ano": ano, "classe_dominante": CLASSES.get(dom, str(dom)), "grupo_dominante": GRUPO.get(dom, "outros"),
            "fracao": {g: round(k / tot, 3) for g, k in sorted(grupos.items(), key=lambda x: -x[1])},
            "classes": {CLASSES.get(c, str(c)): round(k / tot, 3) for c, k in sorted(zip(cls.tolist(), n.tolist()), key=lambda x: -x[1])[:5]},
            "pixel_ha": round(px_m2 / 1e4, 4), "n_pixels": int(tot)}


def _dem(lat, lon):
    n = f"Copernicus_DSM_COG_10_{'S' if lat < 0 else 'N'}{abs(math.floor(lat)):02d}_00_{'W' if lon < 0 else 'E'}{abs(math.floor(lon)):03d}_00_DEM"
    a, m, _ = _recorte(DEM.format(n=n), lat, lon, 300)
    a = a.astype(float)
    if not m.any() or not np.isfinite(a[m]).any():
        return None
    passo = 30.0
    gy, gx = np.gradient(a, passo)
    dec = np.degrees(np.arctan(np.hypot(gx, gy)))[m]
    return {"altitude_m": round(float(np.median(a[m])), 1), "amplitude_m": round(float(np.ptp(a[m])), 1),
            "declividade_media_graus": round(float(np.mean(dec)), 1), "declividade_p90_graus": round(float(np.percentile(dec, 90)), 1)}


def analisar(e):
    """Uso da terra no ano anterior ao fogo e 5 anos antes, histórico de fogo até o ano anterior, relevo."""
    lat, lon, ano = e["lat"], e["lon"], int(e["inicio"][:4])
    ref = min(ano - 1, ANO_MAX_COB)
    antes = ref - ANOS_CONVERSAO
    r = {"raio_m": RAIO_M, "fonte": "MapBiomas Coleção 10 e MapBiomas Fogo Coleção 5; Copernicus DEM GLO-30"}
    r["cobertura"] = _cobertura(ref, lat, lon)
    r["cobertura_antes"] = _cobertura(antes, lat, lon)
    ano_fogo = min(ano - 1, ANO_MAX_FOGO)
    a, m, px = _recorte(FREQUENCIA.format(ano=ano_fogo), lat, lon)
    f = a[m]
    u, _, _ = _recorte(ULTIMO_FOGO.format(ano=ano_fogo), lat, lon)
    ul = u[m]
    ul = ul[ul > 0]
    r["fogo_historico"] = {"ate": ano_fogo, "anos_max": int(f.max()) if f.size else 0, "anos_mediana": float(np.median(f)) if f.size else 0,
                           "anos_p90": float(np.percentile(f, 90)) if f.size else 0,
                           "fracao_ja_queimada": round(float((f > 0).mean()), 3) if f.size else 0,
                           "ultimo_ano": int(ul.max()) if ul.size else None}
    try:
        r["relevo"] = _dem(lat, lon)
    except Exception as exc:
        r["relevo"] = None
        r["erro_relevo"] = type(exc).__name__
    c0, c1 = r["cobertura_antes"] or {}, r["cobertura"] or {}
    fl0, fl1 = (c0.get("fracao") or {}).get("floresta", 0), (c1.get("fracao") or {}).get("floresta", 0)
    antr1 = sum((c1.get("fracao") or {}).get(g, 0) for g in ANTROPICO)
    if c0 and c1 and fl0 >= 0.5 and fl0 - fl1 >= 0.2 and antr1 >= 0.2:
        r["conversao"] = {"de": antes, "ate": ref, "floresta_antes": fl0, "floresta_depois": fl1,
                          "ha_convertidos": round((fl0 - fl1) * c1["n_pixels"] * c1["pixel_ha"], 1),
                          "para": max(((g, (c1["fracao"] or {}).get(g, 0)) for g in ANTROPICO), key=lambda x: x[1])[0]}
    return r


def _enxuto(r):
    """Só o que o painel e o relatório usam (o arquivo de eventos vai para o celular)."""
    cob = lambda c: c and {k: c[k] for k in ("ano", "classe_dominante", "fracao")}
    return {"raio_m": r.get("raio_m"), "cobertura": cob(r.get("cobertura")), "cobertura_antes": cob(r.get("cobertura_antes")),
            "fogo_historico": r.get("fogo_historico"), "relevo": r.get("relevo"), "conversao": r.get("conversao")}


def _tentar_dem(e):
    try:
        return _dem(e["lat"], e["lon"])
    except Exception:
        return None


def _carregar():
    try:
        return json.load(open(CACHE))
    except Exception:
        return {}


def enriquecer(eventos, score_min=50):
    """Acrescenta e["det"]["territorio"]; consulta só os eventos que faltam, por ordem de prioridade."""
    cache = _carregar()
    faltam = sorted([e for e in eventos if e["id"] not in cache and (e["score"] >= score_min or e.get("trilha") == "tempo_real")],
                    key=lambda e: (e.get("trilha") != "tempo_real", -e["score"], e["inicio"]), reverse=False)
    t0, feitos = time.time(), 0

    def um(e):
        if time.time() - t0 > MAX_SEGUNDOS:
            return e, None
        try:
            return e, analisar(e)
        except Exception as exc:
            print("território: falha", e["id"], type(exc).__name__, str(exc)[:120])
            return e, None

    with ThreadPoolExecutor(6) as ex:
        for e, r in ex.map(um, faltam[:400]):
            if r:
                cache[e["id"]] = r
                feitos += 1
        # relevo que falhou por rede: tenta de novo (leitura barata)
        sem_relevo = [e for e in eventos if e["id"] in cache and cache[e["id"]].get("erro_relevo")][:60]
        for e, rv in ex.map(lambda e: (e, _tentar_dem(e)), sem_relevo):
            if rv:
                cache[e["id"]]["relevo"] = rv
                cache[e["id"]].pop("erro_relevo", None)
    json.dump(cache, open(CACHE, "w"), ensure_ascii=False)
    n = 0
    for e in eventos:
        if e["id"] in cache:
            e["det"]["territorio"] = _enxuto(cache[e["id"]])
            n += 1
    return f"{feitos} novos, {n} com território"


def aplicar(lista):
    """Indicadores a partir do território. Conversão recente de floresta entra na prioridade
    (como o desmatamento do DETER); o histórico de fogo do MapBiomas reforça a reincidência."""
    for e in lista:
        t = e["det"].get("territorio")
        if not t:
            continue
        ind = set(e["indicadores"])
        if t.get("conversao"):
            ind.add("conversao_florestal")
        fh = t.get("fogo_historico") or {}
        if fh.get("anos_p90", 0) >= 3:   # ao menos 10% da área queimou em 3+ anos
            ind.add("reincidencia")
        e["indicadores"] = sorted(ind)
        e["score"] = min(100, sum(config.PESOS[k] for k in ind))
    return lista
