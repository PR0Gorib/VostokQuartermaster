/* Applies the saved theme before the page is drawn. 'system' follows the operating system; the default is dark. */
(function () {
  var saved = function () { try { return localStorage.getItem('theme') || 'dark'; } catch (e) { return 'dark'; } };
  var light = function () { return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches); };
  var apply = function (mode) {
    document.documentElement.setAttribute('data-theme', (mode === 'system' ? light() : mode === 'light') ? 'light' : 'dark');
    try { document.dispatchEvent(new CustomEvent('vqtheme')); } catch (e) { /* not needed */ }
  };
  apply(saved());
  window.VQTheme = {
    get: saved,
    set: function (mode) { try { localStorage.setItem('theme', mode); } catch (e) { /* storage not available */ } apply(mode); }
  };
  try { window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', function () { if (saved() === 'system') apply('system'); }); } catch (e) { /* older engine */ }
})();
