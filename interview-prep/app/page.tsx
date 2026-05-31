'use client';

import { useRef, useState } from 'react';
import type { Action, ChatMessage, DocText } from '@/lib/types';

export default function Home() {
  const [documents, setDocuments] = useState<DocText[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [started, setStarted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  function scrollToEnd() {
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
    });
  }

  async function handleUpload(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;
    setError(null);
    setUploading(true);
    try {
      const form = new FormData();
      Array.from(fileList).forEach((f) => form.append('files', f));
      const res = await fetch('/api/upload', { method: 'POST', body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed.');
      setDocuments((prev) => mergeDocs(prev, data.documents as DocText[]));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed.');
    } finally {
      setUploading(false);
    }
  }

  async function send(action: Action, includeInput: boolean) {
    if (loading) return;
    const text = input.trim();
    if (includeInput && !text) return;

    setError(null);
    const outgoing: ChatMessage[] =
      includeInput && text ? [...messages, { role: 'user', content: text }] : messages;
    setMessages(outgoing);
    if (includeInput) setInput('');
    setStarted(true);
    setLoading(true);
    scrollToEnd();

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: outgoing, documents, action }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'The coach is unavailable.');
      setMessages([...outgoing, { role: 'assistant', content: data.content }]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The coach is unavailable.');
    } finally {
      setLoading(false);
      scrollToEnd();
    }
  }

  function onComposerKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Ctrl/Cmd+Enter submits the current text as an answer.
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      send('answer', true);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col gap-6 px-4 py-8 sm:px-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Interview Prep Coach</h1>
        <p className="text-sm text-slate-500">
          Upload your resume and project notes, then practice out loud. The coach asks, you
          answer, it gives you a concrete line to practice — and you can push back until it
          feels like you.
        </p>
      </header>

      <section className="grid grid-cols-1 gap-6 lg:grid-cols-[280px_1fr]">
        {/* Documents panel */}
        <aside className="flex flex-col gap-3">
          <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <h2 className="text-sm font-semibold text-slate-700">Your materials</h2>
            <p className="mt-1 text-xs text-slate-500">
              PDF, DOCX, TXT, or Markdown. Resume + a few project files work best.
            </p>

            <label className="mt-3 flex cursor-pointer items-center justify-center rounded-lg border border-dashed border-slate-300 bg-slate-50 px-3 py-4 text-center text-sm text-slate-600 transition hover:border-slate-400 hover:bg-slate-100">
              <input
                type="file"
                multiple
                accept=".pdf,.docx,.txt,.md,.markdown"
                className="hidden"
                disabled={uploading}
                onChange={(e) => {
                  handleUpload(e.target.files);
                  e.target.value = '';
                }}
              />
              {uploading ? 'Reading files…' : 'Click to upload files'}
            </label>

            {documents.length > 0 && (
              <ul className="mt-3 flex flex-col gap-1.5">
                {documents.map((d) => (
                  <li
                    key={d.name}
                    className="flex items-center justify-between gap-2 rounded-md bg-slate-50 px-2.5 py-1.5 text-xs"
                  >
                    <span className="truncate text-slate-700" title={d.name}>
                      {d.name}
                    </span>
                    <button
                      className="shrink-0 text-slate-400 hover:text-red-500"
                      onClick={() =>
                        setDocuments((prev) => prev.filter((p) => p.name !== d.name))
                      }
                      aria-label={`Remove ${d.name}`}
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-4 text-xs text-slate-500 shadow-sm">
            <p className="font-medium text-slate-600">How a round works</p>
            <ol className="mt-2 list-decimal space-y-1 pl-4">
              <li>Coach asks a question</li>
              <li>You answer (type or paste your spoken attempt)</li>
              <li>It gives a concrete line to practice</li>
              <li>Disagree? Discuss until it fits</li>
              <li>Practice the delivery, then move on</li>
            </ol>
          </div>
        </aside>

        {/* Conversation + composer */}
        <div className="flex min-h-[60vh] flex-col rounded-xl border border-slate-200 bg-white shadow-sm">
          <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto p-4 sm:p-6">
            {messages.length === 0 && !loading && (
              <div className="flex h-full flex-col items-center justify-center gap-4 py-12 text-center">
                <p className="max-w-sm text-sm text-slate-500">
                  {documents.length === 0
                    ? 'Upload your resume and project files on the left, then start your first round. (You can also start without files for generic practice.)'
                    : "You're ready. Start your first practice round whenever you are."}
                </p>
                <button
                  className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-700 disabled:opacity-50"
                  disabled={loading}
                  onClick={() => send('question', false)}
                >
                  Start practice →
                </button>
              </div>
            )}

            {messages.map((m, i) => (
              <Bubble key={i} message={m} />
            ))}

            {loading && (
              <div className="flex items-center gap-2 text-sm text-slate-400">
                <span className="h-2 w-2 animate-bounce rounded-full bg-slate-300 [animation-delay:-0.3s]" />
                <span className="h-2 w-2 animate-bounce rounded-full bg-slate-300 [animation-delay:-0.15s]" />
                <span className="h-2 w-2 animate-bounce rounded-full bg-slate-300" />
                <span className="ml-1">coach is thinking…</span>
              </div>
            )}
          </div>

          {error && (
            <div className="border-t border-red-100 bg-red-50 px-4 py-2 text-xs text-red-600">
              {error}
            </div>
          )}

          {started && (
            <div className="border-t border-slate-100 p-3 sm:p-4">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={onComposerKey}
                rows={3}
                placeholder="Type your answer, your practice delivery, or what you'd rather say…"
                className="w-full resize-y rounded-lg border border-slate-200 p-3 text-sm outline-none focus:border-slate-400"
              />
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <button
                  className="rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-slate-700 disabled:opacity-50"
                  disabled={loading || !input.trim()}
                  onClick={() => send('answer', true)}
                >
                  Submit answer
                </button>
                <button
                  className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
                  disabled={loading || !input.trim()}
                  onClick={() => send('practice', true)}
                >
                  Practice delivery
                </button>
                <button
                  className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
                  disabled={loading || !input.trim()}
                  onClick={() => send('discuss', true)}
                >
                  Discuss / I disagree
                </button>
                <div className="flex-1" />
                <button
                  className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
                  disabled={loading}
                  onClick={() => send('question', false)}
                >
                  Next question →
                </button>
              </div>
              <p className="mt-1.5 text-[11px] text-slate-400">
                Tip: ⌘/Ctrl + Enter submits your answer.
              </p>
            </div>
          )}
        </div>
      </section>
    </main>
  );
}

function Bubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user';
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm ${
          isUser
            ? 'bg-slate-900 text-white'
            : 'border border-slate-200 bg-slate-50 text-slate-800'
        }`}
      >
        {!isUser && (
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            Coach
          </div>
        )}
        <div className="coach-text">{message.content}</div>
      </div>
    </div>
  );
}

function mergeDocs(prev: DocText[], next: DocText[]): DocText[] {
  const byName = new Map(prev.map((d) => [d.name, d]));
  for (const d of next) byName.set(d.name, d);
  return Array.from(byName.values());
}
