# Auditoria Técnica — Distinção Varejo/Atacado no ERP Santtorini

**Data:** 2026-08-25
**Escopo:** 100% read-only. Nenhum arquivo de código foi criado/editado/deletado. Nenhuma migration foi executada. Nenhuma suposição arquitetural foi assumida sem confirmação em código/migration real.
**Método:** 6 auditorias paralelas independentes (catálogo/preço/CSV; schema+RPCs de venda; PDV/clientes/comissão; módulo fiscal; financeiro/DRE/relatórios; integração Nuvemshop), todas confirmando o estado **atual** do código — os documentos antigos em `docs/fiscal-*.md` e `docs/focus-nfe-*.md` foram tratados como plano histórico, não fonte de verdade, e comparados contra o código real onde relevante.

**Achado mais importante de toda a auditoria, confirmado de forma independente por 3 dos 6 agentes**: o sistema já foi auditado para essa mesma pergunta antes. Um comentário vivo no código, em `src/lib/fiscal/resolveFiscalDocumentType.ts:28-34`, registra:

> "'Atacado' (venda de atacado → NF-e) foi PROPOSTO mas DELIBERADAMENTE ADIADO por decisão explícita: auditoria completa do schema/código (migrations + `src/`) não encontrou NENHUM campo real que identifique venda de atacado hoje — nenhuma coluna, enum, flag. Implementar essa prioridade exigiria inventar um sinal que não existe, o que foi explicitamente vetado."

Ou seja: **o terreno está limpo** (não há nada para não duplicar), mas a decisão de adiar já foi tomada uma vez por falta desse mesmo campo — esta auditoria é o material para finalmente resolver a lacuna.

---

## A. Arquitetura atual relevante

- **Stack**: Next.js + Supabase (Postgres). Duas árvores de schema coexistem: `src/lib/db/migrations/000_schema_completo.sql` (baseline consolidado, congelado em 07/07, **comprovadamente desatualizado** em vários pontos) e `supabase/migrations/*.sql` (141 arquivos, incrementos cronológicos por nome de arquivo — **única fonte de verdade confiável**). Um terceiro arquivo, `DATABASE_SCHEMA.sql` na raiz, é um dump ainda mais antigo (23/mar) e não deve ser usado.
- **RBAC**: 3 papéis (`admin` > `gerente` > `usuario`) + mecanismo de elevação por `authorization_tokens` de uso único.
- **Multi-tenant**: a maioria das tabelas centrais (`sales`, `customers`, `products`, `finance_entries`) tem `company_id`. Exceção confirmada: `pedidos` (tabela de pedidos Nuvemshop) **não tem `company_id`** — efetivamente single-tenant hoje.
- **Padrão arquitetural já estabelecido para "dimensão analítica de venda"**: `sales.sale_origin` (enum `customer_origin`) é o único precedente. É gravado na criação da venda via parâmetro da RPC, **nunca agregado em view SQL** — toda agregação por origem/vendedor acontece hoje em **TypeScript sobre linhas cruas de `sales`/`sale_items`** (`src/services/dashboard.ts`, `src/services/sellerDashboard.ts`). Esse é o padrão que uma nova dimensão retail/wholesale deveria seguir, não uma view nova.
- **Fila/eventos**: `integration_outbox` (`sale.completed`/`sale.cancelled`/`sale.refunded`) existe desde `20260817_integration_foundation_schema.sql`, emitido pelas 4 RPCs de venda, mas **sem consumidor fiscal** — só Chatwoot consome hoje via `integration_event_deliveries`.
- **Testes**: cobertura forte no módulo fiscal (dezenas de `.test.ts` + testes SQL/pgTAP) e em invariantes de `rpc_create_sale`. Cobertura **zero** em: `src/services/vendas.service.ts` (criação/cancelamento/devolução/troca), PDV (UI), comissão (não existe), Nuvemshop, DRE/CMV/margem.

## B. Fluxo atual completo de criação de uma venda

1. PDV (`src/app/(dashboard)/vendas/nova/page.tsx`), passo 0: seleciona vendedor responsável (`SellerPicker`, obrigatório) → seleciona `delivery_mode` (`pickup`/`delivery`, único toggle existente hoje) → busca produto via `GET /api/produtos/buscar` (server-side, `requireRole('usuario')`, retorna preço já resolvido) → adiciona ao carrinho (`unit_price` + `list_price_snapshot` congelados no momento).
2. Passo 1: seleciona cliente — busca/criação **direto do browser via Supabase client** (`createClient()` de `@/lib/supabase/client`, sujeito a RLS `authenticated`, não passa por API server-side) contra a tabela `customers`.
3. Passo 2: pagamento(s) multi-forma + desconto (sem teto percentual no schema) + `sale_origin` (select obrigatório, enum fixo sem valor de atacado).
4. Passo 3: confirma → `POST /api/vendas` (`src/app/api/vendas/route.ts`) valida vendedor/produtos/margem, monta `p_delivery_recipient` quando aplicável, chama `createSale()` (`src/services/vendas.service.ts:361-429`) → `rpc_create_sale` (versão vigente: `supabase/migrations/20260828_rpc_create_sale_pricing_and_products_total.sql:196-769`, 17 parâmetros).
5. Dentro da RPC, na mesma transação: valida `product_variation_id` pertence à empresa, debita `stock_balances` (lock `FOR UPDATE`, modo `main_store` ou `online_priority` via `p_stock_mode` — **não persistido**, só afeta a baixa), grava `sales`+`sale_items`+`sale_recipients` (snapshot fiscal imutável do destinatário, com CNPJ), grava lançamento em `finance_entries` (`type='income', category='sale'`, sem nenhuma dimensão de canal), aplica/gera cashback, emite evento `sale.completed` em `integration_outbox`.
6. Fora da transação: sincroniza estoque com Nuvemshop, dispara webhooks n8n e push notification, cria `shipments` (sempre, mesmo para venda de balcão via `pickup`), imprime comprovante não-fiscal automaticamente (`sales.receipt_token`).
7. Emissão fiscal (NF-e/NFC-e) **nunca acontece automaticamente** — é um passo manual e posterior, feito pelo admin clicando "Emitir" no card fiscal da venda já criada.

## C. Como o preço do produto é determinado atualmente

- Produto tem **um único preço**: `products.base_price` (`NUMERIC(10,2) NOT NULL CHECK > 0`). Variação pode sobrescrever via `product_variations.price_override` (nullable — `NULL` = usa `base_price` do pai).
- `GET /api/produtos/buscar` resolve o preço final (`price_override ?? base_price`) **no servidor**; o PDV recebe o preço já pronto — não há cálculo de preço no client.
- Preço é **editável por item no PDV** sem trava de role no front; o servidor só bloqueia preço abaixo do custo para role `usuario` (gerente/admin podem confirmar com aviso). `unit_price` do item vai para a RPC **sem validação contra o catálogo** — é confiado do payload.
- `unit_cost`, ao contrário do preço, **é sempre recalculado no servidor** (`resolveAuthoritativeItemCosts`, `src/services/vendas.service.ts:242-273`) a partir de `cost_override`/`base_cost` reais — nunca confia no valor enviado pelo cliente.
- **Não existe nenhuma segunda coluna de preço** (atacado, faixa, mínimo) em `products` ou `product_variations` — confirmado por 3 agentes independentes via grep exaustivo de migrations.

## D. Como o estoque é baixado

- Pool único: `stock_locations` + `stock_balances` (chave `product_variation_id` + `stock_location_id`), sem nenhuma separação por canal/modalidade.
- `rpc_create_sale` debita com `FOR UPDATE` (lock pessimista) antes de gravar a venda. Dois modos via `p_stock_mode`: `main_store` (default — usado por toda venda manual/PDV) debita só o local principal; `online_priority` (usado **apenas** pelo webhook Nuvemshop) distribui entre todos os locais ativos por prioridade. **O modo não é persistido em `sales`** — só afeta a transação de baixa e o `movement_type` gravado em `stock_movements`.
- Cancelamento/devolução restauram o mesmo saldo (`stock_balances` upsert + `stock_movements(type='return')`).
- Tabela legada `stock` está congelada ("LEGADO/BACKUP"), não mais escrita.
- Confirmado: **atacado e varejo compartilhariam exatamente o mesmo mecanismo hoje, sem nenhuma mudança estrutural necessária** — a regra de negócio do dono já é satisfeita pela arquitetura atual.

## E. Como comissão é calculada

**Achado crítico**: **não existe nenhuma infraestrutura de comissão no código-fonte hoje.** Busca exaustiva por `commission`/`comiss` em todo `src/` e `supabase/` retorna zero código funcional — só um comentário de cabeçalho listando "Comissões" como módulo futuro (`supabase/migrations/20260812_open_cash_rpcs_to_usuario.sql:6`). `sellers` não tem coluna de percentual de comissão. O relatório por vendedor (`src/services/sellerDashboard.ts`) calcula faturamento/margem/ticket médio por `responsible_seller_id`, mas nenhuma coluna de comissão.

O que existe é só o vínculo `sales.responsible_seller_id → sellers(id)`. Se comissão é calculada hoje, é fora do sistema (planilha externa, cálculo manual).

**Isso é um conflito direto com a premissa do pedido do dono** ("atacado deve usar a MESMA infraestrutura/regra de comissão hoje existente") — ver seção P, item 1.

## F. Como financeiro e DRE recebem a venda

- `rpc_create_sale` grava um único lançamento em `finance_entries` (`type='income', category='sale', amount=v_total, sale_id=...`) — **sem nenhum campo de canal/tipo de venda**. `finance_entries` nunca teve e não tem coluna de canal em nenhuma migration.
- Cancelamento/devolução **não criam** lançamento em `finance_entries` — o efeito é refletido via `sales.status`/`cancelled_at`/`returned_at`, consumidos diretamente pela view da DRE.
- **A DRE (`vw_dre_mensal`, versão vigente `supabase/migrations/20260725_vw_dre_mensal_margem_operacional_pct.sql`) já é UMA linha por mês + `company_id`, sem nenhuma outra dimensão.** Receita/CMV vêm de uma CTE que agrega `sales`+`sale_items` (grão de linha de venda); Opex vem de `finance_entries` agrupado por mês+categoria (sem canal, nunca teve).
- **Isso é uma boa notícia estrutural para o requisito "DRE continua consolidada"**: como o Opex já é agregado sem qualquer dimensão de canal, adicionar retail/wholesale como filtro na CTE de receita/CMV (que já opera no grão de `sales`) não exige tocar em Opex nem duplicar despesas — a separação por canal seria feita **fora** da view da DRE (nos relatórios de faturamento/CMV/margem por canal, seguindo o padrão TS já usado para vendedor/origem), não dentro dela.
- **CMV não vem de FIFO/custo médio real** — vem de `sale_items.unit_cost`, que é resolvido a partir de `cost_override`/`base_cost` estático de catálogo no momento da venda (`resolveAuthoritativeItemCosts`). Uma função `consume_stock_fifo` existe no banco mas é código morto (nenhuma chamada encontrada). Esse é um achado independente do pedido de atacado/varejo, mas qualquer cálculo de CMV por canal herdará essa mesma limitação.
- Views/MVs relacionadas a vendas (inventário completo): `vw_dre_mensal`, `vw_daily_revenue_trend`, `vw_stock_live`, `vw_data_quality_issues`, `vw_purchase_suggestions`, `mv_product_performance`, `mv_abc_by_{revenue,profit,volume}`, `mv_stock_status`, `mv_customer_rfm`, `mv_daily_sales_summary`, `mv_monthly_financial`, `mv_color_performance`, `mv_supplier_performance`. **Nenhuma agrega por canal/vendedor** — essa agregação hoje é 100% feita em JavaScript (`dashboard.ts`, `sellerDashboard.ts`) sobre linhas cruas. Achado colateral (fora de escopo, mas relevante): `mv_customer_rfm`, `mv_daily_sales_summary`, `mv_monthly_financial` e `mv_color_performance` parecem não ter sido migradas para `company_id` (diferente de `mv_product_performance`/`mv_stock_status`, corrigidas em `20260812_add_company_id_dashboard_mvs.sql`) — vale confirmar se é um gap real de isolamento multi-tenant.

## G. Como fiscal funciona atualmente

- **Provider**: Focus NFe (`fiscal_documents.provider CHECK IN ('focus_nfe')`), via `src/lib/integrations/focus/httpClient.ts`. HTTP Basic auth, timeout 15s.
- **Ambos NF-e e NFC-e já estão implementados e testados** (não é mais plano — `buildNfePayload`/`buildNfcePayload`/`submitNfeHomologacao`/`submitNfceHomologacao`/`validateNfeReadiness`/`validateNfceReadiness`, cada um com `.test.ts` próprio), mas **travados em ambiente de homologação por código** (retornam 403 se `nfe_environment`/`nfce_environment !== 'homologacao'`).
- **Tipo de documento fiscal**: `fiscal_documents.document_type CHECK IN ('nfe','nfce')` — decidido em runtime por `resolveFiscalDocumentType()` (`src/lib/fiscal/resolveFiscalDocumentType.ts:70-91`), nunca escolhido manualmente: `sale_origin==='website'` → sempre NF-e; senão `shipments.delivery_mode==='delivery'` → NF-e; `'pickup'` → NFC-e; sem `shipments` mas `sale_origin==='store'` → NFC-e; qualquer outro caso → `blocked`. **Comprovante não fiscal não é modelado nessa tabela** — vive inteiramente à parte (`sales.receipt_token`, rota `/comprovante/[token]`, explicitamente rotulado "COMPROVANTE NÃO FISCAL — não substitui NF-e/NFC-e").
- **Emissão pós-venda diferida já é o comportamento padrão e único do sistema** — `rpc_create_sale` nunca chama nada fiscal; emissão é sempre um passo manual posterior via `POST /api/fiscal/{nfe,nfce}/emitir-homologacao`, disparado por um admin no card fiscal da venda. O evento `sale.completed` do outbox não tem consumidor fiscal.
- **Claim/lock de emissão concorrente** (`rpc_claim_fiscal_emission`, `rpc_begin_fiscal_transmission`, `rpc_complete_fiscal_emission`) já resolve corrida de dupla emissão de forma robusta (`20260826_fiscal_emission_claim.sql`).
- **Cancelamento de documento fiscal NÃO existe** — nem rota, nem service, nem chamada à Focus (`DELETE /v2/nfe/{ref}` explicitamente fora de escopo, comentado no código).
- **`indFinal` (indicador de consumidor final) está hardcoded sempre `1`** em `src/services/fiscal/types.ts:75` e `src/lib/integrations/focus/nfePayload.types.ts:176` — o payload fiscal atual **assume sempre venda a consumidor final**, nunca modela revenda/B2B. **Isso é um conflito direto com NF-e de atacado** — ver seção P, item 3.
- **`company_fiscal_settings` (CNPJ/IE/CRT/endereço do emitente) não tem NENHUMA UI de edição** — só leitura/health-check. Hoje precisa ser inserido via SQL direto.
- **Cliente PJ**: `customers` nunca ganhou coluna `cnpj` — mas `sale_recipients` (snapshot por venda, `20260828_sale_recipients.sql`) já tem `cnpj`, e `validateNfeReadiness` já aceita CPF **ou** CNPJ do destinatário. Ou seja: o caminho de emissão já suporta CNPJ **via snapshot da venda**, mesmo sem o cadastro de cliente suportar.
- **CRT suportado**: só 1 (Simples Nacional) e 4 (MEI) — CRT 2/3 bloqueiam emissão.
- Impressão: ainda `window.print()`, agora com layout térmico 80mm + QR code de verificação do comprovante — sem DANFE renderizável na UI (o campo `danfe_path` é gravado mas não exibido em lugar nenhum).
- **Divergência confirmada com os docs antigos**: `docs/fiscal-fase4-nfce-arquitetura-proposta.md` descrevia NFC-e como proposta — já é código funcionando. `docs/fiscal-risk-register.md` apontava "sem suporte a PJ/CNPJ" como bloqueador total — parcialmente resolvido via `sale_recipients`, mas `customers` continua sem `cnpj`.

## H. Como Nuvemshop cria vendas

- Webhook único (`src/app/api/webhooks/nuvemshop/order/route.ts`) trata `order/paid` e `order/cancelled`. Busca o pedido completo na API Nuvemshop, resolve `company_id` via `NUVEMSHOP_SYSTEM_USER_ID` (único ponto de vínculo multi-tenant — `pedidos` em si não tem `company_id`).
- **Preço do item vem 100% do payload Nuvemshop, sem qualquer validação contra o preço do produto no ERP.**
- Chama `rpc_create_sale` com **`p_sale_origin: 'website'` hardcoded** e `p_stock_mode: 'online_priority'`.
- **Não existe hoje nenhum campo confiável em `sales` que isole "veio da Nuvemshop" de "venda manual marcada como `website`"** — o próprio PDV permite ao operador escolher `sale_origin='website'` livremente numa venda manual. O único vínculo inequívoco é indireto: `pedidos.source='nuvemshop'` + `pedidos.sale_id → sales.id`.
- Estoque: **já 100% centralizado no ERP** (soma de todos os locais ativos), só empurrado para Nuvemshop — compatível com o requisito de negócio sem mudança nenhuma.
- Preço: só enviado à Nuvemshop **na criação do produto** — não existe rota/mecanismo para atualizar preço já publicado (só estoque tem push de atualização). Relevante: hoje não há "sync de preço de varejo" contínuo — é só a criação inicial.
- `produto_map`: mecanismo ativo mas provavelmente vazio/pouco populado (uma migration de 16/06 apagou todos os mapeamentos Nuvemshop, sem repopulação automática desde então) — consistente com achado de memória anterior.
- Zero testes cobrindo a integração Nuvemshop.

## I. Como importação CSV funciona

- Parser client-side (`src/lib/utils/import-parser.ts`) + persistência via `POST /api/produtos/import` → `rpc_import_products_batch` (`supabase/migrations/202607302600_pim_product_sku_identity.sql`).
- Campos hoje aceitos: `nome_produto, nome, tipo, modelo, ano, categoria, fornecedor, origem(própria/terceiro), cor, tamanho, preco, custo, estoque_inicial, ativo`.
- **NCM, CEST, origem fiscal (ICMS), unidade tributável, CST, CSOSN, CFOP: nenhum é importável em lote hoje**, apesar de NCM/CEST/origem-fiscal/unidade_med já existirem como colunas em `products` e já serem editáveis manualmente na criação/edição individual de produto (`src/lib/validators/index.ts`).
- `brand_id` é aceito no schema Zod da rota mas **enviado sempre como `null`** na persistência — desconectado do parser.
- **CST/CSOSN/CFOP não têm sequer coluna em `products`** — só existem hoje como snapshot por linha de venda em `fiscal_document_items`, preenchido no momento da emissão fiscal, nunca como cadastro de produto. Adicioná-los ao importador exige primeiro decidir e criar as colunas.
- Exportador CSV de produtos: **não implementado** — o rótulo "CSV" na tela de relatórios é só descritivo, sem handler por trás.

## J. Locais do código que precisarão mudar (mapa preliminar, não implementação)

| Área | Arquivo/objeto | Mudança provável |
|---|---|---|
| Schema | `products` | nova coluna `wholesale_price` (nullable) |
| Schema | `product_variations` | possível `wholesale_price_override` (avaliar necessidade real antes) |
| Schema | `sales` | nova(s) coluna(s) `sale_type` (retail/wholesale) e possivelmente `sales_channel` distinto de `sale_origin` |
| Schema | `products` | novas colunas se decidido armazenar CST/CSOSN/CFOP por produto |
| RPC | `rpc_create_sale` (`20260828_rpc_create_sale_pricing_and_products_total.sql`) | novo parâmetro `p_sale_type`/`p_sales_channel`, gravação na venda — **atenção**: mudar assinatura exige `DROP FUNCTION` explícito da versão antiga (já houve incidente real disso no projeto, documentado no próprio arquivo) |
| RPC | `rpc_cancel_sale`, `rpc_return_sale` | nenhuma mudança de lógica necessária — preservam a linha existente automaticamente |
| RPC | `rpc_process_exchange` / `src/app/api/vendas/[id]/troca/route.ts:79-154` | **precisa de propagação manual explícita** do novo campo para a venda-filha criada em troca com itens novos (hoje já faz isso manualmente para `responsible_seller_id`, mas zera `sale_origin` de propósito — o novo campo precisa do tratamento de "herdar", não de "zerar") |
| PDV | `src/app/(dashboard)/vendas/nova/page.tsx` | novo seletor Varejo/Atacado após vendedor; busca de produto passa a considerar o preço correspondente |
| API | `src/app/api/produtos/buscar/route.ts` | resolver preço por modalidade (retail/wholesale) |
| Fiscal | `src/lib/fiscal/resolveFiscalDocumentType.ts` | ganhar `sale_type` como novo insumo — reativar a regra "atacado → NF-e" hoje comentada como adiada |
| Fiscal | `src/services/fiscal/types.ts:75`, `nfePayload.types.ts:176` | `indFinal` deixa de ser hardcoded `1` — precisa refletir se é consumidor final ou revenda |
| Clientes | `customers` | avaliar CNPJ/PF-PJ (ou continuar resolvendo via `sale_recipients`, sem tocar cadastro) |
| CSV | `src/lib/utils/import-parser.ts`, `src/app/api/produtos/import/route.ts`, `rpc_import_products_batch` | novos campos: preço atacado, NCM, origem fiscal, CST (e decidir armazenamento de CST se novo) |
| Nuvemshop | `src/app/api/webhooks/nuvemshop/order/route.ts:530` | fixar `sale_type='retail'` explicitamente (nunca atacado) |
| Relatórios | `src/services/dashboard.ts`, `src/services/sellerDashboard.ts` | nova dimensão de agregação retail/wholesale, seguindo o padrão já usado para `sale_origin` |
| DRE | `vw_dre_mensal` | **não precisa mudar** (fica consolidada) — a separação por canal acontece nos relatórios de vendas, não na DRE |
| Comissão | *(infraestrutura inexistente)* | esclarecer com o dono antes de qualquer coisa — ver seção P |

## K. Possíveis regressões

1. **Alterar a assinatura de `rpc_create_sale`** é o ponto de maior risco histórico do projeto — já houve overloads duplicados coexistindo por meses (corrigido só em 20260828). Qualquer novo parâmetro precisa de `DROP FUNCTION` explícito da assinatura antiga na mesma migration, com teste `rpc_create_sale_single_overload.test.sql` reexecutado.
2. **Troca com itens novos zera `sale_origin` hoje por decisão explícita** (`troca/route.ts:137`) — se o mesmo padrão for copiado sem cuidado para `sale_type`, toda troca de venda de atacado "viraria" varejo silenciosamente. Precisa ser tratado como herança explícita, não como reuso do padrão de zeragem.
3. **`sale_origin='website'` é ambíguo** entre Nuvemshop real e venda manual — se o webhook Nuvemshop for a única fonte usada para inferir `sale_type` retroativamente em dados históricos, o resultado será incorreto para vendas manuais que também usam `website`.
4. **`resolveFiscalDocumentType` já tem 4 ramos de decisão** (origin/delivery_mode/pickup/store/blocked) — adicionar `sale_type` como quinto insumo sem quebrar os testes existentes (`resolveFiscalDocumentType.test.ts`) exige desenho cuidadoso da precedência entre as regras.
5. **Preço não validado contra catálogo em `rpc_create_sale`** — se o preço de atacado passar a ser "sugerido" pela busca de produto mas o campo continuar 100% editável e não validado no servidor, a garantia de "o preço correto foi realmente aplicado" continua dependendo só de auditoria manual, igual hoje.
6. **CSV import**: adicionar campos fiscais ao importador sem reaproveitar os validators já existentes (`ncmFieldSchema`/`cestFieldSchema`/`origemFieldSchema`) duplicaria regra de validação já usada na criação manual.
7. **Migrations MVs sem `company_id`** (`mv_customer_rfm`, `mv_daily_sales_summary`, `mv_monthly_financial`, `mv_color_performance`) — se relatórios de retail/wholesale forem construídos sobre essas MVs sem antes confirmar isolamento por empresa, corre risco de herdar um gap multi-tenant pré-existente.
8. **`fiscal_documents.document_type` só aceita `nfe`/`nfce`** — nenhuma mudança de schema necessária aqui, mas o comentário na coluna ("nunca escolhido manualmente pelo operador") precisa continuar verdadeiro; a nova regra de negócio não deve introduzir escolha manual do tipo de documento sem revisar esse invariante testado.

## L. Dados/migrations necessárias (alto nível — não implementar ainda)

1. `ALTER TABLE products ADD COLUMN wholesale_price NUMERIC(10,2) NULL` (nullable — sem backfill obrigatório, produtos sem preço de atacado simplesmente não vendem em atacado até serem completados).
2. `ALTER TABLE sales ADD COLUMN sale_type TEXT NOT NULL DEFAULT 'retail' CHECK (sale_type IN ('retail','wholesale'))` — default `'retail'` cobre 100% do histórico automaticamente sem backfill manual (ver seção N).
3. Avaliar `sales_channel` como coluna nova e explicitamente distinta de `sale_origin` (que continua sendo "origem de marketing do cliente", não deve ser sobrecarregado).
4. Se decidido, `product_variations.wholesale_price_override NUMERIC(10,2) NULL` — avaliar necessidade real antes.
5. Se decidido armazenar CST/CSOSN/CFOP por produto: novas colunas em `products` (hoje inexistentes).
6. Alteração de assinatura de `rpc_create_sale` (novo parâmetro), com `DROP FUNCTION` explícito da versão antiga na mesma migration.
7. `rpc_import_products_batch`: novos campos no INSERT (preço atacado, NCM, origem fiscal, CST se aplicável).

## M. Proposta de modelo de dados (para discussão, não decisão final)

- **`sales.sale_type`**: `TEXT CHECK IN ('retail','wholesale') NOT NULL DEFAULT 'retail'` — dimensão 1 do pedido do dono. Preservada automaticamente em cancelamento/devolução (RPCs só fazem `UPDATE` na linha existente); precisa de herança manual explícita no fluxo de troca com itens novos.
- **`sales.sales_channel`**: nova coluna, distinta de `sale_origin` — dimensão 2 (`pos`/`manual`/`whatsapp`/`nuvemshop`/`wholesale_site`, extensível). Deixar `sale_origin` intocado (continua sendo canal de marketing/CRM, já consumido por dashboards de marketing).
- **Fulfillment (dimensão 3)**: já existe como `shipments.delivery_mode` (`pickup`/`delivery`) — os exemplos do dono (`counter`/`shipping`/`pickup`) parecem mapear conceitualmente para o que já existe (`counter`≈`pickup` de balcão), vale confirmar com o dono se querem um terceiro valor explícito ou se `pickup` já cobre "balcão".
- **Documento fiscal (dimensão 4)**: já resolvida por `resolveFiscalDocumentType()` + `fiscal_documents.document_type` (`nfe`/`nfce`) + comprovante fora dessa tabela (`sales.receipt_token`) — só precisa ganhar `sale_type` como novo insumo de decisão, reativando a regra "atacado → NF-e" hoje comentada como adiada.
- **Preço de atacado**: `products.wholesale_price` nullable, paralelo a `base_price` (que vira "preço de varejo" só por convenção de uso, sem renomear a coluna — evita quebrar `margin_pct`/`markup_pct` geradas e dezenas de referências existentes).

## N. Estratégia de rollout/backfill para vendas antigas

- `sale_type DEFAULT 'retail'` cobre automaticamente **100% do histórico** sem necessidade de backfill de dados — toda venda existente é varejo por definição de negócio (não há atacado hoje). Isso é uma vantagem real: nenhuma migration de dados é necessária além do `ALTER TABLE` com default.
- `products.wholesale_price` nasce `NULL` em todos os produtos — nenhum produto vende em atacado até ser explicitamente precificado; não é um "buraco" de dado, é o estado inicial correto.
- Rollout pode ser feito produto a produto / loja a loja: como o PDV usaria o campo novo só se presente, não há necessidade de uma "big bang migration" de preços — mas vale um relatório de "produtos sem preço de atacado" antes de habilitar atacado para o time de vendas.

## O. Estratégia de testes

- `rpc_create_sale_single_overload.test.sql` precisa ser reexecutado após qualquer mudança de assinatura.
- Estender `rpc_create_sale_pricing_invariants.test.sql` para cobrir `sale_type` (default, persistência, imutabilidade após criação — hoje `sale_origin` é editável pós-criação via `PATCH /editar`; decidir se `sale_type` deveria ser imutável, dado que "preservar permanentemente a modalidade original" é requisito explícito do dono).
- Novo teste (hoje inexistente) para `src/lib/fiscal/resolveFiscalDocumentType.ts` cobrindo o novo ramo de decisão de atacado.
- Como `src/services/vendas.service.ts` (criação/cancelamento/devolução/troca) **não tem nenhum teste hoje**, esta é uma boa oportunidade de criar cobertura mínima antes de tocar nesse código — reduz risco real, não é escopo extra desnecessário.
- Novo teste para o fluxo de troca confirmando que `sale_type` é herdado (não zerado) na venda-filha.
- Nenhum teste automatizado hoje cobre DRE/CMV/margem — qualquer relatório novo de retail/wholesale precisará de validação manual contra dado real na ausência de rede de segurança automatizada.

## P. Pontos em que a regra de negócio do dono conflita com a arquitetura existente

1. **Comissão**: o pedido presume "usar a mesma infraestrutura/regra de comissão hoje existente" — **essa infraestrutura não existe**. Não há tabela, coluna, RPC ou tela de comissão em lugar nenhum do código. Precisa ser esclarecido com o dono antes de qualquer implementação: (a) comissão é calculada 100% fora do sistema hoje? (b) o pedido real é criar a infraestrutura de comissão pela primeira vez, só evitando criar uma segunda regra específica de atacado desde o início?
2. **Cliente sem CPF/CNPJ "só para existir"**: `customers.cpf` é `NOT NULL` com `CHECK` de 11 dígitos — é **estruturalmente impossível** hoje criar um cliente sem CPF. Mesmo o cliente "avulso" usa um CPF placeholder (`'11111111111'`). Atender ao requisito exige (a) relaxar o schema de `customers`, ou (b) aceitar que toda venda de atacado sem CPF/CNPJ do cliente usa obrigatoriamente o cliente avulso — o que colide com "quero rastrear quem comprou no atacado" (não dito explicitamente pelo dono, mas implícito em ter cliente/vendedor/comissão por venda de atacado).
3. **NF-e de atacado exige `indFinal=0`** (não é consumidor final), mas o payload fiscal hoje **hardcoda `indFinal=1` sempre** (`src/services/fiscal/types.ts:75`, `nfePayload.types.ts:176`). Isso não é um detalhe pequeno — é uma suposição estrutural do módulo fiscal inteiro (que também limita `CRT` a Simples/MEI e não trata CEST/ICMS-ST) construída assumindo só venda a consumidor final. Habilitar NF-e de atacado de verdade provavelmente exige mais trabalho de regra fiscal do que só "adicionar um campo".
4. **`sale_origin` está sobrecarregado**: já é usado tanto como canal de marketing (dashboards de campanha) quanto como sinal fiscal (decide NF-e vs NFC-e) quanto — potencialmente — como proxy de "veio do site". Introduzir `sales_channel` como campo novo e deixar `sale_origin` como está é a escolha mais segura; tentar reaproveitar/estender `sale_origin` para carregar também canal comercial pioraria essa sobrecarga já existente.
5. **Nuvemshop usa `sale_origin='website'` tanto para pedidos reais da loja quanto venda manual marcada como site pelo operador** — qualquer lógica que infira `sale_type`/canal a partir de dado histórico usando `sale_origin` sozinho terá falsos positivos/negativos. O sinal confiável de "veio da Nuvemshop" é indireto (`pedidos.source='nuvemshop'` + `pedidos.sale_id`), não `sale_origin`.
6. **Preço de atacado por variação**: se o dono espera que cada variação (cor/tamanho) tenha seu próprio preço de atacado igual ao varejo tem hoje (`price_override`), isso dobra a superfície de campos de preço editáveis por produto — vale confirmar se realmente precisa desse nível de granularidade já na primeira fase, ou se preço de atacado só no produto-pai resolve por ora.
7. **Company_fiscal_settings sem UI de edição**: pré-requisito operacional (preencher CNPJ/IE/CRT/endereço do emitente via SQL direto) que já bloqueia NF-e de varejo hoje — ficará ainda mais crítico com volume de NF-e de atacado.

---

# Plano de implementação proposto (fases pequenas e seguras)

**Nenhuma fase abaixo foi implementada.** Ordem sugerida por menor risco e maior valor de desbloqueio, não por facilidade técnica pura.

**Fase 0 — Esclarecimentos com o dono (sem código)**
Resolver os pontos P.1 (comissão), P.2 (CPF/CNPJ obrigatório), P.6 (granularidade de preço por variação) e confirmar semântica de fulfillment (P/seção M) antes de desenhar qualquer migration.

**Fase 1 — Preço de atacado (catálogo)**
`products.wholesale_price` nullable + campo editável em criação/edição manual de produto. Sem tocar PDV/vendas ainda. Baixo risco, testável isoladamente.

**Fase 2 — Modalidade da venda (schema mínimo)**
`sales.sale_type` com default `'retail'` + `sales_channel` novo. Sem tocar RPC ainda (colunas nascem só com default, não usadas). Backfill automático via default, conforme seção N.

**Fase 3 — RPC e PDV**
`rpc_create_sale` ganha `p_sale_type`/`p_sales_channel` (com o cuidado de `DROP FUNCTION` da assinatura antiga). PDV ganha o seletor Varejo/Atacado e passa a resolver preço correspondente na busca de produto. Teste de regressão do overload único.

**Fase 4 — Herança em cancelamento/devolução/troca**
Confirmar (com teste novo) que cancelamento/devolução preservam `sale_type` automaticamente (já deveriam, por construção). Corrigir explicitamente `troca/route.ts` para herdar `sale_type` na venda-filha (em vez de zerar, como hoje faz com `sale_origin`).

**Fase 5 — Fiscal: reativar a regra adiada**
`resolveFiscalDocumentType` ganha `sale_type` como insumo. Resolver o hardcode de `indFinal` para refletir consumidor final vs. revenda. Reavaliar suporte de CRT/CEST se atacado destravar cenários fora de Simples/MEI.

**Fase 6 — Relatórios**
Estender `dashboard.ts`/`sellerDashboard.ts` (padrão já existente de agregação em TS) para incluir a dimensão retail/wholesale nos relatórios de faturamento/ticket médio/CMV/margem/canal/vendedor. DRE **não muda**.

**Fase 7 — CSV import**
Adicionar preço de atacado, NCM, origem fiscal, unidade tributável ao importador (reaproveitando validators existentes). CST/CSOSN/CFOP só depois de decidida a modelagem de armazenamento (Fase 0/discussão à parte).

**Fase 8 — Nuvemshop**
Fixar `sale_type='retail'` explicitamente no webhook (nunca atacado), documentando a decisão no código.

**Fase 9 — Comissão** (depende inteiramente da Fase 0)
Só se a Fase 0 concluir que a infraestrutura de comissão precisa ser criada — nesse caso, é um projeto à parte, não uma sub-tarefa de atacado/varejo.
