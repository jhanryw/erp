# Plano de Integração Direta com a SEFAZ (via SVRS) — ERP Santtorini

**Tipo:** plano técnico executável, **não implementado**. Decisão registrada nesta etapa: integração direta com a SEFAZ (sem API fiscal terceirizada como primeira implementação). Nenhum código, migration, dependência ou infraestrutura foi alterado.

**Isto supersede a recomendação preliminar de `fiscal-audit-report.md` §7** (que apontava preliminarmente para API terceirizada, dados os critérios de menor risco/implementação mais rápida). Essa seção do relatório principal **não foi editada** (fora do escopo dos entregáveis autorizados nesta etapa) — fica registrado aqui, formalmente, que a decisão de negócio evoluiu para integração direta, e que `fiscal-audit-report.md` §7 deve ser atualizado para refletir isso na próxima revisão autorizada desses documentos.

---

## Status da Parte 1 — auditoria interna pendente

As consultas `pg_get_functiondef`/`pg_get_triggerdef` para `set_sale_number`, `generate_sale_number`, `trigger_generate_cashback`, `audit_cash_trigger` e todos os overloads de `rpc_create_sale` **já estão prontas** em [`database-functions-live-analysis.md`](database-functions-live-analysis.md) (Blocos 1-5), preparadas na rodada anterior desta auditoria. **Continuo sem conexão autenticada ao banco Supabase nesta sessão** — nenhuma consulta nova foi executada nesta etapa. Os achados condicionais já registrados permanecem válidos:
- [`cashback-trigger-safety-analysis.md`](cashback-trigger-safety-analysis.md) — risco de cashback duplicado, **não confirmado nem descartado**.
- [`sale-numbering-concurrency-analysis.md`](sale-numbering-concurrency-analysis.md) — mecanismo real de numeração desconhecido (é trigger, não `DEFAULT` de coluna).
- [`rpc-create-sale-overloads-analysis.md`](rpc-create-sale-overloads-analysis.md) — overload de 12 parâmetros com corpo ainda não lido.

**Estes três achados continuam sendo pré-requisito de leitura (não de correção) antes de a Entrega C (ver `fiscal-direct-implementation-phases.md`) tocar qualquer coisa relacionada a criação de venda ou cashback.** Não são bloqueadores da pesquisa/arquitetura fiscal em si (que não depende deles), mas são bloqueadores de qualquer trabalho futuro que precise mexer em `rpc_create_sale` (por exemplo, para disparar emissão fiscal a partir da criação da venda).

---

## Princípio arquitetural central: nenhum acoplamento de SOAP/XML/certificado às rotas do PDV

O PDV (`/api/vendas`, `src/app/(dashboard)/vendas/nova/page.tsx`) **nunca deve saber que existe SOAP, XML, XMLDSig ou certificado digital.** Ele só conhece: "existe uma venda paga, ela pode ter um documento fiscal pendente de emissão". Toda a complexidade de protocolo fica isolada atrás da interface `FiscalGateway` (abaixo), consumida exclusivamente pelo serviço de domínio fiscal (`src/services/fiscal/*`, novo, proposto), nunca diretamente por uma rota de API do PDV.

```
┌──────────────────────────────┐
│  PDV / rotas de vendas         │  ← não conhece SOAP/XML/certificado
│  (já existente, inalterado)    │
└───────────────┬───────────────┘
                 │ evento interno: "venda paga, emitir NFC-e"
                 ▼
┌──────────────────────────────┐
│  src/services/fiscal/          │  ← orquestração de domínio (novo)
│  emitDocument(saleId)          │     monta snapshot, decide NF-e vs NFC-e,
│                                 │     grava fiscal_documents, chama o gateway
└───────────────┬───────────────┘
                 │ usa a interface, não a implementação
                 ▼
┌──────────────────────────────┐
│  interface FiscalGateway       │  ← contrato estável (novo)
└───────────────┬───────────────┘
                 │ implementado por
                 ▼
┌──────────────────────────────┐
│  SvrsFiscalGateway              │  ← única classe que conhece SOAP/XML/
│  (primeira implementação)       │     XMLDSig/certificado/mTLS (novo)
└──────────────────────────────┘
```

Isso garante que, se a Santtorini decidir no futuro trocar de autorizador (outro SVRS, uma futura SVAN, ou até migrar para uma API terceirizada como opção B), a mudança fica isolada em uma nova implementação de `FiscalGateway` — nenhuma rota de PDV, nenhum componente de frontend, precisa mudar.

---

## Interface `FiscalGateway`

```ts
// src/services/fiscal/gateway/types.ts — PROPOSTO, não criado

export type FiscalEnvironment = 'homologacao' | 'producao';
export type FiscalModel = '55' | '65';

export interface FiscalServiceStatus {
  environment: FiscalEnvironment;
  model: FiscalModel;
  available: boolean;
  cStat: string;
  xMotivo: string;
  checkedAt: string; // ISO 8601
  tempoMedioMs?: number; // <tMed> quando informado pelo serviço
}

export interface AuthorizationResult {
  documentId: string;          // referência interna, fiscal_documents.id
  accessKey: string | null;    // chave de 44 dígitos, só se autorizado
  protocolNumber: string | null;
  cStat: string;
  xMotivo: string;
  status: 'authorized' | 'rejected' | 'pending_consultation' | 'technical_failure';
  authorizedXml: string | null; // XML autorizado completo, só se status='authorized'
  rawResponse: string;          // resposta bruta da SEFAZ, para storage (sanitizada antes de logar)
}

export interface ConsultationResult {
  accessKey: string;
  cStat: string;
  xMotivo: string;
  status: 'authorized' | 'cancelled' | 'not_found' | 'processing' | 'unknown';
  protocolNumber: string | null;
}

export interface CancellationInput {
  documentId: string;
  accessKey: string;
  protocolNumber: string;      // protocolo de autorização, exigido no evento de cancelamento
  justification: string;       // mínimo de caracteres exigido pelo leiaute (confirmar no MOC 7.0 Anexo I)
  requestedBy: string;         // uuid do usuário (só admin, ver fiscal-architecture-proposal.md §14)
}

export interface InvalidationInput {
  companyId: number;
  establishmentId: number;
  environment: FiscalEnvironment;
  model: FiscalModel;
  series: number;
  numberRangeStart: number;
  numberRangeEnd: number;
  justification: string;
  requestedBy: string;
}

export interface EventResult {
  cStat: string;
  xMotivo: string;
  protocolNumber: string | null;
  status: 'accepted' | 'rejected';
  rawResponse: string;
}

export interface FiscalGateway {
  getServiceStatus(environment: FiscalEnvironment, model: FiscalModel): Promise<FiscalServiceStatus>;
  authorize(documentId: string): Promise<AuthorizationResult>;
  consult(accessKey: string, environment: FiscalEnvironment): Promise<ConsultationResult>;
  cancel(input: CancellationInput): Promise<EventResult>;
  invalidate(input: InvalidationInput): Promise<EventResult>;
}
```

Notas de desenho (justificativas, não decisões arbitrárias):
- `authorize(documentId: string)` recebe o **ID interno do documento** (`fiscal_documents.id`), não a venda nem o XML — a responsabilidade de montar o XML a partir do snapshot já gravado é do `SvrsFiscalGateway`, não de quem chama. Isso mantém o chamador (`src/services/fiscal/emitDocument`) livre de qualquer conhecimento de XML.
- `environment` é parâmetro explícito em `getServiceStatus`/`consult`, não implícito — evita o erro de "esqueceu de trocar para produção" ou o oposto, mais perigoso, "achou que estava em homologação mas estava em produção". Em `authorize`/`cancel`/`invalidate`, o ambiente é resolvido a partir do próprio `fiscal_documents`/`fiscal_document_series` (já gravado no momento da criação do rascunho), não passado solto — reduz a chance de um chamador errar o ambiente numa chamada isolada.
- `rawResponse` existe para permitir armazenamento no Storage (ver `fiscal-crypto-security-plan.md`), mas **nunca deve ser logado diretamente** — a camada de logging precisa sanitizar antes.
- Nenhum método recebe certificado, senha, ou qualquer segredo como parâmetro — isso é responsabilidade interna do `SvrsFiscalGateway`, resolvido via o mecanismo de segredo em runtime (ver `fiscal-crypto-security-plan.md` §Segurança).

## `SvrsFiscalGateway` — primeira implementação (estrutura proposta, não implementada)

```
src/services/fiscal/
  gateway/
    types.ts                    // interface FiscalGateway + tipos (acima)
    svrs/
      SvrsFiscalGateway.ts       // implementa FiscalGateway
      soapClient.ts              // encapsula chamada SOAP + mTLS (usa `soap`/`easy-soap-request`, ver fiscal-crypto-security-plan.md)
      xmlBuilder.ts              // monta XML mínimo a partir do snapshot (usa xmlbuilder2)
      xmlSigner.ts               // assina XMLDSig (usa xml-crypto ou xmldsigjs)
      xsdValidator.ts            // valida contra XSD oficial (usa xmllint-wasm)
      certificateLoader.ts       // carrega PFX de secret de runtime (usa node-forge >=1.4.0)
      endpoints.ts                // mapa de endpoints homolog/prod (fonte: svrs-services-endpoints.md — nunca hardcoded solto no meio do código)
      parseResponse.ts            // extrai cStat/xMotivo/protocolo/chave da resposta SOAP
  emitDocument.ts                 // orquestração de domínio, único consumidor de FiscalGateway
  buildSnapshot.ts                // monta fiscal_document_items/totals_snapshot a partir de sales/sale_items
```

Nenhum destes arquivos existe hoje — esta é a estrutura proposta para quando a implementação for autorizada (Entregas C-D em `fiscal-direct-implementation-phases.md`).

---

## Documentos complementares desta etapa

- [`svrs-services-endpoints.md`](svrs-services-endpoints.md) — pesquisa oficial completa (endpoints, versões, contingência, DANFE/QR Code, cronograma da Reforma Tributária).
- [`fiscal-technical-spike-plan.md`](fiscal-technical-spike-plan.md) — prova técnica isolada de 12 passos, não implementada.
- [`fiscal-crypto-security-plan.md`](fiscal-crypto-security-plan.md) — bibliotecas candidatas + desenho de segurança do certificado/segredos.
- [`fiscal-xsd-versioning-plan.md`](fiscal-xsd-versioning-plan.md) — estratégia de acompanhamento de versão de schema ao longo do tempo.
- [`fiscal-direct-implementation-phases.md`](fiscal-direct-implementation-phases.md) — Entregas A a I, cada uma com pré-requisitos, arquivos, migrations, testes, riscos, rollback e critério de aceite.

**Nenhuma implementação foi feita nesta etapa.** Aguardando autorização para a primeira entrega.
