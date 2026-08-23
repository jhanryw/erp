# Fase Fiscal 5B — Arquitetura Revisada (Vendas com Entrega/Site)

**PRONTO PARA IMPLEMENTAR: NÃO**

Revisão do [`fiscal-fase5-vendas-entrega-auditoria.md`](fiscal-fase5-vendas-entrega-auditoria.md) a partir de 10 decisões de negócio confirmadas nesta rodada, com destaque para a correção de premissa mais importante: **`shipping_charged` não deve ser automaticamente tratado como `vFrete` da NF-e**. Nenhum código, migration ou builder fiscal foi alterado — auditoria + proposta, com 8 novas sub-auditorias read-only nesta rodada (comissão/margem/contas a receber/caixa, arquitetura de troca/devolução + numeração + impressão, payload real da Nuvemshop). Toda afirmação sobre o ERP tem evidência `arquivo:linha`; toda afirmação sobre legislação fiscal está marcada explicitamente como entendimento geral, não como fato do código, e sinalizada como pendente de validação contábil quando aplicável.

**Achado que muda o tom de toda a proposta**: a separação "valor de mercadoria vs. frete" que você pede na decisão 4 **já foi desenhada no schema em junho de 2026** — `sales.products_total`, com o comentário original *"Valor líquido dos produtos (subtotal - discount_amount), sem frete/surcharge"* (`supabase/migrations/20260613_shipping_fiscal_ready.sql:74-75`), e uma view companheira `vw_sale_shipping_summary` que já calcula `shipping_admin_fee = shipping_charged - COALESCE(internal_cost_real, internal_cost, 0)` — a margem da loja sobre o frete (`20260613_shipping_fiscal_ready.sql:162-166`). Os dois foram abandonados por uma regressão de migration no dia seguinte (`20260614_rpc_create_sale_main_store_only.sql`), não por decisão consciente — e já existe um plano de remediação pronto e não aplicado (`docs/products-total-remediation-plan.md`). Esta proposta reaproveita essa base em vez de inventar uma nova, com um ajuste de fórmula necessário (ver §9).

---

## 1. Modelo conceitual definitivo

Três documentos, nunca confundidos entre si (sua decisão 10):

```
                    ┌─────────────────────┐
                    │   VENDA (sales)      │
                    │  fonte única de fato │
                    └──────────┬───────────┘
              ┌────────────────┼────────────────┐
              ▼                ▼                 ▼
   ┌─────────────────┐ ┌───────────────┐ ┌──────────────────┐
   │  A. DOCUMENTO    │ │ B. DOCUMENTO  │ │ C. MOVIMENTAÇÃO   │
   │     FISCAL       │ │   COMERCIAL   │ │    FINANCEIRA     │
   │ NF-e/NFC-e/Focus/ │ │  comprovante  │ │ o que entrou/saiu │
   │      SEFAZ        │ │ não-fiscal p/ │ │  de caixa/banco,  │
   │                    │ │ cliente/troca │ │ inclusive frete   │
   │ fiscal_documents   │ │  (novo, §15)  │ │ finance_entries/  │
   │ fiscal_document_   │ │               │ │  cash_movements   │
   │ items              │ │               │ │                   │
   └────────────────────┘ └───────────────┘ └───────────────────┘
```

Cada um lê de uma fonte de verdade por item que já existe (ou é proposta) na venda, mas cada um decide **por si só** o que aparece nele — nenhum é gerado a partir do outro:

- O documento fiscal nunca é obrigatório para existir um comprovante comercial (decisão do pedido: "mesmo que eu escolha não emitir documento fiscal... quero poder entregar esse comprovante").
- O valor fiscal (vProd da NF-e) e o valor financeiro recebido (`sales.total`) **podem divergir legitimamente** quando há frete — essa é a mudança central desta revisão.
- A movimentação financeira sempre reflete o dinheiro real (R$100 recebido), independentemente do que o documento fiscal disser.

---

## 2. Campos atuais que podem ser reutilizados

| Campo | Onde já existe | Reaproveitamento proposto |
|---|---|---|
| `sales.subtotal` | `20260817_sale_rpcs_emit_outbox_events.sql:244` | Já é a soma dos itens líquida de desconto por item — base do valor de mercadoria |
| `sales.discount_amount`/`surcharge_amount` | idem | Ajustes globais — fallback conforme hierarquia já definida na Fase 5 (§9 abaixo) |
| `sales.shipping_charged` | idem | Continua sendo o valor financeiro/comercial do frete — só deixa de alimentar `vFrete` automaticamente |
| `sales.products_total` | `20260613_shipping_fiscal_ready.sql:62-75` (existe, mas `NULL` desde 14/06 — ver achado acima) | **Vira a base do valor fiscal da NF-e**, com um ajuste de fórmula (§9) |
| `vw_sale_shipping_summary` | `20260613_shipping_fiscal_ready.sql:142-178` | Reativar como a view gerencial de margem de frete (já calcula `shipping_admin_fee`) |
| `sale_items.unit_price`/`discount_amount` | `DATABASE_SCHEMA.sql:407-423` | Continuam sendo o preço/desconto **efetivamente vendido** — nenhuma mudança de semântica |
| `shipments.mod_frete` | `20260613_shipping_fiscal_ready.sql:86` | Passa a significar "frete existe comercialmente", mas deixa de decidir sozinho se compõe o valor fiscal (ver §4) |
| `resolveMunicipioIbge` | `src/services/fiscal/resolveMunicipioIbge.ts:49` | Mantido como 2ª camada/fallback de resolução de IBGE (decisão 2) |
| `exchanges`/`exchange_items` | `20260609_exchanges.sql:13-44` | Base viva para o comprovante se integrar a trocas (§16) — `returns`/`return_items` está morta, não reaproveitar |
| `sales.sale_number` | `000_schema_completo.sql:714-732` | Identificador legível já exposto em todo o sistema — mas **não deve ser o identificador público do comprovante** (ver §15, é sequencial e global, adivinhável) |

---

## 3. Campos novos propostos (nomes/tipos — sem migration ainda)

### `sale_items` (preço negociado por item — decisão 6)

| Campo | Tipo | Semântica |
|---|---|---|
| `list_price_snapshot` | `NUMERIC(10,2) NULL` | Preço de tabela (`product_variations.price_override ?? products.base_price`) no momento da venda — puramente informativo, nunca entra em nenhum total |
| `surcharge_amount` | `NUMERIC(10,2) NOT NULL DEFAULT 0` | Acréscimo explícito por item (hoje não existe — só `discount_amount` existe) |

`unit_price`/`discount_amount`/`total_price` continuam existindo sem mudança de tipo — só a fórmula gerada de `total_price` precisaria mudar para incluir `+ surcharge_amount` (mudança de código de migration, não de conceito).

### `sales` (endereço/destinatário — decisão 3)

Nenhuma coluna nova em `sales` — a solução é uma tabela separada (ver §8), não colunas soltas em `sales`/`shipments` (evita repetir o problema de `shipments.address_id`, hoje nunca preenchido).

### `sales` (comprovante — decisão 9)

| Campo | Tipo | Semântica |
|---|---|---|
| `public_receipt_token` | `UUID NOT NULL DEFAULT gen_random_uuid()` | Identificador público não-sequencial e não-adivinhável para o comprovante — `sale_number` é sequencial e global (§ achado do agente de numeração), não deve virar chave de busca pública |

### `company_fiscal_settings` (tratamento fiscal do frete — decisão 4, ver §4)

| Campo | Tipo | Semântica |
|---|---|---|
| `freight_fiscal_treatment` | `TEXT CHECK IN ('includes_nfe_value', 'excluded_third_party_carrier')`, sem default automático | Decisão explícita e auditável de como o frete é tratado na NF-e — nunca assumida silenciosamente pelo código (ver §4) |

---

## 4. A questão central: o frete compõe o valor fiscal da NF-e?

Esta seção não decide nada por conta própria — audita as consequências, como pedido, e devolve uma decisão explícita para você e a contabilidade.

### O que a legislação diz, em termos gerais (entendimento geral — não é citação de código deste repositório, não foi verificado contra o texto legal primário nesta rodada, precisa confirmação contábil antes de qualquer implementação)

A Lei Complementar 87/96 (Lei Kandir), art. 13, §1º, inciso II, alínea "b", estabelece que a base de cálculo do ICMS inclui o valor do frete, **"caso o transporte seja efetuado pelo próprio remetente ou por sua conta e ordem e seja cobrado em separado."** Na prática de mercado, essa regra costuma ser lida como: se o vendedor organiza e cobra o frete do cliente — mesmo subcontratando um entregador terceirizado — o frete é entendido como parte da operação de venda e compõe o valor da NF-e (`vFrete`, modalidade CIF/`modFrete=0`).

**Isso é exatamente o modelo operacional descrito para a Santtorini**: a loja cobra `shipping_charged` do cliente, no mesmo pagamento da venda, e paga o motoboy depois via repasse (`rpc_pagar_repasse_motoboy`) — o motoboy não emite nenhum documento fiscal próprio de transporte para o cliente, e o valor nunca deixa de ser tratado como parte da mesma transação comercial.

**A exceção que tornaria a exclusão legítima** normalmente exige que o frete seja uma prestação de serviço de transporte genuinamente autônoma e segregada — contratada e paga diretamente pelo destinatário a um transportador com CNPJ próprio, que emite seu próprio documento fiscal de transporte (CT-e ou equivalente), com a loja apenas repassando/facilitando, sem que o valor circule como receita da venda de mercadoria. **Não encontrei, na auditoria desta rodada nem nas anteriores, nenhuma evidência de que o motoboy da Santtorini opere dessa forma** (não há CNPJ de transportadora, não há emissão de documento de transporte, o valor é cobrado junto com a venda).

### Conclusão desta auditoria (não uma decisão sua, uma constatação técnica)

**Pelo entendimento geral da regra, no modelo operacional descrito, o frete cobrado pela própria loja provavelmente compõe o valor da NF-e** — excluí-lo silenciosamente (emitir NF-e de R$88 quando R$100 foi recebido pela mesma venda, com frete organizado pela própria loja) é o tipo de divergência que uma fiscalização tende a questionar, porque o valor total da operação de saída da mercadoria seria maior que o valor declarado no documento fiscal.

**Isso está marcado explicitamente como:**

> **DECISÃO QUE PRECISA DE VALIDAÇÃO CONTÁBIL/FISCAL** — antes de qualquer implementação que exclua `shipping_charged` do valor da NF-e, a contabilidade da Santtorini precisa confirmar, por escrito, sob qual hipótese legal esse frete pode ficar fora do documento fiscal, dado o modelo real de cobrança/repasse ao motoboy. Se a resposta for "não pode", a arquitetura abaixo (§9, §13) já contempla o caminho conservador (frete sempre em `vFrete`) sem exigir nenhuma mudança adicional.

### Arquitetura proposta — nunca assumir, sempre decidir explicitamente

Independente da resposta contábil, a arquitetura **não deve hardcodar nenhuma das duas opções** — deve ser uma configuração explícita e auditável (`company_fiscal_settings.freight_fiscal_treatment`, §3), lida pelo builder no momento da montagem do payload:

- `'includes_nfe_value'` (conservador — mantém o comportamento atual do builder: `shipping_charged` vira `vFrete` rateado por item, via `allocateOrderAdjustments`, sem nenhuma mudança de código). **Default recomendado até a validação contábil ser feita.**
- `'excluded_third_party_carrier'` (o modelo que você descreve — R$88 na NF-e, R$12 tratado só financeiramente) — só habilitável depois da confirmação contábil, e mesmo assim exigiria endereçar a pergunta de "quem responde pelo frete perante a fiscalização" antes de virar código.

Isso significa: o builder fiscal (`buildNfePayload.ts`, `allocateOrderAdjustments.ts`) **continua igual nesta fase** — nenhuma mudança é proposta neles agora, exatamente como você pediu. A mudança arquitetural que preparamos agora é só o desacoplamento das grandezas na origem (§9), para que, quando a decisão contábil vier, a implementação seja trocar uma leitura de configuração, não reescrever a lógica de cálculo do zero.

---

## 5. Formulário proposto — venda de retirada

Sem mudança em relação ao fluxo atual (§2 do relatório anterior) — nenhum campo de endereço é necessário. Confirmado que o schema `NFCeRequest` da Focus não tem nenhum campo de endereço de destinatário (`fiscal-fase4-nfce-arquitetura-proposta.md:73-84`). Único ajuste sugerido: gerar `public_receipt_token` (§3) mesmo para retirada, para que o comprovante (§15) funcione igualmente nos dois fluxos.

## 6. Formulário proposto — venda de entrega

| Campo | A) Obrigatório p/ concluir a venda | B) Obrigatório só p/ NF-e | C) Opcional | D) Derivado automaticamente |
|---|---|---|---|---|
| Nome | ✓ | — | — | — |
| CPF/CNPJ | — | ✓ (`destinatario_documento_missing`, `validateFiscalReadiness.ts` §1 da Fase 5) | — | — |
| Telefone | — | — | ✓ | — |
| E-mail | — | — | ✓ | — |
| CEP | ✓ | ✓ (`destinatario_cep_invalido` se malformado) | — | — |
| Logradouro | ✓ | ✓ (`destinatario_endereco_incompleto`) | — | pode vir do ViaCEP após CEP digitado |
| Número | ✓ | ✓ | — | — |
| Complemento | — | — | ✓ | — |
| Bairro | ✓ | ✓ | — | pode vir do ViaCEP |
| Cidade | ✓ | ✓ | — | pode vir do ViaCEP |
| UF | ✓ | ✓ (`destinatario_uf_invalida` se malformado) | — | pode vir do ViaCEP |
| Código IBGE | — | ✓ (`destinatario_municipio_ibge_missing`, obrigatório de propósito em `buildNfePayload.ts:189`) | — | **sim — nunca digitado** (§8) |

Evidência de cada exigência fiscal: todas as regras da coluna B vêm de `validateNfeDestinatario` (`src/services/fiscal/validateFiscalReadiness.ts:180-198`, corpo completo já citado na auditoria do agente 5 da Fase 5) — nenhuma foi inventada nesta revisão.

**Por que nome/CEP/logradouro/número/bairro/cidade/UF ficam em A (obrigatório para concluir a venda, não só para NF-e)**: porque sem eles a entrega física não pode acontecer — é uma exigência operacional, não fiscal. Isso responde à sua pergunta A/B/C/D com uma nuance importante: a maior parte do endereço é obrigatória por logística, e a NF-e só adiciona **CPF/CNPJ** e **código IBGE** como exigências extras que a operação, sozinha, não pediria.

---

## 7. Fluxo Nuvemshop (revisado)

Achado novo desta rodada: **o tipo TypeScript que a rota do webhook usa para o pedido da Nuvemshop (`NuvemshopOrder`, `src/app/api/webhooks/nuvemshop/order/route.ts:42-58`) não declara nenhum campo de endereço** — nem sequer um `shipping_address` ignorado. O código busca o pedido completo na API da Nuvemshop (`route.ts:203-206,214`) e faz cast direto para esse tipo estreito — **qualquer campo de endereço que a API real da Nuvemshop devolva hoje é descartado no nível de tipagem, nunca chega a ser lido**, porque nada além dos campos declarados é acessado. Confirmado: não existe, em nenhum lugar do repositório, nenhuma referência ao formato real do objeto de endereço da API da Nuvemshop/Tiendanube — isso precisaria ser confirmado contra a documentação oficial da Nuvemshop antes de implementar (marcar como pendência técnica, não decisão de negócio).

Mapeamento proposto (sem implementar):

| Dado necessário | Fonte proposta | Observação |
|---|---|---|
| Endereço de entrega | `order.shipping_address` (campo a confirmar na API real da Nuvemshop — hoje nem declarado no tipo) | Precisa de spike técnico contra a API real antes da Fase E |
| Cliente | `order.customer.{name,email,phone,identification}` | Já capturado (`route.ts:84-87`) |
| CPF/CNPJ quando disponível | `order.customer.identification` | Já capturado como CPF; Nuvemshop pode devolver CNPJ para compra PJ — schema de `customers` hoje só suporta CPF (fora de escopo, mesma lacuna já documentada) |
| Frete | `order.total_shipping` | Já capturado (`route.ts:534`) — mas ver §4: vira só `shipping_charged`, não decide sozinho o valor fiscal |
| Desconto global | `order.discount`, capado contra o subtotal dos itens | Já capturado (`route.ts:486`) |
| Desconto por item | Campo a confirmar na API real (hoje nem declarado — `NuvemshopOrderItem`, `route.ts:32-40`, não tem campo de desconto) | Hoje sempre `0` (`route.ts:474`) — mesma pendência técnica do endereço |
| Preço efetivamente pago por item | `order.products[].price` | Já capturado, vira `sale_items.unit_price` |
| Total | `order.total` | Já capturado |
| Forma de pagamento | `order.payment_details.method` | Já capturado, mapeado via `mapPaymentMethod` |
| Shipment/delivery | Novo — criar `shipments` com `delivery_mode='delivery'` no mesmo fluxo (hoje não cria nenhuma) | Depende de D7 (decisão de negócio: síncrono no webhook vs. lazy na emissão) |
| Snapshot de endereço | Grava em `sale_recipients` (§8), não em `customer_addresses` diretamente | Mesma arquitetura de qualquer outra origem de venda |

**Achado adicional confirmado nesta rodada**: o pedido cru da Nuvemshop é buscado da API e depois **descartado por completo** — nenhuma cópia do JSON original fica em `pedidos` nem em nenhuma outra tabela (`pedidos` não tem coluna `raw_payload`/JSONB nenhuma, confirmado por grep exaustivo). Recomendação para a Fase E: adicionar uma coluna `raw_payload JSONB` em `pedidos` só para auditoria/depuração — não estritamente necessária para o fluxo funcionar, mas evita que a mesma pergunta ("o que a Nuvemshop realmente manda?") precise ser respondida de novo no futuro via suporte da Nuvemshop em vez de consulta ao próprio banco.

---

## 8. Arquitetura de snapshot de endereço (revisão da decisão D1 anterior)

Mantida a recomendação já feita na Fase 5 (§13 daquele documento) — tabela nova `sale_recipients`, não colunas em `shipments`/`sales`. Reforço da justificativa com o achado desta rodada sobre numeração: como `sales.sale_number` é sequencial e global (não isolado por empresa), reforça a necessidade de qualquer identificador público (§15) ser um campo separado e não-adivinhável, não reaproveitar identificadores internos.

```sql
-- Ilustrativo — não implementar nesta rodada
CREATE TABLE sale_recipients (
  id                SERIAL PRIMARY KEY,
  sale_id           INT NOT NULL UNIQUE REFERENCES sales(id),
  company_id        INT NOT NULL,
  source_address_id INT REFERENCES customer_addresses(id),  -- rastreabilidade, nunca fonte de verdade
  nome              TEXT NOT NULL,
  cpf               TEXT,
  cnpj              TEXT,
  telefone          TEXT,
  cep               TEXT NOT NULL,
  logradouro        TEXT NOT NULL,
  numero            TEXT NOT NULL,
  complemento       TEXT,
  bairro            TEXT NOT NULL,
  municipio         TEXT NOT NULL,
  municipio_ibge    CHAR(7),
  uf                CHAR(2) NOT NULL,
  ibge_source       TEXT CHECK (ibge_source IN ('viacep', 'resolve_municipio_ibge', 'manual_confirmado')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Cascata de resolução automática do IBGE (decisão 2), formalizando o que a auditoria encontrou:

1. **CEP → ViaCEP** (`src/lib/services/cepService.ts`, já integrado): a resposta do ViaCEP **já inclui o campo `ibge`** — hoje ele é lido pelo tipo interno mas **descartado explicitamente** antes de a rota devolver a resposta (`src/app/api/shipping/cep/route.ts:30-39,66-75`, que só repassa `cep, street, neighborhood, city, state, complement, latitude, longitude`). A correção proposta é parar de descartar esse campo — sem nenhuma chamada de rede extra, resolve a maioria dos casos.
2. **Fallback: `resolveMunicipioIbge(uf, municipio)`** (já existe, `src/services/fiscal/resolveMunicipioIbge.ts:49`) — usado quando o CEP não retorna IBGE ou não foi informado. Mantido exatamente como está, sem alteração — é para isso que a Fase 2B já o desenhou.
3. **Nunca inventar** — se as duas camadas falharem, o campo fica pendente e a venda não passa em `validateNfeReadiness` até ser corrigido manualmente (mesmo comportamento de bloqueio já existente hoje, só muda a origem do dado).

`ibge_source` registra qual das duas camadas resolveu o valor — útil para auditoria/confiança do dado, não estritamente necessário para o funcionamento.

---

## 9. Arquitetura de preço negociado por item

### Modelagem proposta (schema já descrito em §3)

Para o cenário do pedido — Produto A tabela R$40 → vendido R$45; Produto B tabela R$40 → vendido R$43:

| Campo | Produto A | Produto B |
|---|---|---|
| `list_price_snapshot` | 40 | 40 |
| `unit_price` (preço efetivamente vendido) | 45 | 43 |
| `discount_amount` | 0 | 0 |
| `surcharge_amount` | 0 | 0 |
| `total_price` (`unit_price*qty - discount + surcharge`) | 45 | 43 |
| Acréscimo implícito (`unit_price - list_price_snapshot`, não armazenado, calculável em relatório) | +5 | +3 |

Para o cenário de desconto explícito no Produto A (tabela R$40 → vendido R$35) preservando "que o desconto ocorreu especificamente no Produto A": mesma modelagem, `unit_price=35`, `list_price_snapshot=40` — a diferença já fica evidente sem precisar duplicar a informação em `discount_amount`. `discount_amount`/`surcharge_amount` ficam disponíveis para o caso em que o vendedor **quer documentar explicitamente** um desconto/acréscimo separado do preço base digitado (ex.: "apliquei um cupom de R$3 em cima do preço já negociado") — não são obrigatórios para o cenário simples.

**Por que não recalcular a partir de `products`/`product_variations`**: exatamente como você pediu — `list_price_snapshot` é gravado **uma vez**, no momento da venda, e nunca mais lido de `products.base_price`/`product_variations.price_override` depois disso. Isso resolve a mesma classe de problema do snapshot de endereço (§8): o preço de tabela pode mudar depois, sem afetar a reconstrução histórica da venda.

---

## 10. Invariantes matemáticas

Notação: soma sobre itens `i = 1..n` de uma venda.

**Nível de item:**
```
total_price_i = (unit_price_i × quantity_i) − discount_amount_i + surcharge_amount_i
```
(`list_price_snapshot_i` nunca entra nesta fórmula — é só informativo, confirmado como intenção do pedido: "não quero depender do preço atual... para reconstruir uma venda histórica" já é atendido por ser um snapshot, não por participar do cálculo.)

**Nível de pedido:**
```
subtotal = Σ total_price_i
products_total (valor fiscal de mercadoria) = subtotal − discount_amount + surcharge_amount
                                               └────────────┬────────────┘
                                                     ajustes GLOBAIS
total = products_total + shipping_charged − cashback_used
```

**Invariante de não-duplicidade (resposta à decisão 7):**

> Um mesmo ajuste (desconto ou acréscimo) só pode ter UMA origem: item OU pedido, nunca as duas para o mesmo valor.

Formalizado como regra de UX (não há como impor isso só no banco sem contexto de negócio — nenhuma constraint SQL consegue saber se dois valores "representam a mesma coisa"):

1. **Se o ajuste tem origem conhecida por produto** → grava em `sale_items.unit_price`/`discount_amount`/`surcharge_amount`. `sales.discount_amount`/`surcharge_amount` **ficam em zero** para esse ajuste.
2. **Se o ajuste é genuinamente do pedido inteiro, sem origem por item** (ex.: "R$5 de desconto porque o cliente é fidelizado", sem ligação a nenhum produto específico) → grava em `sales.discount_amount`/`surcharge_amount`. Os itens **não são tocados** na criação da venda.
3. **`allocateOrderAdjustments` (já existe, inalterado) só atua no caso 2**, no momento da montagem do payload fiscal — nunca no caso 1, porque no caso 1 o ajuste já está dentro de `unit_price`/`total_price` do item, e `sales.discount_amount`/`surcharge_amount` são zero, então o rateio não tem nada para distribuir.

**Prova de não-duplicidade**: como os casos 1 e 2 são mutuamente exclusivos por construção (um ajuste específico é registrado em exatamente um lugar, nunca nos dois), `products_total = subtotal − discount_amount + surcharge_amount` nunca soma o mesmo ajuste duas vezes — `subtotal` já contém os ajustes do caso 1 (dentro de `total_price_i`), e `discount_amount`/`surcharge_amount` (nível de pedido) só contêm ajustes do caso 2, por disciplina de uso, não por constraint de banco. **Recomendação de reforço de UX (Fase D)**: quando a tela de venda tiver desconto por item preenchido em qualquer item, o campo de desconto de pedido deveria ficar visualmente marcado como "residual" (ou mesmo desabilitado por padrão) para reduzir o risco de o vendedor preencher os dois por engano — mitigação de UX, não de banco, porque a ambiguidade é sempre semântica.

**Nível financeiro (decisão 5):**
```
total_financeiro_recebido = products_total + shipping_charged (= sales.total, sem cashback)
receita_de_mercadoria       = products_total
receita_de_frete            = shipping_charged
custo_de_frete               = shipments.internal_cost_real (ou estimado)
margem_de_frete               = shipping_charged − custo_de_frete   (= shipping_admin_fee, já existe em vw_sale_shipping_summary)
```

---

## 11. Arquitetura financeira do frete

Reaproveitando o achado do §1 (topo do documento): `vw_sale_shipping_summary` já calcula exatamente `shipping_admin_fee`. A proposta é reativá-la (corrigindo o `INSERT` de `products_total`, ver §17) em vez de desenhar algo novo.

**Receita de frete em `finance_entries`** — hoje inexistente como categoria distinta (achado confirmado nesta rodada: `finance_category` só tem despesa `'freight_cost'`, nenhuma receita de frete — tudo cai em `category='sale'`). Proposta: `rpc_create_sale` passa a gravar **duas linhas** em `finance_entries` quando `shipping_charged > 0`:
- `type='income', category='sale', amount=products_total`
- `type='income', category='shipping_revenue'` (novo valor no enum), `amount=shipping_charged`

**Despesa/repasse**: já funciona (`rpc_pagar_repasse_motoboy`), não precisa mudar — continua lançando `category='freight_cost'` só quando o repasse é efetivamente pago.

---

## 12. Impacto em dashboard/DRE/comissão/caixa — matriz solicitada

| Métrica | Inclui mercadoria | Inclui acréscimo/desconto comercial | Inclui frete recebido | Inclui custo de frete | Fonte hoje |
|---|:---:|:---:|:---:|:---:|---|
| Dashboard "Faturamento" | ✓ | ✓ | ✓ (não separado) | — | `sales.total`, `dashboard/page.tsx:331` |
| Ticket médio (`vw_daily_revenue_trend`) | ✓ | ✓ | ✓ (não separado) | — | `SUM(s.total)`, `20260810_vw_daily_revenue_trend.sql:101` |
| `/relatorios/vendas` | ✓ | ✓ | ✓ (não separado) | — | `s.total`, `relatorios/vendas/page.tsx:42` |
| `customer_metrics.avg_ticket` | ✓ | ✓ | ✓ (não separado) | — | `NEW.total`, `000_schema_completo.sql:1630-1646` |
| DRE (`vw_dre_mensal`) | ✓ | ✗ (usa `subtotal`, que não soma `surcharge_amount` de pedido) | ✗ | — | `SUM(s.subtotal)`, `20260724_vw_dre_mensal_v3...sql:39,60` |
| `/api/financeiro/resumo` | ✓ | ✓ | ✓ (não separado) | — | `finance_entries category='sale'`, valor = `v_total` |
| Margem por produto (`mv_product_performance`, ABC) | ✓ (só item) | ✓ (só item, via `total_price`) | ✗ | ✗ | `SUM(si.total_price)`/`SUM(si.gross_profit)` |
| **Relatório de vendedores (`sellerDashboard.ts`)** | ✓ | ✓ | ✓ (não separado) | — | **achado de bug real**: `revenue = sales.total` (com frete) ÷ `grossProfit = Σ gross_profit` (sem frete) — `grossMarginPct` fica artificialmente diluída em vendas com frete alto (`sellerDashboard.ts:352,369,411`) |
| Comissão de vendedor | N/A | N/A | N/A | N/A | **Não existe no sistema hoje** — confirmado por grep exaustivo, zero implementação. Nenhuma correção necessária agora; se for construída no futuro, deve usar `products_total`, nunca `sales.total` |
| Contas a receber | N/A | N/A | N/A | N/A | **Não existe no sistema** — toda venda é paga integralmente na criação (`status='paid'` direto, `sale_payments` na mesma transação); não há saldo a receber, logo não há o que "distorcer" aqui |
| Caixa (`cash_movements`/fechamento) | ✓ | ✓ | ✓ (não separado) | — | `v_total_sales = SUM(s.total)`/`v_cash_tendered`, `rpc_close_cash_session`, `20260522_cash_register_rpcs.sql:385-418` — soma única, sem split; correto para conciliação de caixa (o dinheiro físico realmente inclui o frete), mas não deve ser usado como proxy de "faturamento de mercadoria" |

**Semântica única proposta (resposta à sua pergunta "proponha uma única semântica consistente")**:

> **"Faturamento"/"receita"/"ticket médio" de mercadoria = `products_total`. "Total recebido"/"caixa"/"conciliação" = `sales.total` (inclui frete). Nunca os dois com o mesmo rótulo.**

Concretamente: Dashboard, ticket médio, `/relatorios/vendas`, `customer_metrics.avg_ticket` e `/api/financeiro/resumo` deveriam migrar de `sales.total` para `sales.products_total` **quando o rótulo da métrica for "faturamento"/"vendas"/"ticket médio"** — e ganhar uma métrica **separada e claramente rotulada** de "frete recebido" ao lado, nunca somada sem dizer. Caixa/conciliação bancária continuam corretamente usando `sales.total` (o dinheiro físico não se importa com a classificação fiscal). Isso já é exatamente o padrão que `vw_dre_mensal` usa hoje (única view já "correta" nesse sentido) — a proposta é estender esse padrão às outras 5 métricas que hoje divergem dela, em vez de inventar uma terceira convenção.

**Correção do bug de margem do vendedor**: trocar o numerador de `sellerDashboard.ts:352` de `sales.total` para `sales.products_total`, para que `grossMarginPct` deixe de ser diluída por frete.

---

## 13. Payload NF-e esperado para o exemplo (R$80 + R$8 + R$12)

Dois cenários, refletindo a decisão pendente do §4 — **nenhum dos dois é implementado nesta fase**, ambos documentados para você decidir com a contabilidade.

### Cenário A — frete compõe o valor fiscal (comportamento atual do builder, conservador, default até validação contábil)

```
item(s): valor_bruto total = 80 (produtos) + valor_outras_despesas/valor_bruto ajustado = +8 (acréscimo,
         rateado ou embutido em unit_price conforme origem, ver hierarquia §10)
         valor_frete (rateado por item) = 12
vNF (total da NF-e) = 80 + 8 + 12 = 100
```
`sales.total` = `vNF` — sem divergência entre financeiro e fiscal.

### Cenário B — frete excluído do valor fiscal (seu modelo desejado — só válido após validação contábil, §4)

```
item(s): valor_bruto total = 80 (produtos) + 8 (acréscimo, embutido em unit_price ou vOutro, conforme
         origem por item ou global)
vNF (total da NF-e) = 88
shipping_charged = 12 — nunca aparece em nenhum campo do payload NF-e, fica só em sales/finance_entries
sales.total (financeiro) = 100 ≠ vNF (100 ≠ 88) — divergência intencional e documentada, nunca
         tratada como erro pelo sistema
```

Em ambos os cenários, `products_total = 88` (mercadoria + acréscimo, sem frete) — é a mesma grandeza em ambos os casos, só muda se ela **sozinha** vira `vNF` (Cenário B) ou se `+ shipping_charged` também entra (Cenário A). Essa é a prova de que a arquitetura de dados proposta (§9-§11) serve para os dois cenários sem mudança — só a leitura do builder muda, e só depois da decisão contábil.

---

## 14. Pontos que exigem validação fiscal/contábil antes de implementar

1. **§4 — se/sob qual condição o frete cobrado pela própria loja pode ficar fora do valor da NF-e**, dado que o motoboy não emite documento fiscal de transporte próprio hoje. **Bloqueia** habilitar o Cenário B do §13.
2. Herdado da Fase 5A, ainda não resolvido: CFOP 6102 para CRT=4 sem verificação direta do PDF primário da NT 2024.001 (`fiscal-fase2a-payload-nfe.md:29-31`).
3. Herdado da Fase 5A: PIS/COFINS CST 49 / IPI CST 53 como convenção contábil, não regra SEFAZ numerada — confirmação com contador ainda pendente.
4. Se o Cenário B for aprovado: como representar, perante o Fisco, os R$12 recebidos e repassados ao motoboy sem NF-e — precisa de confirmação se basta o controle financeiro interno ou se exige algum outro documento (recibo de prestação de serviço do motoboy, por exemplo), o que foge do escopo deste ERP mas afeta o desenho do comprovante (§15) se ele precisar registrar isso.

---

## 15. Arquitetura do comprovante não fiscal

### Dados a incluir (mínimo necessário para os objetivos declarados)

- `public_receipt_token` (UUID, §3) — nunca `sale_number` ou `sale_id` sequencial, para não permitir que alguém adivinhe/enumere comprovantes de outros clientes trocando um número na URL.
- Data da venda, itens (nome, quantidade, `unit_price` — o preço efetivamente vendido, não `list_price_snapshot`), total.
- Identificador da loja (nome "Santtorini", não CNPJ — CNPJ é dado fiscal, evitar sugerir que é documento fiscal).
- Texto obrigatório e visível: **"NÃO É DOCUMENTO FISCAL — apenas comprovante de compra para fins de troca/consulta."**

### Dados que NÃO deveriam aparecer (privacidade/segurança — achado real da auditoria)

**Achado direto desta rodada**: o único artefato de impressão hoje existente (`/vendas/[id]/imprimir`, etiqueta de envio A4) já imprime **nome completo, telefone e endereço completo** (rua/número/complemento/bairro/CEP/cidade/UF) do cliente — sem nenhum tipo de mascaramento (`src/app/(dashboard)/vendas/[id]/imprimir/page.tsx:283-301`). CPF não é impresso ali (a query exclui deliberadamente, linha 38) — esse é o único cuidado de privacidade já existente no sistema hoje.

Para o comprovante novo, recomendo **não repetir esse padrão**:
- **Nunca** CPF completo (se precisar confirmar identidade, usar só os 3 últimos dígitos, como já é convenção em `SubmitNfeResult` para outro contexto fiscal — achado da Fase 4).
- **Nunca** endereço completo de entrega — o comprovante é para conferência de compra/troca, não para reentrega; se o cliente perder o comprovante em público, um endereço residencial completo é um dado desnecessário e sensível ali.
- Nome pode aparecer parcial (primeiro nome + inicial) se o objetivo é só "confirmar que é a mesma pessoa", ou completo se a política da loja exigir apresentação de documento — decisão operacional da loja, não técnica.
- Telefone/e-mail: não necessários no papel impresso; podem ficar só na consulta autenticada do lojista.

### Rota pública proposta

Confirmado nesta rodada: **não existe hoje nenhuma rota pública/sem-login no sistema para consulta de venda** (`src/middleware.ts:20-34`, lista de `PUBLIC_PATHS`, não tem nada relacionado a vendas/comprovante). Seria uma rota nova (`/comprovante/[public_receipt_token]` ou similar), adicionada à lista de exceções do middleware, com sua própria autorização (o token UUID já é a autorização — não precisa de login), e com uma consulta **deliberadamente limitada** (nunca reaproveitar a query atual de `/vendas/[id]/imprimir`, que usa `createAdminClient()` e ignora RLS — a rota pública precisa buscar só os campos explicitamente permitidos acima, nunca a linha inteira de `sales`/`customers`).

---

## 16. Integração do comprovante com troca/devolução

**Achado confirmado nesta rodada**: existem hoje dois sistemas paralelos de devolução, e só um está vivo:

- `returns`/`return_items` (`000_schema_completo.sql:777-802`) — **schema morto**, zero código em `src/` o utiliza, e **sem nenhuma proteção contra devolver a mesma unidade duas vezes**.
- `exchanges`/`exchange_items` (`20260609_exchanges.sql:13-44`) — **sistema vivo**, usado por `src/app/(dashboard)/vendas/[id]/troca/page.tsx`, `src/app/api/vendas/[id]/troca/route.ts`. Já tem `company_id`, já liga a `sale_item_id`, e **já impede trocar mais unidades do que foram vendidas menos o que já foi trocado** (checagem real em `rpc_process_exchange`, `20260609_exchanges.sql:129-141` — soma `exchange_items.quantity_returned` de trocas já concluídas e bloqueia excesso).

**Proposta**: o comprovante não precisa de nenhuma tabela nova para se integrar a trocas — ele só precisa expor, na tela de atendimento de troca já existente, um campo de busca por `public_receipt_token` (além da busca por `sale_id`/cliente que já deve existir), que resolve para a mesma `sale_id` e reaproveita `rpc_process_exchange` sem nenhuma mudança de lógica. O comprovante é só uma **porta de entrada alternativa** para achar a venda — a lógica de troca em si (quantidade já trocada, limites por item) já está corretamente implementada.

`rpc_return_sale` (devolução total, distinta de troca) também não precisa de mudança — já opera sobre `sale_id`, que o comprovante ajuda a localizar.

---

## 17. Impacto nos builders NF-e/NFC-e

**Nesta fase: zero.** Nenhuma linha de `buildNfePayload.ts`, `buildNfcePayload.ts`, `allocateOrderAdjustments.ts` ou `loadSaleFiscalContext.ts` muda — conforme instruído. A arquitetura proposta (§8, §9) prepara os dados de origem (`sale_recipients`, `list_price_snapshot`, `products_total` corrigido) para que, quando uma fase futura conectar os builders a essas novas fontes, a mudança seja pontual (trocar de onde o loader lê, não como o builder calcula) — e para que a decisão do §4 (Cenário A vs. B) possa ser implementada como uma leitura condicional de configuração, não uma reescrita.

---

## 18. Impacto no banco

Resumo das tabelas/colunas envolvidas (nenhuma migration nesta rodada):

| Tabela | Mudança | Tipo |
|---|---|---|
| `sale_recipients` | Nova (§8) | Schema novo |
| `sale_items` | + `list_price_snapshot`, + `surcharge_amount` (§3) | Aditiva |
| `sales` | + `public_receipt_token` (§3) | Aditiva |
| `sales` (RPC) | Corrigir `INSERT` para voltar a gravar `products_total` (regressão já documentada) | Correção de bug, não feature nova |
| `finance_category` | + `'shipping_revenue'` (§11) | Aditiva a enum |
| `company_fiscal_settings` | + `freight_fiscal_treatment` (§3, §4) | Aditiva — só passa a ser lida quando/se o builder for tocado numa fase futura |
| `vw_sale_shipping_summary` | Nenhuma mudança de definição — só volta a funcionar quando `products_total` for corrigido | Reativação |
| `returns`/`return_items` | Nenhuma ação — recomendo deixar como está (morta), não migrar dado para `exchanges` sem necessidade concreta | Sem mudança |

---

## 19. Plano de migrations em fases pequenas e reversíveis

- **Migration 1 — Correção de `products_total`** (independente de tudo mais, já tem plano pronto em `docs/products-total-remediation-plan.md`): retomar o `INSERT` no `rpc_create_sale` vigente + backfill das ~300 vendas afetadas. Reativa `vw_sale_shipping_summary` de graça.
- **Migration 2 — `sale_recipients`** (§8): tabela nova, sem FK de nada mais dependendo dela ainda — pode ser criada e testada isoladamente antes de qualquer UI usá-la.
- **Migration 3 — `sale_items.list_price_snapshot`/`surcharge_amount`** (§9): colunas aditivas, `DEFAULT NULL`/`DEFAULT 0` — não quebra nenhuma leitura existente.
- **Migration 4 — `sales.public_receipt_token`** (§15): aditiva, `DEFAULT gen_random_uuid()` preenche automaticamente inclusive para vendas antigas.
- **Migration 5 — `finance_category` + `'shipping_revenue'`** (§11): aditiva a enum — decisão D6 precisa estar confirmada antes.
- **Migration 6 — `company_fiscal_settings.freight_fiscal_treatment`** (§4): só depois da validação contábil — enquanto isso, nem precisa existir a coluna, o builder simplesmente continua como está.

Cada migration acima é independente das outras — nenhuma depende de outra ter sido aplicada primeiro, exceto Migration 6 depender da decisão do §4 (não de uma migration anterior).

---

## 20. Plano de implementação em fases pequenas, com testes exigidos

- **Fase 0 — Corrigir `products_total`.** Teste: criar venda de teste, conferir `products_total = subtotal - discount_amount + surcharge_amount` imediatamente após a criação; rodar backfill em ambiente de teste primeiro e comparar contagem de linhas afetadas com os números já confirmados (300) antes de aplicar em produção.
- **Fase A — `sale_recipients` + cascata de IBGE.** Teste unitário da cascata CEP→ViaCEP(ibge)→`resolveMunicipioIbge`→pendência. Teste de que alterar `customer_addresses` depois não muda `sale_recipients` de uma venda já criada.
- **Fase B — Formulário de entrega.** Teste E2E: venda de entrega não salva sem os campos da coluna A/B da tabela do §6; venda de retirada não exige nenhum deles.
- **Fase C — Preço por item (`list_price_snapshot`/`surcharge_amount`).** Teste de que o total da venda bate exatamente com a soma dos itens nos dois exemplos do pedido (R$45+R$43=R$88; R$35+R$40=R$75), e que `list_price_snapshot` nunca é lido de volta de `products` depois de gravado (teste: mudar `products.base_price`, reconsultar a venda antiga, confirmar que não mudou).
- **Fase D — Receita de frete em `finance_entries` + migração dos relatórios para `products_total`.** Teste de regressão: soma das duas linhas novas de `finance_entries` sempre bate com `sales.total`; capturar valores do Dashboard/ticket médio/`/relatorios/vendas` antes e depois da migração e confirmar que a diferença é exatamente a soma de `shipping_charged` do período (nunca mais, nunca menos). Teste específico da correção de `sellerDashboard.ts` (`grossMarginPct` deixa de cair em vendas com frete alto).
- **Fase E — Nuvemshop.** Spike técnico primeiro (fora de código de produção) para confirmar o formato real de `shipping_address`/desconto por item na API da Nuvemshop antes de escrever qualquer parser. Teste: pedido de teste com endereço completo chega pronto para NF-e (passa em `validateNfeReadiness`); pedido sem endereço completo não gera falso-bloqueio de venda (só de emissão fiscal).
- **Fase F — Comprovante não fiscal.** Teste de que a rota pública nunca devolve CPF completo/endereço completo/telefone (teste de contrato da resposta, não só manual); teste de que buscar por `public_receipt_token` de outra empresa (`company_id` diferente) nunca retorna dado (isolamento multi-tenant); teste de integração com `rpc_process_exchange` via busca pelo token.
- **Fase G — Decisão do §4 aplicada ao builder** (só depois de validação contábil): teste de que o Cenário A continua bit-a-bit idêntico ao comportamento atual quando `freight_fiscal_treatment='includes_nfe_value'` (suíte de regressão de `allocateOrderAdjustments`/`buildNfePayload` já existente, 48+ testes, deve continuar 100% verde); novo teste para o Cenário B só quando/se habilitado.

Nenhuma fase acima toca `resolveFiscalDocumentType`, claim/lease/begin/complete, reconciliação, ou qualquer coisa da NFC-e homologada — confirmado, nenhuma menção a esses módulos em nenhuma das 8 novas sub-auditorias desta rodada.

---

## Tabela de decisões

| DECISÃO | PROPOSTA | EVIDÊNCIA | RISCO | PRECISA MINHA APROVAÇÃO? |
|---|---|---|---|---|
| Frete compõe o valor fiscal da NF-e? | Manter Cenário A (atual) como default; Cenário B só após validação contábil | LC 87/96 art. 13 §1º II "b" (entendimento geral, não verificado nesta rodada); modelo real de repasse ao motoboy sem CT-e próprio | Alto — excluir frete sem base legal confirmada pode gerar autuação | **Sim — e também da contabilidade, não só sua** |
| Reativar `products_total` como base do valor de mercadoria | Corrigir regressão da migration, backfill das 300 vendas | `20260613_shipping_fiscal_ready.sql:62-75`, `docs/products-total-remediation-plan.md` | Baixo — mesma fórmula já usada antes da regressão | Sim |
| Fórmula de `products_total` deve incluir `surcharge_amount`? | Sim, para bater com o exemplo do pedido (R$88 = 80+8) | Fórmula original excluía surcharge (`"sem frete/surcharge"`) — mudança de semântica proposta aqui | Médio — precisa checar se as 171 vendas históricas com `surcharge_amount≠0` existem antes de considerar retroativo | Sim |
| `sale_recipients` como tabela de snapshot dedicada | Nova tabela, não colunas em `shipments` | §8 | Baixo | Sim |
| Cascata CEP(ViaCEP)→`resolveMunicipioIbge` para IBGE | Parar de descartar o campo `ibge` do ViaCEP; manter `resolveMunicipioIbge` como fallback | `cepService.ts`, `shipping/cep/route.ts:30-39,66-75`, `resolveMunicipioIbge.ts:49` | Baixo | Sim |
| `list_price_snapshot`/`surcharge_amount` por item | Novos campos aditivos em `sale_items` | §9 | Baixo | Sim |
| Nova categoria `shipping_revenue` em `finance_entries` | Duas linhas por venda com frete, em vez de uma | §11 | Médio — muda leitura de relatórios que somam `finance_entries` por categoria | Sim |
| Migrar Dashboard/ticket médio/`/relatorios/vendas`/`customer_metrics`/`/financeiro/resumo` para `products_total` | Nova semântica única: "faturamento" = mercadoria, "recebido" = com frete | §12 | Médio — mudança visível de números para quem já usa esses relatórios hoje | Sim |
| Corrigir diluição de margem em `sellerDashboard.ts` | Trocar denominador de `sales.total` para `products_total` | `sellerDashboard.ts:352,369,411` | Baixo | Sim |
| Comprovante não fiscal com `public_receipt_token` (UUID, não `sale_number`) | Nova coluna + rota pública dedicada e limitada | §15 — `sale_number` é sequencial/global, achado do agente de numeração | Baixo | Sim |
| Comprovante nunca imprime CPF completo/endereço completo | Modelo mínimo de dados, diferente do padrão já usado na etiqueta A4 atual | `vendas/[id]/imprimir/page.tsx:283-301` (precedente ruim já existente) | Baixo | Sim |
| Comprovante se integra a `exchanges`, não a `returns` | `returns`/`return_items` está morta, sem proteção anti-duplicidade | `20260609_exchanges.sql:129-141` vs. `000_schema_completo.sql:777-802` | Baixo | Sim |
| Nuvemshop — endereço/desconto por item | Requer spike técnico contra API real antes de codar (tipo atual não declara esses campos) | `route.ts:25-58` | Médio — trabalho de descoberta ainda não feito | Sim, e o spike é pré-requisito técnico |
| `company_fiscal_settings.freight_fiscal_treatment` como flag explícita | Nunca decidir silenciosamente no builder | §4 | Baixo (a coluna em si) / Alto (a decisão que ela representa) | Sim |

---

**PRONTO PARA IMPLEMENTAR: NÃO**
