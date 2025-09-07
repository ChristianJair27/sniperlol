# ========= 1) deps de PRODUCCIÓN =========
FROM node:20-alpine AS prod-deps
WORKDIR /app
# toolchain para cualquier módulo nativo (por si acaso)
RUN apk add --no-cache python3 make g++ \
  && npm config set python /usr/bin/python3 \
  && npm config set fund false \
  && npm config set audit false

COPY package*.json ./
# instala SOLO prod; si hay lío de peer deps, cae a install
RUN npm ci --omit=dev --legacy-peer-deps || npm install --omit=dev --legacy-peer-deps


# ========= 2) BUILD de TypeScript =========
FROM node:20-alpine AS build
WORKDIR /app
RUN apk add --no-cache python3 make g++ \
  && npm config set python /usr/bin/python3 \
  && npm config set fund false \
  && npm config set audit false

COPY package*.json ./
# instala todo para compilar (tolerante)
RUN npm ci --legacy-peer-deps || npm install --legacy-peer-deps

# copia código y config
COPY . .

# compila a /dist según tu script "build": "tsc -p tsconfig.json"
RUN npm run build


# ========= 3) RUNTIME =========
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=4000

# usuario no-root
RUN addgroup -S app && adduser -S app -G app

# copia lo mínimo para ejecutar
COPY --from=prod-deps /app/node_modules ./node_modules
COPY package*.json ./
COPY --from=build /app/dist ./dist
# si realmente sirves /public en runtime, crea la carpeta en el repo (public/.gitkeep) y descomenta:
# COPY --from=build /app/public ./public

EXPOSE 4000

# IMPORTANTE: tu server expone /api/health (no /health)
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/api/health || exit 1

USER app
CMD ["npm", "start"]
