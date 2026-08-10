# Plano por Entregas — Integração Focus NFe

**Tipo:** plano executável por entregas, **não implementado**. Estrutura paralela a `fiscal-direct-implementation-phases.md` (via SEFAZ direta), mas **significativamente mais simples** a partir da Entrega C — a Focus abstrai inteiramente XML, XSD, XMLDSig, mTLS e custódia de certificado, então essa complexidade inteira (que ocupava as Entregas C/spike técnico da via direta) desaparece aqui.

**Complexidade relativa por entrega** (estimativa qualitativa, não em horas — depende de dados ainda não disponíveis: catálogo fiscal completo, confirmação da contabilidade):

| Entrega | Complexidade | Comparação com a via direta (SEFAZ/SVRS) |
|---|---|---|
| A | Média | Idêntica — é trabalho interno, independente do provedor |
| B | Baixa-Média | Similar, schema já desenhado, só adaptado |
| C | **Baixa** | **Muito mais simples** — sem certificado/XML/SOAP/mTLS, só HTTP Basic + JSON |
| D | Média | Mais simples — sem montagem/validação/assinatura de XML manual |
| E | Baixa | Similar |
| F | **Baixa** | **Muito mais simples** — DANFCe já vem em HTML pronto |
| G | Média | Similar, mas parte da complexidade (Comunicador Offline) é nova e específica da Focus |
| H | Média | Similar |
| I | Média-Alta | Similar — depende de regras de negócio (CFOP interestadual, PJ), não do provedor |

---

## Entrega A — Saneamento interno e RLS

Idêntica à Entrega A de `fiscal-direct-implementation-phases.md` — não repetida aqui em detalhe. **Pré-requisito de ambas as vias, não depende da escolha de provedor.**

---

## Entrega B — Fundação do domínio fiscal (adaptada para múltiplos provedores)

| | |
|---|---|
| **Pré-requisitos** | Entrega A (padrão de RLS validado); CRT confirmado pela contabilidade |
| **Arquivos** | `src/types/fiscal.types.ts` (tipos espelhando o schema) |
| **Migrations** | Mesmas tabelas de `fiscal-architecture-proposal.md` §2, com os ajustes de `focus-nfe-architecture-plan.md` §5: `fiscal_establishments.provider`/`provider_credentials_ref`; `fiscal_documents.provider`/`provider_reference`/`request_snapshot`/`response_snapshot` + `UNIQUE(provider, provider_reference)`. RLS company-scoped desde a primeira migration |
| **Testes** | Schema/constraint/RLS, mesmo padrão da Entrega A |
| **Riscos** | Mesmos da Entrega B da via direta |
| **Rollback** | `DROP TABLE` — nada depende ainda |
| **Critério de aceite** | Schema criado, RLS testado, suporta `provider='focus_nfe'` desde o início (mesmo que `'svrs_direct'` nunca seja usado de fato) |

---

## Entrega C — Integração básica com a Focus NFe

| | |
|---|---|
| **Pré-requisitos** | Entrega B; **cadastro da empresa no painel Focus NFe e token de homologação obtidos (Fase 0 externa, fora deste plano)**; confirmação das pendências da Parte 1 de `focus-nfe-integration-audit.md` (especialmente: resolução de URL de XML/DANFE, formato de payload de webhook) — **primeiro spike recomendado** (ver seção final) |
| **Arquivos** | `src/services/fiscal/provider/types.ts`, `focus/FocusNFeProvider.ts`, `focus/httpClient.ts` (Basic Auth + seleção de ambiente por host), `focus/parseResponse.ts`, `focus/resolveAssetUrls.ts` — implementando só uma chamada simples de verificação (ex. `GET /v2/empresas`, conforme exemplo oficial de autenticação) nesta entrega, não emissão ainda |
| **Migrations** | Nenhuma nova — `fiscal_credentials`/`fiscal_establishments.provider_credentials_ref` recebem o token real (dado, não schema) |
| **Testes** | Chamada real de autenticação em homologação; testes unitários de `httpClient` com mock |
| **Riscos** | Baixo — é só HTTP + Basic Auth, sem as complexidades de certificado/XML da via direta |
| **Rollback** | Nenhuma rota chama isso em produção ainda — remover arquivos sem impacto |
| **Critério de aceite** | Chamada autenticada de teste bem-sucedida contra `homologacao.focusnfe.com.br`; pendências críticas da Parte 1 (resolução de URL de XML/DANFE, payload do webhook) confirmadas nesta entrega, não adiadas |

---

## Entrega D — NFC-e mínima em homologação

| | |
|---|---|
| **Pré-requisitos** | Entrega C; cadastro fiscal mínimo (NCM/CFOP/CST-CSOSN) para os produtos de teste, conforme os bloqueadores 🔴 listados em `focus-nfe-field-mapping.md`; decisão tomada sobre representação de cashback no payload (pendência crítica registrada no mapeamento) |
| **Arquivos** | `emitDocument.ts`, `buildSnapshot.ts` (reaproveitado), `buildNfcePayload.ts`, `src/app/api/fiscal/documents/route.ts`, botão "Emitir NFC-e" na tela de venda |
| **Migrations** | Nenhuma nova |
| **Testes** | Os testes de "Homologação Focus" de `focus-nfe-test-plan.md` — item único, múltiplos itens, desconto, múltiplos pagamentos, CPF ausente |
| **Riscos** | Mapeamento de campo incorreto causando rejeição (mitigado pela validação do passo 3 do fluxo, `focus-nfe-nfce-flow.md`) |
| **Rollback** | Feature flag desativando o botão — PDV inalterado |
| **Critério de aceite** | Pelo menos 10 notas de teste autorizadas em homologação via Focus, cobrindo os cenários do plano de testes |

---

## Entrega E — Consulta e cancelamento

| | |
|---|---|
| **Pré-requisitos** | Entrega D estável |
| **Arquivos** | `consultNfce`/`cancelNfce` implementados no `FocusNFeProvider`; rota `POST /api/fiscal/documents/[id]/cancelar` (`admin` apenas); **UI de coordenação entre cancelamento de venda e cancelamento de documento fiscal** (ponto em aberto identificado em `focus-nfe-nfce-flow.md`, resolvido nesta entrega) |
| **Migrations** | Nenhuma nova |
| **Testes** | Cancelamento dentro e fora do prazo de 30 minutos, consulta de nota autorizada |
| **Riscos** | Prazo de 30 minutos é curto — UI precisa comunicar isso claramente para não gerar frustração operacional |
| **Rollback** | Reverter `fiscal_documents.status` manualmente, documentado antes |
| **Critério de aceite** | Cancelamento e consulta funcionando em homologação, coordenação com cancelamento de venda desenhada e testada |

---

## Entrega F — DANFCe e impressão

| | |
|---|---|
| **Pré-requisitos** | Entrega D; modelo de impressora térmica confirmado com a Santtorini (pergunta 11 de `fiscal-open-questions.md`) |
| **Arquivos** | Página de exibição do DANFCe (HTML já vindo da Focus, reaproveitando o padrão `window.print()` existente em `src/app/(dashboard)/vendas/[id]/imprimir/*`) — **muito mais simples que a via direta**, que exigiria `pdfkit`/`playwright` |
| **Migrations** | Nenhuma — `fiscal_files` já existe |
| **Testes** | DANFCe impresso é legível em bobina 80mm; QR Code (`qrcode_url`, já pronto pela Focus) escaneável e resolve para a consulta pública correta |
| **Riscos** | Baixo — a Focus já resolve a montagem do QR Code e do layout, ao contrário da via direta |
| **Rollback** | Reverter para impressão manual da chave de acesso |
| **Critério de aceite** | Cupom impresso automaticamente após autorização (ou manualmente, v1), QR Code válido |

---

## Entrega G — Contingência

| | |
|---|---|
| **Pré-requisitos** | Entregas D e E; **decisão de negócio sobre a necessidade do "Comunicador Offline"** (aplicação desktop separada da Focus, ver `focus-nfe-integration-audit.md` Parte 1 item 12) vs. só `forma_emissao=offline` via API cloud |
| **Arquivos** | Lógica de detecção de indisponibilidade + fluxo de contingência; indicador de documentos pendentes na UI |
| **Migrations** | Nenhuma — `fiscal_documents.status='contingency'` já suportado |
| **Testes** | Simular indisponibilidade, confirmar que a venda continua e o documento regulariza depois |
| **Riscos** | Se o "Comunicador Offline" for necessário, é uma peça de infraestrutura nova (software instalado no Windows do PDV) não avaliada em profundidade nesta pesquisa |
| **Rollback** | Nenhum |
| **Critério de aceite** | Cenário de indisponibilidade testado ponta a ponta |

---

## Entrega H — Produção controlada da NFC-e

| | |
|---|---|
| **Pré-requisitos** | Mesmos pré-requisitos absolutos já listados em `fiscal-implementation-plan.md` Fase 5 (homologação validada pela contabilidade, credenciamento confirmado, autorização expressa da Santtorini) + **token de produção da Focus obtido** + Entrega A 100% concluída (RLS) |
| **Arquivos** | Nenhum novo — `fiscal_establishments.ambiente_producao_habilitado=true` |
| **Migrations** | Nenhuma |
| **Testes** | Piloto com poucas vendas reais |
| **Riscos** | Mesmos da via direta — rejeição em massa por cadastro incompleto |
| **Rollback** | Plano definido antes do piloto |
| **Critério de aceite** | Mesmo critério da via direta — número mínimo de vendas reais emitidas com sucesso, taxa de rejeição aceitável |

---

## Entrega I — NF-e modelo 55

| | |
|---|---|
| **Pré-requisitos** | Entrega H estável; suporte PJ em `customers`; **confirmar se NF-e da Focus aceita numeração automática como a NFC-e (pendência #5 da Parte 1)**; decisão sobre webhook `nfe` vs. polling para acompanhar emissão assíncrona |
| **Arquivos** | `buildNfePayload.ts`, tratamento do fluxo assíncrono (webhook + job de reconciliação, `focus-nfe-architecture-plan.md` §6) |
| **Migrations** | `fiscal_document_series` para modelo `'55'`; extensão de `customers` para PJ (se ainda não feita) |
| **Testes** | Emissão de teste NF-e em homologação, venda para CNPJ, venda interestadual |
| **Riscos** | Regras de CFOP/DIFAL interestadual ainda não mapeadas com a contabilidade — bloqueador direto |
| **Rollback** | Nenhum — NFC-e continua funcionando independentemente |
| **Critério de aceite** | NF-e autorizada em homologação, depois piloto controlado |

---

## Primeiro spike recomendado

**Não é o mesmo spike de 12 passos da via direta** (`fiscal-technical-spike-plan.md`) — aquele continua relevante só se/quando a Santtorini migrar para `SvrsDirectProvider` no futuro. Para a via Focus, o primeiro spike recomendado é **muito mais curto**:

1. Obter token de homologação (Fase 0 externa).
2. Chamar `GET /v2/empresas` (ou equivalente) só para confirmar autenticação HTTP Basic funcionando.
3. Emitir **uma única** NFC-e de teste com dados mínimos (produto de teste com NCM/CFOP/CST preenchidos manualmente, mesmo que fictícios de teste), sem nenhuma integração com o domínio de vendas ainda — script isolado, não uma rota do PDV.
4. **Resolver as duas pendências mais críticas da Parte 1**: como `caminho_xml_nota_fiscal`/`caminho_danfe` viram URL completa, e qual é o formato real do corpo de um webhook recebido (configurar um webhook de teste apontando para um endpoint temporário/`webhook.site`-like só para observar o payload real, nunca para produção).
5. Confirmar na prática se uma `ref` rejeitada pode ser reenviada com sucesso após correção (teste deliberado de rejeição seguida de correção).

Este spike é suficiente para fechar a maior parte das pendências "não confirmado" desta auditoria antes da Entrega D começar de verdade.

**Nenhuma entrega foi iniciada.**
