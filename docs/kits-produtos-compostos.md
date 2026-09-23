# Kits / Produtos Compostos — relatório de entrega (2026-09-23)

## 1. Arquitetura implementada

- **Kit é produto do catálogo**: `products.product_kind` (`standard` | `kit`, default `standard`, imutável após criação). Nenhuma tabela paralela de produtos.
- **Composição por variação vendável**: `product_kit_components (kit_product_variation_id → component_product_variation_id × quantity)`.
- **Kit nunca tem saldo físico**: trigger `trg_block_kit_stock_balances` em `stock_balances` barra QUALQUER escrita para variação de kit (entrada, ajuste, transferência simples/lote, inventário, inicialização, cancelamento, devolução, troca, RPC futura).
- **Disponibilidade derivada** num único lugar do banco: `fn_variation_sellable_quantity(company, variação, modo)` — normal = saldo; kit = `MIN(floor(disponível_componente / qtd_por_kit))`. Mesma regra de locais de `rpc_create_sale` (`main_store` = Estoque Loja/PDV; `online_priority` = locais ativos).
- **Camada central TS**: `src/services/inventory/availability.service.ts` (`getSellableQuantity`, `getVariationAvailability`, `resolveStockRequirementsForItems`, `getKitCompositionDetails`, `getAffectedSellableVariationIds`) + funções puras espelho em `src/lib/inventory/stockRequirements.ts`. Nenhuma integração conhece a fórmula do kit.
- **Venda**: item COMERCIAL continua em `sale_items` (SKU/qtd/preço do kit); consumo físico vai para `sale_item_components` (snapshot imutável: composição, custo, local de origem).
- **Evento de estoque**: fila de domínio `stock_availability_changes` alimentada por trigger em `stock_balances` (variação + kits dependentes, na mesma transação) → consumidor `rpc_process_stock_availability_changes` → cache derivado `variation_availability` (quantidade vendável publicada, transições vendável↔indisponível). Ponto de nascimento das deliveries do futuro Marketplace Hub.

## 2. Migrations (todas aditivas, idempotentes, aplicadas 2× sem erro)

| Arquivo | Conteúdo |
|---|---|
| `202609231000_product_kits_foundation.sql` | `products.product_kind` (+CHECK NOT VALID/VALIDATE, índice parcial, trigger de imutabilidade); `product_kit_components` (+validação, constraint triggers "≥1 componente" no COMMIT); guard de saldo de kit; `sale_item_components`; `fn_physical_available_quantity`, `fn_variation_sellable_quantity`, `rpc_get_variation_availability`; fila `stock_availability_changes` + triggers (estoque, composição, ativação manual); cache `variation_availability` + `rpc_process_stock_availability_changes` (SKIP LOCKED, recupera `processing` preso >5min, retenção 7 dias); RLS deny-by-default. |
| `202609231100_rpc_create_sale_kits.sql` | `fn_resolve_stock_requirements`, `_consume_kit_components`, `rpc_create_sale` (mesma assinatura de 19 parâmetros). |
| `202609231200_rpc_cancel_return_exchange_kits.sql` | `_restore_kit_components`, `rpc_cancel_sale`, `rpc_return_sale`, `rpc_process_exchange` (assinaturas inalteradas). |
| `202609231300_kit_management_rpcs.sql` | `rpc_create_kit_product`, `rpc_add_kit_variations`, `rpc_set_kit_components` (+ helpers internos). |

## 3. Tabelas e colunas criadas

- `products.product_kind TEXT NOT NULL DEFAULT 'standard'`
- `product_kit_components` (id, company_id, kit_product_variation_id, component_product_variation_id, quantity, created_at, updated_at, created_by) — UNIQUE(kit, componente), CHECK quantity>0, CHECK kit≠componente, índice por componente ("quais kits usam esta variação").
- `sale_item_components` (company_id, sale_id, sale_item_id, kit_product_variation_id, component_product_variation_id, stock_location_id, quantity_per_kit, kit_quantity, total_quantity, quantity, unit_cost, created_at).
- `stock_availability_changes` (fila), `variation_availability` (cache derivado — NÃO é estoque).

## 4. Regras

**Disponibilidade**: kit = MIN(capacidade dos componentes), por variação (KIT M indisponível não afeta P/G), nunca negativo, 0 sem componentes. Kits compartilhando componente mostram disponibilidades independentes (kits não reservam); qualquer venda muda o saldo real e todos os kits dependentes são recalculados. `active` do componente NÃO afeta o kit (consumo físico).

**Vendável** = `manual_enabled` (products.active ∧ variation.active) ∧ `inventory_available` (quantidade > 0). Nenhuma rotina escreve em `active` — reposição nunca reativa algo desativado manualmente.

**Venda (rpc_create_sale)**: sem kit no carrinho → caminho idêntico ao anterior. Com kit: requisitos físicos agregados (kit + componente avulso somam) → locks `FOR UPDATE` em ordem (variação, local) → validação de TODOS os requisitos → baixa → movimentos por componente (`notes = 'Componente do kit <SKU>'`) → snapshot. Falta de qualquer componente = ROLLBACK completo. Custo do kit = Σ(custo componente × qtd), calculado na RPC (payload ignorado para kit); custo do componente = `cost_override ?? base_cost` (mesma fonte do resto do sistema; nunca tabela legada `stock`).

**Cancelamento**: componentes voltam ao **local de origem** registrado no snapshot; nunca cria saldo para o kit; idempotente (guard de status). **Devolução total e troca**: componentes voltam ao Estoque Loja (regra física já vigente). Troca opera em **kits inteiros** — devolver "1 das 3 calcinhas" é impossível por construção (política de devolução parcial de componente fica fora da V1). Produtos normais: comportamento inalterado.

**Reposição**: qualquer origem que mude `stock_balances` (entrada, ajuste, transferência, inventário, cancelamento, devolução, troca, venda PDV/online, RPC, importação futura) enfileira o componente e seus kits pelo trigger — sem lógica em rotas. A disponibilidade exibida é sempre ao vivo; o cache é atualizado pelo job.

## 5. Arquivos

**Novos**: `src/lib/inventory/stockRequirements.ts` (+test), `src/services/inventory/availability.service.ts` (+test), `src/services/kits.service.ts`, `src/services/vendas.kits.test.ts`, `src/app/api/produtos/kits/{route.ts,schema.ts,schema.test.ts}`, `src/app/api/produtos/kits/[id]/variacoes/route.ts`, `src/app/api/produtos/kits/variacoes/[variationId]/componentes/route.ts`, `src/app/api/produtos/kits/componentes/buscar/route.ts`, `src/app/api/jobs/stock-availability/run/route.ts`, `src/components/produtos/{kit-components-editor,kit-composition-panel,kit-add-variation}.tsx`, `src/app/(dashboard)/produtos/kits/novo/page.tsx`, `supabase/tests/product_kits.test.sql`, `supabase/tests/product_kits.concurrency.sh`.

**Alterados**: `src/services/vendas.service.ts` (pré-checagem e custo de kit), `src/services/produtos.service.ts` (bloqueia excluir componente em uso), `src/app/api/produtos/[id]/route.ts` (GET devolve `product_kind` + composição; PUT bloqueia variação genérica em kit e exclusão de componente em uso), `src/app/api/produtos/buscar/*` + `src/components/vendas/ProductSearchInput.tsx` (kits no PDV com disponibilidade derivada), `src/lib/services/nuvemshopSyncService.ts` (quantidade via camada central + propagação a variações afetadas), rotas `src/app/api/estoque/{entrada,ajuste,inventario,transferencia,transferencia/bulk}` e webhook Nuvemshop (usam a propagação genérica), telas de estoque (kit como "estoque derivado"; excluído de entrada/ajuste/inventário), produtos (selo Kit, botão Novo Kit, composição no detalhe e no editor), `src/services/wholesale/adminList.ts`.

**Correção de segurança colateral**: `/produtos/[id]` lia o produto por id via service role **sem filtro de empresa** (qualquer usuário logado abria produto de outro tenant). Agora exige sessão e filtra `company_id`.

## 6. Decisões

1. `product_kind` imutável (trocar standard↔kit com saldo/vendas geraria estado ambíguo).
2. Kit criado por tela própria com SKU digitado — o gerador tipo/modelo/ano não se aplica a composto. `tipo='kit'`, `modelo='kit'`, `base_cost=0` (custo é derivado).
3. Duplicatas de componente são consolidadas por soma, determinística (UI, TS e RPC).
4. Fila própria em vez de `integration_outbox`: evitar que milhares de eventos de estoque atrasem `sale.*` do Chatwoot (FIFO único). Migrar/fan-out para canais quando o Marketplace Hub existir.
5. Cancelamento de kit → local de origem; devolução/troca → Estoque Loja.
6. Nuvemshop passa a perguntar "quantidade vendável" à camada central — sem `if kit` na integração.

## 7. Limitações da V1

- Kit dentro de kit proibido; devolução parcial de componente interno inexistente (troca/devolução só em kits inteiros).
- Sem reserva de estoque (kits concorrem pelo saldo real; a transação decide).
- Cancelamento de item **normal** continua voltando ao Estoque Loja (débito pré-existente, não alterado).
- Devolução/troca não propagam estoque à Nuvemshop (débito pré-existente, igual para kit e normal).
- Sync de produtos Nuvemshop (`products/sync`, `product`) ainda lê a tabela legada `stock` na criação (kit nasce com 0 e é corrigido no próximo push).
- Nenhum agendamento criado para `/api/jobs/stock-availability/run` — precisa ser registrado no cron (EasyPanel ou pg_cron). Não é necessário para vender corretamente.
- `sku_variation` continua UNIQUE global (não por empresa) — herdado.

## 8. Testes e verificação

- **SQL (`product_kits.test.sql`)**: 97 asserções, todas passando, cobrindo os 26 cenários pedidos + devolução, troca, kit+componente no mesmo carrinho, multi-local e regressão de produto normal.
- **Concorrência real (`product_kits.concurrency.sh`)**, duas sessões Postgres: produto×kit, kit×produto, kit×kit e ordem de lock invertida (sem deadlock), sem saldo negativo — OK.
- **Regressão SQL**: todas as suítes existentes rodadas num banco com e sem as migrations de kit → resultado idêntico (as falhas remanescentes são de ambiente/testes antigos e ocorrem igual nos dois).
- **Ambiente**: Postgres 17 local descartável reconstruído de `000_schema_completo.sql` + todas as migrations (sem acesso ao banco real). Divergências do baseline ajustadas no harness: `pedidos`/`pedidos_itens`/`customer_addresses`/`shipments` como stub, `products.sku` sem UNIQUE, colunas geradas de `stock_lots`, overload legado de `rpc_create_sale`, `sales.customer_id` nullable, trigger `trg_customer_metrics_sale`.
- **Vitest**: 143 arquivos, 1669 testes passando (novos: stockRequirements 18, schema 10, availability.service 11, vendas.kits 5).
- **Typecheck**: limpo. **Build**: compilado com sucesso.
- **UI**: não verificada no navegador — exigiria o app apontando para um banco com as migrations aplicadas (o ambiente local não tem Supabase/Auth).

## 9. Riscos / débitos remanescentes

- **Aplicar em homologação antes de produção** e rodar `product_kits.test.sql` + `product_kits.concurrency.sh` contra ele.
- **Achado pré-existente (fora do escopo)**: `rpc_transfer_stock` das migrations faz `INSERT … VALUES (-qtd) ON CONFLICT DO UPDATE`; o Postgres avalia o CHECK `sb_qty_non_negative` na linha proposta antes do conflito, então a função falharia sempre. Confirmar no banco real se a versão viva diverge.
- `rpc_create_sale_sale_type.test.sql` (teste 6) espera `sale.refunded` vindo de troca, removido em 20260915 — teste desatualizado.
- Custo de kit usa custo de catálogo (`cost_override ?? base_cost`) como todo o sistema — não custo médio real de lote.

## 10. Como aplicar

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f supabase/migrations/202609231000_product_kits_foundation.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f supabase/migrations/202609231100_rpc_create_sale_kits.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f supabase/migrations/202609231200_rpc_cancel_return_exchange_kits.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f supabase/migrations/202609231300_kit_management_rpcs.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/product_kits.test.sql
```
