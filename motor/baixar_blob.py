"""Recupera do Vercel Blob as análises já publicadas (quando o GitHub Actions
começa sem o estado em cache), para não apagá-las do site.

    python -m motor.baixar_blob
"""
import json
import os

import requests

from . import config

BASE = os.environ.get("QUEIMADIA_BLOB_URL", "https://yrxowscwviax57we.public.blob.vercel-storage.com/")
DIR = config.PUBLICO / "analises"


def main():
    DIR.mkdir(parents=True, exist_ok=True)
    if (DIR / "indice.json").exists():
        return print("análises já presentes; nada a baixar")
    r = requests.get(BASE + "analises/indice.json", timeout=60)
    if not r.ok:
        return print("nenhum índice publicado ainda")
    idx = r.json()
    for id_ in idx:
        a = requests.get(f"{BASE}analises/{id_}.json", timeout=60)
        if not a.ok:
            continue
        (DIR / f"{id_}.json").write_bytes(a.content)
        d = a.json()
        arquivos = [i["arquivo"] for i in d.get("imagens", [])] + ([d["dnbr"]["arquivo"]] if d.get("dnbr") else [])
        for arq in arquivos:
            destino = DIR / arq
            destino.parent.mkdir(parents=True, exist_ok=True)
            img = requests.get(BASE + "analises/" + arq, timeout=60)
            if img.ok:
                destino.write_bytes(img.content)
    (DIR / "indice.json").write_text(json.dumps(idx, ensure_ascii=False))
    print(f"{len(idx)} análises recuperadas do Blob")


if __name__ == "__main__":
    main()
