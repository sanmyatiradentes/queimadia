// Fogo Forense — contas, sessão e armazenamento privado (compartilhado pelas funções da API).
// Usuários e dados restritos ficam no Vercel Blob PRIVADO (BLOB_READ_WRITE_TOKEN deste projeto).
// Senhas: scrypt com sal. Sessão: cookie HttpOnly assinado com HMAC-SHA256 (SESSAO_SEGREDO), 12 h.
import { get, put } from "@vercel/blob";
import crypto from "node:crypto";

export const COOKIE = "ff_sessao";
const DURACAO_S = 12 * 3600;
const USUARIOS = "restrito/usuarios.json";
const ADMINS = (process.env.ADMIN_EMAILS || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);

function segredo() {
  const s = process.env.SESSAO_SEGREDO;
  if (!s || s.length < 32) throw new Error("SESSAO_SEGREDO não configurado");
  return s;
}

// ---------------------------------------------------------------- armazenamento privado
export async function lerJSON(caminho, padrao) {
  const r = await get(caminho, { access: "private", useCache: false });
  if (!r) return { dados: padrao, etag: null };
  const txt = await new Response(r.stream).text();
  return { dados: JSON.parse(txt), etag: r.blob?.etag || r.headers?.get?.("etag") || null };
}

export async function gravarJSON(caminho, dados) {
  await put(caminho, JSON.stringify(dados), {
    access: "private", addRandomSuffix: false, allowOverwrite: true, contentType: "application/json", cacheControlMaxAge: 60,
  });
}

export async function usuarios() { return (await lerJSON(USUARIOS, { usuarios: [] })).dados; }
export async function salvarUsuarios(d) { await gravarJSON(USUARIOS, d); cacheU = null; }
// para as leituras frequentes (dados do painel): cadastro em memória por 30 s
let cacheU = null;
async function usuariosRecentes() {
  if (!cacheU || Date.now() - cacheU.t > 30e3) cacheU = { t: Date.now(), d: await usuarios() };
  return cacheU.d;
}
export const ehAdminEmail = email => ADMINS.includes(String(email).toLowerCase());

// ---------------------------------------------------------------- senha
export function hashSenha(senha) {
  const sal = crypto.randomBytes(16);
  const h = crypto.scryptSync(senha, sal, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${sal.toString("base64")}$${h.toString("base64")}`;
}
export function conferirSenha(senha, guardado) {
  const [alg, sal, h] = String(guardado).split("$");
  if (alg !== "scrypt") return false;
  const calc = crypto.scryptSync(senha, Buffer.from(sal, "base64"), 64, { N: 16384, r: 8, p: 1 });
  const esp = Buffer.from(h, "base64");
  return esp.length === calc.length && crypto.timingSafeEqual(esp, calc);
}

// ---------------------------------------------------------------- sessão
const b64 = b => Buffer.from(b).toString("base64url");
export function criarSessao(email) {
  const corpo = b64(JSON.stringify({ e: email, x: Math.floor(Date.now() / 1000) + DURACAO_S }));
  const sig = crypto.createHmac("sha256", segredo()).update(corpo).digest("base64url");
  return `${corpo}.${sig}`;
}
export function lerSessao(req) {
  const ck = String(req.headers.cookie || "").split(/;\s*/).find(c => c.startsWith(COOKIE + "="));
  if (!ck) return null;
  const [corpo, sig] = ck.slice(COOKIE.length + 1).split(".");
  if (!corpo || !sig) return null;
  const esp = crypto.createHmac("sha256", segredo()).update(corpo).digest("base64url");
  if (esp.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(esp), Buffer.from(sig))) return null;
  try {
    const p = JSON.parse(Buffer.from(corpo, "base64url").toString());
    return p.x > Date.now() / 1000 ? p : null;
  } catch { return null; }
}
export function cookieSessao(token) {
  return `${COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${DURACAO_S}`;
}
export const cookieSair = `${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;

// usuário da sessão, conferido no cadastro atual (desativação vale na hora)
export async function usuarioAtual(req) {
  const s = lerSessao(req);
  if (!s) return null;
  const d = await usuariosRecentes();
  const u = d.usuarios.find(x => x.email === s.e);
  return u && u.status === "aprovado" ? u : null;
}

export const publico = u => u && ({ nome: u.nome, email: u.email, orgao: u.orgao, cargo: u.cargo, papel: u.papel, status: u.status });

export function json(res, status, corpo, extra = {}) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  for (const [k, v] of Object.entries(extra)) res.setHeader(k, v);
  res.end(JSON.stringify(corpo));
}

export async function corpoJSON(req) {
  if (req.body && typeof req.body === "object") return req.body;
  let txt = "";
  for await (const c of req) { txt += c; if (txt.length > 20000) break; }
  try { return JSON.parse(txt || "{}"); } catch { return {}; }
}
