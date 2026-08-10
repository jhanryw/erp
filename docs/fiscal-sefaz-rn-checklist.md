# Checklist — SEFAZ/RN — Módulo Fiscal ERP Santtorini

**Contexto:** este documento organiza o que precisa ser resolvido junto à SEFAZ do Rio Grande do Norte antes de qualquer emissão real de NF-e (modelo 55) ou NFC-e (modelo 65) pela Santtorini. Não é uma consulta oficial — é um roteiro para a empresa (ou a contabilidade em seu nome) levar à SEFAZ/RN. Nenhuma transmissão, credenciamento ou contratação foi feita nesta fase.

Ver também: [`fiscal-open-questions.md`](fiscal-open-questions.md) (perguntas 2 e 3 têm origem direta neste checklist).

---

## 1. Credenciamento

- [ ] Confirmar se a empresa (CNPJ 61.523.225/0001-17) já está credenciada para emissão de **NF-e (modelo 55)** junto à SEFAZ/RN.
- [ ] Confirmar se a empresa já está credenciada para emissão de **NFC-e (modelo 65)** junto à SEFAZ/RN.
- [ ] Se não credenciada, levantar o processo completo de credenciamento (documentos exigidos, prazo médio, se depende de vistoria ou só de solicitação eletrônica).
- [ ] Confirmar se o credenciamento para NF-e e para NFC-e são processos distintos ou unificados no RN.
- [ ] Confirmar a Inscrição Estadual está regular e apta para emissão (sem pendências que bloqueiem o credenciamento).

## 2. Ambiente de homologação

- [ ] Confirmar o processo de acesso ao **ambiente de homologação** da SEFAZ/RN (webservices de teste), incluindo se exige registro/solicitação prévia ou se é liberado automaticamente após credenciamento.
- [ ] Confirmar se notas emitidas em homologação têm alguma obrigação de registro/retenção, ou se podem ser descartadas livremente após o teste.
- [ ] Confirmar o(s) endpoint(s)/webservice(s) de homologação vigentes para NF-e e NFC-e no RN (a SEFAZ/RN pode usar SVRS — Sefaz Virtual do Rio Grande do Sul — como contingência/operação; confirmar o ambiente autorizador vigente).

## 3. Certificado digital

- [ ] Confirmar os tipos de certificado digital aceitos para emissão automatizada em servidor (tipicamente e-CNPJ A1, instalável em servidor sem necessidade de token físico — a confirmar formalmente, sem presumir).
- [ ] Confirmar prazo de validade padrão e processo de renovação junto à Autoridade Certificadora escolhida (fora do escopo da SEFAZ diretamente, mas relevante ao processo).

## 4. CSC (Código de Segurança do Contribuinte) — NFC-e

- [ ] Confirmar processo de obtenção do **CSC de homologação**.
- [ ] Confirmar processo de obtenção do **CSC de produção**.
- [ ] Confirmar periodicidade de renovação/rotação do CSC, se houver.
- [ ] Confirmar o identificador do CSC (`idCSC`) e como ele deve ser referenciado no QR Code da NFC-e.

## 5. Séries e numeração

- [ ] Confirmar se é necessário comunicar à SEFAZ/RN a(s) série(s) que a empresa pretende usar para NF-e e para NFC-e antes da primeira emissão, ou se a definição é livre por parte do emitente (respeitando não-reutilização).
- [ ] Confirmar regras de **inutilização de numeração** (quando e como inutilizar uma faixa de números não utilizada).

## 6. Testes

- [ ] Confirmar se a SEFAZ/RN exige algum protocolo formal de testes/validação antes da liberação para produção, ou se a responsabilidade de testar em homologação é inteiramente da empresa/contabilidade.
- [ ] Confirmar se existe algum prazo mínimo de operação em homologação antes de poder migrar para produção.

## 7. Consulta e contingência

- [ ] Confirmar o serviço de **consulta de situação** de NF-e/NFC-e vigente (endpoint, formato) para uso em caso de timeout de transmissão.
- [ ] Confirmar as regras de **contingência** aplicáveis no RN — especificamente para NFC-e, quando a SEFAZ/RN (ou o ambiente autorizador ao qual o RN está vinculado) está indisponível: qual o modo de contingência autorizado (ex.: offline com transmissão posterior), prazo máximo para regularização, e se há diferença entre indisponibilidade de internet do estabelecimento e indisponibilidade da própria SEFAZ.
- [ ] Confirmar se há SVC (SEFAZ Virtual de Contingência) vigente para o RN e qual o fluxo de acionamento.

## 8. Reforma Tributária

- [ ] Confirmar o cronograma de transição de leiaute (schemas XML, notas técnicas) para IBS/CBS aplicável a emitentes do RN, e se há uma data confirmada em que o leiaute atual deixa de ser aceito.

---

**Nota:** todos os itens acima devem ser confirmados junto a fontes oficiais vigentes no momento da consulta (portal da SEFAZ/RN, Encontro Nacional de Administradores Fazendários — ENCAT — para as notas técnicas nacionais de NF-e/NFC-e). Este documento não substitui consulta oficial e não contém nenhuma informação inventada ou presumida sobre os processos da SEFAZ/RN — cada item é uma pergunta em aberto, não uma resposta.
