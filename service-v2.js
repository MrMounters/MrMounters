(function () {
  'use strict';

  var file = location.pathname.split('/').pop() || 'index.html';
  var configs = {
    'seo.html': {
      key: 'seo', label: 'Search demand system',
      title: 'Visibility is useful only when it reaches the right buyer.',
      copy: 'We connect technical foundations, high-intent pages, local discovery, and clear measurement so search becomes a dependable acquisition channel.',
      benefit: 'The search system behind the ranking.',
      benefitIntro: 'Four connected layers turn search visibility into a useful acquisition channel.',
      processTitle: 'Build authority in the right order.',
      processIntro: 'Technical access first. Commercial intent next. Useful answers and measurement after that.',
      visual: '<div class="svc-viz-stage viz-search"><div class="svc-visual-caption"><span>Demand path</span><strong>Search → answer → inquiry</strong></div><div class="svc-search-bar">best growth partner near me</div><div class="svc-result"><small>Foundation</small>Fast, crawlable, structured pages</div><div class="svc-result"><small>Intent match</small>Answers built around a buying decision</div><div class="svc-result"><small>Discovery</small>Local, organic, AEO, and GEO coverage</div><div class="svc-conversion"><small>Next action</small>Qualified inquiry →</div></div>',
      stages: [['Technical clarity','Fix indexing, speed, structure, and the signals search engines need to understand the site.'],['Demand mapping','Prioritize queries by buyer intent, commercial value, location, and the page needed to answer them.'],['Useful authority','Publish pages that are genuinely helpful to people and legible to search and answer engines.'],['Measurement','Track visibility, qualified traffic, inquiries, and the pages contributing to demand.']],
      assurance: ['Technical work before content volume','Local, organic, AEO, and GEO considered together','Reporting tied to meaningful actions']
    },
    'paid-advertising.html': {
      key: 'paid', label: 'Paid demand system',
      title: 'Spend should move through a system—not disappear into a platform.',
      copy: 'Campaign, creative, landing experience, tracking, and lead response work as one path from attention to a booked conversation.',
      benefit: 'Everything between the click and the customer.',
      benefitIntro: 'Media only works when the offer, page, tracking, and response layer agree on the same outcome.',
      processTitle: 'Give every dollar a job.',
      processIntro: 'Set the economics, build the path, then use lead quality to decide what deserves more budget.',
      visual: '<div class="svc-viz-stage viz-paid"><div class="svc-visual-caption"><span>Media control</span><strong>Budget follows qualified demand</strong></div><div class="svc-node"><small>Intent capture</small>Google search</div><div class="svc-node"><small>Demand creation</small>Meta creative</div><div class="svc-node"><small>Message match</small>Focused landing path</div><div class="svc-node"><small>Decision signal</small>Appointment outcome</div><i class="svc-pulse"></i><i class="svc-pulse"></i></div>',
      stages: [['Offer and economics','Define the action, allowable acquisition cost, service area, and capacity before spending.'],['Campaign architecture','Build Google and Meta campaigns around intent, audience, offer, and measurable conversion events.'],['Creative and landing path','Match the promise in the ad to a focused page and a reason to act now.'],['Optimization and follow-up','Use real lead quality and appointment data to decide what earns more budget.']],
      assurance: ['Google and Meta managed as one portfolio','Creative, landing pages, and tracking connected','Optimization based on lead quality—not clicks']
    },
    'web-development.html': {
      key: 'web', label: 'Custom web system',
      title: 'A strong website makes the next decision easier.',
      copy: 'Strategy, messaging, interaction, performance, and integrations are engineered together around the questions your best customer needs answered.',
      benefit: 'The disciplines behind a credible digital experience.',
      benefitIntro: 'The interface is the visible layer. The decisions underneath it are what make the site work.',
      processTitle: 'Move from business case to working interface.',
      processIntro: 'We settle the hierarchy and message before polish, then test the complete path before launch.',
      visual: '<div class="svc-viz-stage viz-web"><div class="svc-visual-caption"><span>Build state</span><strong>Strategy resolved before polish</strong></div><div class="svc-browser"><div class="svc-browser-bar"><i></i><i></i><i></i><span>/growth-system</span></div><div class="wire hero-wire"><b>One clear promise</b><small>One useful next step</small></div><div class="wire wire-split"><span></span><span></span></div><div class="wire"></div><div class="wire"></div></div><div class="svc-build-status"><span>Responsive</span><span>Accessible</span><span>Connected</span></div></div>',
      stages: [['Discovery and architecture','Clarify the audience, offer, proof, page hierarchy, and technical requirements.'],['Copy and visual direction','Turn the business case into a sharp narrative and a distinct interface system.'],['Build and connect','Develop responsive pages, forms, analytics, CRM, booking, and required integrations.'],['Quality and iteration','Test performance, accessibility, devices, conversion paths, and launch behavior.']],
      assurance: ['Custom architecture—not a reskinned template','Responsive, accessible, and performance-conscious','Analytics and business integrations included in the plan']
    },
    'website.html': {
      key: 'launch', label: '5–7 day website offer',
      title: 'A defined launch process without the agency waiting game.',
      copy: 'The productized website offer keeps scope, decisions, approvals, and delivery clear so qualified businesses can move from outdated to live quickly.',
      benefit: 'A focused website offer with a clear finish line.',
      benefitIntro: 'A defined scope and a short decision path keep the work moving without lowering the standard.',
      processTitle: 'A short timeline with visible decisions.',
      processIntro: 'The schedule stays fast because direction, copy, build, review, and launch happen in sequence.',
      visual: '<div class="svc-viz-stage viz-launch"><div class="svc-visual-caption"><span>Launch sequence</span><strong>Defined scope · focused review</strong></div><div class="launch-track"></div><div class="svc-node"><small>Day 01</small>Direction</div><div class="svc-node"><small>Day 02</small>Copy</div><div class="svc-node"><small>Day 03–05</small>Build</div><div class="svc-node"><small>Day 05–07</small>Launch</div><i class="svc-pulse"></i><div class="svc-launch-note">Timing begins after content and access are ready.</div></div>',
      stages: [['Focused intake','Collect the offer, audience, brand assets, services, proof, and required functionality.'],['Concept and copy','Establish the page direction and sharpen the message before the build expands.'],['Responsive build','Create the core pages, mobile experience, forms, booking links, and analytics.'],['Review and launch','Run a focused revision pass, complete quality assurance, and deploy the approved site.']],
      assurance: ['Defined scope and decision points','Built around a focused 5–7 business-day schedule','Mobile, forms, analytics, and launch included']
    },
    'ugc-content.html': {
      key: 'ugc', label: 'Creator content system',
      title: 'The first seconds earn attention. The rest must earn action.',
      copy: 'Hooks, scripts, creator direction, editing, and iteration are built around how people actually watch on Reels, TikTok, Shorts, and paid social.',
      benefit: 'A repeatable content operation—not random posting.',
      benefitIntro: 'Creative gets stronger when every concept has a role, every edit has a hypothesis, and learning carries forward.',
      processTitle: 'Turn one angle into a testing loop.',
      processIntro: 'We plan the opening, direct the story, edit for the platform, and let retention guide the next batch.',
      visual: '<div class="svc-viz-stage viz-ugc"><div class="svc-visual-caption"><span>Creative sequence</span><strong>Earn the next second</strong></div><div class="svc-phone"><div class="ugc-scene"><small>Opening</small>Hook the right problem</div><div class="ugc-scene"><small>Story</small>Make the claim believable</div><div class="ugc-scene"><small>Evidence</small>Show proof in context</div><div class="ugc-scene"><small>Action</small>Give one clear next step</div></div><div class="svc-retention"><span>0s</span><i></i><i></i><i></i><i></i><strong>15s</strong></div></div>',
      stages: [['Audience and angle','Identify the problem, belief, objection, and format most likely to hold attention.'],['Concept and script','Build a strong opening, believable middle, proof moment, and clear call to action.'],['Production and edit','Direct creators or footage, then cut natively for the pace and language of each platform.'],['Learn and iterate','Use retention, engagement, click, and conversion signals to guide the next creative batch.']],
      assurance: ['Concepts built for paid and organic use','Platform-native formats, captions, and pacing','A reusable testing pipeline rather than one-off clips']
    },
    'dashboards.html': {
      key: 'dashboard', label: 'Decision dashboard',
      title: 'A dashboard should answer what happened and what to do next.',
      copy: 'We bring campaigns, leads, appointments, and revenue into one readable operating view built around the decisions your team actually makes.',
      benefit: 'The numbers that matter, in the order they matter.',
      benefitIntro: 'A useful dashboard starts with operating questions, not a pile of available charts.',
      processTitle: 'Define the decision before the metric.',
      processIntro: 'We map reliable sources, agree on definitions, and build the smallest view that changes action.',
      visual: '<div class="svc-viz-stage viz-dashboard"><div class="svc-visual-caption"><span>Operating view</span><strong>Source → lead → appointment</strong></div><div class="svc-dashboard-frame"><img class="dashboard-shot" src="portal-overview-clean.jpg" alt=""></div><div class="svc-dashboard-key"><span>Spend</span><span>Demand</span><span>Pipeline</span><span>Revenue</span></div></div>',
      stages: [['Source map','Identify the reliable source for ad spend, traffic, leads, appointments, customers, and revenue.'],['Decision design','Choose the questions the dashboard must answer before choosing charts.'],['Connections and logic','Build data flows, definitions, filters, and attribution rules around the existing stack.'],['Use and refinement','Review the live view with the team and adjust it as operations and priorities change.']],
      assurance: ['Designed around decisions—not chart volume','Connected to the tools already in use','Clear definitions and ownership for every metric']
    },
    'ai-lead-generation.html': {
      key: 'lead', label: 'AI lead response',
      title: 'Fast response matters. A useful conversation matters more.',
      copy: 'The system answers promptly, understands intent, gathers the right context, books qualified prospects, and knows when a person should step in.',
      benefit: 'A responsive front door for every new inquiry.',
      benefitIntro: 'Speed, approved context, and an obvious human handoff matter more than making a bot sound impressive.',
      processTitle: 'Design the conversation before automating it.',
      processIntro: 'Rules, boundaries, tools, and handoff points are settled before the system handles a real inquiry.',
      visual: '<div class="svc-viz-stage viz-lead"><div class="svc-visual-caption"><span>Lead response</span><strong>Fast where it should be. Human where it matters.</strong></div><div class="svc-message"><small>New inquiry · now</small>Do you have availability this week?</div><div class="svc-message"><small>Approved response</small>Yes. Which service are you considering?</div><div class="svc-message"><small>Qualified handoff</small>Consultation reserved · team notified</div><div class="svc-human-boundary"><span>Human review</span>Clinical, legal, pricing, and exception decisions</div></div>',
      stages: [['Conversation design','Define approved answers, qualification questions, booking rules, boundaries, and escalation conditions.'],['Channel connection','Connect the places inquiries arrive with the CRM, calendar, and notification workflow.'],['Human handoff','Give the team context and a clear moment to enter sensitive, complex, or high-value conversations.'],['Review and tuning','Inspect real conversations and refine language, qualification, routing, and follow-up timing.']],
      assurance: ['Business-specific answers and qualification','Clear human escalation and safety boundaries','CRM, calendar, and source context preserved']
    },
    'ai-revenue-systems.html': {
      key: 'system', label: 'AI revenue operating system',
      title: 'Acquisition becomes valuable when the whole system closes the loop.',
      copy: 'Campaigns, lead capture, response, qualification, booking, CRM status, follow-up, and revenue attribution work as one coordinated operating system.',
      benefit: 'The connected infrastructure behind dependable follow-up.',
      benefitIntro: 'The system is valuable because each stage shares context with the next and carries the outcome back to acquisition.',
      processTitle: 'Close the gap between demand and revenue.',
      processIntro: 'We map ownership and exceptions first, connect the working path, then tune it with real pipeline outcomes.',
      visual: '<div class="svc-viz-stage viz-system"><div class="svc-visual-caption"><span>Revenue architecture</span><strong>Context travels with the lead</strong></div><div class="svc-node"><small>Demand</small>Google + Meta</div><div class="svc-node"><small>Inbound</small>Calls + forms</div><div class="svc-node"><small>Routing layer</small>Qualify + assign</div><div class="svc-node"><small>Operations</small>CRM + calendar</div><div class="svc-node"><small>Closed loop</small>Revenue visible</div><i class="svc-pulse"></i><i class="svc-pulse"></i></div>',
      stages: [['Revenue architecture','Map acquisition sources, response rules, pipeline stages, ownership, and the outcomes worth measuring.'],['System build','Connect lead capture, conversation logic, CRM, calendar, notifications, and reporting.'],['Controlled automation','Automate repeatable actions while preserving approvals and human judgment where they matter.'],['Operating rhythm','Use conversation, pipeline, and revenue data to improve offers, campaigns, follow-up, and capacity.']],
      assurance: ['One system across acquisition and follow-up','Human control at consequential decisions','Attribution carried through to pipeline and revenue']
    }
  };

  var config = configs[file];
  if (!config) return;

  document.body.classList.add('service-v2');
  document.body.dataset.service = config.key;

  var hero = document.querySelector('.hero.has-rocket');
  if (hero) {
    var visual = document.createElement('div');
    visual.className = 'svc-visual';
    visual.dataset.label = config.label;
    visual.setAttribute('aria-hidden', 'true');
    visual.innerHTML = config.visual;
    hero.appendChild(visual);

    var mechanism = document.createElement('section');
    mechanism.className = 'svc-mechanism';
    mechanism.innerHTML = '<div class="svc-mechanism-inner"><div class="svc-mechanism-copy"><span class="svc-kicker">How the system works</span><h2>' + config.title + '</h2><p>' + config.copy + '</p></div><div class="svc-stage-list">' + config.stages.map(function (stage, index) {
      return '<article class="svc-stage"><span>' + String(index + 1).padStart(2, '0') + '</span><div><h3>' + stage[0] + '</h3><p>' + stage[1] + '</p></div></article>';
    }).join('') + '</div></div>';
    hero.insertAdjacentElement('afterend', mechanism);
  }

  var benefitTitle = document.querySelector('#benefits .section-title, #system .section-title, .mission-section .section-title');
  if (benefitTitle) benefitTitle.textContent = config.benefit;
  var benefitSection = benefitTitle && benefitTitle.closest('section');
  if (benefitSection) {
    var benefitLabel = benefitSection.querySelector('.section-eyebrow');
    var benefitIntro = benefitSection.querySelector('.section-sub');
    if (benefitLabel) benefitLabel.textContent = 'Operating components';
    if (benefitIntro) benefitIntro.textContent = config.benefitIntro;
  }

  var processSection = document.getElementById('how');
  if (processSection) {
    var processLabel = processSection.querySelector('.section-eyebrow');
    var processTitle = processSection.querySelector('.section-title');
    var processIntro = processSection.querySelector('.section-sub');
    if (processLabel) processLabel.textContent = 'Working sequence';
    if (processTitle) processTitle.textContent = config.processTitle;
    if (processIntro) processIntro.textContent = config.processIntro;
  }

  var cta = document.querySelector('.cta-band');
  if (cta) {
    var assurance = document.createElement('section');
    assurance.className = 'svc-assurance';
    assurance.setAttribute('aria-label', 'How Meridion approaches this service');
    assurance.innerHTML = '<div class="svc-assurance-head"><span>Build principles</span><p>What stays true from scope through launch.</p></div><div class="svc-assurance-grid">' + config.assurance.map(function (item, index) {
      return '<div><span>' + String(index + 1).padStart(2, '0') + '</span><strong>' + item + '</strong></div>';
    }).join('') + '</div>';
    cta.insertAdjacentElement('beforebegin', assurance);
  }

  var reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var motionItems = document.querySelectorAll('.svc-stage, .svc-visual');
  if (!reducedMotion && 'IntersectionObserver' in window) {
    var stageObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        var siblings = entry.target.parentElement ? Array.from(entry.target.parentElement.children) : [];
        entry.target.style.setProperty('--svc-delay', Math.min(Math.max(siblings.indexOf(entry.target), 0) * 70, 210) + 'ms');
        entry.target.classList.add('is-visible');
        stageObserver.unobserve(entry.target);
      });
    }, { threshold: 0.14, rootMargin: '0px 0px -6% 0px' });
    motionItems.forEach(function (item) { stageObserver.observe(item); });
  } else {
    motionItems.forEach(function (item) { item.classList.add('is-visible'); });
  }

  var progress = document.getElementById('scrollProgress');
  if (progress) {
    var ticking = false;
    window.addEventListener('scroll', function () {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(function () {
        var max = document.documentElement.scrollHeight - innerHeight;
        document.body.style.setProperty('--svc-progress', max > 0 ? Math.min(scrollY / max, 1) : 0);
        ticking = false;
      });
    }, { passive: true });
    window.dispatchEvent(new Event('scroll'));
  }
})();
