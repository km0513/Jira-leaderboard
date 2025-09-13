// Netlify Function: /api/filters
// Builds filter URLs from env (no Jira call), mirroring buildFilterInfo from server.js

function cleanEnv(v) {
  if (v == null) return '';
  let s = String(v).trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1);
  }
  return s.trim();
}

let JIRA_BASE_URL = cleanEnv(process.env.JIRA_BASE_URL);
const JIRA_FILTER_QA_ID = cleanEnv(process.env.JIRA_FILTER_QA_ID);
const JIRA_FILTER_DEV_ID = cleanEnv(process.env.JIRA_FILTER_DEV_ID);
const JIRA_DEV_TODAY = cleanEnv(process.env.JIRA_DEV_TODAY);
const JIRA_QA_TODAY = cleanEnv(process.env.JIRA_QA_TODAY);
const JIRA_DEPLOYMENTREADY = cleanEnv(process.env.JIRA_DEPLOYMENTREADY);

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

function buildFilterInfo(label, filterOrJql) {
  const base = (JIRA_BASE_URL || '').replace(/\/$/, '');
  const jqlOrFilter = toJql(filterOrJql);
  let url = '';
  let text = '';
  if (!base || !jqlOrFilter) return { label, url: '', text: '' };
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

exports.handler = async () => {
  const payload = {
    baseUrl: (JIRA_BASE_URL || '').replace(/\/$/, ''),
    qa: buildFilterInfo('QA', JIRA_FILTER_QA_ID),
    dev: buildFilterInfo('Dev', JIRA_FILTER_DEV_ID),
    devToday: buildFilterInfo('Dev Today', JIRA_DEV_TODAY),
    qaToday: buildFilterInfo('QA Today', JIRA_QA_TODAY),
    deploymentReady: buildFilterInfo('Deployment Ready', JIRA_DEPLOYMENTREADY),
  };
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(payload),
  };
};
