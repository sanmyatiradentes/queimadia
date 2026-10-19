"""Coleta dos dados públicos: focos do INPE (histórico, diário e 10 em 10 min)
e alertas DETER. Tudo fica em motor/dados; o estado em motor/dados/estado."""
import io
import json
import re
import zipfile
from datetime import datetime, timedelta, timezone

import pandas as pd
import requests

from . import config, geo

S = requests.Session()
S.headers["User-Agent"] = "Fogo Forense/1.0 (NIPED-PCAM-DPTC)"
STATUS = config.ESTADO / "status.json"
RECENTES = config.ESTADO / "focos_recentes.csv"
COLS = ["lat", "lon", "data", "satelite", "municipio", "fonte", "dias_sem_chuva", "precipitacao", "risco_fogo", "frp"]
EXTRAS = {"numero_dias_sem_chuva": "dias_sem_chuva", "precipitacao": "precipitacao", "risco_fogo": "risco_fogo", "frp": "frp"}


def agora():
    return datetime.now(timezone.utc)


def status():
    try:
        return json.load(open(STATUS))
    except Exception:
        return {}


def salvar_status(**kw):
    st = status()
    st.update(kw)
    json.dump(st, open(STATUS, "w"), ensure_ascii=False, indent=1)
    return st


def _get(url, **kw):
    r = S.get(url, timeout=kw.pop("timeout", 120), **kw)
    r.raise_for_status()
    # o INPE não informa o charset; os CSV vêm em UTF-8 (sem isso, "MAUÉS" vira "MAUÃ‰S")
    try:
        r.content.decode("utf-8")
        r.encoding = "utf-8"
    except UnicodeDecodeError:
        r.encoding = "latin-1"
    return r


def consertar_acentos(texto):
    """Desfaz textos UTF-8 que foram lidos como Latin-1 ("MAUÃ\x89S" → "MAUÉS")."""
    if not isinstance(texto, str) or "Ã" not in texto and "Â" not in texto:
        return texto
    try:
        return texto.encode("latin-1").decode("utf-8")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return texto


def _listar(url, padrao):
    return sorted(set(re.findall(padrao, _get(url).text)))


# ------------------------------------------------------------------ histórico
def historico_ref():
    """Garante um CSV anual do satélite de referência por ano (AM), de
    ANO_INICIAL até o ano anterior. O ano corrente vem do estado."""
    ano_atual = agora().year
    for ano in range(config.ANO_INICIAL, ano_atual):
        destino = config.DADOS / "inpe" / f"focos_br_am_ref_{ano}.csv"
        if destino.exists():
            continue
        for url, filtrar in (
            (f"{config.INPE}/anual/EstadosBr_sat_ref/AM/focos_br_am_ref_{ano}.zip", False),
            (f"{config.INPE}/anual/Brasil_sat_ref/focos_br_ref_{ano}.zip", True),
        ):
            try:
                z = zipfile.ZipFile(io.BytesIO(_get(url, timeout=600).content))
                df = pd.read_csv(z.open([n for n in z.namelist() if n.endswith(".csv")][0]), skipinitialspace=True)
                if filtrar:
                    df = df[df["estado"].str.strip() == config.UF]
                df.to_csv(destino, index=False)
                print(f"histórico {ano}: {len(df)} focos")
                break
            except Exception as e:
                print(f"histórico {ano}: {url} indisponível ({e})")


def _padronizar(df, fonte):
    df = df.rename(columns={"data_hora_gmt": "data", "data_pas": "data", **EXTRAS})
    for c in EXTRAS.values():   # INPE usa -999 para "sem dado"
        df[c] = pd.to_numeric(df[c], errors="coerce").where(lambda x: x > -900) if c in df else float("nan")
    df["lat"] = df["lat"].astype(float).round(5)
    df["lon"] = df["lon"].astype(float).round(5)
    df["data"] = pd.to_datetime(df["data"].astype(str).str.strip()).dt.strftime("%Y-%m-%d %H:%M:%S")
    df["satelite"] = df["satelite"].astype(str).str.strip()
    if "municipio" not in df:
        df["municipio"] = None
    df["fonte"] = fonte
    return df[COLS]


def carregar_recentes():
    if RECENTES.exists():
        df = pd.read_csv(RECENTES)
        df["municipio"] = df["municipio"].map(consertar_acentos)
        return df
    return pd.DataFrame(columns=COLS)


def _gravar_recentes(df):
    df = df.drop_duplicates(["lat", "lon", "satelite", "data"]).sort_values("data")
    df.to_csv(RECENTES, index=False)
    return df


def inicializar_ano_corrente():
    """Primeira execução do ano: baixa os arquivos mensais do ano corrente
    (todos os satélites, só AM)."""
    sem_extras = RECENTES.exists() and "frp" not in pd.read_csv(RECENTES, nrows=1).columns
    if RECENTES.exists() and status().get("ano_inicializado") == agora().year and not sem_extras:
        return
    ano = agora().year
    semente = config.DADOS / "inpe" / f"focos_br_am_ref_{ano}.csv"
    if sem_extras:
        # estado antigo, sem FRP/dias sem chuva/risco de fogo: refaz o ano pelos mensais
        RECENTES.unlink()
        semente = semente.with_suffix(".nao-usar")
    if semente.exists():   # ano corrente já reconstituído (satélite de referência)
        df = pd.read_csv(semente, skipinitialspace=True)
        df["municipio"] = df["municipio"].str.strip()
        _gravar_recentes(pd.concat([carregar_recentes(), _padronizar(df.assign(satelite=config.SAT_REFERENCIA), "mensal")]))
        semente.rename(semente.with_suffix(".importado"))
        salvar_status(ano_inicializado=ano)
        return
    meses = [m for m in _listar(f"{config.INPE}/mensal/Brasil/", r"focos_mensal_br_(\d{6})\.csv") if m.startswith(str(ano))]
    partes = []
    for m in meses:
        df = pd.read_csv(io.StringIO(_get(f"{config.INPE}/mensal/Brasil/focos_mensal_br_{m}.csv", timeout=900).text),
                         skipinitialspace=True)
        df = df[df["estado"].str.strip() == config.UF]
        partes.append(_padronizar(df, "mensal"))
        print(f"mensal {m}: {len(df)} focos AM")
    if partes:
        _gravar_recentes(pd.concat(partes + [carregar_recentes()]))
    salvar_status(ano_inicializado=ano)


# ------------------------------------------------------------------ correntes
def atualizar_diario():
    """Arquivo diário do INPE (todos os satélites, com município) de ontem e
    hoje. Substitui as linhas de 10 min dessas datas: o diário é a referência."""
    hoje = agora().date()
    rec = carregar_recentes()
    novos = 0
    for d in (hoje - timedelta(days=1), hoje):
        nome = f"focos_diario_br_{d:%Y%m%d}.csv"
        try:
            txt = _get(f"{config.INPE}/diario/Brasil/{nome}", timeout=300).text
        except Exception:
            continue
        df = pd.read_csv(io.StringIO(txt), skipinitialspace=True)
        df = _padronizar(df[df["estado"].str.strip() == config.UF], "diario")
        dia = f"{d:%Y-%m-%d}"
        antes = len(rec)
        rec = rec[~((rec["fonte"] == "10min") & rec["data"].str.startswith(dia))]
        rec = pd.concat([rec, df])
        novos += len(df) - (antes - len(rec) if antes > len(rec) else 0)
    rec = _gravar_recentes(rec)
    salvar_status(diario=agora().isoformat(timespec="seconds"), focos_recentes=len(rec))
    return novos


def atualizar_10min():
    """Arquivos de 10 em 10 minutos (lat, lon, satélite, data). O município é
    obtido pelo polígono do IBGE."""
    st = status()
    ultimo = st.get("ultimo_10min", "")
    arquivos = [a for a in _listar(f"{config.INPE}/10min/", r"focos_10min_\d{8}_\d{4}\.csv") if a > ultimo]
    if not ultimo:
        arquivos = arquivos[-36:]   # primeira vez: últimas 6 h
    lon0, lat0, lon1, lat1 = config.AM_BBOX
    partes = []
    for a in arquivos:
        try:
            df = pd.read_csv(io.StringIO(_get(f"{config.INPE}/10min/{a}", timeout=60).text), skipinitialspace=True)
        except Exception:
            continue
        df = df[(df.lon.between(lon0, lon1)) & (df.lat.between(lat0, lat1))].copy()
        if len(df):
            df["municipio"] = [geo.municipio_de(la, lo) for la, lo in zip(df.lat, df.lon)]
            df = df[df["municipio"].notna()]
            df["municipio"] = df["municipio"].str.upper()
            partes.append(_padronizar(df, "10min"))
    novos = sum(len(p) for p in partes)
    if partes:
        _gravar_recentes(pd.concat([carregar_recentes()] + partes))
    if arquivos:
        salvar_status(ultimo_10min=arquivos[-1], tempo_real=agora().isoformat(timespec="seconds"))
    return novos


def atualizar_deter():
    """Alertas DETER do Amazonas do ano corrente (e do anterior em janeiro)."""
    hoje = agora().date()
    anos = {hoje.year} | ({hoje.year - 1} if hoje.month == 1 else set())
    total = 0
    for ano in sorted(anos):
        url = (f"{config.DETER_WFS}?service=WFS&version=2.0.0&request=GetFeature&typeNames=deter-amz:deter_amz"
               f"&outputFormat=application/json&propertyName=geom,classname,view_date,areamunkm,municipality,uc"
               f"&CQL_FILTER=uf='AM' AND view_date BETWEEN '{ano}-01-01' AND '{ano}-12-31'")
        d = _get(url, timeout=600).json()
        destino = config.DADOS / "deter" / f"deter_am_{ano}.json"
        tmp = destino.with_suffix(".tmp")
        json.dump(d, open(tmp, "w"))
        tmp.replace(destino)
        total += len(d["features"])
    ultima = max((f["properties"]["view_date"] for f in d["features"]), default=None)
    salvar_status(deter=agora().isoformat(timespec="seconds"), deter_ultima_imagem=ultima, deter_alertas_ano=total)
    return total


def areas():
    """TIs, UCs e municípios (TerraBrasilis), baixados uma vez."""
    camadas = {"tis": "prodes-legal-amz:indigenous_area_legal_amazon",
               "ucs": "prodes-legal-amz:conservation_units_legal_amazon",
               "mun": "prodes-legal-amz:municipalities_legal_amazon"}
    for nome, tipo in camadas.items():
        destino = config.DADOS / "areas" / f"{nome}.json"
        if destino.exists():
            continue
        url = f"{config.TERRABRASILIS}?service=WFS&version=1.0.0&request=GetFeature&outputFormat=application/json&typeName={tipo}"
        destino.write_bytes(_get(url, timeout=900).content)
