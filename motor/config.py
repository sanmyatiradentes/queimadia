"""Configuração do Radar de Queimadas Suspeitas (NIPED/PCAM/DPTC)."""
from pathlib import Path

NOME = "Fogo Forense"
BASE = Path(__file__).resolve().parent
RAIZ = BASE.parent
DADOS = BASE / "dados"            # estado do motor (histórico, DETER, áreas)
ESTADO = DADOS / "estado"         # guardado entre execuções (cache do GitHub Actions)
PUBLICO = RAIZ / "public" / "dados"   # JSON servido ao painel
for p in (DADOS, ESTADO, PUBLICO, DADOS / "inpe", DADOS / "deter", DADOS / "areas"):
    p.mkdir(parents=True, exist_ok=True)

# Fontes públicas
INPE = "https://dataserver-coids.inpe.br/queimadas/queimadas/focos/csv"
TERRABRASILIS = "https://terrabrasilis.dpi.inpe.br/geoserver/ows"
DETER_WFS = "https://terrabrasilis.dpi.inpe.br/geoserver/deter-amz/ows"
STAC = "https://planetarycomputer.microsoft.com/api/stac/v1"
PC_DATA = "https://planetarycomputer.microsoft.com/api/data/v1"

ANO_INICIAL = 2020
UF = "AMAZONAS"
AM_BBOX = (-74.0, -10.0, -56.0, 2.5)        # lon_min, lat_min, lon_max, lat_max
MANAUS = (-3.119, -60.021)

# Satélite de referência do INPE (série comparável entre anos) e satélites de
# alta resolução usados no acompanhamento em tempo real.
SAT_REFERENCIA = "AQUA_M-T"
SAT_TEMPO_REAL = ("NPP-375", "NOAA-20", "NOAA-21", "NPP-375D")
DIAS_TEMPO_REAL = 7

# Intervalos do atualizador (segundos)
INTERVALO_10MIN = 600
INTERVALO_DIARIO = 3600
INTERVALO_DETER = 6 * 3600

# Agrupamento e pontuação
EPS_KM = 1.5
EPS_DIAS = 5
BUFFER_DESMAT_KM = 1.0
MESES_PROIBICAO = {7, 8, 9, 10, 11}   # ajustar ao decreto estadual vigente
PESOS = {
    "desmatamento_previo": 30,
    "area_protegida": 20,
    "uso_sustentavel": 10,
    "reincidencia": 15,
    "multiplos_focos_dia": 10,
    "periodo_proibitivo": 10,
    "cicatriz_deter": 15,
    "ignicao_desfavoravel": 10,
    "conversao_florestal": 15,
    "floresta_publica_nd": 15,
    "autuacao_fogo_previa": 10,
}
INDICADORES = list(PESOS)
DESCRICAO_INDICADORES = {
    "desmatamento_previo": ("Desmatamento DETER até 12 meses antes",
                            "polígono DESMATAMENTO_CR/VEG ou CS_* a até 1 km do evento, observado entre 365 dias antes e 5 dias depois do 1º foco"),
    "area_protegida": ("Terra indígena ou UC de proteção integral",
                       "centro do evento dentro de TI (FUNAI) ou UC do grupo PI"),
    "uso_sustentavel": ("UC de uso sustentável",
                        "RDS, RESEX, APA (grupo US): roça tradicional é permitida, peso reduzido; não soma com o anterior"),
    "reincidencia": ("Reincidência",
                     "fogo na mesma célula de ~1 km (0,01°) em 2 ou mais anos anteriores (satélite de referência do INPE), "
                     "ou, a até 500 m, ao menos 10% da área queimada em 3 ou mais anos desde 1985 (MapBiomas Fogo)"),
    "multiplos_focos_dia": ("3 ou mais focos no mesmo dia", "ignições simultâneas dentro do mesmo evento"),
    "periodo_proibitivo": ("Início em período proibitivo", "mês do 1º foco entre julho e novembro (parâmetro)"),
    "cicatriz_deter": ("Cicatriz de queimada no DETER",
                       "polígono CICATRIZ_DE_QUEIMADA a até 1 km, de 10 dias antes a 60 dias depois"),
    "ignicao_desfavoravel": ("Ignição em condição desfavorável ao fogo",
                             "no 1º foco: risco de fogo do INPE < 0,3, ou chuva ≥ 10 mm nas 72 h anteriores, ou umidade mínima das 24 h anteriores ≥ 80%: "
                             "o fogo dificilmente começaria ou se espalharia sozinho"),
    "conversao_florestal": ("Conversão recente de floresta (MapBiomas)",
                            "a até 500 m do evento, a floresta natural caiu ≥ 20 pontos percentuais nos 5 anos anteriores ao fogo "
                            "(partindo de ≥ 50%) e o uso antrópico chegou a ≥ 20% (pastagem, agricultura, mosaico, mineração ou área não vegetada)"),
    "floresta_publica_nd": ("Floresta pública não destinada",
                            "centro do evento em gleba pública sem destinação (Cadastro Nacional de Florestas Públicas 2025, tipo B): "
                            "desmatamento e fogo nessas áreas são associados à grilagem de terras públicas"),
    "autuacao_fogo_previa": ("Autuação anterior por uso de fogo",
                             "auto de infração do IBAMA por uso de fogo a até 3 km do evento, nos 10 anos anteriores (SISCOM, via INDE): "
                             "uso ilícito do fogo já constatado no local; não identifica o autor deste evento"),
}

CREDITO = "Desenvolvido pelo NIPED/PCAM"
