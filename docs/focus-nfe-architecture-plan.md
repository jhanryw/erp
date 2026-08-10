# Arquitetura Proposta — Integração Focus NFe

**Tipo:** plano de arquitetura, **não implementado**. Parte 4 (interface `FiscalProvider`) + Parte 5 (modelo de dados) + Parte 6 (idempotência) + Parte 7 (segurança). Nenhuma dependência, migration ou código foi criado.

---

## Parte 4 — Interface `FiscalProvider`

Princípio central, reafirmado: **nenhuma chamada à Focus NFe acontece dentro de uma rota do PDV ou do domínio de vendas.** O PDV só sabe que "existe uma venda paga, que pode ter um documento fiscal pendente" — a mesma separação já estabelecida para a via de integração direta (`sefaz-direct-integration-plan.md`), agora com uma interface um pouco diferente (por método de documento, não por operação genérica), exatamente como especificado:

```ts
// src/services/fiscal/provider/types.ts — PROPOSTO, não criado

export type FiscalEnvironment = 'homologacao' | 'producao';

export interface NfceIssueInput {
  documentId: string;       // fiscal_documents.id — o provider monta o payload a partir do snapshot já gravado
}

export interface NfeIssueInput {
  documentId: string;
}

export interface FiscalIssueResult {
  documentId: string;
  providerReference: string;      // o `ref` no caso da Focus
  accessKey: string | null;
  status: 'authorized' | 'rejected' | 'processing' | 'technical_failure';
  protocolNumber: string | null;
  statusCode: string | null;      // status_sefaz, no caso da Focus
  statusMessage: string | null;   // mensagem_sefaz
  xmlUrl: string | null;          // resolvida para URL própria (Storage), nunca a URL crua do provedor
  danfeUrl: string | null;        // idem
  qrCodeUrl: string | null;
  rawResponse: string;            // para storage, nunca logada diretamente
}

export interface FiscalDocumentResult {
  providerReference: string;
  status: 'authorized' | 'rejected' | 'cancelled' | 'processing' | 'not_found' | 'unknown';
  statusCode: string | null;
  statusMessage: string | null;
  accessKey: string | null;
  protocolNumber: string | null;
}

export interface FiscalCancellationResult {
  status: 'cancelled' | 'rejected';
  statusCode: string | null;
  statusMessage: string | null;
  protocolNumber: string | null;
  rawResponse: string;
}

export interface FiscalProvider {
  issueNfce(input: NfceIssueInput): Promise<FiscalIssueResult>;
  issueNfe(input: NfeIssueInput): Promise<FiscalIssueResult>;
  consultNfce(reference: string): Promise<FiscalDocumentResult>;
  consultNfe(reference: string): Promise<FiscalDocumentResult>;
  cancelNfce(reference: string, justification: string): Promise<FiscalCancellationResult>;
  cancelNfe(reference: string, justification: string): Promise<FiscalCancellationResult>;
}
```

Diferenças deliberadas em relação a `FiscalGateway` (proposto para a via direta, `sefaz-direct-integration-plan.md`): métodos separados por modelo de documento (`issueNfce`/`issueNfe`) em vez de um `authorize()` genérico — reflete a própria API da Focus, que já expõe `/v2/nfce` e `/v2/nfe` como recursos distintos com comportamento diferente (síncrono vs. assíncrono, prazos de cancelamento diferentes). Isso não impede a futura implementação direta (`SvrsDirectProvider`) de também separar por modelo internamente, mesmo que a API da SEFAZ use uma função `NFeAutorizacao` compartilhada — a interface do domínio não precisa espelhar 1:1 a API de cada provedor.

## `FocusNFeProvider` — primeira implementação (estrutura proposta)

```
src/services/fiscal/
  provider/
    types.ts                     // interface FiscalProvider + tipos (acima)
    focus/
      FocusNFeProvider.ts         // implementa FiscalProvider
      httpClient.ts               // Basic Auth + base URL por ambiente
      buildNfcePayload.ts         // monta o corpo do POST /v2/nfce a partir do snapshot
      buildNfePayload.ts          // idem para NF-e
      parseResponse.ts            // extrai status/status_sefaz/mensagem_sefaz/chave/etc.
      resolveAssetUrls.ts         // resolve caminho_xml_nota_fiscal/caminho_danfe (pendência da Parte 1, item 13 — confirmar no spike)
      webhookVerifier.ts          // valida o header authorization/authorization_header configurado
    svrs/                         // futuro — não criado agora
      SvrsDirectProvider.ts
  emitDocument.ts                  // orquestração de domínio, único consumidor de FiscalProvider (não sabe qual implementação está ativa)
  buildSnapshot.ts                 // já proposto em fiscal-architecture-proposal.md, reaproveitado sem alteração
```

**Seleção de provedor:** uma única função `getFiscalProvider(companyId): FiscalProvider`, resolvida a partir de uma coluna nova em `fiscal_establishments` (`provider: 'focus_nfe' | 'svrs_direct'`, ver Parte 5) — nunca uma variável de ambiente global fixa. Isso é o que efetivamente viabiliza a troca futura para `SvrsDirectProvider` sem alterar `emitDocument.ts` nem nenhuma rota do PDV: só a fábrica muda.

---

## Parte 5 — Modelo de Dados Adaptado

O modelo já proposto em `fiscal-architecture-proposal.md` §2 (para a via direta) continua a base — **não é substituído, é estendido** para suportar múltiplos provedores desde o desenho, mesmo a primeira implementação sendo só Focus.

### Alterações propostas às tabelas já desenhadas (não migrations novas — ajuste ao desenho, ainda não implementado nenhuma das duas versões)

**`fiscal_establishments`** — adicionar:
- `provider TEXT NOT NULL DEFAULT 'focus_nfe' CHECK (provider IN ('focus_nfe', 'svrs_direct'))`
- `provider_credentials_ref TEXT` — referência ao segredo (token Focus, ou certificado, dependendo do provedor), nunca o valor em si (mesmo princípio de `fiscal_credentials` já proposto)

**`fiscal_documents`** — adicionar:
- `provider TEXT NOT NULL` — qual provedor emitiu este documento especificamente (histórico correto mesmo que o estabelecimento troque de provedor no futuro — um documento antigo não deve "mudar de provedor" retroativamente)
- `provider_reference TEXT NOT NULL` — o `ref` da Focus (ou equivalente futuro do SVRS direto). **Substitui/generaliza** o que seria só `idempotency_key` na proposta original — ver Parte 6 para o formato exato
- `request_snapshot JSONB` — o payload exato enviado ao provedor (não o mesmo que `totals_snapshot`, que é o snapshot de negócio; este é o payload de transporte, útil para depuração e reprocessamento)
- `response_snapshot JSONB` — a resposta bruta do provedor (o `rawResponse` da interface), sanitizada antes de gravar (nunca deve conter segredo, mas a resposta de emissão fiscal por natureza não deveria conter nenhum — checagem defensiva mesmo assim)
- `access_key CHAR(44)` — já proposto, mantido
- `protocol_number TEXT` — já proposto como `protocol_number`, mantido, valor vem de `numero_protocolo`/`protocolNumber`
- Constraint `UNIQUE (provider, provider_reference)` — ver Parte 6

**`fiscal_files`** — já proposto, sem alteração de schema, mas o fluxo de gravação muda: para Focus, o conteúdo vem de uma URL externa (`caminho_xml_nota_fiscal`/`caminho_danfe`) que precisa ser buscada e persistida no Storage próprio, não apenas referenciada — nunca depender só do link da Focus como fonte permanente (mesmo princípio de "o ERP mantém cópia própria" já registrado em `fiscal-architecture-proposal.md` §8).

### Tabelas que continuam iguais, sem necessidade de alteração
`fiscal_document_items`, `fiscal_document_payments`, `fiscal_document_events`, `fiscal_transmission_attempts`, `fiscal_tax_profiles`, `fiscal_operation_rules`, `fiscal_webhook_deliveries` — o desenho já proposto é agnóstico de provedor por natureza (são snapshots de negócio, não de transporte).

**Nenhuma migration foi criada.** O ajuste acima é só de desenho, para revisão antes da Entrega B.

---

## Parte 6 — Idempotência

**Ponto de partida direto da documentação oficial (Parte 1, item 3):** a `ref` da Focus é única **por token** (por empresa), e **uma vez autorizado o documento, aquela `ref` fica permanentemente vinculada a ele — não pode ser reusada, mesmo após cancelamento.** Isso muda o desenho em relação ao que havia sido proposto para a via direta (que usava `sale_id`+`model`+`purpose` como chave, sem essa restrição de "nunca mais reusável").

### Formato da `ref`

**Não deve depender só do número da venda**, por dois motivos concretos: (1) uma venda pode gerar mais de um documento fiscal com justificativa (complementar, ajuste — já previsto em `fiscal-architecture-proposal.md` §2, campo `purpose`), e cada tentativa precisa de sua própria `ref` sem colidir; (2) se uma primeira tentativa falhar de forma irrecuperável (não por erro de dado, mas por um problema que exija mudar a `ref`, ainda que a documentação sugira que reenvio com a mesma `ref` funciona para o caso comum de rejeição), é preciso poder gerar uma nova tentativa sem ambiguidade.

**Proposta de formato:** `stt-{company_id}-{fiscal_document_id}` — onde `fiscal_document_id` já é único por natureza (chave primária da tabela já proposta), e o prefixo `stt-{company_id}` deixa a origem legível em qualquer painel/log da Focus, sem depender do número de venda (que pode mudar de forma — ver achado M1 do registro de riscos, mecanismo de numeração ainda não totalmente confirmado). Caracteres exclusivamente alfanuméricos e hífen — **hífen precisa ser confirmado como aceito** (a documentação diz "sem caracteres especiais", ambíguo se hífen conta; usar `stt{company_id}{fiscal_document_id}` sem separador se o spike confirmar que hífen é rejeitado).

### Constraint única

`fiscal_documents` com `UNIQUE (provider, provider_reference)` (Parte 5) — real constraint de banco, não apenas índice (mesma lição já aprendida com `pedidos.processing_lock`, corrigida no desenho da via direta e mantida aqui).

### Prevenção de emissão dupla

Mesmo padrão já proposto (`fiscal-architecture-proposal.md` §5): reservar a linha em `fiscal_documents` com `status='queued'` e a `provider_reference` já definida **antes** de chamar `issueNfce()` — se a chamada falhar por timeout, a linha já existe e pode ser consultada/retomada, nunca gerar uma segunda `ref` para a mesma intenção de emissão.

### Comportamento em timeout

**Nunca reenviar automaticamente sem antes consultar** (`consultNfce(reference)`) — regra já estabelecida na via direta, reforçada aqui porque a semântica de "ref já vinculada permanentemente" da Focus torna um reenvio duplicado ainda mais perigoso do que na via direta (lá, reenviar com a mesma chave só falharia por unicidade; aqui, se a primeira tentativa na verdade tiver sido autorizada apesar do timeout no lado do ERP, a `ref` já está "queimada" e uma segunda tentativa com nova `ref` geraria um **segundo documento fiscal real**, não apenas um erro).

### Consultar antes de reenviar

Reforçado: `consultNfce`/`consultNfe` devem ser chamados sempre que o estado local for `queued`/`processing` por mais que um tempo limite curto (proposta: 30 segundos, dado que a emissão de NFC-e é síncrona segundo a documentação — um timeout real provavelmente indica falha de rede, não processamento lento do lado da Focus) — nunca assumir falha e criar nova `ref` sem essa consulta.

### Webhook duplicado

A Focus pode reenviar o mesmo webhook (política de retry documentada: 1min/30min/1h/3h/24h, Parte 1 item 10) — o endpoint receptor deve ser idempotente por natureza: ao receber um evento para uma `provider_reference` já processada com o mesmo resultado, responder 200 sem reprocessar (nunca gerar um segundo evento em `fiscal_document_events` para a mesma notificação repetida — usar `UNIQUE (fiscal_document_id, event_type, provider_event_hash)` ou similar, a refinar quando o payload real do webhook for confirmado no spike).

### Webhook fora de ordem

Como a Focus não numera/sequencia webhooks (não documentado nenhum mecanismo de sequência), o endpoint receptor deve tratar o `status` recebido como **o estado mais recente conhecido pelo provedor no momento do envio**, não presumir ordem de chegada — sempre atualizar `fiscal_documents` com base no `status`/`status_sefaz` do payload, nunca assumir que webhooks chegam na ordem em que os eventos ocorreram (rede não garante isso).

### Reenvio de webhook

Confirmado que **não existe reenvio/histórico de entregas para NFCe** (Parte 1, item 11) — como a emissão de NFC-e é síncrona, isso é consistente (o resultado já veio na resposta do `POST /nfce`; webhook de NFCe só existe para o caso de contingência). Para NF-e (Entrega I), o endpoint `POST /nfe/{referencia}/hook` existe e deve ser usado como mecanismo de recuperação manual quando um webhook parecer perdido.

### Reconciliação periódica

Job novo, mesmo padrão HTTP-cron dos já existentes (`cashback-expire`, `CRON_SECRET` bearer): varrer `fiscal_documents` com `status IN ('queued', 'processing')` há mais que um limiar de tempo (proposta: 5 minutos para NFC-e síncrona, mais generoso para NF-e assíncrona), chamar `consultNfce`/`consultNfe` para cada um, atualizar o estado. Rede de segurança para o caso de o webhook nunca chegar (relevante principalmente para NF-e, onde o fluxo depende de webhook/consulta por ser assíncrono).

---

## Parte 7 — Segurança

### Tokens somente no backend
O token Basic Auth da Focus nunca é referenciado em nenhum componente `'use client'`, nunca aparece em nenhuma variável `NEXT_PUBLIC_*` — só `FocusNFeProvider`, rodando em rota de API/service. Mesmo princípio já estabelecido para o certificado na via direta (`fiscal-crypto-security-plan.md`), mais simples aqui porque não há certificado nem chave privada para proteger — só o token HTTP Basic.

### Secrets separados de homologação e produção
Confirmado pela documentação (Parte 1, item 2): **token distinto por ambiente.** Proposta: `FOCUS_NFE_TOKEN_HOMOLOGACAO` e `FOCUS_NFE_TOKEN_PRODUCAO` como dois secrets de runtime distintos (nunca um único secret com um "modo" alternável) — mesma lógica de "nunca confundir ambiente por um parâmetro fácil de esquecer" já registrada em `fiscal-architecture-proposal.md` §11.

### Nunca `NEXT_PUBLIC_*`
Reafirmado explicitamente — nenhum dos dois tokens, em nenhuma circunstância, deve ganhar o prefixo `NEXT_PUBLIC_`. Precedente relevante já auditado: `src/app/(dashboard)/debug/page.tsx` já verifica defensivamente se `NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY` está definida (achado da rodada de RLS) — o mesmo tipo de erro não pode se repetir com o token Focus.

### Redaction nos logs
Mesmo utilitário central já proposto (`redactFiscalSecrets`, `fiscal-crypto-security-plan.md`) — estendido para reconhecer o token Focus (o header `Authorization: Basic ...` completo nunca deve aparecer em log, nem em `request_snapshot` gravado em `fiscal_documents` — sanitizar antes de persistir, não só antes de logar).

### Verificação de webhook
**Sem HMAC disponível (achado da Parte 1, item 10)** — o mecanismo real é o par `authorization`/`authorization_header` configurado na criação do webhook, ecoado pela Focus a cada chamada. Proposta de uso: gerar um valor aleatório longo (não um segredo reaproveitado de outro sistema) como `authorization`, configurar `authorization_header` como um nome de header próprio (ex.: `X-Santtorini-Fiscal-Webhook-Secret`), e o endpoint receptor **rejeita com 401 qualquer chamada que não apresente esse header com o valor exato**, em comparação de tempo constante (`crypto.timingSafeEqual`, mesmo padrão já usado na verificação HMAC do webhook Nuvemshop, `src/app/api/webhooks/nuvemshop/order/route.ts:12-20`, reaproveitado por analogia mesmo sendo um mecanismo mais simples). **Isto é mais fraco que HMAC** (não prova que o corpo não foi alterado em trânsito, só que quem chamou conhece o segredo) — aceitável dado que a chamada é sempre por HTTPS (integridade de transporte garantida), mas registrado como limitação conhecida, não uma escolha de segurança equivalente.

### Proteção contra payload duplicado
Já coberta na Parte 6 (webhook duplicado) — idempotência por `(fiscal_document_id, event_type, hash_do_payload)`.

### Armazenamento privado de XML
Reaproveitar o padrão já definido (`fiscal-architecture-proposal.md` §8, Media Hub) — bucket privado, chave não sequencial, signed URL de curta duração. Novo, específico da Focus: o conteúdo precisa ser **buscado ativamente** da URL/caminho retornado pela Focus (pendência de resolução de URL, Parte 1 item 13) no momento da autorização, não apenas referenciado — o ERP nunca deve depender do link da Focus continuar acessível indefinidamente.

### RLS
**Reafirmado, mesmo princípio da via direta (`fiscal-crypto-security-plan.md`):** as tabelas fiscais (`fiscal_documents`, `fiscal_credentials`/`fiscal_establishments` estendida, `fiscal_files`) devem nascer com RLS habilitado e policy company-scoped desde a primeira migration — a correção do RLS crítico já identificado em `sales`/`customers`/`products`/`users` (`rls-open-policies-remediation-plan.md`) continua pré-requisito antes de qualquer dado fiscal real existir, **independentemente da via de integração escolhida** (Focus ou direta).

### Permissões de emissão e cancelamento
Mesmo padrão já desenhado (`fiscal-architecture-proposal.md` §14): emissão acessível a `usuario`+ (sem token extra), cancelamento restrito a `admin`. **Reforço específico da Focus**: o prazo de cancelamento de NFC-e é de só **30 minutos** (Parte 1, item 6) — o fluxo de autorização (se algum dia envolver um token de `authorization_tokens`, como em `cancel_sale`) não pode introduzir atraso que consuma esse prazo; recomenda-se que `admin` cancele diretamente, sem exigir um segundo aprovador, dado que já é o papel mais alto.

### Bloqueio explícito de produção
Mesmo mecanismo já proposto (`fiscal_establishments.ambiente_producao_habilitado`, default `false`) — `FocusNFeProvider` resolve o token e a URL base (homologação vs. produção) a partir dessa flag + da coluna `environment` de `fiscal_documents`/`fiscal_document_series`, nunca de uma variável de ambiente global única.

---

**Nenhuma dependência, migration, secret ou infraestrutura foi criada nesta etapa.**
