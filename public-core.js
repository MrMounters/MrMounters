(function () {
  'use strict';

  document.documentElement.classList.add('js');

  var reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  var progress = document.querySelector('[data-core-progress]');
  var header = document.querySelector('[data-core-header]');
  var scrollFrame = 0;

  function updateScrollChrome() {
    var max = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
    var amount = Math.min(1, Math.max(0, window.scrollY / max));
    if (progress) progress.style.transform = 'scaleX(' + amount + ')';
    if (header) header.classList.toggle('is-scrolled', window.scrollY > 36);
    scrollFrame = 0;
  }

  function requestScrollChrome() {
    if (scrollFrame) return;
    scrollFrame = window.requestAnimationFrame(updateScrollChrome);
  }

  window.addEventListener('scroll', requestScrollChrome, { passive: true });
  window.addEventListener('resize', requestScrollChrome, { passive: true });
  updateScrollChrome();

  var menu = document.querySelector('[data-core-menu]');
  var menuOpen = document.querySelector('[data-core-menu-open]');
  var menuClose = document.querySelector('[data-core-menu-close]');
  var returnFocus = null;

  function menuFocusable() {
    if (!menu) return [];
    return Array.from(menu.querySelectorAll('a[href], button:not([disabled])'));
  }

  function setMenu(open) {
    if (!menu || !menuOpen) return;
    menu.classList.toggle('is-open', open);
    menu.setAttribute('aria-hidden', open ? 'false' : 'true');
    menu.inert = !open;
    menuOpen.setAttribute('aria-expanded', open ? 'true' : 'false');
    document.body.classList.toggle('core-menu-open', open);
    if (open) {
      returnFocus = document.activeElement;
      var first = menuFocusable()[0];
      if (first) first.focus();
    } else if (returnFocus && typeof returnFocus.focus === 'function') {
      returnFocus.focus();
    }
  }

  if (menu && menuOpen) {
    menu.inert = true;
    menuOpen.addEventListener('click', function () { setMenu(true); });
    if (menuClose) menuClose.addEventListener('click', function () { setMenu(false); });
    menu.querySelectorAll('a').forEach(function (link) {
      link.addEventListener('click', function () { setMenu(false); });
    });
    document.addEventListener('keydown', function (event) {
      if (!menu.classList.contains('is-open')) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        setMenu(false);
        return;
      }
      if (event.key !== 'Tab') return;
      var items = menuFocusable();
      if (!items.length) return;
      var first = items[0];
      var last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });
  }

  var revealItems = Array.from(document.querySelectorAll('.core-reveal'));
  if (reducedMotion.matches || !('IntersectionObserver' in window)) {
    revealItems.forEach(function (item) { item.classList.add('is-visible'); });
  } else {
    var revealObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-visible');
        revealObserver.unobserve(entry.target);
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
    revealItems.forEach(function (item) { revealObserver.observe(item); });
  }

  document.querySelectorAll('[data-carousel-direction]').forEach(function (button) {
    button.addEventListener('click', function () {
      var selector = button.getAttribute('data-carousel-target');
      var rail = selector ? document.querySelector(selector) : null;
      if (!rail) return;
      var card = rail.firstElementChild;
      var gap = parseFloat(window.getComputedStyle(rail).gap) || 0;
      var distance = card ? card.getBoundingClientRect().width + gap : rail.clientWidth * 0.84;
      rail.scrollBy({
        left: button.getAttribute('data-carousel-direction') === 'next' ? distance : -distance,
        behavior: reducedMotion.matches ? 'auto' : 'smooth'
      });
    });
  });

  var analyticsId = 'xj1vynd82i';
  function loadAnalytics() {
    if (document.querySelector('script[data-meridion-analytics]')) return;
    window.clarity = window.clarity || function () {
      (window.clarity.q = window.clarity.q || []).push(arguments);
    };
    var analytics = document.createElement('script');
    analytics.async = true;
    analytics.src = 'https://www.clarity.ms/tag/' + analyticsId;
    analytics.dataset.meridionAnalytics = 'true';
    document.head.appendChild(analytics);
  }
  window.meridionAcceptAnalytics = loadAnalytics;

  var banner = document.getElementById('cookieBanner');
  var accept = document.getElementById('cbAccept');
  var decline = document.getElementById('cbDecline');
  var consent = null;
  try { consent = window.localStorage.getItem('jb-cookie'); } catch (error) {}

  function dismissBanner() {
    if (!banner) return;
    banner.classList.remove('cb-show');
    window.setTimeout(function () {
      banner.hidden = true;
      banner.style.display = 'none';
    }, 200);
  }

  if (consent === 'accepted') {
    if (banner) {
      banner.hidden = true;
      banner.style.display = 'none';
    }
    loadAnalytics();
  } else if (consent === 'declined') {
    if (banner) {
      banner.hidden = true;
      banner.style.display = 'none';
    }
  } else if (banner) {
    banner.hidden = false;
    banner.style.removeProperty('display');
    window.setTimeout(function () { banner.classList.add('cb-show'); }, 700);
  }

  if (accept) {
    accept.addEventListener('click', function () {
      try { window.localStorage.setItem('jb-cookie', 'accepted'); } catch (error) {}
      loadAnalytics();
      dismissBanner();
    });
  }

  if (decline) {
    decline.addEventListener('click', function () {
      try { window.localStorage.setItem('jb-cookie', 'declined'); } catch (error) {}
      dismissBanner();
    });
  }

  try {
    var key = 'meridion-utm';
    var query = new URLSearchParams(window.location.search);
    var names = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'];
    var attribution = {};
    names.forEach(function (name) {
      if (query.get(name)) attribution[name] = query.get(name);
    });
    if (Object.keys(attribution).length) {
      window.localStorage.setItem(key, JSON.stringify(attribution));
    } else {
      attribution = JSON.parse(window.localStorage.getItem(key) || '{}');
    }
    var campaign = new URLSearchParams();
    names.forEach(function (name) {
      if (attribution[name]) campaign.set(name, attribution[name]);
    });
    if (campaign.toString()) {
      document.querySelectorAll('a[href*="cal.com/"]').forEach(function (link) {
        var url = new URL(link.href);
        campaign.forEach(function (value, name) { url.searchParams.set(name, value); });
        link.href = url.toString();
      });
    }
  } catch (error) {}
})();
