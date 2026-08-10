# Análise da Regressão — `sales.products_total`

**Tipo:** análise técnica isolada, read-only. Não é uma correção nem uma proposta de migration executável — é diagnóstico completo, exatamente como solicitado. Nenhum código foi alterado.

**Relação com o módulo fiscal:** este é um bug de manutenção de dados, não uma decisão fiscal. Ele afeta qualquer consumidor futuro (fiscal ou não) do campo `products_total`. Como detalhado na seção "Dependência com a Fase 1 fiscal" ao final, **a correção deste bug não é pré-requisito bloqueante da arquitetura fiscal proposta** — mas é uma boa prática de higiene de dados corrigi-lo de qualquer forma, independentemente da decisão de avançar ou não para a Fase 2.

---

## 1. Arquivo e função exata onde o campo deixou de ser preenchido

- **Campo criado e preenchido corretamente em:** `supabase/migrations/20260613_shipping_fiscal_ready.sql`
  - `ALTER TABLE public.sales ADD COLUMN IF NOT EXISTS products_total NUMERIC(10,2);` — linha 62-63.
  - Backfill histórico (na própria migration, para as vendas já existentes até aquele momento): `UPDATE public.sales SET products_total = ROUND(COALESCE(subtotal,0) - COALESCE(discount_amount,0), 2) WHERE products_total IS NULL;` — linhas 67-72.
  - `COMMENT ON COLUMN` documentando o mapeamento fiscal: linhas 74-75 — *"Valor líquido dos produtos (subtotal - discount_amount), sem frete/surcharge. Mapeamento NF-e: vProd - vDesc."*
  - Versão de `rpc_create_sale` que passou a gravar o campo em toda nova venda: mesma migration, declaração `v_products_total numeric` (linha 220), cálculo `v_products_total := ROUND(v_subtotal - COALESCE(p_discount_amount, 0), 2);` (linha 296), e inclusão no `INSERT INTO sales (..., subtotal, products_total, ...)` (linhas 323-338).
  - Uma view gerencial também foi criada nesta mesma migration referenciando o campo: `public.vw_sale_shipping_summary` (`CREATE VIEW`, linhas 142-173), selecionando `s.products_total` na linha 148.

- **Campo removido do `INSERT` na reescrita seguinte:** `supabase/migrations/20260614_rpc_create_sale_main_store_only.sql`, `INSERT INTO sales (...)` nas linhas 293-297 — a lista de colunas volta a ser `customer_id, seller_id, status, subtotal, discount_amount, surcharge_amount, cashback_used, shipping_charged, total, payment_method, sale_origin, notes, sale_date, company_id, cash_session_id`, **sem `products_total`**. Nenhuma variável `v_products_total` é declarada nesta versão da função.

**Causa raiz identificada com precisão (não é apenas inferência de datas — está documentada no próprio cabeçalho do arquivo):** `supabase/migrations/20260614_rpc_create_sale_main_store_only.sql`, linhas 12-14, descreve a PARTE 2 desta migration como *"Reverte `rpc_create_sale` para Estoque Loja exclusivo — CONTEXTO: `20260612_remove_transfer_requirement.sql` adicionou fallback para qualquer local ativo com saldo ao vender presencialmente. REVERSÃO: venda presencial exige saldo no Estoque Loja."* — ou seja, **o autor desta migration partiu explicitamente de `20260612_remove_transfer_requirement.sql` como base para reverter um comportamento de estoque**, não de `20260613_shipping_fiscal_ready.sql` (que veio depois, no dia seguinte). Como `20260612_remove_transfer_requirement.sql` é anterior à adição de `products_total`, a reescrita de `20260614` naturalmente não incluiu essa coluna — ela nunca foi removida deliberadamente, foi simplesmente **reintroduzida a partir de uma base que não a continha**, num contexto de trabalho (correção de regra de estoque) inteiramente alheio ao trabalho fiscal do dia anterior. Isso explica por que nenhuma migration posterior comenta sobre a remoção: ninguém removeu nada conscientemente, a reescrita simplesmente não sabia que a coluna deveria estar lá.

---

## 2. Linha do tempo completa das migrations relacionadas

Toda migration que (re)define `public.rpc_create_sale`, em ordem cronológica pelo nome do arquivo (todas confirmadas por `grep -rlE "CREATE (OR REPLACE )?FUNCTION public\.rpc_create_sale\b"`, que captura tanto `CREATE OR REPLACE` quanto o padrão `DROP FUNCTION` + `CREATE FUNCTION` usado quando a assinatura de parâmetros muda):

| # | Arquivo | `products_total` no `INSERT INTO sales`? | Observação |
|---|---|---|---|
| 1 | `20260522_rpc_create_sale_cash_session.sql:229-243` | Não existe ainda (campo não foi criado) | — |
| 2 | `20260522_rpc_create_sale_payments.sql:215-228` | Não existe ainda | — |
| 3 | `20260610_multi_estoque.sql:699-712` | Não existe ainda | — |
| 4 | `20260612_fix_cashback_earn.sql:149-162` | Não existe ainda | Citada como "base" pela migration seguinte (20260613) |
| 5 | `20260612_remove_transfer_requirement.sql:134-147` | Não existe ainda | Citada como "base" pela migration que causa a regressão (20260614) |
| 6 | **`20260613_shipping_fiscal_ready.sql:323-338`** | **SIM** — `subtotal, products_total, discount_amount, ...` | Único momento em que o campo é gravado por código de aplicação |
| 7 | **`20260614_rpc_create_sale_main_store_only.sql:293-306`** | **NÃO** — regressão começa aqui | Base explícita: migration #5, não #6 (ver Seção 1) |
| 8 | `20260617_rpc_create_sale_stock_mode.sql:187-200` | Não | `DROP FUNCTION` + `CREATE FUNCTION` (mudança de assinatura), sem reintroduzir o campo |
| 9 | `20260626_fix_cashback_balance.sql:227-240` | Não | — |
| 10 | `20260626_fix_finance_entries_v_total.sql:171-184` | Não | — |
| 11 | `20260627_rpc_create_sale_v4.sql:202-217` | Não | `DROP FUNCTION` + `CREATE FUNCTION`, adiciona `p_responsible_seller_id` |
| 12 | **`20260704_fix_cashback_expiry_and_earn.sql:268-283`** | **Não — versão vigente** | Confirmado: nenhuma migration com data posterior a 04/07/2026 menciona `rpc_create_sale` em nenhuma forma (`grep -rl "rpc_create_sale" supabase/migrations/*.sql` não retorna nenhum arquivo com prefixo de data posterior a `20260704`; a última migration do repositório inteiro é `202607302700_fix_markup_pct_overflow_and_import_error_detail.sql`, de 30/07, e não toca essa função) |

**Confirmação de que não existe nenhuma outra ocorrência da string `products_total`:** `grep -rn "products_total" supabase/migrations/*.sql src/lib/db/migrations/*.sql src/lib/db/migrations/archive/*.sql` retorna resultados **somente** dentro de `20260613_shipping_fiscal_ready.sql` (ALTER, backfill, comentário, view, declaração de variável, cálculo, INSERT, e o bloco de rollback comentado ao final do próprio arquivo). `grep -rln "products_total" src/` (código de aplicação) retorna **zero arquivos**.

---

## 3. Qual versão da função está vigente

`supabase/migrations/20260704_fix_cashback_expiry_and_earn.sql`, função `public.rpc_create_sale` (definição completa no arquivo, `INSERT INTO sales` nas linhas 268-283). Confirmado como a versão vigente porque nenhuma migration com data posterior redefine essa função (checagem exaustiva acima).

---

## 4. Como o total é calculado atualmente

Na versão vigente (`20260704_fix_cashback_expiry_and_earn.sql`):
```sql
v_gross := ROUND(v_subtotal - COALESCE(p_discount_amount, 0) + v_surcharge + COALESCE(p_shipping_charged, 0), 2);  -- linha 200
v_total := ROUND(v_gross - v_eff_cashback, 2);                                                                     -- linha 201
```
onde `v_subtotal` é acumulado item a item durante o loop de inserção de `sale_items`: `v_subtotal := v_subtotal + ROUND(v_unit_price * v_qty - v_discount, 2);` (linha 194).

**Ponto central desta análise:** `products_total` **nunca foi um insumo do cálculo de `total`** — ele sempre foi um campo *derivado*, calculado e gravado só para leitura posterior (mapeamento fiscal `vProd`), em paralelo ao cálculo real de `v_total`. Removê-lo do `INSERT` não quebrou nenhum cálculo de venda, pagamento, estoque ou cashback — por isso a regressão nunca gerou nenhum sintoma visível em produção, o que explica por que passou 7 semanas sem ser notada.

`sales.subtotal` e `sales.discount_amount` — os dois componentes originais da fórmula de `products_total` — **continuam sendo gravados normalmente em toda venda, em todas as 12 versões da função, sem exceção** (confirmado na tabela da Seção 2: ambos aparecem no `INSERT INTO sales` de todas as 12 migrations).

---

## 5. Outro campo substituiu `products_total`?

**Não.** Nenhum novo campo foi criado com propósito equivalente em nenhuma migration posterior. `sales.subtotal` e `sales.discount_amount` sempre existiram (desde antes de `products_total`) e continuam existindo e sendo preenchidos — eles não "substituíram" `products_total`, eles são os dois campos originais a partir dos quais `products_total` sempre foi calculado (`products_total = subtotal - discount_amount`, conforme o próprio comentário da migration de origem, linha 17 de `20260613_shipping_fiscal_ready.sql`). Ou seja, **o dado-fonte nunca deixou de existir — só o campo derivado parou de ser recalculado e persistido.**

---

## 6. Quais telas, relatórios, APIs e integrações ainda usam esse campo

- **Código de aplicação (`src/`):** nenhum. `grep -rln "products_total" src/` → zero arquivos. Nenhuma tela, componente, rota de API ou serviço lê ou escreve esse campo.
- **Banco de dados:** a view `public.vw_sale_shipping_summary` (criada em `20260613_shipping_fiscal_ready.sql:142-173`) seleciona `s.products_total` na linha 148 e **nunca foi redefinida em nenhuma migration posterior** (`grep -rln "vw_sale_shipping_summary" supabase/migrations/*.sql` retorna só o arquivo de origem). Essa view tem `GRANT SELECT` para `authenticated, service_role` (linha 175) — ou seja, ela continua existindo e acessível no banco, mas **nenhum arquivo em `src/` a consulta** (`grep -rn "vw_sale_shipping_summary" src/` → zero resultados). Isso significa: se alguém consultar essa view manualmente (SQL Editor, ferramenta de BI externa, exportação para a contabilidade), receberá `products_total = NULL` para toda venda desde 14/06/2026, silenciosamente, sem nenhum erro.
- **Nenhuma integração externa** (Nuvemshop, N8N, webhooks) referencia esse campo — confirmado pela mesma ausência de ocorrência em `src/`.

**Conclusão desta seção:** o único consumidor real e vivo do campo hoje é a view `vw_sale_shipping_summary`, que é "órfã" do ponto de vista da aplicação (ninguém a consulta programaticamente), mas pode estar sendo usada manualmente sem que o time de desenvolvimento saiba.

---

## 7. Quantas vendas podem estar afetadas (estimativa sem acesso ao banco)

Não é possível confirmar o número exato sem consulta ao banco — a consulta exata para isso está pronta no **Bloco 1** de [`fiscal-audit-readonly.sql`](fiscal-audit-readonly.sql) (ver [`fiscal-database-validation-guide.md`](fiscal-database-validation-guide.md)).

**Estimativa aproximada, baseada apenas no volume de negócio já informado no contexto desta auditoria** (~200 vendas/mês): entre a data da regressão (2026-06-14) e a data desta auditoria (2026-08-04) há aproximadamente 7,3 semanas (~1,7 meses). Aplicando a taxa mensal informada, a estimativa é de **~330 a 350 vendas potencialmente com `products_total` nulo**. Esta é uma estimativa de ordem de grandeza, não um dado medido — trate como tal até a consulta real confirmar.

---

## 8. O valor pode ser reconstruído com segurança pelos itens da venda?

**Sim — e de forma ainda mais direta e segura do que recalcular pelos itens de venda (`sale_items`): o valor pode ser reconstruído exatamente pelas próprias colunas já existentes em `sales`, sem precisar tocar em `sale_items` de forma alguma.**

Como demonstrado na Seção 4, `products_total = subtotal - discount_amount` sempre foi a fórmula, e ambos os componentes (`sales.subtotal`, `sales.discount_amount`) continuam sendo gravados corretamente em toda venda, em todas as 12 versões da função, sem interrupção. A reconstrução é literalmente a mesma instrução SQL que a migration original já usou para o backfill histórico:

```sql
UPDATE public.sales
SET products_total = ROUND(COALESCE(subtotal, 0) - COALESCE(discount_amount, 0), 2)
WHERE products_total IS NULL;
```

Isso não é uma aproximação — é a definição exata do campo, aplicada aos dados que nunca deixaram de existir. **Ressalva de prudência:** antes de rodar em escala, vale conferir numa amostra pequena (ex.: os 20 registros trazidos pela consulta 1.3 do Bloco 1) se `subtotal`/`discount_amount` dessas vendas específicas não foram afetados por nenhum outro bug não relacionado — não há evidência de que tenham sido (as migrations `20260626_fix_cashback_balance.sql` e `20260626_fix_finance_entries_v_total.sql`, pelos próprios nomes e pela leitura do `INSERT`, mexem em cashback e em `finance_entries`, não na fórmula de `subtotal`/`discount_amount`), mas uma checagem pontual antes do backfill em massa é uma precaução barata.

---

## 9. Riscos de corrigir apenas a função para vendas futuras (sem backfill)

- **Baixo risco técnico isolado:** `products_total` é puramente derivado e não alimenta nenhum outro cálculo dentro da própria função (`total`, estoque, cashback e pagamento continuam corretos independentemente dele) — reintroduzir a coluna no `INSERT` é uma mudança mecânica de escopo mínimo dentro de uma função que, de resto, permanece igual.
- **Risco real, mas indireto: recorrência do mesmo bug.** A causa raiz (Seção 1) foi uma reescrita que partiu de uma versão-base anterior à adição do campo. Nada no processo atual impede que isso aconteça de novo — não existe teste automatizado (`.github/workflows` não existe, conforme já registrado em `fiscal-risk-register.md`, achado B1) que falhe se `products_total` (ou qualquer outra coluna) sumir do `INSERT` numa reescrita futura. Corrigir só a função sem endereçar esse processo deixa a porta aberta para a mesma regressão se repetir na próxima vez que alguém reescrever `rpc_create_sale` a partir de uma cópia desatualizada.
- **Sem backfill, o histórico (14/06 a hoje) permanece `NULL` de forma permanente**, mesmo que passe a ser preenchido dali para frente — cria uma tabela com um "buraco" temporal que qualquer consumidor futuro do campo (inclusive, eventualmente, o próprio motor fiscal, se decidir usar o valor de `sales` em vez de recalcular a partir do zero na emissão) precisa saber tratar.
- Uma correção puramente forward-only é reversível com risco mínimo (basta remover a coluna do `INSERT` de novo), então não é uma decisão de alto risco por si só — o risco está em deixá-la incompleta sem uma decisão explícita sobre o histórico.

## 10. Riscos de fazer backfill das vendas antigas

- **Risco técnico da instrução em si: baixo.** É a mesma fórmula determinística já usada no backfill original de `20260613_shipping_fiscal_ready.sql:67-72` — sem `JOIN`, sem dependência de outra tabela, sem chamada a function externa.
- **Risco operacional: é um `UPDATE` em massa em `public.sales`, tabela de produção ativa.** Mesmo sendo uma fórmula segura, um `UPDATE` que afeta centenas de linhas deve, por prática recomendada, ser executado fora do horário de pico do PDV e, idealmente, primeiro validado num ambiente de homologação — que hoje **não existe** (achado C7 do registro de riscos). Isso é uma dependência a considerar: o backfill mais seguro pressupõe ter onde testá-lo antes.
- **Não confirmado nesta auditoria: existência de trigger em `UPDATE` de `sales` que reaja a qualquer mudança de coluna.** A leitura de código não encontrou evidência de tal trigger, mas isso deve ser confirmado antes do backfill (a consulta 5.6 do Bloco 5 em `fiscal-audit-readonly.sql` lista todos os triggers do schema — vale conferir especificamente os que têm `sales` como `event_object_table` antes de rodar o `UPDATE`).
- **Decisão de produto pendente, não técnica:** vale decidir, antes de investir no backfill, se o campo `products_total` continuará existindo como coluna persistida (exigindo mantê-lo sincronizado para sempre, com o risco de nova regressão) ou se deve ser **descontinuado como coluna física** e recalculado sob demanda (`subtotal - discount_amount`) sempre que necessário — o que eliminaria de vez a classe de bug que causou esta regressão. Essa decisão não foi tomada nesta auditoria; está registrada apenas como opção.

---

## 11. Plano separado de correção, migration e rollback (proposta, não implementado)

**Nota explícita, respondendo à instrução de não misturar isto com a implementação fiscal:** este plano é independente de qualquer decisão sobre o módulo fiscal em si — é uma correção de integridade de dado que teria valor mesmo que a Santtorini nunca implementasse NF-e/NFC-e (ex.: para qualquer relatório gerencial futuro que precise do valor líquido de produtos por venda). A única relação com o módulo fiscal é que ele é o motivo pelo qual o bug foi descoberto nesta auditoria, não uma dependência arquitetural — ver a seção final "Dependência com a Fase 1 fiscal".

**Proposta de migration única e isolada** (não criada nesta auditoria, apenas desenhada):
1. Redefinir `public.rpc_create_sale` (versão vigente, `CREATE OR REPLACE`, já que a assinatura de parâmetros não muda — não precisa do padrão `DROP FUNCTION`/`CREATE FUNCTION`) reintroduzindo `v_products_total` (mesma declaração e fórmula de `20260613_shipping_fiscal_ready.sql:220,296`) e a coluna no `INSERT`. Nenhuma outra parte da função seria tocada.
2. `UPDATE public.sales SET products_total = ROUND(COALESCE(subtotal,0) - COALESCE(discount_amount,0), 2) WHERE products_total IS NULL;` — mesmo backfill da migration original, na mesma migration ou em uma migration separada subsequente (separar em duas migrations distintas — uma para a função, outra para o backfill — reduz o escopo de rollback de cada uma, recomendado).
3. Nenhuma alteração em `sale_items`, estoque, cashback, pagamento ou qualquer outra função.

**Plano de rollback:**
- Se a migration de correção da função precisar ser revertida: `CREATE OR REPLACE FUNCTION public.rpc_create_sale(...)` de volta para o corpo da versão vigente atual (`20260704_fix_cashback_expiry_and_earn.sql`), removendo `v_products_total` e a coluna do `INSERT` — reversível sem perda de dado (a coluna `products_total` continuaria existindo na tabela, só pararia de ser atualizada de novo).
- Se o backfill precisar ser revertido: como é um `UPDATE` (não um `DROP COLUMN`), o rollback não é trivialmente "desfazer" — exigiria ter capturado o estado anterior (`products_total IS NULL` para todas as linhas afetadas) antes de rodar. Como o valor anterior era sempre `NULL` para essas linhas (não havia dado a perder), o rollback nesse caso específico é simplesmente rodar `UPDATE public.sales SET products_total = NULL WHERE sale_date BETWEEN '2026-06-14' AND '<data do backfill>';` — seguro porque não há ambiguidade sobre o estado anterior.
- Testes antes de aplicar (proposta): comparar, numa amostra, o valor reconstruído (`subtotal - discount_amount`) com o valor que a função vigente calcularia para uma venda de teste nova, e confirmar visualmente que bate.

**Sequenciamento sugerido em relação às fases já definidas em `fiscal-implementation-plan.md`:** esta correção pode ser feita a qualquer momento, inclusive antes de qualquer autorização para a Fase 2 fiscal — ela já estava listada como item de "saneamento técnico interno" na Fase 0 do plano de implementação, mas não depende de nenhum outro item da Fase 0 (credenciamento, certificado, etc.) para ser executada. **Ainda assim, nenhuma execução foi feita agora, conforme a instrução recebida — este documento é só o plano.**

---

## Dependência com a Fase 1 fiscal (justificativa explícita)

A arquitetura fiscal proposta em `fiscal-architecture-proposal.md` (seção "Modelo de Dados Proposto") define `fiscal_documents.totals_snapshot` como um valor calculado **no momento da emissão**, a partir dos dados da venda naquele instante — não como uma leitura direta de `sales.products_total`. Ou seja: **mesmo que `sales.products_total` nunca seja corrigido, isso não impede a Fase 1 fiscal de funcionar corretamente**, porque o motor de emissão fiscal proposto recalcularia o equivalente a `vProd` a partir de `subtotal`/`discount_amount` (ou dos itens da venda) no momento de montar o documento, não confiaria numa coluna pré-calculada potencialmente desatualizada.

Dito isso, corrigir `products_total` continua sendo recomendado por três motivos independentes do fiscal: (1) é um bug real e silencioso que pode voltar a acontecer com qualquer outro campo se o processo de reescrita de RPCs não mudar; (2) a view `vw_sale_shipping_summary` continua ativa e pode estar sendo usada manualmente sem o conhecimento do time; (3) é uma correção de escopo pequeno e risco baixo, sem motivo para adiar indefinidamente. **Mas não é bloqueador de nenhuma fase do plano fiscal**, e por isso não deve ser tratado como pré-requisito obrigatório da Fase 2 — pode ser autorizado e executado separadamente, a qualquer momento, sob seu próprio pedido de autorização.
