"""Alertas automáticos de mudança nas áreas com fogo (Sentinel-2 + radar Sentinel-1).

Para cada evento recente com prioridade alta, compara um recorte de 3 × 3 km
antes e depois do fogo:

  Óptico (Sentinel-2 L2A, 10 m)
    antes  = mediana pixel a pixel das cenas limpas de 90 a 5 dias antes do 1º foco
    depois = mediana das cenas limpas de 1 a 60 dias depois do último foco
    mudança = pixel com vegetação antes (NDVI >= 0,6), sem água em nenhuma cena
              (NDWI < 0, exclui cheia e vazante), e depois dNBR >= 0,27 (queima
              moderada ou maior, USGS) ou ΔNDVI <= −0,20 com NDVI depois < 0,5
  Radar (Sentinel-1 RTC, 10 m; atravessa nuvem e fumaça)
    antes/depois = mediana do retroespalhamento VH (dB) das cenas nas mesmas janelas
    mudança = queda LOCAL de VH >= 3 dB (abertura de dossel), após filtro de mediana
              5 × 5 e descontada a variação mediana do recorte (efeito da seca/umidade)

Os pixels de mudança viram polígonos (mínimo 1 ha). Cada polígono informa a
fonte que o detectou (óptico, radar ou ambos), a área, as datas e as cenas
usadas. É um ALERTA para verificação, não validado por analista (diferente do
DETER e do Brasil MAIS): pode haver falso positivo por nuvem, sombra, água ou
cultivo sazonal.
"""
import json
import math
import time
import traceback
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone

import numpy as np
import pandas as pd
import rasterio
from rasterio.enums import Resampling
from rasterio.features import shapes, sieve
from rasterio.transform import from_bounds as tf_from_bounds
from rasterio.warp import transform_bounds
from rasterio.windows import from_bounds
import planetary_computer as pc
from shapely.geometry import shape, mapping
from scipy.ndimage import median_filter

from . import config, ndvi

ARQ = config.PUBLICO / "mudancas.json"
INDICE = config.ESTADO / "mudancas_indice.json"
LADO_M = 3000
RES = 10
MIN_HA = 1.0
LIM_DNBR, LIM_DNDVI, LIM_VH_DB = 0.27, -0.20, -3.0
MAX_POR_CICLO = 6
PRIORIDADE_MIN = 50
DIAS_RECENTES = 120


def _carregar(p, padrao):
    try:
        return json.load(open(p))
    except Exception:
        return padrao


def _buscar(col, lat, lon, ini, fim, q=None):
    itens = ndvi.catalogo().search(collections=[col], intersects={"type": "Point", "coordinates": [lon, lat]},
                                   datetime=f"{ini}/{fim}", query=q or {}).items()
    vistos, unicos = set(), []
    for it in sorted(itens, key=lambda i: i.datetime):
        k = (it.datetime.date(), it.properties.get("sat:orbit_state"))
        if k not in vistos:
            vistos.add(k); unicos.append(it)
    return unicos


# ------------------------------------------------------------------ óptico
def _s2_composto(lat, lon, ini, fim, bounds, sh, max_cenas=4):
    itens = _buscar("sentinel-2-l2a", lat, lon, ini, fim, {"eo:cloud_cover": {"lt": 70}})
    if not itens:
        return None
    lim = {it.id: ndvi.limpeza_local("sentinel-2-l2a", it, lat, lon, LADO_M / 2) for it in itens}
    bons = sorted([it for it in itens if lim[it.id] >= 0.5], key=lambda it: -lim[it.id])[:max_cenas]
    if not bons:
        return None
    pilha_ndvi, pilha_nbr, pilha_ndwi, usadas = [], [], [], []

    def ler_um(it):
        try:
            d = ndvi.ler(it, "sentinel-2-l2a", bounds, ["green", "red", "nir", "swir2", "mascara"], sh)
            idx, bom = ndvi.indices(d, "sentinel-2-l2a")
            with np.errstate(all="ignore"):
                idx["ndwi"] = (d["green"] - d["nir"]) / (d["green"] + d["nir"])
            idx["ndwi"][~bom] = np.nan
            return it, idx
        except Exception:
            return it, None

    with ThreadPoolExecutor(4) as ex:
        for it, idx in ex.map(ler_um, bons):
            if idx is not None:
                pilha_ndvi.append(idx["ndvi"]); pilha_nbr.append(idx["nbr"]); pilha_ndwi.append(idx["ndwi"])
                usadas.append({"id": it.id, "data": str(it.datetime.date()), "limpo": round(lim[it.id], 2)})
    if not usadas:
        return None
    with np.errstate(all="ignore"):
        return {"ndvi": np.nanmedian(np.stack(pilha_ndvi), axis=0), "nbr": np.nanmedian(np.stack(pilha_nbr), axis=0),
                "ndwi": np.nanmax(np.stack(pilha_ndwi), axis=0), "cenas": usadas}


# ------------------------------------------------------------------ radar
def _s1_vh(it, bounds, sh):
    it = pc.sign(it)
    with rasterio.open(it.assets["vh"].href) as src:
        bb = transform_bounds("EPSG:4326", src.crs, *bounds)
        win = from_bounds(*bb, transform=src.transform)
        a = src.read(1, window=win, out_shape=sh, resampling=Resampling.bilinear, boundless=True,
                     fill_value=src.nodata if src.nodata is not None else -32768).astype("float32")
    a[(a <= 0) | (a < -1000)] = np.nan
    with np.errstate(all="ignore"):
        return 10 * np.log10(a)


def _s1_composto(lat, lon, ini, fim, bounds, sh, max_cenas=3):
    itens = _buscar("sentinel-1-rtc", lat, lon, ini, fim)
    if not itens:
        return None
    itens = itens[-max_cenas:] if max_cenas else itens
    pilha, usadas = [], []
    with ThreadPoolExecutor(3) as ex:
        for it, a in zip(itens, ex.map(lambda i: _try(_s1_vh, i, bounds, sh), itens)):
            if a is not None and np.isfinite(a).mean() > 0.5:
                pilha.append(a); usadas.append({"id": it.id, "data": str(it.datetime.date()),
                                                "orbita": it.properties.get("sat:orbit_state")})
    if not pilha:
        return None
    with np.errstate(all="ignore"):
        vh = np.nanmedian(np.stack(pilha), axis=0)
    return {"vh": vh, "cenas": usadas}


def _try(f, *a):
    try:
        return f(*a)
    except Exception:
        return None


# ------------------------------------------------------------------ poligonização
def _poligonos(mascara, bounds, sh):
    m = sieve(mascara.astype("uint8"), size=int(MIN_HA * 10000 / RES ** 2), connectivity=8)
    tr = tf_from_bounds(*bounds, sh[1], sh[0])
    lat_m = 111320.0
    lon_m = 111320.0 * math.cos(math.radians((bounds[1] + bounds[3]) / 2))
    saida = []
    for geom, v in shapes(m, mask=m == 1, transform=tr, connectivity=8):
        g = shape(geom).simplify(0.00005)
        ha = abs(g.area) * lat_m * lon_m / 1e4
        if ha >= MIN_HA:
            saida.append((g, round(ha, 1)))
    return saida


def analisar(ev):
    lat, lon = ev["lat"], ev["lon"]
    ini, fim = pd.Timestamp(ev["inicio"][:10]), pd.Timestamp(ev["fim"][:10])
    hoje = pd.Timestamp(date.today())
    a_ini, a_fim = (ini - pd.Timedelta(days=90)).date(), (ini - pd.Timedelta(days=5)).date()
    d_ini, d_fim = (fim + pd.Timedelta(days=1)).date(), min(hoje, fim + pd.Timedelta(days=60)).date()
    if d_ini > hoje.date():
        return None
    bounds = ndvi.caixa(lat, lon, LADO_M)
    sh = (LADO_M // RES, LADO_M // RES)

    with ThreadPoolExecutor(4) as ex:
        f_s2a = ex.submit(_try, _s2_composto, lat, lon, a_ini, a_fim, bounds, sh)
        f_s2d = ex.submit(_try, _s2_composto, lat, lon, d_ini, d_fim, bounds, sh)
        f_s1a = ex.submit(_try, _s1_composto, lat, lon, (ini - pd.Timedelta(days=60)).date(), a_fim, bounds, sh)
        f_s1d = ex.submit(_try, _s1_composto, lat, lon, d_ini, d_fim, bounds, sh)
        s2a, s2d, s1a, s1d = f_s2a.result(), f_s2d.result(), f_s1a.result(), f_s1d.result()

    opt = np.zeros(sh, bool)
    rad = np.zeros(sh, bool)
    info = {"optico": None, "radar": None}
    if s2a and s2d:
        with np.errstate(all="ignore"):
            dnbr = s2a["nbr"] - s2d["nbr"]
            dndvi = s2d["ndvi"] - s2a["ndvi"]
        # vegetação antes (NDVI >= 0,6) e sem água em nenhuma cena (NDWI < 0): evita falso alerta
        # por cheia/vazante em várzea, rios e lagos; depois, queima (dNBR) ou perda clara de vegetação
        veg_antes = s2a["ndvi"] >= 0.6
        seco = (s2a["ndwi"] < 0) & (s2d["ndwi"] < 0)
        perda = (dndvi <= LIM_DNDVI) & (s2d["ndvi"] < 0.5)
        opt = np.nan_to_num(veg_antes & seco & ((dnbr >= LIM_DNBR) | perda), nan=0).astype(bool) & np.isfinite(dnbr)
        info["optico"] = {"antes": s2a["cenas"], "depois": s2d["cenas"],
                          "cobertura": round(float(np.isfinite(dnbr).mean()), 2)}
    if s1a and s1d:
        dvh = median_filter(np.nan_to_num(s1d["vh"] - s1a["vh"], nan=0.0), size=5)
        # desconta a variação geral da área (seca/umidade muda o sinal de toda a paisagem):
        # sobra a queda LOCAL, típica de abertura de dossel
        geral = float(np.median(dvh))
        dvh = dvh - geral
        rad = (dvh <= LIM_VH_DB) & np.isfinite(s1a["vh"]) & np.isfinite(s1d["vh"])
        info["radar"] = {"antes": s1a["cenas"], "depois": s1d["cenas"], "variacao_geral_db": round(geral, 2)}

    feats = []
    for g, ha in _poligonos(opt | rad, bounds, sh):
        # que fonte sustenta o polígono: fração dos pixels dele marcada por cada sensor
        tr = tf_from_bounds(*bounds, sh[1], sh[0])
        from rasterio.features import geometry_mask
        dentro = ~geometry_mask([mapping(g)], out_shape=sh, transform=tr)
        fo, fr = float(opt[dentro].mean()) if dentro.any() else 0, float(rad[dentro].mean()) if dentro.any() else 0
        fonte = "ambos" if fo >= 0.3 and fr >= 0.3 else ("optico" if fo >= fr else "radar")
        m = mapping(g)
        feats.append({"type": "Feature",
                      "properties": {"evento": ev["id"], "municipio": ev.get("municipio"), "ha": ha, "fonte": fonte,
                                     "frac_optico": round(fo, 2), "frac_radar": round(fr, 2),
                                     "inicio_fogo": ev["inicio"][:10], "depois_ate": str(d_fim)},
                      "geometry": {"type": m["type"], "coordinates": _arred(m["coordinates"])}})
    return {"evento": ev["id"], "lat": lat, "lon": lon, "t": time.time(),
            "gerado_em": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "janela_antes": [str(a_ini), str(a_fim)], "janela_depois": [str(d_ini), str(d_fim)],
            "area_total_ha": round(sum(f["properties"]["ha"] for f in feats), 1),
            "n_poligonos": len(feats), "fontes": info, "features": feats}


def _arred(c):
    if isinstance(c, (list, tuple)) and c and isinstance(c[0], (int, float)):
        return [round(c[0], 5), round(c[1], 5)]
    return [_arred(x) for x in c]


def ciclo(eventos, limite=MAX_POR_CICLO):
    """Analisa até `limite` eventos recentes de prioridade alta ainda sem alerta
    (ou cujo resultado tem mais de 7 dias e o fogo foi há menos de 60 dias)."""
    idx = _carregar(INDICE, {})
    hoje = pd.Timestamp(date.today())
    agora = time.time()

    def precisa(e):
        if e["score"] < PRIORIDADE_MIN or (hoje - pd.Timestamp(e["fim"][:10])).days > DIAS_RECENTES:
            return False
        if (hoje - pd.Timestamp(e["fim"][:10])).days < 1:
            return False
        r = idx.get(e["id"])
        if not r:
            return True
        return (hoje - pd.Timestamp(e["fim"][:10])).days < 60 and agora - r["t"] > 7 * 86400

    fila = sorted([e for e in eventos if precisa(e)], key=lambda e: (-e["score"], e["dist_manaus_km"]))[:limite]
    from concurrent.futures import ThreadPoolExecutor as _TP, TimeoutError as _TO
    exe = _TP(1)
    for e in fila:
        t0 = time.time()
        fut = exe.submit(analisar, e)
        try:
            r = fut.result(timeout=360)   # orçamento de 6 min por incêndio
        except _TO:
            print(f"mudança {e['id']}: tempo esgotado, fica para o próximo ciclo")
            continue
        except Exception:
            traceback.print_exc()
            continue
        if r is None:
            continue
        idx[e["id"]] = r
        print(f"mudança {e['id']} {e.get('municipio')}: {r['n_poligonos']} polígono(s), {r['area_total_ha']} ha "
              f"(óptico {'sim' if r['fontes']['optico'] else 'não'}, radar {'sim' if r['fontes']['radar'] else 'não'}, {time.time() - t0:.0f}s)")
    exe.shutdown(wait=False, cancel_futures=True)
    # publica: só eventos ainda existentes
    ids = {e["id"] for e in eventos}
    idx = {k: v for k, v in idx.items() if k in ids}
    json.dump(idx, open(INDICE, "w"))
    feats = [f for v in idx.values() for f in v["features"]]
    resumo = {k: {kk: v[kk] for kk in ("area_total_ha", "n_poligonos", "janela_antes", "janela_depois", "gerado_em")}
              | {"fontes": {s: ([c["data"] for c in v["fontes"][s]["antes"]], [c["data"] for c in v["fontes"][s]["depois"]])
                            if v["fontes"][s] else None for s in ("optico", "radar")}}
              for k, v in idx.items()}
    ARQ.write_text(json.dumps({"type": "FeatureCollection", "features": feats, "eventos": resumo,
                               "metodo": __doc__.strip().split("\n\n")[1]}, ensure_ascii=False, separators=(",", ":")))
    return len(fila)
