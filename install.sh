#!/usr/bin/env bash
#
# hyperaccess installer.
# Installs dependencies, builds the server, creates .env with a generated
# API key, and optionally installs the systemd service.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

info() { printf '\033[1;34m==>\033[0m %s\n' "$1"; }
warn() { printf '\033[1;33m!\033[0m  %s\n' "$1"; }
err()  { printf '\033[1;31mERROR:\033[0m %s\n' "$1" >&2; }

# --- Pre-flight checks ----------------------------------------------------

if [ "$(id -u)" -eq 0 ]; then
  err "Do not run this installer as root."
  err "run_command would then execute every command as root."
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  err "Node.js is not installed. Install Node.js >= 20.12 and try again."
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  err "npm is not installed."
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  err "Node.js >= 20.12 is required (found $(node --version))."
  exit 1
fi

NODE_BIN="$(command -v node)"
info "Using Node.js $(node --version) at $NODE_BIN"

# --- Dependencies + build -------------------------------------------------

info "Installing dependencies..."
npm install

info "Building..."
npm run build

# --- .env -----------------------------------------------------------------

if [ -f .env ]; then
  info ".env already exists, leaving it unchanged."
else
  info "Creating .env with a freshly generated API key..."
  cp .env.example .env
  if command -v openssl >/dev/null 2>&1; then
    KEY="$(openssl rand -hex 32)"
  else
    KEY="$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
  fi
  tmp="$(mktemp)"
  sed "s|^API_KEY=.*|API_KEY=$KEY|" .env > "$tmp" && mv "$tmp" .env
  chmod 600 .env
  echo
  echo "  Generated API key: $KEY"
  echo "  Stored in .env (chmod 600). Keep it secret."
  echo
fi

# --- systemd service (optional) -------------------------------------------

if [ -d /run/systemd/system ]; then
  read -rp "Install and start the systemd service now? (needs sudo) [y/N] " ans
  case "${ans:-}" in
    [yY] | [yY][eE][sS])
      SERVICE_TMP="$(mktemp)"
      sed -e "s|__NODE_BIN__|$NODE_BIN|g" \
          -e "s|__PROJECT_DIR__|$SCRIPT_DIR|g" \
          -e "s|__USER__|$(id -un)|g" \
          hyperaccess.service > "$SERVICE_TMP"
      sudo cp "$SERVICE_TMP" /etc/systemd/system/hyperaccess.service
      rm -f "$SERVICE_TMP"
      sudo systemctl daemon-reload
      sudo systemctl enable --now hyperaccess
      info "Service installed and started."
      systemctl --no-pager --lines=0 status hyperaccess || true
      ;;
    *)
      info "Skipped systemd install. Start the server manually with: npm start"
      ;;
  esac
else
  warn "systemd not detected. Start the server manually with: npm start"
fi

echo
info "Done. The server listens on http://127.0.0.1:3420/mcp"
