// Fogo Forense — cadeia de custódia: registro e verificação do hash SHA-256 de relatórios (PDF) e pacotes de dados.
//   POST /api/custodia?acao=registrar {tipo: "pdf"|"conteudo", sha256, relatorio_id, sha256_conteudo, nome_arquivo, tamanho}
//   GET  /api/custodia?acao=verificar&sha256=...
// O registro é imutável: o primeiro registro de um hash não é sobrescrito (vale a data e o autor originais).
import { put } from "@vercel/blob";
import { lerJSON, usuarioAtual, json, corpoJSON } from "./_conta.js";

const HEX = /^[0-9a-f]{64}$/;
const txt = (v, n = 200) => String(v ?? "").slice(0, n);

export default async function handler(req, res) {
  try {
    const u = await usuarioAtual(req);
    if (!u) return json(res, 401, { erro: "Faça login com um cadastro aprovado." });
    const q = new URL(req.url, "http://x").searchParams;
    const acao = q.get("acao");

    if (acao === "verificar") {
      const sha = String(q.get("sha256") || "").toLowerCase();
      if (!HEX.test(sha)) return json(res, 400, { erro: "Hash SHA-256 inválido." });
      const { dados } = await lerJSON(`restrito/custodia/${sha}.json`, null);
      return dados ? json(res, 200, { registrado: true, registro: dados }) : json(res, 200, { registrado: false });
    }

    if (acao === "registrar" && req.method === "POST") {
      const b = await corpoJSON(req);
      const sha = String(b.sha256 || "").toLowerCase(), shaC = String(b.sha256_conteudo || "").toLowerCase();
      if (!HEX.test(sha) || (shaC && !HEX.test(shaC))) return json(res, 400, { erro: "Hash SHA-256 inválido." });
      if (!["pdf", "conteudo"].includes(b.tipo)) return json(res, 400, { erro: "Tipo inválido." });
      const caminho = `restrito/custodia/${sha}.json`;
      const { dados: existente } = await lerJSON(caminho, null);
      if (existente) return json(res, 200, { novo: false, registro: existente });
      const registro = {
        sha256: sha, tipo: b.tipo, relatorio_id: txt(b.relatorio_id), sha256_conteudo: shaC || null,
        nome_arquivo: txt(b.nome_arquivo), tamanho_bytes: Number.isFinite(+b.tamanho) ? +b.tamanho : null,
        registrado_em_utc: new Date().toISOString(),
        registrado_por: { nome: u.nome, email: u.email, orgao: u.orgao, cargo: u.cargo },
      };
      try {
        await put(caminho, JSON.stringify(registro), { access: "private", addRandomSuffix: false, allowOverwrite: false, contentType: "application/json" });
      } catch (e) {  // registrado ao mesmo tempo por outra pessoa: vale o primeiro
        const { dados } = await lerJSON(caminho, null);
        if (dados) return json(res, 200, { novo: false, registro: dados });
        throw e;
      }
      return json(res, 200, { novo: true, registro });
    }
    return json(res, 400, { erro: "Ação inválida." });
  } catch (e) {
    console.error(e);
    return json(res, 500, { erro: "Erro no servidor." });
  }
}
