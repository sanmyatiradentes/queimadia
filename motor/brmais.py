"""Prepara os alertas do Brasil MAIS (convênio, ACESSO RESTRITO) para a área com login.

    python -m motor.brmais caminho/alerts_UTF-8.csv pasta_saida        (queimadas: um arquivo por ano + índice)
    python -m motor.brmais desm caminho/alerts_UTF-8.csv pasta_saida   (desmatamento: quadrículas de 0,5° + resumo)

Uso LOCAL: o resultado vai para o armazenamento PRIVADO da Vercel (restrito/brmais.json),
nunca para o repositório público nem para o armazenamento público.
"""
import json
import re
import sys

import pandas as pd

UUID = re.compile(r"alertUUID=([0-9a-f-]{36})")
DMS = re.compile(r"(\d+)°(\d+)'([\d.,]+)\"?\s*([NSEWO])")


def dms(s):
    m = DMS.search(str(s).replace('""', '"'))
    if not m:
        return None
    g, mi, se, h = m.groups()
    v = int(g) + int(mi) / 60 + float(se.replace(",", ".")) / 3600
    return round(-v if h in "SWO" else v, 5)


def main(csv, saida):
    df = pd.read_csv(csv, low_memory=False)
    out = []
    for r in df.itertuples(index=False):
        la, lo = dms(r.lat_centro), dms(r.long_centr)
        if la is None or lo is None:
            continue
        uuid = UUID.search(str(r.img_antes))
        tipo = {"Cicatriz de Queimadas": "C", "Foco de Queimada": "F", "Foco de Queimada (IA)": "I"}.get(r.tipo, r.tipo)
        out.append([int(r.idt_alerta), tipo, round(float(r.area_ha), 2), str(r.dat_antes)[:10], str(r.dat_depois)[:10],
                    la, lo, str(r.cidades).replace(" - AM", ""), str(r.id_antes), str(r.id_depois),
                    uuid.group(1) if uuid else ""])
    base = {"fonte": "Brasil MAIS (Polícia Federal / convênio) — imagens Planet 3 m. ACESSO RESTRITO.",
            "campos": ["id", "tipo", "area_ha", "data_antes", "data_depois", "lat", "lon", "municipio",
                       "id_planet_antes", "id_planet_depois", "uuid"],
            "tipos": {"C": "Cicatriz de queimada", "F": "Foco de queimada", "I": "Foco de queimada (IA)"},
            "img": "https://imagens-alertas.sccon.com.br/api/images/v2/alerts/generate?alertUUID={uuid}&imageDescription={qual}",
            "raa": "https://plataforma-pf.sccon.com.br/#/dashboard/view-raa/{id}"}
    anos = sorted({a[4][:4] for a in out})
    import os
    os.makedirs(saida, exist_ok=True)
    for ano in anos:
        lst = [a for a in out if a[4][:4] == ano]
        json.dump({**base, "ano": ano, "n": len(lst), "alertas": lst}, open(f"{saida}/brmais_{ano}.json", "w"),
                  ensure_ascii=False, separators=(",", ":"))
    json.dump({**base, "anos": {a: sum(1 for x in out if x[4][:4] == a) for a in anos}, "n": len(out)},
              open(f"{saida}/brmais_indice.json", "w"), ensure_ascii=False)
    print(len(out), "alertas preparados em", len(anos), "anos")


# ---------------------------------------------------------------- desmatamento
# São centenas de milhares de alertas: não cabem numa resposta da API (limite de 4,5 MB) nem no navegador.
# Vão em quadrículas de 0,5° (carregadas só quando o mapa aproxima ou a ficha precisa) e num resumo
# por célula de 0,1° e ano para a visão geral.
TIPOS_DESM = {"Desmatamento - Corte Raso": "R", "Desmatamento - Extração Mineral/Garimpo": "G",
              "Desmatamento - Degradação": "D", "Desmatamento - Acesso": "A",
              "Desmatamento - Degradação - Corte Seletivo": "S", "Desmatamento - Degradação - Agente Químico": "Q"}
CEL = 0.5


def desm(csv, saida):
    import math
    import os
    from collections import defaultdict
    cols = ["idt_alerta", "cidades", "area_ha", "tipo", "dat_antes", "dat_depois", "img_antes", "lat_centro", "long_centr"]
    df = pd.read_csv(csv, usecols=cols, dtype=str)
    celulas, resumo = defaultdict(list), defaultdict(lambda: [0, 0.0])
    for r in df.itertuples(index=False):
        la, lo = dms(r.lat_centro), dms(r.long_centr)
        if la is None or lo is None:
            continue
        t = TIPOS_DESM.get(r.tipo, "R")
        uuid = UUID.search(str(r.img_antes))
        a = [int(r.idt_alerta), t, round(float(r.area_ha), 2), str(r.dat_antes)[:10], str(r.dat_depois)[:10],
             la, lo, str(r.cidades).replace(" - AM", ""), uuid.group(1) if uuid else ""]
        celulas[f"{math.floor(la / CEL)}_{math.floor(lo / CEL)}"].append(a)
        g = "G" if t == "G" else "D"
        k = (round(math.floor(la * 10) / 10 + .05, 2), round(math.floor(lo * 10) / 10 + .05, 2), a[4][:4], g)
        resumo[k][0] += 1
        resumo[k][1] += a[2]
    os.makedirs(f"{saida}/desm", exist_ok=True)
    base = {"fonte": "Brasil MAIS (Polícia Federal / convênio) — alertas de desmatamento, imagens Planet 3 m. ACESSO RESTRITO.",
            "campos": ["id", "tipo", "area_ha", "data_antes", "data_depois", "lat", "lon", "municipio", "uuid"],
            "tipos": {"R": "Corte raso", "G": "Extração mineral / garimpo", "D": "Degradação", "A": "Acesso (ramal)",
                      "S": "Degradação: corte seletivo", "Q": "Degradação: agente químico"}}
    maior = 0
    for c, lst in celulas.items():
        txt = json.dumps({"celula": c, "alertas": lst}, ensure_ascii=False, separators=(",", ":"))
        maior = max(maior, len(txt))
        open(f"{saida}/desm/c_{c}.json", "w").write(txt)
    json.dump({**base, "celula_graus": CEL, "celulas": sorted(celulas),
               "campos_resumo": ["lat", "lon", "ano", "grupo", "n", "ha"],
               "resumo": [[k[0], k[1], k[2], k[3], v[0], round(v[1], 1)] for k, v in resumo.items()],
               "n": sum(len(v) for v in celulas.values())},
              open(f"{saida}/desm_resumo.json", "w"), ensure_ascii=False, separators=(",", ":"))
    print(sum(len(v) for v in celulas.values()), "alertas em", len(celulas), "quadrículas; maior", maior // 1024, "KB")


if __name__ == "__main__":
    if sys.argv[1] == "desm":
        desm(sys.argv[2], sys.argv[3])
    else:
        main(sys.argv[1], sys.argv[2])
