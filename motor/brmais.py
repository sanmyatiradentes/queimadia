"""Prepara os alertas do Brasil MAIS (convênio, ACESSO RESTRITO) para a área com login.

    python -m motor.brmais caminho/alerts_UTF-8.csv pasta_saida   (um arquivo por ano + índice)

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


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
