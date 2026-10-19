// Fogo Forense — entrega dados restritos só para usuários aprovados e logados.
//   GET /api/restrito?dados=brmais_indice | brmais_2026 ...  → alertas Brasil MAIS (convênio; acesso restrito)
import { lerJSON, usuarioAtual, json } from "./_conta.js";

const PERMITIDO = /^brmais_(indice|20\d\d)$/;

export default async function handler(req, res) {
  try {
    const u = await usuarioAtual(req);
    if (!u) return json(res, 401, { erro: "Faça login com um cadastro aprovado." });
    const qual = new URL(req.url, "http://x").searchParams.get("dados");
    if (!PERMITIDO.test(qual || "")) return json(res, 400, { erro: "Conjunto de dados inválido." });
    const { dados } = await lerJSON(`restrito/${qual}.json`, null);
    if (!dados) return json(res, 404, { erro: "Dados ainda não carregados." });
    return json(res, 200, dados, { "Cache-Control": "private, no-store" });
  } catch (e) {
    console.error(e);
    return json(res, 500, { erro: "Erro no servidor." });
  }
}
