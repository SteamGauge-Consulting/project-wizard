FROM node:20-alpine

# `zip` powers the "download .zip" of a generated doc structure.
RUN apk add --no-cache zip

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
