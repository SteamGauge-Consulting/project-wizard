// Generate the artifacts to deploy a generated /docs package as a Docker
// container on a LAN host over SSH: a Dockerfile, a docker-compose.yml (behind
// Traefik if a hostname is given, else a published port), a one-command
// deploy.sh (rsync + remote `docker compose up -d --build`), and a README.
// These are staged alongside the package so the downloaded bundle is runnable.
'use strict';

function slugify(s) {
  return String(s || 'app').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'app';
}

// opts: { name, host, sshUser, sshPort, port, hostname }
function files(opts) {
  const name = slugify(opts.name);
  const host = (opts.host || '').trim();
  const user = (opts.sshUser || 'docker').trim();
  const sshPort = String(opts.sshPort || '22').trim();
  const port = String(opts.port || '3000').trim();
  const hostname = (opts.hostname || '').trim();   // e.g. docs.10.10.0.208.nip.io
  // The hostname field accepts a comma-separated list of routes, each a plain
  // host (crm.10.0.0.1.nip.io) or host/path (crm.example.com/docs) — one
  // Traefik router per entry, so the SAME pod can keep its LAN hostname AND
  // serve under the app's public domain at /docs.
  const routes = hostname ? hostname.split(',').map((s) => s.trim()).filter(Boolean) : [];
  const routerLabels = routes.map((r, i) => {
    const cut = r.indexOf('/');
    const h = cut === -1 ? r : r.slice(0, cut);
    const p = cut === -1 ? '' : ('/' + r.slice(cut + 1).replace(/\/+$/, '').replace(/^\/+/, ''));
    const rule = 'Host(`' + h + '`)' + (p ? ' && PathPrefix(`' + p + '`)' : '');
    const rn = i ? name + '-r' + i : name;
    return '      - traefik.http.routers.' + rn + '.rule=' + rule + '\n' +
           '      - traefik.http.routers.' + rn + '.entrypoints=web\n' +
           '      - traefik.http.routers.' + rn + '.service=' + name;
  }).join('\n');
  const linearKey = (opts.linearKey || '').trim();         // powers the deployed /api/status live tracker
  const linearProjectId = (opts.linearProjectId || '').trim(); // the project the in-page editor's Assess/Apply act on
  const anthropicKey = (opts.anthropicKey || '').trim();   // baked so the in-page editor can Assess + re-enrich
  const sshTarget = user + '@' + host;
  const sshOpt = sshPort && sshPort !== '22' ? ' -p ' + sshPort : '';
  // Extra environment lines (indented for the compose `environment:` block).
  // Baked into the container so the deployed docs site's hamburger editor can
  // run Assess/Apply against Linear + Claude without re-entering keys.
  const envEntries = [];
  if (linearKey) envEntries.push('LINEAR_API_KEY=' + linearKey);
  if (linearProjectId) envEntries.push('LINEAR_PROJECT_ID=' + linearProjectId);
  if (anthropicKey) envEntries.push('ANTHROPIC_API_KEY=' + anthropicKey);
  // Baked so the pod's "Update app" can call back to the wizard to re-deploy
  // itself (data-preserving) without the user re-entering anything.
  if (opts.wizardUrl) envEntries.push('WIZARD_URL=' + String(opts.wizardUrl).trim());
  if (opts.wizardProjectId) envEntries.push('WIZARD_PROJECT_ID=' + String(opts.wizardProjectId).trim());
  envEntries.push('APP_NAME=' + name);
  if (hostname) envEntries.push('APP_HOSTNAME=' + hostname);
  if (opts.buildVersion) envEntries.push('BUILD_VERSION=' + String(opts.buildVersion).trim());
  const envLines = envEntries.map((e) => '\n      - ' + e).join('');

  // The host project folder (~/apps/<name>) is bind-mounted at /app so a file the
  // editor writes (or you edit over SSH) is the file the site serves — applied
  // changes go live with no redeploy. The anonymous node_modules volume keeps the
  // image's installed deps from being hidden by the mount.
  const volumes = '\n    volumes:\n      - .:/app\n      - /app/node_modules';

  const dockerfile =
`FROM node:20-alpine
WORKDIR /app
# unzip lets the in-container editor expand zipped code corpora (reference/*.zip)
# for Assess's code-impact analysis; harmless when there are none.
RUN apk add --no-cache unzip
COPY package.json ./
RUN npm install --omit=dev
COPY . .
ENV PORT=${port}
EXPOSE ${port}
CMD ["node", "serve-docs.js"]
`;

  const dockerignore = `node_modules\n.git\n_static\n_deploy\ndeploy.sh\n`;

  const compose = routes.length
    ? // behind the existing Traefik proxy on the shared `web` network
`services:
  ${name}:
    build: .
    container_name: ${name}
    restart: unless-stopped
    user: "\${PUID:-0}:\${PGID:-0}"
    networks: [default, web]
    environment:
      - PORT=${port}${envLines}${volumes}
    labels:
      - traefik.enable=true
      - traefik.docker.network=web
${routerLabels}
      - traefik.http.services.${name}.loadbalancer.server.port=${port}
networks:
  web:
    external: true
`
    : // standalone: publish the port directly
`services:
  ${name}:
    build: .
    container_name: ${name}
    restart: unless-stopped
    user: "\${PUID:-0}:\${PGID:-0}"
    environment:
      - PORT=${port}${envLines}${volumes}
    ports:
      - "${port}:${port}"
`;

  const reachUrl = routes.length ? 'http://' + routes[0].split('/')[0] + '/docs' : 'http://' + host + ':' + port + '/docs';

  const deploySh =
`#!/usr/bin/env bash
# One-command deploy of these docs to a Docker host over SSH.
# Generated by project-wizard. Run from this folder:  bash deploy.sh
set -euo pipefail

HOST_SSH="${sshTarget}"
SSH_PORT="${sshPort}"
NAME="${name}"
SSH="ssh${sshOpt}"

echo "→ ensuring ~/apps/$NAME on $HOST_SSH"
$SSH "$HOST_SSH" "mkdir -p ~/apps/$NAME"

echo "→ copying files"
rsync -az --delete -e "ssh${sshOpt}" \\
  --exclude node_modules --exclude .git --exclude _static --exclude _deploy --exclude deploy.sh \\
  --exclude .deploy/keys.json --exclude .deploy/changes.json \\
  ./ "$HOST_SSH:apps/$NAME/"

echo "→ build + start"
$SSH "$HOST_SSH" "cd ~/apps/$NAME && PUID=\$(id -u) PGID=\$(id -g) docker compose up -d --build"

echo "✓ deployed — open ${reachUrl}"
`;

  const readme =
`# Deploy bundle — ${name}

This folder is a self-contained docs site plus everything needed to run it as a
Docker container on **${sshTarget}**${sshPort !== '22' ? ' (ssh port ' + sshPort + ')' : ''}.

## One command
\`\`\`bash
bash deploy.sh
\`\`\`
It rsyncs these files to \`~/apps/${name}/\` on the host, then runs
\`docker compose up -d --build\`. Reach it at **${reachUrl}**.

## What's here
- \`Dockerfile\` — node:20-alpine running \`serve-docs.js\` on port ${port}
- \`docker-compose.yml\` — ${hostname ? 'behind Traefik at `' + hostname + '` (joins the external `web` network)' : 'publishes port ' + port + ' directly'}, bind-mounting this folder at \`/app\` so on-page edits go live
- \`deploy.sh\` — the rsync + remote compose step
- the docs app itself (pages, governance library, markdown, serve-docs.js, lib/)
- \`PLAN-INTAKE.json\` + \`reference/\` — the editable intake + code corpus the site's hamburger editor reads

## Editing live
The deployed site has a hamburger menu → **Edit**: it re-opens the project intake,
analyzes your edits against the code in \`reference/\` and the live Linear tracker,
and on Apply re-renders the docs **in place** (this folder is bind-mounted), so
changes are live with no redeploy. Re-running \`deploy.sh\` re-pushes the wizard's
copy and overwrites in-place edits — treat the wizard as the source of truth, or
edit only on the pod.

## Requirements
- SSH access to the host (key or password) and Docker installed there.
${hostname ? '- A Traefik proxy already running on the `web` network (the labels register this app automatically).' : '- Nothing else — the port is published directly.'}

## Update later
Re-run \`bash deploy.sh\` after any change.
`;

  return { 'Dockerfile': dockerfile, '.dockerignore': dockerignore, 'docker-compose.yml': compose, 'deploy.sh': deploySh, 'DEPLOY-README.md': readme, _meta: { name, reachUrl } };
}

module.exports = { files, slugify };
