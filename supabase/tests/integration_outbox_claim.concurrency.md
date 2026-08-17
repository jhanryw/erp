# Teste manual de concorrência — `rpc_claim_outbox_events`

Um único script SQL é sequencial por natureza — não produz concorrência real.
O procedimento abaixo usa **dois terminais `psql` separados** contra o mesmo
banco de **teste** (nunca produção) pra observar `FOR UPDATE SKIP LOCKED`
funcionando de verdade: dois workers concorrentes nunca devem processar o
mesmo evento.

Nenhum worker real consome `integration_outbox` nesta fase (proibido
explicitamente) — este teste existe só pra provar que o desenho suporta
múltiplos workers futuros sem processar o mesmo evento duas vezes, conforme
pedido explicitamente na Fase 2 (seção 30).

Pré-requisito: migration `20260817_integration_foundation_schema.sql`
aplicada.

## 1. Fixture — 2 eventos `pending`

Rode uma vez, em qualquer terminal (fora de transação, comita direto):

```sql
INSERT INTO public.integration_outbox (company_id, event_id, event_type, aggregate_type, aggregate_id, payload)
VALUES
  (1, 'teste:concorrencia:1', 'sale.completed', 'sale', '999001', '{}'::jsonb),
  (1, 'teste:concorrencia:2', 'sale.completed', 'sale', '999002', '{}'::jsonb);
```

## 2. Corrida de claim — SKIP LOCKED nunca entrega o mesmo evento duas vezes

**Terminal A:**
```sql
BEGIN;
SELECT * FROM public.rpc_claim_outbox_events(1, 'worker-A');
-- Anote o event_id retornado (ex.: 'teste:concorrencia:1' ou '...:2').
-- NÃO dê COMMIT/ROLLBACK ainda — a linha claimada continua travada (FOR
-- UPDATE dentro da função) enquanto esta transação estiver aberta. Vá para
-- o Terminal B agora.
```

**Terminal B (enquanto A ainda não deu COMMIT/ROLLBACK):**
```sql
BEGIN;
SELECT * FROM public.rpc_claim_outbox_events(1, 'worker-B');
```

**Resultado esperado em B:** retorna **imediatamente** (não fica pendurado —
essa é a diferença de `SKIP LOCKED` pra um `FOR UPDATE` comum) com o **OUTRO**
`event_id` — nunca o mesmo que A já reivindicou. Se só houvesse 1 linha
`pending` na fixture, B retornaria **zero linhas** (nunca a mesma linha
travada por A).

```sql
COMMIT; -- finalize o Terminal B
```

**Terminal A — finalize:**
```sql
COMMIT;
```

## 3. Confirmar estado final

Em qualquer terminal, fora de transação:
```sql
SELECT event_id, status, attempts, locked_by FROM public.integration_outbox
WHERE event_id IN ('teste:concorrencia:1', 'teste:concorrencia:2')
ORDER BY event_id;
```
**Esperado:** as duas linhas com `status='processing'`, `attempts=1`,
`locked_by` diferente entre elas (`worker-A` numa, `worker-B` na outra) —
prova que cada evento foi processado por exatamente 1 worker.

## 4. Limpeza

```sql
DELETE FROM public.integration_outbox WHERE event_id IN ('teste:concorrencia:1', 'teste:concorrencia:2');
```

## Conclusão a registrar após rodar

- [ ] B não ficou pendurado esperando A (comportamento de `SKIP LOCKED`, diferente de `FOR UPDATE` puro).
- [ ] B recebeu um evento DIFERENTE do que A reivindicou (nunca o mesmo).
- [ ] Estado final: as 2 linhas `processing`, `locked_by` distintos, `attempts=1` cada.
