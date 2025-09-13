// Netlify Function: /api/counts
// Mirrors the logic from server.js but as a serverless function.

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

let JIRA_BASE_URL = cleanEnv(process.env.JIRA_BASE_URL);
const JIRA_EMAIL = cleanEnv(process.env.JIRA_EMAIL);
const JIRA_API_TOKEN = cleanEnv(process.env.JIRA_API_TOKEN);
const JIRA_FILTER_QA_ID = cleanEnv(process.env.JIRA_FILTER_QA_ID);
const JIRA_FILTER_DEV_ID = cleanEnv(process.env.JIRA_FILTER_DEV_ID);
const JIRA_DEV_TODAY = cleanEnv(process.env.JIRA_DEV_TODAY);
const JIRA_QA_TODAY = cleanEnv(process.env.JIRA_QA_TODAY);
const JIRA_DEPLOYMENTREADY = cleanEnv(process.env.JIRA_DEPLOYMENTREADY);
const REFRESH_SECONDS = Number(cleanEnv(process.env.REFRESH_SECONDS) || 60);

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
    'User-Agent': 'jira-leaderboard-netlify/1.0',
  };
  const jql = toJql(filterOrJql);
  if (!jql) throw new Error('Empty JQL');
  const jqlParam = encodeURIComponent(jql);
  const urlV3 = `${base}/rest/api/3/search?jql=${jqlParam}&maxResults=0`;
  try {
    const json = await fetchJSON(urlV3, { headers });
    if (typeof json.total === 'number') return json.total;
    throw new Error('Unexpected Jira response (no total)');
  } catch (_) {
    const urlV2 = `${base}/rest/api/2/search?jql=${jqlParam}&maxResults=0`;
    const json2 = await fetchJSON(urlV2, { headers });
    if (typeof json2.total === 'number') return json2.total;
    throw new Error('Unexpected Jira v2 response (no total)');
  }
}

exports.handler = async () => {
  try {
    const tasks = [
      fetchFilterCount(JIRA_FILTER_QA_ID),
      fetchFilterCount(JIRA_FILTER_DEV_ID),
    ];
    if (JIRA_DEV_TODAY) tasks.push(fetchFilterCount(JIRA_DEV_TODAY));
    if (JIRA_QA_TODAY) tasks.push(fetchFilterCount(JIRA_QA_TODAY));
    const includeDeploy = !!JIRA_DEPLOYMENTREADY;
    if (includeDeploy) tasks.push(fetchFilterCount(JIRA_DEPLOYMENTREADY));

    const results = await Promise.all(tasks);
    const qa = results[0];
    const dev = results[1];
    let idx = 2;
    const devToday = JIRA_DEV_TODAY ? results[idx++] : undefined;
    const qaToday = JIRA_QA_TODAY ? results[idx++] : undefined;
    const deploymentReady = includeDeploy ? results[idx++] : undefined;

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ qa, dev, devToday, qaToday, deploymentReady, refreshSeconds: REFRESH_SECONDS }),
    };
  } catch (err) {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ qa: 0, dev: 0, refreshSeconds: REFRESH_SECONDS, error: String(err && err.message || err) }),
    };
  }
};
