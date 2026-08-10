# Mapeamento de Campos — Payload Focus NFe (NFC-e) vs. ERP Santtorini

**Tipo:** gap analysis, **não implementado**. Baseado nos campos confirmados em `focus-nfe-integration-audit.md` Parte 1 (documentação oficial Focus, nível "campos de uso mais comum" da página `emitir_nfce`). **Os campos internos dos arrays `items[]` e `formas_pagamento[]` não foram enumerados pela documentação consultada nesta rodada** (a referência completa está em `campos.focusnfe.com.br/nfe/NotaFiscalXML.html`, não lida) — onde este documento precisa desses campos, o nome exato é marcado como **não confirmado**, e o mapeamento é feito pelo conceito fiscal (que já é bem conhecido desta auditoria — NCM/CFOP/CST/CSOSN etc.), nunca por um nome de campo inventado.

Legenda de "Bloqueador": 🔴 Homologação (impede testar) · ⛔ Produção (impede emitir de verdade, mesmo que homologação passe) · — nenhum

---

## Cabeçalho do documento (emitente/operação)

| Campo Focus | Obrigatório? | Origem no ERP | Tabela/coluna | Existe | Regra de transformação | Depende da contabilidade? | Bloqueador |
|---|---|---|---|---|---|---|---|
| `cnpj_emitente` | Sim | Cadastro da empresa | **Não existe** — `companies` não tem CNPJ (achado C1, confirmado por consulta real) | ❌ Não existe | Nenhuma — precisa ser cadastrado | Não (é dado cadastral da Santtorini) | 🔴⛔ |
| `data_emissao` | Sim | Momento da emissão | Gerado no momento da chamada, não lido de `sales` | ✅ Existe (é um `now()`) | Formatar ISO 8601, tolerância 5 min | Não | — |
| `natureza_operacao` | Sim | Fixo/configurável ("VENDA AO CONSUMIDOR" default) | Não existe hoje como configuração — pode usar o default da Focus inicialmente | 🟡 Existe parcialmente (default da Focus cobre o caso comum) | Nenhuma para o caso padrão | Confirmar se algum canal exige natureza diferente | — |
| `modalidade_frete` | Sim | Não existe conceito equivalente hoje em `sales`/`shipments` para "modalidade de frete NF-e" (CIF/FOB/sem frete) — mas `shipments.mod_frete` **já existe**, adicionado especificamente para esse fim em `20260613_shipping_fiscal_ready.sql` | `shipments.mod_frete` | ✅ Existe | Mapear `mod_frete` (0/1/9) para o valor esperado pela Focus (formato exato não confirmado) | Não | — |
| `local_destino` | Sim | Determinado pela UF do destinatário vs. UF do emitente (interno/interestadual/exterior) | Não existe como campo pronto — precisa ser calculado | ❌ Não existe (calculável) | Comparar UF do cliente com UF do emitente | Confirmar regra para casos de fronteira/exterior | 🔴 |
| `presenca_comprador` | Sim | Canal da venda (PDV presencial vs. Nuvemshop não presencial) | `sales.sale_origin` (enum `customer_origin`) — indica canal, não o indicador fiscal de presença exigido pela NFC-e | 🟡 Existe parcialmente | Mapear `sale_origin` para o código de presença do comprador (valores exatos do enum Focus não confirmados) | Confirmar mapeamento canal→indicador com a contabilidade | 🔴 |
| `indicador_inscricao_estadual_destinatario` | Não confirmado se obrigatório | Não existe — `customers` não tem IE (não há suporte PJ) | — | ❌ Não existe | N/A para PF | Não, relevante só quando PJ existir | — (só relevante na Entrega I) |

## Destinatário

| Campo Focus | Obrigatório? | Origem no ERP | Tabela/coluna | Existe | Regra de transformação | Depende da contabilidade? | Bloqueador |
|---|---|---|---|---|---|---|---|
| `nome_destinatario` | Condicional (se identificado) | `customers.name` | `customers.name` | ✅ Existe | Direto, exceto para "cliente avulso" (`is_anonymous=true`), onde não deve ser enviado | Não | — |
| `cpf_destinatario` | Condicional | `customers.cpf` | `customers.cpf` (nullable) | ✅ Existe, mas nullable | Só enviar se preenchido e cliente não anônimo | Confirmar regras de quando CPF é obrigatório (consumidor final vs. não) | — |
| `cnpj_destinatario` | Condicional | **Não existe** — `customers` não suporta PJ | — | ❌ Não existe | N/A até Entrega I | Sim — confirmar se/quando NFC-e para CNPJ é necessária | ⛔ (só bloqueia NF-e/Entrega I, não NFC-e) |
| Endereço do destinatário (NF-e, não obrigatório em NFC-e) | Condicional (NF-e) | **Não existe** — `customers` só tem `city`/`state` livres, sem CEP/logradouro/IBGE | — | ❌ Não existe | N/A para NFC-e; bloqueador para NF-e (Entrega I) | Não diretamente, é dado cadastral | ⛔ (só NF-e) |

## Itens (`items[]`) — nomes de campo Focus não confirmados nesta pesquisa

| Conceito fiscal | Obrigatório (presumido) | Origem no ERP | Tabela/coluna | Existe | Regra de transformação | Depende da contabilidade? | Bloqueador |
|---|---|---|---|---|---|---|---|
| Descrição do produto | Sim | `products.name` | `products.name` | ✅ Existe | Direto | Não | — |
| NCM | Sim (obrigatório em qualquer NF-e/NFC-e) | `products.ncm` | `products.ncm` (nullable, sem CHECK) | 🟡 Existe parcialmente — incompleto para parte do catálogo (flag de qualidade `product_no_ncm` já existente) | Direto, quando preenchido | **Sim** — planilha fiscal de produtos pendente (`fiscal-accounting-checklist.md`) | 🔴 |
| CEST | Condicional (produtos com ST) | `products.cest` | `products.cest` (nullable) | 🟡 Existe parcialmente | Direto, quando aplicável | Sim | 🔴 (só para produtos com ST) |
| CFOP | Sim | **Não existe em nenhum lugar do schema** | — | ❌ Não existe | Precisa de matriz de decisão (canal × operação × destino), nenhuma definida hoje | **Sim, crítico** | 🔴⛔ |
| CST/CSOSN | Sim (depende do CRT) | **Não existe** | — | ❌ Não existe | Depende do CRT confirmado (Simples Nacional → CSOSN) | **Sim, crítico, bloqueado até CRT confirmado** | 🔴⛔ |
| Origem da mercadoria | Sim | `products.origem` | `products.origem` (nullable smallint, sem CHECK) | 🟡 Existe parcialmente | Direto, quando preenchido | Sim (confirmar produtos importados) | 🔴 |
| Unidade comercial | Sim | `products.unidade_med` | `products.unidade_med` (NOT NULL, default `'UN'`) | ✅ Existe (mas o default silencia a ausência de dado real revisado) | Direto | Confirmar se o default está correto para todo o catálogo | — |
| GTIN/EAN | Condicional (obrigatório informar "SEM GTIN" corretamente quando ausente) | **Não existe** | — | ❌ Não existe | Confirmar com a Focus/contabilidade o valor correto para "sem GTIN" (provavelmente `"SEM GTIN"` literal, padrão nacional, mas não confirmado nesta pesquisa) | Não diretamente | 🔴 |
| Quantidade | Sim | `sale_items.quantity` | `sale_items.quantity` | ✅ Existe | Direto | Não | — |
| Valor unitário | Sim | `sale_items.unit_price` | `sale_items.unit_price` | ✅ Existe — **mas não validado contra catálogo no momento da venda** (achado A2 do registro de riscos) | Direto, com a ressalva de que o valor pode não refletir o preço real de catálogo | Não | — (risco pré-existente, não bloqueador novo) |
| Valor total do item | Sim | `sale_items.total_price` | `sale_items.total_price` | ✅ Existe | Direto | Não | — |
| Desconto do item | Não confirmado se aceito por item ou só no total | `sale_items.discount_amount` | `sale_items.discount_amount` | ✅ Existe | Confirmar formato aceito pela Focus (por item vs. total do documento) | Não | — |
| Alíquotas (ICMS/PIS/COFINS) | Sim (depende do CRT) | **Não existe** | — | ❌ Não existe | Depende de `fiscal_tax_profiles` (ainda não criada, Entrega B) | **Sim, crítico** | 🔴⛔ |

## Pagamentos (`formas_pagamento[]`) — nomes de campo Focus não confirmados nesta pesquisa

| Conceito fiscal | Obrigatório (presumido) | Origem no ERP | Tabela/coluna | Existe | Regra de transformação | Depende da contabilidade? | Bloqueador |
|---|---|---|---|---|---|---|---|
| Meio de pagamento (código SEFAZ) | Sim | `sale_payments.method` (enum interno `pix|card|cash|credit_card|debit_card`) | `sale_payments.method` | 🟡 Existe parcialmente | Mapear enum interno → código de meio de pagamento SEFAZ (tabela de código nacional, não a mesma coisa) | Confirmar tabela de mapeamento com a contabilidade | 🔴 |
| Valor pago | Sim | `sale_payments.net_amount` | `sale_payments.net_amount` | ✅ Existe | Direto por linha | Não | — |
| Bandeira do cartão | Condicional (cartão) | `sale_payments.card_brand` | `sale_payments.card_brand` (texto livre, sem enum) | 🟡 Existe parcialmente | Confirmar se a Focus espera um código de bandeira específico (texto livre do ERP pode não bater) | Não | — |
| CNPJ da credenciadora | Condicional (cartão) | **Não existe** — só `sale_payments.acquirer` como texto livre, nunca CNPJ real | — | ❌ Não existe | Precisaria de tabela de referência CNPJ por adquirente | Não | — (mitigável se a Focus não exigir isso — não confirmado) |
| **Cashback como forma de pagamento** | — | **Não existe em `sale_payments`** — cashback é tratado só via `sales.cashback_used`, nunca vira linha em `sale_payments` (achado M3 do registro de riscos) | `sales.cashback_used` | 🟡 Existe, mas em local diferente do esperado | **Decisão necessária**: como representar uma venda 100% ou parcialmente paga em cashback no payload da Focus — provavelmente como desconto, não como forma de pagamento, mas isso muda o valor de `vProd`/base de cálculo. **Não decidido nesta pesquisa** | **Sim, crítico** | 🔴⛔ |
| **Reconciliação soma(pagamentos) = total da venda** | — | Não validado no servidor hoje (achado M2) | — | ❌ Não existe | Precisa ser adicionada na camada de tradução ERP→Focus, mesmo que nunca tenha existido no domínio de venda em si | Não | 🔴 (a Focus provavelmente rejeita se não bater — não confirmado, mas prudente assumir) |

## Numeração/série

| Campo Focus | Origem no ERP | Existe | Regra de transformação | Bloqueador |
|---|---|---|---|---|
| `numero`/`serie` (opcionais — Focus pode gerar automaticamente) | Se controlado pelo ERP: `fiscal_document_series` (ainda não criada, Entrega B) | ❌ Não existe ainda | **Decisão de arquitetura, não bloqueador de dado**: usar numeração automática da Focus (mais simples, menos controle) ou `fiscal_document_series` própria (mais controle, mais trabalho) — ver `focus-nfe-architecture-plan.md` §5 | — |

---

## Resumo de bloqueadores

**Bloqueiam homologação (🔴) — nada disso impede desenhar a arquitetura, mas impede testar uma emissão real, mesmo de teste:**
CNPJ da Santtorini cadastrado; cálculo de `local_destino`; mapeamento de `presenca_comprador`; NCM/CEST/origem completos para os produtos de teste; CFOP definido (mesmo que só para o cenário de teste inicial); CST/CSOSN definido; código GTIN "sem GTIN" confirmado; alíquotas mínimas definidas; mapeamento de meio de pagamento para código SEFAZ; decisão de como representar cashback no payload.

**Bloqueiam produção (⛔), além dos de homologação:** nada estrutural adicional identificado nesta rodada além dos já listados — a lista de bloqueadores de homologação e produção é essencially a mesma para NFC-e, porque os mesmos dados fiscais são exigidos em ambos os ambientes (a diferença entre homologação e produção na Focus é o efeito legal, não o payload).

**Não é bloqueador, mas decisão de arquitetura pendente:** numeração automática vs. controlada pelo ERP.

**Nenhum valor fiscal ausente foi inventado neste documento** — onde a Focus exige um dado que o ERP não tem, a célula diz explicitamente "não existe", nunca um valor de exemplo apresentado como real.
