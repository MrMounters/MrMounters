(function () {
  var accordionItems = Array.from(document.querySelectorAll('.v2-accordion-item'));
  accordionItems.forEach(function (item) {
    function activate() {
      accordionItems.forEach(function (candidate) {
        candidate.classList.toggle('is-active', candidate === item);
      });
    }
    item.addEventListener('pointerenter', activate);
    item.addEventListener('focus', activate);
  });

  var proofTrack = document.querySelector('.v2-proof-track');
  var proofSlides = Array.from(document.querySelectorAll('.v2-quote'));
  var proofIndex = 0;

  function showProof(index) {
    if (!proofTrack || !proofSlides.length) return;
    proofIndex = (index + proofSlides.length) % proofSlides.length;
    proofTrack.style.transform = 'translate3d(' + (-proofIndex * 100) + '%, 0, 0)';
    proofSlides.forEach(function (slide, slideIndex) {
      var current = slideIndex === proofIndex;
      slide.classList.toggle('is-current', current);
      slide.setAttribute('aria-hidden', current ? 'false' : 'true');
      slide.inert = !current;
    });
  }

  document.querySelectorAll('[data-proof-direction]').forEach(function (button) {
    button.addEventListener('click', function () {
      showProof(proofIndex + (button.dataset.proofDirection === 'next' ? 1 : -1));
    });
  });
  showProof(0);

  var workCarousel = document.querySelector('.v2-work-list');
  document.querySelectorAll('[data-work-direction]').forEach(function (button) {
    button.addEventListener('click', function () {
      if (!workCarousel) return;
      var card = workCarousel.querySelector('.v2-case');
      var gap = parseFloat(window.getComputedStyle(workCarousel).gap) || 0;
      var distance = card ? card.getBoundingClientRect().width + gap : workCarousel.clientWidth * 0.8;
      workCarousel.scrollBy({
        left: button.dataset.workDirection === 'next' ? distance : -distance,
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
      });
    });
  });

  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduceMotion || !window.gsap || !window.ScrollTrigger) return;

  window.gsap.registerPlugin(window.ScrollTrigger);

  window.gsap.utils.toArray('.v2-manifesto-line').forEach(function (line, index) {
    window.gsap.from(line, {
      xPercent: index % 2 ? 7 : -7,
      ease: 'none',
      scrollTrigger: {
        trigger: line,
        start: 'top 92%',
        end: 'top 48%',
        scrub: true
      }
    });
  });

  window.ScrollTrigger.matchMedia({
    '(min-width: 900px)': function () {
      var portalCards = window.gsap.utils.toArray('.v2-portal-card');
      portalCards.forEach(function (card, index) {
        var top = 88 + (index * 16);
        card.style.position = 'sticky';
        card.style.top = top + 'px';
        card.style.zIndex = String(index + 1);
        if (index < portalCards.length - 1) {
          window.gsap.to(card, {
            scale: 0.93 + (index * 0.02),
            opacity: 0.62,
            ease: 'none',
            scrollTrigger: {
              trigger: portalCards[index + 1],
              start: 'top 88%',
              end: 'top ' + (top + 120) + 'px',
              scrub: true
            }
          });
        }
      });
    }
  });

})();
