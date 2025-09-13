# Simple container for the Jira Leaderboard webview
# Build:   docker build -t jira-leaderboard:latest .
# Run:     docker run -p 5173:5173 \
#            -e PORT=5173 \
#            -e JIRA_BASE_URL="https://your-domain.atlassian.net" \
#            -e JIRA_EMAIL="you@example.com" \
#            -e JIRA_API_TOKEN="<token>" \
#            -e JIRA_FILTER_QA_ID="14621" \
#            -e JIRA_FILTER_DEV_ID="10930" \
#            -e JIRA_QA_TODAY="" \
#            -e JIRA_DEV_TODAY="" \
#            -e JIRA_DEPLOYMENTREADY="" \
#            jira-leaderboard:latest

FROM node:18-alpine AS base
WORKDIR /app

# Copy only what's needed (static + server)
COPY public ./public
COPY server.js ./server.js

# Optional: copy package.json if present
COPY package*.json ./

# No dependencies to install (using core Node APIs only)

ENV NODE_ENV=production
EXPOSE 5173
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s CMD wget -qO- http://localhost:${PORT:-5173}/ || exit 1

CMD ["node", "server.js"]
