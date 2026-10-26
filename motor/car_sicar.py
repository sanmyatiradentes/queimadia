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


def _geometria(shp):
    """Monta o polígono a partir dos anéis do shapefile em código nativo (shapely), sem a organização de furos
    do pyshp, que é lenta e gasta muita memória em polígonos com milhares de anéis. Anéis no sentido horário
    são externos e anti-horários são furos (padrão do shapefile); anéis degenerados são descartados."""
    import shapely
    pts, partes = shp.points, list(shp.parts) + [len(shp.points)]
    aneis = [pts[a:b] for a, b in zip(partes[:-1], partes[1:]) if b - a >= 4]
    if not aneis:
        return None
    lr = [shapely.linearrings(r) for r in aneis]
    ccw = shapely.is_ccw(lr)
    pol = shapely.make_valid(shapely.simplify(shapely.polygons(lr), 0.0001, preserve_topology=True))
    ext = [p for p, c in zip(pol, ccw) if not c and not p.is_empty]
    fur = [p for p, c in zip(pol, ccw) if c and not p.is_empty]
    if not ext:  # só "furos": o shapefile está com a orientação invertida
        ext, fur = fur, []
    g = ext[0] if len(ext) == 1 else shapely.union_all(ext)
    if fur:
        g = shapely.difference(g, shapely.union_all(fur))
    return g


def _partes(g):
    """Recorta a geometria pelas quadrículas, dividindo a caixa ao meio recursivamente (clip_by_rect é rápido
    mesmo com polígonos de milhões de vértices). Cada pedaço fica numa só quadrícula, sem área duplicada."""
    import shapely
    from shapely.geometry import MultiPolygon
    if g is None or g.is_empty:
        return
    x0, y0, x1, y1 = g.bounds

    def rec(g, i0, i1, j0, j1):
        if g.is_empty:
            return
        if i0 == i1 and j0 == j1:
            if g.geom_type == "GeometryCollection":
                g = MultiPolygon([q for q in g.geoms if q.geom_type == "Polygon"])
            if not g.is_empty and g.geom_type in ("Polygon", "MultiPolygon"):
                yield f"{i0}_{j0}", g
            return
        if i1 - i0 >= j1 - j0:
            m = (i0 + i1) // 2
            partes = [(i0, m, j0, j1), (m + 1, i1, j0, j1)]
        else:
            m = (j0 + j1) // 2
            partes = [(i0, i1, j0, m), (i0, i1, m + 1, j1)]
        for a, b, c, d in partes:
            ret = (c * CEL, a * CEL, (d + 1) * CEL, (b + 1) * CEL)
            try:
                h = shapely.clip_by_rect(g, *ret)
            except shapely.errors.GEOSException:
                try:
                    h = shapely.clip_by_rect(shapely.make_valid(g), *ret)
                except shapely.errors.GEOSException:
                    continue
            yield from rec(h, a, b, c, d)

    yield from rec(g, math.floor(y0 / CEL), math.floor(y1 / CEL), math.floor(x0 / CEL), math.floor(x1 / CEL))


def processar(pasta, saida):
    import shapely
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
        celulas, buf, tam, n, cancelados, fora = set(), defaultdict(list), 0, 0, 0, 0

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
                    g = _geometria(shp)
                except Exception:
                    continue
                if g is None or g.is_empty:
                    continue
                x0, y0, x1, y1 = g.bounds
                if x0 < -75 or x1 > -55 or y0 < -11 or y1 > 4:  # fora do Amazonas (ex.: gravado em UTM, em metros)
                    fora += 1
                    continue
                props = {"cod": str(a.get("cod_imovel") or a.get("codigo") or a.get("cod_imov") or ""),
                         "ha": round(float(a.get("num_area") or a.get("area") or 0) or 0, 2),
                         "tema": str(a.get("cod_tema") or ""), "st": str(a.get("ind_status") or "")}
                if props["tema"]:
                    temas.setdefault(props["tema"], str(a.get("nom_tema") or ""))
                pr = json.dumps(props, separators=(",", ":"), ensure_ascii=False)
                try:
                    pedacos = list(_partes(g))
                except Exception:
                    continue
                for c, p in pedacos:
                    try:
                        geo = shapely.to_geojson(shapely.set_precision(p, 1e-5))
                    except Exception:
                        geo = shapely.to_geojson(p, indent=None)
                    linha = '{"type":"Feature","properties":' + pr + ',"geometry":' + geo + "}"
                    buf[c].append(linha)
                    tam += len(linha)
                n += 1
                if tam > 150_000_000:
                    descarrega()
                    tam = 0
                if n % 20000 == 0:
                    print(f"  {cod}: {n} polígonos...", flush=True)
        descarrega()
        for c in celulas:
            with gzip.open(f"{saida}/{cod}/c_{c}.json.gz", "at") as f:
                f.write("]}")
        indice["camadas"][cod] = {"nome": dict((c[0], c[1]) for c in CAMADAS)[cod], "arquivo": arq, "poligonos": n,
                                  "cancelados_ignorados": cancelados, "fora_do_estado": fora, "celulas": sorted(celulas)}
        print(f"{cod}: {n} polígonos em {len(celulas)} quadrículas ({arq}; {cancelados} cancelados e {fora} fora do estado ignorados)", flush=True)
        json.dump(indice, open(f"{saida}/indice.json", "w"), ensure_ascii=False)
    return indice


if __name__ == "__main__":
    pasta = os.path.expanduser(sys.argv[1])
    saida = sys.argv[2] if len(sys.argv) > 2 else os.path.join(pasta, "_car_processado")
    print(json.dumps({k: v["poligonos"] for k, v in processar(pasta, saida)["camadas"].items()}, ensure_ascii=False))
    print("Agora envie ao armazenamento privado:  node motor/enviar_car.mjs", saida)
