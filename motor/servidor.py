"""Servidor do QueimadIA para hospedagem própria (ex.: servidor do Integra).

    python -m motor.servidor            # http://127.0.0.1:8090

Serve o painel (public/), a API de análise e roda o atualizador em segundo
plano: tempo real a cada 10 min e ciclo completo (DETER, diário) a cada hora.
Todas as URLs do painel são relativas, então funciona atrás do nginx em
/queimadia/ sem configuração extra.
"""
import os
import threading
import time
import traceback
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles

from . import atualizar, config, ingest
from .api_analise import router

_estado = {"ativo": False, "proximo": time.time(), "ultimo_completo": 0}
_trava = threading.Lock()


def _rodar(rapido):
    if not _trava.acquire(blocking=False):
        return
    try:
        _estado["ativo"] = True
        atualizar.ciclo(rapido=rapido)
        if not rapido:
            _estado["ultimo_completo"] = time.time()
    except Exception:
        traceback.print_exc()
    finally:
        _estado["ativo"] = False
        _trava.release()


def _laco():
    while True:
        completo = time.time() - _estado["ultimo_completo"] >= config.INTERVALO_DIARIO
        _rodar(rapido=not completo)
        _estado["proximo"] = time.time() + config.INTERVALO_10MIN
        time.sleep(config.INTERVALO_10MIN)


@asynccontextmanager
async def ciclo_de_vida(app):
    if os.environ.get("QUEIMADIA_SEM_ATUALIZADOR") != "1":
        threading.Thread(target=_laco, daemon=True).start()
    yield


app = FastAPI(title="QueimadIA", docs_url="/api/docs", openapi_url="/api/openapi.json", lifespan=ciclo_de_vida)
app.add_middleware(GZipMiddleware, minimum_size=1000)
app.include_router(router)


@app.get("/api/status")
def status():
    st = ingest.status()
    st["atualizador_ativo"] = _estado["ativo"]
    st["proximo_ciclo_s"] = max(0, int(_estado["proximo"] - time.time()))
    return st


@app.post("/api/atualizar")
def atualizar_agora():
    threading.Thread(target=_rodar, args=(False,), daemon=True).start()
    return {"ok": True}


app.mount("/", StaticFiles(directory=config.RAIZ / "public", html=True), name="painel")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("motor.servidor:app", host=os.environ.get("HOST", "127.0.0.1"),
                port=int(os.environ.get("PORT", 8090)), proxy_headers=True, forwarded_allow_ips="*")
