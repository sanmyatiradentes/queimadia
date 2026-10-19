"""Agrupamento de focos em eventos e pontuação de suspeição (0–100).

Duas trilhas:
  - referência: satélite de referência do INPE (AQUA tarde), série comparável
    entre anos. É a base estatística e histórica.
  - tempo real: VIIRS 375 m (NPP, NOAA-20, NOAA-21) dos últimos dias, que
    detecta focos menores e mais cedo. Gera os alertas do dia.
"""
import hashlib
import math

import numpy as np
import pandas as pd
from shapely.geometry import Point
from sklearn.cluster import DBSCAN
from sklearn.ensemble import IsolationForest

from . import config, geo, ingest

KM_GRAU = 111.32


def haversine_km(lat1, lon1, lat2, lon2):
    p = math.pi / 180
    a = (math.sin((lat2 - lat1) * p / 2) ** 2
         + math.cos(lat1 * p) * math.cos(lat2 * p) * math.sin((lon2 - lon1) * p / 2) ** 2)
    return 2 * 6371 * math.asin(math.sqrt(a))


def carregar_focos():
    """Todos os focos AM: histórico de referência + estado recente (todos os satélites)."""
    partes = []
    for f in sorted((config.DADOS / "inpe").glob("focos_br_am_ref_*.csv")):
        df = pd.read_csv(f, skipinitialspace=True)
        df.columns = [c.strip() for c in df.columns]
        df = df.rename(columns={"data_pas": "data"})
        df["satelite"] = config.SAT_REFERENCIA
        df["fonte"] = "anual"
        partes.append(df[["lat", "lon", "data", "satelite", "municipio", "fonte"]])
    rec = ingest.carregar_recentes()
    for c in ingest.COLS:
        if c not in rec:
            rec[c] = float("nan")
    partes.append(rec)
    df = pd.concat(partes, ignore_index=True)
    df["data"] = pd.to_datetime(df["data"].astype(str).str.strip())
    df["lat"] = df["lat"].astype(float)
    df["lon"] = df["lon"].astype(float)
    minusc = {"Da", "De", "Do", "Das", "Dos", "E"}
    nome = lambda m: " ".join(p if i == 0 or p not in minusc else p.lower() for i, p in enumerate(m.title().split()))
    df["municipio"] = df["municipio"].fillna("").astype(str).str.strip().map(ingest.consertar_acentos).map(nome)
    df["ano"] = df["data"].dt.year
    df = df.drop_duplicates(["lat", "lon", "satelite", "data"])
    df["ref"] = df["satelite"] == config.SAT_REFERENCIA
    df["cel"] = ((df["lat"] / 0.01).round().astype(int).astype(str) + "_" +
                 (df["lon"] / 0.01).round().astype(int).astype(str))
    return df.sort_values("data").reset_index(drop=True)


def agrupar(df):
    lat0 = math.radians(df["lat"].mean())
    x = df["lon"].values * KM_GRAU * math.cos(lat0)
    y = df["lat"].values * KM_GRAU
    t = (df["data"] - df["data"].min()).dt.total_seconds().values / 86400 * (config.EPS_KM / config.EPS_DIAS)
    return DBSCAN(eps=config.EPS_KM, min_samples=1).fit_predict(np.c_[x, y, t])


def pontuar(g, anos_por_cel, desmat, cicat, tis, ucs):
    """Indicadores e pontuação de um evento (grupo de focos)."""
    lat, lon = float(g["lat"].mean()), float(g["lon"].mean())
    ini, fim = g["data"].min(), g["data"].max()
    pt = Point(lon, lat)
    area = pt.buffer(config.BUFFER_DESMAT_KM / KM_GRAU)
    ind, det = set(), {}

    dm = []
    for gm, p in desmat.proximos(area):
        vd = pd.Timestamp(p["view_date"])
        if ini - pd.Timedelta(days=365) <= vd <= ini + pd.Timedelta(days=5):
            dm.append((vd, p.get("areamunkm") or 0, p["classname"]))
    if dm:
        ind.add("desmatamento_previo")
        det["desmatamento"] = {"alertas": len(dm), "area_km2": round(sum(a for _, a, _ in dm), 3),
                               "dias_antes": int((ini - max(v for v, _, _ in dm)).days),
                               "classes": sorted({c for _, _, c in dm})}

    ti = tis.contem(pt)
    if ti:
        ind.add("area_protegida")
        det["ti"] = f'TI {ti["terrai_nom"]}' + (f' ({ti["etnia_nome"]})' if ti.get("etnia_nome") else "")
    uc = ucs.contem(pt)
    if uc:
        det["uc"] = uc["nome"].title()
        det["uc_grupo"] = uc.get("grupo")
        ind.add("area_protegida" if uc.get("grupo") == "PI" else "uso_sustentavel")
    if "area_protegida" in ind:
        ind.discard("uso_sustentavel")

    anos_prev = set()
    for c in set(g["cel"]):
        anos_prev |= {a for a in anos_por_cel.get(c, ()) if a < ini.year}
    if len(anos_prev) >= 2:
        ind.add("reincidencia")
    det["anos_anteriores"] = sorted(int(a) for a in anos_prev)

    max_dia = int(g.groupby(g["data"].dt.date).size().max())
    if max_dia >= 3:
        ind.add("multiplos_focos_dia")
    if ini.month in config.MESES_PROIBICAO:
        ind.add("periodo_proibitivo")

    for gm, p in cicat.proximos(area):
        vd = pd.Timestamp(p["view_date"])
        if ini - pd.Timedelta(days=10) <= vd <= fim + pd.Timedelta(days=60):
            ind.add("cicatriz_deter")
            det["cicatriz_km2"] = round(p.get("areamunkm") or 0, 3)
            det["cicatriz_data"] = p["view_date"]
            break

    primeiro = g.iloc[0]
    # dia + posição a ~1 km: estável quando o arquivo diário substitui o de 10 min
    chave = f'{ini:%Y%m%d}|{primeiro["lat"]:.2f}|{primeiro["lon"]:.2f}'
    # dados do INPE por foco (disponíveis nos arquivos diários/mensais do ano corrente)
    fogo = {}
    for c, nome in (("frp", "frp"), ("dias_sem_chuva", "dias_sem_chuva"), ("risco_fogo", "risco_fogo"),
                    ("precipitacao", "precipitacao")):
        if c in g and g[c].notna().any():
            x = g[c].dropna()
            fogo[nome + ("_max" if c == "frp" else "_mediana")] = round(float(x.max() if c == "frp" else x.median()), 2)
            if c == "frp":
                fogo["frp_soma"] = round(float(x.sum()), 1)
    horas = g["data"].dt.hour
    fogo["focos_noite"] = int(((horas >= 2) & (horas <= 10)).sum())   # 22h–6h em Manaus (UTC−4)
    fogo["dias_com_fogo"] = int(g["data"].dt.date.nunique())
    if fogo.get("risco_fogo_mediana") is not None:
        # risco do INPE no(s) foco(s) do 1º dia
        r1 = g[g["data"].dt.date == ini.date()]["risco_fogo"].dropna()
        if len(r1):
            fogo["risco_fogo_inicio"] = round(float(r1.median()), 2)
    det["fogo"] = fogo

    return {
        "chave": chave,
        "lat": round(lat, 5), "lon": round(lon, 5),
        "municipio": g["municipio"].mode().iat[0] if len(g["municipio"].mode()) else "",
        "inicio": ini.strftime("%Y-%m-%d %H:%M"), "fim": fim.strftime("%Y-%m-%d %H:%M"),
        "n_focos": int(len(g)), "max_focos_dia": max_dia,
        "satelites": sorted(set(g["satelite"])),
        "dist_manaus_km": round(haversine_km(lat, lon, *config.MANAUS), 1),
        "indicadores": sorted(ind), "score": sum(config.PESOS[k] for k in ind), "det": det,
    }


def calcular(df=None, anos=None):
    df = carregar_focos() if df is None else df
    anos_por_cel = df[df["ref"]].groupby("cel")["ano"].apply(set).to_dict()
    desmat, cicat = geo.deter()
    tis, ucs = geo.tis(), geo.ucs()

    ref = df[df["ref"] & (df["ano"] >= (anos[0] if anos else 2023))].copy()
    ref["ev"] = agrupar(ref)
    eventos = []
    for k, g in ref.groupby("ev"):
        e = pontuar(g, anos_por_cel, desmat, cicat, tis, ucs)
        e["trilha"] = "referencia"
        eventos.append(e)

    limite = df["data"].max() - pd.Timedelta(days=config.DIAS_TEMPO_REAL)
    rt = df[df["satelite"].isin(config.SAT_TEMPO_REAL) & (df["data"] >= limite)].copy()
    alertas = []
    if len(rt):
        rt["ev"] = agrupar(rt)
        for k, g in rt.groupby("ev"):
            e = pontuar(g, anos_por_cel, desmat, cicat, tis, ucs)
            e["trilha"] = "tempo_real"
            alertas.append(e)

    atipicidade(eventos, alertas)

    def ordenar(lst, prefixo):
        # identificador estável: data do 1º foco + hash do 1º foco (não muda entre ciclos)
        usados = {}
        for e in sorted(lst, key=lambda e: (e["inicio"], e["lat"], e["lon"])):
            h = hashlib.sha1(e.pop("chave").encode()).hexdigest()[:6].upper()
            base = f"{prefixo}{e['inicio'][:10].replace('-', '')}-{h}"
            usados[base] = usados.get(base, 0) + 1
            e["id"] = base if usados[base] == 1 else f"{base}-{usados[base]}"
        return sorted(lst, key=lambda e: (-e["score"], -e["n_focos"]))

    return df, ordenar(eventos, "R"), ordenar(alertas, "T")


# ------------------------------------------------------------------ IA
def _vetor(e):
    """Atributos do evento usados pelo modelo de atipicidade."""
    d = e["det"]
    ini = pd.Timestamp(e["inicio"])
    dur_h = (pd.Timestamp(e["fim"]) - ini).total_seconds() / 3600
    dm = d.get("desmatamento") or {}
    return [
        math.log1p(e["n_focos"]), e["max_focos_dia"], math.log1p(dur_h),
        1.0 if dm else 0.0, math.log1p(dm.get("area_km2", 0) * 100), 1 / (1 + dm.get("dias_antes", 365) / 30),
        len(d.get("anos_anteriores", [])),
        1.0 if d.get("ti") else 0.0, 1.0 if d.get("uc") else 0.0, 1.0 if "cicatriz_deter" in e["indicadores"] else 0.0,
        math.log1p(e["dist_manaus_km"]),
        math.sin(2 * math.pi * ini.month / 12), math.cos(2 * math.pi * ini.month / 12),
    ]


def atipicidade(eventos, alertas):
    """Isolation Forest (não supervisionado): aprende o padrão dos eventos de
    fogo do Amazonas e dá a cada evento uma nota de 0 a 100 de quão atípico
    ele é em relação a esse padrão (percentil da anomalia)."""
    if len(eventos) < 50:
        return
    X = np.array([_vetor(e) for e in eventos])
    modelo = IsolationForest(n_estimators=300, contamination="auto", random_state=42).fit(X)
    ref = -modelo.score_samples(X)              # maior = mais anômalo
    ordenado = np.sort(ref)
    for lst in (eventos, alertas):
        if not lst:
            continue
        s = -modelo.score_samples(np.array([_vetor(e) for e in lst]))
        pct = np.searchsorted(ordenado, s, side="right") / len(ordenado) * 100
        for e, p in zip(lst, pct):
            e["ia"] = int(round(p))



# ------------------------------------------------------------------ clima
def aplicar_clima(lista):
    """Usa o clima do 1º foco (Open-Meteo) e o risco de fogo do INPE para o sinal
    "ignição em condição desfavorável" e para o contexto (escape plausível,
    queima de muita biomassa). Recalcula a pontuação."""
    for e in lista:
        cl, fogo = e.get("clima") or {}, e["det"].get("fogo") or {}
        if cl:
            e["det"]["clima"] = cl
        motivos = []
        risco = fogo.get("risco_fogo_inicio")
        if risco is not None and risco < 0.3:
            motivos.append(f"risco de fogo do INPE {risco:.2f}")
        if (cl.get("chuva_72h_mm") or 0) >= 10:
            motivos.append(f"{cl['chuva_72h_mm']:.0f} mm de chuva nas 72 h anteriores")
        if (cl.get("umidade_min_24h") or 0) >= 80:
            motivos.append(f"umidade mínima de {cl['umidade_min_24h']:.0f}% nas 24 h anteriores")
        ind = set(e["indicadores"])
        if motivos:
            ind.add("ignicao_desfavoravel")
            e["det"]["ignicao_desfavoravel"] = motivos
        else:
            ind.discard("ignicao_desfavoravel")
        contexto = []
        if ((risco or 0) >= 0.8 or (fogo.get("dias_sem_chuva_mediana") or 0) >= 30) and (cl.get("vento_kmh") or 0) >= 10:
            contexto.append("escape_plausivel")
        if (fogo.get("frp_max") or 0) >= 100 and (fogo.get("dias_com_fogo", 1) >= 2 or fogo.get("focos_noite", 0) > 0):
            contexto.append("biomassa_alta")
        e["det"]["contexto"] = contexto
        e["indicadores"] = sorted(ind)
        e["score"] = min(100, sum(config.PESOS[k] for k in ind))
    return lista
