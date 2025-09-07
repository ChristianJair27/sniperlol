# =========================
# 1) Dependencias de PRODUCCIÓN (con toolchain para nativos)
# =========================
FROM node:20-alpine AS prod-deps
WORKDIR /app

# Herramientas para módulos nativos (bcrypt, sharp, etc.)
RUN apk add --no-cache python3 make g++ \
  && npm config set python /usr/bin/python3

COPY package*.json ./
# Instala SÓLO deps de producción
RUN npm ci --omit=dev


# =========================
# 2) Build de TypeScript
# =========================
FROM node:20-alpine AS build
WORKDIR /app

COPY package*.json ./
# Instala TODAS las deps (incluye dev) para poder compilar TS
RUN npm ci

# Copiamos el código fuente y config TS
COPY tsconfig.json ./
COPY src ./src
# Si sirves archivos estáticos desde /public:
COPY public ./public

# Compila a /dist
RUN npm run build


# =========================
# 3) Runtime mínimo
# =========================
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Ajusta el puerto si usas otro en tu server.ts
ENV PORT=4000

# Usuario no root
RUN addgroup -S app && adduser -S app -G app

# Copiamos sólo lo necesario para correr
COPY --from=prod-deps /app/node_modules ./node_modules
COPY package*.json ./
COPY --from=build /app/dist ./dist
# (Opcional) estáticos si tu server los sirve:
COPY --from=build /app/public ./public

EXPOSE 4000

# Healthcheck simple (ajusta a tu endpoint real)
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/health || exit 1

USER app
# Asegúrate que tu package.json tenga "start": "node dist/server.js"
CMD ["npm", "start"]