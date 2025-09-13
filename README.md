# Jira Leaderboard (Bug‑Bash)

A tiny Node server that serves a stylish leaderboard UI and securely proxies Jira Search API requests from the server side.

- Server: `server.js` (no external deps)
- Frontend: static files in `public/`
- Config: `.env` (not committed)

## Features

- Displays counts from Jira using filters/JQL
- “Closed Today” and “Deployment Ready” (optional) metrics
- Stylish UI, lead highlight, KPI badges, countdown widget
- Dark mode + manual toggle

## Quick Start (Local)

1. Create `.env` alongside `server.js` (do not commit this):
   ```env
   JIRA_BASE_URL=https://your-domain.atlassian.net
   JIRA_EMAIL=you@example.com
   JIRA_API_TOKEN=your_api_token
   
   # Required filters/JQL (either numeric filter ID or raw JQL)
   JIRA_FILTER_QA_ID=14621
   JIRA_FILTER_DEV_ID=10930
   
   # Optional extras
   JIRA_QA_TODAY=
   JIRA_DEV_TODAY=
   JIRA_DEPLOYMENTREADY=

   # App
   PORT=5173
   REFRESH_SECONDS=60
   ```
2. Run the server:
   ```bash
   node server.js
   ```
3. Open the app: http://localhost:5173

## Docker

Build and run with Docker:

```bash
# Build
docker build -t jira-leaderboard:latest .

# Run (replace env values)
docker run -d -p 5173:5173 \
  -e PORT=5173 \
  -e JIRA_BASE_URL="https://your-domain.atlassian.net" \
  -e JIRA_EMAIL="you@example.com" \
  -e JIRA_API_TOKEN="<token>" \
  -e JIRA_FILTER_QA_ID="14621" \
  -e JIRA_FILTER_DEV_ID="10930" \
  -e JIRA_QA_TODAY="" \
  -e JIRA_DEV_TODAY="" \
  -e JIRA_DEPLOYMENTREADY="" \
  jira-leaderboard:latest
```

## Deploy Targets (Suggestions)

- Render/Railway: create a Node web service with start command `node server.js` and set env vars.
- Heroku: add `Procfile` with `web: node server.js` and set config vars.
- Any VM: use Docker (above) or run Node directly.

## Security Tips

- Keep `.env` private; never commit secrets.
- Jira API token should be a dedicated bot/service token with least privileges needed to read issues/filters.

## GitHub

This repo is ready to push. Use the commands below (replace `YOUR_REPO_URL`).

```bash
# from the leaderboard/ directory
git init
git add .
git commit -m "feat: initial leaderboard with Jira proxy"
# set the default branch
git branch -M main
# add remote and push
git remote add origin YOUR_REPO_URL
git push -u origin main
```

If you prefer using GitHub CLI to create a new repo, run:
```bash
gh repo create your-org/leaderboard --public --source . --remote origin --push
```

