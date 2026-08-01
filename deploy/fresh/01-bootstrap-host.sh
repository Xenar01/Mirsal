#!/usr/bin/env bash
# Mirsal fresh-server deploy — step 1/5: install host prerequisites.
#
# Installs Docker Engine + compose plugin, nginx, and certbot (nginx plugin) on
# a fresh Ubuntu 22.04/24.04 box. Idempotent — safe to re-run. Configures a UFW
# ruleset but does NOT enable the firewall (enabling it over SSH can lock you
# out); it prints the exact commands for you to run deliberately.
#
# Usage:  sudo bash deploy/fresh/01-bootstrap-host.sh
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "This script needs root. Re-run with: sudo bash $0" >&2
  exit 1
fi

echo "==> Updating apt and installing base packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl gnupg git ufw

# --- Docker Engine + compose plugin -----------------------------------------
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  echo "==> Docker + compose already present ($(docker --version))"
else
  echo "==> Installing Docker Engine (official convenience script)"
  curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
  sh /tmp/get-docker.sh
  rm -f /tmp/get-docker.sh
  systemctl enable --now docker
fi

# --- nginx -------------------------------------------------------------------
if command -v nginx >/dev/null 2>&1; then
  echo "==> nginx already present ($(nginx -v 2>&1))"
else
  echo "==> Installing nginx"
  apt-get install -y nginx
fi
systemctl enable --now nginx

# --- certbot (nginx plugin) --------------------------------------------------
if command -v certbot >/dev/null 2>&1; then
  echo "==> certbot already present ($(certbot --version 2>&1))"
else
  echo "==> Installing certbot + nginx plugin"
  apt-get install -y certbot python3-certbot-nginx
fi

# --- UFW ruleset (configured, NOT enabled) -----------------------------------
# Detect the current SSH port so we don't lock ourselves out if it's non-default.
SSH_PORT="$(ss -tlnp 2>/dev/null | awk '/sshd/{split($4,a,":"); print a[length(a)]}' | sort -u | head -1)"
SSH_PORT="${SSH_PORT:-22}"
echo "==> Preparing UFW rules (detected SSH port: ${SSH_PORT}) — NOT enabling the firewall"
ufw allow "${SSH_PORT}/tcp"   >/dev/null 2>&1 || true
ufw allow 'Nginx Full'        >/dev/null 2>&1 || true   # 80 + 443

cat <<EOF

==============================================================================
Host bootstrap complete.
  docker:  $(docker --version 2>/dev/null)
  compose: $(docker compose version 2>/dev/null | head -1)
  nginx:   $(nginx -v 2>&1)
  certbot: $(certbot --version 2>&1)

The firewall is configured but DISABLED. After you've confirmed SSH still works,
enable it deliberately (SSH port ${SSH_PORT} and nginx are already allowed):

    sudo ufw enable
    sudo ufw status verbose

Next: sudo bash deploy/fresh/02-make-env.sh <your-domain>
==============================================================================
EOF
