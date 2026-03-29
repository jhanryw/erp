# Estratégia de Testes para o ERP

O projeto atualmente NÃO possui uma suíte de testes configurada (Jest ou Vitest) em função da prioridade na finalização da arquitetura e das refatorações críticas transacionais. 

Como a lógica crítica agora está concentrada no PostgreSQL via PL/pgSQL (RPCs transacionais, como `rpc_create_sale`, `rpc_stock_adjust`, etc.) e na camada de `services` puros (como `vendas.service.ts` e `estoque.service.ts`), a adoção futura de testes deve seguir a seguinte estratégia:

### O que falta para testar os Services e RPCs Críticos:

1. **Instalação do framework**: Instalar `vitest` para ser rápido e ter bom suporte TypeScript nativo, e instalar o Supabase Local para testes em um banco limpo.
2. **Setup do banco de testes**: Um script para rodar as migrations (ex: `001_initial.sql` e `002_rpc_transactions.sql`) antes da execução da suíte, populando o banco com cenários-chave (produtos com estoque = 10 e usuários com diferentes roles).
3. **Casos principais a mapear**:
    - **Transacionais Negativos**: Testar requisições concorrentes de `createSale` e `adjustStock` que excedam o limite num mesmo instante, provando que o `FOR UPDATE` na RPC retorna erro `P0001` (estoque insuficiente) sem negativar o banco.
    - **Proteção de Role**: Escrever unit tests simples mockando `requireRole` para validar que sem a role correta os Handlers rejeitam com 403.
    - **Recálculo de Custo Médio Ponderado**: Realizar uma entrada de estoque com custo diferente do estoque original e bater se o valor foi calculado corretamente via `createStockEntry`.

### Ferramentas sugeridas para a próxima etapa:

* `vitest` (Framework de Asserção)
* `@testing-library/react` (Caso avance para testes UI na pasta de componentes)
* `@supabase/local` e `pg` (Para setup de banco via seeders limpos a cada teste integrado)
