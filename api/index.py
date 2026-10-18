"""Função serverless da Vercel: API de análise do QueimadIA (NDVI, imagens,
dNBR, mosaicos, parecer). Os dados do painel vêm do Vercel Blob, atualizado
pelo GitHub Actions a cada 10 minutos."""
import sys
from pathlib import Path
from urllib.parse import parse_qsl, urlencode

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi import FastAPI  # noqa: E402
from motor.api_analise import router  # noqa: E402

_app = FastAPI(title="QueimadIA", docs_url="/api/docs", openapi_url="/api/openapi.json")
_app.include_router(router)


async def app(scope, receive, send):
    """A Vercel entrega toda chamada como /api/index (ver vercel.json); o caminho
    original vem no parâmetro __rota. Restaura-o antes de passar ao FastAPI."""
    if scope["type"] == "http":
        q = parse_qsl(scope.get("query_string", b"").decode(), keep_blank_values=True)
        rota = next((v for k, v in q if k == "__rota"), None)
        if rota is not None:
            scope = dict(scope, path="/api/" + rota.lstrip("/"), raw_path=("/api/" + rota.lstrip("/")).encode(),
                         query_string=urlencode([(k, v) for k, v in q if k != "__rota"]).encode())
    await _app(scope, receive, send)
