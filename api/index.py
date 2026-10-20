"""Função serverless da Vercel: API de análise do Fogo Forense (NDVI, imagens,
dNBR, mosaicos, parecer). Os dados do painel vêm do Vercel Blob, atualizado
pelo GitHub Actions a cada 10 minutos."""
import base64
import hashlib
import hmac
import json
import os
import sys
import time
from pathlib import Path
from urllib.parse import parse_qsl, urlencode

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi import FastAPI  # noqa: E402
from motor.api_analise import router  # noqa: E402

_app = FastAPI(title="Fogo Forense", docs_url="/api/docs", openapi_url="/api/openapi.json")
_app.include_router(router)


def _sessao_valida(scope) -> bool:
    """Confere o cookie ff_sessao (HMAC-SHA256 com SESSAO_SEGREDO, o mesmo de api/_conta.js) e a validade.
    A situação do cadastro (aprovado/desativado) é conferida pelas funções Node a cada carga do painel."""
    segredo = os.environ.get("SESSAO_SEGREDO", "")
    if len(segredo) < 32:
        return False
    cookie = next((v.decode() for k, v in scope.get("headers", []) if k == b"cookie"), "")
    tok = next((c.split("=", 1)[1] for c in cookie.split("; ") if c.startswith("ff_sessao=")), "")
    corpo, _, sig = tok.partition(".")
    if not corpo or not sig:
        return False
    esp = base64.urlsafe_b64encode(hmac.new(segredo.encode(), corpo.encode(), hashlib.sha256).digest()).rstrip(b"=").decode()
    if not hmac.compare_digest(esp, sig):
        return False
    try:
        p = json.loads(base64.urlsafe_b64decode(corpo + "=" * (-len(corpo) % 4)))
        return p.get("x", 0) > time.time()
    except Exception:
        return False


async def _negar(send):
    corpo = json.dumps({"erro": "Faça login com um cadastro aprovado."}).encode()
    await send({"type": "http.response.start", "status": 401,
                "headers": [(b"content-type", b"application/json"), (b"cache-control", b"no-store")]})
    await send({"type": "http.response.body", "body": corpo})


async def app(scope, receive, send):
    """A Vercel entrega toda chamada como /api/index (ver vercel.json); o caminho
    original vem no parâmetro __rota. Restaura-o antes de passar ao FastAPI."""
    if scope["type"] == "http":
        q = parse_qsl(scope.get("query_string", b"").decode(), keep_blank_values=True)
        rota = next((v for k, v in q if k == "__rota"), None)
        if rota is not None:
            scope = dict(scope, path="/api/" + rota.lstrip("/"), raw_path=("/api/" + rota.lstrip("/")).encode(),
                         query_string=urlencode([(k, v) for k, v in q if k != "__rota"]).encode())
        if not _sessao_valida(scope):
            return await _negar(send)
    await _app(scope, receive, send)
