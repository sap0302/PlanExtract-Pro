#!/usr/bin/env bash
# Pulls the latest main from GitHub into the live install, rebuilds both apps
# and restarts the systemd services. Safe to re-run; .env files, the SQLite
# database, node_modules and .next are never touched by git.
#
#   bash /opt/PlanExtract-Pro/PlanExtract-Pro/deploy/bluehost/update.sh
#
set -euo pipefail

APP_ROOT="${APP_ROOT:-/opt/PlanExtract-Pro/PlanExtract-Pro}"
REPO_URL="${REPO_URL:-https://github.com/sap0302/PlanExtract-Pro.git}"
BRANCH="${BRANCH:-main}"
STAMP="$(date +%Y%m%d-%H%M%S)"

log() { printf '\n==> %s\n' "$*"; }

if ! command -v git >/dev/null 2>&1; then
  log "Installing git"
  apt-get update -qq && apt-get install -y -qq git
fi

cd "$APP_ROOT"

log "Backing up database"
mkdir -p /opt/backups
for db in prisma/*.db; do
  [ -f "$db" ] && cp "$db" "/opt/backups/$(basename "$db" .db)-$STAMP.db"
done

if [ ! -d .git ]; then
  log "First run: attaching this folder to the GitHub repo"
  git init -q
  git remote add origin "$REPO_URL"
fi

log "Fetching $BRANCH"
git fetch --depth=1 origin "$BRANCH"
# Tracked files are replaced with the GitHub version. Untracked server-only
# files (.env, *.db, node_modules, .next) are left alone.
git reset -q --hard FETCH_HEAD
git log -1 --format='Now at %h  %s'

log "Building product app"
npm ci --no-audit --no-fund
npx prisma generate
npx prisma db push
npm run build

log "Building admin app"
( cd admin && npm ci --no-audit --no-fund && npm run build )

log "Restarting services"
systemctl restart planextract planextract-admin
sleep 3
systemctl is-active planextract planextract-admin caddy

curl -s -o /dev/null -w "product  %{http_code}\n" http://127.0.0.1:3000/login
curl -s -o /dev/null -w "admin    %{http_code}\n" http://127.0.0.1:3100/login

log "Done. Database backups in /opt/backups (stamp $STAMP)"
