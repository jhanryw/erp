# Pós-Venda v2 — Fluxo N8N com contexto dinâmico do ERP

**Data:** 2026-07-04  
**Status:** Aprovado — pronto para implementação  
**Escopo:** Novos endpoints + nova tabela + webhook v2 paralelo ao v1. Fluxo antigo intocado.

---

## Problema

O fluxo atual (`/webhook/pos-venda`) calcula cashback localmente no N8N (5% fixo), não consulta o ERP, e não sabe se a venda foi troca, se o cliente recomprou, se o cashback expirou ou foi usado. Isso gera mensagens erradas — especialmente em vendas de troca e quando o saldo muda entre o disparo do webhook e a execução da mensagem.

---

## Decisão de arquitetura

**Abordagem A — Endpoint único de contexto, chamado pelo N8N antes de cada ação.**

O N8N é um sequenciador de esperas e HTTP calls. Toda regra de negócio vive no ERP. O N8N lê flags e executa; nunca calcula nem decide.

O fluxo v1 continua rodando em paralelo para as sequências em andamento. O v2 usa um webhook separado (`N8N_WEBHOOK_URL_V2`) e uma nova tabela de eventos.

---

## Componentes

### 1. Webhook v2 — ERP → N8N

**Disparo:** dentro de `sendSaleWebhookV2()` em `src/app/api/vendas/route.ts`, em paralelo ao `sendSaleWebhook()` existente. Fire-and-forget, não bloqueia o response da venda.

**URL:** `N8N_WEBHOOK_URL_V2` (nova env var)

**Payload:**
```json
{
  "sale_id":        123,
  "customer_phone": "5511999990000",
  "is_anonymous":   false,
  "sale_date":      "2026-07-04"
}
```

**Idempotência:** verificada via `post_sale_automation_events` — se já existe evento `webhook_received` para o `sale_id`, não reenvia.

---

### 2. GET /api/automations/post-sale/context

**Auth:** `Authorization: Bearer <N8N_AUTOMATION_SECRET>`

**Query param:** `sale_id` (int, obrigatório)

**Resposta completa:**
```jsonc
{
  // Identificação
  "sale_id":        123,
  "customer_id":    456,
  "customer_name":  "Ana Lima",
  "phone":          "5511999990000",  // null se ausente
  "sale_date":      "2026-07-04",
  "sale_origin":    "instagram",

  // Classificação
  "is_anonymous":   false,
  "is_exchange":    false,           // true se cashback_transactions.type='use'
                                     // com exchange_id NOT NULL nesta venda

  // Comportamento do cliente
  "purchased_again_within_30_days": false,
                                     // outra venda após sale_date dentro de 30 dias

  // Cashback desta venda
  "cashback_generated_by_this_sale": 12.50,  // 0 se não gerou earn
  "cashback_used_in_this_sale":       0,

  // Saldo atual
  "current_cashback_available": 12.50,
  "current_cashback_pending":    0,

  // Expiração
  "nearest_cashback_expiry_date":  "2026-09-04",  // null se sem expiração
  "expiry_reminder_wait_until":    "2026-08-30",  // expiry_date - 5d, null se sem expiry

  // Flags de decisão
  "should_send_cashback_message":    true,
  "should_send_csat":                true,
  "should_schedule_expiry_reminder": true,
  "should_send_expiry_reminder":     false,

  // Motivos quando flag = false (null quando flag = true)
  "skip_reasons": {
    "cashback_message":   null,
    "csat":               null,
    "expiry_reminder":    "not_in_expiry_window"
  },

  // Mensagens prontas — o N8N envia exatamente esse texto
  "messages": {
    "cashback":        "Olá, Ana! Sua compra gerou R$ 12,50 em cashback...",
    "csat":            "Olá, Ana! Como foi sua experiência na Santtorini?...",
    "expiry_reminder": "Ana, seu cashback de R$ 12,50 expira em 5 dias..."
                       // null se not applicable
  }
}
```

#### Regras dos flags

| Flag | `true` quando | `false` quando |
|---|---|---|
| `should_send_cashback_message` | não é troca, não é anônimo, tem telefone, `cashback_generated_by_this_sale > 0` | qualquer condição inversa |
| `should_send_csat` | não é anônimo, tem telefone | anônimo ou sem telefone (recompra não bloqueia) |
| `should_schedule_expiry_reminder` | não é troca, não é anônimo, tem telefone, `nearest_cashback_expiry_date` não nulo, `current_cashback_available > 0` | qualquer condição inversa |
| `should_send_expiry_reminder` | todos os de `should_schedule` + `hoje >= expiry_reminder_wait_until` + `hoje <= nearest_cashback_expiry_date` + `current_cashback_available > 0` + `purchased_again_within_30_days = false` | qualquer condição inversa |

#### Valores possíveis de `skip_reason`

`anonymous_sale`, `missing_phone`, `exchange_sale`, `no_cashback_generated`, `no_active_cashback`, `no_expiry_date`, `not_in_expiry_window`, `cashback_already_used`, `customer_repurchase_within_30_days`

---

### 3. POST /api/automations/post-sale/events

**Auth:** `Authorization: Bearer <N8N_AUTOMATION_SECRET>`

**Payload:**
```jsonc
{
  "sale_id":          123,            // obrigatório — usado para resolver company_id
  "customer_id":      456,            // opcional
  "event_type":       "csat_sent",   // validado contra enum
  "skip_reason":      null,           // optional text
  "n8n_execution_id": "exec_abc123",  // optional
  "message":          "...",          // optional
  "context_snapshot": {               // optional jsonb — snapshot do contexto no momento
    "current_cashback_available": 0,
    "nearest_cashback_expiry_date": null,
    "purchased_again_within_30_days": true
  }
}
```

**Resposta:** `{ "ok": true, "id": 789 }`

**Erros:** 401 se secret inválido, 422 se `event_type` inválido, 404 se `sale_id` não encontrado.

`company_id` é resolvido internamente via `sale_id`. Se não conseguir resolver, retorna 422 — o log não pode ficar sem empresa.

---

### 4. Tabela `post_sale_automation_events`

```sql
CREATE TABLE public.post_sale_automation_events (
  id               BIGSERIAL    PRIMARY KEY,
  sale_id          INT          REFERENCES public.sales(id) ON DELETE SET NULL,
  customer_id      INT          REFERENCES public.customers(id) ON DELETE SET NULL,
  company_id       INT          NOT NULL REFERENCES public.companies(id),
  event_type       TEXT         NOT NULL
                   CHECK (event_type IN (
                     'webhook_received',
                     'cashback_message_sent',
                     'csat_sent',
                     'expiry_reminder_sent',
                     'skipped_cashback_message',
                     'skipped_csat',
                     'skipped_expiry_reminder',
                     'flow_ended_no_expiry',
                     'error'
                   )),
  skip_reason      TEXT,
  n8n_execution_id TEXT,
  message          TEXT,
  context_snapshot JSONB,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  sent_at          TIMESTAMPTZ  NULL      -- preenchido apenas para eventos de envio
);

CREATE INDEX ON public.post_sale_automation_events (sale_id, created_at DESC);
CREATE INDEX ON public.post_sale_automation_events (company_id, created_at DESC);
```

`created_at` — sempre preenchido.  
`sent_at` — preenchido apenas quando o evento representa uma mensagem enviada.

---

## Arquivos

### Novos

| Arquivo | Responsabilidade |
|---|---|
| `supabase/migrations/20260704_post_sale_automation_events.sql` | Cria a tabela + índices + RLS |
| `src/lib/automations/post-sale-context.ts` | Toda lógica de negócio: queries, flags, `skip_reasons`, geração de mensagens |
| `src/app/api/automations/post-sale/context/route.ts` | GET handler — valida secret, chama lib, retorna JSON |
| `src/app/api/automations/post-sale/events/route.ts` | POST handler — valida secret + event_type, resolve company_id, insere |

### Modificados

| Arquivo | O que muda |
|---|---|
| `src/app/api/vendas/route.ts` | Adiciona `sendSaleWebhookV2()` paralela, sem tocar `sendSaleWebhook()` |
| `.env.example` | Adiciona `N8N_WEBHOOK_URL_V2` e `N8N_AUTOMATION_SECRET` |

### Intocados

Tudo o mais: fluxo v1, `webhook_log`, RPCs de cashback/venda/troca, financeiro, estoque, Nuvemshop.

---

## Fluxo N8N v2 — estrutura de nós

```
[Webhook Trigger]  /webhook/pos-venda-v2
  → [POST /events] webhook_received
  → [GET /context] ?sale_id=...
  → [IF] sale_id ausente ou payload inválido → END

  → [IF] should_send_cashback_message = true
      → [Send WhatsApp] messages.cashback
      → [POST /events] cashback_message_sent
    [ELSE]
      → [POST /events] skipped_cashback_message + skip_reason

  → [Wait] 7 dias

  → [GET /context] ?sale_id=...
  → [IF] should_send_csat = true
      → [Send WhatsApp] messages.csat
      → [POST /events] csat_sent
    [ELSE]
      → [POST /events] skipped_csat + skip_reason

  → [IF] should_schedule_expiry_reminder = true
      → [Wait until] expiry_reminder_wait_until

      → [GET /context] ?sale_id=...
      → [IF] should_send_expiry_reminder = true
          → [Send WhatsApp] messages.expiry_reminder
          → [POST /events] expiry_reminder_sent
        [ELSE]
          → [POST /events] skipped_expiry_reminder + skip_reason + context_snapshot
    [ELSE]
      → [POST /events] flow_ended_no_expiry

[END]
```

O JSON do fluxo será criado como `[SANTTORINI] Pós venda v2.json`, baseado na estrutura acima e no padrão de nós do fluxo antigo (Evolution API para WhatsApp, HTTP Request nodes para ERP).

---

## Segurança

- Endpoints `/api/automations/*` protegidos por `N8N_AUTOMATION_SECRET` no header `Authorization: Bearer`.
- Rotas adicionadas ao `PUBLIC_PATHS` do middleware **não** — são API routes protegidas por secret, não por sessão Supabase.
- `company_id` resolvido server-side via `sale_id`, nunca confiado no payload do N8N.

---

## Variáveis de ambiente

```bash
# Webhook v2 — URL do N8N (endpoint novo, não conflita com v1)
N8N_WEBHOOK_URL_V2=https://seu-n8n.com/webhook/pos-venda-v2

# Secret compartilhado entre ERP e N8N para proteger /api/automations/*
# Gere com: openssl rand -hex 32
N8N_AUTOMATION_SECRET=replace-with-random-secret-32chars
```

---

## Como testar

1. **Context endpoint:** `curl -H "Authorization: Bearer $N8N_AUTOMATION_SECRET" "$ERP_URL/api/automations/post-sale/context?sale_id=123"` — verificar flags e mensagens.
2. **Events endpoint:** POST com `event_type` inválido → espera 422. POST com secret errado → espera 401.
3. **Webhook v2:** criar uma venda no ERP e verificar se o N8N recebe o payload enxuto via `/webhook/pos-venda-v2`.
4. **Idempotência:** criar a mesma venda duas vezes (mock) — segundo webhook não deve inserir segundo `webhook_received`.
5. **is_exchange:** criar uma troca no ERP e verificar que `is_exchange = true` no context e `should_send_cashback_message = false`.
6. **Expiração dinâmica:** verificar `expiry_reminder_wait_until = nearest_cashback_expiry_date - 5d` com diferentes configs de `expiry_days`.
