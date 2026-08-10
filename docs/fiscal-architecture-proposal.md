# Arquitetura Proposta — Módulo Fiscal (NF-e/NFC-e) — ERP Santtorini

Complementa [`fiscal-audit-report.md`](fiscal-audit-report.md). **Isto é uma proposta para revisão, não uma implementação.** Nenhuma migration, tabela, dependência ou código foi criado. Nomes de tabela seguem o padrão observado no projeto (snake_case, sem prefixo de schema customizado) e devem ser ajustados na revisão conjunta antes de qualquer execução.

---

## 1. Componentes

```
┌────────────────────────────────────────────────────────────────────┐
│  PDV / Backoffice (Next.js, já existente)                          │
│  Botão "Emitir NFC-e" (manual, v1) → POST /api/fiscal/documents    │
└──────────────────────────┬───────────────────────────────────────┘
                            ▼
┌────────────────────────────────────────────────────────────────────┐
│  Serviço fiscal (novo, src/services/fiscal.service.ts)              │
│  - Monta snapshot fiscal (fiscal_documents/_items/_payments)        │
│  - Reserva número de série (transacional)                           │
│  - Chama motor de emissão (direto ou provedor terceirizado)         │
│  - Persiste eventos e tentativas                                    │
└───────────┬──────────────────────────────────────┬─────────────────┘
            ▼                                       ▼
┌───────────────────────────┐         ┌───────────────────────────────┐
│ Motor de emissão            │         │ Storage (Supabase Storage,     │
│ (SEFAZ direto OU provedor)  │         │ reaproveitando padrão do        │
│                              │         │ Media Hub)                      │
└───────────────────────────┘         └───────────────────────────────┘
            │
            ▼
┌────────────────────────────────────────────────────────────────────┐
│  Job de retry/reprocessamento (HTTP-cron, mesmo padrão de            │
│  /api/jobs/cashback-expire) — /api/jobs/fiscal-retry                 │
└────────────────────────────────────────────────────────────────────┘
            │
            ▼
┌────────────────────────────────────────────────────────────────────┐
│  Eventos internos (fiscal.document.*) → webhook outbound assinado    │
│  (novo, reaproveitando o padrão HMAC do webhook Nuvemshop)           │
└────────────────────────────────────────────────────────────────────┘
```

Nenhum destes componentes existe hoje, exceto o que está explicitamente marcado "já existente" ou "reaproveitando". Não há fila (Redis/BullMQ) no projeto — o "job de retry" é modelado como cron HTTP, seguindo o único padrão assíncrono já usado no sistema.

---

## 2. Modelo de Dados Proposto

### `fiscal_establishments`
Dados fiscais do emitente, hoje ausentes de `companies` (achado C1 do registro de riscos).
```
id, company_id (FK companies, UNIQUE — 1 estabelecimento por empresa nesta fase),
cnpj, razao_social, nome_fantasia, inscricao_estadual, inscricao_municipal,
crt (smallint), regime_tributario (text, redundante legível ao lado do código),
logradouro, numero, complemento, bairro, cep, municipio_ibge (char 7), municipio_nome, uf,
telefone, email_fiscal,
ambiente_producao_habilitado (boolean, default false — trava explícita contra emissão real prematura),
created_at, updated_at
```
Separado de `companies` (em vez de colunas soltas nela) porque nem toda empresa cadastrada no ERP precisa ter dados fiscais completos imediatamente — mantém `companies` como está e adiciona o fiscal como extensão opcional, sem quebrar nada existente.

### `fiscal_credentials`
Referência ao segredo, nunca o segredo em si.
```
id, company_id (FK), environment ('homologacao'|'producao'),
credential_type ('certificado_a1'|'csc'),
secret_ref (text — identificador no cofre de segredos, NÃO o valor),
valid_from, valid_until (usado pelos alertas de vencimento),
active (boolean),
created_at
```

### `fiscal_document_series`
```
id, company_id (FK), establishment_id (FK fiscal_establishments),
model ('55'|'65'), series (smallint), environment ('homologacao'|'producao'),
next_number (bigint), -- avançado via UPDATE...RETURNING transacional, nunca lido e recalculado por MAX()
active (boolean),
UNIQUE (company_id, model, series, environment)
```

### `fiscal_documents`
```
id, company_id (FK), establishment_id (FK), sale_id (FK sales, nullable — permite doc sem venda, ex: complementar),
series_id (FK fiscal_document_series), document_number (bigint),
model ('55'|'65'), purpose ('normal'|'complementar'|'ajuste'|'devolucao'),
status (enum — ver §4 Máquina de Estados),
access_key (char 44, nullable até autorizado), protocol_number (text, nullable),
environment ('homologacao'|'producao'),
recipient_type ('pf'|'pj'|'nao_identificado'),
recipient_snapshot (jsonb — cópia imutável dos dados do destinatário no momento da emissão),
totals_snapshot (jsonb — vProd/vFrete/vDesc/vNF etc., imutável pós-autorização),
xml_authorized_file_id (FK fiscal_files, nullable),
danfe_file_id (FK fiscal_files, nullable),
idempotency_key (text, UNIQUE — sale_id+model+purpose, real UNIQUE constraint, não apenas índice),
created_at, updated_at, authorized_at, cancelled_at
```
`recipient_snapshot`/`totals_snapshot` existem porque, per o pedido do escopo desta auditoria, dados de produto/cliente podem mudar depois da venda — o documento fiscal precisa preservar exatamente o que foi declarado à SEFAZ, não uma referência viva a `customers`/`products`.

### `fiscal_document_items`
```
id, fiscal_document_id (FK), sale_item_id (FK sale_items, nullable),
ncm, cest, cfop, origem, unidade_comercial, unidade_tributavel, gtin,
csosn, cst_icms, cst_pis, cst_cofins,
quantidade, valor_unitario, valor_total,
aliquota_icms, valor_icms, aliquota_pis, valor_pis, aliquota_cofins, valor_cofins,
fcp, icms_st, ibs, cbs -- nullable, preenchidos apenas quando aplicável/vigente
```
Snapshot completo por item — não relê `products` depois da emissão.

### `fiscal_document_payments`
```
id, fiscal_document_id (FK), payment_type_sefaz (código de forma de pagamento SEFAZ, não o enum interno do ERP),
sale_payment_id (FK sale_payments, nullable — nullable porque cashback não gera linha em sale_payments, ver achado M3),
valor, card_brand, nsu, authorization_code, acquirer_cnpj -- os 3 últimos nullable até confirmação da pergunta 10 em fiscal-open-questions.md
```

### `fiscal_document_events`
```
id, fiscal_document_id (FK), event_type ('emissao'|'autorizacao'|'rejeicao'|'cancelamento'|'inutilizacao'|'contingencia_ativada'|'contingencia_regularizada'|'carta_correcao'),
payload (jsonb), sefaz_status_code, sefaz_message,
created_at, created_by (FK users)
```

### `fiscal_transmission_attempts`
```
id, fiscal_document_id (FK), attempt_number,
status ('pending'|'success'|'failed'|'timeout'),
request_payload_ref, response_payload_ref, -- referência ao storage, não o payload inteiro na linha
error_message, http_status,
started_at, finished_at
```
Usado pelo job de retry e pela política de backoff (§5).

### `fiscal_tax_profiles` e `fiscal_operation_rules`
Separação explícita entre dado intrínseco do produto e regra da operação, conforme pedido no escopo:
- `fiscal_tax_profiles`: regras por combinação de categoria de produto × regime tributário × UF origem/destino — CSOSN/CST/alíquotas/benefícios/ICMS-ST/FCP.
- `fiscal_operation_rules`: matriz de decisão de modelo de documento (NF-e vs NFC-e) e CFOP por canal × tipo de operação × tipo de destinatário × UF destino.

Isso evita colocar toda a tributação diretamente no cadastro de produto (`products`), que muda de contexto conforme a operação (mesmo produto pode ter CFOP diferente se vendido para dentro ou fora do RN, por exemplo).

### `fiscal_files`
```
id, company_id, fiscal_document_id (FK, nullable), file_type ('xml_envio'|'xml_autorizado'|'protocolo'|'evento'|'danfe'),
storage_bucket, storage_key, checksum_sha256, size_bytes,
created_at
```
Reaproveita diretamente o padrão de `src/services/media.service.ts` (bucket nunca vem do cliente, checksum para dedup/integridade, chave nunca sequencial).

### `fiscal_webhook_deliveries`
```
id, company_id, event_type, target_url, secret_ref,
payload, signature, attempt_number, status ('pending'|'delivered'|'failed'),
http_status, created_at, delivered_at
```

### Auditoria
Reaproveitar `audit_logs` (já existente, genérico, `resource`/`action`/`before_data`/`after_data`) com a convenção `resource: 'fiscal_document'`. Uma tabela `fiscal_audit_logs` dedicada só se, na prática, o volume ou os requisitos de consulta/retenção legal (tipicamente mais longos que os 24 meses hoje sugeridos para `audit_log` em `TECHNICAL_NOTES.md:41`) exigirem separação — recomendação: não duplicar, mas revisar a política de retenção do `audit_logs` existente para acomodar prazos fiscais (tipicamente mais longos no Brasil).

---

## 3. Separação de Dados: Produto vs. Operação vs. Snapshot

Conforme pedido explicitamente no escopo desta auditoria:

1. **Dados intrínsecos do produto** (não mudam por operação): NCM, CEST, origem, unidade, GTIN. Vivem em `products` (já parcialmente presentes) — propor completar, não recriar.
2. **Regras tributárias** (dependem da operação, não do produto): regime tributário, UF origem/destino, tipo de destinatário, contribuinte/não-contribuinte, consumidor final, canal, CFOP, CSOSN/CST, alíquotas, benefícios, ICMS-ST, FCP, PIS, COFINS, IBS, CBS. Vivem em `fiscal_tax_profiles`/`fiscal_operation_rules`, calculadas no momento da emissão.
3. **Snapshot fiscal no momento da emissão**: os dados exatos usados para calcular e emitir o documento, congelados em `fiscal_document_items`/`fiscal_documents.totals_snapshot`/`recipient_snapshot`. Imutável após autorização — qualquer erro pós-autorização segue procedimento fiscal formal (carta de correção ou cancelamento), nunca `UPDATE` direto nessas colunas.

---

## 4. Máquina de Estados (`fiscal_documents.status`)

```
draft
  → pending_validation
      → validation_failed (retorna a draft após correção)
      → ready
          → queued
              → processing
                  → submitted
                      → authorized  [TERMINAL para o snapshot — imutável a partir daqui]
                      → rejected     (pode gerar novo draft, referenciando o rejeitado)
                      → pending_consultation (timeout — consulta antes de reenviar, nunca reenviar cegamente)
                      → contingency (ver §6)
authorized
  → cancellation_pending
      → cancelled
  → technical_failure (ex.: autorizado na SEFAZ mas falha ao gerar/persistir o DANFE — estado de recuperação operacional, não fiscal)
```

Regras:
- Toda transição passa por função transacional com `SELECT ... FOR UPDATE` no documento, mesmo padrão usado em `rpc_cancel_sale`/`rpc_return_sale`.
- `pending_consultation` é obrigatório antes de qualquer reenvio após timeout — nunca retransmitir sem antes consultar a situação (evita duplicidade, conforme exigido no escopo).
- Nenhum loop infinito de tentativas — política de retry em §5.
- Uma venda pode gerar mais de um documento fiscal apenas com justificativa modelada (`purpose`: `complementar`, `ajuste`, `devolucao`) — nunca duas emissões `normal` para a mesma venda (garantido pelo `idempotency_key` UNIQUE em `fiscal_documents`).

---

## 5. Idempotência e Política de Retry

**Idempotência:** reaproveitar o padrão de `pedidos.processing_lock` (`UPDATE ... WHERE processing_lock = false RETURNING id`, `supabase/migrations/20260521_webhook_idempotency.sql`), mas corrigindo sua fraqueza identificada na auditoria (M-nível, achado A6/risco correlato): a chave de idempotência (`sale_id`+`model`+`purpose`) deve ser um `UNIQUE` real no banco (`fiscal_documents.idempotency_key`), não apenas um índice não-único como em `pedidos`. Isso garante que mesmo duas requisições simultâneas de emissão para a mesma venda não produzam dois documentos.

**Retry:**
- Número limitado de tentativas imediatas (proposta: 3, síncronas, dentro da própria requisição de emissão).
- Se as 3 falharem, o documento vai para `queued` e um job HTTP-cron (`/api/jobs/fiscal-retry`, seguindo exatamente o padrão de `cashback-expire`/`cashback-release`: `CRON_SECRET` bearer, varre por status+tempo, aplica transição) tenta novamente com **backoff exponencial + jitter**, calculado em SQL a partir de `fiscal_transmission_attempts.attempt_number` (ex.: `least(2^attempt_number, cap_minutos) + random_jitter`), não em memória (não há worker persistente).
- Após N tentativas (proposta: 10, ou um teto de tempo, ex. 24h), o documento entra num estado de **dead-letter** (`technical_failure` ou um novo status dedicado a avaliar na Fase 1) e dispara alerta (`fiscal.document.contingency_pending` ou equivalente) via o mesmo canal de push/WhatsApp já existente (`src/lib/push/send.ts`, `src/app/api/alerts/daily/route.ts`).
- Reprocessamento manual sempre disponível para administrador, mas nunca automático além do teto acima.
- Antes de qualquer retransmissão após timeout, consultar situação (estado `pending_consultation`) — nunca assumir falha e reenviar sem checar se a SEFAZ já processou.

---

## 6. Contingência (explicação, não implementação)

**O que é:** contingência é o mecanismo previsto na legislação para a NFC-e continuar sendo emitida (em papel ou em modo simplificado, conforme o tipo de contingência autorizado) quando o emitente não consegue obter autorização online da SEFAZ no momento da venda, com a obrigação de regularizar (transmitir) o documento posteriormente dentro de um prazo definido pela legislação/SEFAZ.

**Quando pode ser usada:** tipicamente quando há indisponibilidade do webservice da SEFAZ (não indisponibilidade de internet do próprio estabelecimento, que é um cenário distinto) ou falha de comunicação prolongada. As regras exatas de quando é permitido acionar contingência, e qual modalidade é aceita pela SEFAZ/RN especificamente, devem ser confirmadas junto à fonte oficial (ver [`fiscal-sefaz-rn-checklist.md`](fiscal-sefaz-rn-checklist.md), item 7) — este documento não inventa esses prazos/regras.

**Diferença entre internet indisponível e SEFAZ indisponível:** se a internet do PDV cai, a venda não pode nem tentar a transmissão — nesse caso, o desenho aqui proposto ainda permite finalizar a venda no ERP (ela já não depende de fiscal para ser registrada, conforme confirmado na auditoria do fluxo de vendas atual) e marcar o documento fiscal como `queued`, tentando emissão assim que a conectividade voltar. Se é a SEFAZ que está indisponível (mas o estabelecimento tem internet), a contingência formal pode ser acionada conforme a modalidade vigente confirmada com a SEFAZ/RN.

**Como a venda continua:** a venda no ERP **nunca fica bloqueada esperando a SEFAZ** — ela é finalizada normalmente (como já acontece hoje) e o documento fiscal nasce em `pending_validation`/`queued`, dissociado do fluxo síncrono de finalização da venda. Isso é possível precisamente porque o fluxo de vendas atual já não tem nenhuma dependência de fiscal (confirmado: nenhuma menção a fiscal em todo o código de `rpc_create_sale`).

**Como o documento é gerado em contingência:** depende da modalidade autorizada pela SEFAZ/RN (a confirmar) — tipicamente envolve um CSC/série de contingência distinto ou justificativa formal registrada no XML.

**Transmissão posterior:** via o mesmo job de retry (`fiscal-retry`), com prioridade sobre novas emissões, e um alerta explícito se o prazo legal de regularização estiver se esgotando.

**Como impedir perda de documentos:** todo documento em contingência é persistido em `fiscal_documents` com status `contingency` no momento em que é gerado (localmente, antes de qualquer tentativa de transmissão) — nunca existe um documento "só na memória" aguardando a rede voltar.

**Como mostrar a situação ao operador:** o PDV deve exibir um indicador visível de "documentos pendentes de transmissão" (contagem), não deixar isso invisível — hoje não existe nenhuma UI equivalente, precisaria ser criada.

**Reprocessamento seguro:** sempre via consulta de situação antes de reenviar (mesma regra de §5), para não duplicar um documento que a SEFAZ já processou durante a janela de indisponibilidade percebida pelo cliente.

---

## 7. Certificado Digital — Recomendação Técnica (sem contratar nada)

Para integração automatizada em servidor (emissão sem intervenção manual por token físico a cada nota), o padrão técnico usual é o **certificado e-CNPJ tipo A1** (arquivo `.pfx`/`.p12`, sem necessidade de hardware/token conectado ao servidor), pelos seguintes motivos técnicos:
- Certificados A3 (token/smartcard) exigem hardware fisicamente conectado à máquina que assina, o que não é compatível com um servidor Linux em container Docker/EasyPanel sem hardware USB dedicado e acessível remotamente — inviável para automação de servidor sem investimento adicional em HSM/servidor de assinatura dedicado.
- A1 é instalável em memória/arquivo protegido por senha, compatível com o padrão de segredo em cofre já recomendado abaixo.
- **Contrapartida a explicitar para a Santtorini:** A1 tem validade menor (tipicamente 1 ano, a confirmar com a Autoridade Certificadora escolhida) e exige renovação mais frequente que A3 (tipicamente 3 anos) — o sistema de alerta de vencimento (abaixo) é obrigatório justamente por isso.

Nenhuma Autoridade Certificadora está sendo recomendada nesta fase — isso é decisão da Santtorini, orientada por preço e suporte, fora do escopo técnico desta auditoria.

**Nunca fazer, reafirmando a regra do escopo:** enviar certificado/senha/CSC ao frontend; logar; armazenar em texto puro no banco; commitar no Git; expor em mensagem de erro.

**Opções de armazenamento seguro avaliadas para o ambiente atual (EasyPanel/Docker/Supabase self-hosted):**
| Opção | Avaliação |
|---|---|
| Secret do EasyPanel (variável de ambiente injetada, não commitada) | Viável e mais simples de operar com a infra já existente — mesmo padrão hoje usado para `SUPABASE_SERVICE_ROLE_KEY` (mas **corrigir primeiro** o achado A7 do registro de riscos: esses segredos hoje viram build ARG do Dockerfile, o que não deve se repetir para o certificado) |
| Docker Secret nativo | Mais robusto que env var simples, mas exige mudança no processo de deploy hoje baseado em push+build do EasyPanel — avaliar se o EasyPanel expõe isso facilmente |
| Arquivo criptografado no Storage privado (reaproveitando o padrão do Media Hub) + chave de decriptação via env var | Reaproveita infraestrutura já existente e testada (`src/services/media.service.ts`), com a chave de decriptação isolada em env var — recomendação preliminar mais alinhada ao que já existe no projeto |
| Cofre de segredos dedicado (ex.: Vault) | Mais seguro, mas introduz nova peça de infraestrutura não existente hoje — desproporcional ao porte atual (single-tenant, ~200 vendas/mês) a menos que já exista apetite da Santtorini para isso |
| Variável de ambiente simples (sem criptografia adicional) | Aceitável apenas se o EasyPanel garantir que env vars não aparecem em logs/build history — precisa confirmação, dado o achado A7 |

**Recomendação preliminar:** arquivo criptografado no Storage privado (reaproveitando o Media Hub) com chave de decriptação isolada como Secret do EasyPanel — é a opção que mais reaproveita infraestrutura já validada no projeto sem introduzir peça nova. Decisão final deve ser tomada em conjunto com quem opera o EasyPanel, considerando se o painel oferece mecanismo de secret nativo mais simples.

**Alertas de validade do certificado** (novos, reaproveitando `src/lib/push/send.ts` e/ou `src/app/api/alerts/daily/route.ts`), disparados por um job diário que compara `fiscal_credentials.valid_until` contra a data atual, nos limiares: 60, 30, 15, 10, 7, 5, 2 dias antes do vencimento — cada limiar dispara uma vez (marcar como já alertado para não repetir o mesmo aviso todo dia).

---

## 8. Storage de Documentos Fiscais

Reaproveitando diretamente `src/services/media.service.ts` (bucket nunca vem do cliente, chave nunca sequencial, checksum SHA-256, signed URL de curta duração para acesso privado):

```
fiscal/
  company-{company_id}/
    production/
      nfe/{ano}/{mes}/{uuid}.xml
      nfce/{ano}/{mes}/{uuid}.xml
    homologation/
      nfe/{ano}/{mes}/{uuid}.xml
      nfce/{ano}/{mes}/{uuid}.xml
```
(nomes reais a ajustar na implementação para evitar qualquer exposição de dado sensível na própria chave — usar sempre UUID, nunca número de nota ou CPF no path, mesmo padrão já seguido pelo Media Hub).

Preservar, quando aplicável: XML de envio, XML autorizado (tratado como **imutável** após gravado — nunca sobrescrito), protocolo, eventos, cancelamentos, inutilizações, respostas da SEFAZ, DANFE, histórico de tentativas (via `fiscal_transmission_attempts`, que referencia o storage em vez de guardar o payload inline), metadados e hash (`fiscal_files.checksum_sha256`).

**Avaliações:**
- Bucket privado: sim, seguir o padrão `media-private` já existente (5MB pode ser pequeno para lotes de XML+DANFE — revisar limite na Fase 1).
- Políticas de acesso: mesma lógica de `visibility`-driven bucket selection do Media Hub, nunca vindo do cliente.
- Criptografia: avaliar se o Supabase Storage self-hosted já criptografa em repouso — não confirmado nesta auditoria (fora do escopo de arquivos do repo), perguntar a quem administra a infraestrutura.
- Backup: **não existe hoje nenhuma política de backup documentada no repositório** — isso precisa ser resolvido antes da Fase 5, dado que XML autorizado tem obrigação de retenção legal (tipicamente 5 anos no Brasil) e o ERP não deve depender exclusivamente do fato de que a contabilidade também guarda cópia via certificado.
- Retenção: definir política formal, maior que os 24 meses hoje sugeridos para `audit_log` genérico (`TECHNICAL_NOTES.md:41`) — obrigação fiscal é mais longa.
- Exportação/recuperação de desastre: a avaliar na Fase 1, não existe hoje.

---

## 9. Eventos e Webhooks

Eventos internos propostos (nomes conforme já sugerido no escopo):
`fiscal.document.authorized`, `fiscal.document.rejected`, `fiscal.document.pending`, `fiscal.document.cancelled`, `fiscal.document.cancellation_failed`, `fiscal.document.contingency_pending`, `fiscal.certificate.expiring`, `fiscal.numbering.divergence`, `fiscal.storage.failed`.

**Infraestrutura reaproveitável:** a verificação HMAC-SHA256 constant-time hoje só existe *inbound* (webhook Nuvemshop, `src/app/api/webhooks/nuvemshop/order/route.ts:12-20`) — propor extrair essa função para `src/lib/webhooks/verifyHmac.ts` (compartilhada) e criar o equivalente *outbound* (assinar o payload enviado), que **não existe hoje em nenhuma forma** — o padrão de webhook outbound atual (`sendSaleWebhook`/`sendSaleWebhookV2` em `src/app/api/vendas/route.ts`) não assina nada e não tem retry, só fire-and-forget + log de idempotência.

Webhook fiscal outbound deve ter: assinatura HMAC (reaproveitando a lógica extraída), secret por assinante (`fiscal_webhook_deliveries.secret_ref`), timestamp no payload (proteção contra replay), idempotência (chave por evento, não reenviar o mesmo evento duas vezes como sucesso), retry limitado com backoff (mesmo mecanismo do §5), histórico completo em `fiscal_webhook_deliveries`, payload versionado (campo `schema_version` no payload desde o início, para não quebrar assinantes quando o formato evoluir).

---

## 10. Métricas Mínimas (primeira fase, sem dashboard complexo)

- Documentos autorizados (contagem, por dia/mês).
- Documentos rejeitados (contagem + principais motivos, agrupado por `sefaz_status_code`).
- Documentos pendentes (contagem, por tempo em `queued`/`processing`).
- Documentos em contingência (contagem + tempo médio até regularização).
- Tempo médio de autorização (da criação até `authorized`).
- Tentativas por documento (média, para detectar degradação de conectividade/SEFAZ).
- Falhas de armazenamento (contagem).
- Cancelamentos (contagem + motivo).
- Certificado próximo do vencimento (dias restantes, já coberto pelo alerta do §7).
- Divergência de numeração (gaps inesperados na série).

Fonte de dados: consultas diretas em `fiscal_documents`/`fiscal_transmission_attempts` — nenhuma materialized view nova é necessária na primeira fase (o padrão de MVs já existe no projeto, `mv_daily_sales_summary` etc., e pode ser reaproveitado depois se o volume justificar).

---

## 11. Ambientes

Hoje: **nenhum ambiente de homologação de aplicação existe** (achado C7). Proposta mínima para viabilizar isso sem duplicar toda a infraestrutura:
- Uma variável `FISCAL_ENVIRONMENT=homologacao|producao` por deploy (não por venda) — mais simples que duplicar a aplicação inteira, mas exige que exista pelo menos um deploy separado (ainda que na mesma VPS/EasyPanel) apontando para homologação, com suas próprias `fiscal_credentials`/`fiscal_document_series` isoladas por `environment`.
- Alternativa mais simples ainda, se orçamento for um bloqueador (ver pergunta 13 em `fiscal-open-questions.md`): um único deploy, mas com trava de aplicação (`fiscal_establishments.ambiente_producao_habilitado = false` por padrão) que impede qualquer emissão em produção até ser explicitamente habilitada por um administrador — não é o ideal (mistura dados de teste e produção no mesmo banco), mas é tecnicamente possível com o schema proposto.
- Recomendação: a primeira opção (deploy de homologação separado) é preferível e deve ser tratada como pré-requisito de Fase 3, não contornada pela alternativa mais simples, exceto se a Fase 0 confirmar que não há orçamento para isso.

---

## 12. Impressão — Avaliação de Requisitos (sem escolher impressora)

Hoje: zero infraestrutura de impressão térmica (achado A4). Opções avaliadas:

| Opção | Prós | Contras |
|---|---|---|
| Página de impressão dedicada (HTML formatado para 80mm) + `window.print()` | Reaproveita o único padrão de impressão já existente no sistema (`/vendas/[id]/imprimir`); zero dependência nova | Não é impressão silenciosa (exige interação do usuário no diálogo do navegador); não é ESC/POS nativo, depende do driver da impressora aceitar spool HTML/CSS |
| Geração de PDF no servidor + impressão via driver do SO | Formato mais previsível | Exige nova dependência (nenhuma lib de PDF existe hoje); ainda depende de driver de impressão local, não resolve "silenciosa" sozinho |
| Agente local (tipo QZ Tray) | Impressão silenciosa real, controle de corte/gaveta, compatível com ESC/POS | Infraestrutura inteiramente nova (nada existe hoje); exige instalar um agente na máquina Windows do PDV, fora do controle do navegador |
| WebUSB/WebSerial direto do navegador | Sem agente externo a instalar | Suporte de navegador mais restrito; nenhuma base de código existe hoje; maior esforço de implementação que o agente local |

**Requisitos mínimos recomendados**, independente da escolha final: bobina 80mm (padrão preferencial conforme já indicado), impressão automática após autorização (sem clique manual do operador), QR Code e demais elementos legalmente obrigatórios da NFC-e, compatibilidade com Windows + USB, fallback para reimpressão manual caso a impressão automática falhe (não pode travar a venda seguinte). A escolha entre agente local e página dedicada deve ser feita na Fase 3, após confirmar o modelo real da impressora (pergunta 11 em `fiscal-open-questions.md`) — impressoras térmicas mais simples aceitam spool HTML via driver Windows, o que tornaria a primeira opção (mais barata, reaproveita o padrão existente) viável sem agente adicional.

---

## 13. Integração com Nuvemshop (retorno da chave fiscal)

Hoje inexistente — `src/lib/integrations/nuvemshop.ts` só expõe chamadas a `products/*`, nunca a `orders/*`. Retornar a chave de acesso/NFC-e-NF-e para o pedido na Nuvemshop exigiria implementação nova, chamando os endpoints de pedido/fulfillment da API da Nuvemshop — não estimado em detalhe nesta fase, tratado como item de Fase 4.

---

## 14. RBAC Fiscal (menor alteração possível sobre o existente)

Reaproveitar integralmente `src/lib/auth/validateAuthorizationToken.ts` e o enum `authorization_tokens.action`, hoje com `cancel_sale`/`return_sale`/`exchange_sale` — adicionar `emit_fiscal_document`/`cancel_fiscal_document` seguindo exatamente o mesmo padrão (token de uso único, atômico, emitido por gerente/admin, consumido por `usuario`). Proposta de matriz:

| Ação | admin | gerente | usuario |
|---|---|---|---|
| Emitir | ✓ | ✓ | ✓ (sem token extra — emissão normal de venda) |
| Consultar situação | ✓ | ✓ | ✓ |
| Cancelar | ✓ (com justificativa obrigatória) | ✗ (por definição do escopo: "somente administrador poderá cancelar") | ✗ |

Isso é mais restritivo que o padrão hoje usado para cancelamento de venda (onde `gerente` também pode cancelar sem token) — é uma divergência deliberada, pois o escopo desta auditoria pede explicitamente que só administrador cancele documento fiscal. Avaliar na Fase 1 se isso deve reusar `requireRole('admin')` diretamente (mais simples, mais próximo do padrão RBAC já existente) em vez de token, já que a exigência é "só admin", não "usuario precisa de token de terceiro".
