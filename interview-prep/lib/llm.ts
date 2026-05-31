import type { AudioClip, ChatMessage } from './types';

export type Provider = 'ollama' | 'google';

export function getProvider(): Provider {
  return process.env.LLM_PROVIDER === 'google' ? 'google' : 'ollama';
}

export function getModelLabel(): string {
  return getProvider() === 'google'
    ? process.env.GOOGLE_MODEL || 'gemma-4-4b-it'
    : process.env.OLLAMA_MODEL || 'gemma4';
}

/**
 * Single entry point used by the API routes. Takes a system prompt plus the
 * running conversation and returns the assistant's reply text. The provider is
 * selected at runtime from LLM_PROVIDER so the same code path works locally
 * (Ollama) or hosted (Google AI).
 *
 * `audio`, when present, is the candidate's spoken turn. It is attached to the
 * latest user message for multimodal models that can hear it (Google AI). The
 * transcript + delivery signals already in the message text carry the content
 * regardless, so providers that can't ingest audio still work.
 */
export async function chat(
  system: string,
  messages: ChatMessage[],
  audio?: AudioClip | null,
): Promise<string> {
  return getProvider() === 'google'
    ? chatGoogle(system, messages, audio)
    : chatOllama(system, messages);
}

async function chatOllama(system: string, messages: ChatMessage[]): Promise<string> {
  const base = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
  const model = process.env.OLLAMA_MODEL || 'gemma4';

  let res: Response;
  try {
    res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        messages: [{ role: 'system', content: system }, ...messages],
        options: { temperature: 0.7 },
      }),
    });
  } catch {
    throw new Error(
      `Could not reach Ollama at ${base}. Start it with "ollama serve" and make sure "${model}" is pulled (ollama pull ${model}).`,
    );
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(
      `Ollama request failed (${res.status}). Is Ollama running and "${model}" pulled? ${detail}`,
    );
  }

  const data = (await res.json()) as { message?: { content?: string } };
  return data.message?.content?.trim() ?? '';
}

type GooglePart = { text?: string; inlineData?: { mimeType: string; data: string } };

async function chatGoogle(
  system: string,
  messages: ChatMessage[],
  audio?: AudioClip | null,
): Promise<string> {
  const key = process.env.GOOGLE_API_KEY;
  if (!key) throw new Error('GOOGLE_API_KEY is not set (LLM_PROVIDER=google).');
  const model = process.env.GOOGLE_MODEL || 'gemma-4-4b-it';

  // Gemma models on the Google API do not accept a separate system instruction,
  // so we fold the system prompt into the first user turn for broad
  // compatibility across both Gemma and Gemini models.
  const source: ChatMessage[] = messages.length
    ? messages
    : [{ role: 'user', content: "Let's begin." }];

  const contents: Array<{ role: 'user' | 'model'; parts: GooglePart[] }> = [];
  let systemInjected = false;
  for (const m of source) {
    const role = m.role === 'assistant' ? 'model' : 'user';
    let text = m.content;
    if (!systemInjected && role === 'user') {
      text = `${system}\n\n---\n\n${text}`;
      systemInjected = true;
    }
    contents.push({ role, parts: [{ text }] });
  }
  if (!systemInjected) {
    contents.unshift({ role: 'user', parts: [{ text: system }] });
  }

  // Attach the spoken audio to the most recent user turn so the model can hear it.
  if (audio) {
    for (let i = contents.length - 1; i >= 0; i--) {
      if (contents[i].role === 'user') {
        contents[i].parts.push({ inlineData: { mimeType: audio.mimeType, data: audio.data } });
        break;
      }
    }
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents, generationConfig: { temperature: 0.7 } }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Google AI request failed (${res.status}). ${detail}`);
  }

  const data = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const parts = data.candidates?.[0]?.content?.parts ?? [];
  return parts
    .map((p) => p.text ?? '')
    .join('')
    .trim();
}
