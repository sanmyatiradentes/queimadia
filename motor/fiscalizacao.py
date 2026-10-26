"""Histórico de fiscalização ambiental no entorno de cada evento (bases publicadas na INDE).

  - IBAMA (SISCOM): autos de infração e termos de apreensão do Amazonas.
  - ICMBio: áreas embargadas em unidades de conservação federais do Amazonas.

O motor guarda só números, datas, categorias e o nº do processo (sem nome, CPF/CNPJ ou texto livre).
Nome e documento do autuado ficam na consulta do relatório (api/bases), só para usuário logado.
Bases baixadas uma vez por semana (cache em motor/dados/estado).
"""
import json
import math
import re
import time
from datetime import datetime, timedelta, timezone

import requests
from shapely.geometry import Point, shape
from shapely.strtree import STRtree

from . import config

CACHE = config.ESTADO / "fiscalizacao_am.json"
PUB = config.PUBLICO / "fiscalizacao.json"   # camadas do mapa (sem dados pessoais)
VALIDADE_S = 7 * 86400
SISCOM = "https://pamgia.ibama.gov.br/server/rest/services/SISCOM/publico/MapServer"
ICMBIO = "https://geoservicos.inde.gov.br/geoserver/ICMBio/ows"
RAIO_KM, ANOS_ANTES, DIAS_DEPOIS = 3.0, 10, 365
FOGO = re.compile(r"\bfogo\b|queimad|inc[eê]ndi", re.I)
ITENS = {  # categorias dos bens apreendidos (a partir da descrição do termo)
    "motosserra": r"motoss?erra|moto\s*serra", "maquinas": r"trator|escavadeira|p[aá]\s*carregadeira|retroescavadeira|skidder|m[aá]quina",
    "veiculos": r"caminh[aã]o|carreta|ve[ií]culo|camionete|caminhonete|motocicleta", "madeira": r"madeira|\btoras?\b|m3|m³|prancha|tábua|tabua",
    "embarcacoes": r"balsa|draga|embarca[cç][aã]o|barco|canoa|voadeira", "armas": r"\barma|espingarda|rifle|carabina|muni[cç][aã]o",
    "gado": r"bovino|\bgado|cabe[cç]as", "combustivel": r"combust[ií]vel|diesel|gasolina", "fauna": r"animal|animais|quel[oô]nio|tartaruga|pescado|peixe",
}
ITENS = {k: re.compile(v, re.I) for k, v in ITENS.items()}


def _data(v):
    if v in (None, ""):
        return None
    if isinstance(v, (int, float)):
        return datetime.fromtimestamp(v / 1000, timezone.utc).strftime("%Y-%m-%d")
    s = str(v)
    m = re.match(r"(\d{2})/(\d{2})/(\d{4})", s)
    return f"{m.group(3)}-{m.group(2)}-{m.group(1)}" if m else s[:10]


def _arcgis(camada, onde, campos):
    """Busca por lotes de objectid: o serviço falha em algumas páginas (registro corrompido); o lote que falha
    é dividido ao meio até isolar e pular o registro ruim."""
    url = f"{SISCOM}/{camada}/query"
    r = requests.get(url, params={"where": onde, "returnIdsOnly": "true", "f": "json"}, timeout=180)
    r.raise_for_status()
    ids = sorted(r.json().get("objectIds") or [])
    out, pulados = [], 0

    def lote(xs):
        nonlocal pulados
        try:
            q = requests.post(url, data={"objectIds": ",".join(map(str, xs)), "outFields": campos, "outSR": 4326, "f": "geojson"}, timeout=180)
            d = q.json()
            if "error" in d:
                raise ValueError(d["error"])
            out.extend(d.get("features", []))
        except Exception:
            if len(xs) == 1:
                pulados += 1
                return
            lote(xs[:len(xs) // 2])
            lote(xs[len(xs) // 2:])

    for i in range(0, len(ids), 1000):
        lote(ids[i:i + 1000])
        time.sleep(0.2)
    if pulados:
        print(f"fiscalização: {pulados} registro(s) ilegível(is) no serviço da camada {camada}")
    return out


def baixar():
    autos = []
    for f in _arcgis(0, "uf='AM'", "num_auto_infracao,ser_auto_infracao,dat_hora_auto_infracao,dt_fato_infracional,tipo_infracao,des_infracao,"
                                   "des_auto_infracao,val_auto_infracao,sit_cancelado,nu_processo_formatado,qt_area,tipo_auto,"
                                   "num_latitude_auto,num_longitude_auto"):
        g, p = f.get("geometry"), f["properties"]
        c = g["coordinates"][:2] if g else [p.get("num_longitude_auto"), p.get("num_latitude_auto")]
        if p.get("sit_cancelado") == "S" or not all(isinstance(v, (int, float)) for v in c) or not (-75 < c[0] < -55 and -11 < c[1] < 4):
            continue
        autos.append({"c": [round(c[0], 5), round(c[1], 5)], "num": f'{p.get("num_auto_infracao") or ""}-{p.get("ser_auto_infracao") or ""}',
                      "data": _data(p.get("dt_fato_infracional")) or _data(p.get("dat_hora_auto_infracao")), "tipo": p.get("tipo_infracao"),
                      "fogo": bool(FOGO.search(f'{p.get("des_auto_infracao") or ""} {p.get("des_infracao") or ""}')),
                      "valor": p.get("val_auto_infracao"), "area_ha": p.get("qt_area"), "processo": p.get("nu_processo_formatado")})
    apre = []
    for f in _arcgis(1, "sg_uf='AM'", "cd_tad,cd_serie_tad,dt_apreensao,st_cancelado,nu_processo_formatado,ds_tad"):
        g, p = f.get("geometry"), f["properties"]
        if not g or p.get("st_cancelado") == "S":
            continue
        txt = p.get("ds_tad") or ""
        apre.append({"c": [round(g["coordinates"][0], 5), round(g["coordinates"][1], 5)], "num": f'{p.get("cd_tad") or ""}-{p.get("cd_serie_tad") or ""}',
                     "data": _data(p.get("dt_apreensao")), "processo": p.get("nu_processo_formatado"),
                     "itens": [k for k, rx in ITENS.items() if rx.search(txt)]})
    r = requests.get(ICMBIO, params={"service": "WFS", "version": "1.0.0", "request": "GetFeature", "typeName": "ICMBio:embargos_icmbio",
                                     "outputFormat": "application/json", "CQL_FILTER": "uf='AM'"}, timeout=180)
    r.raise_for_status()
    emb = []
    for f in r.json().get("features", []):
        p = f["properties"]
        if not f.get("geometry"):
            continue
        emb.append({"g": f["geometry"], "num": f'{p.get("numero_emb") or ""}-{p.get("serie") or ""}', "data": _data(p.get("data")),
                    "uc": p.get("nome_uc"), "processo": p.get("processo"), "tipo": p.get("tipo_infra"),
                    "fogo": bool(FOGO.search(f'{p.get("desc_inf_1") or ""} {p.get("desc_san_1") or ""}'))})
    d = {"t": time.time(), "autos": autos, "apreensoes": apre, "embargos_icmbio": emb,
         "fonte": "IBAMA SISCOM e ICMBio, via INDE (sem dados pessoais)"}
    CACHE.write_text(json.dumps(d, ensure_ascii=False, separators=(",", ":")))
    publicar_camada(d)
    print(f"fiscalização: {len(autos)} autos ({sum(a['fogo'] for a in autos)} por fogo), {len(apre)} apreensões, {len(emb)} embargos ICMBio")
    return d


def publicar_camada(d):
    """Autos, apreensões e embargos ICMBio do AM como GeoJSON para o mapa (números, datas, categorias e processo)."""
    ponto = lambda x, props: {"type": "Feature", "geometry": {"type": "Point", "coordinates": x["c"]}, "properties": props}
    fs = [ponto(a, {"k": "auto", "num": a["num"].rstrip("-"), "data": a["data"], "tipo": a["tipo"], "fogo": a["fogo"],
                    "valor": a["valor"], "area_ha": a["area_ha"], "processo": a["processo"]}) for a in d["autos"]]
    fs += [ponto(a, {"k": "apreensao", "num": a["num"].rstrip("-"), "data": a["data"], "processo": a["processo"],
                     "itens": ", ".join(a["itens"])}) for a in d["apreensoes"]]
    for x in d["embargos_icmbio"]:
        g = shape(x["g"]).simplify(0.0002, preserve_topology=True)
        fs.append({"type": "Feature", "geometry": g.__geo_interface__,
                   "properties": {"k": "icmbio", "num": x["num"].rstrip("-"), "data": x["data"], "uc": x["uc"], "processo": x["processo"],
                                  "tipo": x["tipo"], "fogo": x["fogo"]}})
    PUB.write_text(json.dumps({"type": "FeatureCollection", "features": fs, "fonte": d.get("fonte"), "baixado": d.get("t")},
                              ensure_ascii=False, separators=(",", ":")))


def _carregar(atualizar=True):
    try:
        d = json.load(open(CACHE))
    except Exception:
        d = None
    if atualizar and (not d or time.time() - d.get("t", 0) > VALIDADE_S):
        try:
            d = baixar()
        except Exception as exc:
            print("fiscalização: falha ao baixar", type(exc).__name__)
    return d


class _Grade:
    PASSO = 0.05

    def __init__(self, lista):
        self.g = {}
        for x in lista:
            self.g.setdefault((math.floor(x["c"][1] / self.PASSO), math.floor(x["c"][0] / self.PASSO)), []).append(x)

    def perto(self, lon, lat, km):
        k = math.ceil(km / 111.32 / self.PASSO) + 1
        i0, j0 = math.floor(lat / self.PASSO), math.floor(lon / self.PASSO)
        out = []
        for di in range(-k, k + 1):
            for dj in range(-k, k + 1):
                for x in self.g.get((i0 + di, j0 + dj), ()):
                    d = math.hypot((x["c"][1] - lat) * 111.32, (x["c"][0] - lon) * 111.32 * math.cos(math.radians(lat)))
                    if d <= km:
                        out.append((d, x))
        return sorted(out, key=lambda t: t[0])


def marcar(eventos, atualizar=True):
    d = _carregar(atualizar)
    if not d:
        return "sem base"
    if not PUB.exists():   # garante a camada do mapa mesmo quando a base veio do cache
        publicar_camada(d)
    ga, gp = _Grade(d["autos"]), _Grade(d["apreensoes"])
    emb = [(shape(x["g"]), x) for x in d["embargos_icmbio"]]
    arv = STRtree([g for g, _ in emb]) if emb else None
    n_aut = n_fogo = n_emb = 0
    for e in eventos:
        e["det"].pop("fiscalizacao", None)
        ini = e["inicio"][:10]
        lim_antes = (datetime.fromisoformat(ini) - timedelta(days=365 * ANOS_ANTES)).strftime("%Y-%m-%d")
        lim_depois = (datetime.fromisoformat(ini) + timedelta(days=DIAS_DEPOIS)).strftime("%Y-%m-%d")
        au = ga.perto(e["lon"], e["lat"], RAIO_KM)
        antes = [(k, a) for k, a in au if a["data"] and lim_antes <= a["data"] < ini]
        depois = [(k, a) for k, a in au if a["data"] and ini <= a["data"] <= lim_depois]
        fogo = [(k, a) for k, a in antes if a["fogo"]]
        ap = [(k, a) for k, a in gp.perto(e["lon"], e["lat"], RAIO_KM) if a["data"] and lim_antes <= a["data"] <= lim_depois]
        r = {}
        if antes or depois:
            r["autos"] = {"raio_km": RAIO_KM, "antes": len(antes), "fogo_antes": len(fogo), "depois": len(depois),
                          "tipos": sorted({a["tipo"] for _, a in antes if a["tipo"]}),
                          "lista": [{"num": a["num"], "data": a["data"], "tipo": a["tipo"], "fogo": a["fogo"], "processo": a["processo"],
                                     "km": round(k, 2), "quando": "antes" if a["data"] < ini else "depois"}
                                    for k, a in sorted({id(a): (k, a) for k, a in antes + depois}.values(), key=lambda t: (not t[1]["fogo"], t[0]))[:6]]}
            n_aut += 1
            n_fogo += bool(fogo)
        if ap:
            itens = {}
            for _, a in ap:
                for it in a["itens"]:
                    itens[it] = itens.get(it, 0) + 1
            r["apreensoes"] = {"raio_km": RAIO_KM, "n": len(ap), "itens": itens,
                               "lista": [{"num": a["num"], "data": a["data"], "processo": a["processo"], "itens": a["itens"], "km": round(k, 2)} for k, a in ap[:5]]}
        if arv is not None:
            p = Point(e["lon"], e["lat"])
            cand = [emb[int(i)] for i in arv.query(p.buffer(0.009))]
            if cand:
                dist = sorted(((g.distance(p) * 111.32, x) for g, x in cand), key=lambda t: t[0])
                k, x = dist[0]
                r["embargo_icmbio"] = {"no_ponto": k == 0, "km": round(k, 2), "n_1km": len(dist), "num": x["num"], "data": x["data"],
                                       "uc": x["uc"], "processo": x["processo"], "fogo": x["fogo"]}
                n_emb += 1
        if r:
            e["det"]["fiscalizacao"] = r
    return f"{n_aut} com autos do IBAMA a até {RAIO_KM:g} km ({n_fogo} por uso de fogo antes do evento), {n_emb} com embargo ICMBio a até 1 km"


def aplicar(lista):
    """Auto de infração por uso de fogo a até 3 km, nos 10 anos anteriores, entra na prioridade."""
    for e in lista:
        ind = set(e["indicadores"])
        if (e["det"].get("fiscalizacao") or {}).get("autos", {}).get("fogo_antes"):
            ind.add("autuacao_fogo_previa")
        else:
            ind.discard("autuacao_fogo_previa")
        e["indicadores"] = sorted(ind)
        e["score"] = min(100, sum(config.PESOS[k] for k in ind))
    return lista
