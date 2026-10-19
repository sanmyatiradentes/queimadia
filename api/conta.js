// Fogo Forense — API de contas: cadastro, login, logout, sessão atual e administração.
//   POST /api/conta?acao=cadastrar  {nome, email, orgao, cargo, matricula, senha}
//   POST /api/conta?acao=entrar     {email, senha}
//   POST /api/conta?acao=sair
//   GET  /api/conta?acao=eu
//   GET  /api/conta?acao=lista                         (admin)
//   POST /api/conta?acao=decidir  {email, status}      (admin: aprovado | recusado | desativado | pendente)
import {
  usuarios, salvarUsuarios, hashSenha, conferirSenha, criarSessao, cookieSessao, cookieSair,
  lerSessao, publico, json, corpoJSON, ehAdminEmail,
} from "./_conta.js";

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,}$/i;
const tentativas = new Map();   // limita tentativas de login por e-mail (por instância)

const limpar = (v, n = 120) => String(v ?? "").replace(/[<>]/g, "").trim().slice(0, n);

export default async function handler(req, res) {
  const acao = new URL(req.url, "http://x").searchParams.get("acao");
  try {
    if (acao === "cadastrar" && req.method === "POST") {
      const b = await corpoJSON(req);
      const email = limpar(b.email, 190).toLowerCase();
      const nome = limpar(b.nome), orgao = limpar(b.orgao), cargo = limpar(b.cargo), matricula = limpar(b.matricula, 40);
      const senha = String(b.senha || "");
      if (!nome || !orgao || !cargo || !EMAIL_RE.test(email)) return json(res, 400, { erro: "Preencha nome, e-mail válido, órgão e cargo." });
      if (senha.length < 10) return json(res, 400, { erro: "A senha precisa ter pelo menos 10 caracteres." });
      const d = await usuarios();
      if (d.usuarios.some(u => u.email === email)) return json(res, 409, { erro: "Já existe um cadastro com este e-mail." });
      const admin = ehAdminEmail(email);
      d.usuarios.push({ nome, email, orgao, cargo, matricula, senha: hashSenha(senha),
        papel: admin ? "admin" : "usuario", status: admin ? "aprovado" : "pendente",
        criado_em: new Date().toISOString(), decidido_em: admin ? new Date().toISOString() : null, decidido_por: admin ? "configuração" : null });
      await salvarUsuarios(d);
      return json(res, 201, { ok: true, status: admin ? "aprovado" : "pendente" });
    }

    if (acao === "entrar" && req.method === "POST") {
      const b = await corpoJSON(req);
      const email = limpar(b.email, 190).toLowerCase();
      const t = tentativas.get(email) || { n: 0, ate: 0 };
      if (t.ate > Date.now()) return json(res, 429, { erro: "Muitas tentativas. Aguarde alguns minutos." });
      const d = await usuarios();
      const u = d.usuarios.find(x => x.email === email);
      if (!u || !conferirSenha(String(b.senha || ""), u.senha)) {
        t.n += 1; if (t.n >= 5) { t.ate = Date.now() + 10 * 60e3; t.n = 0; } tentativas.set(email, t);
        await new Promise(r => setTimeout(r, 600));
        return json(res, 401, { erro: "E-mail ou senha incorretos." });
      }
      tentativas.delete(email);
      if (u.status !== "aprovado") {
        const msg = { pendente: "Seu cadastro aguarda aprovação da administração.", recusado: "Seu cadastro não foi aprovado.",
          desativado: "Seu acesso está desativado." }[u.status] || "Acesso indisponível.";
        return json(res, 403, { erro: msg, status: u.status });
      }
      u.ultimo_acesso = new Date().toISOString();
      await salvarUsuarios(d);
      return json(res, 200, { ok: true, usuario: publico(u) }, { "Set-Cookie": cookieSessao(criarSessao(u.email)) });
    }

    if (acao === "sair") return json(res, 200, { ok: true }, { "Set-Cookie": cookieSair });

    if (acao === "eu") {
      const s = lerSessao(req);
      if (!s) return json(res, 200, { usuario: null });
      const d = await usuarios();
      const u = d.usuarios.find(x => x.email === s.e && x.status === "aprovado");
      return json(res, 200, { usuario: publico(u) || null }, u ? {} : { "Set-Cookie": cookieSair });
    }

    // ---------------- administração
    const s = lerSessao(req);
    const d = await usuarios();
    const eu = s && d.usuarios.find(x => x.email === s.e && x.status === "aprovado");
    if (!eu || eu.papel !== "admin") return json(res, 403, { erro: "Acesso restrito à administração." });

    if (acao === "lista") {
      return json(res, 200, { usuarios: d.usuarios.map(u => ({ ...publico(u), matricula: u.matricula, criado_em: u.criado_em,
        decidido_em: u.decidido_em, decidido_por: u.decidido_por, ultimo_acesso: u.ultimo_acesso })) });
    }
    if (acao === "decidir" && req.method === "POST") {
      const b = await corpoJSON(req);
      const alvo = d.usuarios.find(x => x.email === String(b.email || "").toLowerCase());
      if (!alvo) return json(res, 404, { erro: "Usuário não encontrado." });
      if (!["aprovado", "recusado", "desativado", "pendente"].includes(b.status)) return json(res, 400, { erro: "Situação inválida." });
      if (alvo.email === eu.email) return json(res, 400, { erro: "Você não pode alterar o próprio acesso." });
      alvo.status = b.status; alvo.decidido_em = new Date().toISOString(); alvo.decidido_por = eu.email;
      if (b.papel === "admin" || b.papel === "usuario") alvo.papel = b.papel;
      await salvarUsuarios(d);
      return json(res, 200, { ok: true });
    }
    return json(res, 400, { erro: "Ação inválida." });
  } catch (e) {
    console.error(e);
    return json(res, 500, { erro: "Erro no servidor. Tente novamente." });
  }
}
