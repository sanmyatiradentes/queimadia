"""Camadas declaradas no CAR (SICAR, base de downloads do Amazonas): APP, Reserva Legal, área consolidada,
vegetação nativa, uso restrito e pousio.

Uso LOCAL, depois de baixar os arquivos em https://consultapublica.car.gov.br/publico/estados/downloads:
    python -m motor.car_sicar ~/Downloads/car_am

Lê os .zip (sem extrair), simplifica, divide em quadrículas de 0,25° e envia ao armazenamento PRIVADO
(restrito/car/<camada>/c_<i>_<j>.json.gz + restrito/car/indice.json). O motor usa essas quadrículas para
cruzar cada evento com as camadas declaradas (car_camadas.py).
"""
import gzip
import json
import math
import os
import re
import shutil
import sys
import time
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


def _feicoes(z, base):
    """Lê .shp e .dbf em fluxo direto do zip (sem .shx: leitura sequencial, sem carregar tudo na memória)."""
    import shapefile
    r = shapefile.Reader(shp=z.open(base + ".shp"), dbf=z.open(base + ".dbf"), encoding="latin1")
    campos = [f[0].lower() for f in r.fields[1:]]
    for sr in r.iterShapeRecords():
        yield sr.shape, dict(zip(campos, sr.record))


def processar(pasta, saida):
    import shapely
    from shapely.geometry import MultiPolygon, box, shape
    os.makedirs(saida, exist_ok=True)
    try:  # processa camada a camada sem perder as já feitas
        indice = json.load(open(f"{saida}/indice.json"))
    except Exception:
        indice = {"fonte": "SICAR — base de downloads do Amazonas (dados declarados pelos proprietários)", "celula_graus": CEL, "camadas": {}}
    indice["gz"] = True
    indice["gerado"] = time.strftime("%Y-%m-%dT%H:%M:%S")
    temas = indice.setdefault("temas", {})
    for arq in sorted(os.listdir(pasta)):
        if not arq.lower().endswith(".zip"):
            continue
        cod = camada_do_arquivo(arq)
        if not cod:
            print("ignorado:", arq)
            continue
        z = zipfile.ZipFile(os.path.join(pasta, arq))
        bases = sorted(n[:-4] for n in z.namelist() if n.lower().endswith(".shp"))
        if not bases:
            print("sem .shp:", arq)
            continue
        shutil.rmtree(f"{saida}/{cod}", ignore_errors=True)
        os.makedirs(f"{saida}/{cod}")
        celulas, buf, tam, n, cancelados = set(), defaultdict(list), 0, 0, 0

        def descarrega():
            for c, linhas in buf.items():
                with gzip.open(f"{saida}/{cod}/c_{c}.json.gz", "at", compresslevel=6) as f:  # membros gzip concatenados
                    if c not in celulas:
                        f.write('{"type":"FeatureCollection","features":[' + ",".join(linhas))
                        celulas.add(c)
                    else:
                        f.write("," + ",".join(linhas))
            buf.clear()

        for base in bases:
            for shp, a in _feicoes(z, base):
                if str(a.get("ind_status") or "").upper() == "CA":  # cadastro cancelado
                    cancelados += 1
                    continue
                try:
                    g = shape(shp.__geo_interface__).simplify(0.0001, preserve_topology=True)
                    if not g.is_valid:
                        g = shapely.make_valid(g)
                except Exception:
                    continue
                if g.is_empty:
                    continue
                props = {"cod": str(a.get("cod_imovel") or a.get("codigo") or a.get("cod_imov") or ""),
                         "ha": round(float(a.get("num_area") or a.get("area") or 0) or 0, 2),
                         "tema": str(a.get("cod_tema") or ""), "st": str(a.get("ind_status") or "")}
                if props["tema"]:
                    temas.setdefault(props["tema"], str(a.get("nom_tema") or ""))
                pr = json.dumps(props, separators=(",", ":"), ensure_ascii=False)
                x0, y0, x1, y1 = g.bounds
                ci, cj = range(math.floor(y0 / CEL), math.floor(y1 / CEL) + 1), range(math.floor(x0 / CEL), math.floor(x1 / CEL) + 1)
                for i in ci:
                    for j in cj:
                        # recorta pela quadrícula: cada pedaço fica numa só (sem duplicar área nem memória)
                        try:
                            p = g if len(ci) == 1 and len(cj) == 1 else g.intersection(box(j * CEL, i * CEL, (j + 1) * CEL, (i + 1) * CEL))
                        except Exception:
                            continue
                        if p.is_empty or p.geom_type not in ("Polygon", "MultiPolygon", "GeometryCollection"):
                            continue
                        if p.geom_type == "GeometryCollection":
                            p = MultiPolygon([q for q in getattr(p, "geoms", []) if q.geom_type == "Polygon"])
                            if p.is_empty:
                                continue
                        linha = '{"type":"Feature","properties":' + pr + ',"geometry":' + shapely.to_geojson(shapely.set_precision(p, 1e-5)) + "}"
                        buf[f"{i}_{j}"].append(linha)
                        tam += len(linha)
                n += 1
                if tam > 150_000_000:
                    descarrega()
                    tam = 0
                if n % 50000 == 0:
                    print(f"  {cod}: {n} polígonos...", flush=True)
        descarrega()
        for c in celulas:
            with gzip.open(f"{saida}/{cod}/c_{c}.json.gz", "at") as f:
                f.write("]}")
        indice["camadas"][cod] = {"nome": dict((c[0], c[1]) for c in CAMADAS)[cod], "arquivo": arq, "poligonos": n,
                                  "cancelados_ignorados": cancelados, "celulas": sorted(celulas)}
        print(f"{cod}: {n} polígonos em {len(celulas)} quadrículas ({arq}; {cancelados} cancelados ignorados)", flush=True)
        json.dump(indice, open(f"{saida}/indice.json", "w"), ensure_ascii=False)
    return indice


if __name__ == "__main__":
    pasta = os.path.expanduser(sys.argv[1])
    saida = sys.argv[2] if len(sys.argv) > 2 else os.path.join(pasta, "_car_processado")
    print(json.dumps({k: v["poligonos"] for k, v in processar(pasta, saida)["camadas"].items()}, ensure_ascii=False))
    print("Agora envie ao armazenamento privado:  node motor/enviar_car.mjs", saida)
