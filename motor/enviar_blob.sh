#!/usr/bin/env bash
# Envia public/dados para o Vercel Blob (de onde o site publicado lê os dados).
# Requer BLOB_READ_WRITE_TOKEN no ambiente (GitHub Actions: secret; Mac: .env.local).
set -euo pipefail
RAIZ="$(cd "$(dirname "$0")/.." && pwd)"
cd "$RAIZ/public/dados"
: "${BLOB_READ_WRITE_TOKEN:?defina BLOB_READ_WRITE_TOKEN}"
unset VERCEL_OIDC_TOKEN BLOB_STORE_ID   # usa só a chave de gravação do Blob
MANIFESTO="$RAIZ/motor/dados/estado/blob_enviados.txt"
mkdir -p "$(dirname "$MANIFESTO")"
[ -f "$MANIFESTO" ] || touch -t 200001010000 "$MANIFESTO"   # primeira vez: envia tudo
INICIO=$(mktemp); trap 'rm -f "$INICIO"' EXIT
VERCEL="${VERCEL_BIN:-vercel}"
put() {  # arquivo idade-do-cache
  $VERCEL blob put "$1" --pathname "$1" --access public --allow-overwrite \
    --cache-control-max-age "$2" --non-interactive >/dev/null 2>&1 \
    && echo "$1" || echo "FALHA $1" >&2
}
export -f put; export VERCEL
# dados que mudam a cada ciclo: cache de 60 s
ls *.json analises/indice.json 2>/dev/null | xargs -P 6 -I{} bash -c 'put "$@" 60' _ {}
# análises novas ou refeitas: só o que mudou desde o último envio
find analises -type f \( -name '*.png' -o -name '*.json' \) ! -name indice.json -newer "$MANIFESTO" 2>/dev/null \
  | xargs -P 6 -I{} bash -c 'put "$@" 3600' _ {} | wc -l | xargs echo "arquivos de análise enviados:"
touch -r "$INICIO" "$MANIFESTO"   # marca o início deste envio
