# ──────────────────────────────────────────────────────────────────────────────
# Stage 1 — Instala dependências com lockfile exato
# ──────────────────────────────────────────────────────────────────────────────
FROM node:20-alpine AS deps
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

# ──────────────────────────────────────────────────────────────────────────────
# Stage 2 — Build da aplicação Next.js
#
# As variáveis NEXT_PUBLIC_* precisam existir AQUI (no build-time) porque o
# Next.js as embute no bundle do cliente durante o `next build`.
# No EasyPanel: defina-as em App → Settings → Build Arguments com os mesmos
# nomes abaixo.
# ──────────────────────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app

ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL
ENV NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY
ARG SYSTEM_USER_ID
ENV SYSTEM_USER_ID=$SYSTEM_USER_ID

COPY --from=deps /app/node_modules ./node_modules
COPY . .

RUN npm run build

# ──────────────────────────────────────────────────────────────────────────────
# Stage 3 — Imagem de produção (só o output standalone — muito menor)
# ──────────────────────────────────────────────────────────────────────────────
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
# Garante que o servidor escuta em todas as interfaces dentro do container
ENV HOSTNAME="0.0.0.0"
ENV PORT=3000

# O output standalone já contém o Node server e as dependências necessárias.
# Os assets estáticos e a pasta public precisam ser copiados separadamente.
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static     ./.next/static
COPY --from=builder /app/public           ./public

EXPOSE 3000

# server.js fica na raiz do standalone (que agora é /app)
CMD ["node", "server.js"]
