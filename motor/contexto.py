"""Contexto fundiário, hidrográfico e de infraestrutura de cada evento.

  Assentamentos e SIGEF: INCRA (public/bases). Florestas públicas não destinadas: Serviço Florestal Brasileiro, CNFP 2025.
  Sub-bacias: ANA/SNIRH (DNAEE). Aldeias: FUNAI. Mineração: MapBiomas (2023). Pistas e bombeiros: OpenStreetMap.
  PRODES (desmatamento anual, INPE/TerraBrasilis): consulta por evento, em cache.
"""
import json
import math
import time

import requests
from shapely.geometry import Point, shape
from shapely.strtree import STRtree

from . import config

BASES = config.PUBLICO.parent / "bases"
PRODES_CACHE = config.ESTADO / "prodes_eventos.json"
PRODES_WFS = ("https://terrabrasilis.dpi.inpe.br/geoserver/ows?service=WFS&version=1.0.0&request=GetFeature"
              "&typeName=prodes-legal-amz:yearly_deforestation&outputFormat=application/json&propertyName=year,area_km,main_class&bbox={b}")

ASSENT = config.PUBLICO.parent / "bases" / "assentamentos_am.json"
BACIAS = config.ESTADO / "subbacias_am.json"
URL_BACIAS = ("https://portal1.snirh.gov.br/server/rest/services/dados_abertos/DNAEE_Sub_Bacias/MapServer/0/query"
              "?geometry=-73.8,-9.9,-56.1,2.3&geometryType=esriGeometryEnvelope&inSR=4326&outSR=4326"
              "&spatialRel=esriSpatialRelIntersects&outFields=DNS_NM,DNS_NU_SUB&returnGeometry=true&maxAllowableOffset=0.005&f=geojson")


def _bacias():
    try:
        d = json.load(open(BACIAS))
        if time.time() - d.get("t", 0) < 30 * 86400:
            return d
    except Exception:
        d = None
    try:
        r = requests.get(URL_BACIAS, timeout=120)
        r.raise_for_status()
        novo = r.json()
        if novo.get("features"):
            novo["t"] = time.time()
            BACIAS.write_text(json.dumps(novo, separators=(",", ":"), ensure_ascii=False))
            return novo
    except Exception as exc:
        print("sub-bacias: falha", type(exc).__name__)
    return d


def _indice(fc):
    feats = [(shape(f["geometry"]), f["properties"]) for f in (fc or {}).get("features", []) if f.get("geometry")]
    return (STRtree([g for g, _ in feats]), feats) if feats else (None, [])


def _base(nome):
    f = BASES / nome
    return json.load(open(f)) if f.exists() else None


def _km(p, q):
    return math.hypot((p[1] - q[1]) * 111.32, (p[0] - q[0]) * 111.32 * math.cos(math.radians(p[1])))


class _Pontos:
    """Pontos [(lon, lat, props)] com índice em grade de 0,05° para buscas por raio."""
    PASSO = 0.05

    def __init__(self, fc):
        self.lista = [(f["geometry"]["coordinates"][0], f["geometry"]["coordinates"][1], f["properties"]) for f in (fc or {}).get("features", [])]
        self.grade = {}
        for t in self.lista:
            self.grade.setdefault((math.floor(t[1] / self.PASSO), math.floor(t[0] / self.PASSO)), []).append(t)

    def proximos(self, e, raio_km):
        c = (e["lon"], e["lat"])
        if len(self.lista) < 500:
            cand = self.lista
        else:
            k = math.ceil(raio_km / 111.32 / self.PASSO) + 1
            i0, j0 = math.floor(e["lat"] / self.PASSO), math.floor(e["lon"] / self.PASSO)
            cand = [t for di in range(-k, k + 1) for dj in range(-k, k + 1) for t in self.grade.get((i0 + di, j0 + dj), ())]
        r = [(_km(c, (x, y)), pr) for x, y, pr in cand]
        return sorted([t for t in r if t[0] <= raio_km], key=lambda t: t[0])


def prodes(eventos, score_min=50, max_novos=150):
    """Desmatamento PRODES a até 1 km, nos anos anteriores ao fogo (consulta por evento, cache)."""
    try:
        cache = json.load(open(PRODES_CACHE))
    except Exception:
        cache = {}
    faltam = [e for e in eventos if e["id"] not in cache and (e["score"] >= score_min or e.get("trilha") == "tempo_real")][:max_novos]
    t0 = time.time()
    for e in faltam:
        if time.time() - t0 > 90:
            break
        d = 1.0 / 111.32
        b = f'{e["lon"] - d:.4f},{e["lat"] - d:.4f},{e["lon"] + d:.4f},{e["lat"] + d:.4f}'
        try:
            r = requests.get(PRODES_WFS.format(b=b), timeout=40)
            r.raise_for_status()
            anos = {}
            for f in r.json().get("features", []):
                p = f["properties"]
                if p.get("main_class") == "desmatamento" and p.get("year"):
                    anos[int(p["year"])] = anos.get(int(p["year"]), 0) + (p.get("area_km") or 0) * 100
            cache[e["id"]] = {"anos_ha": {str(a): round(v, 1) for a, v in sorted(anos.items())}}
        except Exception as exc:
            print("PRODES: falha", type(exc).__name__)
            break
        time.sleep(0.2)
    json.dump(cache, open(PRODES_CACHE, "w"))
    n = 0
    for e in eventos:
        c = cache.get(e["id"])
        if c is None:
            continue
        ano = int(e["inicio"][:4])
        antes = {a: v for a, v in c["anos_ha"].items() if int(a) < ano}
        e["det"]["prodes"] = {"anos_ha": antes, "total_ha": round(sum(antes.values()), 1), "raio_km": 1}
        n += 1
    return n


def marcar(eventos):
    arv_f, fpnd = _indice(_base("fpnd_am.json"))
    arv_s, sigef = _indice(_base("sigef_am.json"))
    aldeias, mina, pistas, bomb = (_Pontos(_base(n)) for n in ("aldeias_am.json", "mineracao_am.json", "pistas_am.json", "bombeiros_am.json"))
    arv_a, assent = _indice(json.load(open(ASSENT)) if ASSENT.exists() else None)
    arv_b, bacias = _indice(_bacias())
    na = nb = 0
    for e in eventos:
        p = Point(e["lon"], e["lat"])
        e["det"].pop("assentamento", None)
        if arv_a is not None:
            for i in arv_a.query(p, predicate="intersects"):
                pr = assent[int(i)][1]
                e["det"]["assentamento"] = {"nome": pr.get("nome_proje"), "codigo": pr.get("cd_sipra"), "municipio": pr.get("municipio"),
                                            "familias": pr.get("num_famili"), "area_ha": pr.get("area_calc_"), "fase": pr.get("fase"),
                                            "criado": pr.get("data_de_cr")}
                na += 1
                break
        if arv_b is not None:
            for i in arv_b.query(p, predicate="intersects"):
                pr = bacias[int(i)][1]
                e["det"]["bacia"] = {"nome": pr.get("DNS_NM"), "codigo": pr.get("DNS_NU_SUB"), "fonte": "ANA — sub-bacias DNAEE"}
                nb += 1
                break
        for k in ("fpnd", "sigef", "aldeias", "mineracao", "pista", "bombeiros"):
            e["det"].pop(k, None)
        if arv_f is not None:
            for i in arv_f.query(p, predicate="intersects"):
                pr = fpnd[int(i)][1]
                e["det"]["fpnd"] = {"nome": pr.get("nome"), "categoria": pr.get("categoria"), "governo": pr.get("governo"), "area_ha": pr.get("area_ha")}
                break
        if arv_s is not None:
            imoveis = [sigef[int(i)][1] for i in arv_s.query(p.buffer(0.0045), predicate="intersects")]
            if imoveis:
                dentro = [sigef[int(i)][1] for i in arv_s.query(p, predicate="intersects")]
                e["det"]["sigef"] = {"no_ponto": [{k: x.get(k) for k in ("nome_area", "codigo_imo", "situacao_i", "status")} for x in dentro[:3]],
                                     "a_500m": len(imoveis)}
        al = aldeias.proximos(e, 10)
        if al:
            e["det"]["aldeias"] = {"n_10km": len(al), "mais_perto_km": round(al[0][0], 1), "nome": al[0][1].get("nome")}
        mi = mina.proximos(e, 3)
        gar = [t for t in mi if t[1].get("t") == "garimpo"]
        if mi:
            e["det"]["mineracao"] = {"garimpo_ha_3km": round(sum(t[1]["ha"] for t in gar), 1), "industrial_ha_3km": round(sum(t[1]["ha"] for t in mi if t[1].get("t") != "garimpo"), 1),
                                     "mais_perto_km": round(mi[0][0], 1), "tipo_mais_perto": mi[0][1].get("t")}
        pi = pistas.proximos(e, 20)
        if pi:
            e["det"]["pista"] = {"km": round(pi[0][0], 1), "nome": pi[0][1].get("nome"), "tipo": pi[0][1].get("tipo")}
        bo = bomb.proximos(e, 300)
        if bo:
            e["det"]["bombeiros"] = {"km": round(bo[0][0]), "nome": bo[0][1].get("nome")}
    return f"{na} em assentamento, {nb} com sub-bacia, {sum('fpnd' in e['det'] for e in eventos)} em floresta pública não destinada"


def aplicar(lista):
    """Floresta pública não destinada entra na prioridade (padrão associado à grilagem)."""
    for e in lista:
        ind = set(e["indicadores"])
        if e["det"].get("fpnd"):
            ind.add("floresta_publica_nd")
        else:
            ind.discard("floresta_publica_nd")
        e["indicadores"] = sorted(ind)
        e["score"] = min(100, sum(config.PESOS[k] for k in ind))
    return lista
