#!/bin/bash
# ============================================================================
#  Blockway VPS Setup Script
#  Run as root on Ubuntu 22.04 / 24.04
#  Usage: bash setup-vps.sh daddyproxy.com /home/devnigga/blockway
# ============================================================================
set -e

ROOT_DOMAIN="${1:-daddyproxy.com}"
APP_DIR="${2:-/home/devnigga/blockway}"
APP_USER="${3:-devnigga}"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
info()  { echo -e "${GREEN}[INFO]${NC} $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

[[ $EUID -ne 0 ]] && error "Run as root: sudo bash setup-vps.sh"
[[ -z "$ROOT_DOMAIN" ]] && error "Usage: bash setup-vps.sh <domain> <app_dir>"

info "Setting up Blockway proxy for domain: $ROOT_DOMAIN"
info "App directory: $APP_DIR"

# ── 1. Install dependencies ──────────────────────────────────────────────────
info "Installing Nginx and Certbot..."
apt-get update -qq
apt-get install -y nginx certbot python3-certbot-nginx curl

# ── 2. Create snippet directories ────────────────────────────────────────────
info "Installing Nginx snippets..."
mkdir -p /etc/nginx/snippets

cat > /etc/nginx/snippets/ssl-params.conf << 'SSL'
ssl_protocols TLSv1.2 TLSv1.3;
ssl_prefer_server_ciphers on;
ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305:DHE-RSA-AES128-GCM-SHA256;
ssl_session_cache   shared:SSL:10m;
ssl_session_timeout 1d;
ssl_session_tickets off;
ssl_stapling        on;
ssl_stapling_verify on;
resolver 1.1.1.1 8.8.8.8 valid=300s;
resolver_timeout 5s;
add_header Strict-Transport-Security "max-age=63072000; includeSubDomains" always;
SSL

cat > /etc/nginx/snippets/proxy-params.conf << 'PROXY'
proxy_http_version 1.1;
proxy_set_header Upgrade           $http_upgrade;
proxy_set_header Connection        "upgrade";
proxy_set_header Host              $host;
proxy_set_header X-Real-IP         $remote_addr;
proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header X-Forwarded-Host  $host;
proxy_set_header X-Forwarded-Port  $server_port;
proxy_cache_bypass $http_upgrade;
proxy_buffering         off;
proxy_request_buffering off;
PROXY

info "Snippets created at /etc/nginx/snippets/"

# ── 3. Install Nginx site config ─────────────────────────────────────────────
info "Installing Nginx site config..."
NGINX_CONF="/etc/nginx/sites-available/blockway"

# Write the config with actual domain substituted
sed "s/daddyproxy\.com/$ROOT_DOMAIN/g" "$APP_DIR/nginx/blockway" > "$NGINX_CONF"

# Enable the site
ln -sf "$NGINX_CONF" /etc/nginx/sites-enabled/blockway

# Disable default site if it exists
[[ -f /etc/nginx/sites-enabled/default ]] && rm -f /etc/nginx/sites-enabled/default

# Test config
nginx -t || error "Nginx config test failed. Check $NGINX_CONF"
systemctl reload nginx
info "Nginx configured and reloaded."

# ── 4. Set up env file ───────────────────────────────────────────────────────
info "Setting up environment..."
ENV_FILE="$APP_DIR/.env.local"
if [[ ! -f "$ENV_FILE" ]]; then
    cp "$APP_DIR/.env.local.example" "$ENV_FILE" 2>/dev/null || true
fi

if grep -q "PROXY_ROOT_DOMAIN" "$ENV_FILE" 2>/dev/null; then
    sed -i "s/^PROXY_ROOT_DOMAIN=.*/PROXY_ROOT_DOMAIN=$ROOT_DOMAIN/" "$ENV_FILE"
else
    echo "PROXY_ROOT_DOMAIN=$ROOT_DOMAIN" >> "$ENV_FILE"
fi
info "Set PROXY_ROOT_DOMAIN=$ROOT_DOMAIN in $ENV_FILE"

# ── 5. Install/verify PM2 ────────────────────────────────────────────────────
if ! command -v pm2 &> /dev/null; then
    info "Installing PM2..."
    npm install -g pm2
fi

# ── 6. Build and start the app ───────────────────────────────────────────────
info "Building Next.js app..."
cd "$APP_DIR"
sudo -u "$APP_USER" npm run build

info "Starting/restarting app with PM2..."
sudo -u "$APP_USER" pm2 stop blockway 2>/dev/null || true
sudo -u "$APP_USER" pm2 delete blockway 2>/dev/null || true
sudo -u "$APP_USER" pm2 start npm --name blockway -- start
sudo -u "$APP_USER" pm2 save
pm2 startup systemd -u "$APP_USER" --hp "/home/$APP_USER" | bash 2>/dev/null || true

info "App running on port 3000."

# ── 7. SSL certificate ───────────────────────────────────────────────────────
echo ""
warn "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
warn "SSL CERTIFICATE SETUP — Choose ONE option:"
warn "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "OPTION A — Cloudflare SSL (EASIEST — recommended if using Cloudflare proxy):"
echo "  1. In Cloudflare: SSL/TLS → set to 'Full' (not Full Strict)"
echo "  2. Cloudflare handles the browser cert; Nginx uses HTTP internally"
echo "  3. Change listen lines in /etc/nginx/sites-available/blockway to port 80 only"
echo ""
echo "OPTION B — Let's Encrypt wildcard cert (if Cloudflare is DNS-only, orange=off):"
echo "  You need a Cloudflare API token. Create one at:"
echo "  https://dash.cloudflare.com/profile/api-tokens"
echo "  Permission: Zone > DNS > Edit"
echo ""
echo "  Then run:"
echo "  mkdir -p /root/.secrets"
echo "  echo 'dns_cloudflare_api_token = YOUR_TOKEN' > /root/.secrets/cloudflare.ini"
echo "  chmod 600 /root/.secrets/cloudflare.ini"
echo "  certbot certonly --dns-cloudflare \\"
echo "    --dns-cloudflare-credentials /root/.secrets/cloudflare.ini \\"
echo "    -d $ROOT_DOMAIN -d '*.$ROOT_DOMAIN'"
echo ""
warn "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# ── 8. Final verification ────────────────────────────────────────────────────
echo ""
info "━━━━━━━━ SETUP COMPLETE ━━━━━━━━"
info "App URL: https://$ROOT_DOMAIN"
info "Proxy test (query-param): https://$ROOT_DOMAIN/proxy?url=https://google.com"
info "Proxy test (subdomain):   https://google--com.$ROOT_DOMAIN"
info "Proxy test (dot format):  https://google.com.$ROOT_DOMAIN"
info ""
info "Check app logs: pm2 logs blockway"
info "Check nginx logs: tail -f /var/log/nginx/blockway-subdomain.access.log"
