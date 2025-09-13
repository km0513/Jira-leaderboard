let FILTERS = null;
let LAST_VALUES = { qa: 0, dev: 0, qaToday: 0, devToday: 0, preQa: 0, preDev: 0, deploymentReady: 0 };

async function fetchCounts() {
  const status = document.getElementById('status');
  try {
    status.textContent = 'Loading…';
    const res = await fetch('/api/counts', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    const qaCurrent = Number(data.qa ?? 0);
    const devCurrent = Number(data.dev ?? 0);
    let qaToday = data.qaToday != null ? Number(data.qaToday) : null;
    let devToday = data.devToday != null ? Number(data.devToday) : null;
    const preQa = data.preQa != null ? Number(data.preQa) : null;
    const preDev = data.preDev != null ? Number(data.preDev) : null;
    const deploymentReady = data.deploymentReady != null ? Number(data.deploymentReady) : null;

    // Helpers to wrap KPIs with links if available
    const kpi = (v) => `<span class="kpi current">${v}</span>`;
    const wrap = (url, html) => url ? `<a class="kpi-link" target="_blank" rel="noopener" href="${url}">${html}</a>` : html;

    // Determine URLs for each cell
    const qaBacklogUrl = FILTERS?.qa?.url || null;
    const devBacklogUrl = FILTERS?.dev?.url || null;
    const qaTodayUrl = FILTERS?.qaToday?.url || null;
    const devTodayUrl = FILTERS?.devToday?.url || null;
    const deploymentReadyUrl = FILTERS?.deploymentReady?.url || null;
    const preQaUrl = FILTERS?.preQa?.url || null;
    const preDevUrl = FILTERS?.preDev?.url || null;

    // Animated KPI helper
    function animateNumber(el, prev, next) {
      if (prev === undefined || prev === null) prev = 0;
      if (next === undefined || next === null) next = 0;
      prev = Number(prev); next = Number(next);
      if (!el) return;
      const dur = 650; // ms
      const start = performance.now();
      function step(ts) {
        const t = Math.min(1, (ts - start) / dur);
        const eased = 1 - Math.pow(1 - t, 3); // easeOutCubic
        const val = Math.round(prev + (next - prev) * eased);
        el.textContent = String(val);
        if (t < 1) requestAnimationFrame(step);
      }
      requestAnimationFrame(step);
    }

    // Render KPIs with links (use animated spans inside)
    const qaPre = document.getElementById('qa-pre');
    const qaC = document.getElementById('qa-current');
    const devC = document.getElementById('dev-current');
    const devPre = document.getElementById('dev-pre');
    const qaT = document.getElementById('qa-today');
    const devT = document.getElementById('dev-today');
    const depR = document.getElementById('deployment-ready');

    if (qaPre) qaPre.innerHTML = preQa != null ? wrap(preQaUrl, `<span class="kpi current"><span id="anim-qaPre"></span></span>`) : '—';
    qaC.innerHTML = wrap(qaBacklogUrl, `<span class="kpi current"><span id="anim-qa"></span></span>`);
    devC.innerHTML = wrap(devBacklogUrl, `<span class="kpi current"><span id="anim-dev"></span></span>`);
    if (devPre) devPre.innerHTML = preDev != null ? wrap(preDevUrl, `<span class="kpi current"><span id="anim-devPre"></span></span>`) : '—';
    // Strict mode: use Today filters (qaToday/devToday) exactly as returned by backend.
    const qaTodayChip = `<span class=\"kpi current\"><span id=\"anim-qaToday\"></span></span>`;
    const devTodayChip = `<span class=\"kpi current\"><span id=\"anim-devToday\"></span></span>`;
    qaT.innerHTML = qaToday != null ? (qaTodayUrl ? wrap(qaTodayUrl, qaTodayChip) : qaTodayChip) : '—';
    devT.innerHTML = devToday != null ? (devTodayUrl ? wrap(devTodayUrl, devTodayChip) : devTodayChip) : '—';
    if (depR) depR.innerHTML = deploymentReady != null ? wrap(deploymentReadyUrl, `<span class="kpi current"><span id="anim-deploy"></span></span>`) : '—';

    if (preQa != null) animateNumber(document.getElementById('anim-qaPre'), LAST_VALUES.preQa, preQa);
    animateNumber(document.getElementById('anim-qa'), LAST_VALUES.qa, qaCurrent);
    animateNumber(document.getElementById('anim-dev'), LAST_VALUES.dev, devCurrent);
    if (preDev != null) animateNumber(document.getElementById('anim-devPre'), LAST_VALUES.preDev, preDev);
    if (qaToday != null) animateNumber(document.getElementById('anim-qaToday'), LAST_VALUES.qaToday, qaToday);
    if (devToday != null) animateNumber(document.getElementById('anim-devToday'), LAST_VALUES.devToday, devToday);
    if (deploymentReady != null) animateNumber(document.getElementById('anim-deploy'), LAST_VALUES.deploymentReady, deploymentReady);

    LAST_VALUES = { qa: qaCurrent, dev: devCurrent, qaToday, devToday, preQa, preDev, deploymentReady };

    // Deployment ready count at bottom
    const depEl = document.getElementById('deploy-count');
    const depLinkUrl = FILTERS?.deploymentReady?.url || null;
    if (depEl) {
      // Number is a clickable KPI (same style as others)
      depEl.innerHTML = deploymentReady != null ? wrap(depLinkUrl, kpi(deploymentReady)) : '—';
    }

    // Inline summary (if present) and total aggregation
    const qaTodayInline = document.getElementById('qa-today-inline');
    const devTodayInline = document.getElementById('dev-today-inline');
    if (qaTodayInline) qaTodayInline.textContent = qaToday != null ? String(qaToday) : '—';
    if (devTodayInline) devTodayInline.textContent = devToday != null ? String(devToday) : '—';
    const totalTodayEl = document.getElementById('total-today');
    if (totalTodayEl) {
      if (qaToday != null || devToday != null) {
        const total = (qaToday || 0) + (devToday || 0);
        totalTodayEl.textContent = String(total);
      } else {
        totalTodayEl.textContent = '—';
      }
    }

    // Total pending = sum of QA and Dev pending closures (current backlog counts)
    const totalPendingEl = document.getElementById('total-pending');
    if (totalPendingEl) {
      const totalPending = (Number.isFinite(qaCurrent) ? qaCurrent : 0) + (Number.isFinite(devCurrent) ? devCurrent : 0);
      totalPendingEl.textContent = String(totalPending);
    }

    // Neutral status board: no leader/trophy or row highlighting

    const ts = new Date().toLocaleTimeString();
    status.textContent = `Updated at ${ts}${data.refreshSeconds ? ` · Auto-refresh ${data.refreshSeconds}s` : ''}`;
    return data;
  } catch (err) {
    status.textContent = 'Failed to load counts: ' + (err && err.message || err);
    console.error(err);
    throw err;
  }
}

(async function main() {
  let refreshMs = 60000; // default 60s
  // Load filter URLs once for link wrapping
  try {
    const res = await fetch('/api/filters', { cache: 'no-store' });
    if (res.ok) {
      FILTERS = await res.json();
      // Populate deployment ready link if present
      const dep = document.getElementById('deploy-link');
      if (dep) {
        const url = FILTERS?.deploymentReady?.url;
        if (url) {
          dep.href = url;
          dep.textContent = 'open filter';
        } else {
          dep.textContent = 'Not configured';
          dep.removeAttribute('href');
        }
      }
    }
  } catch (_) { /* ignore */ }
  try {
    const data = await fetchCounts();
    refreshMs = Math.max(5, Number(data.refreshSeconds || 60)) * 1000;
  } catch (_) {
    // keep default refresh if first load failed
  }
  setInterval(fetchCounts, refreshMs);
})();

// Countdown to the next 15th 6:00 PM IST
(function setupCountdown() {
  const dEl = document.getElementById('cd-days');
  const hEl = document.getElementById('cd-hours');
  const mEl = document.getElementById('cd-mins');
  const sEl = document.getElementById('cd-secs');
  const tgtLocalEl = document.getElementById('cd-target-local');
  if (!dEl || !hEl || !mEl || !sEl) return; // section missing

  // Returns the UTC ms timestamp for next 15th 18:00 IST
  function nextTargetUTC() {
    const nowUTC = Date.now();
    const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000; // +05:30, India has no DST
    const nowIST = new Date(nowUTC + IST_OFFSET_MS);
    let year = nowIST.getUTCFullYear();
    let month = nowIST.getUTCMonth(); // 0-11
    // 18:00 IST equals 12:30 UTC
    let targetUTC = Date.UTC(year, month, 15, 12, 30, 0, 0);
    if (nowUTC >= targetUTC) {
      // move to next month
      if (month === 11) { month = 0; year += 1; }
      else { month += 1; }
      targetUTC = Date.UTC(year, month, 15, 12, 30, 0, 0);
    }
    // Update helper text with local rendering of the target
    if (tgtLocalEl) {
      const dt = new Date(targetUTC);
      try {
        tgtLocalEl.textContent = new Intl.DateTimeFormat(undefined, {
          dateStyle: 'medium', timeStyle: 'short'
        }).format(dt);
      } catch (_) {
        tgtLocalEl.textContent = dt.toLocaleString();
      }
    }
    return targetUTC;
  }

  let targetUTC = nextTargetUTC();
  function tick() {
    const now = Date.now();
    let diff = targetUTC - now;
    if (diff <= 0) {
      // Recompute next cycle once we hit the target
      targetUTC = nextTargetUTC();
      diff = targetUTC - now;
    }
    const sec = Math.floor(diff / 1000);
    const days = Math.floor(sec / 86400);
    const hours = Math.floor((sec % 86400) / 3600);
    const mins = Math.floor((sec % 3600) / 60);
    const secs = sec % 60;
    dEl.textContent = String(days);
    hEl.textContent = String(hours).padStart(2, '0');
    mEl.textContent = String(mins).padStart(2, '0');
    sEl.textContent = String(secs).padStart(2, '0');
  }
  tick();
  setInterval(tick, 1000);
})();

// Theme toggle (auto + manual), persisted in localStorage
(function setupThemeToggle() {
  const btn = document.getElementById('theme-toggle');
  if (!btn) return;
  const root = document.documentElement;

  function apply(mode) {
    root.classList.remove('dark', 'light');
    if (mode === 'dark') root.classList.add('dark');
    if (mode === 'light') root.classList.add('light');
    btn.textContent = root.classList.contains('dark') ? '☀️' : '🌙';
  }

  function setIconFromState() {
    if (root.classList.contains('dark')) { btn.textContent = '☀️'; return; }
    if (root.classList.contains('light')) { btn.textContent = '🌙'; return; }
    const systemDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    btn.textContent = systemDark ? '☀️' : '🌙';
  }

  // Load preference (if any); otherwise mirror system, update on system change
  let pref = localStorage.getItem('theme');
  if (pref) {
    apply(pref);
  } else {
    // Apply system preference as the initial explicit theme class
    const systemDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    apply(systemDark ? 'dark' : 'light');
    // Keep icon in sync if system theme changes (until user picks a manual pref)
    if (window.matchMedia) {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      const onChange = () => {
        const hasManual = !!localStorage.getItem('theme');
        if (!hasManual) apply(mq.matches ? 'dark' : 'light');
      };
      if (typeof mq.addEventListener === 'function') mq.addEventListener('change', onChange);
      else if (typeof mq.addListener === 'function') mq.addListener(onChange);
    }
  }

  btn.addEventListener('click', () => {
    const nowDark = !document.documentElement.classList.contains('dark');
    const mode = nowDark ? 'dark' : 'light';
    localStorage.setItem('theme', mode);
    apply(mode);
  });
})();
