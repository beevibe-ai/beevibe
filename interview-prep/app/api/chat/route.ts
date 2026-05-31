import { NextRequest, NextResponse } from 'next/server';
import { chat } from '@/lib/llm';
import { buildSystem, formatDelivery } from '@/lib/prompts';
import type { ChatMessage, ChatRequestBody } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Forwarding raw audio to the model can be disabled (e.g. if your Gemma 4
// endpoint rejects the recorded format). Transcript + delivery signals still flow.
const sendAudio = process.env.SEND_AUDIO !== 'false';

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as Partial<ChatRequestBody>;
    const messages: ChatMessage[] = Array.isArray(body.messages) ? body.messages : [];
    const documents = Array.isArray(body.documents) ? body.documents : [];
    const action = body.action ?? 'respond';

    // Fold the delivery signals into the latest user turn so every provider
    // (audio-capable or not) can coach how the answer was spoken.
    const enriched = [...messages];
    if (body.delivery && enriched.length && enriched[enriched.length - 1].role === 'user') {
      const last = enriched[enriched.length - 1];
      enriched[enriched.length - 1] = {
        ...last,
        content: `${last.content}\n\n${formatDelivery(body.delivery)}`,
      };
    }

    const system = buildSystem(documents, action);
    const audio = sendAudio ? body.audio ?? null : null;
    const content = await chat(system, enriched, audio);

    return NextResponse.json({ content });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'The coach is unavailable.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
