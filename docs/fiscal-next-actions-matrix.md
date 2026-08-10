# Matriz de Próximas Ações — Módulo Fiscal ERP Santtorini

**Tipo:** sequenciamento prático das ações identificadas em toda a auditoria (fase inicial + validação intermediária), com responsável e classificação. Não é uma autorização de execução — é organização do que já foi identificado, para facilitar a decisão de por onde começar.

**Classificações usadas** (uma ação pode ter mais de uma):
- 🟢 **Pode começar agora** — não depende de nenhuma outra ação pendente
- 🔵 **Depende da auditoria SQL** — precisa dos resultados de `fiscal-audit-readonly.sql` primeiro
- 🟡 **Depende da contabilidade** — precisa de resposta da Índice Contabilidade
- 🟠 **Depende da SEFAZ** — precisa de confirmação/processo junto à SEFAZ/RN
- 🟣 **Depende de contratação** — precisa de decisão sobre fornecedor de API fiscal (ou da estratégia de integração direta)
- 🔴 **Bloqueia homologação** — sem essa ação, não é possível iniciar testes em homologação
- ⛔ **Bloqueia produção** — sem essa ação, não é possível transmitir em produção, mesmo com tudo mais pronto

---

## Santtorini (responsável pela empresa/negócio)

| # | Ação | Classificação | Depende de |
|---|---|---|---|
| S1 | Executar os blocos do `fiscal-audit-readonly.sql` (ou autorizar alguém com acesso ao banco a executar), seguindo `fiscal-database-validation-guide.md` | 🟢 | — |
| S2 | Confirmar situação de credenciamento na SEFAZ/RN para NF-e e NFC-e | 🟢 🔴 ⛔ | Contato direto com SEFAZ/RN |
| S3 | Iniciar processo de obtenção de certificado digital (tipo recomendado: e-CNPJ A1, ver `fiscal-architecture-proposal.md` §7) | 🟢 🔴 ⛔ | — |
| S4 | Obter/confirmar CSC de homologação e de produção junto à SEFAZ/RN | 🟠 🔴 ⛔ | S2 (credenciamento) |
| S5 | Concluir a alteração de endereço fiscal para o endereço da loja física (ou confirmar que o atual é definitivo) | 🟢 🔴 | — |
| S6 | Enviar o checklist de dados à Índice Contabilidade (`fiscal-accounting-checklist.md`) | 🟢 | — |
| S7 | Decidir orçamento/aprovação para manter ambiente de homologação separado da aplicação | 🟢 🔴 | Ver pergunta 13 em `fiscal-open-questions.md` |
| S8 | Definir responsável interno para validar cada nota emitida em homologação antes da liberação para produção | 🟢 ⛔ | — |
| S9 | Decidir modelo/marca de impressora térmica do PDV (ver pergunta 11 em `fiscal-open-questions.md`) | 🟢 | Não bloqueia o desenho da arquitetura, só a implementação final de impressão (Fase 3) |
| S10 | Revisar e autorizar (ou não) o plano de correção isolado de `products_total` (`products-total-regression-analysis.md` §11) | 🔵 | S1 (para confirmar escopo real antes de decidir) |
| S11 | Revisar e autorizar (ou não) a estratégia de consolidação de schema (`migrations-divergence-analysis.md` §9) | 🟢 | — |
| S12 | Pesquisar e comparar fornecedores de API fiscal usando `fiscal-provider-requirements.md` | 🟢 🟣 | — |
| S13 | Autorizar expressamente o início da Fase 2 (implementação), com escopo de arquivos/migrations apresentado antes | 🟡 🟠 🟣 (depende do progresso das ações de contabilidade/SEFAZ/fornecedor) | Todas as ações críticas acima |

## Contabilidade (Índice Contabilidade)

| # | Ação | Classificação | Depende de |
|---|---|---|---|
| C1 | Confirmar CRT e enquadramento tributário completo (pergunta 1 em `fiscal-open-questions.md`) | 🟢 🔴 | S6 (recebimento do checklist) |
| C2 | Fornecer NCM/CEST por categoria de produto | 🟢 🔴 | S6 |
| C3 | Fornecer CFOP por combinação de canal × operação × destino | 🟢 🔴 | S6 |
| C4 | Fornecer CSOSN/CST de ICMS/PIS/COFINS aplicáveis | 🟢 🔴 | S6, C1 (depende do CRT confirmado primeiro) |
| C5 | Confirmar alíquotas, FCP, ICMS-ST, benefícios fiscais aplicáveis | 🟢 🔴 | S6, C1 |
| C6 | Orientar sobre tratamento de devolução/troca fiscal | 🟢 | S6 |
| C7 | Orientar sobre cronograma de transição para IBS/CBS aplicável à Santtorini | 🟢 | S6 |
| C8 | Confirmar disponibilidade para validar as primeiras notas emitidas em homologação | 🟢 ⛔ | — |

## SEFAZ/RN

| # | Ação | Classificação | Depende de |
|---|---|---|---|
| F1 | Confirmar/processar credenciamento para NF-e e NFC-e | 🟠 🔴 ⛔ | S2 |
| F2 | Confirmar processo e liberar acesso ao ambiente de homologação | 🟠 🔴 | F1 |
| F3 | Emitir/confirmar CSC de homologação e produção | 🟠 🔴 ⛔ | F1 |
| F4 | Esclarecer regras de contingência de NFC-e aplicáveis no RN | 🟠 | Ver `fiscal-sefaz-rn-checklist.md` item 7 |
| F5 | Esclarecer regras de numeração/série e inutilização exigidas | 🟠 | Ver `fiscal-sefaz-rn-checklist.md` item 5 |

## Desenvolvimento

| # | Ação | Classificação | Depende de |
|---|---|---|---|
| D1 | Rodar (ou orientar quem for rodar) as consultas de `fiscal-audit-readonly.sql`, bloco por bloco | 🟢 | Acesso de leitura ao banco |
| D2 | Preparar (não executar) a migration isolada de correção de `products_total`, para revisão | 🔵 | S1/S10 |
| D3 | Preparar (não executar) o `pg_dump --schema-only`/consultas de consolidação de schema, para revisão | 🟢 | S11 |
| D4 | Corrigir o padrão de segredo do Dockerfile (build ARG → mecanismo mais seguro) antes de introduzir segredo de certificado digital — preparar proposta para revisão | 🟢 | Achado A7 do `fiscal-risk-register.md`; não depende de decisão fiscal, é independente |
| D5 | Preparar proposta detalhada de arquivos/migrations da Fase 1 fiscal, para apresentação e autorização | 🟣 🟡 🟠 | S13 (decisão de avançar), C1-C5 (regras tributárias), decisão de fornecedor |
| D6 | Avaliar tecnicamente as opções de impressão (página dedicada vs. agente local) após S9 confirmar o modelo de impressora | 🟢 | S9 |

## Possível fornecedor de API fiscal (após seleção)

| # | Ação | Classificação | Depende de |
|---|---|---|---|
| P1 | Confirmar cobertura de SEFAZ/RN, NFC-e modelo 65, NF-e modelo 55 | 🟣 | S12 (pesquisa concluída, fornecedor escolhido para avaliação) |
| P2 | Disponibilizar ambiente de homologação e credenciais de teste | 🟣 🔴 | P1, S13 |
| P3 | Confirmar processo de upload/gestão de certificado A1 | 🟣 🔴 ⛔ | P1, S3 (certificado obtido) |
| P4 | Confirmar suporte a webhooks assinados e idempotência | 🟣 | P1 |
| P5 | Fornecer tabela de preços oficial para o volume real (~200 notas/mês) | 🟣 | P1 |

---

## Ordem prática recomendada (visão consolidada)

Isto não substitui as fases já definidas em `fiscal-implementation-plan.md` — é uma visão de "quem faz o quê primeiro" cruzando todos os responsáveis, útil para os próximos passos imediatos, antes mesmo de entrar na Fase 0 formalmente:

1. **Agora, em paralelo, sem depender uma da outra:** S1 (rodar SQL), S2 (credenciamento SEFAZ), S3 (certificado), S5 (endereço fiscal), S6 (enviar checklist à contabilidade), S12 (pesquisar fornecedores), D3/D4/D1 (preparações técnicas de desenvolvimento que não mexem em nada de produção).
2. **Assim que S1 retornar:** decidir S10 (corrigir `products_total`, se autorizado) e fechar os achados **[LIVE]** do `fiscal-risk-register.md`.
3. **Assim que C1-C5 (contabilidade) e S2/S4 (SEFAZ/certificado) estiverem avançados:** já é possível começar a desenhar com segurança o modelo de dados fiscal definitivo (ainda sem implementar).
4. **Assim que S12 resultar numa direção de fornecedor (ou na decisão de integração direta):** D5 pode ser preparado com detalhe suficiente para pedir autorização da Fase 1.
5. **S13 (autorização expressa da Fase 2)** é o gate final antes de qualquer código ser escrito — depende de tudo acima estar minimamente encaminhado, não necessariamente 100% concluído (ex.: pode-se começar a Fase 1 de fundação técnica com o CRT já confirmado mesmo que nem todo NCM do catálogo esteja completo ainda, já que o preenchimento de catálogo é trabalho da Fase 2, não da Fase 1).

**Nenhuma ação de escrita (código, migration, configuração, contratação) foi executada nesta auditoria ou nesta validação intermediária.** Esta matriz é só organização do trabalho identificado, aguardando as autorizações específicas de cada ação, conforme o padrão já estabelecido nos documentos anteriores.
