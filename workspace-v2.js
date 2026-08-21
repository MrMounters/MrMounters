(function () {
  "use strict";

  function initWorkspaceShell() {
    document.documentElement.dataset.workspaceReady = "true";

    var sidebar = document.getElementById("sidebar");
    var toggle = document.querySelector(".mobile-menu-btn");
    if (!sidebar || !toggle) return;

    toggle.setAttribute("aria-controls", "sidebar");
    toggle.setAttribute("aria-expanded", sidebar.classList.contains("open") ? "true" : "false");

    toggle.addEventListener("click", function () {
      window.requestAnimationFrame(function () {
        toggle.setAttribute("aria-expanded", sidebar.classList.contains("open") ? "true" : "false");
      });
    });

    document.addEventListener("keydown", function (event) {
      if (event.key !== "Escape" || !sidebar.classList.contains("open")) return;
      sidebar.classList.remove("open");
      toggle.setAttribute("aria-expanded", "false");
      toggle.focus();
    });

    sidebar.addEventListener("click", function (event) {
      if (!event.target.closest(".side-item, .step-item")) return;
      if (!window.matchMedia("(max-width: 900px)").matches) return;
      sidebar.classList.remove("open");
      toggle.setAttribute("aria-expanded", "false");
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initWorkspaceShell, { once: true });
  } else {
    initWorkspaceShell();
  }
})();
