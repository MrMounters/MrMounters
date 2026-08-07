(function () {
  'use strict';

  var page = window.MERIDION_INDUSTRY;
  var root = document.getElementById('industryPage');
  if (!page || !root) return;

  var industries = [
    ['med-spas.html', 'Med spas'],
    ['cosmetic-dentistry.html', 'Cosmetic dentistry'],
    ['hormone-peptide-clinics.html', 'Hormone + peptide clinics'],
    ['hvac.html', 'HVAC'],
    ['roofing-home-services.html', 'Roofing + home services'],
    ['personal-injury-law.html', 'Personal injury law'],
    ['automotive-dealers.html', 'Automotive dealers']
  ];

  function esc(value) {
    return String(value).replace(/[&<>"']/g, function (char) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[char];
    });
  }

  function industryLinks(current) {
    return industries.map(function (item) {
      var active = item[0] === current ? ' aria-current="page"' : '';
      return '<a href="' + item[0] + '"' + active + '>' + esc(item[1]) + '</a>';
    }).join('');
  }

  function systemItems() {
    return page.system.map(function (item, index) {
      var title = Array.isArray(item) ? item[0] : item.title;
      var copy = Array.isArray(item) ? item[1] : item.copy;
      return '<article class="ind-system-item ind-reveal">' +
        '<span>0' + (index + 1) + '</span>' +
        '<h3>' + esc(title) + '</h3>' +
        '<p>' + esc(copy) + '</p>' +
        '<div class="ind-system-icon" aria-hidden="true"></div>' +
      '</article>';
    }).join('');
  }

  function lossItems() {
    return page.losses.map(function (item, index) {
      return '<article class="ind-loss ind-reveal"><span>0' + (index + 1) + '</span><h3>' + esc(item) + '</h3></article>';
    }).join('');
  }

  function scoreItems() {
    return page.metrics.map(function (item, index) {
      return '<div class="ind-score-row ind-reveal"><span>0' + (index + 1) + '</span><strong>' + esc(item[0]) + '</strong><small>' + esc(item[1]) + '</small></div>';
    }).join('');
  }

  function flowItems() {
    return page.flow.map(function (item, index) {
      return '<div class="ind-flow-step" data-step="0' + (index + 1) + '"><div><strong>' + esc(item[0]) + '</strong><small>' + esc(item[1]) + '</small></div><time>' + esc(item[2]) + '</time></div>';
    }).join('');
  }

  function faqItems() {
    return page.faq.map(function (item, index) {
      return '<div class="ind-faq-item' + (index === 0 ? ' is-open' : '') + '">' +
        '<button class="ind-faq-question" type="button" aria-expanded="' + (index === 0 ? 'true' : 'false') + '">' + esc(item[0]) + '<span aria-hidden="true">+</span></button>' +
        '<div class="ind-faq-answer"><div><p>' + esc(item[1]) + '</p></div></div>' +
      '</div>';
    }).join('');
  }

  root.innerHTML =
    '<a class="ind-skip" href="#main">Skip to content</a>' +
    '<div class="ind-progress" aria-hidden="true"></div>' +
    '<header class="ind-nav">' +
      '<a class="ind-logo" href="index.html" aria-label="Meridion AI home"><img src="meridion-logo-full.png" alt="Meridion AI"></a>' +
      '<nav class="ind-nav-center" aria-label="Primary"><a href="industries.html">Industries</a><a href="index.html#capabilities">Services</a><a href="work.html">Work</a><a href="about.html">About</a></nav>' +
      '<a class="ind-nav-action" href="https://cal.com/john-bert/15min" target="_blank" rel="noopener">Book a call</a>' +
      '<button class="ind-menu-button" type="button" aria-expanded="false" aria-controls="industryMobileMenu" aria-label="Open menu"><span></span><span></span><span></span></button>' +
    '</header>' +
    '<aside class="ind-mobile-menu" id="industryMobileMenu" aria-hidden="true"><p>Growth, built for your market.</p><nav><a href="industries.html">All industries</a><a href="index.html#capabilities">Services</a><a href="work.html">Work</a><a href="about.html">About</a><a href="https://cal.com/john-bert/15min" target="_blank" rel="noopener">Book a call</a></nav></aside>' +
    '<main id="main">' +
      '<section class="ind-hero">' +
        '<div class="ind-hero-copy">' +
          '<p class="ind-kicker">Growth systems for ' + esc(page.label) + '</p>' +
          '<h1>' + esc(page.headline[0]) + '<em>' + esc(page.headline[1]) + '</em></h1>' +
          '<p class="ind-hero-summary">' + esc(page.summary) + '</p>' +
          '<div class="ind-hero-actions"><a class="ind-button" href="https://cal.com/john-bert/15min" target="_blank" rel="noopener">Get your free growth map</a><a class="ind-button ind-button-secondary" href="#system">See the system</a></div>' +
          '<p class="ind-hero-note"><span>15-minute working session</span><span>No generic audit</span><span>Built around your market</span></p>' +
        '</div>' +
        '<div class="ind-console" aria-label="Animated lead journey for ' + esc(page.label) + '">' +
          '<div class="ind-console-head"><span><i></i>Live lead path</span><span>' + esc(page.consoleLabel) + '</span></div>' +
          '<div class="ind-flow">' + flowItems() + '</div>' +
          '<div class="ind-console-result"><span>Target outcome</span><strong>' + esc(page.flowResult) + '</strong></div>' +
        '</div>' +
      '</section>' +
      '<section class="ind-section ind-problem">' +
        '<div class="ind-section-inner">' +
          '<span class="ind-section-label">Where growth leaks</span>' +
          '<h2>' + esc(page.problemHeadline[0]) + ' <em>' + esc(page.problemHeadline[1]) + '</em></h2>' +
          '<div class="ind-problem-grid"><div class="ind-problem-intro ind-reveal"><p>' + esc(page.problemIntro) + '</p></div><div class="ind-loss-list">' + lossItems() + '</div></div>' +
        '</div>' +
      '</section>' +
      '<section class="ind-section ind-system" id="system">' +
        '<div class="ind-section-inner">' +
          '<span class="ind-section-label">The Meridion system</span>' +
          '<div class="ind-section-head"><h2>' + esc(page.systemHeadline[0]) + ' <em>' + esc(page.systemHeadline[1]) + '</em></h2><p>' + esc(page.systemIntro) + '</p></div>' +
          '<div class="ind-system-list">' + systemItems() + '</div>' +
        '</div>' +
      '</section>' +
      '<section class="ind-section ind-measure">' +
        '<div class="ind-section-inner ind-measure-layout">' +
          '<div class="ind-measure-copy"><span class="ind-section-label">What stays visible</span><h2>Measure the path, <em>not the noise.</em></h2><p>' + esc(page.measureIntro) + '</p></div>' +
          '<div class="ind-scoreboard">' + scoreItems() + '</div>' +
        '</div>' +
      '</section>' +
      '<section class="ind-section ind-audit" id="audit">' +
        '<div class="ind-section-inner ind-audit-grid">' +
          '<div><span class="ind-section-label">A useful first step</span><h2>' + esc(page.auditHeadline) + '</h2></div>' +
          '<div class="ind-audit-panel ind-reveal"><h3>' + esc(page.auditTitle) + '</h3><p>' + esc(page.auditCopy) + '</p><a class="ind-button" href="https://cal.com/john-bert/15min" target="_blank" rel="noopener">Book the free 15-minute call</a><div class="ind-audit-meta"><span>Specific recommendations</span><span>No obligation</span><span>Senior review</span></div></div>' +
        '</div>' +
      '</section>' +
      '<section class="ind-section ind-faq">' +
        '<div class="ind-section-inner ind-faq-layout"><div><span class="ind-section-label">Before we talk</span><h2>Clear answers.</h2></div><div class="ind-faq-list">' + faqItems() + '</div></div>' +
      '</section>' +
      '<section class="ind-switcher"><div class="ind-switcher-inner"><p>Explore another market</p><div class="ind-switcher-links">' + industryLinks(page.slug) + '</div></div></section>' +
    '</main>' +
    '<footer class="ind-footer"><div class="ind-footer-main"><a href="index.html"><img src="meridion-logo-full.png" alt="Meridion AI"></a><nav aria-label="Footer"><a href="industries.html">Industries</a><a href="index.html#capabilities">Services</a><a href="work.html">Work</a><a href="about.html">About</a><a href="login.html">Client login</a></nav></div><div class="ind-footer-bottom"><span>\u00a9 2026 Meridion AI. Growth systems built with judgment.</span><span><a href="tel:4805890098">(480) 589-0098</a> &nbsp;\u00b7&nbsp; <a href="privacy.html">Privacy</a> &nbsp;\u00b7&nbsp; <a href="terms.html">Terms</a></span></div></footer>';

  var menuButton = document.querySelector('.ind-menu-button');
  var mobileMenu = document.getElementById('industryMobileMenu');
  function setMenu(open) {
    menuButton.setAttribute('aria-expanded', String(open));
    menuButton.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    mobileMenu.classList.toggle('is-open', open);
    mobileMenu.setAttribute('aria-hidden', String(!open));
    document.body.classList.toggle('menu-open', open);
  }
  menuButton.addEventListener('click', function () { setMenu(menuButton.getAttribute('aria-expanded') !== 'true'); });
  mobileMenu.addEventListener('click', function (event) { if (event.target.closest('a')) setMenu(false); });
  document.addEventListener('keydown', function (event) { if (event.key === 'Escape') setMenu(false); });

  document.querySelectorAll('.ind-faq-question').forEach(function (button) {
    button.addEventListener('click', function () {
      var item = button.closest('.ind-faq-item');
      var open = !item.classList.contains('is-open');
      item.classList.toggle('is-open', open);
      button.setAttribute('aria-expanded', String(open));
    });
  });

  var reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var revealItems = document.querySelectorAll('.ind-reveal');
  if (!reducedMotion && 'IntersectionObserver' in window) {
    var revealObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-visible');
        revealObserver.unobserve(entry.target);
      });
    }, { threshold: 0.12 });
    revealItems.forEach(function (item) { revealObserver.observe(item); });
  } else {
    revealItems.forEach(function (item) { item.classList.add('is-visible'); });
  }

  var flow = Array.from(document.querySelectorAll('.ind-flow-step'));
  var flowIndex = 0;
  function paintFlow() {
    flow.forEach(function (item, index) {
      item.classList.toggle('is-active', index === flowIndex);
      item.classList.toggle('is-complete', index < flowIndex);
    });
    flowIndex = (flowIndex + 1) % flow.length;
    if (flowIndex === 0) flow.forEach(function (item) { item.classList.remove('is-complete'); });
  }
  paintFlow();
  if (!reducedMotion) window.setInterval(paintFlow, 1700);

  var progress = document.querySelector('.ind-progress');
  var scrollTicking = false;
  function updateProgress() {
    var max = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
    progress.style.transform = 'scaleX(' + Math.min(1, Math.max(0, window.scrollY / max)) + ')';
    scrollTicking = false;
  }
  window.addEventListener('scroll', function () {
    if (scrollTicking) return;
    scrollTicking = true;
    window.requestAnimationFrame(updateProgress);
  }, { passive: true });
  updateProgress();
})();
