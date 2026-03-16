# Santtorini ERP — Bloco 3: UX/UI por Módulo

---

## Dashboard Geral

**Hierarquia visual:**
- Row 1: 4 KPI cards (Faturamento Hoje | Vendas Hoje | Ticket Médio | Margem Bruta)
- Row 2: Gráfico de faturamento (linha 30 dias) + Gráfico de canais de venda (donut)
- Row 3: Top 5 produtos do dia | Alertas de estoque | Cashback a liberar
- Row 4 (Admin): DRE resumida do mês (mini cards: Receita / CMV / Lucro Bruto / Lucro Líq.)

**Seller view:** sem Row 4, KPI cards limitados (sem margem financeira detalhada)

**Mobile:** stack vertical, cards em full-width, gráficos com scroll horizontal

---

## Produtos

**Listagem:**
- Tabela densa: foto miniatura, nome, SKU, categoria, custo, preço, margem%, estoque total, ações
- Filtros: categoria, subcategoria, fornecedor, status (ativo/inativo), coleção
- Busca: por nome ou SKU (debounce 300ms)
- Ordenação por coluna clicável
- Bulk actions: ativar/desativar selecionados

**Detalhe do produto:**
- Hero: foto grande + informações principais
- Tabs: Informações Gerais | Variações | Estoque por variação | Histórico de compras | Performance
- Seção de variações: grid de chips (cor × tamanho) com estoque por combinação

**Formulário de cadastro:**
- Stepper de 3 passos: (1) Informações Básicas → (2) Variações → (3) Estoque inicial
- Upload de foto com preview
- Margem calculada em tempo real ao digitar custo/preço
- Seletor de variações: add chip de cor, tamanho, modelo, tecido com combinação automática

**Mobile:** formulário single-column, stepper no topo, preview de margem fixo no bottom

---

## Estoque

**Visão geral:**
- Cards de resumo: Produtos em estoque | Valor total a custo | Valor total a preço | Produtos com alerta
- Tabela: produto, variação, qtd, custo médio, valor custo, valor venda, dias parados, última movimentação
- Filtros: categoria, fornecedor, status (com estoque / zerado / abaixo do mínimo)
- Action: botão "Registrar Entrada" fixo no topo

**Movimentações:**
- Timeline de entradas e saídas por produto
- Filtro por tipo (compra / venda / devolução / produção)
- Exportação CSV

**Alertas:**
- Lista de produtos com qtd ≤ estoque mínimo (vermelho)
- Lista de produtos parados (amarelo) — sem venda nos últimos X dias
- Ações rápidas: registrar entrada diretamente da linha de alerta

**Entrada de lote (modal/drawer):**
- Seletor de produto + variação
- Campos: quantidade, custo unitário, frete, impostos
- Preview: custo total do lote, custo por unidade
- Campos: data de entrada, fornecedor, tipo (compra/produção)

---

## Fornecedores

**Listagem:** nome, CNPJ, cidade, total comprado, margem média, última compra, ações
**Detalhe:** tabs — Dados Cadastrais | Histórico de Compras | Produtos | Indicadores

**Indicadores por fornecedor:**
- Total comprado (R$)
- Total faturado (R$ em vendas)
- Margem média dos produtos
- Produto mais vendido
- Ticket médio por compra
- Dias médios para vender os produtos desse fornecedor

---

## Clientes

**Listagem:**
- Busca por nome, CPF, telefone
- Filtros: origem, cidade, segmento RFM
- Colunas: nome, CPF (mascarado), telefone, total gasto, nº compras, ticket médio, última compra, segmento RFM (badge colorido)
- Badge RFM: Champions (dourado), Loyal (azul), At Risk (laranja), Lost (vermelho)

**Detalhe do cliente:**
- Header: nome, CPF, telefone, origem com badge
- 4 KPI cards: total gasto, nº compras, ticket médio, última compra
- Tabs: Histórico de Compras | Cashback | Preferências | RFM
- Tab RFM: scores R/F/M em gauge visual + segmento + explicação do segmento
- Tab Cashback: saldo disponível destacado + tabela de transações

**Cadastro:**
- CPF com validação em tempo real (algoritmo)
- Data de nascimento com cálculo de idade
- Origem obrigatória (dropdown)
- Preferências opcionais (tamanho, cor, categoria)

**Mobile:** formulário single-column, validação de CPF inline

---

## Vendas

**Listagem:**
- Filtros: status (badge colorido), período, vendedor, cliente, origem
- Colunas: nº pedido, cliente, data, itens, total, desconto, cashback usado, pagamento, status, vendedor
- Status badges: pago (verde), enviado (azul), entregue (cinza), cancelado (vermelho), devolvido (laranja)
- Quick actions: ver detalhe, cancelar, iniciar devolução

**FLUXO DE NOVA VENDA (crítico):**

Passo 1 — Selecionar Cliente
- Busca por nome, CPF ou telefone (autocomplete)
- Saldo de cashback disponível exibido ao selecionar cliente
- Link para cadastro rápido se cliente não encontrado

Passo 2 — Adicionar Itens
- Busca de produto por nome/SKU
- Ao selecionar produto: escolher variação (cor, tamanho) com indicador de estoque disponível
- Quantidade com +/- buttons
- Desconto por item (opcional)
- Lista de itens com subtotais
- Remover item com ×

Passo 3 — Resumo e Pagamento
- Subtotal, desconto total, frete cobrado, cashback a usar (com validação de saldo)
- Total final em destaque
- Seletor de forma de pagamento (PIX / Cartão / Dinheiro)
- Origem da venda (onde veio o cliente)
- Campo de observações

Passo 4 — Confirmação
- Preview do pedido completo
- Botão "Confirmar Venda" (CTA principal em #A71818)
- Geração automática do número do pedido

**Interface:** stepper no topo fixo, conteúdo scrollável, resumo do carrinho fixo no lado direito (desktop) ou no bottom (mobile)

**Detalhe do pedido:**
- Header: nº pedido, status, data, vendedor
- Timeline de status
- Tabela de itens (produto, variação, qty, preço, custo, margem por item)
- Resumo financeiro
- Frete: cobrado / custo real (admin vê ambos)
- Seção cashback: gerado nessa venda + status de liberação
- Botões: cancelar pedido | iniciar devolução | marcar como enviado/entregue

---

## Marketing

**Dashboard:**
- KPIs: CAC do mês | Investimento total | Clientes novos | ROI médio
- Gráfico: investimento por canal (barras empilhadas)
- Gráfico: evolução mensal de CAC
- Tabela de campanhas ativas

**Custos:**
- Tabela por categoria: categoria, descrição, valor, data, campanha
- Filtro por período e categoria
- Saldo acumulado por categoria no período
- Botão "Lançar Custo" (modal rápido)

**Campanhas:**
- Card por campanha: canal, período, budget, objetivo
- Status: ativa / encerrada
- Ao clicar: detalhe com custos vinculados e ROI calculado

---

## Financeiro

**Dashboard:**
- DRE resumido do mês corrente em cards horizontais
- Gráfico de fluxo de caixa (entradas vs saídas por semana)
- Comparativo: mês atual vs mês anterior (barras side-by-side)

**Fluxo de caixa:**
- Tabela por dia: entradas, saídas, saldo acumulado
- Filtro por período (default: mês corrente)
- Gráfico de área com saldo acumulado

**DRE:**
- Estrutura em árvore (Receita Bruta → Deduções → Receita Líquida → CMV → Lucro Bruto → Despesas → Lucro Líquido)
- Seletor de mês/período
- Comparativo de múltiplos meses em colunas

---

## Relatórios

**Hub:**
- Grid de cards por tipo de relatório (ícone + nome + descrição)
- Cada relatório tem: filtros de período, botões de export (Excel, PDF, CSV)

**Comportamento:**
- Dados carregados após configurar filtros e clicar em "Gerar"
- Preview na tela antes de exportar
- Loading state com skeleton durante geração

---

## Inteligência

**Hub:**
- Acesso rápido a: Curva ABC | Giro | Margem | Performance por Cor | Fornecedores | RFM

**Curva ABC:**
- Tabs: Por Faturamento | Por Lucro | Por Volume
- Gráfico: bar chart com linha de acumulado (Pareto)
- Tabela com filtro por classe (A / B / C)
- Highlight: produtos em A por faturamento mas C por lucro (warning)

**Giro de Estoque:**
- Tabela: produto, giro anual, dias médios para vender, categoria do giro (rápido/médio/lento)
- Filtros: categoria, fornecedor, período
- Cards de resumo: média geral de giro, categoria mais lenta, fornecedor mais parado

**Performance por Cor:**
- Tabela: cor, unidades vendidas, faturamento, margem média, ticket médio
- Gráfico de barras: faturamento por cor
- Filtro por categoria de produto

**RFM:**
- Bubble chart ou heatmap de segmentos
- Tabela de clientes por segmento
- Ações de CRM por segmento (copiar lista de contatos para WhatsApp — futuro)

---

## Tabelas Densas — Comportamento Padrão

- **Desktop:** máximo de colunas visíveis, overflow horizontal se necessário
- **Mobile:** 3-4 colunas essenciais visíveis, restante em drawer "Ver mais" por linha
- **Paginação:** 20 / 50 / 100 itens por página
- **Ordenação:** clique no header da coluna, ícone de seta indicando direção
- **Seleção:** checkbox na primeira coluna para bulk actions
- **Linha clicável:** toda a linha abre o detalhe (exceto células com ações)
- **Hover:** highlight sutil com `bg-white/5`
- **Células numéricas:** alinhamento à direita, formatação monetária

---

## Estados de Interface

**Empty state:** ícone centralizado + texto descritivo + CTA para criar o primeiro item
**Loading:** skeleton de linhas em tabelas, skeleton de cards em dashboards
**Error:** banner vermelho com mensagem + botão de retry
**Success:** toast verde no canto inferior direito, duração 4s
**Confirmação destrutiva:** modal com texto do item + botão vermelho "Confirmar exclusão"
