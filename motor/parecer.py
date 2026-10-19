"""Parecer técnico preliminar redigido por IA a partir dos números calculados
pelo QueimadIA. O modelo só organiza e explica o que foi medido: não acrescenta
fatos, não atribui autoria e declara as limitações.

Provedor: Google Gemini. Chave em GEMINI_API_KEY; modelo em GEMINI_MODELO.
"""
import json
import os

import requests

GEMINI_MODELO = os.environ.get("GEMINI_MODELO")   # vazio: escolhe o Flash-Lite mais recente da conta
GEMINI_LISTA = "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000"
_modelo_escolhido = None
GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/{modelo}:generateContent"

SISTEMA = """Você redige pareceres técnicos preliminares para o Núcleo de Inovação, Pesquisa e Desenvolvimento da Polícia Civil do Amazonas (NIPED/PCAM) e para o Departamento de Polícia Técnico-Científica (DPTC-AM), sobre possíveis queimadas criminosas identificadas por satélite.

Regras:
- Use somente os dados do JSON recebido. Não invente datas, áreas, nomes, proprietários ou fatos.
- O sensoriamento remoto detecta calor e mudança de vegetação, não autoria nem intenção. Trate tudo como indício para orientar diligência, nunca como prova.
- Cite os números com as unidades e as datas no formato dd/mm/aaaa.
- Explique em linguagem técnica e clara, para um delegado ou perito que não é especialista em satélite.
- Se a área estiver em terra indígena ou reserva de uso sustentável, lembre que o uso tradicional do fogo pode ser legal.
- Critério de quebra: o NDVI precisa ficar abaixo do limiar em 6 observações consecutivas (CCDC; Zhu & Woodcock, 2014; Arévalo et al., 2020). Se "situacao" for "provavel", diga que a mudança ainda não está confirmada e aguarda novas imagens. Se houver "quedas_transitorias", explique que foram quedas passageiras, com recuperação. Se houver "removidas_tmask", informe que essas imagens saíram da linha de base por névoa ou sombra residual.
- Clima (det.clima e det.fogo): use vento, umidade mínima, chuva das 72 h, dias sem chuva, risco de fogo do INPE e FRP para discutir as duas hipóteses. "ignicao_desfavoravel" pesa para ignição deliberada. "escape_plausivel" torna possível uma queima que fugiu do controle. "biomassa_alta" indica queima de muita biomassa, como mata derrubada. Se "fumaca_rumo_manaus" for verdadeiro, mencione o impacto potencial na qualidade do ar em Manaus e o tempo estimado.
- Faça um confronto explícito das hipóteses: liste os sinais que apontam para fogo intencional e os compatíveis com acidente ou queima tradicional, e diga qual predomina. Não conclua sobre autoria.
- Estrutura: 1. Objeto; 2. Dados e método (fontes, satélites, período, critério de quebra, triagem Tmask); 3. Resultados (série de NDVI, situação da quebra e intervalo de data, dNBR e área queimada, indicadores, clima no início do fogo); 4. Confronto de hipóteses (intencional × acidental); 5. Interpretação técnica; 6. Limitações; 7. Diligências sugeridas (ex.: perícia de local, consulta ao CAR/SIGEF, embargos, autorização de queima no IPAAM, imagens de maior resolução).
- Texto corrido em português, sem markdown, sem tabelas. Máximo de 800 palavras."""

class ParecerIndisponivel(Exception):
    pass


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
    if not os.environ.get("GEMINI_API_KEY"):
        raise ParecerIndisponivel("chave do Gemini não configurada (GEMINI_API_KEY)")
    return _gemini(pedido)


def _escolher_modelo(chave):
    """O mais recente da família Flash-Lite (texto) disponível para a chave."""
    global _modelo_escolhido
    if GEMINI_MODELO:
        return GEMINI_MODELO
    if _modelo_escolhido:
        return _modelo_escolhido
    import re
    r = requests.get(GEMINI_LISTA, headers={"x-goog-api-key": chave}, timeout=60)
    if not r.ok:
        raise ParecerIndisponivel(f"não foi possível listar os modelos do Gemini ({r.status_code})")
    candidatos = []
    for m in r.json().get("models", []):
        nome = m["name"].split("/")[-1]
        if "generateContent" not in m.get("supportedGenerationMethods", []):
            continue
        if not nome.startswith("gemini-") or "flash-lite" not in nome:
            continue
        if re.search(r"image|tts|audio|live|thinking|exp|preview|embedding", nome):
            continue
        versao = tuple(int(x) for x in re.findall(r"\d+", nome.split("flash")[0]))
        candidatos.append((versao, -len(nome), nome))
    if not candidatos:
        raise ParecerIndisponivel("nenhum modelo Gemini Flash-Lite disponível para esta chave")
    _modelo_escolhido = max(candidatos)[2]
    return _modelo_escolhido


def _gemini(pedido):
    corpo = {"systemInstruction": {"parts": [{"text": SISTEMA}]},
             "contents": [{"role": "user", "parts": [{"text": pedido}]}],
             "generationConfig": {"temperature": 0.2, "maxOutputTokens": 8192}}
    try:
        chave = os.environ["GEMINI_API_KEY"]
        modelo = _escolher_modelo(chave)
        r = requests.post(GEMINI_URL.format(modelo=modelo), json=corpo, timeout=180,
                          headers={"x-goog-api-key": chave})
    except requests.RequestException:
        raise ParecerIndisponivel("sem conexão com a API Gemini")
    if r.status_code == 429:
        raise ParecerIndisponivel("limite de uso da API Gemini atingido; tente de novo em alguns minutos")
    if r.status_code in (400, 401, 403) and "API key" in r.text:
        raise ParecerIndisponivel("chave da API Gemini inválida")
    if not r.ok:
        try:
            msg = r.json()["error"]["message"][:160]
        except Exception:
            msg = ""
        raise ParecerIndisponivel(f"erro da API Gemini ({r.status_code}) {msg}".strip())
    d = r.json()
    cand = (d.get("candidates") or [{}])[0]
    if cand.get("finishReason") in ("SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST"):
        raise ParecerIndisponivel("o modelo recusou gerar este parecer")
    texto = "".join(p.get("text", "") for p in (cand.get("content") or {}).get("parts", [])).strip()
    if not texto:
        raise ParecerIndisponivel("resposta vazia do modelo")
    return {"texto": texto, "modelo": d.get("modelVersion", modelo)}
