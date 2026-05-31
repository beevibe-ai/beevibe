import { NextRequest, NextResponse } from 'next/server';
import { chat } from '@/lib/llm';
import { buildSystem } from '@/lib/prompts';
import type { ChatRequestBody } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as Partial<ChatRequestBody>;
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const documents = Array.isArray(body.documents) ? body.documents : [];
    const action = body.action ?? 'freeform';

    const system = buildSystem(documents, action);
    const content = await chat(system, messages);

    return NextResponse.json({ content });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'The coach is unavailable.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
