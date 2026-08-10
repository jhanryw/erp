# Plano por Entregas — Integração Direta SEFAZ (NFC-e prioritária, depois NF-e)

**Tipo:** plano executável por entregas, **não implementado**. Substitui/detalha, para a via de integração direta, o plano de fases genérico já existente em [`fiscal-implementation-plan.md`](fiscal-implementation-plan.md) (que continua válido como visão macro — Fase 0 a Fase 5). Cada entrega abaixo é a granularidade real de execução. Nenhuma entrega foi iniciada.

**Regra de avanço, reafirmada:** cada entrega só começa mediante autorização própria, apresentando antes a lista exata de arquivos, migrations, riscos e testes — o que este documento já adianta, mas a autorização de execução é separada, entrega por entrega, nunca em lote.

---

## Entrega A — Saneamento interno e RLS

| | |
|---|---|
| **Pré-requisitos** | Nenhum — pode começar imediatamente, independente de qualquer decisão fiscal |
| **Arquivos** | Nenhum arquivo de aplicação novo. Consultas `pg_get_functiondef`/`pg_get_triggerdef` (já prontas em `database-functions-live-analysis.md`) precisam ser executadas primeiro, para fechar as perguntas de `trigger_generate_cashback`/`set_sale_number` antes de decidir se há correção de função a incluir aqui |
| **Migrations** | `DROP POLICY`/`CREATE POLICY` por tabela, seguindo exatamente a ordem já definida em `rls-open-policies-remediation-plan.md` §3; opcionalmente, se autorizado separadamente, a correção isolada de `products_total` (`products-total-remediation-plan.md`) — **não depende desta entrega, mas pode ser feita na mesma janela de manutenção por conveniência** |
| **Testes** | Testes por perfil (`admin`/`gerente`/`usuario`/anônimo) e teste de isolamento entre empresas, ambos já detalhados em `rls-open-policies-remediation-plan.md` §4-5 |
| **Riscos** | Já classificados em `rls-open-policies-remediation-plan.md` §6 (PDV/telas de estoque podem quebrar se a policy nova for restritiva demais) |
| **Rollback** | Restaurar a policy removida com o texto exato já capturado (§7 do mesmo documento) |
| **Critério de aceite** | Nova consulta `pg_policies` confirma zero policy `USING(true)` nas 16 tabelas listadas; nenhuma tela do PDV/estoque quebrada; corpo de `trigger_generate_cashback`/`set_sale_number` lido e status de risco fechado (confirmado como seguro, ou corrigido) |

---

## Entrega B — Fundação do domínio fiscal

| | |
|---|---|
| **Pré-requisitos** | Entrega A com RLS corrigido nas tabelas mais críticas (não precisa das 16 completas, mas o padrão de policy correto já deve estar validado, para não repetir o erro nas tabelas novas); CRT confirmado pela contabilidade (`fiscal-accounting-checklist.md`); Fase 0 minimamente avançada (credenciamento SEFAZ/RN em andamento, certificado de homologação obtido) |
| **Arquivos** | Nenhum código de aplicação ainda — só schema. Tipos TypeScript (`src/types/fiscal.types.ts`) espelhando o schema, sem lógica |
| **Migrations** | Criação de `fiscal_establishments`, `fiscal_credentials`, `fiscal_document_series`, `fiscal_documents`, `fiscal_document_items`, `fiscal_document_payments`, `fiscal_document_events`, `fiscal_transmission_attempts`, `fiscal_tax_profiles`, `fiscal_operation_rules`, `fiscal_files`, `fiscal_webhook_deliveries` (conforme `fiscal-architecture-proposal.md` §2, revisado para incluir `fiscal_documents.schema_version` per `fiscal-xsd-versioning-plan.md`) — **cada uma já nasce com RLS habilitado e policy company-scoped desde a primeira migration, nunca `USING(true)`, seguindo o padrão corrigido na Entrega A** |
| **Testes** | Testes de schema: constraints, FKs, RLS de isolamento entre empresas nas tabelas novas (mesmo teste da Entrega A, aplicado às tabelas novas) |
| **Riscos** | Repetir o erro de RLS por hábito/copy-paste de uma migration antiga como modelo — mitigado por revisão explícita contra este risco antes do merge; desenho de schema precisar de ajuste logo depois de usado na prática (normal, mas registrar) |
| **Rollback** | `DROP TABLE` das tabelas novas — nada em produção depende delas ainda |
| **Critério de aceite** | Todas as tabelas criadas, RLS testado e correto desde o nascimento, nenhuma tabela existente (`sales`, `products` etc.) alterada |

---

## Entrega C — StatusServico e infraestrutura criptográfica

| | |
|---|---|
| **Pré-requisitos** | Entrega B; certificado A1 de homologação obtido e carregável; **spike técnico (`fiscal-technical-spike-plan.md`) concluído com sucesso** — esta entrega essencialmente formaliza o spike em código de produção do módulo |
| **Arquivos** | `src/services/fiscal/gateway/types.ts`, `svrs/SvrsFiscalGateway.ts`, `svrs/soapClient.ts`, `svrs/certificateLoader.ts`, `svrs/endpoints.ts`, `svrs/parseResponse.ts` (estrutura completa já proposta em `sefaz-direct-integration-plan.md`) — implementando **só** `getServiceStatus()` nesta entrega, os outros métodos da interface ficam com stub/`not implemented` até as entregas seguintes |
| **Migrations** | Nenhuma nova — `fiscal_credentials` (já criada na B) recebe o primeiro registro real (dado, não schema) |
| **Testes** | Unitários com mocks das libs; integração real contra `NfeStatusServico`/`NFeStatusServico` de homologação (NF-e e NFC-e, hosts diferentes conforme `svrs-services-endpoints.md`) |
| **Riscos** | Os já documentados em `fiscal-crypto-security-plan.md` (CVE `node-forge`, cadeia intermediária mTLS, formato PFX) |
| **Rollback** | Nenhuma rota chama isso ainda em produção — reverter é remover os arquivos, sem impacto |
| **Critério de aceite** | `getServiceStatus('homologacao', '65')` retorna `cStat=107` (ou código de disponibilidade documentado) de forma confiável e repetível, para NF-e e NFC-e |

---

## Entrega D — NFC-e mínima em homologação

| | |
|---|---|
| **Pré-requisitos** | Entrega C; cadastro fiscal mínimo completo para os produtos usados no teste (NCM/CEST/origem/unidade, Fase 2 de `fiscal-implementation-plan.md`, ao menos para o subconjunto de teste); `xmlBuilder.ts`/`xsdValidator.ts`/`xmlSigner.ts` prontos (spike passos 5-8 formalizados) |
| **Arquivos** | `src/services/fiscal/emitDocument.ts`, `buildSnapshot.ts`, `src/app/api/fiscal/documents/route.ts` (novo endpoint, `POST`, `requireRole('usuario')` conforme `fiscal-architecture-proposal.md` §14), botão manual "Emitir NFC-e" na tela de detalhe da venda (`src/app/(dashboard)/vendas/[id]/page.tsx`, adição pontual, sem alterar o fluxo de criação de venda em si) |
| **Migrations** | Nenhuma nova além da B |
| **Testes** | Emissão de teste completa e repetida em homologação, cobrindo: item único, múltiplos itens, desconto, frete, cashback (confirmar que não entra em `vProd`, conforme já desenhado) |
| **Riscos** | Numeração/série de homologação colidir com uso concorrente (mitigado pelo desenho de reserva transacional já proposto); erro de leiaute (mitigado pela validação XSD antes do envio) |
| **Rollback** | Feature flag desativando o botão de emissão — PDV continua funcionando normalmente sem nenhuma dependência do módulo fiscal |
| **Critério de aceite** | Pelo menos 10 notas de teste autorizadas (`cStat=100`) em homologação, sem nenhuma intervenção manual de correção de XML entre uma tentativa e outra |

---

## Entrega E — Consulta, cancelamento e inutilização

| | |
|---|---|
| **Pré-requisitos** | Entrega D concluída e estável |
| **Arquivos** | Implementação de `consult()`, `cancel()`, `invalidate()` no `SvrsFiscalGateway`; rotas `POST /api/fiscal/documents/[id]/cancelar` (`requireRole('admin')`, conforme já decidido em `fiscal-architecture-proposal.md` §14 — só admin, não gerente) e `POST /api/fiscal/series/[id]/inutilizar` |
| **Migrations** | Nenhuma nova — `fiscal_document_events` (já criada na B) passa a ser populada |
| **Testes** | Cancelar uma nota de teste dentro do prazo, tentar cancelar fora do prazo (deve rejeitar), inutilizar uma faixa de numeração de teste não usada |
| **Riscos** | Justificativa de cancelamento abaixo do mínimo de caracteres exigido pelo leiaute (validar antes de enviar, não deixar a SEFAZ rejeitar); prazo de cancelamento não confirmado nesta pesquisa — reconfirmar no MOC 7.0 Anexo I antes desta entrega |
| **Rollback** | Reverter `fiscal_documents.status` manualmente via função administrativa, documentado passo a passo antes da entrega (não durante um incidente) |
| **Critério de aceite** | Consulta, cancelamento e inutilização funcionando em homologação, com trilha completa em `fiscal_document_events` |

---

## Entrega F — DANFE NFC-e e impressão

| | |
|---|---|
| **Pré-requisitos** | Entrega D concluída (precisa de XML autorizado real para desenhar/testar o layout contra dado real, não só a especificação); **bloqueador a resolver antes**: confirmar manualmente a URL de consulta pública de NFC-e do RN (achado da pesquisa: `nfce.set.rn.gov.br` apresentou erro de certificado TLS, ver `svrs-services-endpoints.md` §9) |
| **Arquivos** | `src/services/fiscal/danfe/renderNfce.ts` (`pdfkit`), geração do QR Code (`qrcode`), decisão final de estratégia de impressão (página dedicada `window.print()` vs. agente local — avaliação já estruturada em `fiscal-architecture-proposal.md` §12, decisão real acontece aqui após confirmar o modelo de impressora com a Santtorini, pergunta 11 de `fiscal-open-questions.md`) |
| **Migrations** | Nenhuma nova — `fiscal_files` (já criada na B) recebe o DANFE gerado |
| **Testes** | DANFE gerado comparado visualmente contra o Manual de Padrões Técnicos do DANFE-NFC-e v6.0; QR Code testado contra a URL de consulta pública confirmada como funcional |
| **Riscos** | Se a URL de consulta pública não for corrigida a tempo, o QR Code de produção seria inválido — **bloqueador explícito, não apenas risco** |
| **Rollback** | Reverter para impressão manual da chave de acesso (sem DANFE automático) até o layout ser corrigido |
| **Critério de aceite** | Cupom impresso legível em bobina 80mm, QR Code escaneável e resolvendo para a consulta pública real da nota |

---

## Entrega G — Contingência

| | |
|---|---|
| **Pré-requisitos** | Entregas D e E; leitura completa do Manual de Especificações da Contingência Offline para NFC-e v2.0 (pendência já registrada em `svrs-services-endpoints.md` §7 — só o título/existência foram confirmados nesta pesquisa, não o conteúdo detalhado) |
| **Arquivos** | Lógica de detecção de indisponibilidade + fluxo de contingência no `emitDocument.ts`/gateway; indicador de "documentos pendentes de transmissão" na UI do PDV (novo, não existe hoje nenhum equivalente) |
| **Migrations** | Nenhuma nova — `fiscal_documents.status = 'contingency'` já suportado pela máquina de estados proposta (`fiscal-architecture-proposal.md` §4) |
| **Testes** | Simular indisponibilidade da SEFAZ (endpoint de homologação fora do ar, ou timeout forçado), confirmar que a venda continua normalmente, o documento fica marcado em contingência, e é retransmitido corretamente quando a conectividade volta, sem duplicar |
| **Riscos** | Perda de documento se não persistido antes da tentativa de transmissão — já endereçado no desenho (documento é gravado localmente antes de qualquer tentativa de rede) |
| **Rollback** | Nenhum — é um modo de operação, não uma mudança estrutural |
| **Critério de aceite** | Cenário de indisponibilidade simulada testado ponta a ponta: venda não trava, documento entra em contingência, regulariza automaticamente depois |

---

## Entrega H — Produção controlada da NFC-e

| | |
|---|---|
| **Pré-requisitos** | **Todos os pré-requisitos absolutos já listados em `fiscal-implementation-plan.md` Fase 5**: homologação concluída e validada, contabilidade validou os XMLs, credenciamento confirmado, certificado de produção instalado com segurança, CSC de produção confirmado, ambiente de produção configurado, responsável da Santtorini autorizou expressamente. **Adicional específico desta via**: Entrega A (RLS) 100% concluída — não parcial — antes de `fiscal_establishments.ambiente_producao_habilitado` ser setado para `true` em qualquer empresa |
| **Arquivos** | Nenhum novo — só a alteração de dado `fiscal_establishments.ambiente_producao_habilitado = true` |
| **Migrations** | Nenhuma |
| **Testes** | Piloto com poucas vendas reais, monitoramento manual próximo, comparação de cada nota emitida contra o esperado |
| **Riscos** | Rejeição em massa por erro de cadastro fiscal não detectado em homologação; falha de certificado no momento crítico — plano de rollback obrigatório antes do piloto |
| **Rollback** | Plano de rollback específico definido e revisado antes do piloto (não durante) — inclui reverter `ambiente_producao_habilitado` para `false` e comunicação clara ao operador do PDV sobre o que fazer com vendas já em andamento |
| **Critério de aceite** | Um número mínimo definido junto à Santtorini (ex.: 20-30 vendas reais) emitidas com sucesso, taxa de rejeição abaixo de um limiar aceitável definido antes do piloto, nenhum incidente de duplicidade ou perda de documento |

---

## Entrega I — NF-e modelo 55

| | |
|---|---|
| **Pré-requisitos** | Entrega H estável por um período mínimo definido junto à Santtorini; suporte a destinatário PJ implementado (`customers` estendido, Fase 2 de `fiscal-implementation-plan.md`); decisão sobre retorno da chave fiscal para a Nuvemshop (integração nova, `fiscal-architecture-proposal.md` §13); resposta às perguntas 5, 8, 9 de `fiscal-open-questions.md` (CFOP por canal/operação, volume de vendas B2B, regras interestaduais/DIFAL) |
| **Arquivos** | Extensão de `xmlBuilder.ts` para o modelo 55 (campos adicionais de transporte/frete completos), `danfe/renderNfe.ts` (formato A4, distinto do cupom) |
| **Migrations** | `fiscal_document_series` para modelo `'55'` (a tabela já suporta múltiplos modelos por desenho — só inserir a série nova, não alterar schema); extensão de `customers` para PJ, se ainda não feita na Fase 2 |
| **Testes** | Emissão de teste em homologação cobrindo: venda para CNPJ, venda interestadual, venda de e-commerce (Nuvemshop) |
| **Riscos** | Regras de CFOP/DIFAL interestadual ainda não mapeadas com a contabilidade (pergunta 9 de `fiscal-open-questions.md`) — bloqueador direto desta entrega, não apenas risco |
| **Rollback** | Nenhum — NFC-e continua funcionando independentemente |
| **Critério de aceite** | NF-e autorizada em homologação para os três cenários de teste, depois piloto controlado em produção seguindo o mesmo padrão da Entrega H |

---

**Nenhuma entrega foi iniciada.** Aguardando autorização para a Entrega A, que é a única sem nenhuma dependência externa pendente.
