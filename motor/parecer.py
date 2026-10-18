"""Parecer técnico preliminar redigido por IA a partir dos números calculados
pelo QueimadIA. O modelo só organiza e explica o que foi medido: não acrescenta
fatos, não atribui autoria e declara as limitações.

Provedor (o primeiro com chave configurada no ambiente):
  GEMINI_API_KEY     → Google Gemini (padrão do NIPED; modelo em GEMINI_MODELO)
  ANTHROPIC_API_KEY  → Claude (alternativa; modelo em QUEIMADIA_MODELO)
"""
import json
import os

import requests

MODELO = os.environ.get("QUEIMADIA_MODELO", "claude-opus-5-5")
GEMINI_MODELO = os.environ.get("GEMINI_MODELO", "gemini-2.5-flash")
GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/{modelo}:generateContent"

SISTEMA = """Você redige pareceres técnicos preliminares para o Núcleo de Inovação, Pesquisa e Desenvolvimento da Polícia Civil do Amazonas (NIPED/PCAM) e para o Departamento de Polícia Técnico-Científica (DPTC-AM), sobre possíveis queimadas criminosas identificadas por satélite.

Regras:
- Use somente os dados do JSON recebido. Não invente datas, áreas, nomes, proprietários ou fatos.
- O sensoriamento remoto detecta calor e mudança de vegetação, não autoria nem intenção. Trate tudo como indício para orientar diligência, nunca como prova.
- Cite os números com as unidades e as datas no formato dd/mm/aaaa.
- Explique em linguagem técnica e clara, para um delegado ou perito que não é especialista em satélite.
- Se a área estiver em terra indígena ou reserva de uso sustentável, lembre que o uso tradicional do fogo pode ser legal.
- Estrutura: 1. Objeto; 2. Dados e método (fontes, satélites, período, critério de quebra); 3. Resultados (série de NDVI, quebra e intervalo de data, dNBR e área queimada, indicadores do evento); 4. Interpretação técnica; 5. Limitações; 6. Diligências sugeridas (ex.: perícia de local, consulta ao CAR/SIGEF, embargos, imagens de maior resolução).
- Texto corrido em português, sem markdown, sem tabelas. Máximo de 700 palavras."""

_cliente = None


class ParecerIndisponivel(Exception):
    pass


def cliente():
    global _cliente
    if _cliente is None:
        import anthropic
        _cliente = anthropic.Anthropic(timeout=180.0)
    return _cliente


def _resumir(dados):
    """Remove o que não ajuda o texto (listas longas de cenas viram estatísticas)."""
    d = dict(dados)
    cenas = d.pop("cenas", []) or []
    validas = [c for c in cenas if c.get("ndvi") is not None and (c.get("frac_valida") or 0) >= 0.5]
    d["resumo_cenas"] = {
        "total": len(cenas), "validas": len(validas),
        "sentinel2": sum(1 for c in validas if str(c.get("colecao", "")).startswith("sentinel")),
        "landsat": sum(1 for c in validas if str(c.get("colecao", "")).startswith("landsat")),
        "primeira": validas[0]["data"] if validas else None, "ultima": validas[-1]["data"] if validas else None,
    }
    d["serie_ndvi"] = [[c["data"], c["ndvi"]] for c in validas]
    return d


def gerar(dados):
    msg = json.dumps(_resumir(dados), ensure_ascii=False)
    pedido = f"Dados da análise (JSON):\n{msg}\n\nRedija o parecer técnico preliminar."
    if os.environ.get("GEMINI_API_KEY"):
        return _gemini(pedido)
    if os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"):
        return _claude(pedido)
    raise ParecerIndisponivel("chave de IA não configurada (GEMINI_API_KEY)")


def _gemini(pedido):
    corpo = {"systemInstruction": {"parts": [{"text": SISTEMA}]},
             "contents": [{"role": "user", "parts": [{"text": pedido}]}],
             "generationConfig": {"temperature": 0.2, "maxOutputTokens": 8192}}
    try:
        r = requests.post(GEMINI_URL.format(modelo=GEMINI_MODELO), json=corpo, timeout=180,
                          headers={"x-goog-api-key": os.environ["GEMINI_API_KEY"]})
    except requests.RequestException:
        raise ParecerIndisponivel("sem conexão com a API Gemini")
    if r.status_code == 429:
        raise ParecerIndisponivel("limite de uso da API Gemini atingido; tente de novo em alguns minutos")
    if r.status_code in (400, 401, 403) and "API key" in r.text:
        raise ParecerIndisponivel("chave da API Gemini inválida")
    if not r.ok:
        raise ParecerIndisponivel(f"erro da API Gemini ({r.status_code})")
    d = r.json()
    cand = (d.get("candidates") or [{}])[0]
    if cand.get("finishReason") in ("SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST"):
        raise ParecerIndisponivel("o modelo recusou gerar este parecer")
    texto = "".join(p.get("text", "") for p in (cand.get("content") or {}).get("parts", [])).strip()
    if not texto:
        raise ParecerIndisponivel("resposta vazia do modelo")
    return {"texto": texto, "modelo": d.get("modelVersion", GEMINI_MODELO)}


def _claude(pedido):
    import anthropic
    try:
        resp = cliente().beta.messages.create(
            model=MODELO,
            max_tokens=16000,
            system=SISTEMA,
            output_config={"effort": "medium"},
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
            messages=[{"role": "user", "content": pedido}],
        )
    except anthropic.RateLimitError:
        raise ParecerIndisponivel("limite de uso da API atingido; tente de novo em alguns minutos")
    except anthropic.AuthenticationError:
        raise ParecerIndisponivel("chave da API Claude inválida")
    except anthropic.APIStatusError as e:
        raise ParecerIndisponivel(f"erro da API Claude ({e.status_code})")
    except anthropic.APIConnectionError:
        raise ParecerIndisponivel("sem conexão com a API Claude")
    if resp.stop_reason == "refusal":
        raise ParecerIndisponivel("o modelo recusou gerar este parecer")
    texto = "".join(b.text for b in resp.content if b.type == "text").strip()
    if not texto:
        raise ParecerIndisponivel("resposta vazia do modelo")
    return {"texto": texto, "modelo": resp.model}
