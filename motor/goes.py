"""Detecção geoestacionária (GOES-16/19, a cada 10 min) para estreitar o horário de início do fogo.

Os focos GOES já chegam nos arquivos do INPE; aqui se procura, para cada evento, a detecção GOES
mais antiga a até 4 km (pixel de ~2 km) entre 48 h antes do 1º foco do evento e o último foco.
Guia pericial: a primeira detecção mostra fogo detectável naquele instante, não a hora da ignição.
"""
import numpy as np
import pandas as pd

RAIO_KM, ANTES_H = 4.0, 48


def marcar(lista, df):
    g = df[df["satelite"].astype(str).str.upper().str.startswith("GOES")]
    if g.empty:
        return 0
    g = g.sort_values("data")
    t = g["data"].values.astype("datetime64[s]").astype(np.int64)
    la, lo, sat = g["lat"].values, g["lon"].values, g["satelite"].values
    n = 0
    for e in lista:
        ini, fim = pd.Timestamp(e["inicio"]), pd.Timestamp(e["fim"])
        a = np.searchsorted(t, int((ini - pd.Timedelta(hours=ANTES_H)).timestamp()))
        b = np.searchsorted(t, int((fim + pd.Timedelta(hours=1)).timestamp()), side="right")
        if a >= b:
            continue
        dy = (la[a:b] - e["lat"]) * 111.32
        dx = (lo[a:b] - e["lon"]) * 111.32 * np.cos(np.radians(e["lat"]))
        perto = np.flatnonzero(np.hypot(dx, dy) <= RAIO_KM)
        if not len(perto):
            continue
        i = a + perto[0]
        primeira = pd.Timestamp(t[i], unit="s")
        e["det"]["goes"] = {"primeira": primeira.strftime("%Y-%m-%d %H:%M"), "satelite": str(sat[i]), "deteccoes": int(len(perto)),
                            "antecede_h": round((ini - primeira).total_seconds() / 3600, 1)}
        n += 1
    return n
