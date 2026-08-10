# Plano de Implementação por Fases — Módulo Fiscal (NF-e/NFC-e) — ERP Santtorini

Complementa [`fiscal-audit-report.md`](fiscal-audit-report.md) e [`fiscal-architecture-proposal.md`](fiscal-architecture-proposal.md). **Este é um plano proposto, não autorizado.** Nenhuma fase abaixo deve começar sem autorização expressa e separada, apresentando antes: lista exata de arquivos a alterar, dependências a instalar, migrations propostas, impactos, riscos, rollback, ordem de execução e testes — conforme a regra de segurança desta auditoria.

---

## Fase 0 — Regularização e Dependências Externas

**Objetivo:** resolver bloqueadores que não dependem de código.

| Item | Responsável | Bloqueador de quê |
|---|---|---|
| Confirmar/completar credenciamento SEFAZ/RN (NF-e e NFC-e) | Santtorini + SEFAZ/RN | Toda transmissão real |
| Obter certificado digital adequado (ver recomendação em `fiscal-architecture-proposal.md`) | Santtorini | Toda transmissão real |
| Obter CSC de homologação e produção | Santtorini + SEFAZ/RN | NFC-e |
| Concluir alteração de endereço fiscal | Santtorini | Cadastro do emitente |
| Confirmar CRT e enquadramento tributário completo | Índice Contabilidade | Todo o cadastro fiscal |
| Planilha fiscal de produtos (NCM/CEST/CFOP/CST/CSOSN) | Índice Contabilidade | Fase 2 |
| Definir estratégia integração direta vs. API fiscal terceirizada | Santtorini, com recomendação técnica (ver relatório §7) | Toda a arquitetura de transmissão |
| Aprovar orçamento/infra para ambiente de homologação separado | Santtorini | Fases 3 e 4 |

**Em paralelo (saneamento técnico interno, não depende de decisão fiscal):**
- Investigar e corrigir a causa raiz de `sales.products_total` NULL desde 14/06/2026 (confirmar escopo via consulta live antes de decidir entre backfill ou descontinuar a coluna).
- Adicionar reconciliação de preço server-side na criação de venda (`unit_price` vs. catálogo).
- Bloquear edição de venda (`/api/vendas/[id]/editar`) quando houver documento fiscal vinculado (a trava em si só é possível depois que a Fase 1 criar o vínculo — mas o desenho da trava pode começar aqui).
- `pg_dump --schema-only` do banco real para reconciliar as duas árvores de migration divergentes antes de desenhar novas tabelas fiscais sobre uma base incerta.

---

## Fase 1 — Fundação Técnica

**Pré-requisito:** Fase 0 concluída o suficiente para saber qual estratégia de transmissão (direta ou terceirizada) será usada — isso afeta o desenho de `fiscal_credentials`/`fiscal_transmission_attempts`.

Escopo (proposto, sujeito a aprovação):
- Modelo de dados fiscal completo (`fiscal_establishments`, `fiscal_document_series`, `fiscal_documents`, `fiscal_document_items`, `fiscal_document_payments`, `fiscal_document_events`, `fiscal_transmission_attempts`, `fiscal_credentials`) — ver `fiscal-architecture-proposal.md`.
- Segurança de segredos: corrigir o padrão de build ARG do Dockerfile antes de introduzir `CERTIFICATE_PFX_BASE64`/`CERTIFICATE_PASSWORD`/`NFCE_CSC_ID`/`NFCE_CSC_TOKEN`.
- Séries e numeração com reserva transacional (não repetir o padrão `COUNT()+1` de `generate_sale_number`).
- Storage de documentos fiscais reaproveitando o padrão de `src/services/media.service.ts`.
- Extensão do padrão `authorization_tokens` para ações fiscais (`emit_fiscal`, `cancel_fiscal`).
- Idempotência de emissão reaproveitando o padrão `processing_lock`, com `UNIQUE` real na chave natural.
- Trilha de auditoria fiscal (reaproveitar `audit_logs` com convenção de `resource_type`, ou avaliar tabela dedicada `fiscal_audit_logs` se o volume/consulta exigir).
- Endpoint(s) de evento interno (`fiscal.document.*`) — modelo de webhook outbound assinado, hoje inexistente (extrair e reaproveitar a lógica HMAC do webhook Nuvemshop).

## Fase 2 — Cadastro Fiscal

- Completar NCM/CEST/origem/unidade em `products` para todo o catálogo ativo (apoiado pela planilha da Fase 0).
- Adicionar CFOP/CST/CSOSN/alíquotas/GTIN conforme definição da contabilidade.
- Estender `customers` para suportar PJ (CNPJ, razão social, IE, indicador de IE) e endereço estruturado com código IBGE (PF e PJ).
- Ferramenta de importação em massa para acelerar o preenchimento (reaproveitar padrão de `rpc_import_products_batch` já existente).
- Validação de completude fiscal antes de permitir emissão (bloquear emissão para produto sem NCM, por exemplo).

## Fase 3 — NFC-e em Homologação

**Pré-requisito:** ambiente de homologação de aplicação e de SEFAZ prontos; CSC de homologação obtido.

- Botão de emissão manual no PDV (não automática nesta primeira versão, conforme definido).
- Integração com o motor de emissão (direto ou via provedor, conforme decisão da Fase 0).
- Consulta de situação.
- Geração/impressão de DANFE (nova infraestrutura de impressão — avaliar as opções descritas em `fiscal-architecture-proposal.md`).
- Cancelamento (restrito a administrador, com justificativa obrigatória).
- Contingência (modo e prazo conforme confirmado no checklist SEFAZ/RN).
- Testes extensivos em homologação, validados pela contabilidade.

## Fase 4 — NF-e em Homologação

- E-commerce (Nuvemshop), atacado, vendas para CNPJ, vendas interestaduais.
- Retorno da chave fiscal para a Nuvemshop (integração nova — hoje não existe nenhuma chamada a endpoints `orders/*` da Nuvemshop).
- Geração de DANFE (A4, formato distinto do cupom NFC-e).
- Eventos (carta de correção, cancelamento).
- Testes em homologação, validados pela contabilidade.

## Fase 5 — Produção Controlada

**Pré-requisito absoluto (repetindo a regra de segurança do escopo desta auditoria):**
- Homologação concluída e validada.
- Contabilidade validou os XMLs.
- Credenciamento confirmado.
- Certificado instalado com segurança (não em texto puro, nunca no frontend, nunca em log).
- CSC confirmado.
- Ambiente de produção configurado corretamente (separado de homologação).
- Responsável pela Santtorini autorizou expressamente o início da transmissão real.

Escopo:
- Piloto controlado (poucas vendas, monitoramento manual próximo).
- Monitoramento de métricas mínimas (documentos autorizados/rejeitados/pendentes, tempo médio de autorização, principais rejeições).
- Plano de rollback definido antes do piloto (o que fazer se a SEFAZ rejeitar em massa, ou se o certificado falhar).
- Liberação gradual (por canal, começando provavelmente por NFC-e no PDV antes de NF-e no e-commerce, dado que o PDV físico é a prioridade operacional declarada).

---

## Regra de avanço entre fases

Cada fase só avança mediante autorização expressa, apresentando previamente:
1. Lista exata de arquivos a alterar/criar.
2. Dependências novas a instalar (ex.: biblioteca de assinatura XML, se integração direta).
3. Migrations propostas (texto completo, para revisão — nenhuma execução automática).
4. Impactos em fluxos existentes (venda, estoque, financeiro, PDV) — com o compromisso de não alterar fluxos que já funcionam sem necessidade comprovada.
5. Riscos específicos da fase.
6. Plano de rollback.
7. Ordem de execução.
8. Plano de testes.

Isso vale mesmo dentro de uma fase já aprovada em princípio — cada lote de mudança é apresentado e aprovado antes da implementação, uma fase de cada vez, nunca implementação especulativa adiantada.
