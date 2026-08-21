(function () {
  'use strict';

  var STORAGE_KEY = 'jb-cookie';
  var CLARITY_ID = 'xj1vynd82i';
  var clarityLoaded = false;

  function preference() {
    try { return localStorage.getItem(STORAGE_KEY); } catch (_) { return null; }
  }

  function savePreference(value) {
    try { localStorage.setItem(STORAGE_KEY, value); } catch (_) {}
  }

  function loadClarity() {
    if (clarityLoaded || preference() !== 'accepted') return;
    clarityLoaded = true;
    window.clarity = window.clarity || function () {
      (window.clarity.q = window.clarity.q || []).push(arguments);
    };
    var script = document.createElement('script');
    script.async = true;
    script.src = 'https://www.clarity.ms/tag/' + CLARITY_ID;
    script.dataset.meridionAnalytics = 'clarity';
    document.head.appendChild(script);
  }

  function createBanner() {
    var banner = document.createElement('aside');
    banner.id = 'cookieBanner';
    banner.setAttribute('role', 'dialog');
    banner.setAttribute('aria-label', 'Analytics preference');
    banner.innerHTML = '<p class="cb-text">Optional analytics help us improve the site. You can continue without them. <a href="privacy.html">Privacy</a></p><div class="cb-actions"><button id="cbDecline" type="button">Continue without</button><button id="cbAccept" type="button">Allow analytics</button></div>';
    document.body.appendChild(banner);
    return banner;
  }

  function init() {
    var current = preference();
    if (current === 'accepted') {
      loadClarity();
      return;
    }
    if (current === 'declined') return;

    var banner = document.getElementById('cookieBanner') || createBanner();
    var accept = document.getElementById('cbAccept');
    var decline = document.getElementById('cbDecline');
    if (!accept || !decline) return;

    function dismiss(value) {
      savePreference(value);
      banner.classList.remove('cb-show');
      banner.setAttribute('aria-hidden', 'true');
      window.setTimeout(function () { banner.hidden = true; }, 240);
      if (value === 'accepted') loadClarity();
    }

    accept.addEventListener('click', function () { dismiss('accepted'); }, { once: true });
    decline.addEventListener('click', function () { dismiss('declined'); }, { once: true });
    window.setTimeout(function () {
      banner.hidden = false;
      banner.classList.add('cb-show');
    }, 500);
  }

  window.meridionConsent = {
    get: preference,
    accept: function () { savePreference('accepted'); loadClarity(); },
    decline: function () { savePreference('declined'); }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
