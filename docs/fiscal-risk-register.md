# Registro de Riscos — Módulo Fiscal (NF-e/NFC-e) — ERP Santtorini

Complementa [`fiscal-audit-report.md`](fiscal-audit-report.md). Auditoria READ-ONLY, 2026-08-04. Toda citação é `arquivo:linha`. Itens marcados **[LIVE]** precisam de confirmação por consulta SQL somente leitura (ver [`fiscal-audit-readonly.sql`](fiscal-audit-readonly.sql)) antes de serem tratados como fato definitivo.

Classificação: **Crítico** (bloqueia qualquer emissão fiscal real) · **Alto** (compromete integridade fiscal/financeira se não corrigido) · **Médio** (risco operacional relevante, não bloqueador) · **Baixo** (qualidade/manutenibilidade)

---

## Críticos

| # | Risco | Evidência | Impacto | Ação recomendada |
|---|---|---|---|---|
| C1 | `companies` não tem nenhum campo fiscal (CNPJ/IE/IM/CRT/endereço/IBGE) | `src/lib/db/migrations/archive/005_multi_tenant.sql:26-34`, confirmado sem nenhum `ALTER TABLE companies` adicionando coluna em toda a árvore de migrations | Impossível montar o bloco `<emit>` de qualquer NF-e/NFC-e | Criar `fiscal_establishments` (ou colunas em `companies`) — Fase 1 |
| C2 | `customers` não suporta CNPJ/PJ | grep de `cnpj` em `supabase/migrations/*.sql` → zero resultados | Impossível emitir NF-e para CNPJ (atacado/B2B) | Estender `customers` ou criar tabela de destinatário PJ — Fase 2 |
| C3 | CFOP/CST(ICMS,PIS,COFINS)/CSOSN inexistentes em qualquer tabela ou código | grep case-insensitive em ambas as árvores de migration, zero resultados | Impossível calcular ou declarar tributação de qualquer item | Depende de definição da contabilidade (CRT) antes de modelar — Fase 1/2 |
| C4 | Nenhum dado fiscal de operação (alíquotas, FCP, ICMS-ST, IBS, CBS) | mesmo grep acima | Bloqueia cálculo de imposto e emissão | Idem C3 |
| C5 | Empresa não possui certificado digital nem confirmação de CSC | Declarado no contexto de negócio, não é achado técnico | Bloqueia qualquer transmissão real (homologação ou produção) | Bloqueador externo — Santtorini |
| C6 | Credenciamento na SEFAZ/RN não confirmado | Idem | Bloqueia qualquer transmissão real | Bloqueador externo — Santtorini junto à SEFAZ/RN |
| C7 | Nenhum ambiente de homologação (aplicação nem SEFAZ) | Zero ocorrências de `STAGING`/`HOMOLOG`/`SANDBOX` em `.env.example`, `.env.local`, `src/`; sem `supabase/config.toml`; sem `.github/workflows` | Impossível testar emissão sem risco de transmitir em produção por engano | Criar ambiente de homologação antes de qualquer Fase 3/4 |
| C8 | Nenhuma tabela/enum de documento fiscal existe | grep de `fiscal`, `nfe`, `nfce`, `invoice`, `nota_fiscal` em ambas as árvores → zero resultados fora dos dois arquivos de preparação já conhecidos (`20260615_products_fiscal_fields.sql`, `20260613_shipping_fiscal_ready.sql`) | Confirma que este é trabalho 100% novo — não há nada a "religar" | Modelar do zero — Fase 1 |

---

## Altos

| # | Risco | Evidência | Impacto | Ação recomendada |
|---|---|---|---|---|
| A1 | `sales.products_total` (vProd) populado por 1 dia e depois NULL em toda venda desde 14/06/2026 | Tabela cronológica completa em `fiscal-audit-report.md` §Resumo Executivo; `grep -rn "products_total" supabase/migrations/*.sql` só aparece em `20260613_shipping_fiscal_ready.sql`; `grep -rln "products_total" src/` → zero | Qualquer motor fiscal que confie nesse campo pega dado nulo silenciosamente | **[LIVE]** Confirmar escopo real (query 1), depois decidir entre backfill+correção do RPC ou descontinuar a coluna |
| A2 | Preço unitário do item de venda é 100% confiado do payload do cliente HTTP, sem reconciliação contra catálogo | `src/app/api/vendas/route.ts:157-163` (schema aceita `unit_price` livre); `supabase/migrations/20260627_rpc_create_sale_v4.sql:122-137` (RPC só valida `company_id`, não preço) | Valor declarado na fiscal pode não corresponder ao preço real do produto; abre porta para subfaturamento acidental ou deliberado | Adicionar busca server-side do preço de catálogo antes de aceitar `unit_price` — recomendado independentemente do módulo fiscal |
| A3 | `/api/vendas/[id]/editar` não verifica `sales.status` antes de permitir alteração de `sale_date`/`notes`/`sale_origin` | `src/app/api/vendas/[id]/editar/route.ts:44-69` — busca `status` mas nunca usa no fluxo de decisão | `sale_date` alterável após emissão fiscal quebraria o vínculo venda↔documento fiscal | Bloquear edição quando existir documento fiscal autorizado vinculado — Fase 1/3 |
| A4 | Nenhuma infraestrutura de impressão térmica/DANFE | `grep -rniE "print|cupom|danfe|qz.?tray"` em `src/` → único hit é `window.print()` para etiqueta A4 de envio (`src/app/(dashboard)/vendas/[id]/imprimir/*`); nenhuma lib de PDF/ESC-POS/WebUSB no `package.json` | Impossível emitir cupom térmico automaticamente no PDV | Nova infraestrutura — avaliar página de impressão dedicada, agente local, ou WebUSB — Fase 3 |
| A5 | Duas árvores de migration divergentes, uma comprovadamente errada em pontos estruturais | `supabase/migrations/202607302600_pim_product_sku_identity.sql:12-18` (admissão explícita do time: `000_schema_completo.sql` está errado sobre unicidade de `products.sku`, `stock`/`stock_balances`, `rpc_stock_initialize`); `pedidos`/`pedidos_itens` ausentes de `000_schema_completo.sql` | Qualquer trabalho de modelagem que use a árvore legada como referência herda erros | **[LIVE]** `pg_dump --schema-only` antes de desenhar o módulo fiscal definitivamente |
| A6 | `products.sku` não é UNIQUE de fato (apesar de `000_schema_completo.sql` afirmar que é) | `supabase/migrations/202607302600_pim_product_sku_identity.sql:12-40` — admissão datada do time, com histórico de até 44 produtos compartilhando o mesmo SKU base | Ambiguidade de identidade de produto pode contaminar item fiscal (NCM errado se SKU mapear para produto errado) | **[LIVE]** Confirmar estado real via `pg_constraint`/`pg_indexes` (query incluída) |
| A7 | Segredos (`SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET`) declarados como build ARG no Dockerfile | `Dockerfile:5-9,16-21,29-40` | Se o pipeline de build logar ARGs, segredo vaza; relevante antes de introduzir segredo de certificado digital no mesmo padrão | Corrigir o padrão de injeção de segredo do Dockerfile antes de adicionar `CERTIFICATE_PFX_BASE64`/`CERTIFICATE_PASSWORD` |

---

## Médios

| # | Risco | Evidência | Impacto | Ação recomendada |
|---|---|---|---|---|
| M1 | `generate_sale_number()` é `COUNT(*)+1` global (não por empresa), sem `nextval()`/lock explícito, corrida mitigada só por `UNIQUE` (falha dura sem retry) | `src/lib/db/migrations/000_schema_completo.sql:289-305` (única definição em todo o repo); `src/services/vendas.service.ts:271-283` não trata `23505` com retry | Falha de venda em concorrência real de PDV; não é fiscal em si, mas o padrão precisa ser substituído por reserva transacional para numeração fiscal | Não reutilizar este padrão para `fiscal_document_series` — usar `UPDATE ... RETURNING` |
| M2 | Split de pagamento (`sale_payments[]`) não reconciliado contra `sales.total` no servidor | `supabase/migrations/20260704_fix_cashback_expiry_and_earn.sql` (RPC não soma `net_amount` e compara a `v_total`); gate existe só no frontend (`src/app/(dashboard)/vendas/nova/page.tsx:349-354`) | Chamada direta à API pode gravar pagamentos que não somam o total da venda | Adicionar `RAISE EXCEPTION IF sum(net_amount) <> v_total` no RPC |
| M3 | Cashback 100% não gera linha em `sale_payments` | `src/services/vendas.service.ts:252`, `route.ts:182` (`payments: []` documentado) | Reconciliação fiscal que soma só `sale_payments` não vê a parcela paga em cashback | Modelar explicitamente "cashback" como forma de tender no documento fiscal, à parte de `sale_payments` |
| M4 | `sale_payments.acquirer`/`card_brand` são texto livre; NSU/código de autorização/CNPJ da adquirente só existiriam em `metadata` JSONB não validado e hoje não populado | `supabase/migrations/20260522_sale_payments_table.sql:57-58` (coluna existe, comentário documenta intenção, mas RPC não a preenche) | Detalhe de meio de pagamento pode não estar disponível/estruturado para exigências de NFC-e | Ativar preenchimento de `metadata` com schema validado, ou criar colunas dedicadas |
| M5 | RLS habilitado sem nenhuma policy em `sale_items` e `product_variations`; `companies` sem RLS nenhuma | `src/lib/db/migrations/000_schema_completo.sql:1820-1855` (seção RLS não cobre essas tabelas) | Mitigado hoje porque app usa só `service_role` (ignora RLS), mas é lacuna real de defesa em profundidade | **[LIVE]** Confirmar `pg_policies`; adicionar policies faltantes |
| M6 | Possíveis policies antigas permissivas (`USING (true)`) nunca dropadas, coexistindo com policies novas por `company_id` | `src/lib/db/migrations/archive/001_rls_and_audit.sql:74-186`; nenhum `DROP POLICY` encontrado para essas policies em toda a árvore | Se ainda ativas no banco real, tornam as policies novas redundantes (RLS é permissivo/OR) | **[LIVE]** Confirmar via `pg_policies`; dropar policies antigas se confirmado |
| M7 | Trocas parciais não fecham `sales.status` (permanece `'paid'` mesmo com parte revertida) | `supabase/migrations/20260726_fix_rpc_process_exchange_guards.sql:212-227` — só fecha o status quando 100% da venda foi trocada | Uma venda parcialmente revertida continua "paga" no sistema, dificultando saber se precisa de nota de ajuste/devolução | Definir política de documento fiscal complementar para trocas parciais |
| M8 | Duas tabelas paralelas para devolução (`returns`/`return_items` legado vs. `exchanges`/`exchange_items` ativo) | `src/lib/db/migrations/000_schema_completo.sql:773-798` vs. `supabase/migrations/20260609_exchanges.sql:13-40` | Ambíguo qual é a fonte de verdade para desenhar a NF-e de devolução | Confirmar com o time qual caminho é realmente usado hoje antes de modelar |
| M9 | Nenhum ambiente separado de produção/homologação para a aplicação como um todo (sem CI, sem staging) | `.github/workflows` inexistente; nenhum indício de `STAGING`/`HOMOLOG` em env | Qualquer mudança no motor de vendas para suportar fiscal vai direto para produção sem gate automatizado | Considerar introduzir ao menos testes automatizados + ambiente de homologação de aplicação antes da Fase 3 |
| M10 | `ALERT_COMPANY_ID`/alertas via WhatsApp hardcoded para 1 empresa | `.env.example:52-56` (comentário do próprio time reconhece isso como solução temporária) | Alertas fiscais (certificado expirando) herdando esse padrão não escalam além de 1 empresa sem trabalho extra | Generalizar para `company_id` antes ou durante a Fase 1 fiscal, se relevante |

---

## Baixos

| # | Risco | Evidência | Impacto | Ação recomendada |
|---|---|---|---|---|
| B1 | Ausência de CI/CD no repositório | `.github/workflows` não existe; nenhum outro CI encontrado | Nenhum gate automatizado de lint/typecheck/teste antes de deploy | Considerar introduzir, não bloqueador direto do módulo fiscal |
| B2 | Webhook outbound v1 (N8N) tem checagem de idempotência não-atômica (`SELECT` seguido de `INSERT`, sem lock) | `src/app/api/vendas/route.ts:104-112` | Risco de disparo duplicado em concorrência rara | Migrar para o padrão v2 (índice único), já existente no mesmo arquivo |
| B3 | `TECHNICAL_NOTES.md`/`ARCHITECTURE.md` desatualizados (RBAC de 2 papéis documentado vs. 3 reais; 5 jobs de cron documentados vs. 3 reais) | `ARCHITECTURE.md:74-107` (datado 15/03/2026) vs. `src/types/roles.ts:40-58`; `TECHNICAL_NOTES.md:319-327` vs. `src/app/api/jobs/*` (3 arquivos reais) | Risco de decisão baseada em documentação desatualizada | Atualizar a documentação ou tratá-la explicitamente como histórica |

---

## Itens que dependem de confirmação via banco live

Ver [`fiscal-audit-readonly.sql`](fiscal-audit-readonly.sql) para as consultas correspondentes:
1. Contagem de `sales` com `products_total IS NULL` por data (A1)
2. `pg_policies` para `companies`, `products`, `sales`, `sale_items`, `product_variations`, `customers`, `sale_payments` (M5, M6)
3. `pg_constraint`/`pg_indexes` para `products.sku` e `product_variations.sku_variation` (A6)
4. Estrutura real (colunas) de `companies`, `products`, `customers`, `pedidos`, `pedidos_itens` via `information_schema.columns` (A5)
5. Inventário completo de schemas/tabelas/triggers/functions/views/enums (item 24 do prompt-mestre, cobertura geral)
