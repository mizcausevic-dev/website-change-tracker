// Runs before first paint so the stored theme and mode apply without a flash.
// `?theme=swiss&mode=dark` overrides storage for one view (used for shareable links and screenshots).
(function () {
  var root = document.documentElement;
  var themes = ['bento', 'swiss', 'cosmic', 'aqua', 'brutalist', 'steel', 'parchment'];
  var theme = 'bento';
  var mode = null;
  try {
    theme = localStorage.getItem('driftline.theme') || theme;
    mode = localStorage.getItem('driftline.mode');
  } catch (e) { /* storage unavailable: use defaults */ }
  var q = new URLSearchParams(location.search);
  if (themes.indexOf(q.get('theme')) >= 0) theme = q.get('theme');
  if (q.get('mode') === 'dark' || q.get('mode') === 'light') mode = q.get('mode');
  if (themes.indexOf(theme) < 0) theme = 'bento';
  if (!mode) mode = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  root.setAttribute('data-theme', theme);
  root.setAttribute('data-mode', mode);
})();
