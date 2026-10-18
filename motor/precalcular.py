"""Pré-cálculo das análises de NDVI dos eventos prioritários (roda no Mac).

O servidor da PCAM só serve arquivos estáticos, então a análise completa de
cada evento prioritário (série Sentinel-2 + Landsat, quebra pelo método do
PolicIA, imagens por período, dNBR e parecer por IA) é feita aqui e gravada em
public/dados/analises/<id>.json + PNGs.

    python -m motor.precalcular            # até MAX_POR_CICLO eventos novos
    python -m motor.precalcular R2026-00123
"""
import json
import sys
import time
import traceback
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone

import pandas as pd

from . import config, ndvi, parecer

DIR = config.PUBLICO / "analises"
DIR.mkdir(parents=True, exist_ok=True)
INDICE = DIR / "indice.json"
MAX_POR_CICLO = 3          # análises novas por ciclo (≈3 min cada)
SCORE_MIN = 70
RAIO_M, LADO_M = 600, 4000
DIAS_REFAZER = 7           # refaz eventos recentes até a imagem pós-fogo estabilizar
MIN_VALIDO = 0.5


def indice():
    try:
        return json.load(open(INDICE))
    except Exception:
        return {}


def _grava(nome, obj):
    tmp = DIR / (nome + ".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")))
    tmp.replace(DIR / nome)


def escolher_periodos(validas, quebra, n=4):
    v = [m for m in validas if m["colecao"].startswith("sentinel")] or validas
    if not v:
        return []
    marcas = {v[0]["data"]: "Início", v[-1]["data"]: "Fim"}
    if quebra.get("detectada"):
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


def analisar(ev):
    lat, lon = ev["lat"], ev["lon"]
    ini = ev["inicio"][:10]
    fim = ev["fim"][:10]
    hoje = date.today().isoformat()
    a_ini = (pd.Timestamp(ini) - pd.DateOffset(months=24)).date().isoformat()
    a_fim = min(hoje, (pd.Timestamp(fim) + pd.Timedelta(days=120)).date().isoformat())
    ref_ini, ref_fim = a_ini, (pd.Timestamp(ini) - pd.Timedelta(days=60)).date().isoformat()

    cenas = ndvi.buscar_cenas(lat, lon, a_ini, ref_fim, modo="mes", nuvem_max=70)
    cenas += ndvi.buscar_cenas(lat, lon, ref_fim, a_fim, modo="todas", nuvem_max=80)
    vistos, unicas = set(), []
    for c in cenas:
        if c["id"] not in vistos:
            vistos.add(c["id"]); unicas.append(c)

    def medir(c):
        try:
            return {**c, **ndvi.medir_cena(c["colecao"], c["id"], lat, lon, RAIO_M)}
        except Exception as e:
            return {**c, "erro": type(e).__name__}

    with ThreadPoolExecutor(12) as ex:
        med = sorted(ex.map(medir, unicas), key=lambda m: (m["data"], m["colecao"]))
    validas = [m for m in med if m.get("ndvi") is not None and m.get("frac_valida", 0) >= MIN_VALIDO]
    quebra = ndvi.detectar_quebra(validas, ref_ini, ref_fim)
    if quebra.get("detectada"):
        ini_ts = pd.Timestamp(ini)
        prim, ult = pd.Timestamp(quebra["data_primeira_abaixo"]), pd.Timestamp(quebra["data_ultima_estavel"])
        quebra["relacao_fogo"] = ("antes_do_fogo" if prim < ini_ts - pd.Timedelta(days=5)
                                  else "no_fogo" if ult >= ini_ts - pd.Timedelta(days=5) else "indefinida")

    pasta = DIR / ev["id"]
    pasta.mkdir(exist_ok=True)
    imagens = []
    for p in escolher_periodos(validas, quebra):
        for prod in ("rgb", "ndvi"):
            nome = f"{p['data']}_{p['colecao'][:2]}_{prod}.png"
            try:
                (pasta / nome).write_bytes(ndvi.imagem(p["colecao"], p["id"], lat, lon, LADO_M, prod, RAIO_M))
                imagens.append({"arquivo": f"{ev['id']}/{nome}", "produto": prod, "data": p["data"], "colecao": p["colecao"],
                                "rotulo": p["rotulo"], "ndvi": p.get("ndvi")})
            except Exception:
                traceback.print_exc()

    dn = None
    v_nbr = [m for m in validas if m.get("nbr") is not None]
    if len(v_nbr) >= 2:
        if quebra.get("detectada"):
            a = [m for m in v_nbr if m["data"] <= quebra["data_ultima_estavel"]]
            b = [m for m in v_nbr if m["data"] >= quebra["data_primeira_abaixo"]]
        else:
            a = [m for m in v_nbr if m["data"] < ini]
            b = [m for m in v_nbr if m["data"] > fim]
        if a and b:
            a, b = a[-1], b[0]
            try:
                png, stats = ndvi.dnbr(a["colecao"], a["id"], b["colecao"], b["id"], lat, lon, LADO_M, RAIO_M)
                (pasta / "dnbr.png").write_bytes(png)
                dn = {**stats, "arquivo": f"{ev['id']}/dnbr.png", "antes": a["data"], "depois": b["data"],
                      "cena_antes": a["id"], "cena_depois": b["id"]}
            except Exception:
                traceback.print_exc()

    res = {
        "evento": {k: ev[k] for k in ("id", "municipio", "inicio", "fim", "score", "lat", "lon", "n_focos", "indicadores")},
        "area": {"lat": lat, "lon": lon, "raio_m": RAIO_M, "lado_m": LADO_M},
        "periodo": [a_ini, a_fim], "linha_base": [ref_ini, ref_fim],
        "quebra": quebra, "dnbr": dn, "imagens": imagens,
        "cenas": med, "n_validas": len(validas),
        "metodo": "NDVI = mediana dos pixels válidos no círculo de 600 m; quebra pelo método do PolicIA "
                  "(limiar = base − max(3σ; 0,15), ≥2 observações seguidas); Sentinel-2 L2A + Landsat 8/9 C2 L2 Tier 1.",
        "fonte": "Microsoft Planetary Computer (STAC)",
        "gerado_em": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    try:
        res["parecer"] = parecer.gerar({**res, "evento": {**res["evento"], "det": ev.get("det")}})
    except parecer.ParecerIndisponivel as e:
        res["parecer"] = {"indisponivel": str(e)}
    _grava(f"{ev['id']}.json", res)
    return res


def ciclo(eventos, limite=MAX_POR_CICLO, ids=None):
    idx = indice()
    agora = time.time()
    if ids:
        fila = [e for e in eventos if e["id"] in ids]
    else:
        def precisa(e):
            r = idx.get(e["id"])
            if not r:
                return True
            recente = (pd.Timestamp.now() - pd.Timestamp(e["fim"][:10])).days < 90
            return recente and agora - r["t"] > DIAS_REFAZER * 86400
        fila = [e for e in eventos if e["score"] >= SCORE_MIN and precisa(e)]
        fila.sort(key=lambda e: (e["inicio"][:4] != str(date.today().year), e["dist_manaus_km"] > 250, -e["score"]))
        fila = fila[:limite]
    for e in fila:
        t0 = time.time()
        try:
            r = analisar(e)
            q = r["quebra"]
            idx[e["id"]] = {"t": time.time(), "quebra": q.get("data_primeira_abaixo"), "relacao": q.get("relacao_fogo"),
                            "queimado_ha": (r["dnbr"] or {}).get("queimado_ha"), "n": r["n_validas"],
                            "parecer": "texto" in (r.get("parecer") or {})}
            print(f"análise {e['id']} {e['municipio']}: {r['n_validas']} obs, quebra {q.get('data_primeira_abaixo')} "
                  f"({time.time() - t0:.0f}s)")
        except Exception:
            traceback.print_exc()
        _grava("indice.json", idx)
    return len(fila)


if __name__ == "__main__":
    evs = json.load(open(config.PUBLICO / "eventos.json"))
    cols = ["id", "lat", "lon", "score", "n_focos", "max_focos_dia", "inicio", "fim", "municipio",
            "dist_manaus_km", "mask", "det", "satelites", "ia"]
    inds = evs["indicadores"]
    lista = []
    for a in evs["eventos"]:
        e = dict(zip(cols, a))
        e["indicadores"] = [k for i, k in enumerate(inds) if e["mask"] & (1 << i)]
        lista.append(e)
    ciclo(lista, ids=set(sys.argv[1:]) or None)
