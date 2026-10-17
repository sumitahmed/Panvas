# syntax=docker/dockerfile:1
FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS dependencies
WORKDIR /app
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund

FROM dependencies AS development
COPY --chown=node:node . .
RUN mkdir -p /app/node_modules/.vite /app/node_modules/.vite-temp \
    && chown node:node /app /app/node_modules/.vite /app/node_modules/.vite-temp
USER node
EXPOSE 3000
CMD ["npm", "run", "dev:web", "--", "--host", "0.0.0.0", "--port", "3000", "--strictPort"]

FROM dependencies AS build
COPY . .
# VITE values are PUBLIC compile-time configuration, never server secrets.
ARG VITE_ENABLE_CLOUD_SYNC=false
ARG VITE_PANVAS_SYNC_V2=false
ARG VITE_PANVAS_GOOGLE_WEB_CLIENT_ID=
ARG VITE_SUPABASE_URL=
ARG VITE_SUPABASE_ANON_KEY=
ARG VITE_PANVAS_BUILD_ID=local
ENV VITE_MARKETING_ONLY=false VITE_ENABLE_ANALYTICS=false
RUN npm run build:web

FROM nginxinc/nginx-unprivileged:1.31.7-alpine@sha256:378d0c32f6562f7fd9629170797f57d2b953aa09be983b3daaf4809bb039ca00 AS production
COPY docker/nginx.conf /etc/nginx/nginx.conf
COPY --from=build /app/dist /usr/share/nginx/html
USER 101:101
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
STOPSIGNAL SIGQUIT
# Bypass image configuration scripts; the image contains final, immutable config.
ENTRYPOINT ["nginx"]
CMD ["-g", "daemon off;"]
