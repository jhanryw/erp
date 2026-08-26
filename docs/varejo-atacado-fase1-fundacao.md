# Fundação Varejo/Atacado — Entrega Fase 1 (Backend/Dados)

**Data:** 2026-08-31
**Escopo:** fundação de dados/backend apenas — sem PDV, sem dashboards/analytics, sem site de atacado, sem comissão. Baseado em `docs/varejo-atacado-audit-report.md` (auditoria de 2026-08-25) e nas 4 decisões de negócio fechadas pelo dono na Fase 0.

---

## 1. Modelo de dados final

| Entidade | Campo novo | Tipo | Regra |
|---|---|---|---|
| `sales` | `sale_type` | `TEXT NOT NULL DEFAULT 'retail'` | `CHECK IN ('retail','wholesale')` — modalidade **comercial** |
| `sales` | `sales_channel` | `TEXT NULL` | `CHECK IN ('pos','manual','whatsapp','nuvemshop','wholesale_site')` — canal **operacional**, distinto de `sale_origin` (marketing) |
| `products` | `wholesale_price` | `NUMERIC(10,2) NULL` | `> 0` quando informado — espelha `base_price` |
| `products` | `cst` | `TEXT NULL` | reservado/informativo (ver seção 9) |
| `product_variations` | `wholesale_price_override` | `NUMERIC(10,2) NULL` | `> 0` quando informado — espelha `price_override` |

Nenhuma coluna existente foi renomeada, removida ou teve seu tipo alterado. `sale_origin`, `base_price`, `price_override`, `fiscal_documents.document_type` continuam exatamente como estavam.

## 2. Migrations criadas

1. `supabase/migrations/202608311200_wholesale_retail_schema_foundation.sql` — colunas novas acima (com `NOT VALID` + `VALIDATE CONSTRAINT` separado para não travar `sales` sob lock exclusivo num full-table scan).
2. `supabase/migrations/202608311201_rpc_create_sale_wholesale_channel.sql` — `rpc_create_sale` ganha `p_sale_type`/`p_sales_channel` (18º/19º parâmetros). `DROP FUNCTION` explícito da assinatura de 17 antes do `CREATE` da de 19 (mesmo cuidado de overload já documentado no projeto) + `REVOKE`/`GRANT` reaplicados.
3. `supabase/migrations/202608311202_sale_lifecycle_outbox_sale_type.sql` — `rpc_cancel_sale`, `rpc_return_sale`, `rpc_process_exchange` passam a incluir `sale_type`/`sales_channel` no payload dos eventos que já emitiam. Assinaturas inalteradas.
4. `supabase/migrations/202608311203_import_products_wholesale_fiscal_fields.sql` — `_persist_single_product` (usada por `rpc_import_products_batch` e `rpc_create_product`) ganha leitura de `wholesale_price`/`ncm`/`origem`/`cst`/`wholesale_price_override`, todos opcionais. Assinatura inalterada (JSONB).

## 3. Arquivos alterados (TypeScript)

- `src/services/vendas.service.ts` — `CreateSaleInput.sale_type`/`sales_channel`, thread para a RPC.
- `src/app/api/vendas/route.ts` — Zod ganha `sale_type` (default `retail`) e `sales_channel`.
- `src/app/api/webhooks/nuvemshop/order/route.ts` — `p_sale_type: 'retail'`, `p_sales_channel: 'nuvemshop'` hardcoded.
- `src/app/api/vendas/[id]/troca/route.ts` — herda `sale_type`/`sales_channel` da venda original para a venda-filha (troca com itens novos).
- `src/lib/fiscal/consumidorFinal.ts` (novo) + `.test.ts` — resolve `indFinal` a partir do CNPJ do destinatário, nunca de `sale_type`.
- `src/services/fiscal/loadSaleFiscalContext.ts` — usa `resolveConsumidorFinal` em vez do hardcode `?? 1`.
- `src/services/fiscal/types.ts`, `src/lib/integrations/focus/nfePayload.types.ts` — comentários atualizados (nenhuma mudança de tipo).
- `src/lib/utils/import-parser.ts` + `.test.ts` — campos `preco_atacado`/`ncm`/`origem_fiscal`/`cst` no CSV.
- `src/app/api/produtos/import/route.ts` — Zod + payload para a RPC.
- `src/app/api/produtos/route.ts`, `src/app/api/produtos/[id]/route.ts` — `wholesale_price`/`wholesale_price_override` na criação/edição manual (backend; formulário/UI não foi tocado).
- `src/lib/sku/sku-unique.ts` — `VariationInsertPayload.wholesale_price_override`.
- `src/lib/validators/index.ts` — `wholesalePriceFieldSchema()` novo; `productSchema.wholesale_price`; `customerSchema.cpf` relaxado para opcional.
- `src/app/api/clientes/route.ts`, `src/services/clientes.service.ts` — CPF opcional na criação de cliente.
- `src/app/(dashboard)/vendas/nova/page.tsx` — **único ponto de PDV tocado**: gate de CPF obrigatório no formulário inline de criação de cliente virou opcional (1 condicional). Nenhum seletor de modalidade, nenhuma mudança de layout.
- `src/lib/pricing/resolveSalePrice.ts` (novo) + `.test.ts` — resolução pura de preço por `sale_type`, com `missingWholesalePrice`. Sem consumidor ainda (fundação para o PDV futuro).

## 4. Comportamento anterior vs. 5. Comportamento novo

| Área | Antes | Depois |
|---|---|---|
| Modalidade da venda | Não existia em lugar nenhum do schema | `sales.sale_type`, gravado no `rpc_create_sale`, imutável pós-criação, preservado em cancelamento/devolução/troca |
| Preço de atacado | Não existia | `products.wholesale_price` + `product_variations.wholesale_price_override`, mesma granularidade/fallback do preço de varejo |
| Cliente sem CPF | Bloqueado em 2 camadas de aplicação (`/api/clientes`, PDV) — banco já permitia desde 20260521 | Permitido nas 2 camadas de aplicação; banco não mudou (já era nullable) |
| `indFinal` na NF-e | Hardcoded `1` sempre | Resolvido do CNPJ do destinatário (`sale_recipients.cnpj`) — `0` se CNPJ presente, `1` caso contrário. Nunca depende de `sale_type` |
| CSV de produtos | Só nome/tipo/modelo/ano/categoria/fornecedor/origem/cor/tamanho/preço/custo/estoque | + preço de atacado, NCM, origem fiscal, CST (todos opcionais) |
| Nuvemshop | `sale_origin: 'website'` hardcoded, nenhuma outra classificação | + `sale_type: 'retail'`, `sales_channel: 'nuvemshop'` hardcoded (nunca deriva de payload externo) |
| Evento `sale.completed`/`cancelled`/`refunded` | Sem informação de modalidade | Payload ganha `sale_type`/`sales_channel` (chaves novas, nada removido) |

## 6. Estratégia usada para o histórico

`sale_type NOT NULL DEFAULT 'retail'` — toda venda existente vira `retail` automaticamente via `ADD COLUMN ... DEFAULT`, sem `UPDATE` em massa (metadata-only desde PG11, sem rewrite de tabela). Nenhum backfill manual necessário nem executado. `wholesale_price`/`wholesale_price_override` nascem `NULL` em todo produto existente — não é dado faltando, é o estado inicial correto (nenhum produto vende em atacado até ser precificado).

## 7. Como o preço de atacado ficou modelado

Espelha **exatamente** a granularidade real do preço de varejo hoje em produção (confirmado por auditoria: `COALESCE(pv.price_override, p.base_price)`, usado em `/api/produtos/buscar` e várias views/RPCs):

```
retail:    product_variations.price_override           ?? products.base_price
wholesale: product_variations.wholesale_price_override  ?? products.wholesale_price
```

Política para produto sem preço de atacado: **nunca** cai silenciosamente no preço de varejo. `src/lib/pricing/resolveSalePrice.ts` devolve `{ price: null, missingWholesalePrice: true }` nesse caso — decisão explícita do dono, sem constraint de banco (produtos legados continuam válidos). Essa função ainda não tem consumidor em rota alguma (PDV/busca de produto não foram tocados) — é a fundação pronta para a próxima fase.

## 8. Como cliente sem CPF ficou modelado

Achado real durante a validação: **`customers.cpf` já era nullable no banco** desde `20260521_webhook_idempotency.sql` (usado pelo fluxo Nuvemshop) — a auditoria de 25/08 relatou isso como bloqueador de schema, mas era impreciso: o bloqueio real estava só na camada de aplicação (Zod em `/api/clientes` exigia 11 dígitos; o PDV bloqueava no client). **Nenhuma migration foi necessária** para este item — só relaxamento de validação em 3 pontos (API, service, PDV). CNPJ **não** foi adicionado ao cadastro de `customers` — decisão deliberada, para não duplicar o que `sale_recipients` (snapshot fiscal por venda, já com `cnpj`) já cobre. Ver seção 14 para a lacuna residual disso.

## 9. Impacto fiscal

- `resolveFiscalDocumentType()` (NF-e vs. NFC-e vs. bloqueado) **não foi alterado** — continua decidindo por `sale_origin`/`delivery_mode`, nunca por `sale_type`, exatamente como o dono pediu ("não modele sale_type=wholesale como autorização fiscal automática").
- `indFinal` deixou de ser hardcoded — resolvido a partir do CNPJ real do destinatário (`sale_recipients.cnpj`, que já existia desde 20260828 mas nunca era lido para essa decisão). Retail com CNPJ agora resolve `indFinal=0`; wholesale sem CNPJ continua `indFinal=1` — sem acoplamento com a classificação comercial.
- `fiscal_documents.document_type` continua só `nfe`/`nfce`, decidido em runtime, nunca escolhido manualmente — invariante preservado.
- `products.cst` foi criado **reservado/informativo**: o motor fiscal (`taxRules.ts`) deriva CSOSN inteiramente do CRT da empresa (nunca de produto) e só suporta CRT 1/4 — não existe hoje regra de CST (CRT 2/3) implementada. Gravar o dado sem fingir uma regra fiscal que não existe foi a escolha mais honesta; ativá-lo de verdade é um projeto fiscal à parte.
- **Nenhuma mudança em `validateFiscalReadiness`/`buildNfePayload`/`buildNfcePayload`/CRT suportado/CEST** — fora de escopo desta fase.

## 10. Impacto Nuvemshop

Uma única mudança: o webhook (`order/route.ts`) agora passa `p_sale_type: 'retail'` e `p_sales_channel: 'nuvemshop'` **hardcoded**, nunca derivados do payload do pedido (proteção explícita contra payload arbitrário virar venda de atacado). Preço, estoque, mapeamento de produto (`produto_map`) — nada disso mudou.

## 11. Impacto outbox

`sale.completed` (`rpc_create_sale`), `sale.cancelled` (`rpc_cancel_sale`), `sale.refunded` (`rpc_return_sale` e `rpc_process_exchange`, troca total) ganham `sale_type`/`sales_channel` no payload JSON — **retrocompatível**: só chaves novas somadas, nenhuma removida/renomeada. Consumidores existentes (hoje só Chatwoot, via `integration_event_deliveries`) não quebram.

## 12. Testes adicionados

**TypeScript (vitest):**
- `src/lib/fiscal/consumidorFinal.test.ts` — 3 casos (com/sem CNPJ, independência de sale_type).
- `src/lib/pricing/resolveSalePrice.test.ts` — 6 casos (retail com/sem override, wholesale com/sem override, missing nunca cai pro varejo).
- `src/lib/validators/customer.test.ts` — 7 casos (CPF ausente/vazio/válido/inválido, wholesale_price ausente/válido/inválido).
- `src/lib/utils/import-parser.test.ts` — 6 casos novos (retrocompatibilidade, campos presentes, 3 validações de erro, override por variante).

**SQL (pgTAP-style, `supabase/tests/`, para o usuário rodar contra Postgres real):**
- `rpc_create_sale_sale_type.test.sql` (novo) — 7 cenários: default retail, wholesale explícito, valor inválido rejeitado, cancelamento preserva, devolução preserva, troca (devolução total) preserva + evento correto, `sale.completed` carrega os campos.
- `rpc_import_products_batch_wholesale_fiscal.test.sql` (novo) — 3 cenários: campos novos persistem (produto + variante, sem alterar preço/custo de varejo), payload antigo sem os campos continua funcionando, `wholesale_price` inválido rejeitado.
- `rpc_create_sale_single_overload.test.sql` (atualizado) — assinatura de 19 parâmetros, GRANTs reconfirmados, Bloco 4 agora também valida `p_sale_type='wholesale'`/`p_sales_channel` persistindo.

## 13. Resultado da suíte completa (rodado nesta sessão)

- `npm run typecheck` → **limpo**, zero erros.
- `npm run test` (vitest) → **876/876 testes passando** (60 arquivos), incluindo os 22 novos.
- `npm run build` (Next.js) → **build de produção completo sem erros**, todas as rotas compiladas.
- `npm run lint` → **não executável neste ambiente** (projeto nunca teve `.eslintrc`/`eslint.config` configurado — gap pré-existente, não introduzido por esta entrega).
- **Testes SQL/pgTAP não foram executados** — este sandbox não tem acesso a uma instância Postgres real (limitação conhecida e documentada em todas as fases anteriores do projeto). Ver seção 15.

## 14. Pendências para a próxima fase

1. **PDV**: seletor Varejo/Atacado, busca de produto resolvendo preço por `sale_type` (via `resolveSalePrice`), UI para `missingWholesalePrice`.
2. **Comissão**: infraestrutura não existe hoje (confirmado na auditoria) — `sale_type` já está disponível para um futuro módulo, mas o módulo em si não foi criado (fora de escopo, conforme decisão do dono).
3. **CSV — atualização por SKU**: hoje o importador é só CREATE (produto já existente é bloqueado no preflight). "Atualizar produto/SKU existente via CSV" é um recurso novo genuíno (match por SKU, política de o que sobrescreve vs. preserva, semântica de estoque numa atualização) — deliberadamente **não implementado** nesta fase, por não ser seguro decidir de passagem.
4. **CNPJ no cadastro de cliente**: hoje só existe via `sale_recipients` (snapshot por venda). Se o negócio precisar rastrear CNPJ como identidade permanente do cliente (não só por venda), é uma decisão de produto separada.
5. **`sale_recipients` só é coletado para `delivery_mode='delivery'`**: uma venda de atacado com retirada (`pickup`) hoje não tem como capturar CNPJ do destinatário para NF-e — gap real, não resolvido aqui porque a coleta desse dado depende de UI do PDV (fora de escopo).
6. **Nuvemshop**: nenhum teste automatizado cobre o webhook (gap pré-existente, confirmado na auditoria original) — a garantia de `sale_type='retail'` hoje é só leitura de código, não testada automaticamente.
7. **Relatórios/analytics por `sale_type`**: banco já preserva o dado necessário (ver seção 1), mas nenhum dashboard foi construído — fora de escopo desta fase.
8. **Company_fiscal_settings sem UI de edição** — achado da auditoria original, não relacionado a este trabalho, ainda pendente.

## 15. Migrations/comandos que você precisa executar manualmente

Nenhum código foi aplicado a um banco real (este ambiente não tem acesso a Postgres). Antes de subir para produção:

```bash
# 1. Aplicar as 4 migrations novas, em ordem, num ambiente de teste primeiro
supabase db push   # ou o método de deploy de migration já usado no projeto

# 2. Rodar os testes SQL/pgTAP contra esse ambiente de teste
psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f supabase/tests/rpc_create_sale_single_overload.test.sql
psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f supabase/tests/rpc_create_sale_sale_type.test.sql
psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f supabase/tests/rpc_import_products_batch_wholesale_fiscal.test.sql

# 3. Rodar a suíte SQL existente de regressão (nenhuma delas foi alterada,
#    mas cobrem create/cancel/return/exchange/outbox/import — confirmar que
#    nada quebrou)
psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f supabase/tests/rpc_create_sale_pricing_invariants.test.sql
psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f supabase/tests/rpc_create_sale_recipient_atomicity.test.sql
psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f supabase/tests/integration_outbox_sale_events.test.sql
psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f supabase/tests/rpc_import_products_batch.test.sql
psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f supabase/tests/sales_receipt_token.test.sql
psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f supabase/tests/sale_recipients_constraints.test.sql

# 4. Depois de aplicado, gerar os tipos TS atualizados (opcional, o build
#    passou sem isso porque as rotas usam casts manuais, mas mantém
#    database.types.ts em dia)
npm run supabase:types
```

Nenhum passo requer autorização adicional além de aplicar as migrations — todas são aditivas, sem `DROP`/`ALTER COLUMN TYPE`/dado destrutivo.
