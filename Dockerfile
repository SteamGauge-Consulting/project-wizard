FROM node:20-alpine

# zip → the .zip downloads; openssh-client + rsync + sshpass → "Deploy now"
# pushes a generated package to a Docker host over SSH from inside the container.
RUN apk add --no-cache zip openssh-client rsync sshpass

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

COPY . .

# Project JSON + generated trees persist here — mount a volume to keep them.
ENV DATA_DIR=/app/data/projects
ENV GEN_DIR=/app/data/generated
VOLUME ["/app/data"]

ENV PORT=4500
EXPOSE 4500
CMD ["node", "server.js"]
