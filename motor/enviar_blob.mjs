// Envia public/dados ao Vercel Blob PRIVADO (prefixo painel/) com a biblioteca oficial (@vercel/blob).
// O site lê esses arquivos por /api/dados, que exige login aprovado.
// Requer BLOB_READ_WRITE_TOKEN. Dados do ciclo: cache de 60 s; análises novas ou
// refeitas desde o último envio: cache de 1 h. Sai com erro se algum envio falhar.
import { put } from "@vercel/blob";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dados = path.join(raiz, "public", "dados");
const manifesto = path.join(raiz, "motor", "dados", "estado", "blob_enviados.txt");
const token = process.env.BLOB_READ_WRITE_TOKEN;
if (!token) { console.error("defina BLOB_READ_WRITE_TOKEN"); process.exit(1); }

fs.mkdirSync(path.dirname(manifesto), { recursive: true });
const desde = fs.existsSync(manifesto) ? fs.statSync(manifesto).mtimeMs : 0;
const inicio = Date.now();
const tipos = { ".json": "application/json", ".png": "image/png" };

const lista = [];
for (const f of fs.readdirSync(dados)) if (f.endsWith(".json")) lista.push([f, 60]);
for (const f of fs.readdirSync(dados)) if (f.endsWith(".png")) lista.push([f, 600]);   // risco previsto (INPE)
const dirA = path.join(dados, "analises");
if (fs.existsSync(path.join(dirA, "indice.json"))) lista.push(["analises/indice.json", 60]);
(function varre(dir) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) varre(p);
    else if (/\.(png|json)$/.test(e.name) && e.name !== "indice.json" && fs.statSync(p).mtimeMs > desde)
      lista.push([path.relative(dados, p).split(path.sep).join("/"), 3600]);
  }
})(dirA);

let falhas = 0, ok = 0, i = 0;
async function trabalhador() {
  while (i < lista.length) {
    const [rel, idade] = lista[i++];
    try {
      await put("painel/" + rel, fs.readFileSync(path.join(dados, rel)), {
        access: "private", token, addRandomSuffix: false, allowOverwrite: true,
        cacheControlMaxAge: idade, contentType: tipos[path.extname(rel)] || "application/octet-stream",
      });
      ok++;
    } catch (e) { falhas++; console.error(`FALHA ${rel}: ${e.message}`); }
  }
}
await Promise.all(Array.from({ length: 6 }, trabalhador));
console.log(`enviados ${ok} de ${lista.length} arquivos ao Blob`);
if (falhas) process.exit(1);
fs.closeSync(fs.openSync(manifesto, "a"));
fs.utimesSync(manifesto, new Date(inicio), new Date(inicio));
