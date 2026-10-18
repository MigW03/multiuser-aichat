# Build from the repo root so the image can see shared/:
#   fly deploy            (uses ../fly.toml)
#   docker build -f server/Dockerfile .
FROM node:22-slim

ENV NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    ELECTRON_SKIP_BINARY_DOWNLOAD=1

WORKDIR /app

# Install only what the server needs. The lockfile belongs to the whole monorepo, so every workspace's
# package.json has to be present, but only shared and server are installed (-w).
# tsx is a devDependency but it is what runs the server (there is no build step), so dev packages stay.
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY ui/package.json ui/
COPY web/package.json web/
COPY desktop/package.json desktop/
RUN npm ci -w shared -w server --include=dev --no-audit --no-fund

COPY tsconfig.base.json ./
COPY shared shared
COPY server server

# Run as the unprivileged user that ships with the node image.
USER node

ENV HOST=0.0.0.0 \
    PORT=8080
EXPOSE 8080

WORKDIR /app/server
CMD ["/app/node_modules/.bin/tsx", "src/index.ts"]
