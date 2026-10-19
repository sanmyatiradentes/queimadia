"""Clima no local e na hora de cada incêndio (Open-Meteo: modelos ECMWF/GFS/ICON
e reanálise ERA5) e grade de vento para o mapa.

Para cada evento: vento (velocidade e direção), umidade relativa, temperatura e
chuva das 72 h anteriores na hora do 1º foco; se o vento levava a fumaça para
Manaus e em quanto tempo ela chegaria. Resultados ficam em cache (o clima do
passado não muda), então só eventos novos geram consulta.
"""
import json
import math
import time
from datetime import datetime, timedelta, timezone

import requests

from . import config

FORECAST = "https://api.open-meteo.com/v1/forecast"
ARQUIVO = "https://archive-api.open-meteo.com/v1/archive"
CACHE = config.ESTADO / "clima_eventos.json"
VENTO = config.PUBLICO / "vento.json"
VARS = "wind_speed_10m,wind_direction_10m,relative_humidity_2m,temperature_2m,precipitation"
LOTE = 40                 # pontos por chamada
MAX_NOVOS_POR_CICLO = 400
CONE_GRAUS = 30           # fumaça "rumo a Manaus" se o vento sopra a até ±30° da direção da cidade
DIST_MAX_KM = 800


def _carregar():
    try:
        return json.load(open(CACHE))
    except Exception:
        return {}


def rumo(lat1, lon1, lat2, lon2):
    """Direção (graus, 0 = norte) do ponto 1 para o ponto 2."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    x = math.sin(dl) * math.cos(p2)
    y = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(x, y)) + 360) % 360


def _consultar(pontos, inicio, fim, url):
    """pontos: [(lat, lon)] → lista de séries horárias (dict) na mesma ordem."""
    params = {"latitude": ",".join(f"{a:.3f}" for a, _ in pontos),
              "longitude": ",".join(f"{b:.3f}" for _, b in pontos),
              "hourly": VARS, "timezone": "UTC", "wind_speed_unit": "kmh"}
    if url == ARQUIVO:
        params.update(start_date=inicio, end_date=fim)
    else:
        params.update(start_date=inicio, end_date=fim)
    for tentativa in range(3):
        try:
            r = requests.get(url, params=params, timeout=(30, 240))
        except requests.RequestException:
            time.sleep(15 * (tentativa + 1))
            continue
        if r.status_code in (429, 500, 502, 503, 504):   # limite ou instabilidade: espera e tenta de novo
            time.sleep(20 * (tentativa + 1))
            continue
        r.raise_for_status()
        d = r.json()
        return d if isinstance(d, list) else [d]
    raise RuntimeError("Open-Meteo sem resposta")


def _resumo(serie, ini_utc, fim_utc, lat, lon):
    h = serie["hourly"]
    tempos = h["time"]
    alvo = ini_utc.strftime("%Y-%m-%dT%H:00")
    if alvo not in tempos:
        return None
    i = tempos.index(alvo)
    j = tempos.index(fim_utc.strftime("%Y-%m-%dT%H:00")) if fim_utc.strftime("%Y-%m-%dT%H:00") in tempos else i
    val = lambda k, k_i: h[k][k_i]
    chuva72 = sum(x or 0 for x in h["precipitation"][max(0, i - 72):i])
    vel, dirv = val("wind_speed_10m", i), val("wind_direction_10m", i)
    if vel is None or dirv is None:
        return None
    para = (dirv + 180) % 360                    # a fumaça vai para onde o vento sopra
    alvo_manaus = rumo(lat, lon, *config.MANAUS)
    desvio = abs((para - alvo_manaus + 180) % 360 - 180)
    dist = _dist_km(lat, lon, *config.MANAUS)
    rumo_manaus = desvio <= CONE_GRAUS and dist <= DIST_MAX_KM and vel >= 3
    ventos = [x for x in h["wind_speed_10m"][i:j + 1] if x is not None]
    # umidade MÍNIMA das 24 h anteriores (a da tarde): a umidade da madrugada passa de
    # 90% quase toda noite na Amazônia e não diz quão seca estava a vegetação
    ur24 = [x for x in h["relative_humidity_2m"][max(0, i - 24):i + 1] if x is not None]
    return {
        "hora_utc": alvo, "vento_kmh": round(vel, 1), "vento_de_graus": round(dirv), "fumaca_para_graus": round(para),
        "umidade": val("relative_humidity_2m", i), "umidade_min_24h": min(ur24) if ur24 else None,
        "temperatura": val("temperature_2m", i),
        "chuva_72h_mm": round(chuva72, 1), "vento_max_evento_kmh": round(max(ventos), 1) if ventos else None,
        "fumaca_rumo_manaus": rumo_manaus, "desvio_rumo_manaus_graus": round(desvio),
        "horas_ate_manaus": round(dist / vel, 1) if rumo_manaus else None,
        "fonte": "Open-Meteo (ECMWF/GFS/ICON; ERA5 para datas antigas)",
    }


def _dist_km(lat1, lon1, lat2, lon2):
    p = math.pi / 180
    a = (math.sin((lat2 - lat1) * p / 2) ** 2 + math.cos(lat1 * p) * math.cos(lat2 * p) * math.sin((lon2 - lon1) * p / 2) ** 2)
    return 2 * 6371 * math.asin(math.sqrt(a))


def enriquecer(eventos, score_min=50, desde=None):
    """Acrescenta e["clima"] aos eventos (cache + consultas só para os novos)."""
    cache = _carregar()
    desde = desde or f"{datetime.now(timezone.utc).year}-01-01"
    hoje = datetime.now(timezone.utc).date()
    faltam = [e for e in eventos if e["id"] not in cache and e["inicio"][:10] >= desde
              and (e["score"] >= score_min or e.get("trilha") == "tempo_real")][:MAX_NOVOS_POR_CICLO]
    for k in range(0, len(faltam), LOTE):
        lote = faltam[k:k + LOTE]
        ini = min(datetime.fromisoformat(e["inicio"]) for e in lote) - timedelta(days=4)
        fim = max(datetime.fromisoformat(e["fim"]) for e in lote)
        recente = (hoje - ini.date()).days <= 85
        url = FORECAST if recente else ARQUIVO
        if not recente:
            fim = min(fim, datetime.combine(hoje - timedelta(days=6), datetime.min.time()))
        try:
            series = _consultar([(e["lat"], e["lon"]) for e in lote], ini.date().isoformat(), fim.date().isoformat(), url)
        except Exception as exc:
            print("clima: falha na consulta", type(exc).__name__)
            break
        for e, sr in zip(lote, series):
            r = _resumo(sr, datetime.fromisoformat(e["inicio"]), datetime.fromisoformat(e["fim"]), e["lat"], e["lon"])
            if r:
                cache[e["id"]] = r
        time.sleep(0.5)
    json.dump(cache, open(CACHE, "w"))
    n = 0
    for e in eventos:
        if e["id"] in cache:
            e["clima"] = cache[e["id"]]
            n += 1
    return n


def grade_vento(passo=1.0, horas=24):
    """Grade de vento sobre o AM (agora e próximas `horas`) para o mapa.
    Atualizada no máximo a cada 3 h (a previsão não muda mais rápido que isso)."""
    try:
        atual = json.load(open(VENTO))
        if time.time() - atual.get("t", 0) < 3 * 3600:
            return atual
    except Exception:
        pass
    lon0, lat0, lon1, lat1 = config.AM_BBOX
    pontos = [(round(lat0 + passo / 2 + i * passo, 2), round(lon0 + passo / 2 + j * passo, 2))
              for i in range(int((lat1 - lat0) / passo)) for j in range(int((lon1 - lon0) / passo))]
    agora = datetime.now(timezone.utc)
    hoje = agora.date().isoformat()
    amanha = (agora + timedelta(days=1)).date().isoformat()
    linhas = []
    for k in range(0, len(pontos), 40):
        lote = pontos[k:k + 40]
        params = {"latitude": ",".join(str(a) for a, _ in lote), "longitude": ",".join(str(b) for _, b in lote),
                  "hourly": "wind_speed_10m,wind_direction_10m", "timezone": "UTC", "wind_speed_unit": "kmh",
                  "start_date": hoje, "end_date": amanha}
        resp = None
        for tentativa in range(4):
            try:
                resp = requests.get(FORECAST, params=params, timeout=(30, 240))
            except requests.RequestException:
                resp = None
            if resp is not None and resp.status_code not in (429, 500, 502, 503, 504):
                break
            time.sleep(15 * (tentativa + 1))
        if resp is None:
            raise RuntimeError("Open-Meteo sem resposta para a grade de vento")
        resp.raise_for_status()
        d = resp.json()
        for (la, lo), sr in zip(lote, d if isinstance(d, list) else [d]):
            linhas.append([la, lo, sr["hourly"]["wind_speed_10m"], sr["hourly"]["wind_direction_10m"]])
        time.sleep(0.5)
    tempos = d[0]["hourly"]["time"] if isinstance(d, list) else d["hourly"]["time"]
    saida = {"t": time.time(), "gerado_em": agora.isoformat(timespec="seconds"), "horas_utc": tempos,
             "passo_graus": passo, "pontos": linhas, "fonte": "Open-Meteo (previsão)"}
    VENTO.write_text(json.dumps(saida, separators=(",", ":")))
    return saida
