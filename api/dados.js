// Fogo Forense — entrega os dados do painel (gerados pelo motor a cada 10 min) só a usuários aprovados.
//   GET /api/dados?arq=eventos.json | analises/R2026...json | analises/R2026.../dnbr.png
// Os arquivos ficam no Vercel Blob PRIVADO, prefixo painel/. JSON grandes saem comprimidos (gzip).
import { get } from "@vercel/blob";
import zlib from "node:zlib";
import { usuarioAtual, json } from "./_conta.js";

const NOME = /^(analises\/)?[\w-]+(\/[\w.-]+)?\.(json|png)$/;
const TIPO = { json: "application/json; charset=utf-8", png: "image/png" };

export default async function handler(req, res) {
  try {
    if (!(await usuarioAtual(req))) return json(res, 401, { erro: "Faça login com um cadastro aprovado." });
    const arq = new URL(req.url, "http://x").searchParams.get("arq") || "";
    if (!NOME.test(arq) || arq.includes("..")) return json(res, 400, { erro: "Arquivo inválido." });
    const ext = arq.split(".").pop();
    const r = await get("painel/" + arq, { access: "private", useCache: ext !== "json" });
    if (!r) return json(res, 404, { erro: "Arquivo não encontrado." });
    let corpo = Buffer.from(await new Response(r.stream).arrayBuffer());
    res.statusCode = 200;
    res.setHeader("Content-Type", TIPO[ext]);
    res.setHeader("Cache-Control", ext === "png" ? "private, max-age=3600" : "private, max-age=30");
    if (ext === "json" && corpo.length > 20000 && /gzip/.test(req.headers["accept-encoding"] || "")) {
      corpo = zlib.gzipSync(corpo, { level: 6 });
      res.setHeader("Content-Encoding", "gzip");
      res.setHeader("Vary", "Accept-Encoding");
    }
    res.end(corpo);
  } catch (e) {
    console.error(e);
    return json(res, 500, { erro: "Erro no servidor." });
  }
}
