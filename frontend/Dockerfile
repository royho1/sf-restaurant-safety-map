# Multi-stage frontend image.
# Build from repo root:
#   docker build -f frontend/Dockerfile \
#     --build-arg VITE_MAPBOX_TOKEN=pk.... \
#     -t sf-web .

# ---------- Stage 1: build ----------
# Full Node image has compilers/tooling Vite may need for native deps.
# Tradeoff vs node:*-alpine: Alpine is smaller here too, but mapbox/gl native
# optional deps historically break more often on musl; Debian Node is safer.
FROM node:20-bookworm-slim AS build

WORKDIR /app

# Cache npm installs separately from source edits (same idea as pip layer).
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci

COPY frontend/ ./

# Vite inlines VITE_* into the JS bundle at build time — not at container start.
# Passing as build-arg keeps the token out of the final nginx layer's ENV
# (it still ends up in the public JS; Mapbox tokens are public by design).
ARG VITE_MAPBOX_TOKEN
ENV VITE_MAPBOX_TOKEN=$VITE_MAPBOX_TOKEN
# Leave VITE_API_BASE unset so the SPA keeps relative `/api/...` URLs.
# nginx (below) will proxy those to the API container in Compose (Step 3).

RUN npm run build

# ---------- Stage 2: serve ----------
# Only the static files + a tiny web server. No Node, no npm, no node_modules.
FROM nginx:1.27-alpine AS serve

# Replace the default site config with ours (SPA + /api proxy).
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf

# Copy *only* the Vite output from the build stage — not the build toolchain.
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80

# nginx image already defines CMD; listed explicitly for clarity.
CMD ["nginx", "-g", "daemon off;"]
