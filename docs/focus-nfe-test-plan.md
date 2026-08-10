# Plano de Testes — Integração Focus NFe

**Tipo:** plano de testes, **não implementado**. Nenhum teste foi escrito ou executado.

---

## Unitários (sem rede, com mocks)

| Teste | Cobre |
|---|---|
| `buildNfcePayload` monta o payload correto a partir de um snapshot de venda conhecido | Tradução ERP → Focus, incluindo mapeamento de `sale_payments.method` → código de meio de pagamento |
| `buildNfcePayload` rejeita/sinaliza quando um item não tem NCM | Validação antes de chamar a API (passo 3 do fluxo) |
| `buildNfcePayload` lida corretamente com venda 100% paga em cashback (`payments: []`) | Decisão pendente registrada em `focus-nfe-field-mapping.md` — o teste deve existir mesmo antes da decisão, para forçar que ela seja tomada explicitamente |
| `parseResponse` extrai `status`/`status_sefaz`/`mensagem_sefaz`/`chave_nfe` de uma resposta de exemplo (autorizada e rejeitada) | Interpretação de resposta |
| `webhookVerifier` aceita um payload com o header de autorização correto e rejeita sem ele | Segurança do webhook (Parte 7 de `focus-nfe-architecture-plan.md`) |
| Geração de `provider_reference` (`stt-{company_id}-{fiscal_document_id}`) nunca colide para dois documentos distintos | Idempotência |
| `redactFiscalSecrets` remove o token Focus de um objeto de log de exemplo | Segurança |

## Integração com mock (sem chamar a Focus de verdade)

| Teste | Cobre |
|---|---|
| `emitDocument()` ponta a ponta com `FocusNFeProvider` mockado (sucesso) | Fluxo principal completo, incluindo gravação em `fiscal_documents`/`fiscal_files` |
| `emitDocument()` com mock retornando rejeição | Caminho de rejeição, `status='rejected'`, mensagem exibida corretamente |
| `emitDocument()` com mock lançando timeout | Caminho de falha técnica — confirma que NÃO reenvia automaticamente, só registra `fiscal_transmission_attempts` |
| Reconciliação periódica com mock de `consultNfce` retornando um status diferente do esperado | Job de reconciliação atualiza o documento corretamente |
| Webhook recebido duas vezes com o mesmo conteúdo (simulando o retry documentado da Focus) | Idempotência de webhook — segunda chamada não duplica evento |

## Homologação Focus (chamadas reais, ambiente de teste)

**Pré-requisito:** token de homologação obtido, empresa cadastrada no painel Focus (Fase 0 externa, fora do controle deste plano).

| Teste | Cobre | Referência |
|---|---|---|
| `getServiceStatus`-equivalente / primeira chamada simples (`GET /v2/empresas` conforme exemplo oficial de autenticação) | Confirma autenticação funcionando | `focus-nfe-integration-audit.md` Parte 1, item 2 |
| Emissão de NFC-e de teste, venda simples, 1 item, pagamento único | Fluxo principal completo, primeira emissão real | — |
| Emissão de NFC-e com múltiplos itens | Payload `items[]` com mais de uma linha | — |
| Emissão de NFC-e com desconto | Campo de desconto (formato ainda não confirmado — item vs. total) | `focus-nfe-field-mapping.md` |
| Emissão de NFC-e com múltiplas formas de pagamento | `formas_pagamento[]`, reconciliação de soma | — |
| Emissão de NFC-e com cliente sem CPF | Consumidor não identificado | — |
| Emissão de NFC-e com CPF inválido propositalmente | Confirma que a Focus rejeita e como o erro é reportado (código, mensagem) | — |
| Emissão de NFC-e com produto sem NCM propositalmente | Confirma se a validação do passo 3 (bloqueio no ERP) realmente evita chegar à Focus, e o que aconteceria se chegasse (para calibrar a mensagem de erro) | — |
| Consulta de uma nota recém-autorizada | `consultNfce` | — |
| Cancelamento dentro do prazo de 30 minutos | `cancelNfce`, caminho feliz | — |
| Tentativa de cancelamento fora do prazo (esperar >30min ou usar nota antiga de teste) | Confirma a mensagem de erro exata da Focus para prazo vencido | — |
| Reenvio da mesma `ref` após uma emissão rejeitada por dado corrigível | Confirma na prática se a `ref` pode mesmo ser reaproveitada após rejeição (pendência da Parte 1) | `focus-nfe-integration-audit.md` |
| Resolução de `caminho_xml_nota_fiscal`/`caminho_danfe` em URL completa | Fecha a pendência #3 da Parte 1 — **item obrigatório do primeiro spike**, não pode ficar sem resposta antes da Entrega D | — |

## Idempotência (dedicado, dado o desenho específico da Focus)

| Teste | Cobre |
|---|---|
| Duas chamadas simultâneas de `emitDocument()` para a mesma venda | Constraint `UNIQUE(provider, provider_reference)` impede duplicidade real, mesmo sob corrida |
| Timeout simulado seguido de nova tentativa | Confirma que o fluxo consulta antes de reenviar (Parte 6 de `focus-nfe-architecture-plan.md`), nunca gera uma segunda `ref` para a mesma intenção |

## Webhook

| Teste | Cobre |
|---|---|
| Webhook repetido (mesmo conteúdo, enviado 2x — simulando o retry real da Focus) | Não duplica evento, responde 200 nas duas vezes |
| Webhook perdido (simular que nunca chega) | Job de reconciliação periódica pega o documento eventualmente, sem depender só do webhook |
| Webhook com header de autorização incorreto/ausente | Rejeitado com 401, não processado |
| Webhook fora de ordem (evento mais antigo chegando depois de um mais novo) | Endpoint trata o `status` recebido como estado mais recente conhecido, não presume ordem |

## Troca de ambiente

| Teste | Cobre |
|---|---|
| `fiscal_establishments.ambiente_producao_habilitado=false` bloqueia qualquer chamada com `environment='producao'` | Bloqueio explícito de produção (Parte 7 de `focus-nfe-architecture-plan.md`) |
| Token de homologação nunca é usado quando `environment='producao'` está resolvido, e vice-versa | Separação de secrets por ambiente — teste que injeta os dois tokens e confirma que o correto é escolhido em cada chamada |

## Proteção do token

| Teste | Cobre |
|---|---|
| Nenhuma string do token aparece em nenhum log gerado durante um teste de integração completo (grep automatizado no output do teste) | Redaction efetiva, não só teórica |
| Tentativa de importar o módulo do `FocusNFeProvider` a partir de um arquivo `'use client'` falha em tempo de build/lint | Garantia estrutural de que o token nunca chega ao bundle do navegador (proposta de regra de lint/import boundary, a definir na implementação) |

---

**Nenhum destes testes foi escrito.** Os testes de "Homologação Focus" dependem de credenciais reais de teste (Fase 0 externa) e devem ser os primeiros a rodar manualmente, antes de qualquer automação — ver `focus-nfe-implementation-phases.md` para o spike recomendado.
