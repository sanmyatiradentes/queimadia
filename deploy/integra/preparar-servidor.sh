#!/usr/bin/env bash
# Rodar UMA vez no servidor do Integra (como root). Cria a pasta e o usuário que
# recebe os arquivos do Mac por SSH. Não instala Python nem nenhum programa.
set -euo pipefail
id queimadia >/dev/null 2>&1 || useradd --create-home --shell /bin/bash queimadia
mkdir -p /var/www/queimadia && chown queimadia:www-data /var/www/queimadia && chmod 755 /var/www/queimadia
mkdir -p ~queimadia/.ssh && chmod 700 ~queimadia/.ssh && touch ~queimadia/.ssh/authorized_keys
chmod 600 ~queimadia/.ssh/authorized_keys && chown -R queimadia:queimadia ~queimadia/.ssh
echo "Cole a chave pública do Mac (motor/chave_ssh.pub) em ~queimadia/.ssh/authorized_keys."
echo "Depois inclua deploy/integra/nginx-queimadia.conf no server{} do Integra: nginx -t && systemctl reload nginx"
