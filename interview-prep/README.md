# Interview Prep Coach

A web app for practicing how you *talk about* your resume and projects — out loud, on a
mock video call, without sounding rehearsed.

You upload your materials, then hop on a call with an AI coach:

1. **It asks** an interview question out loud (grounded in your materials).
2. **You speak** your answer. When you pause, your turn is sent automatically.
3. **The coach hears how you sounded** — pace, filler words ("um"/"like"), long pauses,
   confidence — plus a live transcript, and replies by voice with a concrete line to
   practice ("Try saying it something like this…").
4. **You push back or practice**, all spoken, until it feels natural and like *you*.

The coach is **Gemma 4** (multimodal). It runs either against a **local Ollama** instance
(great for solo dev) or the **Google AI API** (required for a hosted, public deployment),
switched with a single env var.

## How a turn works (the "video call" feel)

- **Self-view webcam** so you get used to being on camera (frames are not analyzed).
- **Open mic with silence detection** — speak naturally; a pause ends your turn. Or hit
  **Done answering**.
- **Live captions** (Chrome/Edge, via the Web Speech API) show your words as you talk.
- **Delivery signals** are computed in-browser every turn — words-per-minute, filler-word
  count, long pauses, duration — and sent to the coach so it critiques *delivery*, not just
  content. This works on every provider, even if your Gemma 4 endpoint can't ingest raw audio.
- **The recorded audio** is also sent (for providers that can hear it, e.g. Google AI) so the
  coach can react to real tone and hesitation.
- **The coach talks back** via the browser's built-in text-to-speech.

---

## Run it locally (Ollama)

```bash
cd interview-prep
cp .env.example .env.local
npm install
npm run dev          # http://localhost:3100  (use Chrome/Edge; allow camera + mic)
```

`.env.local`:

```
LLM_PROVIDER=ollama
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=gemma4         # use the exact tag from `ollama list`
```

> Note: browser camera/mic require a **secure context** — `localhost` counts, so local dev
> works without HTTPS.

---

## Deploying for a broad audience (hosted)

A public deployment **cannot use Ollama** (it's a local process). Point it at the hosted
**Google AI API** so every visitor hits a hosted Gemma 4:

```
LLM_PROVIDER=google
GOOGLE_API_KEY=your_key_here
GOOGLE_MODEL=gemma-4-4b-it   # or a larger Gemma 4 variant for higher quality
SEND_AUDIO=true              # set false if your endpoint rejects the recorded audio format

# Rate limiting — protects your paid API on a public URL
RATE_LIMIT_MAX=30            # model calls per IP per window (0 disables)
RATE_LIMIT_WINDOW_SEC=3600
UPSTASH_REDIS_REST_URL=      # optional, see below
UPSTASH_REDIS_REST_TOKEN=
```

### Vercel (recommended — repo already uses Vercel)

1. Create a Vercel project from this repo and set its **Root Directory** to `interview-prep`.
2. Framework preset: **Next.js** (auto-detected; a `vercel.json` is included).
3. Add the env vars above in **Project Settings → Environment Variables**.
4. Deploy. Vercel serves over **HTTPS**, which the camera, mic, and Web Speech API require.

Notes for hosted serverless:
- Request bodies are kept small (uploads capped at 4 MB/file; spoken-audio clips are tiny).
- The chat route sets `maxDuration = 60` — model responses need Vercel **Pro** to use the
  full 60s; the Hobby tier caps functions at 10s (usually fine for short coach replies).

### Anything that runs a Node server

`npm run build && npm run start` behind an HTTPS reverse proxy works too — just serve it
over TLS and set the same env vars.

### Cost / abuse protection (rate limiting)

The `/api/chat` endpoint — the one that costs money — is **rate limited per IP**
(`RATE_LIMIT_MAX` calls per `RATE_LIMIT_WINDOW_SEC`). Over the limit returns HTTP 429 and the
app shows a friendly "hit the practice limit" message.

- **Out of the box:** a best-effort in-memory limiter (per serverless instance).
- **For a real public launch:** add a free **Upstash Redis** database
  (https://console.upstash.com) and set `UPSTASH_REDIS_REST_URL` /
  `UPSTASH_REDIS_REST_TOKEN`. The limiter then enforces limits **durably across Vercel's
  whole serverless fleet** (the in-memory fallback resets on every cold start and isn't
  shared between instances, so it's only a soft guard). No SDK is added — it uses Upstash's
  REST API directly.

There is still **no login** — anyone with the URL can practice (within the rate limit). Add
accounts later if you need per-user history or stricter control.

---

## How it's built

A self-contained **Next.js 14 (App Router)** app — no database. A call's state lives in the
browser; the backend is stateless.

```
interview-prep/
  app/
    page.tsx              # phase switch: Lobby (upload) ↔ Call
    api/upload/route.ts   # extract text from PDF/DOCX/TXT/MD
    api/chat/route.ts     # build the coach prompt, attach audio + delivery, call the model
  components/
    Lobby.tsx             # upload materials, start the call
    Call.tsx              # webcam, mic VAD, captions, recording, TTS, turn-taking
  lib/
    llm.ts                # provider abstraction (ollama | google), audio attach
    speech.ts             # TTS, speech recognition, delivery-signal computation
    extract.ts            # document text extraction
    prompts.ts            # call-aware coach prompt + directives
    types.ts
```

## Model tags

Set `OLLAMA_MODEL` / `GOOGLE_MODEL` to the exact Gemma 4 identifier available to you
(`ollama list`, or the Google AI model catalog) — the defaults are best guesses.

## Not done yet

User accounts + saved sessions and progress tracking, rate limiting / abuse protection for
public hosting, optional nicer (hosted) TTS voices, and full live-duplex (barge-in)
conversation. All deferred from this focused MVP.
