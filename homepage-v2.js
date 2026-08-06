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
      slide.classList.toggle('is-current', slideIndex === proofIndex);
      slide.setAttribute('aria-hidden', slideIndex === proofIndex ? 'false' : 'true');
    });
  }

  document.querySelectorAll('[data-proof-direction]').forEach(function (button) {
    button.addEventListener('click', function () {
      showProof(proofIndex + (button.dataset.proofDirection === 'next' ? 1 : -1));
    });
  });
  showProof(0);

  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduceMotion || !window.gsap || !window.ScrollTrigger) return;

  window.gsap.registerPlugin(window.ScrollTrigger);

  window.gsap.utils.toArray('.v2-case').forEach(function (card) {
    var image = card.querySelector('img');
    if (image) {
      window.gsap.fromTo(image, { scale: 0.88 }, {
        scale: 1,
        ease: 'none',
        scrollTrigger: {
          trigger: card,
          start: 'top bottom',
          end: 'bottom top',
          scrub: true
        }
      });
    }
    window.gsap.from(card.querySelectorAll('.v2-case-meta, h3, p'), {
      y: 18,
      duration: 0.8,
      stagger: 0.08,
      scrollTrigger: {
        trigger: card,
        start: 'top 70%'
      }
    });
  });

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
      var workSection = document.querySelector('.v2-work');
      var workTitle = document.querySelector('.v2-work-title');
      if (workSection && workTitle) {
        window.ScrollTrigger.create({
          trigger: workSection,
          start: 'top 92px',
          end: 'bottom bottom',
          pin: workTitle,
          pinSpacing: false
        });
      }

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
