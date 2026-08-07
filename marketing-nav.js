(function () {
  function addIndustriesLinks() {
    document.querySelectorAll('.nav-links').forEach(function (nav) {
      if (nav.querySelector('a[href="industries.html"]')) return;
      var work = nav.querySelector(':scope > a[href="work.html"]');
      if (!work) return;
      var link = document.createElement('a');
      link.href = 'industries.html';
      link.textContent = 'Industries';
      nav.insertBefore(link, work);
    });

    document.querySelectorAll('.mobile-nav').forEach(function (nav) {
      if (nav.querySelector('a[href="industries.html"]')) return;
      var work = nav.querySelector('a[href="work.html"]');
      if (!work) return;
      var link = document.createElement('a');
      link.href = 'industries.html';
      link.className = 'mobile-link mnav-row mnav-row-top';
      link.innerHTML = '<span class="mnav-label">Industries</span><span class="mnav-chevron"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg></span>';
      nav.insertBefore(link, work);
    });
  }

  function initMenu() {
    addIndustriesLinks();
    var button = document.getElementById('navHamburger');
    var panel = document.getElementById('mobileNav');
    if (!button || !panel) return;

    var lastFocused = null;

    function isOpen() {
      return panel.classList.contains('open');
    }

    function syncMenu() {
      var open = isOpen();
      panel.setAttribute('aria-hidden', open ? 'false' : 'true');
      document.body.classList.toggle('menu-open', open);
      if (open) {
        lastFocused = document.activeElement;
      } else if (lastFocused && document.contains(lastFocused)) {
        lastFocused.focus({ preventScroll: true });
        lastFocused = null;
      }
    }

    function closeMenu() {
      if (!isOpen()) return;
      if (typeof window.closeMobileNav === 'function') {
        window.closeMobileNav();
      } else {
        button.classList.remove('open');
        panel.classList.remove('open');
        button.setAttribute('aria-expanded', 'false');
        document.body.style.overflow = '';
      }
      syncMenu();
    }

    panel.setAttribute('aria-hidden', 'true');

    button.addEventListener('click', function () {
      window.requestAnimationFrame(syncMenu);
    });

    panel.addEventListener('click', function (event) {
      if (event.target === panel) closeMenu();
    });

    document.addEventListener('keydown', function (event) {
      if (!isOpen()) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        closeMenu();
        return;
      }
      if (event.key !== 'Tab') return;

      var focusable = Array.from(panel.querySelectorAll('a[href], button:not([disabled])')).filter(function (element) {
        return element.offsetParent !== null;
      });
      if (!focusable.length) return;
      var first = focusable[0];
      var last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });

    window.addEventListener('resize', function () {
      if (window.innerWidth > 900) closeMenu();
    }, { passive: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initMenu, { once: true });
  } else {
    initMenu();
  }
})();
