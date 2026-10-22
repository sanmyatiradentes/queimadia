"""Fumaça e qualidade do ar (Copernicus CAMS, via Open-Meteo Air Quality): PM2,5 no local do fogo e em
Manaus nos dias do evento. Referência: diretriz da OMS (2021) para PM2,5 em 24 h = 15 µg/m³.
Histórico do CAMS global no Open-Meteo a partir de agosto de 2022."""
import json
import time
from datetime import datetime, timedelta, timezone

import requests

from . import config

URL = "https://air-quality-api.open-meteo.com/v1/air-quality"
CACHE = config.ESTADO / "ar_eventos.json"
DESDE = "2022-08-01"
OMS_24H = 15
LOTE, MAX_NOVOS = 25, 300


def _carregar():
    try:
        return json.load(open(CACHE))
    except Exception:
        return {}


def _consultar(pontos, ini, fim):
    p = {"latitude": ",".join(f"{a:.3f}" for a, _ in pontos), "longitude": ",".join(f"{b:.3f}" for _, b in pontos),
         "hourly": "pm2_5,aerosol_optical_depth", "start_date": ini, "end_date": fim, "timezone": "UTC"}
    for k in range(4):
        r = requests.get(URL, params=p, timeout=(30, 180))
        if r.status_code not in (429, 500, 502, 503, 504):
            r.raise_for_status()
            d = r.json()
            return d if isinstance(d, list) else [d]
        time.sleep(15 * (k + 1))
    raise RuntimeError("Open-Meteo Air Quality sem resposta")


def _resumo(sr, ini, fim):
    h = sr.get("hourly") or {}
    tempos = [datetime.fromisoformat(x) for x in h.get("time", [])]
    pm = h.get("pm2_5") or []
    aod = h.get("aerosol_optical_depth") or []
    sel = [i for i, x in enumerate(tempos) if ini - timedelta(hours=6) <= x <= fim + timedelta(hours=30)]
    vals = [pm[i] for i in sel if pm[i] is not None]
    if not vals:
        return None
    dias = {}
    for i in sel:
        if pm[i] is not None:
            dias.setdefault(tempos[i].date().isoformat(), []).append(pm[i])
    media_dia = {d: sum(v) / len(v) for d, v in dias.items()}
    pior = max(media_dia, key=media_dia.get)
    av = [aod[i] for i in sel if i < len(aod) and aod[i] is not None]
    return {"pm25_max": round(max(vals), 1), "pm25_media_dia_max": round(media_dia[pior], 1), "dia_pior": pior,
            "aod_max": round(max(av), 2) if av else None, "dias_acima_oms": sum(1 for v in media_dia.values() if v > OMS_24H)}


def enriquecer(eventos, score_min=50):
    cache = _carregar()
    hoje = datetime.now(timezone.utc).date()
    faltam = [e for e in eventos if e["id"] not in cache and e["inicio"][:10] >= DESDE
              and (e["score"] >= score_min or e.get("trilha") == "tempo_real")][:MAX_NOVOS]
    for k in range(0, len(faltam), LOTE):
        lote = faltam[k:k + LOTE]
        ini = min(datetime.fromisoformat(e["inicio"]) for e in lote)
        fim = min(max(datetime.fromisoformat(e["fim"]) for e in lote) + timedelta(days=2), datetime.combine(hoje, datetime.min.time()))
        pontos = [(e["lat"], e["lon"]) for e in lote] + [config.MANAUS]
        try:
            series = _consultar(pontos, (ini - timedelta(days=1)).date().isoformat(), fim.date().isoformat())
        except Exception as exc:
            print("ar: falha na consulta", type(exc).__name__)
            break
        manaus = series[-1]
        for e, sr in zip(lote, series[:-1]):
            a, b = datetime.fromisoformat(e["inicio"]), datetime.fromisoformat(e["fim"])
            r = _resumo(sr, a, b)
            if r:
                m = _resumo(manaus, a, b)
                r["manaus"] = m and {k2: m[k2] for k2 in ("pm25_max", "pm25_media_dia_max", "dia_pior", "dias_acima_oms")}
                cache[e["id"]] = r
        time.sleep(0.5)
    json.dump(cache, open(CACHE, "w"))
    n = 0
    for e in eventos:
        if e["id"] in cache:
            e["det"]["ar"] = cache[e["id"]]
            n += 1
    return n
