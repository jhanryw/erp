-- =============================================================================
-- SHIPPING MODULE INITIAL DATA SEED
-- =============================================================================

-- Inserir origem (Santtorini / Candelária, Natal)
INSERT INTO shipping_origins (name, cep, street, number, complement, neighborhood, city, state, latitude, longitude) VALUES
  ('Santtorini / Natture', '59066400', 'Rua Candelária', '100', 'Apto 1001', 'Candelária', 'Natal', 'RN', -5.7942, -35.2080)
ON CONFLICT DO NOTHING;

-- ZONA 1: Natal Central até 6km (intra-urbano)
INSERT INTO shipping_zones (name, description, state, city, neighborhoods_json, min_km, max_km, color, priority, is_active) VALUES
  ('Natal Central', 'Delivery em Natal até 6km', 'RN', 'Natal', '["Candelária", "Praia do Meio", "Ribeira", "Alecrim", "Cidade Alta", "Petrópolis", "Tirol", "Lagoa Seca"]'::jsonb, 0, 6, '#10b981', 10, TRUE)
ON CONFLICT (name) DO NOTHING;

-- ZONA 2: Natal Expandida de 6 a 10km
INSERT INTO shipping_zones (name, description, state, city, neighborhoods_json, min_km, max_km, color, priority, is_active) VALUES
  ('Natal Expandida', 'Delivery em Natal de 6 a 10km', 'RN', 'Natal', '["Pitimbu", "Quintas", "Necrópolis", "Ponta Negra", "Mãe Luíza", "Areia Preta", "Bom Pastor", "Rocas"]'::jsonb, 6, 10, '#3b82f6', 20, TRUE)
ON CONFLICT (name) DO NOTHING;

-- ZONA 3: Parnamirim Central até 12km
INSERT INTO shipping_zones (name, description, state, city, neighborhoods_json, min_km, max_km, color, priority, is_active) VALUES
  ('Parnamirim Central', 'Delivery em Parnamirim até 12km', 'RN', 'Parnamirim', '["Centro", "São Cristóvão", "Pitimbu", "Igapó"]'::jsonb, 0, 12, '#f59e0b', 30, TRUE)
ON CONFLICT (name) DO NOTHING;

-- ZONA 4: Parnamirim Expandida de 12 a 15km
INSERT INTO shipping_zones (name, description, state, city, neighborhoods_json, min_km, max_km, color, priority, is_active) VALUES
  ('Parnamirim Expandida', 'Delivery em Parnamirim de 12 a 15km', 'RN', 'Parnamirim', '["Pium", "Lagoa Azul", "Gramorezinho"]'::jsonb, 12, 15, '#8b5cf6', 40, TRUE)
ON CONFLICT (name) DO NOTHING;

-- REGRAS para as zonas (usando INSERT com SELECT para pegar o zone_id dinamicamente)
INSERT INTO shipping_rules (zone_id, rule_type, client_price, internal_cost, estimated_hours, free_shipping_min_order, min_order_to_enable, allow_pickup, allow_delivery, is_active)
SELECT z.id, 'zone', 10.00, 15.00, 24, 99.00, 20.00, FALSE, TRUE, TRUE FROM shipping_zones z WHERE z.name = 'Natal Central'
ON CONFLICT DO NOTHING;

INSERT INTO shipping_rules (zone_id, rule_type, client_price, internal_cost, estimated_hours, free_shipping_min_order, min_order_to_enable, allow_pickup, allow_delivery, is_active)
SELECT z.id, 'zone', 15.00, 18.00, 24, 129.00, 20.00, FALSE, TRUE, TRUE FROM shipping_zones z WHERE z.name = 'Natal Expandida'
ON CONFLICT DO NOTHING;

INSERT INTO shipping_rules (zone_id, rule_type, client_price, internal_cost, estimated_hours, free_shipping_min_order, min_order_to_enable, allow_pickup, allow_delivery, is_active)
SELECT z.id, 'zone', 18.00, 20.00, 48, 149.00, 30.00, FALSE, TRUE, TRUE FROM shipping_zones z WHERE z.name = 'Parnamirim Central'
ON CONFLICT DO NOTHING;

INSERT INTO shipping_rules (zone_id, rule_type, client_price, internal_cost, estimated_hours, free_shipping_min_order, min_order_to_enable, allow_pickup, allow_delivery, is_active)
SELECT z.id, 'zone', 22.00, 25.00, 48, 199.00, 50.00, FALSE, TRUE, TRUE FROM shipping_zones z WHERE z.name = 'Parnamirim Expandida'
ON CONFLICT DO NOTHING;
