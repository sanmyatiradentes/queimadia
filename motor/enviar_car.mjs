// Envia as quadrículas do CAR (car_sicar.py) ao Vercel Blob PRIVADO, em restrito/car/.
// Uso: node motor/enviar_car.mjs <pasta processada> [subpasta]  (subpasta: envia só aquela camada)   (BLOB_READ_WRITE_TOKEN no ambiente, ex.: .env.local)
import { put } from "@vercel/blob";
import fs from "node:fs";
import path from "node:path";

const dir = process.argv[2];
if (!dir || !process.env.BLOB_READ_WRITE_TOKEN) { console.error("uso: node motor/enviar_car.mjs <pasta> (com BLOB_READ_WRITE_TOKEN)"); process.exit(1); }
const arqs = [];
const raiz = process.argv[3] ? path.join(dir, process.argv[3]) : dir;
(function varre(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) varre(p); else if (/\.json(\.gz)?$/.test(e.name)) arqs.push(p);
  }
})(raiz);
let i = 0, ok = 0;
async function trab() {
  while (i < arqs.length) {
    const p = arqs[i++];
    const destino = "restrito/car/" + path.relative(dir, p).split(path.sep).join("/");
    for (let t = 0; t < 4; t++) try {
      await put(destino, fs.readFileSync(p), { access: "private", addRandomSuffix: false, allowOverwrite: true, contentType: p.endsWith(".gz") ? "application/gzip" : "application/json" });
      ok++; break;
    } catch (e) { if (t === 3) console.error("falha", destino, e.message); await new Promise(r => setTimeout(r, 2000)); }
  }
}
await Promise.all(Array.from({ length: 8 }, trab));
console.log(`enviados ${ok} de ${arqs.length} arquivos para restrito/car/`);
process.exit(0);
