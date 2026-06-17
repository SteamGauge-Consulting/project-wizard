FROM node:20-alpine

# zip → the .zip downloads; unzip → expand uploaded codebase .zips for analysis;
# openssh-client + rsync + sshpass → "Deploy now" pushes a generated package to a
# Docker host over SSH from inside the container.
RUN apk add --no-cache zip unzip openssh-client rsync sshpass

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

COPY . .

# Project JSON + generated trees persist here — mount a volume to keep them.
ENV DATA_DIR=/app/data/projects
ENV GEN_DIR=/app/data/generated
VOLUME ["/app/data"]

# Build version (git short SHA), passed by scripts/update.sh as a build-arg and
# read by the wizard so it can stamp each deployed pod (shown in the ☰ menu).
ARG BUILD_VERSION=dev
ENV BUILD_VERSION=$BUILD_VERSION

ENV PORT=4500
EXPOSE 4500
CMD ["node", "server.js"]
