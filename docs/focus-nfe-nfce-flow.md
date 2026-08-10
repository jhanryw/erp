# Fluxo Completo — NFC-e via Focus NFe

**Tipo:** desenho de fluxo, **não implementado**. Cobre o ciclo completo da NFC-e (prioridade operacional), da venda finalizada até a impressão, incluindo os desvios de falha técnica e contingência.

---

## Fluxo principal (caminho feliz)

```
1. Venda finalizada no PDV
   (já existente, inalterado — rpc_create_sale, status='paid')
   │
   ▼
2. Criação do documento fiscal (rascunho)
   emitDocument.ts:
     - busca a venda + itens + pagamentos já persistidos
     - resolve fiscal_establishments (provider='focus_nfe', ambiente)
     - monta o snapshot (buildSnapshot.ts, reaproveitado sem alteração)
     - gera provider_reference (formato stt-{company_id}-{fiscal_document_id})
     - INSERT em fiscal_documents com status='pending_validation'
   │
   ▼
3. Validação
   - confirma que todo item tem NCM/CFOP/CST-CSOSN preenchido
     (bloqueia aqui, não deixa a Focus rejeitar por dado ausente)
   - confirma que soma(sale_payments.net_amount) + cashback_used ≈ sales.total
     (reconciliação que não existe hoje no domínio de venda, ver
     focus-nfe-field-mapping.md — "Reconciliação soma(pagamentos)")
   - se falhar: status='validation_failed', não chama a Focus
   │
   ▼
4. Emissão manual (botão no PDV, v1 — não automática)
   admin/gerente/usuario clica "Emitir NFC-e" na tela de detalhe da venda
   │
   ▼
5. Resposta síncrona (FocusNFeProvider.issueNfce)
   POST https://api.focusnfe.com.br/v2/nfce?ref={provider_reference}
   - a Focus responde na MESMA requisição (síncrono, confirmado na documentação)
   - status='queued' → chamada em andamento → resultado imediato
   │
   ├─── 6a. Autorizado (201, status=autorizado) ──────────────────┐
   │                                                                 │
   └─── 6b. Rejeitado (201, status=erro_autorizacao,               │
   │        ou 400/422 por erro de payload) ──────────┐            │
   │                                                     │            │
   ▼                                                     ▼            ▼
7b. status='rejected'                          7a-continua ──► 8. Armazenamento
   grava status_sefaz/mensagem_sefaz               (autorizado)     - busca caminho_xml_nota_fiscal
   operador vê o motivo, corrige e tenta            fiscal_documents  e caminho_danfe da resposta
   de novo (nova ref, já que a rejeitada           .status='authorized'  (pendência: resolver URL completa,
   não pode ser reaproveitada se a Focus            .access_key          confirmar no spike)
   já a considerou "usada" — confirmar no spike     .protocol_number     - grava cópia própria no Storage
   se rejeição libera a ref para reenvio,                                 privado (fiscal_files)
   já que a doc só confirma isso claramente                              - calcula checksum SHA-256
   para o caso de "falha antes de autorizar")                            │
                                                                          ▼
                                                                   9. DANFCe (HTML, já pronto pela Focus)
                                                                      - exibido/impresso via window.print()
                                                                      (reaproveitando o único padrão de
                                                                      impressão já existente no ERP)
                                                                          │
                                                                          ▼
                                                                   10. Impressão
                                                                      - automática após autorização (v1: manual,
                                                                        clique do operador; automação é melhoria
                                                                        futura, não desta primeira entrega)
```

## Consulta (a qualquer momento, inclusive fora do fluxo principal)

```
Operador ou job de reconciliação → consultNfce(provider_reference)
  → GET /v2/nfce/{ref}
  → atualiza fiscal_documents.status conforme a resposta
```
Usado quando: (a) a resposta síncrona do passo 5 nunca chegou (timeout de rede do lado do ERP, não da Focus), (b) o job de reconciliação periódica (Parte 6 de `focus-nfe-architecture-plan.md`) varre documentos presos em `queued`/`processing`.

## Cancelamento

```
Admin, na tela de detalhe da venda/documento fiscal → "Cancelar NFC-e"
  → UI exige justificativa (15-255 caracteres, validado no frontend
    ANTES de chamar a API, para não gastar uma tentativa com erro óbvio)
  → verifica localmente: autorizada há menos de 30 minutos?
      - se não: bloqueia no frontend, orienta para devolução/nota complementar
        em vez de cancelamento fiscal (prazo da Focus já vencido)
  → cancelNfce(provider_reference, justification)
  → DELETE /v2/nfce/{ref}
  → fiscal_document_events: novo evento 'cancellation'
  → fiscal_documents.status='cancelled'
```
**Nota importante:** o cancelamento do documento fiscal é uma ação **separada** de `rpc_cancel_sale`/`rpc_return_sale` (que continuam existindo e funcionando exatamente como hoje, sem nenhuma alteração) — cancelar a venda no ERP e cancelar o documento fiscal na Focus são duas operações distintas que precisam ser coordenadas pela UI (ex.: ao cancelar uma venda que já tem NFC-e autorizada, o operador deve ser orientado a cancelar o documento fiscal primeiro, dentro do prazo, antes ou junto do cancelamento da venda) — esta coordenação **não está desenhada nesta etapa**, é um ponto em aberto para a Entrega E.

## Falha técnica (rede, timeout, erro 5xx da Focus)

```
issueNfce() lança exceção (timeout, erro de rede, 5xx)
  → fiscal_documents.status='queued' (já estava, desde o passo 2)
  → fiscal_transmission_attempts: nova linha, status='failed'
  → NÃO reenviar automaticamente
  → job de reconciliação (roda a cada N minutos) chama consultNfce()
    antes de qualquer nova tentativa de issueNfce()
  → se a consulta confirmar que a Focus nunca recebeu/processou:
    reenviar com a MESMA ref (documentação confirma que isso é seguro
    para o caso de falha antes da autorização)
  → se a consulta confirmar que já foi autorizado (a falha foi só
    na resposta de volta ao ERP, não na operação real): tratar como
    sucesso, seguir para o passo 8 (armazenamento) normalmente
```

## Contingência (SEFAZ ou Focus indisponível)

```
getServiceStatus() ou uma tentativa de issueNfce() indica indisponibilidade
  → venda NÃO trava — já foi finalizada no passo 1, independente do fiscal
  → duas opções, a decidir na Entrega G:
    (a) forma_emissao=offline via API cloud da Focus (numero/serie/
        codigo_unico informados manualmente) — mais simples, mas ainda
        depende de a Focus estar acessível
    (b) "Comunicador Offline" — aplicação desktop separada da Focus,
        para quando NEM a internet do PDV está disponível — infraestrutura
        adicional não avaliada em profundidade nesta pesquisa, ver
        focus-nfe-integration-audit.md Parte 1, item 12
  → fiscal_documents.status='contingency'
  → indicador visível na UI do PDV de "documentos pendentes de
    transmissão" (não existe hoje, precisa ser criado)
  → regularização: quando a conectividade voltar, efetivar a NFC-e
    de contingência (endpoint específico do Comunicador Offline, se
    essa via for escolhida) ou re-emitir normalmente (se só a API
    cloud, sem o Comunicador)
```
**Decisão não tomada nesta etapa:** se a Santtorini precisa do "Comunicador Offline" (aplicação desktop) desde o início, ou se `forma_emissao=offline` na própria API cloud é suficiente para o cenário real de indisponibilidade que o PDV físico enfrentaria — isso depende de saber com que frequência a internet do estabelecimento cai vs. a Focus/SEFAZ ficarem indisponíveis, informação de negócio não levantada nesta auditoria.

---

**Nenhuma parte deste fluxo foi implementada.** Serve de base para a Entrega D (`focus-nfe-implementation-phases.md`).
