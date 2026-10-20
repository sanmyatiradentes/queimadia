"""Pré-cálculo das análises de NDVI dos eventos prioritários (roda no Mac).

O servidor da PCAM só serve arquivos estáticos, então a análise completa de
cada evento prioritário (série Sentinel-2 + Landsat, quebra pelo método do
limiar de 3σ e confirmação do CCDC, imagens por período, dNBR e parecer por IA) é feita aqui e gravada em
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


def analisar(ev):
    lat, lon = ev["lat"], ev["lon"]
    ini = ev["inicio"][:10]
    fim = ev["fim"][:10]
    hoje = date.today().isoformat()
    a_ini = (pd.Timestamp(ini) - pd.DateOffset(months=24)).date().isoformat()
    a_fim = min(hoje, (pd.Timestamp(fim) + pd.Timedelta(days=120)).date().isoformat())
    ref_ini, ref_fim = a_ini, (pd.Timestamp(ini) - pd.Timedelta(days=60)).date().isoformat()

    cenas = ndvi.buscar_cenas(lat, lon, a_ini, ref_fim, modo="mes", nuvem_max=70, raio_m=RAIO_M)
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
    validas, removidas_tmask = ndvi.tmask(validas, ref_ini, ref_fim)
    quebra = ndvi.detectar_quebra(validas, ref_ini, ref_fim)
    quebra["removidas_tmask"] = [{"data": m["data"], "colecao": m["colecao"], "motivo": m["tmask"], "ndvi": m["ndvi"]}
                                 for m in removidas_tmask]
    if quebra.get("situacao") in ("confirmada", "provavel"):
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
        if quebra.get("data_primeira_abaixo"):
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
        "metodo": "NDVI = mediana dos pixels válidos no círculo de 600 m; cena do mês escolhida pela limpeza sobre a área; "
                  "quebra quando o NDVI fica abaixo de base − max(3σ; 0,15) em 6 observações consecutivas "
                  "(critério do CCDC; Zhu & Woodcock, 2014a), com triagem Tmask (Zhu & Woodcock, 2014b) na linha de base; "
                  "severidade por dNBR (Key & Benson, 2006); "
                  "Sentinel-2 L2A + Landsat 8/9 C2 L2 Tier 1.",
        "fonte": "Microsoft Planetary Computer (STAC)",
        "gerado_em": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    try:
        res["parecer"] = parecer.gerar({**res, "evento": {**res["evento"], "det": ev.get("det"), "clima": ev.get("clima")}})
    except parecer.ParecerIndisponivel as e:
        res["parecer"] = {"indisponivel": str(e)}
    _grava(f"{ev['id']}.json", res)
    return res


def religar(eventos, idx):
    """Liga análises cujo identificador não existe mais ao evento equivalente
    (mesmo dia de início, a menos de 2 km) e renomeia os arquivos."""
    import math
    ids = {e["id"] for e in eventos}
    mudou = False
    for antigo in [k for k in idx if k not in ids]:
        arq = DIR / f"{antigo}.json"
        if not arq.exists():
            idx.pop(antigo); mudou = True; continue
        r = json.load(open(arq))
        ev0 = r["evento"]
        def dist(e):
            return math.hypot((e["lat"] - ev0["lat"]) * 111, (e["lon"] - ev0["lon"]) * 111 * math.cos(math.radians(e["lat"])))
        cands = [e for e in eventos if e["inicio"][:10] == ev0["inicio"][:10] and dist(e) < 2]
        if not cands:
            continue
        novo = min(cands, key=dist)["id"]
        if novo in idx:
            continue
        txt = arq.read_text().replace(f"{antigo}/", f"{novo}/").replace(f'"id":"{antigo}"', f'"id":"{novo}"')
        (DIR / f"{novo}.json").write_text(txt); arq.unlink()
        if (DIR / antigo).exists():
            (DIR / antigo).rename(DIR / novo)
        idx[novo] = idx.pop(antigo); mudou = True
        print(f"análise religada: {antigo} → {novo}")
    if mudou:
        _grava("indice.json", idx)
    return idx


def completar_pareceres(idx, limite=5):
    """Gera o parecer das análises já publicadas que ainda não têm (ex.: feitas
    antes de a chave do Gemini ser cadastrada)."""
    feitos = 0
    for id_, info in sorted(idx.items(), key=lambda kv: -kv[1].get("t", 0)):
        if info.get("parecer") or feitos >= limite:
            continue
        arq = DIR / f"{id_}.json"
        if not arq.exists():
            continue
        r = json.load(open(arq))
        try:
            r["parecer"] = parecer.gerar(r)
        except parecer.ParecerIndisponivel as e:
            print("parecer indisponível:", e)
            break
        _grava(f"{id_}.json", r)
        info["parecer"] = True
        feitos += 1
        print(f"parecer gerado: {id_}")
    if feitos:
        _grava("indice.json", idx)


def ciclo(eventos, limite=MAX_POR_CICLO, ids=None):
    idx = religar(eventos, indice())
    if not ids:
        completar_pareceres(idx)
    agora = time.time()
    if ids:
        fila = [e for e in eventos if e["id"] in ids]
    else:
        def precisa(e):
            r = idx.get(e["id"])
            if not r or "situacao" not in r:   # sem resultado, ou calculado antes do critério do CCDC
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
            idx[e["id"]] = {"t": time.time(), "quebra": q.get("data_primeira_abaixo"), "situacao": q.get("situacao"),
                            "relacao": q.get("relacao_fogo"),
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
