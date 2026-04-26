(function () {
  var VALID = ['emerald', 'teal', 'coral', 'violet', 'amber'];
  var KEY = 'vf-theme';
  var LOGOS = {
    emerald: 'assets/logo-emerald.png',
    teal:    'assets/logo-teal.png',
    coral:   'assets/logo-coral.png',
    violet:  'assets/logo-violet.png',
    amber:   'assets/logo-amber.png'
  };

  function getStored() {
    try {
      var t = localStorage.getItem(KEY);
      return VALID.indexOf(t) >= 0 ? t : null;
    } catch (e) { return null; }
  }

  var initial = getStored() || 'emerald';

  // Apply to <html> immediately so descendants inherit the right CSS vars on first paint
  document.documentElement.setAttribute('data-theme', initial);

  // <body> may not exist yet (head-time script) — sync it as soon as it does
  if (document.body) {
    document.body.setAttribute('data-theme', initial);
  } else {
    new MutationObserver(function (_, obs) {
      if (document.body) {
        document.body.setAttribute('data-theme', initial);
        obs.disconnect();
      }
    }).observe(document.documentElement, { childList: true });
  }

  function applyTheme(theme) {
    if (VALID.indexOf(theme) < 0) return;
    document.documentElement.setAttribute('data-theme', theme);
    if (document.body) document.body.setAttribute('data-theme', theme);
    var src = LOGOS[theme];
    if (src) {
      document.querySelectorAll('img.theme-logo').forEach(function (img) {
        img.src = src;
      });
    }
    document.querySelectorAll('.theme-dot').forEach(function (d) {
      d.classList.toggle('active', d.dataset.t === theme);
    });
  }

  function init() {
    applyTheme(initial);
    document.querySelectorAll('.theme-dot').forEach(function (dot) {
      dot.addEventListener('click', function () {
        var t = dot.dataset.t;
        if (VALID.indexOf(t) < 0) return;
        applyTheme(t);
        try { localStorage.setItem(KEY, t); } catch (e) {}
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
