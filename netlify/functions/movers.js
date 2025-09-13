// Netlify Function: /api/movers
// Aggregates per-user transitions from one status to another over a set of issues defined by a filter/JQL.
// Query params:
//   filter  = filter id | full filter URL | raw JQL   (required)
//   from    = source status name (optional; defaults to ANY)
//   to      = target status name (optional; defaults to Done)
//   since   = ISO datetime to bound transition time (optional)
//   until   = ISO datetime upper bound (optional)
//   limit   = max number of users in response (default 20)
//
// Env required (same as other functions):
//   JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN

const https = require('https');
const http = require('http');

function cleanEnv(v) {
  if (v == null) return '';
  let s = String(v).trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1);
  }
  return s.trim();
}

// Simple in-memory cache (per lambda instance) with TTL
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

async function discoverTransitionPairs(issues, since, until) {
  const pairs = new Map(); // key: `${from}→${to}` => count
  for (const issue of issues) {
    let startAt = 0;
    let total = 0;
    do {
      const log = await fetchChangelog(issue.id, startAt, 100);
      total = log.total || 0;
      const histories = Array.isArray(log.values) ? log.values : [];
      for (const h of histories) {
        const created = h.created;
        if (since || until) {
          if (!withinWindow(created, since, until)) continue;
        }
        const items = Array.isArray(h.items) ? h.items : [];
        for (const it of items) {
          if (it.field !== 'status') continue;
          const from = (it.fromString || '').trim();
          const to = (it.toString || '').trim();
          const key = `${from}→${to}`;
          pairs.set(key, (pairs.get(key) || 0) + 1);
        }
      }
      startAt += histories.length;
      if (histories.length === 0) break;
    } while (startAt < total);
  }
  const arr = Array.from(pairs.entries()).map(([pair, count]) => {
    const [from, to] = pair.split('→');
    return { from, to, count };
  });
  arr.sort((a,b) => b.count - a.count || `${a.from}→${a.to}`.localeCompare(`${b.from}→${b.to}`));
  return arr;
}

let JIRA_BASE_URL = cleanEnv(process.env.JIRA_BASE_URL);
const JIRA_EMAIL = cleanEnv(process.env.JIRA_EMAIL);
const JIRA_API_TOKEN = cleanEnv(process.env.JIRA_API_TOKEN);

if (JIRA_BASE_URL && !/^https?:\/\//i.test(JIRA_BASE_URL)) {
  JIRA_BASE_URL = 'https://' + JIRA_BASE_URL;
}

function toJql(filterOrJql) {
  const raw = cleanEnv(filterOrJql);
  if (!raw) return '';
  if (/^\d+$/.test(raw)) return `filter=${raw}`;
  if (/^https?:\/\//i.test(raw)) {
    try {
      const u = new URL(raw);
      const filterId = u.searchParams.get('filter');
      if (filterId && /^\d+$/.test(filterId)) return `filter=${filterId}`;
      const jql = u.searchParams.get('jql');
      if (jql) return jql;
    } catch (_) {}
  }
  return raw;
}

function fetchJSON(url, options) {
  return new Promise((resolve, reject) => {
    try {
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
            try { resolve(JSON.parse(data || '{}')); }
            catch (e) { reject(new Error('Failed to parse JSON: ' + e.message)); }
          } else {
            reject(new Error('HTTP ' + res.statusCode + ': ' + data));
          }
        });
      });
      req.on('error', reject);
      if (options?.body) req.write(options.body);
      req.end();
    } catch (e) {
      reject(e);
    }
  });
}

function getAuthHeaders() {
  if (!JIRA_BASE_URL || !JIRA_EMAIL || !JIRA_API_TOKEN) {
    throw new Error('Missing Jira configuration (JIRA_BASE_URL/JIRA_EMAIL/JIRA_API_TOKEN)');
  }
  const auth = Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString('base64');
  return {
    'Authorization': `Basic ${auth}`,
    'Accept': 'application/json',
    'User-Agent': 'jira-leaderboard-movers/1.0',
  };
}

async function searchIssues(jql, max=200) {
  const base = JIRA_BASE_URL.replace(/\/$/, '');
  const headers = getAuthHeaders();
  const jqlParam = encodeURIComponent(jql);
  const fields = encodeURIComponent('key');
  // We only need keys here; changelog fetched per-issue
  const url = `${base}/rest/api/3/search?jql=${jqlParam}&maxResults=${Math.min(max,1000)}&fields=${fields}`;
  const res = await fetchJSON(url, { headers });
  const issues = Array.isArray(res.issues) ? res.issues : [];
  return issues.map(it => ({ key: it.key, id: it.id }));
}

async function fetchChangelog(issueId, startAt=0, maxResults=100) {
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

  // Concurrency-limited worker pool
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
          const fromOk = (!fromName || from.toLowerCase() === fromName.toLowerCase()) && (!notFromName || from.toLowerCase() !== notFromName.toLowerCase());
          const toOk = (!toName || to.toLowerCase() === toName.toLowerCase()) && (!notToName || to.toLowerCase() !== notToName.toLowerCase());
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
  arr.sort((a,b) => b.count - a.count || a.user.localeCompare(b.user));
  return arr;
}

exports.handler = async (event) => {
  try {
    const params = new URLSearchParams(event.queryStringParameters || {});
    const filter = params.get('filter');
    const from = params.get('from'); // e.g., "In QA"
    const to = params.get('to');
    const notFrom = params.get('notFrom');
    const notTo = params.get('notTo');
    const since = params.get('since');
    const until = params.get('until');
    const limit = Math.min(parseInt(params.get('limit') || '20', 10) || 20, 100);
    const maxIssues = Math.min(parseInt(params.get('maxIssues') || '150', 10) || 150, 1000);
    const concurrencyParam = Math.min(parseInt(params.get('concurrency') || '0', 10) || 0, 20);
    const ttl = Math.min(parseInt(params.get('ttl') || '60', 10) || 60, 600) * 1000; // default 60s
    const discover = params.get('discover') === '1';

    if (!filter) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing required query param: filter' }) };
    }
    const jqlOrFilter = toJql(filter);
    if (!jqlOrFilter) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid filter/JQL' }) };
    }

    // Build JQL: if it's filter=NN, Jira will handle it; if it's JQL, we use it as-is.
    const jql = jqlOrFilter.startsWith('filter=') ? jqlOrFilter : jqlOrFilter;

    const cacheKey = JSON.stringify({ jql, from, to, notFrom, notTo, since, until, limit, maxIssues, concurrencyParam });
    const cached = cacheGet(cacheKey);
    if (cached) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Cache': 'HIT' },
        body: JSON.stringify(cached),
      };
    }

    const issues = await searchIssues(jql, maxIssues);

    if (discover) {
      const pairs = await discoverTransitionPairs(issues, since, until);
      const topPairs = pairs.slice(0, Math.min(limit, 100));
      const payload = {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ filter, since: since || null, until: until || null, totalIssues: issues.length, transitions: topPairs }),
      };
      cacheSet(cacheKey, JSON.parse(payload.body), ttl);
      return payload;
    }

    const results = await countTransitionsByUser(issues, from, to, since, until, notFrom, notTo);
    const top = results.slice(0, limit);
    const payload = {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        filter,
        from: from || null,
        to: to || null,
        notFrom: notFrom || null,
        notTo: notTo || null,
        since: since || null,
        until: until || null,
        totalIssues: issues.length,
        users: top,
      }),
    };
    cacheSet(cacheKey, JSON.parse(payload.body), ttl);
    return payload;
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: String(err && err.message || err) }) };
  }
};
