# Santtorini ERP — Bloco 1: Arquitetura do Sistema

---

## 1.1 Visão Geral da Arquitetura

```
┌─────────────────────────────────────────────────────────────────┐
│                        EasyPanel (Docker)                       │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                  Next.js App (Port 3000)                  │  │
│  │  ┌────────────────┐  ┌────────────────────────────────┐  │  │
│  │  │  App Router    │  │   API Routes (/api/*)           │  │  │
│  │  │  (RSC + RCC)   │  │   Node.js service layer        │  │  │
│  │  └───────┬────────┘  └───────────────┬────────────────┘  │  │
│  └──────────┼───────────────────────────┼───────────────────┘  │
│             │                           │                       │
│             ▼                           ▼                       │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │              Supabase (External / Hosted)                 │  │
│  │   Auth │ PostgreSQL │ Storage │ Realtime │ Edge Functions  │  │
│  └──────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘

DNS: santtorini.qarvon.com → EasyPanel Reverse Proxy → Next.js :3000
```

---

## 1.2 Separação Frontend / Backend

### Frontend (Next.js App Router)
- **Server Components (RSC)**: fetch de dados pesados, relatórios, dashboards iniciais
- **Client Components (RCC)**: formulários, tabelas interativas, filtros, charts
- **Server Actions**: mutations simples (create/update) sem necessidade de API Route dedicada
- **API Routes (`/api/*`)**: operações com lógica de negócio complexa, webhooks, jobs

### Backend (Node.js via Next.js API Routes)
- Cada módulo tem seu diretório `/api/[modulo]/`
- Service layer pura em `/src/services/` — sem dependência de req/res
- Supabase Admin Client usado apenas no servidor (nunca exposto ao client)
- Validação com `zod` em todas as entradas de API

---

## 1.3 Autenticação

**Provider:** Supabase Auth (email + password)

**Fluxo:**
1. Login → Supabase retorna JWT com `access_token` + `refresh_token`
2. JWT armazenado em cookie HttpOnly (via `@supabase/ssr`)
3. Middleware Next.js intercepta todas as rotas e valida o token
4. `role` injetado no JWT via Supabase custom claims (app_metadata)

**Custom Claims no JWT:**
```json
{
  "app_metadata": {
    "role": "admin" | "seller"
  }
}
```

**Setup via Supabase Hook (Auth Hook - `custom_access_token`):**
```sql
-- Supabase hook que injeta role no JWT
SELECT app_metadata->>'role' FROM auth.users WHERE id = user_id;
```

---

## 1.4 Autorização (RBAC)

**Dois níveis de controle:**

### Nível 1 — Middleware Next.js
```
/dashboard/*          → autenticado
/dashboard/financeiro → role = admin
/dashboard/config     → role = admin
/dashboard/relatorios → role = admin
/dashboard/marketing  → role = admin
```

### Nível 2 — RLS (Row Level Security) no PostgreSQL
- Policies por tabela baseadas no `auth.uid()` e `app_metadata->>'role'`
- Vendedor: SELECT em produtos, estoque, clientes próprios
- Admin: full access
- Tabelas financeiras: apenas admin

**Matriz de permissões:**

| Módulo              | Admin | Vendedor |
|---------------------|-------|----------|
| Dashboard geral     | ✓     | ✓ (limitado) |
| Produtos            | CRUD  | R        |
| Estoque             | CRUD  | R        |
| Fornecedores        | CRUD  | —        |
| Clientes            | CRUD  | CR       |
| Vendas              | CRUD  | CR       |
| Marketing           | CRUD  | —        |
| Financeiro          | CRUD  | —        |
| Relatórios          | ✓     | —        |
| Inteligência        | ✓     | —        |
| Configurações       | ✓     | —        |

---

## 1.5 Estratégia Multi-Módulo

Cada módulo é isolado por:
1. **Rotas**: `/dashboard/[modulo]`
2. **API Routes**: `/api/[modulo]/`
3. **Services**: `/src/services/[modulo].service.ts`
4. **Types**: `/src/types/[modulo].types.ts`
5. **Components**: `/src/components/modules/[modulo]/`

Sem compartilhamento de estado global entre módulos (exceto auth context e configurações globais).

---

## 1.6 Organização de Pastas

```
/santtorini-erp
├── src/
│   ├── app/
│   │   ├── (auth)/
│   │   │   ├── login/
│   │   │   └── callback/
│   │   ├── (dashboard)/
│   │   │   ├── layout.tsx          ← sidebar, navbar, auth guard
│   │   │   ├── page.tsx            ← dashboard geral
│   │   │   ├── produtos/
│   │   │   ├── estoque/
│   │   │   ├── fornecedores/
│   │   │   ├── clientes/
│   │   │   ├── vendas/
│   │   │   ├── marketing/
│   │   │   ├── financeiro/
│   │   │   ├── relatorios/
│   │   │   ├── inteligencia/
│   │   │   └── configuracoes/
│   │   └── api/
│   │       ├── produtos/
│   │       ├── estoque/
│   │       │   └── lotes/
│   │       ├── fornecedores/
│   │       ├── clientes/
│   │       ├── vendas/
│   │       │   ├── [id]/
│   │       │   ├── devolucoes/
│   │       │   └── trocas/
│   │       ├── marketing/
│   │       ├── financeiro/
│   │       ├── cashback/
│   │       ├── relatorios/
│   │       └── jobs/               ← cron endpoints
│   │           ├── refresh-views/
│   │           ├── cashback-release/
│   │           └── rfm-recalc/
│   ├── components/
│   │   ├── ui/                     ← primitivos (button, input, card, table...)
│   │   ├── layout/                 ← sidebar, topbar, breadcrumb
│   │   ├── charts/                 ← wrappers recharts/tremor
│   │   └── modules/
│   │       ├── produtos/
│   │       ├── estoque/
│   │       ├── vendas/
│   │       ├── clientes/
│   │       ├── cashback/
│   │       └── dashboards/
│   ├── lib/
│   │   ├── supabase/
│   │   │   ├── client.ts           ← browser client
│   │   │   ├── server.ts           ← server client (cookies)
│   │   │   └── admin.ts            ← service role client
│   │   ├── auth/
│   │   │   ├── middleware.ts
│   │   │   └── guards.ts
│   │   ├── validators/             ← zod schemas por entidade
│   │   └── utils/
│   │       ├── currency.ts
│   │       ├── cpf.ts
│   │       ├── margin.ts
│   │       └── date.ts
│   ├── services/
│   │   ├── products.service.ts
│   │   ├── inventory.service.ts
│   │   ├── sales.service.ts
│   │   ├── customers.service.ts
│   │   ├── suppliers.service.ts
│   │   ├── cashback.service.ts
│   │   ├── finance.service.ts
│   │   ├── marketing.service.ts
│   │   ├── reports.service.ts
│   │   └── intelligence.service.ts
│   ├── hooks/
│   │   ├── useAuth.ts
│   │   ├── useDebounce.ts
│   │   └── usePermission.ts
│   └── types/
│       ├── database.types.ts       ← gerado via supabase gen types
│       ├── products.types.ts
│       ├── sales.types.ts
│       └── ...
├── supabase/
│   ├── migrations/                 ← versionamento do schema
│   │   ├── 001_enums.sql
│   │   ├── 002_core_tables.sql
│   │   ├── 003_stock.sql
│   │   ├── 004_sales.sql
│   │   ├── 005_finance.sql
│   │   ├── 006_cashback.sql
│   │   ├── 007_indexes.sql
│   │   ├── 008_rls.sql
│   │   ├── 009_views.sql
│   │   └── 010_functions.sql
│   ├── functions/                  ← Edge Functions (opcional)
│   └── seed.sql
├── middleware.ts                   ← auth middleware global
├── tailwind.config.ts
├── next.config.js
└── docker-compose.yml              ← para dev local
```

---

## 1.7 Estratégia para Dashboards Performáticos

### Problema
Dashboards de ERP envolvem JOINs pesados, agregações e janelas de tempo variáveis.

### Solução em camadas

**Camada 1 — Materialized Views (PostgreSQL)**
Views pré-calculadas atualizadas por schedule:
- `mv_daily_sales_summary` — vendas por dia
- `mv_product_performance` — faturamento, custo, margem por produto
- `mv_stock_status` — posição atual do estoque
- `mv_customer_rfm` — scores RFM por cliente
- `mv_abc_by_revenue` — curva ABC por faturamento
- `mv_abc_by_profit` — curva ABC por lucro
- `mv_abc_by_volume` — curva ABC por volume
- `mv_monthly_financial` — DRE mensal
- `mv_cashback_balance` — saldo de cashback por cliente

**Refresh schedule:**
- A cada hora: `mv_daily_sales_summary`, `mv_stock_status`
- A cada 6 horas: `mv_product_performance`, `mv_abc_*`
- A cada 24 horas: `mv_customer_rfm`, `mv_monthly_financial`

Via endpoint `/api/jobs/refresh-views` chamado por cron EasyPanel.

**Camada 2 — React Query no Client**
- `staleTime: 5 * 60 * 1000` (5 min) para dashboards
- Refetch on window focus desabilitado para relatórios pesados
- Background refetch para dados em tempo real (vendas do dia)

**Camada 3 — Supabase Realtime (seletivo)**
- Canal `sales` para notificações de nova venda (sidebar counter)
- Não usar para dashboards inteiros — muito custoso

**Camada 4 — Server Components**
- Dashboard inicial renderizado no servidor com dados frescos
- Hydration apenas dos componentes interativos (filtros, charts)

---

## 1.8 Estratégia Mobile Responsivo

**Abordagem:** Mobile-first com breakpoints Tailwind (`sm`, `md`, `lg`, `xl`)

**Sidebar:**
- Desktop: sidebar fixa lateral (240px)
- Mobile: drawer off-canvas com overlay

**Tabelas:**
- Desktop: tabela completa
- Mobile: card list view com dados essenciais + ação de expand

**Dashboards:**
- Grid responsivo: `grid-cols-1 sm:grid-cols-2 lg:grid-cols-4`
- Charts com `ResponsiveContainer` (Recharts)

**Formulários:**
- Single column em mobile, dois columns em desktop
- Inputs com tamanho mínimo de 44px para toque

**Tema:**
- Dark mode exclusivo (`dark` class no `<html>`)
- Cores: `#A71818` (primary/action), `#F4A8A9` (accent/highlight)
- Background: `#0F0F0F` principal, `#1A1A1A` cards, `#252525` sidebar

---

## 1.9 Entidades Principais

```
User → (admin | seller)
  │
  ├── cria Vendas → tem SaleItems → referencia ProductVariations
  │                              → consome StockLots (FIFO)
  ├── cadastra Clientes
  │
Product → tem ProductVariations (cor × tamanho × modelo × tecido)
  │     → pertence a Category (hierárquica)
  │     → pertence a Collection
  │     → tem Supplier
  │
StockLot → entrada de estoque (compra ou produção própria)
  │      → atualiza Stock (posição atual)
  │
Sale → tem SaleItems
  │  → tem SaleShipping
  │  → gera CashbackTransaction
  │  → gera FinanceEntry
  │
Return → reverte SaleItems
  │    → repõe StockLots
  │    → reverte CashbackTransaction
  │    → cria FinanceEntry negativa
  │
MarketingCost → gera FinanceEntry
  │           → pertence a Campaign (opcional)
  │
FinanceEntry → DRE, Fluxo de Caixa
```

---

## 1.10 Stack de Dependências Principais

```json
{
  "dependencies": {
    "next": "^14.x",
    "react": "^18.x",
    "@supabase/supabase-js": "^2.x",
    "@supabase/ssr": "^0.x",
    "tailwindcss": "^3.x",
    "zod": "^3.x",
    "react-query": "@tanstack/react-query ^5.x",
    "recharts": "^2.x",
    "react-hook-form": "^7.x",
    "@hookform/resolvers": "^3.x",
    "date-fns": "^3.x",
    "numeral": "^2.x"
  }
}
```
