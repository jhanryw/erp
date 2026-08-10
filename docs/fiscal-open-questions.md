# Perguntas em Aberto — Módulo Fiscal (NF-e/NFC-e) — ERP Santtorini

Complementa [`fiscal-audit-report.md`](fiscal-audit-report.md). Cada pergunta indica por que é necessária, quem deve responder, o impacto, e se bloqueia ou não a implementação. Perguntas genéricas foram evitadas — cada uma existe porque a auditoria não conseguiu confirmar o dado a partir do código, do banco (sem acesso live) ou do contexto de negócio fornecido.

---

## Regime tributário e credenciamento

**1. Qual é o CRT (Código de Regime Tributário) confirmado da empresa?**
- Por que é necessária: o CRT determina se a tributação usa CSOSN (Simples Nacional) ou CST (demais regimes) em todo item de NF-e/NFC-e — é o dado tributário mais fundamental do sistema.
- Quem deve responder: Índice Contabilidade.
- Impacto: define toda a modelagem de `fiscal_tax_profiles`/`fiscal_operation_rules`.
- Bloqueia: **sim**, bloqueia a Fase 2 (cadastro fiscal) por completo.

**2. A empresa está credenciada na SEFAZ/RN para emissão de NF-e (modelo 55) e NFC-e (modelo 65)? Se não, qual o processo e prazo estimado?**
- Por que é necessária: sem credenciamento confirmado, não é possível nem testar em homologação de forma válida.
- Quem deve responder: Santtorini, junto à SEFAZ/RN (ver [`fiscal-sefaz-rn-checklist.md`](fiscal-sefaz-rn-checklist.md)).
- Impacto: define o cronograma real da Fase 0.
- Bloqueia: **sim**, bloqueia qualquer transmissão real (mesmo em homologação, dependendo do processo).

**3. A empresa já possui ou está em processo de obtenção do CSC (Código de Segurança do Contribuinte) para NFC-e, em homologação e produção?**
- Por que é necessária: o CSC é obrigatório para gerar o QR Code da NFC-e.
- Quem deve responder: Santtorini, junto à SEFAZ/RN.
- Impacto: bloqueia a Fase 3 (NFC-e em homologação).
- Bloqueia: **sim** para NFC-e especificamente.

---

## Cadastro fiscal de produtos e operações

**4. Qual é a classificação fiscal (NCM/CEST) correta para cada categoria de produto vendida pela Santtorini?**
- Por que é necessária: o sistema já tem os campos (`products.ncm`/`cest`), mas nulos/incompletos para parte do catálogo (confirmado por uma flag de qualidade de dado já existente no sistema, `product_no_ncm`). Sem isso, a modelagem tributária não avança.
- Quem deve responder: Índice Contabilidade (validação final) + Santtorini (levantamento inicial por categoria).
- Impacto: bloqueia Fase 2 e qualquer emissão de teste realista.
- Bloqueia: **sim**.

**5. Quais CFOPs se aplicam a cada combinação de canal (PDV, Nuvemshop, WhatsApp, atacado, manual) × tipo de operação (venda, devolução, troca) × destino (dentro do RN, fora do RN)?**
- Por que é necessária: não existe hoje nenhuma matriz de decisão de CFOP no sistema — precisa ser desenhada com apoio contábil, não inferida pelo nome do canal (conforme instrução explícita do escopo desta auditoria).
- Quem deve responder: Índice Contabilidade.
- Impacto: define a tabela `fiscal_operation_rules`.
- Bloqueia: **sim**, para Fase 2/3/4.

**6. Existem benefícios fiscais, isenções ou regimes diferenciados aplicáveis a algum produto ou operação da Santtorini (ex.: por NCM, por categoria, por UF de destino)?**
- Por que é necessária: o simulador tributário já existente no sistema (`tax_simulation_settings`) declara explicitamente que não trata "isenções, redução de base ou regimes diferenciados por NCM" — não dá para presumir ausência sem confirmação.
- Quem deve responder: Índice Contabilidade.
- Impacto: define se `fiscal_tax_profiles` precisa de campo de benefício fiscal desde o início.
- Bloqueia: não bloqueia o início da Fase 1, mas bloqueia a Fase 2 para os produtos afetados.

**7. Como a Santtorini deve tratar a Reforma Tributária (IBS/CBS) no cronograma de implementação — o módulo fiscal deve nascer já preparado para o novo leiaute, ou seguir o leiaute vigente e migrar depois?**
- Por que é necessária: o leiaute da NF-e/NFC-e está em transição; construir para o leiaute errado significa retrabalho.
- Quem deve responder: decisão conjunta entre desenvolvimento e contabilidade, à luz da documentação oficial vigente na época da Fase 1.
- Impacto: afeta o desenho de `fiscal_tax_profiles` e o schema XML alvo.
- Bloqueia: não bloqueia o início, mas deve ser resolvida antes de fechar o modelo de dados definitivo (Fase 1).

---

## Cliente / destinatário

**8. A Santtorini já vende hoje para clientes com CNPJ (atacado, B2B)? Se sim, com que volume, e isso é prioridade para a primeira versão fiscal?**
- Por que é necessária: define se o suporte a PJ em `customers` entra na Fase 2 ou pode ser adiado.
- Quem deve responder: Santtorini.
- Impacto: escopo da Fase 2.
- Bloqueia: não bloqueia NFC-e presencial, mas bloqueia qualquer NF-e para CNPJ.

**9. Para vendas interestaduais (Nuvemshop para fora do RN), a Santtorini tem clareza sobre a obrigatoriedade de NF-e vs. NFC-e, e sobre o tratamento de ICMS-ST/DIFAL aplicável?**
- Por que é necessária: a matriz de decisão de documento fiscal não pode ser assumida pelo nome do canal (Nuvemshop pode gerar tanto NF-e quanto, em alguns casos, ser tratado como consumidor final não presencial).
- Quem deve responder: Índice Contabilidade.
- Impacto: define regra em `fiscal_operation_rules`.
- Bloqueia: bloqueia a Fase 4 (NF-e para e-commerce/interestadual), não a Fase 3 (NFC-e no PDV).

---

## Meios de pagamento e adquirentes

**10. Para NFC-e, quais dados de meio de pagamento são de fato exigidos pela SEFAZ/RN por adquirente (Cielo, Ton, Cora, InfinityPay) — é obrigatório capturar NSU/código de autorização/CNPJ da credenciadora, ou o meio de pagamento (código de forma de pagamento SEFAZ) já é suficiente?**
- Por que é necessária: o sistema hoje não captura NSU/autorização/CNPJ da adquirente de forma estruturada (só texto livre em `card_brand`/`acquirer`, e um campo `metadata` JSONB não populado) — antes de decidir se isso precisa ser retrofitado, é preciso confirmar a exigência real.
- Quem deve responder: Índice Contabilidade / documentação oficial da NFC-e vigente.
- Impacto: define se `sale_payments` precisa de novas colunas antes da Fase 3.
- Bloqueia: bloqueia a Fase 3 se a resposta for "sim, é obrigatório".

---

## Impressão

**11. Qual modelo/marca de impressora térmica será usada no PDV, e ela suporta ESC/POS padrão via USB?**
- Por que é necessária: o sistema hoje não tem nenhuma infraestrutura de impressão térmica (só `window.print()` para etiqueta A4) — a estratégia de impressão (agente local, WebUSB, PDF) depende de conhecer a capacidade real do hardware.
- Quem deve responder: Santtorini (decisão de compra de equipamento, com apoio técnico do desenvolvimento).
- Impacto: define a arquitetura de impressão da Fase 3.
- Bloqueia: não bloqueia o desenho da arquitetura (pode ser feito com requisitos mínimos), mas bloqueia a implementação final de impressão.

---

## Decisão de fornecimento

**12. A Santtorini tem preferência declarada ou já iniciou conversas com algum provedor de API fiscal terceirizada?**
- Por que é necessária: evita que a fase de pesquisa de fornecedores (§7 do relatório principal) duplique esforço já em andamento.
- Quem deve responder: Santtorini.
- Impacto: acelera ou não a Fase 0/1.
- Bloqueia: não bloqueia, mas é relevante para sequenciar o trabalho.

---

## Ambiente e infraestrutura

**13. Existe orçamento/aprovação para manter um ambiente de homologação separado da aplicação (banco, storage, variáveis de ambiente próprias) rodando em paralelo à produção?**
- Por que é necessária: hoje não existe nenhum ambiente de homologação de aplicação (confirmado tecnicamente) — criar um tem custo de infraestrutura contínuo, não só de configuração inicial.
- Quem deve responder: Santtorini (decisão de negócio/orçamento).
- Impacto: define a viabilidade da Fase 3/4 como desenhadas (testar em homologação antes de produção).
- Bloqueia: **sim**, é classificado como bloqueador no relatório principal se a resposta for "não há orçamento" — nesse caso a estratégia de homologação precisa ser redesenhada (ex.: ambiente compartilhado com janela de manutenção).

**14. Quem, do lado da Santtorini, terá autoridade e disponibilidade para validar cada nota emitida em homologação antes da liberação para produção (Fase 5)?**
- Por que é necessária: o plano de implementação prevê aprovação humana explícita antes de produção controlada — sem um responsável definido, a Fase 5 não tem como avançar com segurança.
- Quem deve responder: Santtorini.
- Impacto: define o piloto da Fase 5.
- Bloqueia: bloqueia especificamente a Fase 5, não as anteriores.
