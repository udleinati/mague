// Mague - utilitários frontend (vanilla JS, sem frameworks)
(function () {
  "use strict";

  // ── Confirmação de ações destrutivas ─────────────────────────────────
  // Qualquer <form data-confirm="…"> pede confirmação antes de submeter.
  // Qualquer <a data-confirm="…"> também (por exemplo links de download).
  document.addEventListener("submit", function (event) {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    const msg = form.getAttribute("data-confirm");
    if (msg && !globalThis.confirm(msg)) {
      event.preventDefault();
    }
  });

  document.addEventListener("click", function (event) {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const anchor = target.closest("a[data-confirm]");
    if (anchor) {
      const msg = anchor.getAttribute("data-confirm");
      if (msg && !globalThis.confirm(msg)) {
        event.preventDefault();
      }
    }
  });

  // ── Auto-submit de filtros ───────────────────────────────────────────
  // <select data-auto-submit> dentro de <form> submete ao mudar.
  document.querySelectorAll("select[data-auto-submit]").forEach(function (el) {
    el.addEventListener("change", function () {
      const form = el.closest("form");
      if (form) form.submit();
    });
  });

  // ── Auto-dismiss de flash messages (5s) ──────────────────────────────
  document.querySelectorAll(".alert[data-dismiss]").forEach(function (el) {
    setTimeout(function () {
      el.style.transition = "opacity 0.4s ease";
      el.style.opacity = "0";
      setTimeout(function () {
        if (el.parentNode) el.parentNode.removeChild(el);
      }, 420);
    }, 5000);
  });

  // ── Toggle sidebar (mobile hamburger) ────────────────────────────────
  const toggle = document.querySelector("[data-sidebar-toggle]");
  const layout = document.querySelector(".layout-admin");
  if (toggle && layout) {
    toggle.addEventListener("click", function () {
      layout.classList.toggle("sidebar-open");
    });
  }

  // ── Formatação auxiliar em inputs monetários ─────────────────────────
  // Converte vírgula→ponto ao submeter formulários com inputs data-money.
  // (Os POST handlers já aceitam ambos, mas isto normaliza a UI.)
  document.addEventListener("submit", function (event) {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    form.querySelectorAll("input[data-money]").forEach(function (input) {
      if (input instanceof HTMLInputElement) {
        input.value = input.value.replace(",", ".").trim();
      }
    });
  });
})();
