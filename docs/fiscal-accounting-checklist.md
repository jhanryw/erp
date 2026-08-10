# Checklist Fiscal — Solicitação à Contabilidade (Índice Contabilidade)

**Contexto:** o ERP Santtorini está em fase de planejamento (não implementação) de um módulo de emissão de NF-e (modelo 55) e NFC-e (modelo 65). Esta lista reúne exatamente os dados que a auditoria técnica não conseguiu obter do sistema atual nem presumir, e que precisam de validação/fornecimento pela contabilidade antes que o desenvolvimento comece a modelar o cadastro fiscal. Nenhuma implementação foi feita ainda — este documento é insumo para a próxima fase.

Ver também: [`fiscal-open-questions.md`](fiscal-open-questions.md) (perguntas 1, 4, 5, 6, 7, 9, 10 têm origem direta nesta lista).

---

## 1. Regime tributário e emitente

- [ ] **CRT (Código de Regime Tributário)** confirmado — Simples Nacional, com sub-anexo/atividade correta.
- [ ] **CNAE** principal e secundários da empresa.
- [ ] **Inscrição Estadual (IE)** — número confirmado e situação ativa junto à SEFAZ/RN.
- [ ] **Inscrição Municipal (IM)**, se aplicável ao CNAE.
- [ ] Confirmação de que **61.523.225 Yasmim Pereira Araujo Lucas Freire, CNPJ 61.523.225/0001-17** é a razão social/CNPJ correto para o emitente das notas.
- [ ] Confirmação do **endereço fiscal definitivo** a constar nas notas (o endereço está em processo de alteração para o da loja física — precisamos da data prevista de conclusão e do endereço final, incluindo código IBGE do município).

## 2. Classificação fiscal de produtos

- [ ] **NCM** por categoria/linha de produto (o sistema já tem o campo pronto — `products.ncm` — mas está incompleto para parte do catálogo).
- [ ] **CEST**, quando aplicável (produtos sujeitos a substituição tributária).
- [ ] **Origem da mercadoria** (código 0 a 8) por categoria — confirmar se há produtos importados ou com conteúdo de importação relevante.
- [ ] **Unidade comercial e unidade tributável** por categoria de produto (confirmar se são sempre iguais ou se algum produto precisa de distinção).
- [ ] Orientação sobre **GTIN/EAN**: a maioria dos produtos não tem código de barras cadastrado hoje — confirmar se a nota pode ser emitida com "SEM GTIN" e em quais casos isso é aceitável.

## 3. Tributação por operação

- [ ] **CSOSN** aplicável a cada tipo de operação (venda presencial, venda e-commerce, atacado, devolução, troca) — ou CST, caso o CRT não seja Simples Nacional.
- [ ] **CST de PIS e COFINS** aplicável.
- [ ] **CFOP** por combinação de: canal de venda (PDV físico, Nuvemshop, WhatsApp, atacado, venda manual) × tipo de operação (venda, devolução, troca) × destino (dentro do RN, fora do RN, exportação se aplicável).
- [ ] **Alíquotas de ICMS** aplicáveis, incluindo eventual **FCP** (Fundo de Combate à Pobreza) por UF de destino.
- [ ] **ICMS-ST**: confirmar se algum produto/categoria está sujeito a substituição tributária, e a MVA aplicável se houver.
- [ ] **Benefícios fiscais ou regimes diferenciados** aplicáveis a algum produto, categoria ou operação — hoje o simulador tributário interno do ERP explicitamente não cobre isenções/reduções de base/regimes diferenciados, então precisamos saber se isso é necessário desde a v1.

## 4. Vendas interestaduais e para CNPJ

- [ ] Regras de **DIFAL** (diferencial de alíquota) para vendas a consumidor final não contribuinte em outra UF via Nuvemshop.
- [ ] Confirmação sobre a diferenciação entre **consumidor final, contribuinte e não contribuinte** — como isso deve ser identificado no momento da venda.
- [ ] Se a Santtorini já vende ou pretende vender para clientes com CNPJ (atacado), quais as regras tributárias específicas dessas operações.

## 5. Devoluções e trocas

- [ ] Procedimento fiscal correto para **devolução de mercadoria** já com nota emitida (NF-e de devolução, CFOP de devolução, etc.).
- [ ] Procedimento fiscal correto para **troca** — se deve gerar novo documento fiscal, documento complementar, ou nota de ajuste, considerando que o sistema hoje trata trocas parciais sem fechar o status da venda original.

## 6. Reforma Tributária

- [ ] Orientação sobre o cronograma de transição para **IBS/CBS** aplicável à Santtorini, e se o módulo deve nascer já preparado para o novo leiaute ou seguir o vigente com plano de migração.

## 7. Validação e homologação

- [ ] Disponibilidade da contabilidade para **validar as primeiras notas emitidas em ambiente de homologação** antes da liberação para produção.
- [ ] Confirmação de que a contabilidade já processa (ou processará) XML de NF-e/NFC-e da Santtorini pelo certificado digital, e se isso dispensa ou não o ERP de manter armazenamento próprio dos documentos (nossa recomendação técnica é manter armazenamento próprio independentemente — ver `fiscal-architecture-proposal.md`).

## 8. Séries e numeração

- [ ] Confirmar se já existe alguma série/numeração reservada ou usada anteriormente pela empresa (mesmo que nunca tenha emitido) — para evitar conflito.

---

**Retorno esperado:** planilha ou documento com as respostas ponto a ponto, idealmente organizadas por categoria de produto para os itens da seção 2 e 3. Pode ser parcial — os itens não respondidos serão tratados como bloqueadores registrados em [`fiscal-risk-register.md`](fiscal-risk-register.md) até serem resolvidos.
