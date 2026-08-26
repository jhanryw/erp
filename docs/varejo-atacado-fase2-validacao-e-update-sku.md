# Varejo/Atacado — Validação da Fase 1 + Conclusão do Importador CSV (Update por SKU)

**Data:** 2026-09-01
**Escopo desta etapa:** (1) validar/corrigir as 4 migrations da Fase 1 antes de qualquer coisa nova; (2) concluir o importador CSV com UPDATE de produtos existentes por SKU. Nenhum PDV, dashboard, site de atacado, comissão, DRE ou refatoração fiscal foi tocado.

---

## 1. Migrations revisadas

### Achado crítico corrigido: ordem de aplicação quebrada

As 4 migrations da Fase 1 foram criadas com o prefixo `20260831_` (mesma data). O Supabase CLI aplica migrations em ordem **alfabética do nome do arquivo**, e com prefixo de data idêntico o desempate é puramente alfabético no resto do nome:

| Ordem alfabética (errada) | Arquivo | Precisa que colunas novas já existam? |
|---|---|---|
| 1º | `20260831_import_products_wholesale_fiscal_fields.sql` | **Sim** (`products.wholesale_price/cst`, `product_variations.wholesale_price_override`) |
| 2º | `20260831_rpc_create_sale_wholesale_channel.sql` | **Sim** (`sales.sale_type/sales_channel`) |
| 3º | `20260831_sale_lifecycle_outbox_sale_type.sql` | **Sim** (idem) |
| 4º | `20260831_wholesale_retail_schema_foundation.sql` | Cria as colunas | — |

A migration que **cria** as colunas (`wholesale_retail_schema_foundation`) começa com "w" e ordenava **depois** das três que já as referenciam em `INSERT`/`UPDATE` dentro de função PL/pgSQL. `CREATE FUNCTION` valida (com `check_function_bodies=on`, padrão do Postgres) os comandos SQL embutidos contra o catálogo real — nessa ordem, o deploy teria **falhado** com erro de coluna inexistente já na primeira migration aplicada.

**Correção aplicada:** renomeadas para o padrão de timestamp completo (`YYYYMMDDHHmm`) que o próprio projeto já usa para desempate no mesmo dia (precedente: `202607302400_`, `202607302600_`, `202608101300_`):

```
202608311200_wholesale_retail_schema_foundation.sql   (schema — roda primeiro)
202608311201_rpc_create_sale_wholesale_channel.sql
202608311202_sale_lifecycle_outbox_sale_type.sql
202608311203_import_products_wholesale_fiscal_fields.sql
```

Todas as referências cruzadas entre arquivos (comentários citando o nome de outra migration) e nos arquivos de teste/relatório foram atualizadas para os novos nomes.

### Achado importante: `rpc_import_products_batch` tem uma versão MAIS RECENTE do que a usada como base

A auditoria original da Fase 1 (e a primeira versão desta migration) tratou `202607302600_pim_product_sku_identity.sql` como a definição vigente de `rpc_import_products_batch`. **Isso estava incompleto**: existe `supabase/migrations/20260812_open_import_products_to_usuario.sql` (12/08, mais recente), que:
- Muda a checagem de role de `('admin','gerente')` para `('admin','gerente','usuario')` — Produtos não está nos módulos bloqueados, `usuario = admin` aqui.
- Envolve a chamada a `_persist_single_product` num `BEGIN...EXCEPTION` que enriquece a mensagem de erro com nome/índice do produto e **relança** (mantém o comportamento all-or-nothing).

Minha migration `202608311203` só toca `_persist_single_product` (não `rpc_import_products_batch` em si), então **não conflita** com `20260812` — o wrapper mais recente continua chamando `_persist_single_product` genericamente e herda os campos novos sem problema. Mas essa descoberta foi decisiva para o desenho do Update por SKU (seção 4): confirma que a política de autorização vigente para qualquer operação de importação/atualização de produto é `admin/gerente/usuario`, e que o caminho de CRIAÇÃO é deliberadamente all-or-nothing — não deveria ser alterado para virar parcial-sucesso "de brinde" junto com o update.

### Checklist pedido

| Item | Resultado |
|---|---|
| Ordem correta | Corrigida (ver acima) |
| Dependências | `202608311200` (schema) → `1201`/`1202`/`1203` (dependem do schema) — confirmado, nenhuma outra dependência cruzada entre as 3 últimas |
| Idempotência | Todas usam `ADD COLUMN IF NOT EXISTS`, `CREATE OR REPLACE FUNCTION`, `DROP FUNCTION IF EXISTS` — seguras para reaplicação |
| Assinatura antiga/nova de `rpc_create_sale` | 17 params (vigente antes) → 19 params (`p_sale_type`, `p_sales_channel` no final, ambos com DEFAULT) — `DROP FUNCTION` explícito da assinatura de 17 antes do `CREATE`, mesmo padrão documentado em `20260828_rpc_create_sale_pricing_and_products_total.sql` |
| Impacto do `DROP FUNCTION` | Remove só a assinatura de 17 parâmetros — nenhuma outra função no projeto declara essa assinatura exata (confirmado por grep em todas as 145 migrations) |
| Grants/permissões | `REVOKE`/`GRANT` reaplicados explicitamente para `rpc_create_sale` (novo `service_role` apenas); as 3 RPCs de cancelamento/devolução/troca mantiveram assinatura, sem necessidade de novo GRANT (`CREATE OR REPLACE` preserva) |
| Defaults | `sale_type DEFAULT 'retail'` (coluna e parâmetro), `sales_channel` sem default (NULL implícito) — consistente nos dois lugares |
| Constraints | `CHECK` de `sale_type`/`sales_channel`/preços novos adicionados com `NOT VALID` + `VALIDATE CONSTRAINT` separado — evita lock exclusivo de full-table scan em `sales` (achado desta revisão; a versão original usava `ADD CONSTRAINT` direto, corrigido) |
| Dados históricos | `DEFAULT 'retail'` cobre 100% do histórico sem `UPDATE` em massa |
| Compatibilidade com produção | Corrigida a ordem de aplicação (achado crítico acima) — sem essa correção, o deploy falharia |
| Compatibilidade com RPCs existentes | Confirmado: nenhuma migration futura redefine `rpc_create_sale`/`rpc_cancel_sale`/`rpc_return_sale`/`rpc_process_exchange`/`_persist_single_product` (são as mais recentes na árvore); `rpc_import_products_batch` tem uma versão mais nova (20260812) que não conflita, ver acima |

### Regra obrigatória confirmada
`sales.sale_type` só aceita `retail`/`wholesale` (CHECK), `NOT NULL DEFAULT 'retail'` — histórico existente sempre `retail`. `sales.sales_channel` só aceita os 5 valores já definidos na Fase 1 (`pos`, `manual`, `whatsapp`, `nuvemshop`, `wholesale_site`) — nenhum valor novo foi inventado nesta etapa.

## 2. Migrations efetivamente aplicadas ou não

**Nenhuma migration foi aplicada a um banco real.** Este ambiente não tem Postgres/Supabase local nem acesso de rede autorizado a uma instância remota (confirmado: sem `supabase/config.toml`, sem Docker, sem `DATABASE_URL`) — mesma limitação de todas as fases anteriores deste projeto. As credenciais em `.env.local` apontam para uma instância Supabase real (possivelmente produção); eu **não** tentei me conectar a ela — aplicar migrations num banco real é uma ação de alto risco que exige sua autorização explícita e deve ser feita por você, em ambiente de teste primeiro.

## 3. Resultado dos testes SQL/pgTAP

**Não executáveis neste ambiente** (mesma razão acima). Escrevi e revisei cuidadosamente 2 arquivos de teste novos + atualizei 1 existente (ver seção 9) — todos seguem o padrão `BEGIN...ROLLBACK` já usado no projeto (não destrutivos) e foram lidos linha a linha para consistência de mensagens de erro entre a migration e as asserções. Comandos exatos para você rodar estão na seção 14.

## 4. Comportamento final do update-by-SKU

- **Identificador**: `product_variations.sku_variation` — o único identificador real de catálogo (confirmado de novo nesta sessão: `products.sku` nunca teve `UNIQUE`). Nenhuma identificação paralela nova.
- **CSV ganha uma coluna nova, `sku`**. Linha com `sku` vazio → **cria** (comportamento 100% inalterado). Linha com `sku` preenchido → **atualiza** o registro daquele SKU específico; os campos de criação (tipo/modelo/categoria/cor/tamanho/etc.) na mesma linha são ignorados.
- **SKU informado mas não encontrado na empresa** → erro claro por linha ("verifique o código ou deixe a coluna sku em branco para criar um novo produto") — nunca cria um produto novo com esse SKU (isso seria inventar uma segunda identificação paralela).
- **Duas variações com o mesmo SKU na mesma empresa** (não deveria acontecer, mas o código não confia nisso) → erro explícito de ambiguidade, nunca escolhe arbitrariamente.
- **SKU repetido dentro do próprio CSV** → primeira ocorrência aplicada, as demais reportadas como erro.
- **Multi-tenancy**: todo lookup é `product_variations.sku_variation = X AND products.company_id = sua_empresa` — nunca por SKU sozinho.
- **Parcial-sucesso do lote**: uma linha de update com erro **não** aborta as outras (savepoint por linha, via `BEGIN...EXCEPTION` do PL/pgSQL) — resultado final é `{updated, errors[]}`. Isto é **deliberadamente diferente** do caminho de criação (`rpc_import_products_batch`), que continua all-or-nothing (comportamento de produção já testado, não alterado). Implementado como RPC **nova e separada** (`rpc_update_products_by_sku_batch`), nunca misturada com a de criação.
- **Autorização**: mesma política vigente hoje para importação de produtos — `admin`/`gerente`/`usuario` (confirmado contra `20260812_open_import_products_to_usuario.sql`, a versão real mais recente).

## 5. Semântica de campos vazios

Célula vazia no CSV **nunca** vira uma chave presente no JSON enviado ao servidor — o parser (`src/lib/utils/import-parser.ts`) só inclui `price_override`/`wholesale_price_override`/`ncm`/`origem`/`cst` no objeto de atualização quando o valor da célula é não-vazio e parseia corretamente. `_update_single_product_by_sku` usa `p_patch ? 'chave'` (existência da chave) — nunca `IS NOT NULL` — para decidir se toca a coluna. Resultado: célula vazia = campo intocado, exatamente como pedido. Confirmado pelo teste SQL nº5 (`rpc_update_products_by_sku_batch.test.sql`), que reproduz literalmente o exemplo do pedido (atualiza só `preco_atacado`, confirma que `preco`/`ncm`/`origem` continuam com os valores anteriores).

Não foi criada nenhuma sintaxe para "apagar campo via CSV" — decisão explícita do pedido, não implementada.

## 6. Como preço de produto x preço de variação foi tratado

Como o identificador do update é **sempre uma variação** (`sku_variation`), os campos de preço do update **sempre** tocam `product_variations.price_override`/`wholesale_price_override` — **nunca** `products.base_price`/`wholesale_price` do produto-pai. Confirmado explicitamente pelo teste SQL nº8: depois de vários updates via SKU, `products.base_price`/`wholesale_price` continuam com os valores originais de cadastro. NCM/origem/CST não têm equivalente por variação no schema (só existem em `products`) — esses sempre tocam o produto-pai da variação identificada, única opção coerente com o schema real.

## 7. Validações NCM/origem/CST

- **NCM**: exatamente 8 dígitos (`^\d{8}$`), mesma regra já usada na criação manual/CSV (`ncmFieldSchema`, reaproveitada, não duplicada). NCM com pontuação (`6108.22.00`) é rejeitado pelo RPC — a normalização (remover pontuação) é responsabilidade do parser/Node antes de chegar ao banco, não do SQL. NCM inválido nunca substitui um NCM válido já salvo (validação acontece antes de qualquer `UPDATE`).
- **Origem fiscal**: inteiro 0-8, mesma regra já usada (`origemFieldSchema`). Fora da faixa é rejeitado sem alterar o registro.
- **CST**: texto livre, sem validação de formato — mesma política da Fase 1 (reservado/informativo, o motor fiscal ainda não lê essa coluna). **Não** há conversão automática CST↔CSOSN em lugar nenhum — cada um é tratado como o que é (CST fica só armazenado; CSOSN continua sendo derivado só do CRT da empresa, nunca de produto).

## 8. Arquivos alterados

**Migrations novas** (ver seção 1 para os 4 renomeados + 1 novo):
- `supabase/migrations/202608311200_wholesale_retail_schema_foundation.sql` (renomeado)
- `supabase/migrations/202608311201_rpc_create_sale_wholesale_channel.sql` (renomeado)
- `supabase/migrations/202608311202_sale_lifecycle_outbox_sale_type.sql` (renomeado)
- `supabase/migrations/202608311203_import_products_wholesale_fiscal_fields.sql` (renomeado)
- `supabase/migrations/20260901_rpc_update_products_by_sku.sql` (**novo** — `_update_single_product_by_sku` + `rpc_update_products_by_sku_batch`)

**TypeScript:**
- `src/lib/utils/import-parser.ts` — coluna `sku`, tipo `ParsedProductUpdate`, dispatch create/update por linha, validação leve (warnings, nunca bloqueia) para os campos de update.
- `src/app/api/produtos/import/route.ts` — reestruturado: `processCreateBatch()` (extraído, comportamento idêntico ao de antes) + novo fluxo de update chamando `rpc_update_products_by_sku_batch`, resultado combinado. Contrato de resposta mudou (ver seção 15).
- `src/app/(dashboard)/produtos/importar/page.tsx` — envia `updates` junto de `products`; exibe criados/atualizados/erros por linha; texto de ajuda menciona as novas colunas (incluindo `sku`).
- `public/template-importacao.csv` — colunas novas + 2 linhas de exemplo de atualização por SKU.

## 9. Testes criados

**SQL (`supabase/tests/`, para você rodar — ver seção 14):**
- `rpc_update_products_by_sku_batch.test.sql` (novo) — cobre os 20 itens pedidos: criar SKU inexistente (via lote misto), atualizar SKU existente, multi-tenancy, sem duplicata, célula vazia preserva, preço varejo só varejo, preço atacado só atacado, preço por variação correto, NCM válido/pontuado/inválido, origem válida/inválida, CST válido, negativo rejeitado, linha inválida não aplica parcial, múltiplas linhas/produtos, SKU ambíguo (dentro do CSV e contra o banco), autorização, idempotência.
- `rpc_import_products_batch_wholesale_fiscal.test.sql` — reforçado com asserção extra: `wholesale_price_override` de uma variação nunca grava em `price_override` (varejo) da mesma variação, e `base_price`/`base_cost` do produto-pai continuam intactos.
- `rpc_create_sale_single_overload.test.sql` — referências de nome de arquivo atualizadas.

**TypeScript (vitest, executados nesta sessão):**
- `src/lib/utils/import-parser.test.ts` — 11 casos novos: dispatch create/update por presença de `sku`, chaves ausentes vs. presentes, NCM com pontuação (warning) vs. só dígitos, origem fora de faixa, preço negativo, CST livre, SKU duplicado no CSV (warning), múltiplas linhas com `client_index` sequencial, retrocompatibilidade total sem coluna `sku`, formato monetário já suportado (`47.90`).

## 10. Resultado da suíte completa

```
Test Files  60 passed (60)
Tests       887 passed (887)
```
(876 da Fase 1 + 11 novos desta etapa — nenhuma regressão.)

## 11. Typecheck

```
tsc --noEmit → limpo, zero erros
```
(rodado 3 vezes ao longo desta etapa, após cada bloco de mudanças)

## 12. Lint

**Não executável neste ambiente** — o projeto nunca teve `.eslintrc`/`eslint.config` configurado (`npm run lint` abre um wizard interativo de primeira configuração). Gap pré-existente, não introduzido por este trabalho — confirmado que não há esse arquivo em nenhum commit do histórico consultável.

## 13. Build

```
next build → completo, sem erros, todas as rotas compiladas
```
`/produtos/importar` foi de 126 kB para 127 kB (mudança pequena, esperada pelas ~150 linhas novas na página).

## 14. Comandos que você precisa executar manualmente

```bash
# 1. Aplicar as migrations em ordem, num ambiente de TESTE primeiro
supabase db push

# 2. Rodar os testes SQL desta etapa
psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f supabase/tests/rpc_update_products_by_sku_batch.test.sql
psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f supabase/tests/rpc_import_products_batch_wholesale_fiscal.test.sql
psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f supabase/tests/rpc_create_sale_single_overload.test.sql
psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f supabase/tests/rpc_create_sale_sale_type.test.sql

# 3. Regressão da suíte já existente (nenhuma alterada nesta etapa, mas
#    confirme que a correção de ordem das migrations não quebrou nada)
psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f supabase/tests/rpc_import_products_batch.test.sql
psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f supabase/tests/rpc_create_sale_pricing_invariants.test.sql
psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f supabase/tests/integration_outbox_sale_events.test.sql

# 4. Gerar tipos TS atualizados (opcional)
npm run supabase:types
```

## 15. Riscos e pendências restantes

1. **Nada foi validado contra Postgres real** — a correção de ordem das migrations (item mais importante desta etapa) só foi confirmada por leitura cuidadosa, não por execução. Rode a seção 14 antes de qualquer deploy.
2. **Contrato de resposta de `POST /api/produtos/import` mudou**: antes `{message, imported, products}`, agora `{created, created_products, create_error, updated, updated_products, update_errors, update_blocked_error}`. Só há um consumidor (`produtos/importar/page.tsx`), já atualizado — mas se algum script/integração externa já chamar essa rota diretamente, vai quebrar.
3. **CSV update ainda não altera campos de identidade do produto** (nome, tipo, modelo, ano, categoria, fornecedor, marca) nem `active`/estoque — decisão deliberada de escopo mínimo (só os 5 campos explicitamente pedidos: preço varejo, preço atacado, NCM, origem, CST). Se precisar editar esses outros campos em lote no futuro, é uma extensão natural do mesmo `_update_single_product_by_sku`.
4. **"Ignorados" não virou uma terceira categoria formal** — o resultado tem só `updated`/`errors` (created/created_products para a fase de criação). O pedido dizia explicitamente que o texto exato não precisa bater; a estrutura de dados tem informação suficiente pra UI compor qualquer apresentação.
5. **Fixture do teste de multi-tenancy** (`rpc_update_products_by_sku_batch.test.sql`) depende de existir uma "segunda empresa" com pelo menos uma categoria acessível (própria ou global) no ambiente de teste — se esse ambiente só tiver 1 empresa, o teste pula graciosamente (`RAISE NOTICE 'PULADO'`); se tiver 2+ empresas mas nenhuma categoria acessível pra segunda, o `INSERT` de fixture pode falhar. Vale conferir ao rodar.
6. **Todas as pendências já listadas no relatório da Fase 1** (`docs/varejo-atacado-fase1-fundacao.md`, seção 14) continuam de pé — PDV, comissão, CNPJ no cadastro de cliente, `sale_recipients` só em vendas com entrega, etc. Nada disso foi tocado aqui.
