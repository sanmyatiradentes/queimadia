"""Estações Rádio Base (ERBs) licenciadas no Amazonas (Anatel, dados abertos).

Fonte: painel de dados de Outorga e Licenciamento da Anatel, arquivo
Estacoes_SMP.zip (atualização diária). O arquivo tem uma linha por
frequência/setor; aqui as linhas são agrupadas por número da estação.
Atualizado no máximo uma vez por semana. Lido direto do ZIP (sem extrair).

Uso investigativo: indica quais estações estavam licenciadas perto de um
incêndio. A localização da ERB NÃO é a posição de um aparelho; registros de
conexão só por ordem judicial, com vínculo individualizado (ver o guia do NIPED).
"""
import csv
import io
import json
import math
import time
import zipfile

import requests

from . import config

URL = "https://www.anatel.gov.br/dadosabertos/paineis_de_dados/outorga_e_licenciamento/estacoes_smp.zip"
ZIP = config.DADOS / "estacoes_smp.zip"
ARQ = config.PUBLICO / "erbs.json"
RAIO_KM = 15.0          # ERBs consideradas "próximas" de um evento
MAX_PROXIMAS = 8


def _baixar():
    with requests.get(URL, stream=True, timeout=600, headers={"User-Agent": "FogoForense/1.0 (NIPED-PCAM)"}) as r:
        r.raise_for_status()
        tmp = ZIP.with_suffix(".tmp")
        with open(tmp, "wb") as f:
            for bloco in r.iter_content(1 << 20):
                f.write(bloco)
        tmp.replace(ZIP)


def atualizar(forcar=False):
    try:
        atual = json.load(open(ARQ))
        if not forcar and time.time() - atual.get("t", 0) < 7 * 86400:
            return atual
    except Exception:
        atual = None
    try:
        _baixar()
    except Exception as e:
        print("ERBs: download falhou", type(e).__name__)
        return atual
    est = {}
    with zipfile.ZipFile(ZIP) as z:
        nome = [n for n in z.namelist() if n.lower().endswith(".csv")][0]
        with z.open(nome) as bruto:
            leitor = csv.reader(io.TextIOWrapper(bruto, encoding="utf-8-sig", errors="replace"), delimiter=";")
            cab = next(leitor)
            ix = {c: i for i, c in enumerate(cab)}
            def col(*nomes):
                for n in nomes:
                    if n in ix:
                        return ix[n]
                raise KeyError(nomes)
            i_uf, i_num, i_lat, i_lon = col("UF"), col("Número Estação"), col("Latitude decimal"), col("Longitude decimal")
            i_emp, i_ger, i_tec, i_sit = col("Empresa Estação"), col("Geração"), col("Tecnologia"), col("Situacao")
            i_mun, i_lic = col("Município-UF"), col("Data Primeiro Licenciamento")
            for row in leitor:
                if len(row) <= i_uf or row[i_uf] != "AM":
                    continue
                try:
                    la, lo = float(row[i_lat]), float(row[i_lon])
                except ValueError:
                    continue
                k = row[i_num]
                e = est.setdefault(k, {"id": k, "lat": round(la, 5), "lon": round(lo, 5), "op": row[i_emp].strip(),
                                       "ger": set(), "tec": set(), "sit": row[i_sit].strip(),
                                       "mun": row[i_mun].replace(" - AM", "").strip(), "desde": row[i_lic].strip()})
                if row[i_ger]:
                    e["ger"].add(row[i_ger].strip())
                if row[i_tec]:
                    e["tec"].add(row[i_tec].strip())
    lista = []
    for e in est.values():
        e["ger"] = sorted(e["ger"]); e["tec"] = sorted(e["tec"])
        lista.append(e)
    saida = {"t": time.time(), "fonte": "Anatel — Estações do SMP licenciadas (dados abertos)", "n": len(lista), "erbs": lista}
    ARQ.write_text(json.dumps(saida, ensure_ascii=False, separators=(",", ":")))
    try:
        ZIP.unlink()          # 94 MB: não guardar no estado
    except OSError:
        pass
    return saida


def marcar(eventos, base):
    """e["det"]["erbs"] = até 8 ERBs licenciadas a até 15 km do centro do evento."""
    erbs = (base or {}).get("erbs", [])
    if not erbs:
        return 0
    grade = {}
    for b in erbs:
        grade.setdefault((round(b["lat"] / 0.2), round(b["lon"] / 0.2)), []).append(b)
    n = 0
    for e in eventos:
        cand = []
        gi, gj = round(e["lat"] / 0.2), round(e["lon"] / 0.2)
        for di in (-1, 0, 1):
            for dj in (-1, 0, 1):
                cand += grade.get((gi + di, gj + dj), [])
        prox = []
        for b in cand:
            d = math.hypot((b["lat"] - e["lat"]) * 111.32, (b["lon"] - e["lon"]) * 111.32 * math.cos(math.radians(e["lat"])))
            if d <= RAIO_KM:
                prox.append((d, b))
        prox.sort(key=lambda x: x[0])
        if prox:
            e["det"]["erbs"] = [{"id": b["id"], "op": b["op"], "ger": b["ger"], "dist_km": round(d, 1), "sit": b["sit"]}
                                for d, b in prox[:MAX_PROXIMAS]]
            e["det"]["n_erbs_15km"] = len(prox)
            n += 1
        else:
            e["det"].pop("erbs", None)
            e["det"]["n_erbs_15km"] = 0
    return n
