#!/usr/bin/env bash
# Um ciclo do QueimadIA no Mac: atualiza, calcula e envia ao servidor.
# Chamado a cada 10 min pelo launchd (motor/instalar_mac.sh).
set -uo pipefail
RAIZ="$(cd "$(dirname "$0")/.." && pwd)"
cd "$RAIZ"
TRAVA=motor/dados/estado/.trava
LOG=motor/dados/estado/ciclos.log
mkdir -p motor/dados/estado
if ! mkdir "$TRAVA" 2>/dev/null; then
  # outro ciclo em andamento (ou trava velha de mais de 1 h)
  if [ -n "$(find "$TRAVA" -maxdepth 0 -mmin +60 2>/dev/null)" ]; then rmdir "$TRAVA"; mkdir "$TRAVA"; else exit 0; fi
fi
trap 'rmdir "$TRAVA"' EXIT
[ -f motor/.env ] && { set -a; . motor/.env; set +a; }   # ex.: ANTHROPIC_API_KEY=... (parecer por IA)
{
  echo "=== $(date '+%Y-%m-%d %H:%M:%S')"
  ULT=motor/dados/estado/.ultimo_completo
  if [ ! -f "$ULT" ] || [ -n "$(find "$ULT" -mmin +55)" ]; then
    .venv/bin/python -m motor.atualizar && touch "$ULT"
  else
    .venv/bin/python -m motor.atualizar --rapido
  fi
  if [ -f motor/destino.conf ]; then
    . motor/destino.conf     # define DESTINO=usuario@servidor:/var/www/queimadia/
    rsync -az --delete --exclude 'dados/*.tmp' -e "ssh -i motor/chave_ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new" \
      public/ "$DESTINO" && echo "enviado para $DESTINO"
  fi
} >> "$LOG" 2>&1
tail -n 4000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
