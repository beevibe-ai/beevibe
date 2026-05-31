import { NextRequest, NextResponse } from 'next/server';
import { chat } from '@/lib/llm';
import { buildSystem, formatDelivery } from '@/lib/prompts';
import { clientIp, rateLimit } from '@/lib/rate-limit';
import type { ChatMessage, ChatRequestBody } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Off by default: the hosted Gemini API Gemma 4 models (26b-a4b, 31b) are
// text+image only and reject audio. Enable only with an audio-capable variant
// (local E2B/E4B, audio <= 30s). Transcript + delivery signals always flow.
const sendAudio = process.env.SEND_AUDIO === 'true';

export async function POST(req: NextRequest) {
  // Protect the paid model endpoint from runaway cost/abuse on a public URL.
  const rl = await rateLimit(clientIp(req));
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "You've hit the practice limit for now — give it a little while and try again." },
      { status: 429, headers: { 'Retry-After': String(rl.resetSec) } },
    );
  }

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
