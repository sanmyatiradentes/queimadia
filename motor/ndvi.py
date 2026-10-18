"""Análise de NDVI sob demanda (mesmo método do serviço ambiental do PolicIA).

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
os.environ.setdefault("CPL_VSIL_CURL_ALLOWED_EXTENSIONS", ".tif")

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


def mascara_circulo(shape, frac_raio):
    h, w = shape
    yy, xx = np.ogrid[:h, :w]
    return ((yy - (h - 1) / 2) / (h / 2)) ** 2 + ((xx - (w - 1) / 2) / (w / 2)) ** 2 <= frac_raio ** 2


# ------------------------------------------------------------------ cenas
def _data(it):
    return it.datetime.date()


def buscar_cenas(lat, lon, inicio, fim, colecoes=("sentinel-2-l2a", "landsat-c2-l2"), modo="mes", nuvem_max=70):
    """Lista as cenas que cobrem o ponto. modo='mes': a menos nublada de cada mês
    por coleção (como no PolicIA); modo='todas': todas as datas."""
    saida = []
    for col in colecoes:
        q = {"eo:cloud_cover": {"lt": nuvem_max}}
        if col == "landsat-c2-l2":
            q["platform"] = {"in": ["landsat-8", "landsat-9"]}
            q["landsat:collection_category"] = {"eq": "T1"}
        itens = catalogo().search(collections=[col], intersects={"type": "Point", "coordinates": [lon, lat]},
                                  datetime=f"{inicio}/{fim}", query=q).items()
        por_chave = {}
        for it in itens:
            k = it.datetime.strftime("%Y-%m") if modo == "mes" else str(_data(it))
            if k not in por_chave or it.properties["eo:cloud_cover"] < por_chave[k].properties["eo:cloud_cover"]:
                por_chave[k] = it
        for it in por_chave.values():
            saida.append({"id": it.id, "colecao": col, "data": str(_data(it)),
                          "nuvem_cena": round(it.properties.get("eo:cloud_cover", 0), 1),
                          "plataforma": it.properties.get("platform"),
                          "baseline": it.properties.get("s2:processing_baseline")})
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
def medir_cena(colecao, item_id, lat, lon, raio_m=600):
    """NDVI/NBR/NDMI (mediana) dos pixels válidos num círculo de raio_m."""
    t0 = time.time()
    item = obter_item(colecao, item_id)
    res = COLECOES[colecao]["res"] if raio_m > 1500 else 10
    b = caixa(lat, lon, 2 * raio_m)
    sh = forma_janela(b, res)
    d = ler(item, colecao, b, ["red", "nir", "swir1", "swir2", "mascara"], sh)
    idx, bom = indices(d, colecao)
    circ = mascara_circulo(sh, 1.0)
    validos = circ & bom & np.isfinite(idx["ndvi"])
    frac = float(validos.sum() / circ.sum())
    saida = {"id": item_id, "colecao": colecao, "data": str(_data(item)),
             "baseline": item.properties.get("s2:processing_baseline"),
             "frac_valida": round(frac, 3), "n_validos": int(validos.sum()), "segundos": round(time.time() - t0, 1)}
    if validos.sum() >= 5:
        for k, v in idx.items():
            x = v[validos]
            x = x[np.isfinite(x)]
            if x.size:
                saida[k] = round(float(np.clip(np.median(x), -1, 1)), 4)
                saida[k + "_p10"] = round(float(np.percentile(x, 10)), 4)
                saida[k + "_p90"] = round(float(np.percentile(x, 90)), 4)
    return saida


def detectar_quebra(serie, ref_ini=None, ref_fim=None):
    """Método do PolicIA (servico-ambiental/ndvi.py): base = mediana do período de
    referência; limiar = base − max(3·desvio, 0,15); quebra = 1ª de ≥2
    observações seguidas abaixo do limiar. A data é dada como intervalo."""
    serie = [p for p in serie if p.get("ndvi") is not None]
    if len(serie) < 6:
        return {"detectada": False, "motivo": "Série curta demais para avaliar quebra."}
    vals = [p["ndvi"] for p in serie]
    datas = [p["data"] for p in serie]
    if ref_ini and ref_fim:
        base_idx = [i for i, p in enumerate(serie) if ref_ini <= p["data"] <= ref_fim]
    else:
        base_idx = list(range(max(3, len(serie) // 3)))
    base_vals = [vals[i] for i in base_idx] or vals[: len(vals) // 3]
    base = median(base_vals)
    desv = float(np.std(base_vals)) if len(base_vals) > 1 else 0.05
    limiar = base - max(3 * desv, 0.15)
    ini_busca = (base_idx[-1] + 1) if base_idx else len(vals) // 3
    comum = {"ndvi_base": round(base, 4), "desvio_base": round(desv, 4), "limiar": round(limiar, 4),
             "n_base": len(base_vals)}
    for i in range(ini_busca, len(vals) - 1):
        if vals[i] < limiar and vals[i + 1] < limiar:
            apos = median(vals[i:i + 3])
            return {**comum, "detectada": True,
                    "data_ultima_estavel": datas[i - 1] if i > 0 else datas[0],
                    "data_primeira_abaixo": datas[i], "ndvi_apos": round(apos, 4),
                    "queda": round(base - apos, 4),
                    "criterio": f"NDVI < {limiar:.3f} (base {base:.3f} − max(3·{desv:.3f}; 0,15)) em ≥2 observações seguidas"}
    return {**comum, "detectada": False, "motivo": "Sem queda sustentada abaixo do limiar da linha de base."}


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


def _png(rgb, marcar_centro=None):
    im = Image.fromarray(rgb)
    if marcar_centro:
        from PIL import ImageDraw
        dr = ImageDraw.Draw(im)
        h, w = rgb.shape[:2]
        r = marcar_centro * w / 2
        dr.ellipse([w / 2 - r, h / 2 - r, w / 2 + r, h / 2 + r], outline=(255, 255, 255), width=2)
    buf = io.BytesIO()
    im.save(buf, "PNG", optimize=True)
    return buf.getvalue()


def imagem(colecao, item_id, lat, lon, lado_m=4000, produto="rgb", raio_m=None):
    """PNG do recorte: produto ∈ rgb, falsacor (SWIR-NIR-Red), ndvi, nbr, ndmi."""
    item = obter_item(colecao, item_id)
    b = caixa(lat, lon, lado_m)
    sh = forma_janela(b, 10)
    if max(sh) > 800:
        f = 800 / max(sh)
        sh = (int(sh[0] * f), int(sh[1] * f))
    centro = raio_m * 2 / lado_m if raio_m else None
    if produto in ("rgb", "falsacor"):
        ch = ["red", "green", "blue"] if produto == "rgb" else ["swir2", "nir", "red"]
        d = ler(item, colecao, b, ch, sh)
        rgb = np.dstack([d[c] for c in ch])
        rgb = np.clip(np.nan_to_num(rgb) / (0.18 if produto == "rgb" else 0.45), 0, 1) ** (1 / 1.4)
        return _png((rgb * 255).astype("uint8"), centro)
    d = ler(item, colecao, b, ["red", "nir", "swir1", "swir2", "mascara"], sh)
    idx, _ = indices(d, colecao)
    faixas = {"ndvi": (0, 0.9), "nbr": (-0.3, 0.8), "ndmi": (-0.3, 0.6)}
    return _png(colorir(idx[produto], produto, *faixas[produto]), centro)


def dnbr(col_a, id_a, col_b, id_b, lat, lon, lado_m=4000, raio_m=None):
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
    circ = mascara_circulo(sh, raio_m * 2 / lado_m) if raio_m else np.ones(sh, bool)
    v = dn[circ & np.isfinite(dn)]
    stats = {"areas_ha": areas, "queimado_ha": round(float((dn >= 0.27).sum()) * pix_ha, 1),
             "dnbr_mediana_nucleo": round(float(np.median(v)), 3) if v.size else None,
             "cobertura_valida": round(float(np.isfinite(dn).mean()), 3), "pixel_ha": round(pix_ha, 4)}
    return _png(rgb, raio_m * 2 / lado_m if raio_m else None), stats


# ------------------------------------------------------------------ mosaicos
_mosaicos = {}


def mosaico(dias=45, nuvem=20):
    """Registra no Planetary Computer uma busca Sentinel-2 recente sobre o AM e
    devolve os modelos de URL de tiles (cor real e NDVI). Cache de 6 h."""
    chave = (dias, nuvem)
    if chave in _mosaicos and time.time() - _mosaicos[chave]["t"] < 6 * 3600:
        return _mosaicos[chave]["r"]
    fim = datetime.now(timezone.utc)
    ini = fim - timedelta(days=dias)
    corpo = {"collections": ["sentinel-2-l2a"], "filter-lang": "cql2-json",
             "filter": {"op": "and", "args": [
                 {"op": "anyinteracts", "args": [{"property": "datetime"},
                                                 {"interval": [ini.strftime("%Y-%m-%dT00:00:00Z"), fim.strftime("%Y-%m-%dT23:59:59Z")]}]},
                 {"op": "<=", "args": [{"property": "eo:cloud_cover"}, nuvem]},
                 {"op": "s_intersects", "args": [{"property": "geometry"},
                                                 {"type": "Polygon", "coordinates": [[[-74, -10], [-56, -10], [-56, 2.5], [-74, 2.5], [-74, -10]]]}]}]},
             "sortby": [{"field": "eo:cloud_cover", "direction": "asc"}]}
    sid = requests.post(f"{PC_DATA}/mosaic/register", json=corpo, timeout=60).json()["searchid"]
    base = f"{PC_DATA}/mosaic/tiles/{sid}/WebMercatorQuad/{{z}}/{{x}}/{{y}}@1x?collection=sentinel-2-l2a&nodata=0"
    r = {"searchid": sid, "periodo": [ini.strftime("%Y-%m-%d"), fim.strftime("%Y-%m-%d")], "nuvem_max": nuvem,
         "rgb": base + "&assets=B04&assets=B03&assets=B02&color_formula=Gamma+RGB+3.2+Saturation+0.8+Sigmoidal+RGB+25+0.35",
         "ndvi": base + "&expression=(B08-B04)/(B08%2BB04)&asset_as_band=true&rescale=0,0.9&colormap_name=rdylgn",
         "falsacor": base + "&assets=B12&assets=B08&assets=B04&color_formula=Gamma+RGB+2.2+Saturation+1.1+Sigmoidal+RGB+15+0.4"}
    _mosaicos[chave] = {"t": time.time(), "r": r}
    return r
