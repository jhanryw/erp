/**
 * Testes SQL REAIS (Postgres local descartável) da efetivação automática de
 * pagamentos agendados — public.fn_settle_scheduled_payments().
 *
 * Sobe um cluster temporário (initdb/pg_ctl/psql do PATH), recria o schema
 * financeiro com as constraints/trigger de PRODUCAO (auditoria de 18/11/2026)
 * e aplica as migrations REAIS do repositório. Sem Postgres local, a suíte é
 * pulada. Nunca toca o banco de produção.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const has = (bin: string) => {
  try { execFileSync('which', [bin], { stdio: 'ignore' }); return true } catch { return false }
}
const HAS_PG = has('initdb') && has('pg_ctl') && has('psql')

const ENV = { ...process.env, LC_ALL: 'en_US.UTF-8', LANG: 'en_US.UTF-8' }
const PORT = String(55000 + Math.floor(Math.random() * 900))
let dir = ''

function psql(sql: string): string {
  return execFileSync('psql', ['-h', '/tmp', '-p', PORT, '-d', 'postgres', '-X', '-At', '-v', 'ON_ERROR_STOP=1', '-c', sql], { env: ENV, encoding: 'utf8' }).trim()
}
function psqlFile(file: string) {
  execFileSync('psql', ['-h', '/tmp', '-p', PORT, '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', file], { env: ENV, stdio: 'pipe' })
}
function psqlAsync(sql: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn('psql', ['-h', '/tmp', '-p', PORT, '-d', 'postgres', '-X', '-At', '-v', 'ON_ERROR_STOP=1', '-c', sql], { env: ENV })
    let out = ''
    p.stdout.on('data', (d) => (out += d))
    p.on('close', (c) => (c === 0 ? resolve(out.trim()) : reject(new Error(`psql exit ${c}`))))
  })
}

const TODAY = `(now() AT TIME ZONE 'America/Fortaleza')::date`
let seq = 0
function add(o: { co?: number; type?: string; status?: string; paid?: string | null; method?: string | null; ref?: string }): number {
  const status = o.status ?? 'scheduled'
  const paid = o.paid === undefined ? `${TODAY}` : o.paid === null ? 'NULL' : o.paid
  const method = o.method === undefined ? (o.paid === null ? null : 'pix') : o.method
  seq++
  return Number(psql(`INSERT INTO finance_entries (company_id,type,category,description,amount,reference_date,payment_status,paid_at,payment_method)
    VALUES (${o.co ?? 1},'${o.type ?? 'expense'}','taxes','DAS ${seq}',648.66,${o.ref ? `'${o.ref}'` : TODAY},'${status}',${paid},${method ? `'${method}'` : 'NULL'}) RETURNING id`).split('\n')[0])
}
const row = (id: number) => psql(`SELECT payment_status||'|'||COALESCE(paid_at::text,'')||'|'||reference_date||'|'||COALESCE(payment_method::text,'')||'|'||amount||'|'||company_id FROM finance_entries WHERE id=${id}`)
const status = (id: number) => row(id).split('|')[0]
const settle = () => JSON.parse(psql('SELECT public.fn_settle_scheduled_payments()'))

describe.skipIf(!HAS_PG)('fn_settle_scheduled_payments (Postgres real)', () => {
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'pg-settle-'))
    execFileSync('initdb', ['-D', join(dir, 'd'), '-A', 'trust'], { env: ENV, stdio: 'ignore' })
    execFileSync('pg_ctl', ['-D', join(dir, 'd'), '-o', `-p ${PORT} -k /tmp`, '-l', join(dir, 'log'), '-w', 'start'], { env: ENV, stdio: 'ignore' })

    psql(`
      CREATE SCHEMA auth; CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS 'SELECT NULL::uuid';
      CREATE ROLE service_role; CREATE ROLE anon; CREATE ROLE authenticated;
      CREATE TYPE payment_method AS ENUM ('cash','pix','credit_card','debit_card','card');
      CREATE TYPE entry_type AS ENUM ('income','expense');
      CREATE TABLE cash_movements (id bigint PRIMARY KEY);
      CREATE TABLE finance_entries (
        id bigserial PRIMARY KEY, company_id int NOT NULL, type entry_type NOT NULL, category text,
        description text, amount numeric NOT NULL, reference_date date NOT NULL,
        payment_method payment_method, paid_at date,
        cash_movement_id bigint REFERENCES cash_movements(id), sale_id bigint,
        CONSTRAINT finance_entries_amount_positive CHECK (amount > 0),
        CONSTRAINT fe_cash_movement_id_unique UNIQUE (cash_movement_id),
        CONSTRAINT fe_cash_movement_requires_cash_method CHECK (cash_movement_id IS NULL OR payment_method IS NOT NULL),
        CONSTRAINT fe_payment_method_paid_at_together CHECK ((payment_method IS NULL AND paid_at IS NULL) OR (payment_method IS NOT NULL AND paid_at IS NOT NULL)));
      CREATE TABLE audit_logs (id bigserial PRIMARY KEY, ts timestamptz DEFAULT now(), request_id text, user_id uuid,
        user_role text, action text NOT NULL, resource text NOT NULL, resource_id text, before_data jsonb, after_data jsonb,
        detail text, ip_address text, user_agent text);
      CREATE TABLE audit_log (id bigserial PRIMARY KEY, table_name text, record_id text, action text, old_data jsonb, new_data jsonb, user_id uuid, created_at timestamptz);
      CREATE FUNCTION audit_trigger_function() RETURNS trigger AS $f$ BEGIN
        INSERT INTO audit_log (table_name, record_id, action, old_data, new_data, user_id, created_at)
        VALUES (TG_TABLE_NAME, COALESCE(NEW.id::text, OLD.id::text), TG_OP,
          CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) END, CASE WHEN TG_OP<>'DELETE' THEN to_jsonb(NEW) END, auth.uid(), now());
        RETURN COALESCE(NEW, OLD); END; $f$ LANGUAGE plpgsql SECURITY DEFINER;
      CREATE TRIGGER audit_finance AFTER INSERT OR UPDATE OR DELETE ON finance_entries FOR EACH ROW EXECUTE FUNCTION audit_trigger_function();`)
    // 3.121 históricos: paid com paid_at nulo (3.067) e paid com data (54), proporção reduzida
    psql(`INSERT INTO finance_entries (company_id,type,category,description,amount,reference_date)
          SELECT 1,'expense','taxes','legado',10,'2026-01-01' FROM generate_series(1,30)`)
    psql(`INSERT INTO finance_entries (company_id,type,category,description,amount,reference_date,paid_at,payment_method)
          SELECT 1,'expense','taxes','pago',10,'2026-01-01','2026-01-02','pix' FROM generate_series(1,5)`)
    for (const f of ['202610011000_finance_entries_payment_status.sql', '202611181000_finance_entries_scheduled_status.sql', '202611191000_fn_settle_scheduled_payments.sql']) {
      const p = join(dir, f)
      execFileSync('cp', [join(process.cwd(), 'supabase/migrations', f), p])
      psqlFile(p)
    }
  }, 60_000)

  afterAll(() => {
    try { execFileSync('pg_ctl', ['-D', join(dir, 'd'), '-m', 'immediate', 'stop'], { env: ENV, stdio: 'ignore' }) } catch { /* noop */ }
    rmSync(dir, { recursive: true, force: true })
  })

  it('data futura NÃO é efetivada antecipadamente', () => {
    const id = add({ paid: `${TODAY} + 1` })
    settle()
    expect(status(id)).toBe('scheduled')
  })

  it('data de hoje é efetivada, preservando paid_at, vencimento, forma e valor', () => {
    const id = add({ paid: `${TODAY}`, ref: '2026-11-10', method: 'pix' })
    const before = row(id).split('|').slice(1)
    settle()
    const after = row(id).split('|')
    expect(after[0]).toBe('paid')
    expect(after.slice(1)).toEqual(before) // paid_at, reference_date, method, amount, company intactos
  })

  it('data anterior a hoje (catch-up) é efetivada mantendo a data programada', () => {
    const id = add({ paid: `${TODAY} - 3` })
    const paidAt = row(id).split('|')[1]
    settle()
    expect(status(id)).toBe('paid')
    expect(row(id).split('|')[1]).toBe(paidAt)
  })

  it('cancelado (pending) e confirmado manualmente (paid) não são processados', () => {
    const canceled = add({ status: 'pending', paid: null })
    const manual = add({ status: 'paid', paid: `${TODAY} - 1` })
    const manualBefore = row(manual)
    const r = settle()
    expect(status(canceled)).toBe('pending')
    expect(row(canceled).split('|')[1]).toBe('')
    expect(row(manual)).toBe(manualBefore)
    expect(r.settled).toBe(0)
  })

  it('reagendado respeita a nova data', () => {
    const id = add({ paid: `${TODAY}` })
    psql(`UPDATE finance_entries SET paid_at = ${TODAY} + 5 WHERE id=${id}`) // reagendar
    settle()
    expect(status(id)).toBe('scheduled')
    psql(`UPDATE finance_entries SET paid_at = ${TODAY} WHERE id=${id}`)
    settle()
    expect(status(id)).toBe('paid')
  })

  it('execuções repetidas não duplicam lançamentos nem auditoria', () => {
    const id = add({ paid: `${TODAY}` })
    const total = () => Number(psql('SELECT count(*) FROM finance_entries'))
    const n = total()
    expect(settle().settled).toBeGreaterThanOrEqual(1)
    const audits = () => Number(psql(`SELECT count(*) FROM audit_logs WHERE resource_id='${id}'`))
    expect(audits()).toBe(1)
    expect(settle().settled).toBe(0)
    expect(settle().settled).toBe(0)
    expect(total()).toBe(n) // nenhum lançamento novo
    expect(audits()).toBe(1)
  })

  it('auditoria identifica o sistema', () => {
    const id = add({ paid: `${TODAY}` })
    settle()
    const a = psql(`SELECT user_id IS NULL, user_role, action, resource, detail FROM audit_logs WHERE resource_id='${id}'`)
    expect(a).toContain('t|system|update|finance_entry|agendamento:auto_confirm')
  })

  it('receitas, pendentes, legados e lançamentos já pagos permanecem inalterados', () => {
    // receita com paid_at vencido não pode existir como scheduled (constraint) — força pending/paid
    const income = add({ type: 'income', status: 'paid', paid: `${TODAY} - 2` })
    const pending = add({ status: 'pending', paid: null, ref: '2026-01-01' })
    const snap = () => psql(`SELECT md5(string_agg(t::text, ',' ORDER BY id)) FROM finance_entries t WHERE id IN (${income},${pending}) OR description IN ('legado','pago')`)
    const before = snap()
    settle()
    expect(snap()).toBe(before)
    expect(Number(psql(`SELECT count(*) FROM finance_entries WHERE description='legado' AND payment_status='paid' AND paid_at IS NULL`))).toBe(30)
  })

  it('o constraint do banco impede agendar receita ou agendado vinculado ao Caixa', () => {
    expect(() => add({ type: 'income', status: 'scheduled' })).toThrow()
    psql('INSERT INTO cash_movements VALUES (999)')
    expect(() => psql(`INSERT INTO finance_entries (company_id,type,amount,reference_date,payment_status,paid_at,payment_method,cash_movement_id)
      VALUES (1,'expense',1,${TODAY},'scheduled',${TODAY},'cash',999)`)).toThrow()
  })

  it('multiempresa: processa cada empresa sem misturar dados', () => {
    const a = add({ co: 10, paid: `${TODAY}` })
    const b = add({ co: 20, paid: `${TODAY}` })
    const c = add({ co: 20, paid: `${TODAY} + 2` })
    const r = settle()
    expect(r.by_company).toMatchObject({ '10': 1, '20': 1 })
    expect(status(a)).toBe('paid'); expect(status(b)).toBe('paid'); expect(status(c)).toBe('scheduled')
    expect(row(a).endsWith('|10')).toBe(true)
    expect(row(b).endsWith('|20')).toBe(true)
    const audit = psql(`SELECT detail FROM audit_logs WHERE resource_id='${a}'`)
    expect(audit).toContain('company_id=10')
  })

  it('concorrência: confirmação manual em curso não é duplicada nem corrompida', async () => {
    const id = add({ paid: `${TODAY}` })
    const manual = psqlAsync(`BEGIN; UPDATE finance_entries SET payment_status='paid' WHERE id=${id} AND payment_status='scheduled'; SELECT pg_sleep(1.5); COMMIT;`)
    await new Promise((r) => setTimeout(r, 500))
    const job = JSON.parse(await psqlAsync('SELECT public.fn_settle_scheduled_payments()'))
    await manual
    expect(status(id)).toBe('paid')
    expect(Number(psql(`SELECT count(*) FROM audit_logs WHERE resource_id='${id}'`))).toBe(0) // job pulou (SKIP LOCKED)
    expect(job.by_company['1'] ?? 0).toBeGreaterThanOrEqual(0)
  })

  it('concorrência: cancelamento em curso vence — o job não efetiva', async () => {
    const id = add({ paid: `${TODAY}` })
    const cancel = psqlAsync(`BEGIN; UPDATE finance_entries SET payment_status='pending', paid_at=NULL, payment_method=NULL WHERE id=${id} AND payment_status='scheduled'; SELECT pg_sleep(1.5); COMMIT;`)
    await new Promise((r) => setTimeout(r, 500))
    await psqlAsync('SELECT public.fn_settle_scheduled_payments()')
    await cancel
    expect(status(id)).toBe('pending')
  })

  it('concorrência: dois jobs simultâneos efetivam uma única vez', async () => {
    const id = add({ paid: `${TODAY}` })
    await Promise.all([psqlAsync('SELECT public.fn_settle_scheduled_payments()'), psqlAsync('SELECT public.fn_settle_scheduled_payments()')])
    expect(status(id)).toBe('paid')
    expect(Number(psql(`SELECT count(*) FROM audit_logs WHERE resource_id='${id}'`))).toBe(1)
  })

  it('fluxo de caixa e dashboard: sai da previsão de agendados e entra no caixa realizado', () => {
    // Mesmos predicados de financeiro/fluxo/page.tsx e dashboard/page.tsx
    const month = `date_trunc('month', ${TODAY})::date`
    const scheduledForecast = () => psql(`SELECT COALESCE(sum(amount),0) FROM finance_entries WHERE company_id=77 AND payment_status='scheduled' AND paid_at >= ${month} AND paid_at < ${month} + interval '1 month'`)
    const realized = () => psql(`SELECT COALESCE(sum(amount),0) FROM finance_entries WHERE company_id=77 AND payment_status='paid' AND ((paid_at >= ${month} AND paid_at < ${month} + interval '1 month') OR (paid_at IS NULL AND reference_date >= ${month}))`)
    add({ co: 77, paid: `${TODAY}` })
    expect(scheduledForecast()).toBe('648.66')
    expect(realized()).toBe('0')
    settle()
    expect(scheduledForecast()).toBe('0')
    expect(realized()).toBe('648.66')
  })

  it('a migration de cron só referencia a função e o horário esperados', () => {
    const sql = readFileSync(join(process.cwd(), 'supabase/migrations/202611191100_cron_settle_scheduled_payments.sql'), 'utf8')
    expect(sql).toContain("'5 3 * * *'") // 00:05 America/Fortaleza
    expect(sql).toContain('fn_settle_scheduled_payments()')
  })
})
