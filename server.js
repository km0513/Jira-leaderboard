// Minimal dependency-free Node server to serve the leaderboard webview
// and proxy Jira filter counts securely from server-side.

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

// Simple .env loader (no dotenv dependency)
function loadEnv(envPath = path.join(__dirname, '.env')) {
  try {
    const text = fs.readFileSync(envPath, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim();
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch (_) {
    // no .env – ignore
  }
}

// Simple in-memory cache (per server process) with TTL
const CACHE = new Map();
function cacheGet(key) {
  const hit = CACHE.get(key);
  if (!hit) return null;
  if (hit.expireAt && Date.now() > hit.expireAt) { CACHE.delete(key); return null; }
  return hit.value;
}
function cacheSet(key, value, ttlMs) {
  CACHE.set(key, { value, expireAt: ttlMs ? Date.now() + ttlMs : 0 });
}

function getAuthHeaders() {
  if (!JIRA_BASE_URL || !JIRA_EMAIL || !JIRA_API_TOKEN) {
    throw new Error('Missing Jira configuration (JIRA_BASE_URL/JIRA_EMAIL/JIRA_API_TOKEN)');
  }
  const auth = Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString('base64');
  return {
    'Authorization': `Basic ${auth}`,
    'Accept': 'application/json',
    'User-Agent': 'jira-leaderboard-webview/1.4',
  };
}

async function searchIssues(jql, max = 200) {
  const base = JIRA_BASE_URL.replace(/\/$/, '');
  const headers = getAuthHeaders();
  const jqlParam = encodeURIComponent(jql);
  const fields = encodeURIComponent('key');
  const url = `${base}/rest/api/3/search?jql=${jqlParam}&maxResults=${Math.min(max, 1000)}&fields=${fields}`;
  const res = await fetchJSON(url, { headers });
  const issues = Array.isArray(res.issues) ? res.issues : [];
  return issues.map(it => ({ key: it.key, id: it.id }));
}

async function fetchChangelog(issueId, startAt = 0, maxResults = 100) {
  const base = JIRA_BASE_URL.replace(/\/$/, '');
  const headers = getAuthHeaders();
  const url = `${base}/rest/api/3/issue/${issueId}/changelog?startAt=${startAt}&maxResults=${maxResults}`;
  return fetchJSON(url, { headers });
}

function withinWindow(ts, since, until) {
  const t = new Date(ts).getTime();
  if (Number.isNaN(t)) return false;
  if (since && t < new Date(since).getTime()) return false;
  if (until && t > new Date(until).getTime()) return false;
  return true;
}

async function countTransitionsByUser(issues, fromName, toName, since, until, notFromName, notToName) {
  const counts = new Map(); // author.displayName => number

  async function processIssue(issue) {
    let startAt = 0;
    let total = 0;
    do {
      const log = await fetchChangelog(issue.id, startAt, 100);
      total = log.total || 0;
      const histories = Array.isArray(log.values) ? log.values : [];
      for (const h of histories) {
        const authorName = h.author && (h.author.displayName || h.author.name || h.author.accountId) || 'Unknown';
        const created = h.created;
        if (since || until) {
          if (!withinWindow(created, since, until)) continue;
        }
        const items = Array.isArray(h.items) ? h.items : [];
        for (const it of items) {
          if (it.field !== 'status') continue;
          const from = (it.fromString || '').trim();
          const to = (it.toString || '').trim();
          const fromOk = (!fromName || from.toLowerCase() === String(fromName).toLowerCase()) && (!notFromName || from.toLowerCase() !== String(notFromName).toLowerCase());
          const toOk = (!toName || to.toLowerCase() === String(toName).toLowerCase()) && (!notToName || to.toLowerCase() !== String(notToName).toLowerCase());
          if (fromOk && toOk) {
            counts.set(authorName, (counts.get(authorName) || 0) + 1);
          }
        }
      }
      startAt += histories.length;
      if (histories.length === 0) break;
    } while (startAt < total);
  }

  async function mapLimit(arr, limit, iter) {
    const pending = new Set();
    for (const item of arr) {
      const p = Promise.resolve().then(() => iter(item));
      pending.add(p);
      p.finally(() => pending.delete(p));
      if (pending.size >= limit) {
        await Promise.race(pending);
      }
    }
    await Promise.all(pending);
  }

  const concurrency = Math.max(1, Math.min(10, Number(process.env.MOVERS_CONCURRENCY || 5)));
  await mapLimit(issues, concurrency, processIssue);

  const arr = Array.from(counts.entries()).map(([user, count]) => ({ user, count }));
  arr.sort((a, b) => b.count - a.count || a.user.localeCompare(b.user));
  return arr;
}

async function handleMovers(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const filter = url.searchParams.get('filter');
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    const notFrom = url.searchParams.get('notFrom');
    const notTo = url.searchParams.get('notTo');
    const since = url.searchParams.get('since');
    const until = url.searchParams.get('until');
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '20', 10) || 20, 100);
    const maxIssues = Math.min(parseInt(url.searchParams.get('maxIssues') || '150', 10) || 150, 1000);
    const concurrencyParam = Math.min(parseInt(url.searchParams.get('concurrency') || '0', 10) || 0, 20);
    const ttl = Math.min(parseInt(url.searchParams.get('ttl') || '60', 10) || 60, 600) * 1000;

    if (!filter) return sendJSON(res, 400, { error: 'Missing required query param: filter' });
    const jqlOrFilter = toJql(filter);
    if (!jqlOrFilter) return sendJSON(res, 400, { error: 'Invalid filter/JQL' });

    const jql = jqlOrFilter; // filter=NN or raw JQL
    const cacheKey = JSON.stringify({ jql, from, to, notFrom, notTo, since, until, limit, maxIssues, concurrencyParam });
    const cached = cacheGet(cacheKey);
    if (cached) {
      return sendJSON(res, 200, cached);
    }

    const issues = await searchIssues(jql, maxIssues);
    const results = await countTransitionsByUser(issues, from, to, since, until, notFrom, notTo);
    const top = results.slice(0, limit);
    const payload = {
      filter,
      from: from || null,
      to: to || null,
      notFrom: notFrom || null,
      notTo: notTo || null,
      since: since || null,
      until: until || null,
      totalIssues: issues.length,
      users: top,
    };
    cacheSet(cacheKey, payload, ttl);
    return sendJSON(res, 200, payload);
  } catch (err) {
    return sendJSON(res, 500, { error: String(err && err.message || err) });
  }
}

loadEnv();

// Sanitize env strings and strip quotes/whitespace
function cleanEnv(v) {
  if (v == null) return '';
  let s = String(v).trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1);
  }
  return s.trim();
}

const PORT = Number(cleanEnv(process.env.PORT) || 5173);
const REFRESH_SECONDS = Number(cleanEnv(process.env.REFRESH_SECONDS) || 60);

let JIRA_BASE_URL = cleanEnv(process.env.JIRA_BASE_URL);
const JIRA_EMAIL = cleanEnv(process.env.JIRA_EMAIL);
const JIRA_API_TOKEN = cleanEnv(process.env.JIRA_API_TOKEN);
const JIRA_FILTER_QA_ID = cleanEnv(process.env.JIRA_FILTER_QA_ID);
const JIRA_FILTER_DEV_ID = cleanEnv(process.env.JIRA_FILTER_DEV_ID);
// Optional JQLs/filters for "worked today" counts
const JIRA_DEV_TODAY = cleanEnv(process.env.JIRA_DEV_TODAY);
const JIRA_QA_TODAY = cleanEnv(process.env.JIRA_QA_TODAY);
// Optional: Pre-bugbash baseline filters
const JIRA_PRE_DEV = cleanEnv(process.env.JIRA_PRE_DEV);
const JIRA_PRE_QA = cleanEnv(process.env.JIRA_PRE_QA);
// Optional filter/JQL for Deployment Ready set
const JIRA_DEPLOYMENTREADY = cleanEnv(process.env.JIRA_DEPLOYMENTREADY);

const INITIAL_QA = Number(cleanEnv(process.env.INITIAL_QA) || 33);
const INITIAL_DEV = Number(cleanEnv(process.env.INITIAL_DEV) || 71);

// Ensure base URL includes scheme; default to https
if (JIRA_BASE_URL && !/^https?:\/\//i.test(JIRA_BASE_URL)) {
  JIRA_BASE_URL = 'https://' + JIRA_BASE_URL;
}

function toJql(filterOrJql) {
  const raw = cleanEnv(filterOrJql);
  if (!raw) return '';
  // If numeric, use filter=ID so Jira evaluates the filter server-side.
  if (/^\d+$/.test(raw)) return `filter=${raw}`;
  // If looks like full URL, try to extract ?filter= or ?jql=
  if (/^https?:\/\//i.test(raw)) {
    try {
      const u = new URL(raw);
      const filterId = u.searchParams.get('filter');
      if (filterId && /^\d+$/.test(filterId)) return `filter=${filterId}`;
      const jql = u.searchParams.get('jql');
      if (jql) return jql;
    } catch (_) { /* ignore */ }
  }
  // Otherwise assume it's a JQL string
  return raw;
}

function buildFilterInfo(label, filterOrJql) {
  const base = (JIRA_BASE_URL || '').replace(/\/$/, '');
  const jqlOrFilter = toJql(filterOrJql);
  let url = '';
  let text = '';
  if (!base || !jqlOrFilter) {
    return { label, url: '', text: '' };
  }
  if (jqlOrFilter.startsWith('filter=')) {
    const id = jqlOrFilter.slice('filter='.length);
    url = `${base}/issues/?filter=${encodeURIComponent(id)}`;
    text = `Filter ${id}`;
  } else {
    url = `${base}/issues/?jql=${encodeURIComponent(jqlOrFilter)}`;
    text = `JQL (${jqlOrFilter.slice(0, 80)}${jqlOrFilter.length > 80 ? '…' : ''})`;
  }
  return { label, url, text };
}

function sendJSON(res, statusCode, body) {
  const json = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
  });
  res.end(json);
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

function staticFile(filePath, res) {
  const abs = path.join(__dirname, 'public', filePath);
  if (!abs.startsWith(path.join(__dirname, 'public'))) {
    return sendText(res, 403, 'Forbidden');
  }
  fs.readFile(abs, (err, data) => {
    if (err) {
      return sendText(res, 404, 'Not found');
    }
    const ext = path.extname(abs).toLowerCase();
    const type =
      ext === '.html' ? 'text/html; charset=utf-8' :
      ext === '.js' ? 'text/javascript; charset=utf-8' :
      ext === '.css' ? 'text/css; charset=utf-8' :
      'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type });
    res.end(data);
  });
}

function fetchJSON(url, options) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const isHttps = u.protocol === 'https:';
    const lib = isHttps ? https : http;
    const req = lib.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search,
      method: options?.method || 'GET',
      headers: options?.headers || {},
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(data || '{}'));
          } catch (e) {
            reject(new Error('Failed to parse JSON: ' + e.message));
          }
        } else {
          reject(new Error('HTTP ' + res.statusCode + ': ' + data));
        }
      });
    });
    req.on('error', reject);
    if (options?.body) req.write(options.body);
    req.end();
  });
}

async function fetchFilterCount(filterOrJql) {
  if (!JIRA_BASE_URL || !JIRA_EMAIL || !JIRA_API_TOKEN || !filterOrJql) {
    throw new Error('Missing Jira config or filter/JQL');
  }
  const base = JIRA_BASE_URL.replace(/\/$/, '');
  const auth = Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString('base64');
  const headers = {
    'Authorization': `Basic ${auth}`,
    'Accept': 'application/json',
    'User-Agent': 'jira-leaderboard-webview/1.4',
  };
  const jql = toJql(filterOrJql);
  if (!jql) throw new Error('Empty JQL');
  const jqlParam = encodeURIComponent(jql);
  const urlV3 = `${base}/rest/api/3/search?jql=${jqlParam}&maxResults=0`;
  try {
    const json = await fetchJSON(urlV3, { headers });
    if (typeof json.total === 'number') return json.total;
    throw new Error('Unexpected Jira response (no total)');
  } catch (e) {
    const urlV2 = `${base}/rest/api/2/search?jql=${jqlParam}&maxResults=0`;
    const json2 = await fetchJSON(urlV2, { headers });
    if (typeof json2.total === 'number') return json2.total;
    throw new Error('Unexpected Jira v2 response (no total)');
  }
}

async function handleCounts(_req, res) {
  try {
    const tasks = [
      fetchFilterCount(JIRA_FILTER_QA_ID),
      fetchFilterCount(JIRA_FILTER_DEV_ID),
    ];
    // Optionally compute "worked today" if configured
    if (JIRA_DEV_TODAY) tasks.push(fetchFilterCount(JIRA_DEV_TODAY));
    if (JIRA_QA_TODAY) tasks.push(fetchFilterCount(JIRA_QA_TODAY));
    // Optionally compute pre-bugbash baselines
    if (JIRA_PRE_DEV) tasks.push(fetchFilterCount(JIRA_PRE_DEV));
    if (JIRA_PRE_QA) tasks.push(fetchFilterCount(JIRA_PRE_QA));
    // Optionally compute deployment ready count
    const includeDeploy = !!JIRA_DEPLOYMENTREADY;
    if (includeDeploy) tasks.push(fetchFilterCount(JIRA_DEPLOYMENTREADY));

    const results = await Promise.all(tasks);
    const qa = results[0];
    const dev = results[1];
    let idx = 2;
    const devToday = JIRA_DEV_TODAY ? results[idx++] : undefined;
    const qaToday = JIRA_QA_TODAY ? results[idx++] : undefined;
    const preDev = JIRA_PRE_DEV ? results[idx++] : undefined;
    const preQa = JIRA_PRE_QA ? results[idx++] : undefined;
    const deploymentReady = includeDeploy ? results[idx++] : undefined;
    sendJSON(res, 200, {
      qa,
      dev,
      devToday: typeof devToday === 'number' ? devToday : undefined,
      qaToday: typeof qaToday === 'number' ? qaToday : undefined,
      preDev: typeof preDev === 'number' ? preDev : undefined,
      preQa: typeof preQa === 'number' ? preQa : undefined,
      deploymentReady: typeof deploymentReady === 'number' ? deploymentReady : undefined,
      initialQa: INITIAL_QA,
      initialDev: INITIAL_DEV,
      refreshSeconds: REFRESH_SECONDS,
    });
  } catch (err) {
    console.error('Error /api/counts:', err);
    sendJSON(res, 200, { qa: 0, dev: 0, initialQa: INITIAL_QA, initialDev: INITIAL_DEV, refreshSeconds: REFRESH_SECONDS, error: String(err && err.message || err) });
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === '/') return staticFile('index.html', res);
  if (url.pathname === '/script.js') return staticFile('script.js', res);
  if (url.pathname === '/styles.css') return staticFile('styles.css', res);
  if (url.pathname === '/api/counts') return handleCounts(req, res);
  if (url.pathname === '/api/movers') return handleMovers(req, res);
  if (url.pathname === '/api/filters') {
    const payload = {
      baseUrl: (JIRA_BASE_URL || '').replace(/\/$/, ''),
      qa: buildFilterInfo('QA', JIRA_FILTER_QA_ID),
      dev: buildFilterInfo('Dev', JIRA_FILTER_DEV_ID),
      preDev: buildFilterInfo('Pre Dev', JIRA_PRE_DEV),
      preQa: buildFilterInfo('Pre QA', JIRA_PRE_QA),
      devToday: buildFilterInfo('Dev Today', JIRA_DEV_TODAY),
      qaToday: buildFilterInfo('QA Today', JIRA_QA_TODAY),
      deploymentReady: buildFilterInfo('Deployment Ready', JIRA_DEPLOYMENTREADY),
    };
    return sendJSON(res, 200, payload);
  }
  return sendText(res, 404, 'Not found');
});

server.listen(PORT, () => {
  console.log(`Leaderboard webview listening on http://localhost:${PORT}`);
});
