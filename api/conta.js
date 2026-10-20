// Fogo Forense — API de contas: cadastro, login, logout, sessão atual e administração.
//   POST /api/conta?acao=cadastrar  {nome, email, orgao, cargo, matricula, senha}
//   POST /api/conta?acao=entrar     {email, senha}
//   POST /api/conta?acao=sair
//   GET  /api/conta?acao=eu
//   GET  /api/conta?acao=lista                         (admin)
//   POST /api/conta?acao=decidir  {email, status}      (admin: aprovado | recusado | desativado | pendente)
//   POST /api/conta?acao=redefinir {email}            (admin: gera senha temporária; a pessoa troca no próximo acesso)
//   POST /api/conta?acao=trocar   {email, senha, nova}  (troca de senha; obrigatória depois de uma redefinição)
import crypto from "node:crypto";
import {
  usuarios, salvarUsuarios, hashSenha, conferirSenha, criarSessao, cookieSessao, cookieSair,
  lerSessao, publico, json, corpoJSON, ehAdminEmail,
} from "./_conta.js";

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,}$/i;
const tentativas = new Map();   // limita tentativas de login por e-mail (por instância)

// senha temporária legível (sem 0/O, 1/l/I), 12 caracteres em 3 blocos
function senhaTemporaria() {
  const A = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789", b = crypto.randomBytes(12);
  const t = [...b].map(x => A[x % A.length]).join("");
  return `${t.slice(0, 4)}-${t.slice(4, 8)}-${t.slice(8, 12)}`;
}
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
        console.warn("entrar recusado:", !u ? "e-mail não cadastrado" : "senha não confere");
        t.n += 1; if (t.n >= 5) { t.ate = Date.now() + 10 * 60e3; t.n = 0; } tentativas.set(email, t);
        await new Promise(r => setTimeout(r, 600));
        return json(res, 401, { erro: "E-mail ou senha incorretos." });
      }
      tentativas.delete(email);
      if (u.trocar_senha && u.status === "aprovado") {
        // senha temporária conferida: a nova, se veio junto, é gravada nesta mesma chamada
        const nova = String(b.nova || "");
        if (!nova) return json(res, 403, { erro: "Crie uma senha nova para continuar.", trocar_senha: true });
        if (nova.length < 10) return json(res, 400, { erro: "A senha nova precisa ter pelo menos 10 caracteres.", trocar_senha: true });
        if (nova === String(b.senha || "")) return json(res, 400, { erro: "A senha nova precisa ser diferente da temporária.", trocar_senha: true });
        u.senha = hashSenha(nova); delete u.trocar_senha;
        u.senha_trocada_em = u.ultimo_acesso = new Date().toISOString();
        await salvarUsuarios(d);
        console.log("senha trocada após redefinição");
        return json(res, 200, { ok: true, usuario: publico(u) }, { "Set-Cookie": cookieSessao(criarSessao(u.email)) });
      }
      if (u.status !== "aprovado") {
        const msg = { pendente: "Seu cadastro aguarda aprovação da administração.", recusado: "Seu cadastro não foi aprovado.",
          desativado: "Seu acesso está desativado." }[u.status] || "Acesso indisponível.";
        return json(res, 403, { erro: msg, status: u.status });
      }
      u.ultimo_acesso = new Date().toISOString();
      await salvarUsuarios(d);
      return json(res, 200, { ok: true, usuario: publico(u) }, { "Set-Cookie": cookieSessao(criarSessao(u.email)) });
    }

    if (acao === "trocar" && req.method === "POST") {
      const b = await corpoJSON(req);
      const email = limpar(b.email, 190).toLowerCase(), nova = String(b.nova || "");
      const t = tentativas.get(email) || { n: 0, ate: 0 };
      if (t.ate > Date.now()) return json(res, 429, { erro: "Muitas tentativas. Aguarde alguns minutos." });
      if (nova.length < 10) return json(res, 400, { erro: "A senha nova precisa ter pelo menos 10 caracteres." });
      if (nova === String(b.senha || "")) return json(res, 400, { erro: "A senha nova precisa ser diferente da atual." });
      const d = await usuarios();
      const u = d.usuarios.find(x => x.email === email);
      if (!u || !conferirSenha(String(b.senha || ""), u.senha)) {
        console.warn("trocar recusado:", !u ? "e-mail não cadastrado" : "senha atual não confere");
        t.n += 1; if (t.n >= 5) { t.ate = Date.now() + 10 * 60e3; t.n = 0; } tentativas.set(email, t);
        await new Promise(r => setTimeout(r, 600));
        return json(res, 401, { erro: "Senha atual (ou temporária) incorreta." });
      }
      tentativas.delete(email);
      u.senha = hashSenha(nova); delete u.trocar_senha; u.senha_trocada_em = new Date().toISOString();
      if (u.status !== "aprovado") { await salvarUsuarios(d); return json(res, 200, { ok: true, status: u.status }); }
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
        decidido_em: u.decidido_em, decidido_por: u.decidido_por, ultimo_acesso: u.ultimo_acesso,
        trocar_senha: !!u.trocar_senha, senha_redefinida_em: u.senha_redefinida_em })) });
    }
    if (acao === "redefinir" && req.method === "POST") {
      const b = await corpoJSON(req);
      const alvo = d.usuarios.find(x => x.email === String(b.email || "").toLowerCase());
      if (!alvo) return json(res, 404, { erro: "Usuário não encontrado." });
      if (alvo.email === eu.email) return json(res, 400, { erro: "Você não pode redefinir a própria senha por aqui." });
      const temp = senhaTemporaria();
      alvo.senha = hashSenha(temp); alvo.trocar_senha = true;
      alvo.senha_redefinida_em = new Date().toISOString(); alvo.senha_redefinida_por = eu.email;
      tentativas.delete(alvo.email);
      await salvarUsuarios(d);
      return json(res, 200, { ok: true, temporaria: temp });
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
