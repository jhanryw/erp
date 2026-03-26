# -------------------------
# Build
# -------------------------
    FROM node:20-alpine AS builder

    WORKDIR /app
    
    ARG NEXT_PUBLIC_SUPABASE_URL
    ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
    ARG SUPABASE_SERVICE_ROLE_KEY
    ARG SYSTEM_USER_ID
    ARG CRON_SECRET
    ARG NODE_ENV=production
    
    ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL
    ENV NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY
    ENV SUPABASE_SERVICE_ROLE_KEY=$SUPABASE_SERVICE_ROLE_KEY
    ENV SYSTEM_USER_ID=$SYSTEM_USER_ID
    ENV CRON_SECRET=$CRON_SECRET
    ENV NODE_ENV=$NODE_ENV
    
    COPY package.json package-lock.json ./
    RUN npm ci
    
    COPY . .
    
    RUN npm run build
    
    # -------------------------
    # Runner
    # -------------------------
    FROM node:20-alpine AS runner
    
    WORKDIR /app
    
    ARG NEXT_PUBLIC_SUPABASE_URL
    ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
    ARG SUPABASE_SERVICE_ROLE_KEY
    ARG SYSTEM_USER_ID
    ARG CRON_SECRET
    ARG NODE_ENV=production
    
    ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL
    ENV NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY
    ENV SUPABASE_SERVICE_ROLE_KEY=$SUPABASE_SERVICE_ROLE_KEY
    ENV SYSTEM_USER_ID=$SYSTEM_USER_ID
    ENV CRON_SECRET=$CRON_SECRET
    ENV NODE_ENV=$NODE_ENV
    
    COPY --from=builder /app/.next ./.next
    COPY --from=builder /app/public ./public
    COPY --from=builder /app/package.json ./package.json
    COPY --from=builder /app/package-lock.json ./package-lock.json
    COPY --from=builder /app/node_modules ./node_modules
    
    EXPOSE 3000
    
    CMD ["npm", "start"]