#!/usr/bin/env bash
# Envia public/dados para o Vercel Blob (de onde o site publicado lê os dados).
# Requer BLOB_READ_WRITE_TOKEN no ambiente (GitHub Actions: secret; Mac: .env.local).
set -euo pipefail
RAIZ="$(cd "$(dirname "$0")/.." && pwd)"
[ -d "$RAIZ/motor/node_modules/@vercel/blob" ] || npm install --silent --no-save --prefix "$RAIZ/motor" @vercel/blob@2.8.0
node "$RAIZ/motor/enviar_blob.mjs"
