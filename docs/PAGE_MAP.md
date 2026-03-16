# Santtorini ERP — Bloco 1: Mapa Completo de Páginas e Navegação

---

## Autenticação (público)
| Rota | Componente | Acesso |
|------|-----------|--------|
| `/login` | Login com email/senha | Público |
| `/recuperar-acesso` | Solicitação de reset de senha | Público |
| `/auth/callback` | Callback OAuth/magic link | Público |

---

## Dashboard
| Rota | Título | Acesso |
|------|--------|--------|
| `/` | Dashboard Geral | Admin + Seller (limitado) |
| `/vendas/dashboard` | Dashboard de Vendas | Admin + Seller |
| `/estoque/dashboard` | Dashboard de Estoque | Admin + Seller |
| `/financeiro/dashboard` | Dashboard Financeiro | Admin |
| `/clientes/dashboard` | Dashboard de Clientes | Admin |
| `/marketing/dashboard` | Dashboard de Marketing | Admin |
| `/cashback/dashboard` | Dashboard de Cashback | Admin |
| `/inteligencia` | Dashboard de Inteligência de Produto | Admin |
| `/inteligencia/giro` | Dashboard de Giro de Estoque | Admin |
| `/inteligencia/margem` | Dashboard de Margem e Lucro | Admin |

---

## Produtos
| Rota | Título | Acesso |
|------|--------|--------|
| `/produtos` | Listagem de produtos (tabela + filtros) | Admin (R+W), Seller (R) |
| `/produtos/novo` | Cadastro de produto | Admin |
| `/produtos/[id]` | Detalhe do produto | Admin + Seller |
| `/produtos/[id]/editar` | Edição do produto | Admin |

---

## Estoque
| Rota | Título | Acesso |
|------|--------|--------|
| `/estoque` | Visão geral do estoque (posição atual) | Admin + Seller |
| `/estoque/movimentacoes` | Histórico de movimentações | Admin + Seller |
| `/estoque/alertas` | Produtos abaixo do mínimo e parados | Admin + Seller |
| `/estoque/entrada` | Registrar nova entrada / lote | Admin |

---

## Fornecedores
| Rota | Título | Acesso |
|------|--------|--------|
| `/fornecedores` | Listagem de fornecedores | Admin |
| `/fornecedores/novo` | Cadastro de fornecedor | Admin |
| `/fornecedores/[id]` | Detalhe + histórico de compras | Admin |
| `/fornecedores/[id]/editar` | Edição | Admin |

---

## Clientes
| Rota | Título | Acesso |
|------|--------|--------|
| `/clientes` | Listagem de clientes | Admin + Seller |
| `/clientes/novo` | Cadastro de cliente | Admin + Seller |
| `/clientes/[id]` | Detalhe + histórico + cashback + RFM | Admin + Seller |
| `/clientes/[id]/editar` | Edição | Admin + Seller |

---

## Vendas
| Rota | Título | Acesso |
|------|--------|--------|
| `/vendas` | Listagem de vendas | Admin + Seller (seller vê próprias) |
| `/vendas/nova` | Nova venda (fluxo multi-item) | Admin + Seller |
| `/vendas/[id]` | Detalhe do pedido | Admin + Seller |
| `/vendas/[id]/devolucao` | Iniciar devolução/troca | Admin + Seller |

---

## Marketing
| Rota | Título | Acesso |
|------|--------|--------|
| `/marketing` | Dashboard de Marketing (CAC, ROI) | Admin |
| `/marketing/campanhas` | Listagem de campanhas | Admin |
| `/marketing/campanhas/nova` | Cadastro de campanha | Admin |
| `/marketing/campanhas/[id]` | Detalhe de campanha | Admin |
| `/marketing/custos` | Custos de marketing por período | Admin |
| `/marketing/custos/novo` | Registrar custo | Admin |

---

## Financeiro
| Rota | Título | Acesso |
|------|--------|--------|
| `/financeiro` | Dashboard Financeiro (DRE resumido) | Admin |
| `/financeiro/fluxo` | Fluxo de caixa | Admin |
| `/financeiro/dre` | DRE simplificado mensal | Admin |
| `/financeiro/lancamentos` | Lançamentos manuais | Admin |
| `/financeiro/lancamentos/novo` | Novo lançamento | Admin |

---

## Cashback
| Rota | Título | Acesso |
|------|--------|--------|
| `/cashback` | Dashboard de cashback | Admin |
| `/cashback/configuracao` | Configuração da regra de cashback | Admin |
| `/cashback/historico` | Histórico de transações | Admin |

---

## Relatórios
| Rota | Título | Acesso |
|------|--------|--------|
| `/relatorios` | Central de relatórios | Admin |
| `/relatorios/vendas` | Relatório de vendas (filtros + export) | Admin |
| `/relatorios/produtos` | Relatório por produto | Admin |
| `/relatorios/clientes` | Relatório de clientes | Admin |
| `/relatorios/fornecedores` | Relatório por fornecedor | Admin |
| `/relatorios/financeiro` | Relatório financeiro | Admin |
| `/relatorios/estoque` | Relatório de estoque | Admin |
| `/relatorios/marketing` | Relatório de marketing | Admin |

---

## Inteligência
| Rota | Título | Acesso |
|------|--------|--------|
| `/inteligencia` | Hub de inteligência | Admin |
| `/inteligencia/abc` | Curva ABC (Revenue / Profit / Volume) | Admin |
| `/inteligencia/giro` | Giro de estoque e dias parados | Admin |
| `/inteligencia/margem` | Margem e lucro por produto/categoria | Admin |
| `/inteligencia/cores` | Performance por cor | Admin |
| `/inteligencia/fornecedores` | Ranking de fornecedores | Admin |
| `/inteligencia/rfm` | Mapa RFM de clientes | Admin |

---

## Configurações
| Rota | Título | Acesso |
|------|--------|--------|
| `/configuracoes` | Configurações gerais | Admin |
| `/configuracoes/usuarios` | Gestão de usuários | Admin |
| `/configuracoes/categorias` | CRUD de categorias | Admin |
| `/configuracoes/variacoes` | Tipos e valores de variação | Admin |
| `/configuracoes/colecoes` | Coleções de produto | Admin |
| `/configuracoes/parametros` | Parâmetros do sistema | Admin |
| `/configuracoes/perfil` | Editar perfil próprio | Admin + Seller |

---

## Navegação — Estrutura da Sidebar

```
─────────────────────────────────
  ◈  Santtorini                    ← logo
─────────────────────────────────
  Geral
  ├── Dashboard

  Operação
  ├── Vendas
  ├── Clientes
  ├── Produtos
  ├── Estoque

  Gestão (Admin only)
  ├── Fornecedores
  ├── Marketing
  ├── Financeiro
  ├── Cashback

  Análise (Admin only)
  ├── Relatórios
  └── Inteligência

  Sistema (Admin only)
  └── Configurações
─────────────────────────────────
  [avatar] Nome do usuário
  Role badge
─────────────────────────────────
```

## Navegação Mobile

- Bottom tab bar com 5 itens principais (Dashboard, Vendas, Clientes, Estoque, ⋯ Mais)
- "Mais" abre drawer com os módulos restantes filtrados por permissão
- Sidebar desktop hidden em mobile
