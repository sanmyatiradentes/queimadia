"""Camadas geográficas: municípios, TIs, UCs e alertas DETER do Amazonas."""
import json
from functools import lru_cache

from shapely.geometry import shape, box, Point, mapping
from shapely.strtree import STRtree

from . import config

AM = box(*config.AM_BBOX)


def _carregar(caminho, filtro=None):
    d = json.load(open(caminho))
    geoms, props = [], []
    for f in d.get("features", []):
        if not f.get("geometry"):
            continue
        if filtro and not filtro(f["properties"]):
            continue
        g = shape(f["geometry"])
        if not g.intersects(AM):
            continue
        if not g.is_valid:
            g = g.buffer(0)
        geoms.append(g)
        props.append(f["properties"])
    return geoms, props


class Camada:
    def __init__(self, geoms, props):
        self.geoms, self.props = geoms, props
        self.tree = STRtree(geoms) if geoms else None

    def contem(self, pt):
        if not self.tree:
            return None
        for i in self.tree.query(pt):
            if self.geoms[i].contains(pt):
                return self.props[i]
        return None

    def proximos(self, geom):
        if not self.tree:
            return []
        return [(self.geoms[i], self.props[i]) for i in self.tree.query(geom) if self.geoms[i].intersects(geom)]


@lru_cache(maxsize=1)
def municipios():
    return Camada(*_carregar(config.DADOS / "areas" / "mun.json", lambda p: str(p["geocodigo"]).startswith("13")))


@lru_cache(maxsize=1)
def tis():
    return Camada(*_carregar(config.DADOS / "areas" / "tis.json"))


@lru_cache(maxsize=1)
def ucs():
    return Camada(*_carregar(config.DADOS / "areas" / "ucs.json"))


DESMAT_CLASSES = ("DESMATAMENTO_CR", "DESMATAMENTO_VEG", "CS_DESORDENADO", "CS_GEOMETRICO")
_deter_cache = {}


def deter():
    """(desmatamento, cicatrizes) com a versão atual dos arquivos DETER."""
    arquivos = sorted((config.DADOS / "deter").glob("deter_am_*.json"))
    chave = tuple((a.name, a.stat().st_mtime) for a in arquivos)
    if _deter_cache.get("chave") != chave:
        dm, dmp, ci, cip = [], [], [], []
        for a in arquivos:
            g, p = _carregar(a)
            for gi, pi in zip(g, p):
                if pi["classname"] in DESMAT_CLASSES:
                    dm.append(gi); dmp.append(pi)
                elif pi["classname"] == "CICATRIZ_DE_QUEIMADA":
                    ci.append(gi); cip.append(pi)
        _deter_cache.update(chave=chave, desmat=Camada(dm, dmp), cicat=Camada(ci, cip))
    return _deter_cache["desmat"], _deter_cache["cicat"]


def municipio_de(lat, lon):
    p = municipios().contem(Point(lon, lat))
    return p["nome"] if p else None


def arredonda(geo, nd=4):
    if isinstance(geo, (list, tuple)):
        if geo and isinstance(geo[0], (int, float)):
            return [round(geo[0], nd), round(geo[1], nd)]
        return [arredonda(g, nd) for g in geo]
    return geo


def geojson_simplificado(camada, props, tol=0.005, nd=4):
    feats = []
    for g, p in zip(camada.geoms, camada.props):
        s = g.simplify(tol, preserve_topology=True)
        if s.is_empty:
            continue
        m = mapping(s)
        feats.append({"type": "Feature", "properties": {k: p.get(k) for k in props},
                      "geometry": {"type": m["type"], "coordinates": arredonda(m["coordinates"], nd)}})
    return {"type": "FeatureCollection", "features": feats}
