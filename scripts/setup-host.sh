#!/usr/bin/env bash
# ============================================================================
#  setup-host.sh — turn a fresh Ubuntu host into a Docker app server and deploy
#  the Project Wizard onto it. Run ON the target host, from the repo root:
#
#      bash scripts/setup-host.sh [HOST_IP]
#
#  (HOST_IP defaults to the box's primary LAN IP.) When it finishes, the wizard
#  is live at  http://wizard.<HOST_IP>.nip.io/  with a working "New project"
#  button, behind a Traefik reverse proxy that also routes every project a user
#  later deploys from the wizard.
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."                                  # repo root
HOST_IP="${1:-$(hostname -I | awk '{print $1}')}"
WIZARD_HOST="wizard.${HOST_IP}.nip.io"
echo "→ Setting up Docker host ${HOST_IP}"
echo "  wizard will be at http://${WIZARD_HOST}/"

# 1. Docker (official convenience script) ------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  echo "→ installing Docker…"
  curl -fsSL https://get.docker.com | sudo sh
  sudo systemctl enable --now docker
  sudo usermod -aG docker "$USER" || true   # takes effect on next login
fi
# Use sudo for docker only if the current shell can't reach the daemon yet.
DOCKER="docker"; docker ps >/dev/null 2>&1 || DOCKER="sudo docker"

# 2. Log rotation so container logs can't fill the disk ----------------------
if [ ! -f /etc/docker/daemon.json ]; then
  echo '{ "log-driver": "json-file", "log-opts": { "max-size": "10m", "max-file": "3" } }' \
    | sudo tee /etc/docker/daemon.json >/dev/null
  sudo systemctl restart docker
fi

# 3. Shared proxy network ----------------------------------------------------
$DOCKER network inspect web >/dev/null 2>&1 || $DOCKER network create web

# 4. TLS — a private CA + one wildcard leaf ---------------------------------
#    nip.io hostnames can't get a public cert (no DNS control, RFC1918 target),
#    so the LAN runs its own CA. The leaf's *.<HOST_IP>.nip.io SAN covers every
#    pod the wizard will ever deploy, so adding a project needs no cert work —
#    Traefik serves this as the default certificate for all hosts on :443.
#    Trust ~/apps/proxy/certs/ca.crt once per client machine to lose the
#    browser warning (see the note this script prints at the end).
mkdir -p ~/apps/proxy/certs ~/apps/proxy/dynamic
if [ ! -f ~/apps/proxy/certs/ca.key ]; then
  echo "→ generating LAN certificate authority…"
  openssl genrsa -out ~/apps/proxy/certs/ca.key 2048 2>/dev/null
  openssl req -x509 -new -nodes -sha256 -days 3650 \
    -key ~/apps/proxy/certs/ca.key -out ~/apps/proxy/certs/ca.crt \
    -subj "/CN=Project Wizard Lab CA/O=Project Wizard" \
    -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
    -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null
fi
# Leaf is reissued on every run (825 days — the max a browser accepts).
cat > ~/apps/proxy/certs/leaf.ext <<EXT
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectKeyIdentifier=hash
authorityKeyIdentifier=keyid,issuer
subjectAltName=@alt

[alt]
DNS.1=${HOST_IP}.nip.io
DNS.2=*.${HOST_IP}.nip.io
DNS.3=localhost
IP.1=${HOST_IP}
IP.2=127.0.0.1
EXT
openssl genrsa -out ~/apps/proxy/certs/lan.key 2048 2>/dev/null
openssl req -new -key ~/apps/proxy/certs/lan.key -out ~/apps/proxy/certs/lan.csr \
  -subj "/CN=${HOST_IP}.nip.io/O=Project Wizard" 2>/dev/null
openssl x509 -req -in ~/apps/proxy/certs/lan.csr \
  -CA ~/apps/proxy/certs/ca.crt -CAkey ~/apps/proxy/certs/ca.key -CAcreateserial \
  -out ~/apps/proxy/certs/lan.crt -days 825 -sha256 \
  -extfile ~/apps/proxy/certs/leaf.ext 2>/dev/null
rm -f ~/apps/proxy/certs/lan.csr
chmod 644 ~/apps/proxy/certs/*.crt
chmod 640 ~/apps/proxy/certs/*.key

cat > ~/apps/proxy/dynamic/tls.yml <<'YML'
# The default certificate is served for every Host on the websecure
# entrypoint, so a newly deployed pod is valid over HTTPS immediately.
tls:
  stores:
    default:
      defaultCertificate:
        certFile: /etc/traefik/certs/lan.crt
        keyFile: /etc/traefik/certs/lan.key
  certificates:
    - certFile: /etc/traefik/certs/lan.crt
      keyFile: /etc/traefik/certs/lan.key
YML

# 4a. Traefik reverse proxy --------------------------------------------------
#    Routes by hostname via nip.io, so apps get clean URLs with no DNS setup.
#    Serves both :80 and :443; HTTP is left working rather than redirected, so
#    the wizard↔pod callbacks (which POST over http://) keep their 2xx.
mkdir -p ~/apps/proxy
cat > ~/apps/proxy/docker-compose.yml <<'YML'
services:
  traefik:
    image: traefik:latest          # NOTE: a recent image — Traefik v3.1 is
    container_name: traefik        # incompatible with Docker Engine 29+.
    restart: unless-stopped
    environment:
      - DOCKER_API_VERSION=1.44
    command:
      - --providers.docker=true
      - --providers.docker.exposedbydefault=false
      # File provider carries the TLS store (certs/ + dynamic/tls.yml).
      - --providers.file.directory=/etc/traefik/dynamic
      - --providers.file.watch=true
      - --entrypoints.web.address=:80
      - --entrypoints.websecure.address=:443
      # Every router on websecure terminates TLS with the default cert, so a
      # pod only needs `entrypoints=web,websecure` — no per-router tls labels.
      - --entrypoints.websecure.http.tls=true
      - --api.dashboard=true
      - --api.insecure=true        # LAN dashboard on :8080, no auth
    ports:
      - "80:80"
      - "443:443"
      - "8080:8080"
    volumes:
      - ./certs:/etc/traefik/certs:ro
      - ./dynamic:/etc/traefik/dynamic:ro
      - /var/run/docker.sock:/var/run/docker.sock:ro
    networks: [web]
networks:
  web:
    external: true
YML
( cd ~/apps/proxy && $DOCKER compose up -d )

# 4b. Portainer — container-management GUI at portainer.<HOST_IP>.nip.io ------
#     Seed an admin password up front so Portainer never hits its first-run
#     security timeout (which locks the init screen until you restart it).
#     --admin-password-file only takes effect on the very first launch; on
#     re-runs (volume already initialized) it's ignored, so this is idempotent.
mkdir -p ~/apps/portainer
if [ ! -f ~/apps/portainer/admin-password ]; then
  openssl rand -base64 18 | tr -d '\n' > ~/apps/portainer/admin-password
  chmod 600 ~/apps/portainer/admin-password
fi
cat > ~/apps/portainer/docker-compose.yml <<YML
services:
  portainer:
    image: portainer/portainer-ce:latest
    container_name: portainer
    restart: unless-stopped
    command: --admin-password-file /run/portainer-admin
    networks: [web]
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - portainer_data:/data
      - ${HOME}/apps/portainer/admin-password:/run/portainer-admin:ro
    labels:
      - traefik.enable=true
      - traefik.docker.network=web
      - traefik.http.routers.portainer.rule=Host(\`portainer.${HOST_IP}.nip.io\`)
      - traefik.http.routers.portainer.entrypoints=web,websecure
      - traefik.http.services.portainer.loadbalancer.server.port=9000
networks:
  web:
    external: true
volumes:
  portainer_data:
YML
( cd ~/apps/portainer && $DOCKER compose up -d )

# 5. The wizard, behind Traefik at wizard.<HOST_IP>.nip.io -------------------
#    A host-specific override (not committed) adds the proxy wiring; the base
#    docker-compose.yml stays portable.
cat > docker-compose.override.yml <<YML
services:
  project-wizard:
    environment:
      - PORT=4500
      - HOST_IP=${HOST_IP}
    networks: [default, web]
    labels:
      - traefik.enable=true
      - traefik.docker.network=web
      - traefik.http.routers.wizard.rule=Host(\`${WIZARD_HOST}\`)
      - traefik.http.routers.wizard.entrypoints=web,websecure
      - traefik.http.services.wizard.loadbalancer.server.port=4500
networks:
  web:
    external: true
YML
$DOCKER compose up -d --build

echo
echo "✓ Done."
echo "  Project Wizard:     https://${WIZARD_HOST}/   (http:// also works)"
echo "  Portainer:          https://portainer.${HOST_IP}.nip.io/"
echo "     login: admin / $(cat ~/apps/portainer/admin-password)"
echo "     (seeded on first run — change it in Portainer › My account)"
echo "  Traefik dashboard:  http://${HOST_IP}:8080/dashboard/"
echo
echo "Users open the wizard, build a project, then Export → Deploy to Docker"
echo "with host ${HOST_IP} (this box) to spin it up at <name>.${HOST_IP}.nip.io."
echo
echo "HTTPS uses a private CA, so browsers warn until it's trusted. Copy"
echo "  ~/apps/proxy/certs/ca.crt"
echo "to each client machine and trust it once — it covers every pod, since the"
echo "cert carries a *.${HOST_IP}.nip.io wildcard. On macOS:"
echo "  sudo security add-trusted-cert -d -r trustRoot \\"
echo "    -k /Library/Keychains/System.keychain ca.crt"
