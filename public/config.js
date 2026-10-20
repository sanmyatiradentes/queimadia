/* Onde o painel busca os dados (JSON, imagens das análises).
   Publicado (Vercel): Vercel Blob, atualizado a cada 10 min pelo GitHub Actions.
   Local (Mac): pasta public/dados gerada pelo motor. */
(function () {
  const local = ["localhost", "127.0.0.1", ""].includes(location.hostname);
  window.QUEIMADIA_DADOS = window.QUEIMADIA_DADOS || (local ? "dados/" : "api/dados?arq=");
  // separador da versão (?v=) conforme a base já tenha "?"
  window.QD = (n, v) => window.QUEIMADIA_DADOS + n + (window.QUEIMADIA_DADOS.includes("?") ? "&" : "?") + "v=" + v;
  // acesso restrito: sem login aprovado, vai para a tela de entrada
  if (!local) {
    document.documentElement.style.visibility = "hidden";
    fetch("api/conta?acao=eu", {credentials: "same-origin"}).then(r => r.json()).then(d => {
      if (!d.usuario) location.replace(location.pathname.length > 1 && !/index\.html$/.test(location.pathname)
        ? "entrar.html?voltar=" + encodeURIComponent(location.pathname.slice(1) + location.search) : "sobre.html");
      else document.documentElement.style.visibility = "";
    }).catch(() => location.replace("sobre.html"));
  }
})();
