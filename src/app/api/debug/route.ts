import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

export async function GET() {
  return NextResponse.json(
    { error: 'Debug route disabled in this environment.' },
    { status: 403 }
  )
}