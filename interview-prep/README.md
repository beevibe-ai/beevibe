# Interview Prep Coach

A small standalone web app for practicing how you *talk about* your resume and
projects — out loud, in rounds, without rote memorisation.

You upload your materials (resume, project notes), and an AI coach runs you
through practice rounds:

1. **It asks** one interview question grounded in your materials.
2. **You answer** — type or paste your spoken attempt (stumbles welcome).
3. **It gives you a concrete line to practice** — a short, first-person answer
   you can actually say, marked `Suggested answer to practice:`.
4. **You disagree?** Discuss it. Tell the coach what you'd rather emphasise and
   it revises the suggestion with you.
5. **You practice the delivery**, it gives you one or two tweaks, and you move
   on to the next question.

It runs **Gemma** as the coach, and you can point it at either a **local Ollama**
instance or the **Google AI API** with a single env var.

---

## Quick start

```bash
cd interview-prep
cp .env.example .env.local      # then edit it (see below)
npm install
npm run dev                     # http://localhost:3100
```

### Option A — Local with Ollama (free, private)

```bash
# Install Ollama from https://ollama.com, then pull your Gemma model:
ollama pull gemma4              # use the exact tag from `ollama list`
```

`.env.local`:

```
LLM_PROVIDER=ollama
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=gemma4
```

### Option B — Google AI API (hosted)

Get a key at https://aistudio.google.com/apikey.

`.env.local`:

```
LLM_PROVIDER=google
GOOGLE_API_KEY=your_key_here
GOOGLE_MODEL=gemma-4-4b-it
```

> **Model tags:** set `OLLAMA_MODEL` / `GOOGLE_MODEL` to the exact Gemma model
> identifier available to you. The defaults assume Gemma 4 — confirm the precise
> tag (`ollama list`, or the Google AI model catalog) and adjust if needed.

---

## How it's built

A single self-contained **Next.js 14 (App Router)** app — no database, no login.
Everything for a practice session lives in the browser; the server is stateless.

```
interview-prep/
  app/
    page.tsx              # the whole UI: upload + practice loop
    api/upload/route.ts   # extracts text from uploaded PDF/DOCX/TXT/MD
    api/chat/route.ts     # builds the coach prompt, calls the model
  lib/
    llm.ts                # provider abstraction (ollama | google)
    extract.ts            # document text extraction
    prompts.ts            # coach system prompt + per-turn directives
    types.ts
```

- **Documents** are parsed server-side once on upload; the extracted text is
  held in the browser and sent with each turn, so the model always has your
  resume/project context.
- **Each round** sends an explicit `action` (`question`, `answer`, `discuss`,
  `practice`) so even a small model reliably does the right thing that turn.
- **Supported uploads:** PDF, DOCX, TXT, Markdown (10 MB/file, trimmed to keep
  prompts small).

## Notes & next steps

This is the focused MVP: single user, no accounts, session lives in the tab.
Natural follow-ups when you want them: user accounts + saved sessions, voice
input/output for true out-loud practice, progress tracking across questions,
and streaming responses.
