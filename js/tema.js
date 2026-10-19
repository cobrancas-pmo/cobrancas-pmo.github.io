// Aplica o tema escolhido (automático / claro / escuro) antes de desenhar a página.
(function () {
  var t = null;
  try { t = localStorage.getItem('tema'); } catch (e) {}
  if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
})();
