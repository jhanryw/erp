# Teste manual de concorrência — `rpc_claim_event_deliveries`

Mesmo espírito e procedimento de `integration_outbox_claim.concurrency.md`
(Fase 2), agora escopado por **destino** — dois workers do MESMO destino
(`chatwoot`) nunca devem reivindicar a mesma linha de delivery.

Nenhum worker real consome `integration_event_deliveries` nesta fase além
de `consumeChatwootDeliveries()` chamada manualmente por teste — nenhum
scheduler foi criado (proibido explicitamente, seção 52 do pedido da Fase
4).

Pré-requisito: migration `20260818_integration_event_deliveries.sql`
aplicada.

## 1. Fixture — 1 evento outbox + 2 deliveries `pending` do mesmo destino

```sql
INSERT INTO public.integration_outbox (company_id, event_id, event_type, aggregate_type, aggregate_id, payload, status)
VALUES (1, 'teste:delivery-concorrencia:1', 'sale.completed', 'sale', '999003', '{}'::jsonb, 'dispatched')
RETURNING id \gset outbox_

INSERT INTO public.integration_event_deliveries (outbox_event_id, company_id, destination)
VALUES
  (:outbox_id, 1, 'chatwoot'),
  (:outbox_id, 1, 'chatwoot'); -- simula 2 deliveries pendentes do mesmo destino (não é o caso real de 1 evento -> 1 delivery por destino, só pra ter 2 linhas pra disputar)
```
(Se seu `psql` não suportar `\gset`, rode o `INSERT INTO integration_outbox` separado, anote o `id` retornado manualmente e substitua `:outbox_id` pelo valor literal nos dois `INSERT`s de delivery abaixo.)

## 2. Corrida de claim — SKIP LOCKED nunca entrega a mesma linha duas vezes

**Terminal A:**
```sql
BEGIN;
SELECT * FROM public.rpc_claim_event_deliveries('chatwoot', 1, 'worker-A');
-- Anote o id retornado. NÃO dê COMMIT/ROLLBACK ainda.
```

**Terminal B (enquanto A ainda não deu COMMIT/ROLLBACK):**
```sql
BEGIN;
SELECT * FROM public.rpc_claim_event_deliveries('chatwoot', 1, 'worker-B');
```

**Resultado esperado em B:** retorna imediatamente com a **outra** linha de
delivery — nunca a mesma que A já reivindicou.

```sql
COMMIT; -- Terminal B
```

**Terminal A:**
```sql
COMMIT;
```

## 3. Confirmar estado final

```sql
SELECT id, status, attempts, locked_by FROM public.integration_event_deliveries
WHERE outbox_event_id = <id anotado>
ORDER BY id;
```
**Esperado:** as duas linhas `processing`, `attempts=1`, `locked_by`
diferente entre elas.

## 4. Limpeza

```sql
DELETE FROM public.integration_event_deliveries WHERE outbox_event_id = <id anotado>;
DELETE FROM public.integration_outbox WHERE event_id = 'teste:delivery-concorrencia:1';
```

## Conclusão a registrar após rodar

- [ ] B não ficou pendurado esperando A.
- [ ] B recebeu a linha DIFERENTE da que A reivindicou.
- [ ] Estado final: as 2 linhas `processing`, `locked_by` distintos.
