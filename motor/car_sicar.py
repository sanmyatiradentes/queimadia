"""Camadas declaradas no CAR (SICAR, base de downloads do Amazonas): APP, Reserva Legal, área consolidada,
vegetação nativa, uso restrito e pousio.

Uso LOCAL, depois de baixar os arquivos em https://consultapublica.car.gov.br/publico/estados/downloads:
    python -m motor.car_sicar ~/Downloads/car_am

Lê os .zip (sem extrair), simplifica, divide em quadrículas de 0,25° e envia ao armazenamento PRIVADO
(restrito/car/<camada>/c_<i>_<j>.json + restrito/car/indice.json). O motor usa essas quadrículas para
cruzar cada evento com as camadas declaradas (car_camadas.py).
"""
import io
import json
import math
import os
import re
import sys
import zipfile
from collections import defaultdict

CEL = 0.25
CAMADAS = [  # (código, nome, padrões no nome do arquivo)
    ("app", "Área de Preservação Permanente", r"APP|PRESERVA"),
    ("rl", "Reserva Legal", r"RESERVA|LEGAL"),
    ("consolidada", "Área Consolidada", r"CONSOLIDAD"),
    ("rvn", "Remanescente de Vegetação Nativa", r"VEGETA|NATIVA|REMANESC"),
    ("uso_restrito", "Uso Restrito", r"RESTRITO"),
    ("pousio", "Área de Pousio", r"POUSIO"),
]


def camada_do_arquivo(nome):
    n = nome.upper().replace("Ç", "C").replace("Ã", "A")
    for cod, _, padrao in CAMADAS:
        if re.search(padrao, n):
            return cod
    return None


def processar(pasta, saida):
    import shapefile
    from shapely.geometry import mapping, shape
    os.makedirs(saida, exist_ok=True)
    indice = {"fonte": "SICAR — base de downloads do Amazonas (dados declarados pelos proprietários)", "celula_graus": CEL, "camadas": {}}
    for arq in sorted(os.listdir(pasta)):
        if not arq.lower().endswith(".zip"):
            continue
        cod = camada_do_arquivo(arq)
        if not cod:
            print("ignorado:", arq)
            continue
        z = zipfile.ZipFile(os.path.join(pasta, arq))
        shp = [n for n in z.namelist() if n.lower().endswith(".shp")]
        if not shp:
            print("sem .shp:", arq)
            continue
        base = shp[0][:-4]
        r = shapefile.Reader(shp=io.BytesIO(z.read(base + ".shp")), shx=io.BytesIO(z.read(base + ".shx")),
                             dbf=io.BytesIO(z.read(base + ".dbf")), encoding="latin1")
        campos = [f[0].lower() for f in r.fields[1:]]
        celulas = defaultdict(list)
        n = 0
        for sr in r.iterShapeRecords():
            a = dict(zip(campos, sr.record))
            g = shape(sr.shape.__geo_interface__).simplify(0.0001, preserve_topology=True)
            if g.is_empty:
                continue
            props = {"cod": str(a.get("cod_imovel") or a.get("codigo") or a.get("cod_imov") or ""),
                     "ha": round(float(a.get("num_area") or a.get("area") or 0) or 0, 2)}
            geo = json.loads(json.dumps(mapping(g)), parse_float=lambda x: round(float(x), 5))
            x0, y0, x1, y1 = g.bounds
            for i in range(math.floor(y0 / CEL), math.floor(y1 / CEL) + 1):
                for j in range(math.floor(x0 / CEL), math.floor(x1 / CEL) + 1):
                    celulas[f"{i}_{j}"].append({"type": "Feature", "properties": props, "geometry": geo})
            n += 1
        os.makedirs(f"{saida}/{cod}", exist_ok=True)
        for c, feats in celulas.items():
            json.dump({"type": "FeatureCollection", "features": feats}, open(f"{saida}/{cod}/c_{c}.json", "w"), separators=(",", ":"))
        indice["camadas"][cod] = {"nome": dict((c[0], c[1]) for c in CAMADAS)[cod], "arquivo": arq, "poligonos": n, "celulas": sorted(celulas)}
        print(f"{cod}: {n} polígonos em {len(celulas)} quadrículas ({arq})")
    json.dump(indice, open(f"{saida}/indice.json", "w"), ensure_ascii=False)
    return indice


if __name__ == "__main__":
    pasta = os.path.expanduser(sys.argv[1])
    saida = sys.argv[2] if len(sys.argv) > 2 else os.path.join(pasta, "_car_processado")
    print(json.dumps({k: v["poligonos"] for k, v in processar(pasta, saida)["camadas"].items()}, ensure_ascii=False))
    print("Agora envie ao armazenamento privado:  node motor/enviar_car.mjs", saida)
