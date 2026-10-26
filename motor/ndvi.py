"""Análise de NDVI sob demanda: limiar de 3σ com a confirmação do CCDC (Zhu & Woodcock, 2014).

Cada função faz uma tarefa curta (listar cenas, medir uma cena, gerar uma
imagem), para que o painel orquestre em paralelo e mostre o progresso. Isso
também cabe no limite de tempo de funções serverless.

Fórmulas (reflectância de superfície):
  NDVI = (NIR − Red) / (NIR + Red)        S2: B08, B04   Landsat: nir08, red
  NBR  = (NIR − SWIR2) / (NIR + SWIR2)    S2: B08, B12   Landsat: nir08, swir22
  NDMI = (NIR − SWIR1) / (NIR + SWIR1)    S2: B08, B11   Landsat: nir08, swir16
  dNBR = NBR_antes − NBR_depois           (Key & Benson; classes USGS)
Escalas:
  Sentinel-2 L2A: (DN − 1000)/10000 se s2:processing_baseline ≥ 04.00, senão DN/10000
  Landsat C2 L2:  DN · 0,0000275 − 0,2
Máscaras:
  Sentinel-2: SCL ∈ {4 vegetação, 5 solo, 6 água, 7 não classificado}
  Landsat:    QA_PIXEL sem bits 1,2,3,4,5 e com bit 6 (claro) ou 7 (água); só Tier 1
"""
import io
import json
import math
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone
from statistics import median

import numpy as np

# A função Python da Vercel não tem a libexpat do sistema, exigida pelo GDAL do
# rasterio. Carregamos a cópia em motor/lib antes de importar o rasterio.
if sys.platform.startswith("linux"):
    import ctypes
    from pathlib import Path as _P
    _expat = _P(__file__).resolve().parent / "lib" / "libexpat.so.1"
    if _expat.exists():
        try:
            ctypes.CDLL("libexpat.so.1")
        except OSError:
            ctypes.CDLL(str(_expat), mode=ctypes.RTLD_GLOBAL)

import planetary_computer as pc
import pystac_client
import rasterio
from rasterio.enums import Resampling
from rasterio.warp import transform_bounds
from rasterio.windows import from_bounds
from PIL import Image
import requests

os.environ.setdefault("GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR")
os.environ.setdefault("GDAL_HTTP_MULTIPLEX", "YES")
os.environ.setdefault("GDAL_HTTP_MERGE_CONSECUTIVE_RANGES", "YES")
os.environ.setdefault("CPL_VSIL_CURL_ALLOWED_EXTENSIONS", ".tif,.tiff")
# leituras remotas nunca podem travar o ciclo: limite de tempo e novas tentativas
os.environ.setdefault("GDAL_HTTP_TIMEOUT", "45")
os.environ.setdefault("GDAL_HTTP_CONNECTTIMEOUT", "15")
os.environ.setdefault("GDAL_HTTP_MAX_RETRY", "3")
os.environ.setdefault("GDAL_HTTP_RETRY_DELAY", "2")

STAC = "https://planetarycomputer.microsoft.com/api/stac/v1"
PC_DATA = "https://planetarycomputer.microsoft.com/api/data/v1"

COLECOES = {
    "sentinel-2-l2a": {"red": "B04", "green": "B03", "blue": "B02", "nir": "B08", "swir1": "B11", "swir2": "B12",
                       "mascara": "SCL", "res": 10, "rotulo": "Sentinel-2"},
    "landsat-c2-l2": {"red": "red", "green": "green", "blue": "blue", "nir": "nir08", "swir1": "swir16",
                      "swir2": "swir22", "mascara": "qa_pixel", "res": 30, "rotulo": "Landsat 8/9",
                      "escala": 0.0000275, "offset": -0.2},
}
SCL_VALIDO = [4, 5, 6, 7]
DNBR_CLASSES = [(-9, 0.1, "Não queimado", "#1a9850"), (0.1, 0.27, "Baixa", "#fee08b"),
                (0.27, 0.44, "Moderada-baixa", "#fdae61"), (0.44, 0.66, "Moderada-alta", "#f46d43"),
                (0.66, 9, "Alta", "#a50026")]

_cat = None


def catalogo():
    global _cat
    if _cat is None:
        _cat = pystac_client.Client.open(STAC, modifier=pc.sign_inplace)
    return _cat


# ------------------------------------------------------------------ geometria
def caixa(lat, lon, lado_m):
    g = lado_m / 2 / 111320.0
    c = max(0.1, math.cos(math.radians(lat)))
    return (lon - g / c, lat - g, lon + g / c, lat + g)


def forma_janela(bounds, res):
    lon0, lat0, lon1, lat1 = bounds
    h = (lat1 - lat0) * 111320.0 / res
    w = (lon1 - lon0) * 111320.0 * math.cos(math.radians((lat0 + lat1) / 2)) / res
    return max(8, int(round(h))), max(8, int(round(w)))


def ler_poligono(txt):
    """'lon,lat;lon,lat;...' → lista de (lon, lat). Até 300 vértices; None se vazio ou inválido."""
    if not txt:
        return None
    try:
        pts = [tuple(float(v) for v in par.split(",")) for par in str(txt).split(";") if par.strip()]
    except ValueError:
        return None
    if len(pts) < 3 or len(pts) > 300 or any(len(p) != 2 or not (-80 < p[0] < -40 and -20 < p[1] < 10) for p in pts):
        return None
    return pts


def caixa_poligono(poli, folga=0.15, minimo_m=300):
    xs, ys = [p[0] for p in poli], [p[1] for p in poli]
    lat = (min(ys) + max(ys)) / 2
    dx, dy = max(xs) - min(xs), max(ys) - min(ys)
    m = minimo_m / 111320.0
    dx, dy = max(dx, m / max(0.1, math.cos(math.radians(lat)))), max(dy, m)
    return (min(xs) - dx * folga, min(ys) - dy * folga, max(xs) + dx * folga, max(ys) + dy * folga)


def mascara_poligono(bounds, shape, poli):
    from rasterio.features import geometry_mask
    from rasterio.transform import from_bounds
    t = from_bounds(*bounds, shape[1], shape[0])
    anel = list(poli) + [poli[0]]
    return geometry_mask([{"type": "Polygon", "coordinates": [anel]}], out_shape=shape, transform=t, invert=True, all_touched=True)


def mascara_circulo(shape, frac_raio):
    h, w = shape
    yy, xx = np.ogrid[:h, :w]
    return ((yy - (h - 1) / 2) / (h / 2)) ** 2 + ((xx - (w - 1) / 2) / (w / 2)) ** 2 <= frac_raio ** 2


# ------------------------------------------------------------------ cenas
def _data(it):
    return it.datetime.date()


def limpeza_local(colecao, item, lat, lon, raio_m=600):
    """Fração do círculo de análise sem nuvem/sombra (0–1), lendo só a máscara."""
    try:
        res = 20 if colecao == "sentinel-2-l2a" else 30
        b = caixa(lat, lon, 2 * raio_m)
        sh = forma_janela(b, res)
        m = ler(item, colecao, b, ["mascara"], sh)["mascara"]
        circ = mascara_circulo(sh, 1.0)
        return float(mascara_boa(colecao, m)[circ].mean())
    except Exception:
        return 0.0


def buscar_cenas(lat, lon, inicio, fim, colecoes=("sentinel-2-l2a", "landsat-c2-l2"), modo="mes", nuvem_max=70,
                 raio_m=None, candidatas=4):
    """Lista as cenas que cobrem o ponto. modo='mes': uma por mês e coleção. Com
    raio_m, entre as `candidatas` menos nubladas, considera só as com >= 80% da
    ÁREA limpa (máscara) e fica com a de menor nuvem na cena; sem raio_m, a de
    menor nuvem na cena. modo='todas': todas as datas."""
    saida = []
    for col in colecoes:
        q = {"eo:cloud_cover": {"lt": nuvem_max}}
        if col == "landsat-c2-l2":
            q["platform"] = {"in": ["landsat-8", "landsat-9"]}
            q["landsat:collection_category"] = {"eq": "T1"}
        itens = catalogo().search(collections=[col], intersects={"type": "Point", "coordinates": [lon, lat]},
                                  datetime=f"{inicio}/{fim}", query=q).items()
        grupos = {}
        for it in itens:
            k = it.datetime.strftime("%Y-%m") if modo == "mes" else str(_data(it))
            grupos.setdefault(k, []).append(it)
        escolhidas, limpeza = [], {}
        if modo == "mes" and raio_m:
            tarefas = []
            for lst in grupos.values():
                lst.sort(key=lambda it: it.properties["eo:cloud_cover"])
                tarefas += lst[:candidatas]
            with ThreadPoolExecutor(16) as ex:
                for it, f in zip(tarefas, ex.map(lambda it: limpeza_local(col, it, lat, lon, raio_m), tarefas)):
                    limpeza[it.id] = f
            for lst in grupos.values():
                # área limpa (máscara) E pouca nuvem na cena: a máscara não pega névoa nem
                # nuvem fina, que acompanham cenas muito nubladas. Entre as candidatas com
                # >= 80% da área limpa, fica a de menor nuvem na cena.
                escolhidas.append(min(lst[:candidatas], key=lambda it: (limpeza[it.id] < 0.8, round(it.properties["eo:cloud_cover"] / 10),
                                                                        -limpeza[it.id])))
        else:
            escolhidas = [min(lst, key=lambda it: it.properties["eo:cloud_cover"]) for lst in grupos.values()]
        for it in escolhidas:
            saida.append({"id": it.id, "colecao": col, "data": str(_data(it)),
                          "nuvem_cena": round(it.properties.get("eo:cloud_cover", 0), 1),
                          "plataforma": it.properties.get("platform"),
                          "baseline": it.properties.get("s2:processing_baseline"),
                          # cadeia de custódia: produto de origem e versão de processamento
                          "produto": it.properties.get("s2:product_uri") or it.properties.get("landsat:scene_id"),
                          "versao": (f"L2A baseline {it.properties['s2:processing_baseline']}" if it.properties.get("s2:processing_baseline")
                                     else "Collection {} {} Tier {}".format(it.properties.get("landsat:collection_number", "02"),
                                                                           it.properties.get("landsat:correction", "L2SP"),
                                                                           str(it.properties.get("landsat:collection_category", "T1"))[-1:])
                                     if col == "landsat-c2-l2" else None),
                          "atualizado_stac": it.properties.get("updated") or it.properties.get("s2:generation_time"),
                          "limpo_area": round(limpeza[it.id], 3) if it.id in limpeza else None})
    return sorted(saida, key=lambda c: (c["data"], c["colecao"]))


def obter_item(colecao, item_id):
    url = f"{STAC}/collections/{colecao}/items/{item_id}"
    r = requests.get(url, timeout=60)
    r.raise_for_status()
    import pystac
    return pc.sign(pystac.Item.from_dict(r.json()))


# ------------------------------------------------------------------ leitura
def ler(item, col, bounds, chaves, shape):
    perfil = COLECOES[col]
    baseline = float(item.properties.get("s2:processing_baseline", "0") or 0)
    out = {}

    def uma(k):
        with rasterio.open(item.assets[perfil[k]].href) as src:
            bb = transform_bounds("EPSG:4326", src.crs, *bounds)
            win = from_bounds(*bb, transform=src.transform)
            rs = Resampling.nearest if k == "mascara" else Resampling.bilinear
            return k, src.read(1, window=win, out_shape=shape, resampling=rs, boundless=True, fill_value=0)

    with ThreadPoolExecutor(len(chaves)) as ex:
        for k, arr in ex.map(uma, chaves):
            if k == "mascara":
                out[k] = arr.astype("int64")
                continue
            arr = arr.astype("float32")
            nodata = arr == 0
            if col == "landsat-c2-l2":
                arr = arr * perfil["escala"] + perfil["offset"]
            else:
                arr = (arr - 1000 if baseline >= 4.0 else arr) / 10000.0
            arr[nodata] = np.nan
            out[k] = arr
    return out


def mascara_boa(col, m):
    if col == "landsat-c2-l2":
        ruim = ((m >> 1) & 1) | ((m >> 2) & 1) | ((m >> 3) & 1) | ((m >> 4) & 1) | ((m >> 5) & 1)
        limpo = ((m >> 6) & 1) | ((m >> 7) & 1)
        return (ruim == 0) & (limpo == 1)
    return np.isin(m, SCL_VALIDO)


def _ind(a, b):
    with np.errstate(invalid="ignore", divide="ignore"):
        return (a - b) / (a + b)


def indices(d, col):
    bom = mascara_boa(col, d["mascara"])
    r = {}
    if "red" in d:
        r["ndvi"] = _ind(d["nir"], d["red"])
    if "swir2" in d:
        r["nbr"] = _ind(d["nir"], d["swir2"])
    if "swir1" in d:
        r["ndmi"] = _ind(d["nir"], d["swir1"])
    for v in r.values():
        v[~bom] = np.nan
    return r, bom


# ------------------------------------------------------------------ medições
def medir_cena(colecao, item_id, lat, lon, raio_m=600, poli=None):
    """NDVI/NBR/NDMI (mediana) dos pixels válidos num círculo de raio_m ou num polígono desenhado."""
    t0 = time.time()
    item = obter_item(colecao, item_id)
    res = COLECOES[colecao]["res"] if raio_m > 1500 else 10
    b = caixa_poligono(poli, folga=0.02) if poli else caixa(lat, lon, 2 * raio_m)
    sh = forma_janela(b, res)
    d = ler(item, colecao, b, ["green", "red", "nir", "swir1", "swir2", "mascara"], sh)
    idx, bom = indices(d, colecao)
    circ = mascara_poligono(b, sh, poli) if poli else mascara_circulo(sh, 1.0)
    validos = circ & bom & np.isfinite(idx["ndvi"])
    frac = float(validos.sum() / circ.sum())
    saida = {"id": item_id, "colecao": colecao, "data": str(_data(item)),
             "baseline": item.properties.get("s2:processing_baseline"),
             "frac_valida": round(frac, 3), "n_validos": int(validos.sum()), "segundos": round(time.time() - t0, 1)}
    if validos.sum() >= 5:
        # reflectâncias medianas usadas pela triagem Tmask (Zhu & Woodcock, 2014)
        for banda in ("green", "swir1"):
            x = d[banda][validos]
            x = x[np.isfinite(x)]
            if x.size:
                saida["refl_" + banda] = round(float(np.median(x)), 4)
        for k, v in idx.items():
            x = v[validos]
            x = x[np.isfinite(x)]
            if x.size:
                saida[k] = round(float(np.clip(np.median(x), -1, 1)), 4)
                saida[k + "_p10"] = round(float(np.percentile(x, 10)), 4)
                saida[k + "_p90"] = round(float(np.percentile(x, 90)), 4)
    return saida


OBS_CONSECUTIVAS = 6   # critério do CCDC (Zhu & Woodcock, 2014; Arévalo et al., 2020)
QUEDA_MIN, QUEDA_MAX = 0.15, 0.30   # queda de NDVI exigida abaixo da base (3·σ robusto, limitado a esse intervalo)
TMASK_LIMIAR = 0.04    # reflectância; Tmask do CCDC (Zhu & Woodcock, 2014)


def tmask(serie, ref_ini, ref_fim):
    """Triagem multitemporal de nuvem/névoa e sombra residuais (Tmask, CCDC):
    na LINHA DE BASE, por coleção, remove a observação cujo verde passa da
    mediana + 0,04 (nuvem/névoa) ou cujo SWIR1 fica abaixo da mediana − 0,04
    (sombra). Fora da linha de base nada é removido (lá está a mudança)."""
    from statistics import median as med
    saida, removidas = [], []
    for col in {p["colecao"] for p in serie}:
        base = [p for p in serie if p["colecao"] == col and ref_ini <= p["data"] <= ref_fim
                and p.get("refl_green") is not None and p.get("refl_swir1") is not None]
        if len(base) < 4:
            continue
        mg, ms = med(p["refl_green"] for p in base), med(p["refl_swir1"] for p in base)
        for p in base:
            if p["refl_green"] > mg + TMASK_LIMIAR:
                p["tmask"] = "nuvem/névoa"
            elif p["refl_swir1"] < ms - TMASK_LIMIAR:
                p["tmask"] = "sombra"
    for p in serie:
        (removidas if p.get("tmask") else saida).append(p)
    return saida, removidas


def detectar_quebra(serie, ref_ini=None, ref_fim=None, n_consec=None):
    """Limiar estatístico com a confirmação do CCDC (Zhu & Woodcock, 2014a;
    Arévalo et al., 2020): base = mediana do período de referência; limiar = base −
    clamp(3·σ robusto, 0,15; 0,30), com σ robusto = 1,4826·MAD (Leys et al., 2013); quebra CONFIRMADA = 1ª de >= 6 observações consecutivas
    abaixo do limiar. Queda no fim da série ainda sem as 6 = mudança PROVÁVEL.
    Quedas que se recuperam antes = transitórias. A data é dada como intervalo."""
    n = int(n_consec or OBS_CONSECUTIVAS)
    serie = [p for p in serie if p.get("ndvi") is not None]
    if len(serie) < 6:
        return {"detectada": False, "situacao": "nao_detectada", "obs_consecutivas": n,
                "motivo": "Série curta demais para avaliar quebra."}
    vals = [p["ndvi"] for p in serie]
    datas = [p["data"] for p in serie]
    if ref_ini and ref_fim:
        base_idx = [i for i, p in enumerate(serie) if ref_ini <= p["data"] <= ref_fim]
    else:
        base_idx = list(range(max(3, len(serie) // 3)))
    base_vals = [vals[i] for i in base_idx] or vals[: len(vals) // 3]
    base = median(base_vals)
    # escala robusta: 1,4826 × mediana dos desvios absolutos (MAD; Leys et al., 2013), que não se deixa inflar
    # por queimadas e desmatamentos antigos na linha de base; a queda exigida fica entre 0,15 e 0,30 de NDVI
    desv = float(1.4826 * np.median(np.abs(np.array(base_vals) - base))) if len(base_vals) > 1 else 0.05
    limiar = base - min(max(3 * desv, QUEDA_MIN), QUEDA_MAX)
    comum = {"ndvi_base": round(base, 4), "desvio_base": round(desv, 4), "limiar": round(limiar, 4),
             "n_base": len(base_vals), "obs_consecutivas": n,
             "criterio": f"NDVI < {limiar:.3f} (base {base:.3f} − entre 0,15 e 0,30 de 3·{desv:.3f}, σ robusto pela MAD) em ≥{n} observações consecutivas (CCDC)"}
    i = (base_idx[-1] + 1) if base_idx else len(vals) // 3
    transitorias = []
    while i < len(vals):
        if vals[i] >= limiar:
            i += 1
            continue
        j = i
        while j < len(vals) and vals[j] < limiar:
            j += 1
        seq = j - i
        apos = median(vals[i:j])
        info = {"data_ultima_estavel": datas[i - 1] if i > 0 else datas[0], "data_primeira_abaixo": datas[i],
                "ndvi_apos": round(apos, 4), "queda": round(base - apos, 4), "obs_abaixo": seq}
        if seq >= n:
            return {**comum, **info, "detectada": True, "situacao": "confirmada", "quedas_transitorias": transitorias}
        if j == len(vals) and seq >= 2:
            return {**comum, **info, "detectada": False, "situacao": "provavel", "quedas_transitorias": transitorias,
                    "motivo": f"Queda em {seq} observação(ões) no fim da série; a confirmação exige {n} consecutivas."}
        if seq >= 2:
            transitorias.append({"de": datas[i], "ate": datas[j - 1], "obs": seq})
        i = j
    return {**comum, "detectada": False, "situacao": "nao_detectada", "quedas_transitorias": transitorias,
            "motivo": "Sem queda sustentada abaixo do limiar da linha de base."}


def escolher_periodos(validas, quebra, n=4):
    v = [m for m in validas if m["colecao"].startswith("sentinel")] or validas
    if not v:
        return []
    marcas = {v[0]["data"]: "Início", v[-1]["data"]: "Fim"}
    if quebra.get("data_primeira_abaixo"):
        antes = [m for m in v if m["data"] <= quebra["data_ultima_estavel"]]
        depois = [m for m in v if m["data"] >= quebra["data_primeira_abaixo"]]
        if antes:
            marcas[antes[-1]["data"]] = "Antes da quebra"
        if depois:
            marcas[depois[0]["data"]] = "Depois da quebra"
    j = 1
    while len(marcas) < n and j < 3 * n:
        m = v[round(j * (len(v) - 1) / n)]
        marcas.setdefault(m["data"], "")
        j += 1
    return [dict(next(m for m in v if m["data"] == d), rotulo=r) for d, r in sorted(marcas.items())]


def par_dnbr(validas, quebra, ini, fim):
    """Par de cenas para o dNBR: em volta da quebra, se houver; senão, a última antes e a primeira depois do fogo."""
    v = [m for m in validas if m.get("nbr") is not None]
    if quebra.get("data_primeira_abaixo"):
        a = [m for m in v if m["data"] <= quebra["data_ultima_estavel"]]
        b = [m for m in v if m["data"] >= quebra["data_primeira_abaixo"]]
    else:
        a = [m for m in v if m["data"] < ini]
        b = [m for m in v if m["data"] > fim]
    return (a[-1], b[0]) if a and b else None


def serie_completa(med, ref_ini, ref_fim, ini, fim, min_valido=0.5):
    """Da lista de cenas medidas ao resultado: triagem Tmask, quebra, relação com o fogo, períodos das imagens e par do dNBR."""
    validas = [m for m in med if m.get("ndvi") is not None and (m.get("frac_valida") or 0) >= min_valido]
    validas.sort(key=lambda m: (m["data"], m["colecao"]))
    validas, removidas = tmask(validas, ref_ini, ref_fim)
    q = detectar_quebra(validas, ref_ini, ref_fim)
    q["removidas_tmask"] = [{"data": m["data"], "colecao": m["colecao"], "motivo": m["tmask"], "ndvi": m["ndvi"]} for m in removidas]
    if q.get("situacao") in ("confirmada", "provavel"):
        from datetime import date, timedelta
        d = lambda s: date.fromisoformat(s[:10])
        prim, ult, i0 = d(q["data_primeira_abaixo"]), d(q["data_ultima_estavel"]), d(ini)
        q["relacao_fogo"] = ("antes_do_fogo" if prim < i0 - timedelta(days=5)
                             else "no_fogo" if ult >= i0 - timedelta(days=5) else "indefinida")
    par = par_dnbr(validas, q, ini[:10], fim[:10])
    return {"quebra": q, "n_validas": len(validas), "periodos": escolher_periodos(validas, q),
            "par_dnbr": [{k: m[k] for k in ("id", "colecao", "data")} for m in par] if par else None}

# ------------------------------------------------------------------ imagens
def _cores(nome):
    paradas = {"ndvi": [(0, (165, 0, 38)), (0.25, (244, 109, 67)), (0.45, (254, 224, 139)),
                        (0.65, (166, 217, 106)), (0.85, (26, 152, 80)), (1, (0, 104, 55))],
               "nbr": [(0, (103, 0, 13)), (0.35, (239, 59, 44)), (0.55, (254, 224, 144)),
                       (0.75, (120, 198, 121)), (1, (0, 104, 55))],
               "ndmi": [(0, (140, 81, 10)), (0.4, (246, 232, 195)), (0.6, (199, 234, 229)),
                        (1, (1, 102, 94))]}[nome]
    xs = np.array([p for p, _ in paradas])
    cs = np.array([c for _, c in paradas], dtype=float)
    return xs, cs


def colorir(arr, nome, vmin, vmax):
    xs, cs = _cores(nome)
    t = np.clip((np.nan_to_num(arr, nan=vmin) - vmin) / (vmax - vmin), 0, 1)
    rgb = np.dstack([np.interp(t, xs, cs[:, i]) for i in range(3)]).astype("uint8")
    rgb[np.isnan(arr)] = (120, 124, 132)
    return rgb


def _png(rgb, marcar_centro=None, contorno=None):
    im = Image.fromarray(rgb)
    if contorno:   # polígono desenhado: [(x_px, y_px), ...]
        from PIL import ImageDraw
        ImageDraw.Draw(im).line(list(contorno) + [contorno[0]], fill=(255, 255, 255), width=2)
    elif marcar_centro:
        from PIL import ImageDraw
        dr = ImageDraw.Draw(im)
        h, w = rgb.shape[:2]
        r = marcar_centro * w / 2
        dr.ellipse([w / 2 - r, h / 2 - r, w / 2 + r, h / 2 + r], outline=(255, 255, 255), width=2)
    buf = io.BytesIO()
    im.save(buf, "PNG", optimize=True)
    return buf.getvalue()


def _contorno_px(b, sh, poli):
    return [((x - b[0]) / (b[2] - b[0]) * sh[1], (b[3] - y) / (b[3] - b[1]) * sh[0]) for x, y in poli] if poli else None


def imagem(colecao, item_id, lat, lon, lado_m=4000, produto="rgb", raio_m=None, poli=None):
    """PNG do recorte: produto ∈ rgb, falsacor (SWIR-NIR-Red), ndvi, nbr, ndmi."""
    item = obter_item(colecao, item_id)
    b = caixa(lat, lon, lado_m)
    sh = forma_janela(b, 10)
    if max(sh) > 800:
        f = 800 / max(sh)
        sh = (int(sh[0] * f), int(sh[1] * f))
    centro = raio_m * 2 / lado_m if raio_m and not poli else None
    cont = _contorno_px(b, sh, poli)
    if produto in ("rgb", "falsacor"):
        ch = ["red", "green", "blue"] if produto == "rgb" else ["swir2", "nir", "red"]
        d = ler(item, colecao, b, ch, sh)
        rgb = np.dstack([d[c] for c in ch])
        rgb = np.clip(np.nan_to_num(rgb) / (0.18 if produto == "rgb" else 0.45), 0, 1) ** (1 / 1.4)
        return _png((rgb * 255).astype("uint8"), centro, cont)
    d = ler(item, colecao, b, ["red", "nir", "swir1", "swir2", "mascara"], sh)
    idx, _ = indices(d, colecao)
    faixas = {"ndvi": (0, 0.9), "nbr": (-0.3, 0.8), "ndmi": (-0.3, 0.6)}
    return _png(colorir(idx[produto], produto, *faixas[produto]), centro, cont)


def dnbr(col_a, id_a, col_b, id_b, lat, lon, lado_m=4000, raio_m=None, poli=None):
    """dNBR entre duas cenas (a = antes, b = depois): PNG classificado + áreas."""
    b = caixa(lat, lon, lado_m)
    sh = forma_janela(b, 10)
    if max(sh) > 800:
        f = 800 / max(sh)
        sh = (int(sh[0] * f), int(sh[1] * f))
    pix_ha = ((b[3] - b[1]) * 111320 / sh[0]) * ((b[2] - b[0]) * 111320 * math.cos(math.radians(lat)) / sh[1]) / 1e4
    with ThreadPoolExecutor(2) as ex:
        fa = ex.submit(lambda: ler(obter_item(col_a, id_a), col_a, b, ["nir", "swir2", "mascara"], sh))
        fb = ex.submit(lambda: ler(obter_item(col_b, id_b), col_b, b, ["nir", "swir2", "mascara"], sh))
        da, db = fa.result(), fb.result()
    nbr_a = _ind(da["nir"], da["swir2"]); nbr_a[~mascara_boa(col_a, da["mascara"])] = np.nan
    nbr_b = _ind(db["nir"], db["swir2"]); nbr_b[~mascara_boa(col_b, db["mascara"])] = np.nan
    dn = nbr_a - nbr_b
    rgb = np.zeros(sh + (3,), "uint8") + 120
    areas = {}
    for lo, hi, nome, cor in DNBR_CLASSES:
        sel = (dn >= lo) & (dn < hi)
        rgb[sel] = tuple(int(cor[i:i + 2], 16) for i in (1, 3, 5))
        areas[nome] = round(float(sel.sum()) * pix_ha, 1)
    circ = mascara_poligono(b, sh, poli) if poli else mascara_circulo(sh, raio_m * 2 / lado_m) if raio_m else np.ones(sh, bool)
    v = dn[circ & np.isfinite(dn)]
    stats = {"areas_ha": areas, "queimado_ha": round(float((dn >= 0.27).sum()) * pix_ha, 1),
             "dnbr_mediana_nucleo": round(float(np.median(v)), 3) if v.size else None,
             "cobertura_valida": round(float(np.isfinite(dn).mean()), 3), "pixel_ha": round(pix_ha, 4)}
    if poli:   # área queimada dentro do polígono desenhado
        stats["queimado_ha_area"] = round(float(((dn >= 0.27) & circ).sum()) * pix_ha, 1)
        stats["area_ha"] = round(float(circ.sum()) * pix_ha, 1)
    return _png(rgb, raio_m * 2 / lado_m if raio_m and not poli else None, _contorno_px(b, sh, poli)), stats


# ------------------------------------------------------------------ mosaicos
_mosaicos = {}


AM_POLIGONO = {"type": "Polygon", "coordinates": [[[-74, -10], [-56, -10], [-56, 2.5], [-74, 2.5], [-74, -10]]]}


def _registrar(colecao, ini, fim, ordem, nuvem=None):
    args = [{"op": "anyinteracts", "args": [{"property": "datetime"},
                                            {"interval": [ini.strftime("%Y-%m-%dT00:00:00Z"), fim.strftime("%Y-%m-%dT23:59:59Z")]}]},
            {"op": "s_intersects", "args": [{"property": "geometry"}, AM_POLIGONO]}]
    if nuvem is not None:
        args.append({"op": "<=", "args": [{"property": "eo:cloud_cover"}, nuvem]})
    corpo = {"collections": [colecao], "filter-lang": "cql2-json", "filter": {"op": "and", "args": args},
             "sortby": [ordem]}
    return requests.post(f"{PC_DATA}/mosaic/register", json=corpo, timeout=60).json()["searchid"]


# Realce de fogo ativo (inspirado no "Wildfires" de P. Markuse, Sentinel Hub): cor real
# e, onde o SWIR2 (B12) é muito alto e maior que SWIR1 e vermelho, pinta vermelho/laranja.
# Reflectância L2A com offset de +1000 (baseline >= 04.00, todas as cenas recentes).
_FOGO_COND = "(B12>3000)%26(B12>B11)%26(B12>B04*1.6)"
_FOGO_EXPR = (f"where({_FOGO_COND},1,((B04-1000)/2200)**0.75);"
              f"where({_FOGO_COND},(B11-1000)/6000,((B03-1000)/2200)**0.75);"
              f"where({_FOGO_COND},0,((B02-1000)/2200)**0.75)")


def mosaico(dias=45, nuvem=20):
    """Mosaicos Sentinel-2 e Sentinel-1 recentes sobre o AM (Planetary Computer) e
    os modelos de URL de tiles de cada visualização. Cache de 6 h.

    Sentinel-2 (menos nuvem primeiro): cor real, falsa-cor SWIR, NDVI, umidade
    (NDMI), água (NDWI), falsa-cor vegetação. Sentinel-2 (mais recente primeiro):
    fogo ativo. Sentinel-1 RTC (radar, enxerga através de nuvem e fumaça): composição
    VV/VH/razão em dB."""
    chave = (dias, nuvem)
    if chave in _mosaicos and time.time() - _mosaicos[chave]["t"] < 6 * 3600:
        return _mosaicos[chave]["r"]
    fim = datetime.now(timezone.utc)
    ini = fim - timedelta(days=dias)
    sid = _registrar("sentinel-2-l2a", ini, fim, {"field": "eo:cloud_cover", "direction": "asc"}, nuvem)
    base = f"{PC_DATA}/mosaic/tiles/{sid}/WebMercatorQuad/{{z}}/{{x}}/{{y}}@1x?collection=sentinel-2-l2a&nodata=0"
    expr = lambda e, faixa, cmap: base + f"&expression={e}&asset_as_band=true&rescale={faixa}&colormap_name={cmap}"
    r = {"searchid": sid, "periodo": [ini.strftime("%Y-%m-%d"), fim.strftime("%Y-%m-%d")], "nuvem_max": nuvem,
         "rgb": base + "&assets=B04&assets=B03&assets=B02&color_formula=Gamma+RGB+3.2+Saturation+0.8+Sigmoidal+RGB+25+0.35",
         "ndvi": expr("(B08-B04)/(B08%2BB04)", "0,0.9", "rdylgn"),
         "falsacor": base + "&assets=B12&assets=B08&assets=B04&color_formula=Gamma+RGB+2.2+Saturation+1.1+Sigmoidal+RGB+15+0.4",
         "vegetacao": base + "&assets=B08&assets=B04&assets=B03&color_formula=Gamma+RGB+2.6+Saturation+1.0+Sigmoidal+RGB+15+0.35",
         "ndmi": expr("(B8A-B11)/(B8A%2BB11)", "-0.4,0.6", "rdylbu"),
         "ndwi": expr("(B03-B08)/(B03%2BB08)", "-0.6,0.6", "blues")}
    try:   # fogo ativo: cenas mais recentes (até 60% de nuvem) nos últimos 15 dias
        sf = _registrar("sentinel-2-l2a", fim - timedelta(days=15), fim, {"field": "datetime", "direction": "desc"}, 60)
        r["fogo"] = (f"{PC_DATA}/mosaic/tiles/{sf}/WebMercatorQuad/{{z}}/{{x}}/{{y}}@1x?collection=sentinel-2-l2a&nodata=0"
                     f"&asset_as_band=true&expression={_FOGO_EXPR}&rescale=0,1&rescale=0,1&rescale=0,1")
        r["periodo_fogo"] = [(fim - timedelta(days=15)).strftime("%Y-%m-%d"), fim.strftime("%Y-%m-%d")]
    except Exception:
        pass
    try:   # radar Sentinel-1 RTC: cenas mais recentes dos últimos 30 dias
        s1 = _registrar("sentinel-1-rtc", fim - timedelta(days=30), fim, {"field": "datetime", "direction": "desc"})
        r["radar"] = (f"{PC_DATA}/mosaic/tiles/{s1}/WebMercatorQuad/{{z}}/{{x}}/{{y}}@1x?collection=sentinel-1-rtc&nodata=-32768"
                      "&asset_as_band=true&expression=10*log10(vv);10*log10(vh);vv/vh&rescale=-20,-3&rescale=-26,-10&rescale=2,14")
        r["periodo_radar"] = [(fim - timedelta(days=30)).strftime("%Y-%m-%d"), fim.strftime("%Y-%m-%d")]
    except Exception:
        pass
    _mosaicos[chave] = {"t": time.time(), "r": r}
    return r
