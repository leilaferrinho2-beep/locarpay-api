// iLocarPay Theme System — v1.0
// Manages light/dark/system preference with zero-flash guarantee.
// Storage key: ilocarpay-theme  |  Values: system | light | dark
(function () {
  var KEY = 'ilocarpay-theme';
  var ATTR = 'data-theme';

  function getPreference() {
    try { return localStorage.getItem(KEY) || 'system'; } catch (e) { return 'system'; }
  }

  function savePreference(mode) {
    try { localStorage.setItem(KEY, mode); } catch (e) {}
  }

  function resolveTheme(pref) {
    if (pref === 'light') return 'light';
    if (pref === 'dark')  return 'dark';
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function applyTheme(pref) {
    var resolved = resolveTheme(pref);
    document.documentElement.setAttribute(ATTR, resolved);
    // Update active button states if selector exists
    var btns = document.querySelectorAll('[data-theme-option]');
    btns.forEach(function(btn) {
      var active = btn.getAttribute('data-theme-option') === pref;
      btn.classList.toggle('ip-theme-active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  }

  function setTheme(mode) {
    savePreference(mode);
    applyTheme(mode);
  }

  // Apply on load (called inline from <head> for zero-flash)
  applyTheme(getPreference());

  // React to OS preference changes when mode is "system"
  try {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () {
      if (getPreference() === 'system') applyTheme('system');
    });
  } catch (e) {}

  // Public API
  window.ILocarTheme = { set: setTheme, get: getPreference };
})();
