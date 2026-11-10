// Selecao de um trecho da tela: arrastar marca o retangulo, soltar confirma, Esc cancela.
(function () {
  const box = document.getElementById('box');
  const hint = document.getElementById('hint');
  let start = null;

  function rectFrom(event) {
    const x = Math.min(start.x, event.clientX);
    const y = Math.min(start.y, event.clientY);
    return { x, y, width: Math.abs(event.clientX - start.x), height: Math.abs(event.clientY - start.y) };
  }

  window.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return window.aside.regionDone(null);
    start = { x: event.clientX, y: event.clientY };
    document.body.classList.add('selecting');
    hint.hidden = true;
  });

  window.addEventListener('pointermove', (event) => {
    if (!start) return;
    const rect = rectFrom(event);
    box.hidden = false;
    box.style.left = `${rect.x}px`;
    box.style.top = `${rect.y}px`;
    box.style.width = `${rect.width}px`;
    box.style.height = `${rect.height}px`;
  });

  window.addEventListener('pointerup', (event) => {
    if (!start) return;
    const rect = rectFrom(event);
    start = null;
    window.aside.regionDone(rect);
  });

  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') window.aside.regionDone(null);
  });
})();
