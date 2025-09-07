# ========= 1) Instalar deps de PRODUCCIÓN =========
FROM node:20-alpine AS prod-deps
WORKDIR /app

COPY package*.json ./
# Instala solo deps de producción (si falla por peers, cae a install)
RUN npm ci --omit=dev || npm install --omit=dev

# ========= 2) Compilar TypeScript =========
FROM node:20-alpine AS build
WORKDIR /app

COPY package*.json ./
# Instala TODAS para poder compilar
RUN npm ci || npm install

# Copia el código fuente y configuración
COPY . .

# Compila a /dist según tu script
RUN npm run build

# ========= 3) Runtime =========
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=4000

# Usuario no root
RUN addgroup -S app && adduser -S app -G app

# Copiamos lo mínimo para ejecutar
COPY --from=prod-deps /app/node_modules ./node_modules
COPY package*.json ./
COPY --from=build /app/dist ./dist
# Si sirves estáticos, añade una carpeta public en tu repo y descomenta:
# COPY --from=build /app/public ./public

EXPOSE 4000

# Tu server expone /api/health
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/api/health || exit 1

USER app
CMD ["npm", "start"]
