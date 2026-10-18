#!/usr/bin/env bash
# Instala o QueimadIA neste Mac: ambiente Python, chave SSH e agendamento a cada 10 min.
#   bash motor/instalar_mac.sh usuario@integra.dptc.am.gov.br:/var/www/queimadia/
set -euo pipefail
RAIZ="$(cd "$(dirname "$0")/.." && pwd)"
cd "$RAIZ"
[ -x .venv/bin/python ] || python3 -m venv .venv
.venv/bin/pip install -q --upgrade pip
.venv/bin/pip install -q -r motor/requirements.txt
if [ -n "${1:-}" ]; then
  echo "DESTINO=\"$1\"" > motor/destino.conf
  [ -f motor/chave_ssh ] || ssh-keygen -t ed25519 -N "" -C "queimadia-mac" -f motor/chave_ssh >/dev/null
  echo "Chave pública para o servidor (colar em ~queimadia/.ssh/authorized_keys):"; cat motor/chave_ssh.pub
fi
PLIST="$HOME/Library/LaunchAgents/br.gov.am.dptc.queimadia.plist"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>br.gov.am.dptc.queimadia</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$RAIZ/motor/rodar.sh</string></array>
  <key>StartInterval</key><integer>600</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$RAIZ/motor/dados/estado/launchd.log</string>
  <key>StandardErrorPath</key><string>$RAIZ/motor/dados/estado/launchd.log</string>
</dict></plist>
PL
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo "Agendado: o QueimadIA roda a cada 10 minutos enquanto este Mac estiver ligado e acordado."
echo "Log: motor/dados/estado/ciclos.log  ·  Parar: launchctl unload $PLIST"
