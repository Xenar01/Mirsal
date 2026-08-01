#!/usr/bin/env bash
# Mirsal fresh-server deploy — step 4/5: nginx vhost + Let's Encrypt cert.
#
# Renders the http vhost template for your domain, enables it, then runs
# `certbot --nginx --redirect`, which obtains the certificate over port 80 and
# rewrites the vhost to add the 443 server + an http->https redirect. certbot
# installs its own auto-renewal timer.
#
# PREREQUISITE: your domain's DNS A/AAAA record must already point at this VPS
# (certbot validates over http-01 on port 80). Check: dig +short <domain>
#
# Usage:  sudo bash deploy/fresh/04-nginx-tls.sh <domain> <email>
#   e.g.  sudo bash deploy/fresh/04-nginx-tls.sh files.example.com you@example.com
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "This script needs root. Re-run with: sudo bash $0 <domain> <email>" >&2
  exit 1
fi

cd "$(dirname "$0")/../.."   # repo root
DOMAIN="${1:-}"
EMAIL="${2:-}"
if [[ -z "$DOMAIN" || -z "$EMAIL" ]]; then
  echo "Usage: sudo bash deploy/fresh/04-nginx-tls.sh <domain> <email>" >&2
  exit 2
fi

TEMPLATE="deploy/fresh/mirsal-http.conf.template"
AVAIL="/etc/nginx/sites-available/mirsal"
ENABLED="/etc/nginx/sites-enabled/mirsal"

command -v nginx  >/dev/null 2>&1 || { echo "nginx not installed — run 01-bootstrap-host.sh" >&2; exit 1; }
command -v certbot >/dev/null 2>&1 || { echo "certbot not installed — run 01-bootstrap-host.sh" >&2; exit 1; }
[[ -f "$TEMPLATE" ]] || { echo "Missing $TEMPLATE" >&2; exit 1; }

# Sanity: app must be up on loopback so the proxy has an upstream.
curl -fsS http://127.0.0.1:8084/api/health >/dev/null 2>&1 \
  || { echo "App not answering on 127.0.0.1:8084 — run 03-build-run.sh first." >&2; exit 1; }

# Soft DNS check (warn, don't block — split-horizon/proxied setups vary).
RESOLVED="$(getent hosts "$DOMAIN" | awk '{print $1}' | head -1 || true)"
[[ -n "$RESOLVED" ]] || echo "WARNING: $DOMAIN does not resolve yet. certbot will fail until DNS points here."

echo "==> Installing http vhost for ${DOMAIN}"
sed "s/__DOMAIN__/${DOMAIN}/g" "$TEMPLATE" > "$AVAIL"
ln -sfn "$AVAIL" "$ENABLED"
# Disable the stock default site if it's grabbing the port (harmless if absent).
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

echo "==> Requesting certificate + enabling HTTPS (certbot --nginx --redirect)"
certbot --nginx -d "$DOMAIN" --redirect --non-interactive --agree-tos -m "$EMAIL"

nginx -t && systemctl reload nginx

echo
echo "==> Verifying the live chain"
printf 'https health -> ' ; curl -sk  "https://${DOMAIN}/api/health" -o /dev/null -w '%{http_code}\n' || true
printf 'http redirect -> '; curl -skI "http://${DOMAIN}/api/health"  -o /dev/null -w '%{http_code}\n' || true

cat <<EOF

==============================================================================
HTTPS is live at: https://${DOMAIN}
  - certbot installed an auto-renew timer (check: systemctl list-timers | grep certbot)
  - rollback the public route: rm ${ENABLED} && systemctl reload nginx

Next: sudo bash deploy/fresh/05-backup-cron.sh
==============================================================================
EOF
