"""Gera os arquivos JSON consumidos pelo painel (public/dados)."""
import json
from datetime import datetime, timezone

import pandas as pd

from . import config, geo, ingest

INDICADORES = config.INDICADORES


def _escrever(nome, obj):
    destino = config.PUBLICO / nome
    tmp = destino.with_suffix(".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")))
    tmp.replace(destino)


def _compacto(e):
    mask = sum(1 << i for i, k in enumerate(INDICADORES) if k in e["indicadores"])
    return [e["id"], e["lat"], e["lon"], e["score"], e["n_focos"], e["max_focos_dia"], e["inicio"], e["fim"],
            e["municipio"], round(e["dist_manaus_km"]), mask, e["det"], e["satelites"], e.get("ia")]


def camadas_estaticas():
    """Municípios, TIs e UCs simplificados (só se ainda não existirem)."""
    if not (config.PUBLICO / "municipios.json").exists():
        _escrever("municipios.json", geo.geojson_simplificado(geo.municipios(), ["nome"], 0.003))
    if not (config.PUBLICO / "tis.json").exists():
        _escrever("tis.json", geo.geojson_simplificado(geo.tis(), ["terrai_nom", "etnia_nome", "fase_ti"], 0.003))
    if not (config.PUBLICO / "ucs.json").exists():
        _escrever("ucs.json", geo.geojson_simplificado(geo.ucs(), ["nome", "categoria", "grupo", "esfera"], 0.003))


def deter_recente(dias=400):
    desmat, cicat = geo.deter()
    limite = (pd.Timestamp.now() - pd.Timedelta(days=dias)).strftime("%Y-%m-%d")
    feats = []
    for camada in (desmat, cicat):
        for g, p in zip(camada.geoms, camada.props):
            if p["view_date"] < limite:
                continue
            s = g.simplify(0.0005, preserve_topology=True)
            feats.append({"type": "Feature",
                          "properties": {"c": p["classname"], "d": p["view_date"], "a": round(p.get("areamunkm") or 0, 3),
                                         "m": p.get("municipality")},
                          "geometry": {"type": s.geom_type, "coordinates": geo.arredonda(geo.mapping(s)["coordinates"], 4)}})
    _escrever("deter.json", {"type": "FeatureCollection", "features": feats})
    return len(feats)


def publicar(df, eventos, alertas):
    camadas_estaticas()
    n_deter = deter_recente()

    ref = df[df["ref"]]
    por_mes = ref.groupby([ref["ano"], ref["data"].dt.month]).size()
    focos_mes = {int(a): [int(por_mes.get((a, m), 0)) for m in range(1, 13)] for a in sorted(ref["ano"].unique())}
    por_mun = ref[ref["ano"] >= 2023].groupby(["ano", "municipio"]).size()
    por_sat = df[df["data"] >= df["data"].max() - pd.Timedelta(days=30)].groupby("satelite").size()

    _escrever("eventos.json", {"indicadores": INDICADORES, "eventos": [_compacto(e) for e in eventos]})
    _escrever("alertas.json", {"indicadores": INDICADORES, "eventos": [_compacto(e) for e in alertas]})

    limite = df["data"].max() - pd.Timedelta(days=config.DIAS_TEMPO_REAL)
    rec = df[df["data"] >= limite]
    _escrever("focos_recentes.json", {
        "campos": ["lat", "lon", "data_utc", "satelite", "municipio"],
        "focos": [[round(a, 4), round(b, 4), c.strftime("%Y-%m-%d %H:%M"), d, e]
                  for a, b, c, d, e in zip(rec.lat, rec.lon, rec.data, rec.satelite, rec.municipio)]})

    st = ingest.status()
    try:
        from . import ndvi
        mosaico = ndvi.mosaico()
    except Exception:
        mosaico = None
    try:
        from . import precalcular
        analises = precalcular.religar(eventos, precalcular.indice())
    except Exception:
        analises = {}
    estat = {
        "mosaico": mosaico,
        "analises": analises,
        "gerado_em": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "focos_por_mes": focos_mes,
        "total_focos_ref": {int(a): int(n) for a, n in ref.groupby("ano").size().items()},
        "focos_por_municipio": {int(a): {m: int(n) for m, n in por_mun.loc[a].sort_values(ascending=False).items()}
                                for a in sorted({a for a, _ in por_mun.index})},
        "focos_30d_por_satelite": {k: int(v) for k, v in por_sat.sort_values(ascending=False).items()},
        "ultimo_foco_utc": df["data"].max().strftime("%Y-%m-%d %H:%M"),
        "focos_recentes": int(len(rec)),
        "n_eventos": len(eventos), "n_alertas": len(alertas), "n_deter": n_deter,
        "pesos": config.PESOS,
        "descricao_indicadores": config.DESCRICAO_INDICADORES,
        "parametros": {"eps_km": config.EPS_KM, "eps_dias": config.EPS_DIAS,
                       "buffer_desmat_km": config.BUFFER_DESMAT_KM,
                       "meses_proibicao": sorted(config.MESES_PROIBICAO),
                       "sat_referencia": config.SAT_REFERENCIA, "sat_tempo_real": list(config.SAT_TEMPO_REAL),
                       "dias_tempo_real": config.DIAS_TEMPO_REAL},
        "fontes": st,
        "versao": datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S"),
    }
    _escrever("estatisticas.json", estat)
    return estat


def atualizar_indice_analises(eventos):
    """Regrava em estatisticas.json o índice das análises prontas (chamado
    depois do pré-cálculo, para o site já mostrar as análises do ciclo)."""
    from . import precalcular
    est = json.load(open(config.PUBLICO / "estatisticas.json"))
    est["analises"] = precalcular.religar(eventos, precalcular.indice())
    _escrever("estatisticas.json", est)
    return est
