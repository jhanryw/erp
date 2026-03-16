# 1. Estágio de dependências
FROM node:20-alpine AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

# 2. Estágio de build
FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Desabilita telemetria para o build ficar mais rápido
ENV NEXT_TELEMETRY_DISABLED 1

RUN npm run build

# 3. Estágio de execução (Runner)
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV production
ENV NEXT_TELEMETRY_DISABLED 1

# Cria usuário para não rodar como root (segurança)
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

# Cria a pasta public se ela não existir para evitar erro de cópia
RUN mkdir public

# Copia os arquivos necessários do estágio builder
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs

# O Next standalone roda na 3000 por padrão
EXPOSE 3000
ENV PORT 3000
ENV HOSTNAME "0.0.0.0"

# O comando mágico para o modo standalone
CMD ["node", "server.js"]