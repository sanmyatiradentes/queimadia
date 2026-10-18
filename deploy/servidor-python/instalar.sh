#!/usr/bin/env bash
# Instala o QueimadIA no servidor do Integra (Ubuntu/Debian), em /opt/queimadia.
# Uso (como root, na pasta do projeto copiada para o servidor):  bash deploy/integra/instalar.sh
set -euo pipefail
DEST=/opt/queimadia
id queimadia >/dev/null 2>&1 || useradd --system --home "$DEST" --shell /usr/sbin/nologin queimadia
mkdir -p "$DEST"
rsync -a --delete --exclude .venv --exclude motor/cache --exclude 'motor/dados/estado' ./ "$DEST"/
apt-get install -y python3-venv rsync >/dev/null
python3 -m venv "$DEST/.venv"
"$DEST/.venv/bin/pip" install -q --upgrade pip
"$DEST/.venv/bin/pip" install -q -r "$DEST/motor/requirements.txt"
[ -f "$DEST/.env" ] || printf '# ANTHROPIC_API_KEY=coloque-a-chave-aqui (opcional, para o parecer por IA)\n' > "$DEST/.env"
chmod 600 "$DEST/.env"
chown -R queimadia:queimadia "$DEST"
cp "$DEST/deploy/integra/queimadia.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now queimadia
echo "Serviço iniciado. Primeiro ciclo completo leva alguns minutos."
echo "Agora inclua deploy/integra/nginx-queimadia.conf no server{} do Integra e rode: nginx -t && systemctl reload nginx"
echo "Endereço: https://integra.dptc.am.gov.br/queimadia/"
