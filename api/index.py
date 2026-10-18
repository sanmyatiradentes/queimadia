"""Função serverless da Vercel: API de análise do QueimadIA (NDVI, imagens,
dNBR, mosaicos, parecer). Os dados do painel vêm do ramo `dados` do GitHub,
atualizado pelo GitHub Actions a cada 10 minutos."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi import FastAPI  # noqa: E402
from motor.api_analise import router  # noqa: E402

app = FastAPI(title="QueimadIA", docs_url="/api/docs", openapi_url="/api/openapi.json")
app.include_router(router)


@app.api_route("/{caminho:path}", methods=["GET", "POST"], include_in_schema=False)
def _diagnostico(caminho: str):
    from fastapi import HTTPException
    raise HTTPException(404, f"rota não encontrada: /{caminho}")
