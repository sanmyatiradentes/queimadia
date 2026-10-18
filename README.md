# QueimadIA — Radar de Queimadas Suspeitas

Sistema do **NIPED/PCAM** com o **DPTC-AM** para identificar possíveis queimadas criminosas no Amazonas com dados públicos de satélite e inteligência artificial.

Desenvolvido pelo **NIPED/PCAM**, Núcleo de Inovação, Pesquisa e Desenvolvimento da Polícia Civil do Amazonas.

## O que ele faz

- **Atualização contínua:** focos do INPE a cada 10 minutos (todos os satélites), arquivo diário a cada hora e alertas DETER.
- **Eventos e pontuação:** agrupa focos em eventos (DBSCAN espaço-temporal) e pontua de 0 a 100 por indicadores objetivos: desmatamento prévio no DETER, TI/UC, reincidência, ignições simultâneas, período proibitivo e cicatriz DETER.
- **IA:**
  - Isolation Forest dá uma nota de atipicidade a cada evento.
  - Claude redige um parecer técnico preliminar a partir dos números.
- **Análise de NDVI sob demanda:** para qualquer ponto e período, usa Sentinel-2 e Landsat 8/9 pelo mesmo método do serviço ambiental do PolicIA.
  - Série temporal.
  - Detecção de quebra, mostrada passo a passo.
  - Imagens por período (cor real, falsa-cor, NDVI, NBR, NDMI).
  - dNBR com área queimada por classe.
  - Exportação em CSV/JSON com proveniência.
- **Mapas:**
  - Fundos: OpenStreetMap, satélite Esri, topográfico, claro, escuro, e Sentinel-2 dos últimos 45 dias (cor real, NDVI e falsa-cor) gerado na hora.
  - Camadas: eventos, alertas VIIRS, focos, mapa de calor, DETER, TIs, UCs e municípios.
- **Filtros** por período, pontuação, município, distância de Manaus, tipo de área, indicadores e busca. Valem para mapa, tabela, estatísticas e exportações.
- **Acesso aberto**, com o layout do Integra DPTC.

## Estrutura

```
motor/            coleta, pontuação, IA, NDVI e servidor (Python)
  atualizar.py    ciclo: coleta → eventos → publicação
  ingest.py       INPE (10 min, diário, anual), DETER, áreas
  eventos.py      DBSCAN, pontuação e Isolation Forest
  ndvi.py         índices espectrais, quebra (método PolicIA), imagens, dNBR, mosaicos
  parecer.py      parecer por IA (Claude)
  api_analise.py  rotas da API de análise (servidor e Vercel)
  servidor.py     servidor próprio com atualizador em segundo plano
public/           painel (HTML/CSS/JS) e public/dados/*.json gerados
api/index.py      função da Vercel (API de análise)
deploy/integra/   instalação no servidor do Integra (systemd + nginx)
.github/workflows atualizador a cada 10 min para a hospedagem na Vercel
```

## Como funciona a publicação (arquitetura adotada)

O processamento (coleta, pontuação, IA, NDVI, parecer) roda **no Mac do NIPED**. O servidor do Integra só recebe e serve arquivos estáticos (HTML, JS, JSON e PNG): **nenhum programa nem IA roda no servidor da PCAM**.

```
Mac do NIPED (a cada 10 min)                         Servidor do Integra (nginx)
  coleta INPE/DETER → eventos → IA → NDVI  ── rsync/SSH ──▶  /var/www/queimadia/
  public/  (painel + dados + análises)                        https://integra.dptc.am.gov.br/queimadia/
```

No site publicado, a análise de NDVI aparece **pronta** para os eventos com pontuação ≥ 70. São até 3 novas por ciclo, primeiro as da temporada atual e as mais perto de Manaus. A análise livre de qualquer ponto do mapa funciona na versão local, no Mac.

### 1. No servidor do Integra (uma vez)

1. Como root: `bash deploy/integra/preparar-servidor.sh`. Cria `/var/www/queimadia` e o usuário `queimadia` para receber os arquivos.
2. Inclua `deploy/integra/nginx-queimadia.conf` dentro do `server { }` do Integra, antes do `location /`.
3. Rode `nginx -t && systemctl reload nginx`.

### 2. No Mac (uma vez)

```bash
cd ~/Documents/Radar-Queimadas-NIPED
bash motor/instalar_mac.sh queimadia@integra.dptc.am.gov.br:/var/www/queimadia/
```

O script:
- cria o ambiente Python;
- gera a chave SSH (`motor/chave_ssh.pub`), que deve ser colada em `~queimadia/.ssh/authorized_keys` no servidor;
- agenda o ciclo a cada 10 minutos com o launchd.

O Mac precisa ficar **ligado, acordado e com internet**. Log em `motor/dados/estado/ciclos.log`.

Opcional (parecer por IA): crie `motor/.env` com `ANTHROPIC_API_KEY=...`. O arquivo fica fora do git.

### Versão local completa (com análise livre)

```bash
.venv/bin/python -m motor.servidor     # http://127.0.0.1:8090
```

Um endereço próprio, como `queimadia.dptc.am.gov.br`, depende de um registro de DNS feito pela PRODAM, que gerencia o domínio dptc.am.gov.br. Sem ele, o caminho `/queimadia/` do Integra funciona.

Alternativas mantidas no projeto: `deploy/servidor-python/`, para um servidor que aceite rodar o motor, e a Vercel (abaixo).

## Publicar na Vercel (alternativa)

A Vercel serve o painel e a API de análise. Os dados são atualizados pelo GitHub Actions a cada 10 minutos e publicados no ramo `dados` do repositório.

1. Crie um repositório público no GitHub (ex.: `queimadia`) e envie esta pasta.
2. Em **Settings → Actions → General**, dê permissão de escrita ao workflow. Depois rode **Atualizar dados** manualmente uma vez.
3. Em `public/config.js`, aponte para os dados: `window.QUEIMADIA_DADOS = "https://raw.githubusercontent.com/USUARIO/queimadia/dados/";`
4. Na Vercel, importe o repositório com o nome do projeto `queimadia` (endereço queimadia.vercel.app). Opcional: variável de ambiente `ANTHROPIC_API_KEY`.

No plano gratuito a função de análise tem limite de 60 s por chamada. O painel faz uma chamada por cena, em paralelo, então cabe nesse limite.

## Método (resumo)

| Etapa | Cálculo |
|---|---|
| Evento | DBSCAN em (x, y, t), com 1,5 km ≈ 5 dias |
| Pontuação | soma dos pesos dos indicadores presentes (máx. 100) |
| NDVI | (NIR − Red)/(NIR + Red), mediana dos pixels válidos no núcleo |
| Quebra | limiar = base − max(3σ; 0,15); 2 observações seguidas abaixo; data como intervalo |
| dNBR | NBR antes − NBR depois; classes USGS |
| Atipicidade (IA) | Isolation Forest, em percentil de 0 a 100 |

**Diferenças deliberadas em relação ao `ndvi.py` do PolicIA:**
- O offset do Sentinel-2 é aplicado pela versão de processamento da cena (`s2:processing_baseline` ≥ 04.00), não pela data. Há cenas de 2019 e 2021 reprocessadas com offset.
- O Landsat entra só como Tier 1.
- A máscara QA_PIXEL também exclui cirro e neve, porque em cenas Tier 2 havia nuvem classificada como neve.

## Limitações

O satélite detecta calor e mudança de vegetação, não autoria. A pontuação é **indício para orientar diligência**, nunca prova. Em TIs e reservas de uso sustentável há uso tradicional do fogo, que é legal. CAR e SIGEF ainda não estão integrados.

## Fontes

INPE (Programa Queimadas, DETER/TerraBrasilis) · FUNAI · ICMBio/MMA · IBGE · ESA Copernicus Sentinel-2 · NASA/USGS Landsat · Microsoft Planetary Computer.
