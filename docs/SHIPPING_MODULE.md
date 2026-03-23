# Módulo de Frete/Logística - Santtorini ERP

## Visão Geral

Sistema completo de cálculo automático de frete baseado em CEP, região, distância e valor do pedido. Integrado com Next.js 14, Supabase e APIs de geocodificação.

## Arquitetura

### 1. Database Schema

#### Tabelas Principais

- **shipping_origins**: Pontos de origem (depósitos/estoques)
- **shipping_zones**: Regiões de entrega (Natal Central, Natal Expandida, Parnamirim, etc)
- **shipping_rules**: Regras de preço por zona (tabela de preços)
- **customer_addresses**: Endereços dos clientes
- **shipments**: Histórico de envios dos pedidos
- **shipment_events**: Eventos de rastreamento

### 2. Serviços (Services Layer)

#### `src/lib/services/cepService.ts`
- `fetchCEP(cep: string)`: Busca dados de um CEP via ViaCEP API

#### `src/lib/services/geocodingService.ts`
- `geocodeAddress(address: string)`: Converte endereço em coordenadas (Nominatim/OSM)
- `calculateDistance(lat1, lon1, lat2, lon2)`: Calcula distância em km (Haversine)

#### `src/lib/services/shippingCalculatorService.ts`
- `calculateShipping(...)`: Calcula frete automático com precedência:
  1. CEP range (faixa de CEP)
  2. Neighborhood + City (bairro + cidade)
  3. Distance range (faixa de distância)

### 3. API Endpoints

#### Públicos (Cliente/Checkout)
```
POST /api/shipping/cep
  Input: { cep: string }
  Output: { street, neighborhood, city, state, latitude, longitude }

POST /api/shipping/calculate
  Input: { latitude, longitude, cep, city, neighborhood, order_total }
  Output: { client_price, internal_cost, subsidy, zone_id, reason, etc }

GET /api/shipping/zones
  Output: Lista de zonas ativas
```

#### Admin (Gerenciamento)
```
GET/POST /api/shipping/admin/origins
GET/PATCH/DELETE /api/shipping/admin/origins/[id]

GET/POST /api/shipping/admin/zones
GET/PATCH/DELETE /api/shipping/admin/zones/[id]

GET/POST /api/shipping/admin/rules
GET/PATCH/DELETE /api/shipping/admin/rules/[id]
```

## Configuração Inicial

### Passo 1: Executar Migration SQL

Execute o código SQL em `DATABASE_SCHEMA.sql` na seção "SHIPPING MODULE":

```bash
# Via Supabase Console ou pgAdmin
supabase migration up
```

### Passo 2: Inserir Dados Iniciais

Execute o seed em `src/lib/seeds/shipping-seed.sql`:

```sql
-- Copie o conteúdo e execute no Supabase Console (SQL Editor)
```

Isso criará:
- 1 origem (Candelária, Natal)
- 4 zonas de entrega (Natal Central, Natal Expandida, Parnamirim Central, Parnamirim Expandida)
- 4 regras de frete (preços por zona)

### Passo 3: Variáveis de Ambiente

Certifique-se que estão setadas em `.env.local`:
```
NEXT_PUBLIC_SUPABASE_URL=https://xxxxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=xxxxx
SUPABASE_SERVICE_ROLE_KEY=xxxxx
```

## Logística de Frete - Tabela Padrão

### Zonas de Entrega

| Zona | Bairros | Distância | Preço Cliente | Custo Interno | Frete Grátis a partir de | Mínimo Pedido |
|------|---------|-----------|---------------|---|---|---|
| Natal Central | Candelária, Praia do Meio, Ribeira, etc | 0-6km | R$ 10 | R$ 15 | R$ 99 | R$ 20 |
| Natal Expandida | Pitimbu, Quintas, Ponta Negra, etc | 6-10km | R$ 15 | R$ 18 | R$ 129 | R$ 20 |
| Parnamirim Central | Centro, São Cristóvão, Igapó | 0-12km | R$ 18 | R$ 20 | R$ 149 | R$ 30 |
| Parnamirim Expandida | Pium, Lagoa Azul, Gramorezinho | 12-15km | R$ 22 | R$ 25 | R$ 199 | R$ 50 |

### Modelo de Negócio

- **Client Price**: O que o cliente paga pelo frete
- **Internal Cost**: Custo real operacional
- **Subsidy**: (Internal Cost - Client Price) = Quanto a empresa subsidia
- **Free Shipping Min Order**: Valor mínimo para frete grátis
- **Min Order to Enable**: Pedido mínimo para permitir entrega naquela zona

## Fluxo de Cálculo de Frete

```
1. Cliente digita CEP no checkout
   ↓
2. Sistema chama POST /api/shipping/cep
   → Busca dados no ViaCEP
   → Geocodifica endereço (Nominatim)
   → Retorna { cep, street, neighborhood, city, state, latitude, longitude }
   ↓
3. Sistema chama POST /api/shipping/calculate
   Input: latitude, longitude, CEP, city, neighborhood, order_total
   ↓
4. calculateShipping() busca zona/regra por prioridade:
   - Verifica CEP ranges primeiro
   - Depois neighborhood + city
   - Depois distance ranges
   ↓
5. Calcula preço:
   - Se order_total >= free_shipping_min_order → client_price = 0
   - Se order_total < min_order_to_enable → erro (mínimo não atingido)
   ↓
6. Retorna { client_price, internal_cost, subsidy, zone_id, distance_km, reason }
   ↓
7. Checkout exibe o frete ao cliente
   ↓
8. Após criar pedido, cria shipment com dados do frete
```

## Tipos TypeScript

Todos os tipos estão em `src/types/shipping.types.ts`:

```typescript
type DeliveryMode = 'pickup' | 'delivery'
type ShipmentStatus = 'aguardando_confirmacao' | 'pronto_envio' | 'saiu_entrega' | 'entregue' | ...

interface ShippingZone { id, name, neighborhoods_json, min_km, max_km, priority, ... }
interface ShippingRule { zone_id, client_price, internal_cost, free_shipping_min_order, ... }
interface ShippingCalculationResult { delivery_mode, zone_id, distance_km, client_price, ... }
```

## Implementação no Checkout

### Exemplo de Integração (React Component)

```typescript
// app/checkout/page.tsx
const [shippingCost, setShippingCost] = useState(0)

async function handleCepChange(cep: string) {
  // 1. Buscar dados do CEP
  const cepRes = await fetch('/api/shipping/cep', {
    method: 'POST',
    body: JSON.stringify({ cep })
  })
  const cepData = await cepRes.json()

  // 2. Calcular frete
  const shippingRes = await fetch('/api/shipping/calculate', {
    method: 'POST',
    body: JSON.stringify({
      latitude: cepData.latitude,
      longitude: cepData.longitude,
      cep: cepData.cep,
      city: cepData.city,
      neighborhood: cepData.neighborhood,
      order_total: cartTotal
    })
  })
  const shippingData = await shippingRes.json()

  if ('error' in shippingData) {
    // Exibir mensagem de erro
  } else {
    setShippingCost(shippingData.client_price)
    // Armazenar dados para criar shipment depois
  }
}
```

## Estrutura de Dados do Frete

### Ao Criar Pedido

```typescript
// Salvar na tabela shipments
{
  order_id: order.id,
  customer_id: order.customer_id,
  address_id: selectedAddress.id,
  origin_id: 1,  // Santtorini / Natture
  zone_id: 2,    // Natal Expandida
  rule_id: 5,    // Regra da zona
  delivery_mode: 'delivery',
  distance_km: 7.5,
  client_shipping_price: 15.00,
  internal_shipping_cost_estimated: 18.00,
  shipping_subsidy: 3.00,
  status: 'aguardando_confirmacao'
}
```

### Rastreamento (shipment_events)

Cada mudança de status cria um evento:

```
aguardando_confirmacao → Pedido confirmado
→ aguardando_separacao → Iniciando separação
→ pronto_envio → Pronto para sair
→ saiu_entrega → Saiu para entrega
→ entregue → Entregue ao cliente
```

## Estender para Outras Regiões

Para adicionar novas zonas/regiões:

```bash
# 1. Criar zona via API:
curl -X POST http://localhost:3000/api/shipping/admin/zones \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Areia Branca Expandida",
    "city": "Areia Branca",
    "neighborhoods_json": ["Centro", "Praia"],
    "min_km": 80,
    "max_km": 100,
    "priority": 50
  }'

# 2. Criar regra de frete para a zona:
curl -X POST http://localhost:3000/api/shipping/admin/rules \
  -H "Content-Type: application/json" \
  -d '{
    "zone_id": 5,
    "client_price": 35.00,
    "internal_cost": 40.00,
    "free_shipping_min_order": 250.00
  }'
```

## Queries SQL Úteis

### Listar todos os envios por status
```sql
SELECT s.id, s.order_id, s.status, sz.name, sr.client_price
FROM shipments s
JOIN shipping_zones sz ON s.zone_id = sz.id
JOIN shipping_rules sr ON s.rule_id = sr.id
WHERE s.status = 'pronto_envio'
ORDER BY s.created_at;
```

### Custo total de subsídio por zona
```sql
SELECT sz.name, COUNT(*) as qty, SUM(s.shipping_subsidy) as total_subsidy
FROM shipments s
JOIN shipping_zones sz ON s.zone_id = sz.id
WHERE s.created_at >= NOW() - INTERVAL '30 days'
GROUP BY sz.id, sz.name
ORDER BY total_subsidy DESC;
```

### Cobertura de entrega por CEP
```sql
SELECT DISTINCT
  SUBSTRING(ca.cep, 1, 5) as cep_range,
  ca.neighborhood,
  ca.city,
  COUNT(*) as deliveries,
  AVG(s.distance_km) as avg_distance
FROM shipments s
JOIN customer_addresses ca ON s.address_id = ca.id
WHERE s.status = 'entregue'
GROUP BY cep_range, ca.neighborhood, ca.city
ORDER BY deliveries DESC;
```

## Próximas Fases (Futura)

- [ ] Integração com APIs de courier (ViaCEP Frete, Correios, Loggi)
- [ ] Cálculo automático de frete por peso/volume
- [ ] Dashboard de rastreamento em tempo real
- [ ] Webhooks para atualizar status de envio
- [ ] Notificações automáticas para cliente
- [ ] Relatórios de rentabilidade por zona
- [ ] Machine learning para otimizar zonas baseado em histórico

## Troubleshooting

### "Origem de envio não configurada"
→ Execute o seed `shipping-seed.sql` ou insira manualmente uma origem

### "Zonas de envio não configuradas"
→ Execute o seed ou crie zonas via API /admin/zones

### CEP não encontrado
→ ViaCEP pode estar down. O serviço retorna `null` gracefully.

### Frete muito caro/barato
→ Revise a tabela `shipping_rules` e ajuste `client_price` e `internal_cost`

## Links Úteis

- ViaCEP API: https://viacep.com.br/
- Nominatim (Geocoding): https://nominatim.openstreetmap.org/
- Haversine Formula: https://en.wikipedia.org/wiki/Haversine_formula
