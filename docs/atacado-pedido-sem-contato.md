# Pedido de atacado sem nome/telefone — decisão técnica

## Comparação
| | Dados fictícios (`c22f876`) | Campos NULL (migration `202610131000`) |
|---|---|---|
| Schema | inalterado | `DROP NOT NULL` + CHECK de par (nome e telefone juntos ou nenhum) |
| Semântica | "Cliente do site" e `+5500…` são lixo em coluna de telefone | NULL = "não informado" (explícito) |
| Risco futuro (CRM, pós-venda, relatórios, exportações) | qualquer consumidor que esqueça o prefixo reservado envia mensagem para número falso, conta "clientes distintos" errado | consumidor recebe NULL e precisa tratar (o TypeScript acusa: tipos nullable) |
| Anti-spam | por telefone nunca dispara (único por pedido); IP e empresa valem | por telefone só quando há telefone; IP e empresa valem — idêntico |
| Idempotência | chave UUID + advisory lock (inalterado) | idem |
| Implantação | zero migration | 1 migration pequena e reaplicável; app tem ponte para banco sem ela |
| Rollback | nada a desfazer | ver bloco ROLLBACK da migration |

## Anti-spam: nenhuma proteção removida
O limite por telefone (10/h) já era contornável (qualquer número de 10 dígitos passa). As proteções que de fato seguram um atacante
continuam: limite por IP (30/h, hash) e teto por empresa (200/h, independe de IP e telefone). Testes SQL e unitários cobrem os dois
para pedidos anônimos, inclusive sem IP.

## Recomendação
Campos NULL. Os dados fictícios satisfazem a constraint, mas deixam uma "mentira" no schema que só o código desta feature conhece.

## Implantação segura (ordem indiferente)
O app tenta gravar NULL; se o banco ainda tem NOT NULL (erro 23502, RPC atômica, nada gravado), repete uma vez com a identidade de
reserva. Depois da migration esse ramo nunca executa e pode ser removido. A migration faz backfill SOMENTE dos marcadores fictícios
(`Cliente do site` + `+5500` + 8 dígitos).
