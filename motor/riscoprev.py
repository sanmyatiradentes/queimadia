"""Risco de fogo previsto pelo INPE (hoje e 1 a 3 dias à frente), recortado para o Amazonas, como imagem do mapa.

INPE — Programa Queimadas, modelo de risco de fogo (grade de 0,01°, valores de 0 a 1). Atualizado a cada 6 h.
Classes do INPE: mínimo < 0,15 · baixo 0,15–0,4 · médio 0,4–0,7 · alto 0,7–0,95 · crítico ≥ 0,95.
"""
import io
import json
import os
import time

import numpy as np

from . import config

URL = "https://dataserver-coids.inpe.br/queimadas/queimadas/riscofogo_meteorologia/previsto/risco_fogo/RF.PREV.T{n}.tif"
IDX = config.PUBLICO / "risco_previsto.json"
CORES = [(0.15, (0, 0, 0, 0)), (0.4, (102, 187, 106, 110)), (0.7, (255, 213, 79, 160)), (0.95, (245, 124, 0, 190)), (9, (183, 28, 28, 215))]


def atualizar(forcar=False):
    os.environ.setdefault("GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR")
    try:
        atual = json.load(open(IDX))
        if not forcar and time.time() - atual.get("t", 0) < 6 * 3600:
            return atual
    except Exception:
        atual = None
    import rasterio
    from PIL import Image
    from rasterio.windows import from_bounds
    w, s, e, n = config.AM_BBOX
    dias = []
    for k in range(4):
        try:
            with rasterio.open("/vsicurl/" + URL.format(n=k)) as r:
                win = from_bounds(w, s, e, n, r.transform).round_offsets().round_lengths()
                a = r.read(1, window=win).astype(float)
                b = r.window_bounds(win)
                titulo = r.tags().get("NC_GLOBAL#title", "")
        except Exception as exc:
            print("risco previsto: falha T", k, type(exc).__name__)
            continue
        a[a < 0] = np.nan
        rgba = np.zeros(a.shape + (4,), dtype=np.uint8)
        lim_ant = -1
        for lim, cor in CORES:
            m = (a >= lim_ant) & (a < lim)
            rgba[m] = cor
            lim_ant = lim
        nome = f"risco_previsto_T{k}.png"
        Image.fromarray(rgba, "RGBA").save(config.PUBLICO / nome, optimize=True)
        data = "".join(ch for ch in titulo if ch.isdigit())[:8]
        dias.append({"t": k, "arquivo": nome, "data": f"{data[:4]}-{data[4:6]}-{data[6:8]}" if len(data) == 8 else None,
                     "alto_ou_critico_pct": round(float(np.nanmean(a >= 0.7) * 100), 1)})
    if not dias:
        return atual
    saida = {"t": time.time(), "fonte": "INPE — risco de fogo previsto", "limites": [b[0], b[1], b[2], b[3]], "dias": dias}
    IDX.write_text(json.dumps(saida, ensure_ascii=False))
    return saida
