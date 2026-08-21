(function () {
  function markCurrentPage() {
    var current = (location.pathname.split('/').pop() || 'index.html').toLowerCase();
    document.querySelectorAll('a[href]').forEach(function (link) {
      var raw = link.getAttribute('href');
      if (!raw || raw.charAt(0) === '#' || /^(https?:|mailto:|tel:|sms:)/i.test(raw)) return;
      var page = raw.split('#')[0].split('?')[0].split('/').pop().toLowerCase() || 'index.html';
      if (page === current) link.setAttribute('aria-current', 'page');
    });
  }

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

  function initDesktopDropdowns() {
    document.querySelectorAll('.nav-dropdown').forEach(function (dropdown, index) {
      var trigger = dropdown.querySelector('.nav-dropdown-trigger');
      var menu = dropdown.querySelector('.nav-dropdown-menu');
      if (!trigger || !menu) return;
      var menuId = menu.id || 'serviceMenu' + index;
      menu.id = menuId;
      trigger.setAttribute('aria-controls', menuId);
      trigger.setAttribute('aria-expanded', 'false');

      function setOpen(open) {
        dropdown.classList.toggle('is-open', open);
        trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
      }

      trigger.addEventListener('click', function () { setOpen(!dropdown.classList.contains('is-open')); });
      dropdown.addEventListener('focusout', function (event) {
        if (!dropdown.contains(event.relatedTarget)) setOpen(false);
      });
      dropdown.addEventListener('pointerleave', function () {
        if (!dropdown.contains(document.activeElement)) setOpen(false);
      });
      document.addEventListener('pointerdown', function (event) {
        if (!dropdown.contains(event.target)) setOpen(false);
      });
      document.addEventListener('keydown', function (event) {
        if (event.key !== 'Escape' || !dropdown.classList.contains('is-open')) return;
        setOpen(false);
        trigger.focus();
      });
    });
  }

  function initMenu() {
    addIndustriesLinks();
    markCurrentPage();
    initDesktopDropdowns();
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
      button.setAttribute('aria-expanded', open ? 'true' : 'false');
      panel.inert = !open;
      document.body.classList.toggle('menu-open', open);
      if (open) {
        if (!lastFocused) lastFocused = document.activeElement;
        var firstLink = Array.from(panel.querySelectorAll('a[href], button:not([disabled])')).find(function (element) {
          return element.offsetParent !== null;
        });
        if (firstLink) window.requestAnimationFrame(function () { firstLink.focus({ preventScroll: true }); });
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
    panel.inert = true;

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
