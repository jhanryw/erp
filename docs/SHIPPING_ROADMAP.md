# Roadmap de Implementação - Módulo de Frete

## Status: FASE 1 COMPLETA ✅

### Fase 1: Base de Dados + Serviços + APIs (DONE)

- [x] Schemas SQL (8 tabelas)
- [x] Types TypeScript completos
- [x] Service Layer (CEP, Geocoding, Cálculo de Frete)
- [x] API Routes públicas (3 endpoints)
- [x] API Routes admin (10 endpoints CRUD)
- [x] Seed inicial (1 origem + 4 zonas + 4 regras)
- [x] Documentação técnica (SHIPPING_MODULE.md)
- [x] Guia de integração (SHIPPING_INTEGRATION_EXAMPLE.md)

**Arquivos principais:**
- `/DATABASE_SCHEMA.sql` (atualizado com tabelas shipping)
- `/src/types/shipping.types.ts`
- `/src/lib/services/*` (cepService, geocodingService, shippingCalculatorService)
- `/src/app/api/shipping/*` (todos os endpoints)
- `/src/lib/seeds/shipping-seed.sql`

---

## Fase 2: Páginas Admin (PRÓXIMO)

### 2.1 Dashboard de Frete
**Localização:** `/app/admin/shipping`

**Componentes necessários:**
- [ ] Card com resumo de envios (total, pendentes, entregues)
- [ ] Gráfico de envios por zona (últimos 30 dias)
- [ ] Gráfico de subsídios de frete por zona
- [ ] Tabela rápida de envios recentes
- [ ] Links para páginas de configuração

**Dados necessários:**
```sql
-- Total de envios por status
SELECT status, COUNT(*) as qty FROM shipments GROUP BY status

-- Receita vs custo de frete por zona
SELECT sz.name,
  COUNT(*) as qty,
  SUM(sr.client_price) as total_received,
  SUM(sr.internal_cost) as total_cost,
  SUM(s.shipping_subsidy) as total_subsidy
FROM shipments s
JOIN shipping_zones sz ON s.zone_id = sz.id
GROUP BY sz.id, sz.name
```

**Estimativa:** 2-3 horas

---

### 2.2 Página de Gerenciamento de Zonas
**Localização:** `/app/admin/shipping/zones`

**Funcionalidades:**
- [ ] Tabela com todas as zonas (nome, cidade, km range, prioridade, status)
- [ ] Botão "Nova Zona"
- [ ] Modal para criar zona
  - [ ] Campos: nome, descrição, estado, cidade, vizinhanças (array input), CEP ranges (array input)
  - [ ] Campos: min_km, max_km, cor (color picker), prioridade
  - [ ] Validação: nome único
  - [ ] Mapa interativo para visualizar zona (opcional fase 2.5)
- [ ] Ações por linha: Editar, Deletar, Ver Regras
- [ ] Modal para editar zona
- [ ] Confirmação antes de deletar

**Componentes a criar:**
- `NeighborhoodsInput.tsx` - Array input para vizinhanças
- `CEPRangesInput.tsx` - Array input para faixas de CEP
- `ZonesTable.tsx` - Tabela principal
- `ZoneModal.tsx` - Modal create/edit
- `page.tsx` - Container principal

**API já pronta:** `/api/shipping/admin/zones` (GET/POST/PATCH/DELETE)

**Estimativa:** 4-5 horas

---

### 2.3 Página de Gerenciamento de Regras
**Localização:** `/app/admin/shipping/rules`

**Funcionalidades:**
- [ ] Tabela com todas as regras (zona, preço cliente, custo interno, subsídio)
- [ ] Filtro por zona (dropdown)
- [ ] Botão "Nova Regra"
- [ ] Modal para criar regra
  - [ ] Dropdown de zona
  - [ ] Campos: client_price, internal_cost, estimated_hours
  - [ ] Campos: free_shipping_min_order, min_order_to_enable
  - [ ] Toggles: allow_pickup, allow_delivery
  - [ ] Cálculo automático de subsídio (internal_cost - client_price)
- [ ] Ações por linha: Editar, Deletar
- [ ] Modal para editar regra
- [ ] Confirmação antes de deletar

**Componentes a criar:**
- `RulesTable.tsx` - Tabela principal com filtro
- `RuleModal.tsx` - Modal create/edit
- `SubsidyCalculator.tsx` - Cálculo em tempo real
- `page.tsx` - Container principal

**API já pronta:** `/api/shipping/admin/rules` (GET/POST/PATCH/DELETE)

**Estimativa:** 3-4 horas

---

### 2.4 Página de Configuração de Origem
**Localização:** `/app/admin/shipping/origins`

**Funcionalidades:**
- [ ] Card com origem ativa (nome, endereço, coordenadas, status)
- [ ] Botão "Editar Origem"
- [ ] Modal para editar
  - [ ] Campos: nome, CEP, logradouro, número, complemento
  - [ ] Campos: bairro, cidade, estado
  - [ ] Campos: latitude, longitude (ou buscar via CEP)
  - [ ] Toggle: is_active
- [ ] Histórico de origens (lista com backup antigo)
- [ ] Ação: Ativar origem anterior (backup)

**Componentes a criar:**
- `OriginCard.tsx` - Exibição principal
- `OriginModal.tsx` - Modal edit
- `OriginHistory.tsx` - Histórico
- `page.tsx` - Container

**API já pronta:** `/api/shipping/admin/origins` (GET/POST/PATCH)

**Estimativa:** 2-3 horas

---

### 2.5 Mapa Interativo de Zonas (OPCIONAL)
**Localização:** Integrado nas páginas de zonas

**Funcionalidades:**
- [ ] Mapa (Leaflet/Mapbox) mostrando:
  - Origem (Santtorini)
  - Limites das zonas de entrega (polígonos coloridos)
  - Raio de distância (círculos)
  - Vizinhanças (labels)
- [ ] Click em zona para ver detalhes
- [ ] Click em zona para editar

**Libs necessárias:**
```json
{
  "leaflet": "^1.9.0",
  "react-leaflet": "^4.2.0"
}
```

**Estimativa:** 4-6 horas

---

## Fase 3: Página de Envios/Logística

**Localização:** `/app/admin/shipping/shipments`

### 3.1 Lista de Envios
**Funcionalidades:**
- [ ] Tabela com colunas:
  - ID do pedido
  - Cliente (nome)
  - Endereço (bairro, cidade)
  - Zona
  - Status
  - Distância
  - Frete cobrado
  - Data de criação
- [ ] Filtros:
  - Por status (dropdown multi-select)
  - Por zona (dropdown)
  - Por cliente (busca)
  - Por data (range picker)
  - Por método de entrega (entrega/retirada)
- [ ] Sorting: por status, por data, por distância
- [ ] Paginação ou infinite scroll
- [ ] Ação: Clicar para ver detalhes

**Estimativa:** 4-5 horas

---

### 3.2 Detalhes do Envio
**Localização:** `/app/admin/shipping/shipments/[id]`

**Seções:**
- [ ] Info geral (ID, cliente, endereço completo)
- [ ] Info de frete (zona, distância, preços)
- [ ] Info de entrega (nome courier, telefone, modo)
- [ ] Timeline de eventos (eventos em ordem cronológica)
- [ ] Formulário para atualizar status (dropdown com estados válidos)
- [ ] Campo para adicionar nota/descrição
- [ ] Upload de comprovante (foto/assinatura)
- [ ] Botão para adicionar novo evento

**Componentes:**
- `ShipmentHeader.tsx` - Info geral
- `ShipmentDetails.tsx` - Frete + entrega
- `ShipmentTimeline.tsx` - Timeline de eventos
- `ShipmentEventForm.tsx` - Formulário para novo evento
- `page.tsx` - Container

**API necessária:** (nova)
- `GET /api/shipping/shipments/[id]` - Detalhes + eventos
- `PATCH /api/shipping/shipments/[id]` - Atualizar status/nota
- `POST /api/shipping/shipments/[id]/events` - Criar evento

**Estimativa:** 5-6 horas

---

### 3.3 Rastreamento para Cliente (PUBLIC)
**Localização:** `/tracking/[shipmentId]`

**Funcionalidades:**
- [ ] Página pública (sem autenticação)
- [ ] Timeline visual dos eventos
- [ ] Mapa mostrando origem e destino (opcional)
- [ ] Status atual em destaque
- [ ] Info de entrega (data estimada, courier)
- [ ] Share via link/QR code

**Estimativa:** 3-4 horas

---

## Fase 4: Integração no Checkout

**Localização:** Integrar em `/app/checkout` ou `/cart`

### 4.1 Componente de CEP com Busca
- [x] **Código exemplo:** `SHIPPING_INTEGRATION_EXAMPLE.md` > CEPInput
- [ ] Implementar no projeto
- [ ] Testar com CEPs de Natal e Parnamirim
- [ ] Tratamento de erros (CEP inválido, não encontrado)

**Estimativa:** 2 horas

---

### 4.2 Componente de Cálculo de Frete
- [x] **Código exemplo:** `SHIPPING_INTEGRATION_EXAMPLE.md` > ShippingCalculator
- [ ] Implementar no projeto
- [ ] Exibir frete em tempo real
- [ ] Mostrar mensagem de frete grátis quando aplicável
- [ ] Mostrar erro se não atender mínimo

**Estimativa:** 2 horas

---

### 4.3 Integração no Fluxo de Pedido
- [ ] Salvar `shipping` junto com `sale` e `sale_items`
- [ ] Criar `shipment` automaticamente ao confirmar pedido
- [ ] Criar primeiro `shipment_event` (aguardando_confirmacao)
- [ ] Atualizar UI para mostrar frete no resumo
- [ ] Atualizar email de confirmação com info de frete

**API necessária:** (update)
- `POST /api/checkout/create-order` - Já pronta no exemplo

**Estimativa:** 3-4 horas

---

### 4.4 Seleção de Método de Entrega
- [ ] Radio buttons: Entrega / Retirada na loja
- [ ] Se "Retirada": esconder CEP, mostrar endereço da loja
- [ ] Se "Retirada": frete = 0
- [ ] Atualizar total quando mudar método

**Estimativa:** 2 horas

---

## Fase 5: Automação & Webhooks (FUTURO)

### 5.1 Seed Automático
- [ ] Verificar se tabelas estão vazias no first load
- [ ] Executar `shipping-seed.sql` automaticamente
- [ ] Usar função ou job

**Estimativa:** 1-2 horas

---

### 5.2 Job Agendado para Sincronizar Status
- [ ] Job que roda a cada 6h
- [ ] Pega shipments com status "saiu_entrega"
- [ ] Consulta API de courier (ViaCEP Frete, Loggi, etc)
- [ ] Atualiza status + cria evento

**Estimativa:** 4-6 horas (depende da API escolhida)

---

### 5.3 Notificações Automáticas
- [ ] Email quando status muda
- [ ] SMS opcional
- [ ] Push notification (via PWA)

**Estimativa:** 3-4 horas

---

### 5.4 Webhooks de Courier
- [ ] Receber POST de courier quando status mudar
- [ ] Validar assinatura/token
- [ ] Atualizar shipment
- [ ] Criar evento
- [ ] Notificar cliente

**Estimativa:** 4-5 horas

---

## Resumo de Estimativas

| Fase | Tarefa | Horas | Status |
|------|--------|-------|--------|
| 1 | Base de Dados + Serviços + APIs | 16-20 | ✅ DONE |
| 2.1 | Dashboard | 2-3 | ⏳ TODO |
| 2.2 | Gerenciar Zonas | 4-5 | ⏳ TODO |
| 2.3 | Gerenciar Regras | 3-4 | ⏳ TODO |
| 2.4 | Configurar Origem | 2-3 | ⏳ TODO |
| 2.5 | Mapa Interativo (OPT) | 4-6 | ⏳ TODO |
| 3.1 | Lista de Envios | 4-5 | ⏳ TODO |
| 3.2 | Detalhes do Envio | 5-6 | ⏳ TODO |
| 3.3 | Rastreamento Público | 3-4 | ⏳ TODO |
| 4.1 | CEP Input | 2 | ⏳ TODO |
| 4.2 | Cálculo de Frete | 2 | ⏳ TODO |
| 4.3 | Integração no Pedido | 3-4 | ⏳ TODO |
| 4.4 | Método de Entrega | 2 | ⏳ TODO |
| 5.1 | Seed Automático | 1-2 | ⏳ TODO |
| 5.2 | Sincronizar Status | 4-6 | ⏳ TODO |
| 5.3 | Notificações | 3-4 | ⏳ TODO |
| 5.4 | Webhooks | 4-5 | ⏳ TODO |
| **TOTAL** | | **66-88 horas** | - |

---

## Prioridade Recomendada

1. **CRÍTICO** (1-2 semanas)
   - Fase 2: Admin de zonas/regras/origem
   - Fase 4: Integração no checkout

2. **IMPORTANTE** (semana 3)
   - Fase 3: Lista de envios + detalhes
   - Rastreamento público

3. **NICE-TO-HAVE** (mês 2)
   - Mapa interativo
   - Automação/webhooks
   - Notificações

---

## Checklist de Validação Antes de Deploy

### Banco de Dados
- [ ] Tables criadas no Supabase
- [ ] Seed executado (origem + zonas + regras)
- [ ] RLS policies aplicadas
- [ ] Índices criados

### APIs
- [ ] POST /api/shipping/cep funciona (teste com CEP real)
- [ ] POST /api/shipping/calculate funciona
- [ ] GET /api/shipping/zones retorna dados
- [ ] Admin endpoints protegidos por role

### Frontend
- [ ] Checkout mostra frete em tempo real
- [ ] Frete grátis aplicado corretamente
- [ ] Mínimo de pedido validado
- [ ] Shipment criado automaticamente

### Dados
- [ ] Zonas configuradas corretamente
- [ ] Vizinhanças de Natal mapeadas
- [ ] Vizinhanças de Parnamirim mapeadas
- [ ] Regras de preço revisadas

### Testes
- [ ] CEP Candelária (centro): R$ 10
- [ ] CEP Pitimbu (zona expandida): R$ 15
- [ ] CEP Parnamirim (12km): R$ 18
- [ ] Frete grátis acima de R$ 99 (zona 1)
- [ ] Error ao pedir mínimo de R$ 20 (zona 1)

---

## Next Steps

**Próxima tarefa:** Escolha entre Fase 2 ou Fase 4 para começar a implementar.

Recomendação: **Comece pela Fase 4 (Integração Checkout)** pois é mais visível para o cliente.
