# Pós-Venda v2 — Plano de Implementação

**Spec:** `2026-07-04-pos-venda-v2-design.md`  
**Ordem:** sequencial — cada passo depende do anterior.

---

## Passo 1 — Migration: `post_sale_automation_events`

**Arquivo:** `supabase/migrations/20260704_post_sale_automation_events.sql`

Criar a tabela com:
- `company_id NOT NULL`
- `created_at` sempre preenchido, `sent_at` nullable
- CHECK constraint nos valores de `event_type`
- Índice único `uq_post_sale_webhook_received` em `(sale_id, event_type) WHERE event_type = 'webhook_received'`
- Índices de consulta em `(sale_id, created_at DESC)` e `(company_id, created_at DESC)`
- RLS: `service_role` full access, `authenticated` leitura por `company_id`

---

## Passo 2 — Lib de contexto: `post-sale-context.ts`

**Arquivo:** `src/lib/automations/post-sale-context.ts`

Função principal: `getPostSaleContext(saleId: number): Promise<PostSaleContext>`

Queries necessárias (todas via admin client):
1. `sales` — busca venda: `id, customer_id, sale_date, sale_origin, company_id, status`
2. `customers` — busca cliente: `name, phone, is_anonymous`
3. `cashback_transactions` — detecta `is_exchange` (type='use', used_in_sale_id=sale_id, exchange_id NOT NULL)
4. `cashback_transactions` — cashback gerado por esta venda (type='earn', sale_id=sale_id)
5. `cashback_transactions` — cashback usado nesta venda (type='use', used_in_sale_id=sale_id)
6. `v_cashback_balance` — saldo atual (customer_id + company_id)
7. `cashback_transactions` — nearest_cashback_expiry_date (earn, available, expiry_date NOT NULL, > hoje, mínima)
8. `sales` — purchased_again_within_30_days (customer_id, id != sale_id, sale_date entre original e original+30d, status NOT IN cancelled/returned)
9. `post_sale_automation_events` — eventos já enviados para este sale_id (idempotência dos flags)

Cálculos:
- `expiry_reminder_wait_until = nearest_cashback_expiry_date - 5 dias` (null se sem expiry)
- Todos os flags (`should_send_*`) conforme tabela do spec
- `skip_reasons` para cada flag false
- `messages` — três textos prontos (cashback, csat, expiry_reminder), null quando não aplicável

Exportar também o tipo `PostSaleContext` (TypeScript interface completa).

---

## Passo 3 — Endpoint de contexto

**Arquivo:** `src/app/api/automations/post-sale/context/route.ts`

```
GET /api/automations/post-sale/context?sale_id=X
Authorization: Bearer <N8N_AUTOMATION_SECRET>
```

- Valida header contra `process.env.N8N_AUTOMATION_SECRET` → 401 se inválido
- Valida `sale_id` como inteiro positivo → 422 se inválido
- Chama `getPostSaleContext(saleId)`
- Se venda não encontrada → 404
- Retorna JSON completo conforme contrato do spec

---

## Passo 4 — Endpoint de eventos

**Arquivo:** `src/app/api/automations/post-sale/events/route.ts`

```
POST /api/automations/post-sale/events
Authorization: Bearer <N8N_AUTOMATION_SECRET>
```

Schema Zod:
```typescript
{
  sale_id:          z.number().int().positive(),
  customer_id:      z.number().int().positive().optional(),
  event_type:       z.enum([...lista completa...]),
  skip_reason:      z.string().optional(),
  n8n_execution_id: z.string().optional(),
  message:          z.string().optional(),
  context_snapshot: z.record(z.unknown()).optional(),
}
```

Lógica:
- Valida secret → 401
- Valida body via Zod → 422
- Resolve `company_id` via `sales.company_id` pelo `sale_id` → 404 se não encontrar
- Preenche `sent_at = NOW()` automaticamente quando `event_type IN ('cashback_message_sent', 'csat_sent', 'expiry_reminder_sent')`
- Insere em `post_sale_automation_events`
- Retorna `{ ok: true, id: <bigint> }`

---

## Passo 5 — Webhook v2 em `vendas/route.ts`

**Arquivo:** `src/app/api/vendas/route.ts` (modificação cirúrgica)

Adicionar função `sendSaleWebhookV2()` paralela à `sendSaleWebhook()` existente:
- Lê `process.env.N8N_WEBHOOK_URL_V2` — se ausente, retorna silenciosamente
- Verifica idempotência via `post_sale_automation_events` (event_type='webhook_received', sale_id)
- Busca `customer_phone` e `is_anonymous` do cliente
- Posta payload enxuto para `N8N_WEBHOOK_URL_V2`:
  ```json
  { "sale_id": 123, "customer_phone": "...", "is_anonymous": false, "sale_date": "..." }
  ```
- Insere `webhook_received` em `post_sale_automation_events` (independente do status HTTP)
- Fire-and-forget via `.catch()` — não bloqueia response da venda

Na mesma linha onde `sendSaleWebhook()` é chamado, adicionar `sendSaleWebhookV2()` em paralelo. **Não modificar nada de `sendSaleWebhook()` nem `webhook_log`.**

---

## Passo 6 — Variáveis de ambiente

**Arquivo:** `.env.example`

Adicionar após a seção de N8N existente:
```bash
# Webhook v2 — URL do N8N (novo endpoint, não conflita com v1)
N8N_WEBHOOK_URL_V2=https://seu-n8n.com/webhook/pos-venda-v2

# Secret para endpoints /api/automations/* chamados pelo N8N
# Gere com: openssl rand -hex 32
N8N_AUTOMATION_SECRET=replace-with-random-secret-32chars
```

---

## Passo 7 — Build e TypeScript

```bash
npx tsc --noEmit
rm -rf .next && npm run build
```

Erros esperados a ignorar: pré-existente em `/recuperar-acesso` (NEXT_PUBLIC_SUPABASE_URL no build).

---

## Passo 8 — Commit

```
feat: pós-venda v2 — context + events endpoints + webhook v2 paralelo

- Migration: post_sale_automation_events com idempotência por sale_id
- GET /api/automations/post-sale/context — contexto completo com flags,
  skip_reasons e mensagens prontas; nunca calcula cashback localmente
- POST /api/automations/post-sale/events — log de eventos do fluxo N8N
- sendSaleWebhookV2() paralela em POST /api/vendas, sem alterar v1
- is_exchange detectado via cashback_transactions.exchange_id
- purchased_again_within_30_days ignora própria venda e canceladas/devolvidas
- Flags consultam eventos já enviados para evitar reenvio (already_sent)
```

---

## Passo 9 — JSON do fluxo N8N v2

**Arquivo:** `[SANTTORINI] Pós venda v2.json` (para importar no N8N)

Nós necessários (baseados no padrão Evolution API do fluxo antigo):
1. **Webhook Trigger** — `/webhook/pos-venda-v2`
2. **HTTP Request** — POST `/api/automations/post-sale/events` (webhook_received)
3. **HTTP Request** — GET `/api/automations/post-sale/context?sale_id={{$json.sale_id}}`
4. **IF** — `should_send_cashback_message`
5. **Evolution: Send Message** — `messages.cashback`
6. **HTTP Request** — POST events (cashback_message_sent ou skipped)
7. **Wait** — 7 dias
8. **HTTP Request** — GET context (nova consulta)
9. **IF** — `should_send_csat`
10. **Evolution: Send Message** — `messages.csat`
11. **HTTP Request** — POST events (csat_sent ou skipped)
12. **IF** — `should_schedule_expiry_reminder`
13. **Wait** — até `expiry_reminder_wait_until` (date/time do campo)
14. **HTTP Request** — GET context (nova consulta)
15. **IF** — `should_send_expiry_reminder`
16. **Evolution: Send Message** — `messages.expiry_reminder`
17. **HTTP Request** — POST events (expiry_reminder_sent ou skipped)
18. **No Operation** — flow_ended_no_expiry (com log)

---

## Checklist de testes

- [ ] `curl` no context endpoint com `sale_id` válido → resposta completa
- [ ] `curl` com secret errado → 401
- [ ] `curl` com `sale_id` inexistente → 404
- [ ] POST events com `event_type` inválido → 422
- [ ] Criar venda → verificar `webhook_received` em `post_sale_automation_events`
- [ ] Recriar mesma venda → segundo `webhook_received` não inserido (idempotência)
- [ ] Venda com cashback gerado → `cashback_generated_by_this_sale > 0`, `should_send_cashback_message = true`
- [ ] Troca → `is_exchange = true`, `should_send_cashback_message = false`
- [ ] Cliente sem telefone → `should_send_csat = false`, `skip_reason = missing_phone`
- [ ] Recompra em 15 dias → `purchased_again_within_30_days = true`
- [ ] Cashback com expiry em 6 dias → `should_send_expiry_reminder = true`
- [ ] Cashback sem expiry → `should_schedule_expiry_reminder = false`, `expiry_reminder_wait_until = null`
- [ ] Cashback já enviado → segundo context retorna `should_send_cashback_message = false`, `skip_reason = already_sent`
