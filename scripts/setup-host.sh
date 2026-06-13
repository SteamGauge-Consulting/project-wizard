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

# 4. Traefik reverse proxy ---------------------------------------------------
#    Routes by hostname via nip.io, so apps get clean URLs with no DNS setup.
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
      - --entrypoints.web.address=:80
      - --api.dashboard=true
      - --api.insecure=true        # LAN dashboard on :8080, no auth
    ports:
      - "80:80"
      - "8080:8080"
    volumes:
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
      - traefik.http.routers.portainer.entrypoints=web
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
      - traefik.http.routers.wizard.entrypoints=web
      - traefik.http.services.wizard.loadbalancer.server.port=4500
networks:
  web:
    external: true
YML
$DOCKER compose up -d --build

echo
echo "✓ Done."
echo "  Project Wizard:     http://${WIZARD_HOST}/"
echo "  Portainer:          http://portainer.${HOST_IP}.nip.io/"
echo "     login: admin / $(cat ~/apps/portainer/admin-password)"
echo "     (seeded on first run — change it in Portainer › My account)"
echo "  Traefik dashboard:  http://${HOST_IP}:8080/dashboard/"
echo
echo "Users open the wizard, build a project, then Export → Deploy to Docker"
echo "with host ${HOST_IP} (this box) to spin it up at <name>.${HOST_IP}.nip.io."
