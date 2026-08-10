# Auditoria — Integração Focus NFe

**Tipo:** auditoria técnica read-only, **nenhuma implementação feita**. Parte 1 (documentação oficial Focus NFe, `doc.focusnfe.com.br`) + Parte 2 (auditoria do ERP relevante para essa integração). Nenhum código, banco, migration, dependência, variável de ambiente ou infraestrutura foi alterado.

---

# Parte 1 — Documentação Oficial Focus NFe

Pesquisa feita em 2026-08-04, exclusivamente em `doc.focusnfe.com.br/reference/*`, via leitura direta do conteúdo renderizado de cada página (WebFetch + Browser pane onde necessário). Toda citação entre aspas é cópia literal do texto oficial. Onde algo não pôde ser confirmado na documentação acessada, está marcado explicitamente como tal — nenhum valor foi inventado.

## 1. Ambientes

| Ambiente | URL base |
|---|---|
| Homologação | `https://homologacao.focusnfe.com.br` |
| Produção | `https://api.focusnfe.com.br` |

Prefixo REST: `/v2`. Seleção de ambiente é **por subdomínio/host**, não por header/parâmetro. Fonte: `reference/ambiente`. *"Os documentos emitidos [em homologação] não têm validade fiscal nem tributária."*

## 2. Autenticação

Fonte: `reference/autenticacao`. **HTTP Basic (RFC 7617)**: *"Não há cabeçalho de API key separado: o token da empresa é enviado como usuário do Basic Auth e a senha fica em branco."* Exemplo oficial: `curl -u 'SEU_TOKEN_AQUI:' https://api.focusnfe.com.br/v2/empresas`. **Token distinto por ambiente** (homologação e produção têm tokens diferentes).

## 3. Referência única `ref`

Fonte: `reference/referencia`. Alfanumérica, sem caracteres especiais (acentos/espaços/`@`/`/`). **Única no escopo do token** (por empresa), não globalmente. Tamanho máximo: **não especificado**. Comportamento de reenvio: se a emissão falhar/rejeitar, a mesma `ref` pode em geral ser reenviada após correção; **uma vez autorizado o documento, aquela `ref` fica permanentemente vinculada a ele — não pode ser reusada para uma nova emissão, mesmo que o documento seja cancelado depois.** Isto é central para o desenho de idempotência (ver `focus-nfe-architecture-plan.md` §6).

## 4. Emissão de NFC-e

Fonte: `reference/emitir_nfce`. **`POST /v2/nfce`**, **síncrono** — *"a nota é autorizada ou rejeitada na mesma requisição"*. Numeração automática ou manual (`numero`/`serie` opcionais no corpo). Query params: `ref` (obrigatório), `completa` (0/1), `forma_emissao=offline` (contingência).

Campos de corpo (uso mais comum, lista completa em `campos.focusnfe.com.br/nfe/NotaFiscalXML.html`, **não lida nesta pesquisa** — pendência registrada): `cnpj_emitente` (req), `data_emissao` (req, tolerância de 5 min), `indicador_inscricao_estadual_destinatario`, `modalidade_frete` (req), `local_destino` (req), `presenca_comprador` (req), `natureza_operacao` (req, default "VENDA AO CONSUMIDOR"), `nome_destinatario`, `cnpj_destinatario`, `cpf_destinatario`, `items[]` (req), `formas_pagamento[]` (req), `numero`, `serie`, `codigo_unico` (contingência).

Resposta (201): `status` (`autorizado`|`erro_autorizacao`), `status_sefaz`, `mensagem_sefaz`, `chave_nfe`, `numero`, `serie`, `caminho_xml_nota_fiscal`, `caminho_danfe` (**formato .html**), `qrcode_url` (pronta, não precisa ser montada pelo ERP), `url_consulta_nf`, `contingencia_offline`, `contingencia_offline_efetivada`.

## 5. Consulta de NFC-e

Fonte: `reference/consultar_nfce`. **`GET /v2/nfce/{referencia}`** (`completa` opcional). `status` enum: `autorizado`, `erro_autorizacao`, `denegado`. Códigos: 200, 401, 403, 404.

## 6. Cancelamento de NFC-e

Fonte: `reference/cancelar_nfce`. **`DELETE /v2/nfce/{referencia}`**, síncrono. **Prazo: até 30 minutos após a emissão.** Payload: `justificativa` (obrigatório, **15–255 caracteres**). Resposta: `status`, `status_sefaz`, `mensagem_sefaz`, `caminho_xml_cancelamento`, `numero_protocolo`.

## 7. Emissão de NF-e

Fonte: `reference/emitir_nfe`. **`POST /v2/nfe`**. **Assíncrono por padrão** — *"a API confirma o recebimento da requisição e a nota segue em fila até o processamento. Quando permitido pelo estado e pela configuração da conta, a emissão pode ocorrer de forma síncrona"*. Acompanhamento via consulta ou webhook. Campos adicionais vs. NFC-e: `tipo_documento` (0/1, entrada/saída, não existe em NFC-e), `finalidade_emissao` (1-4, não existe em NFC-e), `consumidor_final`, dados completos de destinatário (endereço/IE/regime), `valor_frete`/`valor_seguro`/`valor_desconto`/`valor_outras_despesas`/`valor_total`/`valor_produtos`. `numero`/`serie` não estão listados como "uso comum" nesta página — **não confirmado se a numeração automática opcional da NFC-e também vale para NF-e**.

## 8. Consulta de NF-e

Fonte: `reference/consultar_nfe`. **`GET /v2/nfe/{referencia}`**. `status: "autorizado"` ou `"processando_autorizacao"`.

## 9. Cancelamento de NF-e

Fonte: `reference/cancelar_nfe`. **`DELETE /v2/nfe/{referencia}`**, síncrono. **Prazo: até 24 horas** (*"alguns estados podem permitir um prazo maior"*). Payload: `justificativa` (15–255 caracteres). `status`: `cancelado`|`erro_cancelamento`.

## 10. Webhooks

Fontes: `reference/webhooks`, `reference/criar_webhook`. POST JSON para URL própria a cada evento. **Retry documentado com intervalos exatos: 1 minuto, 30 minutos, 1 hora, 3 horas, 24 horas** — depois disso, não tenta mais. Criação: `POST /v2/hooks` com `cnpj`/`cpf`, `event`, `url`, `authorization`, `authorization_header`.

**Eventos:** `nfe`, `nfse`, `nfsen`, `nfce_contingencia`, `nfe_recebida`, `nfe_recebida_falha_consulta`, `nfse_recebida`, `cte_recebida`, `inutilizacao`, `cte`, `mdfe`, `nfcom`, `nfsen_recebida`, `dce`. **Não existe evento `nfce` puro** — só `nfce_contingencia`, coerente com a emissão normal de NFC-e ser 100% síncrona.

**Segurança do webhook:** não há HMAC nem assinatura automática — só o par `authorization`/`authorization_header` que você define na criação, ecoado pela Focus a cada chamada, para validação manual da origem. **Mais fraco do que uma assinatura HMAC real** — precisa de desenho próprio de verificação (ver `focus-nfe-architecture-plan.md` §7).

**Payload exato do webhook recebido: não confirmado nesta pesquisa** — a página descreve o mecanismo, não mostra um exemplo de corpo.

## 11. Reenvio de webhook

Fonte: `reference/reenviar_hook_nfe` (e equivalentes para outros documentos). `POST /nfe/{referencia}/hook`. **Não existe endpoint de reenvio listado para NFCe** — coerente com NFC-e não ter webhook de emissão normal (só contingência). Não há histórico de entregas (sucesso/falha por tentativa) exposto pela API — `GET /hooks`/`GET /hooks/{id}` só retornam a configuração do gatilho, não um log.

## 12. Contingência offline de NFC-e

Fontes: `reference/emitir_nfce`, `reference/comunicador`. Dois níveis: (a) na própria API cloud, via `forma_emissao=offline` + `numero`/`serie`/`codigo_unico` manuais; (b) **"Comunicador Offline"** — **aplicação desktop separada**, não é parte da API REST — para quando o PDV não tem acesso à API via internet. Funciona por diretórios monitorados (JSON gravado em pasta, processado localmente) e expõe API local própria (`Emitir`/`Cancelar`/`Consultar NFCe`, gerar espelho PDF, gerar XML autorizado/cancelado, listar pendentes, efetivar em contingência). **Achado relevante para arquitetura:** este é um componente de infraestrutura adicional (software instalado no Windows do PDV), não coberto pela abstração `FiscalProvider` proposta em `focus-nfe-architecture-plan.md` sem investigação própria — registrado como item a avaliar na Entrega de contingência, não decidido aqui.

## 13. Retorno de XML

`caminho_xml_nota_fiscal` — descrito só como *"Caminho para download do XML"*, **não é base64 nem XML embutido**. **Não confirmado como resolver esse caminho em URL completa/baixável** nas páginas de emissão/consulta. Por contraste, o endpoint de backups (`reference/consultar_backups_por_cnpj`) retorna URLs S3 completas — mas backups é um endpoint diferente, não confirma o comportamento de `caminho_xml_nota_fiscal`. **Ação necessária antes de codificar:** confirmar isso com uma chamada real em homologação (primeiro spike, ver seção final deste documento).

## 14. Retorno de DANFE/DANFCe

**NFC-e: `caminho_danfe` é HTML (.html), confirmado explicitamente.** **NF-e: formato não confirmado** (a página não especifica PDF vs. HTML para o documento já autorizado — só existe um endpoint separado de pré-visualização, `POST /nfe/danfe`, que devolve PDF mas é explicitamente sem valor fiscal, não é o DANFE do documento autorizado).

**Achado arquitetural favorável, não esperado:** o DANFCe da Focus já vem em HTML — exatamente o formato que a única infraestrutura de impressão hoje existente no ERP (`window.print()`, `src/app/(dashboard)/vendas/[id]/imprimir/*`, achado A4 do registro de riscos) já sabe processar. Isso reduz significativamente o trabalho da Entrega de impressão em relação ao que seria necessário numa integração direta com a SEFAZ (que exigiria montar o DANFE do zero, `pdfkit`/`playwright`, conforme `fiscal-crypto-security-plan.md`).

## 15. QR Code

`qrcode_url` — **URL pronta, retornada pela Focus.** O ERP não monta os dados do QR Code manualmente (diferente da integração direta, onde isso seria responsabilidade do ERP conforme o Manual de Padrões Técnicos do DANFE-NFC-e/QR Code v6.0, já pesquisado em `svrs-services-endpoints.md`).

## 16. Numeração automática vs. controlada

**NFC-e:** confirmado, ambos os modos suportados — automático (omitir `numero`/`serie`) ou manual (informar os dois). **NF-e:** não confirmado se o mesmo vale — a página não repete essa afirmação nem lista os campos como opcionais explicitamente.

## 17. Códigos de resposta HTTP

| Código | Significado documentado |
|---|---|
| 200 | Sucesso (consulta; cancelamento concluído) |
| 201 | Recurso criado (NFC-e autorizada; NF-e autorizada em modo síncrono) |
| 202 | NF-e em processamento (modo assíncrono) |
| 400 | Requisição inválida |
| 401 | Não autorizado |
| 403 | Ação não permitida / CNPJ não autorizado |
| 404 | Recurso não encontrado |
| 415 | `Content-Type` não suportado |
| 422 | Requisição entendida, dados inválidos/não processáveis |

**Formato do corpo de erro para 400/401/403/422 (campo `erro`/`mensagem` estruturado): não confirmado.**

## 18. Formato de status

Consistente entre operações: `status` (enum por operação), `status_sefaz` (código numérico, ex. `"100"`), `mensagem_sefaz` (texto, ex. `"Autorizado o uso da NF-e"`).

## Itens não confirmados nesta pesquisa (para não inventar)

1. Tamanho máximo de `ref`.
2. Payload JSON exato recebido no webhook.
3. Resolução de `caminho_xml_nota_fiscal`/`caminho_danfe` em URL completa.
4. Formato do DANFE de NF-e autorizada (PDF vs. HTML).
5. Se NF-e também aceita numeração automática opcional.
6. Existência de reenvio/histórico de webhook para NFC-e.
7. Formato estruturado do corpo de erro (400/401/403/422).
8. Se 422 se aplica a `cancelar_nfe` (confirmado só em `emitir_nfce`/`emitir_nfe`).
9. Modelo de custódia do certificado digital com a Focus (upload para a plataforma deles vs. outro modelo) — **não pesquisado nesta rodada**, relevante para `focus-nfe-architecture-plan.md` §7 (segurança) — tratado como pendência explícita, não presumido.

**Todos os itens acima devem ser confirmados com uma chamada real em homologação (primeiro spike recomendado, ver `focus-nfe-implementation-phases.md`) antes de fechar o desenho definitivo do payload de `FocusNFeProvider`.**

---

# Parte 2 — Auditoria do ERP (relevante à integração Focus)

Toda esta seção é conhecimento já verificado em rodadas anteriores desta mesma auditoria (citações completas com `arquivo:linha` em `fiscal-audit-report.md` e documentos subsequentes) — reorganizada aqui especificamente para o gap analysis de `focus-nfe-field-mapping.md`.

## Finalização de venda
`src/app/(dashboard)/vendas/nova/page.tsx` (wizard 4 passos) → `POST /api/vendas` (`src/app/api/vendas/route.ts`) → `src/services/vendas.service.ts:createSale()` → RPC `rpc_create_sale` (versão vigente de 16 parâmetros, `supabase/migrations/20260704_fix_cashback_expiry_and_earn.sql`). Venda nasce com `status='paid'` diretamente.

## `sales`, `sale_items`, `sale_payments`
Schema completo já confirmado por consulta real ao banco (`fiscal-database-validation-results.md`). `sales`: `sale_number`, `customer_id`, `subtotal`, `discount_amount`, `surcharge_amount`, `shipping_charged`, `cashback_used`, `total`, `payment_method`, `sale_origin`, `sale_date`, `company_id`, `cancelled_at/by`, `returned_at/by`. `sale_items`: `product_variation_id`, `quantity`, `unit_price`, `unit_cost`, `discount_amount`, `total_price`. `sale_payments`: `method` (enum `pix|card|cash|credit_card|debit_card`), `card_brand` (texto livre), `acquirer` (texto livre), `installments`, `net_amount`, `metadata` (JSONB não populado hoje).

## Múltiplas formas de pagamento
Suportado — array `payments[]`, uma linha por método em `sale_payments`. **Sem reconciliação server-side** de que a soma bate com `sales.total` (achado M2 do registro de riscos) — relevante porque a Focus exige `formas_pagamento[]` no payload de emissão, e essa reconciliação precisará existir na camada de tradução ERP→Focus, já que não existe hoje na camada de venda.

## Clientes com e sem CPF
`customers.cpf` é **nullable**. Padrão de "cliente avulso": uma linha real e dedicada (`is_anonymous=true`), não um `customer_id` nulo em `sales` (que é `NOT NULL`). Zero suporte a CNPJ/PJ. Para a Focus, isso significa: NFC-e para consumidor final sem CPF é suportado nativamente pelo fluxo atual (basta não enviar `cpf_destinatario`), mas qualquer emissão de NF-e para CNPJ (Entrega I) está bloqueada até `customers` ser estendida.

## Produtos, variações e dados fiscais
`products.ncm`/`cest`/`origem`/`unidade_med` existem, **nullable, sem CHECK constraint**, incompletos para parte do catálogo (flag de qualidade de dado já existente, `product_no_ncm`). **CFOP/CST/CSOSN/GTIN inexistentes** em qualquer lugar do schema — confirmado por grep exaustivo em ambas as árvores de migration. Isto é o maior bloqueador de dado para o payload `items[]` da Focus, que presumivelmente exige código fiscal por item (campo exato não confirmado, ver Parte 1 item 4 — pendência de leitura de `campos.focusnfe.com.br`).

## Cancelamento de venda
`rpc_cancel_sale`/`rpc_return_sale` (`supabase/migrations/20260722_rpc_cancel_return_sale_no_finance_entry.sql`) — transacional, bloqueia re-cancelamento. **Não integrado a nenhum conceito fiscal hoje** — cancelar uma venda no ERP não tem nenhuma relação com cancelar um documento fiscal na Focus; essa integração é inteiramente nova (Entrega E). Ponto de atenção direto do prazo da Focus: **NFC-e só pode ser cancelada em até 30 minutos** — bem mais curto que qualquer janela de cancelamento de venda hoje existente no ERP (não há limite de tempo para `rpc_cancel_sale`), então a UI precisa comunicar claramente quando esse prazo já passou e a venda só pode ser estornada por outro meio (nota complementar/devolução), não por cancelamento do documento fiscal.

## Permissões admin/vendedor
RBAC real de 3 níveis (`admin` > `gerente` > `usuario`), confirmado por consulta real ao banco (só 2 `admin` e 1 `usuario`/`seller`, **zero `gerente`** hoje). Mecanismo de elevação via `authorization_tokens` para `cancel_sale`/`return_sale`/`exchange_sale`. Já recomendado (`fiscal-architecture-proposal.md` §14) estender esse mesmo padrão para `emit_fiscal_document`/`cancel_fiscal_document`, restrito a `admin` — reforçado agora pelo prazo curto de cancelamento da Focus (30 min), que não deixa margem para um fluxo de aprovação lento.

## Integração Nuvemshop
Webhook inbound único (`src/app/api/webhooks/nuvemshop/order/route.ts`), HMAC-SHA256 verificado, chama a mesma `rpc_create_sale`. Tabela `pedidos` tem uma coluna órfã `nf_status` (achado novo, não usada por nenhum código, não documentada em nenhuma migration — ver `fiscal-database-validation-results.md` §1) — **candidata natural a ser reaproveitada** (ou formalmente descontinuada) para rastrear o status de emissão fiscal de pedidos vindos da Nuvemshop, decisão a tomar na Entrega B.

## Webhooks existentes
Só o inbound da Nuvemshop tem verificação HMAC real. Webhooks outbound (N8N, `sendSaleWebhook`/`sendSaleWebhookV2`) **não são assinados** — fire-and-forget com log de idempotência (`webhook_log`, `post_sale_automation_events`). **Nenhum padrão de recepção de webhook assinado existe hoje** — relevante porque a Focus não oferece HMAC (só um header de autorização configurável, Parte 1 item 10), então o endpoint que a Santtorini expor para receber webhooks da Focus (evento `nfce_contingencia`, e futuramente `nfe`) precisa de desenho próprio de verificação, não pode reaproveitar a verificação HMAC do Nuvemshop (mecanismo diferente).

## Storage
Padrão maduro e reaproveitável: `src/services/media.service.ts` — bucket privado, chave `{companyId}/{uuid}.{ext}`, nunca sequencial, checksum SHA-256, signed URL de 5 minutos para privado. **Diretamente aplicável** ao armazenamento do XML/DANFCe retornado pela Focus — a única diferença é que agora o "arquivo" vem de uma URL/caminho externo (Focus), não de um upload do usuário, então o fluxo de gravação precisa buscar o conteúdo da Focus primeiro (uma vez resolvida a pendência da Parte 1 item 13), depois gravar no Storage próprio — nunca confiar exclusivamente no armazenamento da Focus como única cópia (mesmo princípio já registrado em `fiscal-architecture-proposal.md` §8).

## Logs e auditoria
`audit_logs` (plural) — genérico, reutilizável, já usado pela aplicação. `audit_log` (singular) — tabela órfã, não usada, com RLS aberta (achado crítico já registrado, correção pendente em `rls-open-policies-remediation-plan.md`). Reaproveitar `audit_logs`, nunca a singular.

## Jobs e processamento assíncrono
3 rotas HTTP-cron (`CRON_SECRET` bearer): `cashback-release`, `cashback-expire`, `refresh-views`. **Sem fila/worker persistente** (nenhum Redis/BullMQ). Relevante para a Focus: como NF-e é assíncrona por padrão (Parte 1 item 7), acompanhar o status até a autorização final exige ou (a) consultar periodicamente via um job novo no mesmo padrão HTTP-cron, ou (b) depender do webhook `nfe` — **recomendação: usar ambos** (webhook como caminho principal, job de consulta periódica como rede de segurança, mesmo padrão de "enforcement primário + limpeza best-effort" já usado em `cashback-expire`).

## Infraestrutura atual de impressão
Só `window.print()` para etiquetas de envio A4 — zero infraestrutura térmica/DANFE. **Mas, como já destacado na Parte 1 item 14, o DANFCe da Focus já vem em HTML** — isso significa que a Entrega F (impressão) para a via Focus pode ser dramaticamente mais simples do que estava planejada para a via SEFAZ direta: reaproveitar o padrão de página dedicada + `window.print()` já existente, apontando para o HTML retornado pela Focus (possivelmente incorporado num template próprio ou usado como veio), em vez de construir renderização de PDF do zero.

---

Ver [`focus-nfe-field-mapping.md`](focus-nfe-field-mapping.md) para o gap analysis campo a campo, e [`focus-nfe-architecture-plan.md`](focus-nfe-architecture-plan.md) para a arquitetura proposta.
