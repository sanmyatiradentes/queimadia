/* Onde o painel busca os dados (JSON, imagens das análises).
   Publicado (Vercel): ramo `dados` do GitHub, atualizado a cada 10 min pelo GitHub Actions.
   Local (Mac): pasta public/dados gerada pelo motor. */
(function () {
  const local = ["localhost", "127.0.0.1", ""].includes(location.hostname);
  window.QUEIMADIA_DADOS = window.QUEIMADIA_DADOS ||
    (local ? "dados/" : "https://raw.githubusercontent.com/sanmyatiradentes/queimadia/dados/");
})();
