# Matriz de Requisitos — Fornecedor de API Fiscal (NF-e/NFC-e)

**Tipo:** matriz objetiva de requisitos para avaliar qualquer fornecedor de API fiscal terceirizada, conforme recomendação preliminar registrada em `fiscal-audit-report.md` §7. **Nenhum fornecedor foi contratado, integrado ou testado nesta auditoria.** Onde nomes de fornecedores são citados, é apenas como ponto de partida de pesquisa — nenhuma informação técnica, comercial ou de preço sobre eles foi verificada nesta sessão, e cada linha da matriz precisa ser confirmada diretamente na documentação comercial/técnica vigente de cada fornecedor no momento da decisão.

**Como usar esta matriz:** para cada fornecedor avaliado, preencher a coluna "Confirmado?" com Sim/Não/Parcial e anotar a fonte (link da documentação oficial, e-mail do comercial, etc.) — nunca marcar como confirmado com base em suposição ou em material de marketing genérico.

---

## 1. Cobertura de modelo fiscal

| Requisito | Por que importa | Como verificar |
|---|---|---|
| Suporte a **NF-e modelo 55** | Necessário para e-commerce/atacado/CNPJ (Fase 4) | Documentação técnica do fornecedor deve citar explicitamente "modelo 55" |
| Suporte a **NFC-e modelo 65** | Necessário para o PDV físico (prioridade operacional, Fase 3) | Idem, "modelo 65" |
| Suporte simultâneo aos dois modelos na mesma conta/contrato | Evita precisar de dois fornecedores diferentes | Confirmar se é a mesma API/mesmo painel ou produtos separados |
| Suporte explícito a **SEFAZ/RN** | O RN usa um ambiente autorizador específico (possivelmente SVRS ou equivalente) — nem todo fornecedor cobre todos os estados igualmente | Perguntar diretamente: "vocês atendem emissão para SEFAZ do Rio Grande do Norte hoje, e há alguma limitação conhecida?" |

## 2. Ambientes

| Requisito | Por que importa | Como verificar |
|---|---|---|
| **Ambiente de homologação** disponível, separado de produção, sem custo adicional relevante para testes | Bloqueador confirmado do relatório principal — não existe ambiente de homologação hoje na aplicação nem confirmação de acesso ao da SEFAZ | Confirmar se a API do fornecedor tem endpoint/chave de homologação distintos, e se o fornecedor cobra por chamadas de teste |
| Troca entre homologação e produção **sem risco de emissão real acidental** | Evita transmitir nota real por engano durante testes | Perguntar como a chave/ambiente é selecionado na API (idealmente por credencial distinta, não por um parâmetro fácil de esquecer) |

## 3. Ciclo de vida do documento

| Requisito | Por que importa | Como verificar |
|---|---|---|
| **Emissão** (NF-e e NFC-e) | Básico | — |
| **Cancelamento** dentro do prazo legal | Fluxo já mapeado em `fiscal-architecture-proposal.md` §4 | Confirmar prazo de cancelamento suportado pela API e SLA de processamento |
| **Inutilização** de numeração | Necessário para gaps de numeração (ex.: falha antes da emissão) | Confirmar suporte explícito, não presumir |
| **Consulta de situação** | Obrigatório antes de qualquer reenvio após timeout (política de retry proposta em `fiscal-architecture-proposal.md` §5) | Confirmar existência de endpoint de consulta e tempo de resposta típico |
| **Contingência de NFC-e** | Continuidade operacional do PDV quando a SEFAZ está indisponível (explicado em `fiscal-architecture-proposal.md` §6) | Perguntar explicitamente qual(is) modalidade(s) de contingência o fornecedor suporta e como isso é acionado via API |
| **Eventos** (carta de correção, etc.) | Necessário para NF-e (Fase 4) | Confirmar cobertura |

## 4. DANFE e QR Code

| Requisito | Por que importa | Como verificar |
|---|---|---|
| Geração de **DANFE** (NF-e, formato A4/paisagem conforme aplicável) | Necessário para Fase 4 | Confirmar formato de entrega (PDF pronto vs. o ERP precisa montar) |
| Geração de **DANFE NFC-e** (formato bobina, idealmente 80mm) | Necessário para Fase 3 — o sistema hoje não tem nenhuma infraestrutura de impressão térmica (achado A4 do registro de riscos) | Confirmar se o fornecedor entrega o layout pronto para impressão térmica ou só o XML/dados, deixando a montagem visual para o ERP |
| **QR Code** da NFC-e correto e íntegro | Obrigatório legalmente | Confirmar que o fornecedor gera o QR Code com o CSC correto automaticamente |

## 5. Certificado digital e CSC

| Requisito | Por que importa | Como verificar |
|---|---|---|
| Suporte a **certificado A1** hospedado pelo fornecedor (upload do `.pfx`) | Evita a Santtorini/ERP terem que gerenciar assinatura XML diretamente | Confirmar processo de upload/rotação de certificado e onde ele fica armazenado |
| Alternativa: suporte a assinatura feita pelo próprio ERP, com o fornecedor só transmitindo | Caminho alternativo se a Santtorini preferir manter o certificado sob seu próprio controle | Confirmar se o fornecedor aceita XML já assinado, não só XML para assinar |
| Gestão do **CSC** (homologação e produção) | Necessário para NFC-e | Confirmar se o fornecedor gerencia isso ou se depende de a Santtorini fornecer o CSC obtido diretamente na SEFAZ |
| **Alertas de vencimento de certificado** | Ninguém deve descobrir que o certificado venceu no meio de uma venda | Confirmar se o fornecedor tem alerta nativo, ou se isso fica sob responsabilidade do ERP (ver `fiscal-architecture-proposal.md` §7) |

## 6. Integração técnica

| Requisito | Por que importa | Como verificar |
|---|---|---|
| **Webhooks** para eventos assíncronos (autorizado, rejeitado, etc.) | O ERP não tem hoje nenhuma fila/worker persistente — depende de ser notificado, não de fazer polling constante | Confirmar existência de webhook, formato do payload, e se há suporte a assinatura (HMAC ou equivalente) para validar autenticidade |
| **Idempotência** nativa da API (aceitar reenvio da mesma requisição sem duplicar) | Essencial para o padrão de retry proposto (`fiscal-architecture-proposal.md` §5) | Confirmar se a API aceita uma chave de idempotência fornecida pelo cliente, ou se a responsabilidade de não duplicar é só do ERP |
| **Rate limits** documentados | Volume baixo (~200 notas/mês) não deveria esbarrar em limite, mas picos de PDV podem gerar rajadas | Confirmar limite de chamadas por minuto/segundo |
| Latência/SLA de resposta síncrona vs. assíncrona | Afeta a experiência no PDV (emissão precisa ser razoavelmente rápida) | Confirmar tempo médio de resposta documentado pelo fornecedor |

## 7. Armazenamento e exportação do XML

| Requisito | Por que importa | Como verificar |
|---|---|---|
| Fornecedor **armazena** XML autorizado por prazo mínimo legal | Redundância útil, mas não deve ser a única cópia (ver `fiscal-architecture-proposal.md` §8 — o ERP deve manter cópia própria independentemente) | Confirmar prazo de retenção do fornecedor |
| **Exportação em massa** do XML a qualquer momento, em formato aberto, sem custo proibitivo | Evita lock-in — essencial se a Santtorini decidir trocar de fornecedor ou migrar para integração direta no futuro | Confirmar se existe endpoint/rotina de exportação em lote, e se há cobrança por isso |
| Não exigir manter contrato ativo para acessar XMLs já emitidos | Risco de lock-in agravado se o acesso ao histórico for cortado ao cancelar o contrato | Perguntar explicitamente o que acontece com o acesso ao histórico após cancelamento |

## 8. Reforma Tributária (IBS/CBS)

| Requisito | Por que importa | Como verificar |
|---|---|---|
| Roadmap confirmado (não apenas prometido genericamente) para suporte a IBS/CBS conforme cronograma oficial vigente | Fornecedor precisa acompanhar as notas técnicas nacionais — não pode ser a Santtorini/ERP a única responsável por isso | Pedir declaração explícita por escrito do fornecedor sobre o cronograma de adequação dele, comparado ao cronograma oficial vigente na época da decisão |

## 9. Segurança

| Requisito | Por que importa | Como verificar |
|---|---|---|
| Certificado/segredo nunca trafega nem é logado em texto puro | Regra absoluta do escopo desta auditoria, também deve valer para o fornecedor | Perguntar como o certificado é armazenado do lado do fornecedor (criptografia em repouso, HSM, etc.) |
| Conformidade com LGPD para os dados de clientes que trafegam nos documentos fiscais | Dados de CPF/CNPJ/endereço do destinatário passam pelo fornecedor | Confirmar política de privacidade e localização de armazenamento dos dados |
| Autenticação forte da API (chave de API + segredo, não só um token estático simples) | — | Confirmar mecanismo de autenticação |

## 10. SLA e suporte

| Requisito | Por que importa | Como verificar |
|---|---|---|
| SLA de disponibilidade documentado | Relevante para decidir política de contingência/retry | Confirmar número (ex.: "99,x% de uptime") e se há compensação contratual em caso de descumprimento |
| Suporte técnico em português, com canal direto (não só ticket genérico) | Operação pequena, sem time fiscal dedicado — vai depender do suporte do fornecedor nos primeiros meses | Confirmar canal de suporte e horário de atendimento |
| Suporte técnico durante a fase de homologação/testes | Fase 3/4 dependem disso | Confirmar se o suporte cobre ativamente a fase de testes ou só produção |

## 11. Portabilidade e migração futura

| Requisito | Por que importa | Como verificar |
|---|---|---|
| Nenhum aprisionamento de numeração/série exclusivo do fornecedor | A numeração fiscal pertence ao emitente (Santtorini), não ao fornecedor — precisa ser possível continuar a numeração ao trocar de fornecedor ou migrar para emissão direta | Confirmar como a numeração é gerida e se pode ser "levada junto" |
| Possibilidade de migração futura para integração direta com a SEFAZ, sem reconstruir todo o histórico | Ver comparação Estratégia A vs. B em `fiscal-audit-report.md` §7 — a decisão de hoje não deveria ser irreversível | Perguntar diretamente se o fornecedor já viu clientes migrarem para fora, e como isso costuma funcionar |

## 12. Preço para ~200 notas/mês

| Requisito | Por que importa | Como verificar |
|---|---|---|
| Custo mensal e por nota, para o volume real informado (~200 vendas/mês, com expectativa de crescimento) | Critério de prioridade mais baixa na ordem definida pelo negócio, mas ainda relevante para viabilidade | Pedir tabela de preços oficial vigente, não uma estimativa verbal — e perguntar como o preço escala se o volume crescer (ex.: 2x, 5x) |
| Custos ocultos (setup, taxa de homologação, taxa por cancelamento/evento, mínimo mensal) | Comum em serviços desse tipo | Pedir a tabela de preços completa, não só o valor "a partir de" |

---

## Fornecedores conhecidos no mercado brasileiro (ponto de partida de pesquisa, não avaliados nesta auditoria)

Os nomes abaixo são citados **apenas como referência de mercado para iniciar a pesquisa** — nenhum deles foi avaliado, testado ou comparado nesta auditoria, e nenhuma característica técnica ou comercial específica de nenhum deles foi verificada nesta sessão. Antes de considerar qualquer um: confirmar diretamente na documentação oficial vigente de cada um se atendem a cada linha das seções 1 a 12 acima, especialmente cobertura de SEFAZ/RN, suporte a NFC-e modelo 65 e roadmap de Reforma Tributária.

- Focus NFe
- PlugNotas
- eNotas
- NFe.io
- TecnoSpeed
- Outras plataformas de ERP com módulo fiscal embutido (ex.: Bling), caso a Santtorini considere avaliar substituir parte do ERP em vez de só integrar um serviço de emissão

**Nenhum destes é uma recomendação. É responsabilidade de quem for conduzir a pesquisa confirmar preço, cobertura de SEFAZ/RN, suporte a NFC-e, política de exportação de XML e roadmap de IBS/CBS diretamente com cada fornecedor antes de qualquer decisão ou contratação.**
