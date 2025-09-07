# ========== 1) Dependencias de producción ==========
FROM node:20-alpine AS prod-deps
WORKDIR /app
# toolchain para nativos (bcrypt, sharp, etc.)
RUN apk add --no-cache python3 make g++ \
  && npm config set python /usr/bin/python3 \
  && npm config set fund false \
  && npm config set audit false

COPY package*.json ./

# Instala SOLO prod (tolerando peer deps)
# Primero intentamos "ci"; si falla por peer deps, caemos a "install"
RUN npm ci --omit=dev --legacy-peer-deps || npm install --omit=dev --legacy-peer-deps

# ========== 2) Build de TypeScript ==========
FROM node:20-alpine AS build
WORKDIR /app
RUN apk add --no-cache python3 make g++ \
  && npm config set python /usr/bin/python3 \
  && npm config set fund false \
  && npm config set audit false

COPY package*.json ./

# Instala TODAS las deps para compilar (tolerante)
RUN npm ci --legacy-peer-deps || npm install --legacy-peer-deps

# Copiamos código
COPY tsconfig.json ./
COPY src ./src
COPY public ./public 2>/dev/null || true

# Compila a dist/
RUN npm run build

# ========== 3) Runtime ==========
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=4000

# Usuario no-root
RUN addgroup -S app && adduser -S app -G app

# Copiamos lo mínimo
COPY --from=prod-deps /app/node_modules ./node_modules
COPY package*.json ./
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public

EXPOSE 4000

# (opcional) Healthcheck, ajusta tu endpoint
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/health || exit 1

USER app
CMD ["npm", "start"]