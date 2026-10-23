"""Parecer técnico preliminar redigido por IA a partir dos números calculados
pelo Fogo Forense. O modelo só organiza e explica o que foi medido: não acrescenta
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
- Território (det.territorio, MapBiomas Coleção 10, Souza et al., 2020): compare a cobertura do ano anterior ao fogo com a de 5 anos antes. "conversao" (floresta que virou pastagem/agricultura) pesa para ignição deliberada associada a desmatamento, mas não é independente do DETER quando ambos existem. Uso agropecuário consolidado é compatível com queima de manejo (verificar autorização). Floresta sem queima registrada desde 1985 (fogo_historico.anos_max = 0) indica que a fonte foi humana, sem discriminar ignição no local de escape de queima vizinha. fogo_historico mostra o uso recorrente do fogo. Relevo (Copernicus DEM): declividade alta orienta a procurar o início na parte baixa da encosta.
- GOES (det.goes): a primeira detecção geoestacionária estreita o horário em que o fogo já era detectável (antecede_h = horas antes do satélite de referência), sem marcar a hora nem o ponto da ignição (pixel de ~2 km).
- Fumaça (det.ar, Copernicus CAMS): cite o PM2,5 médio diário no local e em Manaus em relação à diretriz da OMS (15 µg/m³ em 24 h) como impacto à saúde; a fumaça em Manaus pode ter várias origens, não atribua só a este evento.
- Entorno: det.estrada (via mais próxima, OpenStreetMap incompleto) indica facilidade de acesso humano, compatível com ignição deliberada e com escape de queima à beira da via; ausência de via mapeada não prova falta de acesso. det.assentamento (INCRA): uso do fogo na agricultura familiar é comum; sugerir verificar o lote e a autorização. det.bacia (ANA): cite a sub-bacia hidrográfica. det.biodiversidade (GBIF): cite as espécies ameaçadas registradas no entorno como dimensão do dano ambiental potencial, lembrando que registros são esparsos e não provam presença no momento do fogo.
- Fundiário e pressão: det.fpnd (floresta pública não destinada, Serviço Florestal Brasileiro) indica terra pública sem destinação, onde desmatamento e fogo são associados à grilagem — favorável à ignição intencional ligada à apropriação de terra, sem demonstrar autoria. det.prodes: desmatamento anual oficial do INPE nos anos anteriores (não independente do DETER e do MapBiomas). det.sigef: imóvel certificado no ponto é pista para identificar o detentor, não prova autoria; sugerir requisição de dados ao INCRA. det.mineracao (garimpo, MapBiomas) e det.pista (pista de pouso, OpenStreetMap) indicam contexto de atividade ilícita e acesso a esclarecer. det.aldeias: comunidades expostas ao fogo e à fumaça.
- Monte a matriz de hipóteses em texto: elementos favoráveis à ignição intencional, compatíveis com acidente ou queima tradicional, e inconclusivos ou lacunas. Não atribua pesos, percentuais nem "predominância" por contagem: diga o que cada elemento sustenta e o que falta para discriminar as hipóteses.
- Regras do guia pericial do NIPED: a primeira detecção por satélite mostra fogo detectável até aquele instante, não a hora nem o ponto da ignição; focos da mesma passagem são simultâneos; o mesmo foco em duas bases (INPE e FIRMS) não é confirmação independente; o centro do pixel não é o ponto de origem. Origem espacial, causa e autoria são conclusões distintas e exigem demonstrações próprias. Condição favorável ao fogo não demonstra fonte de ignição nem autoria. Um vínculo com imóvel (CAR/SIGEF) é pista, não prova; o CAR não é título de propriedade. Se os dados não discriminarem as hipóteses, diga que a origem e a causa permanecem indeterminadas.
- Método: fundamente cada passo na literatura científica, nunca em nomes de sistemas ou programas (não cite "Fogo Forense", "PolicIA", "QueimadIA" nem outro software como origem do método). NDVI: Rouse et al. (1974) e Tucker (1979). Critério de quebra (limiar de 3 desvios-padrão e 6 observações consecutivas): CCDC, Zhu e Woodcock (2014a) e Arévalo et al. (2020). Triagem de nuvem e sombra residuais: Tmask, Zhu e Woodcock (2014b). Severidade da queima: dNBR, Key e Benson (2006). Uso e cobertura da terra: MapBiomas, Souza et al. (2020).
- Estrutura: 1. Objeto; 2. Dados e método (fontes, satélites, período, critério de quebra, triagem Tmask, com as citações); 3. Resultados (série de NDVI, situação da quebra e intervalo de data, dNBR e área queimada, indicadores, clima no início do fogo); 4. Matriz de hipóteses (favoráveis, compatíveis com acidente/queima tradicional, inconclusivos); 5. Interpretação técnica; 6. Limitações; 7. Diligências sugeridas, orientadas pelas lacunas (ex.: perícia de local para delimitar a região de provável início, consulta ao CAR/SIGEF, embargos, autorização de queima no IPAAM, alertas Brasil MAIS, imagens de maior resolução); 8. Referências (liste apenas as obras citadas, no formato autor, ano, título, periódico).
- Títulos das seções numerados em linha própria (ex.: "1. Objeto"), seguidos do texto em parágrafos. Português, sem markdown (sem asteriscos ou #), sem tabelas. Máximo de 900 palavras."""

METODO = ("NDVI (Rouse et al., 1974; Tucker, 1979) como mediana dos pixels válidos num círculo de 600 m; uma cena por mês, "
          "com ao menos 80% da área sem nuvem e a menor nuvem na cena; triagem Tmask de névoa e sombra residuais na linha de base "
          "(Zhu e Woodcock, 2014b); quebra quando o NDVI fica abaixo de mediana − max(3σ; 0,15) em 6 observações consecutivas, "
          "critério de confirmação do CCDC (Zhu e Woodcock, 2014a; Arévalo et al., 2020); severidade da queima por dNBR "
          "(Key e Benson, 2006); Sentinel-2 L2A e Landsat 8/9 Coleção 2 Nível 2.")
REFERENCIAS = [
    "Rouse, J. W.; Haas, R. H.; Schell, J. A.; Deering, D. W. (1974). Monitoring vegetation systems in the Great Plains with ERTS. NASA SP-351, p. 309-317.",
    "Tucker, C. J. (1979). Red and photographic infrared linear combinations for monitoring vegetation. Remote Sensing of Environment, 8, 127-150.",
    "Zhu, Z.; Woodcock, C. E. (2014a). Continuous change detection and classification of land cover using all available Landsat data. Remote Sensing of Environment, 144, 152-171.",
    "Zhu, Z.; Woodcock, C. E. (2014b). Automated cloud, cloud shadow, and snow detection in multitemporal Landsat data: an algorithm designed specifically for monitoring land cover change. Remote Sensing of Environment, 152, 217-234.",
    "Arévalo, P.; Bullock, E. L.; Woodcock, C. E.; Olofsson, P. (2020). A suite of tools for continuous land change monitoring in Google Earth Engine. Frontiers in Climate, 2, 576740.",
    "Souza, C. M. et al. (2020). Reconstructing three decades of land use and land cover changes in Brazilian biomes with Landsat archive and Earth Engine. Remote Sensing, 12(17), 2735.",
    "Key, C. H.; Benson, N. C. (2006). Landscape Assessment (LA): sampling and analysis methods. In: FIREMON: Fire Effects Monitoring and Inventory System. USDA Forest Service, RMRS-GTR-164-CD.",
]

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
    d["metodo"] = METODO              # descrição pela literatura (análises antigas citavam o sistema)
    d["referencias_disponiveis"] = REFERENCIAS
    d.pop("parecer", None); d.pop("imagens", None)
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
