'use strict';
(function () {
  const root = document.documentElement;
  const sel = document.getElementById('theme');
  sel.value = root.dataset.theme;
  const save = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } };
  sel.addEventListener('change', () => { root.dataset.theme = sel.value; save('driftline.theme', sel.value); });
  document.getElementById('mode').addEventListener('click', () => { root.dataset.mode = root.dataset.mode === 'dark' ? 'light' : 'dark'; save('driftline.mode', root.dataset.mode); });
  // Fill the measured noise rate from the live API instead of hard-coding a number.
  fetch('/v1/stats/overview', { headers: { Authorization: 'Bearer wct_demo_public_explorer_key' } })
    .then((r) => (r.ok ? r.json() : null))
    .then((s) => { if (s) document.getElementById('noise-rate').textContent = `${Math.round(s.totals.noise_rate * 100)}% (live figure)`; })
    .catch(() => {});
})();
