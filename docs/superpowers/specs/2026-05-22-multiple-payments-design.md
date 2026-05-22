# Múltiplas formas de pagamento — ERP Santtorini

**Data:** 2026-05-22
**Status:** Aprovado — pronto para implementação
**Escopo:** Tabela `sale_payments`, extensão do `rpc_create_sale`, UI do caixa

---

## 1. Contexto e problema

Hoje `sales.payment_method` é um único campo enum (`pix`, `card`, `cash`) que não suporta
vendas com mais de uma forma de pagamento. Loja física precisa de combinações como
Pix + dinheiro, crédito parcelado + Pix, dois cartões, dinheiro com troco via Pix.

---

## 2. Decisões de design

| Decisão | Escolha |
|---|---|
| Troco | `amount_tendered`, `change_amount`, `change_method`, `net_amount` (Opção A) |
| Taxa de cartão | Calculada automaticamente via `payment_fee_settings` (Opção A) |
| Campo legado | `sales.payment_method` = método com maior `net_amount` (Opção A) |
| UX do caixa | Lista acumulativa com "Adicionar pagamento" (Opção A) |
| Arquitetura | Estender `rpc_create_sale` com `p_payments jsonb DEFAULT NULL` (Opção A) |

---

## 3. Schema — banco de dados

### 3.1 Extensão do enum `payment_method`

```sql
-- Verificar valores atuais antes:
-- SELECT enumlabel FROM pg_enum WHERE enumtypid = 'payment_method'::regtype;

DO $$ BEGIN
  BEGIN ALTER TYPE payment_method ADD VALUE 'credit_card';
  EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN ALTER TYPE payment_method ADD VALUE 'debit_card';
  EXCEPTION WHEN duplicate_object THEN NULL; END;
END $$;
```

Valores resultantes: `pix`, `card` (legado), `cash`, `credit_card`, `debit_card`.
O valor `card` permanece para vendas antigas e webhook Nuvemshop — nunca gerado pelo novo frontend.

### 3.2 Tabela `sale_payments`

```sql
CREATE TABLE public.sale_payments (
  id               BIGSERIAL       PRIMARY KEY,
  sale_id          INT             NOT NULL REFERENCES public.sales(id) ON DELETE CASCADE,
  company_id       INT             NOT NULL REFERENCES public.companies(id),
  method           payment_method  NOT NULL,
  amount_tendered  NUMERIC(10,2)   NOT NULL,
  change_amount    NUMERIC(10,2)   NOT NULL DEFAULT 0,
  change_method    TEXT            CHECK (change_method IN ('cash', 'pix')),
  net_amount       NUMERIC(10,2)   NOT NULL,
  installments     INT             NOT NULL DEFAULT 1,
  card_brand       TEXT,
  acquirer         TEXT,
  fee_percentage   NUMERIC(6,4)    NOT NULL DEFAULT 0,
  fee_amount       NUMERIC(10,2)   NOT NULL DEFAULT 0,
  metadata         JSONB           NOT NULL DEFAULT '{}',
  created_by       UUID            REFERENCES public.users(id),
  created_at       TIMESTAMPTZ     NOT NULL DEFAULT NOW(),

  CONSTRAINT sp_net_amount_eq
    CHECK (ROUND(net_amount, 2) = ROUND(amount_tendered - change_amount, 2)),
  CONSTRAINT sp_net_amount_positive    CHECK (net_amount > 0),
  CONSTRAINT sp_change_nonnegative     CHECK (change_amount >= 0),
  CONSTRAINT sp_amount_tendered_gte    CHECK (amount_tendered >= net_amount),
  CONSTRAINT sp_change_method_required CHECK (change_amount = 0 OR change_method IS NOT NULL),
  CONSTRAINT sp_cash_only_change       CHECK (change_amount = 0 OR method = 'cash'),
  CONSTRAINT sp_installments_positive  CHECK (installments >= 1),
  CONSTRAINT sp_installments_credit    CHECK (installments = 1 OR method = 'credit_card')
);

CREATE INDEX idx_sale_payments_sale_id ON public.sale_payments (sale_id);
CREATE INDEX idx_sale_payments_company ON public.sale_payments (company_id, created_at DESC);
```

**Campo `metadata`:** reservado para integração futura com adquirentes (NSU, auth_code, terminal_id, etc.).
**Campo `change_method`:** TEXT com CHECK constraint; preparado para migração para enum futuro sem mudança de semântica.

### 3.3 Função helper `get_dominant_payment_method`

Usada pelo RPC e por relatórios. Fallback automático para vendas sem `sale_payments` (legadas).

```sql
CREATE OR REPLACE FUNCTION public.get_dominant_payment_method(p_sale_id int)
RETURNS payment_method LANGUAGE plpgsql STABLE AS $$
DECLARE v_method payment_method;
BEGIN
  -- Fonte de verdade: sale_payments (vendas novas)
  SELECT method INTO v_method
  FROM public.sale_payments
  WHERE sale_id = p_sale_id
  ORDER BY net_amount DESC LIMIT 1;

  -- Fallback: sales.payment_method (vendas legadas sem sale_payments)
  IF v_method IS NULL THEN
    SELECT payment_method INTO v_method
    FROM public.sales WHERE id = p_sale_id;
  END IF;

  RETURN v_method;
END;
$$;
```

---

## 4. RPC — `rpc_create_sale`

### 4.1 Novo parâmetro

```sql
p_payments jsonb DEFAULT NULL
```

Adicionado como último parâmetro com default, sem quebrar nenhuma chamada existente.

### 4.2 Formato de `p_payments`

```json
[
  {
    "method": "cash",
    "amount_tendered": 100.00,
    "change_amount": 20.00,
    "change_method": "pix",
    "net_amount": 80.00
  },
  {
    "method": "credit_card",
    "amount_tendered": 200.00,
    "change_amount": 0,
    "net_amount": 200.00,
    "installments": 3,
    "card_brand": "visa",
    "acquirer": "stone",
    "metadata": {}
  }
]
```

Campos obrigatórios: `method`, `amount_tendered`, `net_amount`.
Campos condicionais: `change_amount`/`change_method` se `cash`; `installments` se `credit_card`.

### 4.3 Fluxo novo (`p_payments IS NOT NULL`)

```
1. Calcular v_total normalmente (subtotal − desconto + frete + surcharge − cashback)

2. Validar cada payment:
   ├── method IN ('pix','cash','credit_card','debit_card')
   ├── net_amount > 0
   ├── amount_tendered >= net_amount
   ├── ROUND(amount_tendered − change_amount, 2) = ROUND(net_amount, 2)
   ├── change_amount > 0 → change_method IS NOT NULL
   ├── change_amount > 0 → method = 'cash'
   └── installments > 1 → method = 'credit_card'

3. Validar fechamento:
   ABS(SUM(net_amount) - v_total) > 0.01 → RAISE EXCEPTION

4. Determinar método dominante (maior net_amount) → sales.payment_method

5. INSERT em sales com payment_method = dominante (inalterado nos demais campos)

6. INSERT em sale_items + UPDATE stock (lógica idêntica ao legado)

7. Para cada payment:
   ├── Se credit_card ou debit_card:
   │   ├── Lookup em payment_fee_settings:
   │   │   WHERE company_id = v_company_id
   │   │     AND payment_method = CASE
   │   │           WHEN method IN ('credit_card','debit_card') THEN 'card'
   │   │           ELSE method::text END
   │   │     AND installments = COALESCE(pmt.installments, 1)
   │   ├── Se NOT FOUND → fee_percentage = 0, RAISE WARNING (não bloqueia)
   │   ├── fee_amount = ROUND(net_amount * fee_percentage / 100, 2)
   │   └── INSERT finance_entry (expense, 'card_fee') quando fee_amount > 0
   └── INSERT em sale_payments

8. Lógica de cashback (inalterada)

9. INSERT finance_entry de receita da venda (inalterado)

10. RETURN jsonb com sale_id, sale_number, total_payments inseridos
```

### 4.4 Fluxo legado (`p_payments IS NULL`)

Comportamento 100% idêntico ao atual. Adiciona automaticamente **uma linha** em `sale_payments`
para uniformizar relatórios futuros:

```sql
INSERT INTO sale_payments (
  sale_id, company_id, method,
  amount_tendered, change_amount, net_amount,
  installments, fee_percentage, fee_amount,
  metadata, created_by
) VALUES (
  v_sale_id, v_company_id, p_payment_method,
  v_total, 0, v_total,
  1,
  ROUND(p_card_fee / NULLIF(v_total, 0) * 100, 4),  -- fee_percentage back-calculado
  p_card_fee,
  '{}', p_system_user_id
);
```

### 4.5 Garantias de atomicidade

Todo o bloco (sales + sale_items + stock + sale_payments + finance_entries) roda na mesma
transação existente. Falha em qualquer INSERT reverte a venda inteira.

### 4.6 Compatibilidade

| Chamador | Impacto |
|---|---|
| Webhook Nuvemshop | Nenhum — `p_payments` vem NULL, path legado ativo |
| Wrapper de compatibilidade existente | Nenhum — parâmetro com DEFAULT NULL |
| Vendas antigas já no banco | Nenhum — `sale_payments` criada sem retroativo |
| Frontend novo | Envia `payments[]`, não envia `payment_method` explicitamente |

---

## 5. Frontend e API

### 5.1 Validação (`src/lib/validators/index.ts`)

```typescript
export const paymentEntrySchema = z.object({
  method:          z.enum(['pix', 'cash', 'credit_card', 'debit_card']),
  amount_tendered: z.number().positive(),
  change_amount:   z.number().min(0).default(0),
  change_method:   z.enum(['cash', 'pix']).optional(),
  net_amount:      z.number().positive(),
  installments:    z.number().int().min(1).max(12).default(1),
  card_brand:      z.string().optional(),
  acquirer:        z.string().optional(),
  metadata:        z.record(z.unknown()).default({}),
})
.refine(d => d.amount_tendered >= d.net_amount,
  { message: 'Valor recebido deve ser maior ou igual ao valor cobrado' })
.refine(d => Math.abs(d.amount_tendered - d.change_amount - d.net_amount) < 0.01,
  { message: 'Troco incoerente com os valores informados' })
.refine(d => d.change_amount === 0 || d.change_method != null,
  { message: 'Informe a forma do troco' })
.refine(d => d.change_amount === 0 || d.method === 'cash',
  { message: 'Troco só é permitido em pagamentos em dinheiro' })
.refine(d => d.installments === 1 || d.method === 'credit_card',
  { message: 'Parcelamento só é permitido em cartão de crédito' })

export type PaymentEntry = z.infer<typeof paymentEntrySchema>
```

### 5.2 API route (`src/app/api/vendas/route.ts`)

```typescript
const schema = z.object({
  customer_id:    z.number().int().positive(),
  payment_method: z.enum(['pix', 'card', 'cash', 'credit_card', 'debit_card']).optional(),
  payments:       z.array(paymentEntrySchema).min(1).optional(),
  // demais campos inalterados…
})
.refine(
  d => d.payment_method != null || (d.payments && d.payments.length > 0),
  { message: 'Informe payment_method (legado) ou payments (novo)' }
)
```

Derivação do método dominante quando `payments` é fornecido:
```typescript
const dominant = parsed.data.payments
  ?.reduce((max, p) => p.net_amount > max.net_amount ? p : max)
  .method ?? parsed.data.payment_method
```

### 5.3 Estado local (`vendas/nova/page.tsx`)

```typescript
type PaymentDraft = PaymentEntry & { _id: string } // _id só existe no cliente

const [payments, setPayments]   = useState<PaymentDraft[]>([])
const [showForm, setShowForm]   = useState(false)

const saleTotal     = subtotal - discount + shipping + surcharge - cashbackUsed
const totalPaid     = payments.reduce((s, p) => s + p.net_amount, 0)
const saldoRestante = Math.max(0, saleTotal - totalPaid)
const canFinalize   = Math.abs(saleTotal - totalPaid) < 0.01
```

### 5.4 Regras de UX

- `net_amount` no formulário padrão vem pré-preenchido com `saldoRestante`
- Bloquear "Adicionar" quando `totalPaid + net_amount > saleTotal` — excesso só é
  permitido via `amount_tendered` (dinheiro) tratado como troco, nunca como `net_amount`
- `pix`, `credit_card`, `debit_card`: `amount_tendered = net_amount` (campo oculto)
- `cash`: campo `amount_tendered` separado (≥ `net_amount`), `change_amount` calculado
- `change_method` só aparece quando `change_amount > 0`
- `installments` só aparece para `credit_card`
- `card_brand` e `acquirer` opcionais para `credit_card` e `debit_card`
- Remoção por botão `✕` — sem edição inline, remove e re-adiciona
- Botão "Finalizar venda" desabilitado com tooltip enquanto `saldoRestante > 0.01`
- Frontend **nunca** envia `method = 'card'` — apenas `credit_card` ou `debit_card`

### 5.5 Detalhe da venda (`vendas/[id]/page.tsx`)

Exibir por pagamento: método, valor recebido, troco, líquido, parcelas, taxa aplicada.

```
Pagamentos
─────────────────────────────────────────────
Pix                Líquido: R$ 150,00
Crédito 3×         Líquido: R$ 130,00
                   Recebido: R$ 130,00
                   Taxa: 2,5% (R$ 3,25)
                   Mastercard · Stone
─────────────────────────────────────────────
```

Para troco:
```
Dinheiro           Recebido: R$ 100,00
                   Troco via Pix: R$ 20,00
                   Líquido: R$ 80,00
```

---

## 6. Arquivos alterados

| Arquivo | Mudança |
|---|---|
| `supabase/migrations/20260522_sale_payments.sql` | Enum + tabela + helper function |
| `src/lib/validators/index.ts` | `paymentEntrySchema`, `PaymentEntry` |
| `src/types/database.types.ts` | Tipo `SalePayment` |
| `src/services/vendas.service.ts` | `sale_payments` no tipo de resposta |
| `src/app/api/vendas/route.ts` | `payment_method` opcional, aceita `payments[]` |
| `src/app/(dashboard)/vendas/nova/page.tsx` | Step 2 com lista acumulativa |
| `src/app/(dashboard)/vendas/[id]/page.tsx` | Exibe `sale_payments` no detalhe |
| `src/lib/db/migrations/000_schema_completo.sql` | RPC atualizado com `p_payments` |

---

## 7. Checklist de testes

### Banco / RPC

- [ ] Venda com pagamento único Pix (path legado, `p_payments = null`) — comportamento inalterado
- [ ] Venda com pagamento único via `payments[]` (Pix) — `sale_payments` criada, `payment_method = 'pix'`
- [ ] Venda Pix R$150 + Crédito R$130 — `payment_method = 'pix'` (dominante)
- [ ] Venda Dinheiro R$100 (net R$80) + troco R$20 via Pix — `change_method = 'pix'`
- [ ] Venda Crédito 3× — `fee_amount` calculado, `finance_entry` de despesa criada
- [ ] Venda com `SUM(net_amount) ≠ total` — RAISE EXCEPTION
- [ ] Venda com `amount_tendered < net_amount` — constraint viola, rollback
- [ ] Venda com `change_amount > 0` sem `change_method` — constraint viola, rollback
- [ ] Venda com `installments = 3` e `method = 'pix'` — constraint viola, rollback
- [ ] Taxa não encontrada em `payment_fee_settings` — WARNING, taxa = 0, venda prossegue
- [ ] Webhook Nuvemshop após migration — comportamento inalterado

### Frontend

- [ ] Step 2 abre com lista vazia e saldo = total da venda
- [ ] Adicionar Pix de R$150 — saldo atualiza para R$130
- [ ] Adicionar Crédito R$130 — saldo = R$0, botão "Finalizar" habilita
- [ ] Tentar adicionar pagamento quando `totalPaid + net_amount > saleTotal` — bloqueado
- [ ] Dinheiro: campo `amount_tendered` aceita valor maior que `net_amount`
- [ ] Dinheiro: troco calculado automaticamente, `change_method` obrigatório quando > 0
- [ ] Crédito: campo `installments` obrigatório, `card_brand`/`acquirer` opcionais
- [ ] Remover pagamento da lista — saldo volta ao valor anterior
- [ ] Finalizar sem fechar saldo — botão desabilitado com tooltip correto
- [ ] Detalhe da venda exibe todos os pagamentos com campos corretos

### Regressão

- [ ] Venda simples pelo fluxo antigo (sem `payments[]`) — sem mudança visível
- [ ] Relatório de vendas — `sales.payment_method` continua populado corretamente
- [ ] Webhook Nuvemshop — processa pedido sem erro após migration

---

## 8. Rollback

Em caso de problema após aplicar a migration:

```sql
-- 1. Remover tabela (seguro, sem dados históricos afetados)
DROP TABLE IF EXISTS public.sale_payments CASCADE;

-- 2. Remover função helper
DROP FUNCTION IF EXISTS public.get_dominant_payment_method(int);

-- 3. Reverter RPC para versão anterior (manter backup antes de aplicar)
-- Os valores 'credit_card' e 'debit_card' adicionados ao enum NÃO podem ser
-- removidos no PostgreSQL, mas não causam problema — simplesmente não serão usados.
```

> **Nota:** valores adicionados a enums PostgreSQL são irreversíveis via SQL padrão.
> Se for crítico reverter o enum, requer pg_dump + recriação da coluna, o que é destrutivo.
> Recomendação: testar a migration em staging antes de produção.

---

## 9. Fora de escopo (próximos specs)

- **Abertura e fechamento de caixa** — subsistema independente que consome `sale_payments`
  como fonte de dados para o fechamento. Spec separado.
- Integração com adquirentes via `metadata` (NSU, auth_code)
- Migração retroativa de vendas antigas para `sale_payments`
- Relatório detalhado por forma de pagamento
- Migração de `change_method` para enum PostgreSQL
