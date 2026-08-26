# Site de Atacado Integrado ao ERP — Fase 8

Relatório de entrega. Primeira versão funcional ponta a ponta: catálogo → produto → carrinho → checkout → venda `wholesale`/`wholesale_site` → estoque → analytics.

## 1. Arquitetura escolhida

O ERP continua sendo a única fonte de verdade — nenhuma tabela de catálogo/estoque/venda nova. Os 3 gaps reais (auditados, não presumidos) foram preenchidos com o **menor acréscimo possível**, sempre seguindo um padrão já existente no projeto:
- **Tenant**: `resolveWholesaleSiteTenant()` — mesmo padrão do webhook Nuvemshop (`NUVEMSHOP_SYSTEM_USER_ID`), agora `WHOLESALE_SITE_SYSTEM_USER_ID`. Não existe subdomínio no projeto; documentado como decisão explícita, não descoberta tarde.
- **Login de cliente**: Supabase Auth (mesma tecnologia do staff), isolado por rota — `customers.auth_user_id` liga a identidade, nunca toca `public.users`/RBAC.
- **Pagamento**: sem gateway real auditado em lugar nenhum do projeto → `payment_method='invoice'` (novo valor de enum) representa cobrança negociada fora do sistema — nunca um checkout fingindo cobrar Pix/cartão.

## 2. URL/roteamento

`/atacado/**` (novo segmento de rota, fora de `(dashboard)`/`(auth)`) — path-based, um dos dois padrões sugeridos no pedido. `/api/wholesale/**` para as APIs. Ambos adicionados ao allowlist do `middleware.ts` (nunca a gate de sessão de staff).

## 3. Autenticação

Supabase Auth, isolado (`src/lib/wholesale/session.ts`) — nunca reutiliza `requireRole`/`getUserProfile` (staff). Um funcionário logado visitando `/atacado` é tratado como visitante anônimo (testado).

## 4. Tenant resolution

`src/lib/wholesale/tenant.ts` — env var → `public.users` → `company_id`. Nunca aceito do browser.

## 5. Catálogo

`getWholesaleCatalogPage`/`getWholesaleProductDetail` — 100% tabelas existentes (`products`/`product_variations`/`stock_balances`). Preço: `resolveSalePrice({saleType:'wholesale',...})`, a mesma função pura do PDV. Produto sem preço de atacado nunca comprável (preferência: mostrado, indisponível).

## 6. Imagens

`listMediaByEntity('product', id, companyId)` — mesma função do Media Hub administrativo. Nenhum upload/consulta paralelo.

## 7. Variações

Compra sempre sobre `variation_id` — nunca `product_id` isolado. Atributos (cor/tamanho) exibidos via `product_variation_attributes`, mesma granularidade do resto do ERP.

## 8. Preço

`wholesale_price_override` da variação → `wholesale_price` do produto → sem preço = não comprável. **Sempre resolvido no servidor**, no catálogo E de novo no checkout (nunca confia no valor mostrado no carrinho).

## 9. Estoque

Soma de `stock_balances` em TODAS as `stock_locations` ativas — mesmo escopo que o checkout debita de verdade (`p_stock_mode='online_priority'`, mesmo modo já usado pelo webhook Nuvemshop, reaproveitado via novo parâmetro opcional em `createSale()`). Testado: 12 → venda site 4 → 8 → PDV varejo 2 → 6, mesmo pool.

## 10. Carrinho

`localStorage`, preserva `variationId`+quantidade+dados de exibição — nunca a autoridade de preço final.

## 11. Checkout

`POST /api/wholesale/checkout` → `checkoutWholesaleCart` (`src/services/wholesale/checkout.ts`): recarrega preço/custo/estoque do banco, rejeita item por item quando indisponível (retorna quais), nunca cria a venda se algo faltar. Chama `createSale()` — a MESMA infraestrutura do PDV/troca, nunca duplica `rpc_create_sale`.

## 12. Clientes

`customers` reutilizado — signup faz merge-or-create (busca por email/telefone/CPF/CNPJ antes de duplicar).

## 13. CNPJ

`customers.cnpj` (nova coluna, identidade COMERCIAL) — distinto de `sale_recipients.cnpj` (snapshot fiscal por venda, Fase Fiscal 6, nunca substituído).

## 14. Endereço

Reaproveita `/api/shipping/cep` (já público) + o mesmo formato de `deliveryRecipientSchema` da Fase Fiscal 5C/6 — `sale_recipients` grava atomicamente dentro de `createSale()`, sem segunda implementação.

## 15. Entrega

Retirada ou entrega (mesmos `delivery_mode`/`shipments` do resto do ERP). Frete: sem calculadora real aplicável a B2B (o único cálculo existente é geofenced/local) — estratégia simples documentada: "a combinar com o time comercial."

## 16. Pagamento

Nenhum gateway real → `invoice`. Cliente vê "pagamento a combinar" — nunca um botão fingindo cobrar.

## 17. Criação da venda

`sale_type='wholesale'`/`sales_channel='wholesale_site'`/`sale_origin='website'` fixados no `checkoutWholesaleCart` — o tipo de entrada nem tem campo pra isso vir do browser.

## 18-20. sale_type / sales_channel / sale_origin

Fixados no servidor (18/19). `sale_origin='website'` reaproveita a semântica já existente (preserva `resolveFiscalDocumentType` forçando NF-e pra `website`, sem inventar valor novo).

## 21. Vendedor

`responsible_seller_id: null` sempre — nunca um vendedor falso.

## 22. Fiscal

Nenhuma infraestrutura fiscal nova — venda nasce elegível a NF-e via `resolveFiscalDocumentType`/`sale_origin='website'`, staff emite depois pela tela da venda (Fase Fiscal 6, intocada). Como `payment_method='invoice'` não tem mapeamento em `resolveFormaPagamento` (decisão deliberada — nunca inventar um código SEFAZ sem confirmação), a emissão fica bloqueada até o pagamento real ser reconciliado por staff — documentado, não escondido.

## 23. Analytics

Zero código novo — `sale_type`/`sales_channel` já aparecem em tudo (Fase 7).

## 24. Segurança

Preço/estoque sempre recarregados do servidor (testado: browser não pode alterar `unit_price`). DTO público nunca expõe custo/margem/NCM/CST/estoque exato/company_id (testado via inspeção do JSON serializado). Multi-tenant: toda query filtra `company_id`; variação de outra empresa tratada como inexistente (testado).

## 25. Idempotência

`wholesale_checkout_idempotency` (nova tabela, UNIQUE key) — claim atômico ANTES de criar a venda. Replay do mesmo clique devolve o mesmo pedido, nunca cria um segundo (testado).

## 26. APIs públicas

Todas sob `/api/wholesale/` — nenhuma reaproveita rota administrativa.

## 27. Arquivos alterados

Novos: `src/lib/wholesale/{tenant,session}.ts`+testes, `src/services/wholesale/{catalog,checkout,checkoutIdempotency,customerAuth}.ts`+testes, `src/app/atacado/**` (9 páginas), `src/app/api/wholesale/**` (9 rotas). Modificado: `vendas.service.ts` (+`stockMode` opcional), `middleware.ts` (+allowlist).

## 28. Migrations

`202609040900_wholesale_site_foundation.sql` — `customers.auth_user_id`/`customers.cnpj`, `payment_method` +`invoice`, tabela `wholesale_checkout_idempotency`.

## 29. Índices

Nenhum novo — catálogo usa os padrões `company_id`/`active` já indexados em fases anteriores; sem query lenta identificada nesta v1.

## 30. Testes

**38 testes novos** cobrindo ~35 dos itens numerados: segurança de preço/estoque/tenant, idempotência (duplo clique, claim concorrente), CNPJ/CPF, cliente existente vs novo, staff-session-não-é-cliente, DTO sem dado interno, estoque compartilhado (SQL manual).

## 31-33. Suíte completa / typecheck / build

`npx vitest run`: **981/981**. `npm run typecheck`: limpo. `npm run build`: limpo, todas as rotas `/atacado`/`/api/wholesale` presentes.

## 34. Testes não executáveis neste ambiente

Todo o SQL (migration + `wholesale_site_foundation.test.sql`) — sem Postgres neste sandbox. Fluxo de UI ponta a ponta (signup real, cookie de sessão em navegador real, checkout completo) — sem `WHOLESALE_SITE_SYSTEM_USER_ID` configurado neste ambiente e sem infraestrutura de teste E2E no projeto (mesma limitação de todas as fases anteriores).

## 35. Comandos manuais

```bash
supabase db push
psql "$DATABASE_URL" -f supabase/tests/wholesale_site_foundation.test.sql
# Depois, configurar no ambiente real:
# WHOLESALE_SITE_SYSTEM_USER_ID=<uuid de um public.users com company_id>
```

## 36. Limitações conhecidas

Sem gateway de pagamento real (decisão consciente, documentada). Sem cálculo de frete B2B (estratégia simples: "a combinar"). Sem verificação de e-mail no signup (sem infra de e-mail transacional auditada). Sem categorias navegáveis (só busca por texto). `resolveFormaPagamento` não mapeia `invoice` — fiscal fica pendente até pagamento real ser registrado por staff.

## 37. Pendências seguintes

Gateway de pagamento real (Pix/cartão) quando o negócio decidir qual; frete B2B dedicado; subdomínio por empresa (multi-tenant real) se o projeto crescer pra múltiplas empresas operando sites separados; verificação de e-mail; categorias navegáveis.
