"""Rotas da API de análise (comuns ao servidor próprio e à Vercel).

Só depende de ndvi.py e parecer.py: nada de pandas/shapely/sklearn, para
caber numa função serverless.
"""
import base64

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import JSONResponse, Response

from . import ndvi, parecer

router = APIRouter(prefix="/api")
CACHE_IMG = {"Cache-Control": "public, max-age=604800, s-maxage=604800, immutable"}
CACHE_CURTO = {"Cache-Control": "public, max-age=600, s-maxage=600"}


@router.get("/cenas")
def cenas(lat: float, lon: float, inicio: str, fim: str, colecoes: str = "sentinel-2-l2a,landsat-c2-l2",
          modo: str = "mes", nuvem_max: float = 70):
    cols = tuple(c for c in colecoes.split(",") if c in ndvi.COLECOES)
    return JSONResponse(ndvi.buscar_cenas(lat, lon, inicio, fim, cols, modo, nuvem_max), headers=CACHE_CURTO)


@router.get("/medir")
def medir(colecao: str, id: str, lat: float, lon: float, raio_m: float = Query(600, ge=50, le=10000)):
    try:
        return JSONResponse(ndvi.medir_cena(colecao, id, lat, lon, raio_m), headers=CACHE_IMG)
    except Exception as e:
        return {"id": id, "colecao": colecao, "erro": f"{type(e).__name__}: {str(e)[:200]}"}


@router.get("/imagem")
def imagem(colecao: str, id: str, lat: float, lon: float, lado_m: float = Query(4000, ge=500, le=20000),
           produto: str = "rgb", raio_m: float | None = None):
    if produto not in ("rgb", "falsacor", "ndvi", "nbr", "ndmi"):
        raise HTTPException(400, "produto inválido")
    try:
        png = ndvi.imagem(colecao, id, lat, lon, lado_m, produto, raio_m)
    except Exception as e:
        raise HTTPException(502, f"falha ao ler a cena: {type(e).__name__}")
    return Response(png, media_type="image/png", headers=CACHE_IMG)


@router.get("/dnbr")
def dnbr(col_a: str, id_a: str, col_b: str, id_b: str, lat: float, lon: float,
         lado_m: float = Query(4000, ge=500, le=20000), raio_m: float | None = None):
    try:
        png, stats = ndvi.dnbr(col_a, id_a, col_b, id_b, lat, lon, lado_m, raio_m)
    except Exception as e:
        raise HTTPException(502, f"falha ao calcular dNBR: {type(e).__name__}")
    return JSONResponse({"png": base64.b64encode(png).decode(), **stats}, headers=CACHE_IMG)


@router.post("/quebra")
def quebra(corpo: dict):
    return ndvi.detectar_quebra(corpo.get("serie", []), corpo.get("ref_ini"), corpo.get("ref_fim"))


@router.get("/mosaico")
def mosaico(dias: int = Query(45, ge=5, le=365), nuvem: int = Query(20, ge=1, le=100)):
    return JSONResponse(ndvi.mosaico(dias, nuvem), headers=CACHE_CURTO)


@router.post("/parecer")
def gerar_parecer(corpo: dict):
    try:
        return parecer.gerar(corpo)
    except parecer.ParecerIndisponivel as e:
        raise HTTPException(503, str(e))
