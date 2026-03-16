# Santtorini ERP — Bloco 4: Observações Técnicas e Escalabilidade

---

## 4.1 Riscos de Modelagem

### Risco 1 — Custo médio vs. FIFO no sale_item
**Problema:** Usar `stock.avg_cost` no `sale_items.unit_cost` é uma simplificação. Se a empresa comprar lotes com custos muito diferentes, a margem realizada por item será imprecisa.

**Mitigação v1:** Aceitar o avg_cost para simplicidade operacional.

**Migração futura:** Adicionar coluna `lot_consumption` (JSONB) em `sale_items` armazenando `[{lot_id, qty, unit_cost}]`. Sem mudar a estrutura principal.

---

### Risco 2 — Materialized Views desatualizadas
**Problema:** Dashboards podem mostrar dados de até 1h/6h atrás dependendo do refresh schedule.

**Mitigação:**
- Exibir `last_refresh_at` em todos os dashboards
- Para KPIs do dia (faturamento atual, vendas abertas), usar queries diretas nas tabelas de fato
- Materialized views apenas para análises históricas e rankings

---

### Risco 3 — Race condition em `consume_stock_fifo`
**Problema:** Duas vendas simultâneas podem consumir o mesmo lote.

**Mitigação:**
- `consume_stock_fifo` usa `FOR UPDATE SKIP LOCKED` no SELECT de lotes (adicionar na função)
- Ou: usar `quantity_remaining` com constraint `>= 0` como barreira natural (erro na venda)
- Recomendado: tratar o erro no service layer e retornar `"estoque insuficiente"` ao usuário

---

### Risco 4 — Explosão de audit_log
**Problema:** `audit_log` cresce indefinidamente com todas as operações.

**Mitigação:**
- Particionamento por mês (`PARTITION BY RANGE (created_at)`)
- Política de retenção: manter 24 meses, arquivar ou descartar mais antigos
- Índice em `(created_at)` já presente no schema

---

### Risco 5 — CPF como identificador único de cliente
**Problema:** Dois membros da mesma família usando o mesmo CPF (comum em vendas físicas).

**Mitigação:**
- Manter CPF como UNIQUE — é a regra correta de negócio
- Adicionar campo `alias_name` ou `secondary_contact` no futuro se necessário
- Nunca aceitar CPF inválido (validação algoritmica obrigatória)

---

### Risco 6 — cashback_config com constraint UNIQUE (active)
**Problema:** A constraint `UNIQUE (active)` só permite 1 registro `active=TRUE`. Mas permite múltiplos `active=FALSE`.

**Alternativa mais robusta:**
```sql
-- Ao criar nova config, desativar a anterior
CREATE OR REPLACE FUNCTION deactivate_old_cashback_config()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.active = TRUE THEN
    UPDATE cashback_config SET active = FALSE WHERE id != NEW.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
```

---

### Risco 7 — Categorias hierárquicas sem limite de profundidade
**Problema:** A auto-referência em `categories(parent_id)` permite n níveis. Mas o sistema foi projetado para 2 níveis (categoria → subcategoria).

**Mitigação:** Adicionar constraint de profundidade via trigger ou validar no service layer:
```typescript
// Validar que subcategoria tem parent_id != NULL e parent.parent_id = NULL
if (data.parent_id) {
  const parent = await getCategory(data.parent_id)
  if (parent.parent_id !== null) throw new Error('Máximo 2 níveis de categoria')
}
```

---

## 4.2 Pontos que Merecem Versionamento

### Versionamento de Preço de Produto
**Situação atual:** `products.base_price` é mutável. Uma alteração de preço apaga o histórico.

**Necessário para:** analisar se a margem caiu por mudança de preço ou de custo.

**Solução futura:** tabela `product_price_history`:
```sql
CREATE TABLE product_price_history (
  id          SERIAL      PRIMARY KEY,
  product_id  INT         NOT NULL REFERENCES products(id),
  price       NUMERIC(10,2) NOT NULL,
  cost        NUMERIC(10,2) NOT NULL,
  changed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  changed_by  UUID        NOT NULL REFERENCES users(id),
  reason      TEXT
);
```

### Versionamento de Cashback Config
**Situação atual:** apenas 1 config ativa.

**Necessário para:** auditoria de quando a taxa foi alterada e qual era na data da venda.

**Solução:** ao criar uma venda, armazenar o `cashback_config_id` no `cashback_transactions.earn`:
```sql
ALTER TABLE cashback_transactions ADD COLUMN config_id INT REFERENCES cashback_config(id);
```

### Versionamento de Parâmetros
**Tabela `parameters`** deve ter log de alterações. Solução: o `audit_log` já cobre isso se o trigger for aplicado na tabela `parameters`.

---

## 4.3 Pontos Configuráveis via Painel Admin

Todos gerenciados via tabela `parameters` (chave-valor) ou tabelas dedicadas:

| Configuração                        | Tabela/Chave                             | Impacto                          |
|-------------------------------------|------------------------------------------|----------------------------------|
| Taxa de cashback (%)                | `cashback_config.rate_pct`              | Cálculo de earn                  |
| Dias para liberação do cashback     | `cashback_config.release_days`          | Job de liberação                 |
| Dias para expiração do cashback     | `cashback_config.expiry_days`           | Job de expiração                 |
| Valor mínimo para usar cashback     | `cashback_config.min_use_value`         | Validação na venda               |
| Estoque mínimo para alerta          | `parameters['stock_min_alert_qty']`     | Dashboard de estoque             |
| Período inatividade para "parado"   | `parameters['stock_idle_days']`         | Relatório de giro                |
| Período RFM (janela de análise)     | `parameters['rfm_analysis_days']`       | Cálculo RFM                      |
| Novos tipos de variação             | `variation_types` (CRUD pelo admin)     | Variações de produto             |
| Novas categorias                    | `categories` (CRUD pelo admin)          | Catálogo                         |
| Novas formas de pagamento           | Extensão do enum `payment_method`       | Requer migração de banco         |
| Novas origens de cliente/venda      | Extensão do enum `customer_origin`      | Requer migração de banco         |

> **Nota:** Enums no PostgreSQL requerem `ALTER TYPE ... ADD VALUE` para novos valores.
> Considerar usar tabela de lookup ao invés de enum para `marketing_category` e `customer_origin` para facilitar extensão pelo admin.

---

## 4.4 Preparação para Futuras Integrações

### 4.4.1 WhatsApp (Notificações e Vendas)

**Casos de uso futuros:**
- Enviar confirmação de venda ao cliente via WhatsApp
- Notificar cliente sobre cashback disponível
- Recuperar clientes em risco (RFM: At Risk)
- Receber pedidos via WhatsApp

**Preparação no schema:**
```sql
-- Já existe: customers.phone
-- Adicionar futuramente:
ALTER TABLE customers ADD COLUMN whatsapp_opt_in BOOLEAN DEFAULT FALSE;
ALTER TABLE customers ADD COLUMN whatsapp_verified_at TIMESTAMPTZ;

-- Tabela de notificações enviadas
CREATE TABLE notifications (
  id          BIGSERIAL   PRIMARY KEY,
  customer_id INT         NOT NULL REFERENCES customers(id),
  channel     TEXT        NOT NULL,  -- 'whatsapp', 'email', 'sms'
  type        TEXT        NOT NULL,  -- 'sale_confirmation', 'cashback_available', etc.
  payload     JSONB       NOT NULL,
  status      TEXT        NOT NULL,  -- 'pending', 'sent', 'failed'
  sent_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

**Integração:** Evolution API (auto-hospedado) ou Z-API / Twilio

---

### 4.4.2 E-commerce (Site Próprio)

**Estratégia:** o ERP é a fonte de verdade. O e-commerce consome via API.

**Endpoints que serão necessários:**
```
GET  /api/public/products         → catálogo público (com estoque)
GET  /api/public/products/:id     → produto com variações disponíveis
POST /api/public/orders           → criar pedido do site
GET  /api/public/orders/:id       → status do pedido
```

**Preparação no schema:**
```sql
-- Adicionar campo de visibilidade no produto:
ALTER TABLE products ADD COLUMN ecommerce_visible BOOLEAN DEFAULT FALSE;
ALTER TABLE products ADD COLUMN ecommerce_description TEXT;

-- Adicionar origin de venda para 'website' (já previsto no enum customer_origin)

-- Tabela de pedidos web (pode ser sales com origin='website')
-- Nenhuma mudança estrutural necessária — apenas origin diferente
```

---

### 4.4.3 Marketplaces (Shopee, Mercado Livre, Magalu)

**Desafio principal:** sincronização de estoque bidirecional (venda no marketplace → desconta estoque no ERP).

**Preparação:**
```sql
-- Identificador externo por marketplace:
CREATE TABLE marketplace_product_mappings (
  id                    SERIAL  PRIMARY KEY,
  product_variation_id  INT     NOT NULL REFERENCES product_variations(id),
  marketplace           TEXT    NOT NULL,  -- 'shopee', 'mercado_livre', 'magalu'
  external_id           TEXT    NOT NULL,  -- ID do produto no marketplace
  external_sku          TEXT,
  active                BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (marketplace, external_id)
);

CREATE TABLE marketplace_orders (
  id                    SERIAL      PRIMARY KEY,
  sale_id               INT         REFERENCES sales(id),  -- NULL até ser processado
  marketplace           TEXT        NOT NULL,
  external_order_id     TEXT        NOT NULL UNIQUE,
  raw_payload           JSONB       NOT NULL,  -- payload original do marketplace
  status                TEXT        NOT NULL DEFAULT 'pending',
  processed_at          TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

**Fluxo:** Webhook do marketplace → `marketplace_orders` → job processa → cria `sales` → desconta estoque

---

### 4.4.4 Validação de CPF via API Externa

**Preparação atual:** `customers.cpf` validado algoritimicamente.

**Integração futura (Receita Federal / Serpro):**
```typescript
// service layer preparado para extensão
interface CPFValidationResult {
  valid: boolean
  name?: string      // nome na Receita
  situation?: string // regular, pendente, etc.
}

async function validateCPF(cpf: string): Promise<CPFValidationResult> {
  // v1: validação algorítmica apenas
  if (!algorithmValidate(cpf)) return { valid: false }

  // v2: integrar API externa se parâmetro habilitado
  const useExternalAPI = await getParam('cpf_external_validation')
  if (useExternalAPI === 'true') {
    return await externalCPFValidation(cpf)
  }

  return { valid: true }
}
```

---

### 4.4.5 Impressão de Etiquetas / Boletos (Futuro)

```sql
-- Campo de endereço completo no cliente (para etiquetas de envio):
ALTER TABLE customers ADD COLUMN address TEXT;
ALTER TABLE customers ADD COLUMN address_number TEXT;
ALTER TABLE customers ADD COLUMN address_complement TEXT;
ALTER TABLE customers ADD COLUMN neighborhood TEXT;
ALTER TABLE customers ADD COLUMN zip_code TEXT;
```

---

## 4.5 Estratégia de Deployment (EasyPanel)

### Dockerfile recomendado
```dockerfile
FROM node:20-alpine AS base

FROM base AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

EXPOSE 3000
CMD ["node", "server.js"]
```

### Variáveis de ambiente necessárias
```env
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
NEXT_PUBLIC_APP_URL=https://santtorini.qarvon.com
CRON_SECRET=                    # token para proteger /api/jobs/*
```

### Cron Jobs no EasyPanel
Configurar via EasyPanel Cron ou container separado com crontab:
```
*/60 * * * *  curl -H "Authorization: Bearer $CRON_SECRET" https://santtorini.qarvon.com/api/jobs/refresh-views-hourly
0 */6 * * *   curl -H "Authorization: Bearer $CRON_SECRET" https://santtorini.qarvon.com/api/jobs/refresh-views-6h
0 2  * * *    curl -H "Authorization: Bearer $CRON_SECRET" https://santtorini.qarvon.com/api/jobs/cashback-release
0 3  * * *    curl -H "Authorization: Bearer $CRON_SECRET" https://santtorini.qarvon.com/api/jobs/cashback-expire
0 4  * * *    curl -H "Authorization: Bearer $CRON_SECRET" https://santtorini.qarvon.com/api/jobs/rfm-recalc
```

---

## 4.6 Escalabilidade

### Gargalos previstos e soluções

| Gargalo                             | Quando ocorre            | Solução                                      |
|-------------------------------------|--------------------------|----------------------------------------------|
| Dashboard lento                     | > 10k vendas             | Materialized views + React Query cache        |
| `consume_stock_fifo` lento          | > 50 lotes por variação  | Índice em `(product_variation_id, entry_date, quantity_remaining)` |
| Tabela `audit_log` crescendo        | > 1M registros           | Particionamento mensal                        |
| `mv_customer_rfm` lento             | > 5k clientes            | Calcular apenas para clientes com compras     |
| Busca de clientes por nome/CPF      | > 10k clientes           | pg_trgm + GIN index para busca textual        |

### Índice trigram para busca de clientes
```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX idx_customers_name_trgm ON customers USING GIN (name gin_trgm_ops);
```

### Particionamento futuro de `sales` e `finance_entries`
```sql
-- Quando > 100k registros, converter para particionamento por ano:
CREATE TABLE sales_2026 PARTITION OF sales
  FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');
```

---

## 4.7 Ordem de Implementação Sugerida

```
Sprint 1: Fundação
  ✓ Setup Next.js + Supabase + Tailwind + Auth
  ✓ Schema migrations (enums, core tables)
  ✓ RBAC (middleware + RLS)
  ✓ Layout com sidebar (dark mode)

Sprint 2: Catálogo
  ✓ CRUD Categorias
  ✓ CRUD Fornecedores
  ✓ CRUD Produtos + Variações

Sprint 3: Estoque
  ✓ Entrada de lotes
  ✓ Posição de estoque
  ✓ Alertas de mínimo

Sprint 4: Clientes e Vendas
  ✓ CRUD Clientes (validação CPF)
  ✓ Registro de vendas (fluxo completo)
  ✓ FIFO de estoque
  ✓ Devoluções e trocas

Sprint 5: Financeiro e Cashback
  ✓ Finance entries automáticas
  ✓ Sistema de cashback completo
  ✓ Cron jobs

Sprint 6: Dashboards e Relatórios
  ✓ Materialized views
  ✓ Dashboards (general, sales, stock)
  ✓ RFM e Curva ABC
  ✓ DRE simplificado

Sprint 7: Marketing e Inteligência
  ✓ CRUD de campanhas e custos
  ✓ CAC, ROI, ROAS
  ✓ Dashboard de inteligência de produto
```
