import { z } from 'zod'

export const domainIdSchema = z.string().trim().regex(/^([A-Z]{3}-)?[A-Z0-9_]{2,80}$/, 'Domínio inválido.')

export const attributeValueSchema = z.object({
  id: z.string().trim().min(1).max(80),
  value_id: z.string().trim().max(80).nullable().optional(),
  value_name: z.string().trim().max(255).nullable().optional(),
})

export const templateBodySchema = z.object({
  domain_id: domainIdSchema,
  attributes: z.array(attributeValueSchema).max(200).default([]),
})

const cellSchema = z.object({
  value_id: z.string().trim().max(80).nullable().optional(),
  value_name: z.string().trim().max(255).nullable().optional(),
})

export const createChartBodySchema = z.object({
  domain_id: domainIdSchema,
  name: z.string().trim().min(1, 'Informe o nome da tabela.').max(120),
  measure_type: z.enum(['BODY_MEASURE', 'CLOTHING_MEASURE']).nullable().optional(),
  main_attribute_id: z.string().trim().regex(/^[A-Z0-9_]{1,80}$/, 'Atributo principal inválido.'),
  attributes: z.array(attributeValueSchema).max(100).default([]),
  rows: z.array(z.record(z.string().regex(/^[A-Z0-9_]{1,80}$/), cellSchema)).min(1, 'Adicione ao menos um tamanho.').max(75),
})
