'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AudioClip, ChatMessage, DocText } from '@/lib/types';
import {
  blobToBase64,
  cancelSpeech,
  computeDelivery,
  getRecognition,
  sanitizeForSpeech,
  speak,
} from '@/lib/speech';

type Phase = 'connecting' | 'coachSpeaking' | 'listening' | 'thinking' | 'error';

// Voice-activity tuning.
const SILENCE_RMS = 0.012; // below this counts as silence
const END_SILENCE_MS = 1800; // pause this long (after speaking) ends the turn
const LONG_PAUSE_MS = 1200; // a silence this long mid-answer counts as a "long pause"

export default function Call({
  documents,
  onEnd,
}: {
  documents: DocText[];
  onEnd: () => void;
}) {
  const [phase, setPhase] = useState<Phase>('connecting');
  const [coachLine, setCoachLine] = useState('');
  const [caption, setCaption] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [captionsSupported] = useState(() => !!getRecognition());

  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const finalTranscriptRef = useRef('');
  const startTimeRef = useRef(0);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);
  const longPausesRef = useRef(0);
  const messagesRef = useRef<ChatMessage[]>([]);
  const phaseRef = useRef<Phase>('connecting');
  const turnDoneRef = useRef(false);
  const endedRef = useRef(false);

  const setPhaseSafe = useCallback((p: Phase) => {
    phaseRef.current = p;
    setPhase(p);
  }, []);

  const addMessage = useCallback((m: ChatMessage) => {
    messagesRef.current = [...messagesRef.current, m];
  }, []);

  // ── Networking ────────────────────────────────────────────────
  const callCoach = useCallback(
    async (action: 'question' | 'respond', audio?: AudioClip | null, delivery?: ReturnType<typeof computeDelivery> | null) => {
      setPhaseSafe('thinking');
      try {
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messages: messagesRef.current,
            documents,
            action,
            audio: audio ?? null,
            delivery: delivery ?? null,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'The coach is unavailable.');
        const reply: string = data.content || '(no response)';
        addMessage({ role: 'assistant', content: reply });
        setCoachLine(reply);
        speakThenListen(reply);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'The coach is unavailable.');
        setPhaseSafe('error');
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [documents],
  );

  // ── Speak, then hand the mic back ─────────────────────────────
  const speakThenListen = useCallback((text: string) => {
    setPhaseSafe('coachSpeaking');
    speak(sanitizeForSpeech(text), () => {
      if (endedRef.current) return;
      startListening();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Listening turn: record audio + live captions + silence VAD ─
  const startListening = useCallback(() => {
    const stream = streamRef.current;
    if (!stream || endedRef.current) return;

    setCaption('');
    finalTranscriptRef.current = '';
    longPausesRef.current = 0;
    turnDoneRef.current = false;
    chunksRef.current = [];
    startTimeRef.current = performance.now();
    setPhaseSafe('listening');

    // Record the mic audio only.
    const audioStream = new MediaStream(stream.getAudioTracks());
    try {
      const recorder = new MediaRecorder(audioStream);
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorderRef.current = recorder;
      recorder.start();
    } catch {
      recorderRef.current = null; // audio capture unavailable; transcript still works
    }

    // Live captions via Web Speech API.
    const recognition = getRecognition();
    if (recognition) {
      recognitionRef.current = recognition;
      recognition.onresult = (event: SpeechRecognitionEvent) => {
        let interim = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const result = event.results[i];
          if (result.isFinal) finalTranscriptRef.current += result[0].transcript + ' ';
          else interim += result[0].transcript;
        }
        setCaption((finalTranscriptRef.current + interim).trim());
      };
      recognition.onerror = () => {};
      try {
        recognition.start();
      } catch {
        /* already started */
      }
    }

    startVad();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Silence detection: end the turn after a pause once the user has spoken.
  const startVad = useCallback(() => {
    const stream = streamRef.current;
    if (!stream) return;
    const AudioCtx =
      window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new AudioCtx();
    audioCtxRef.current = ctx;
    const source = ctx.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    const data = new Uint8Array(analyser.fftSize);

    let hasSpoken = false;
    let silenceStart = 0;
    let pauseCounted = false;

    const tick = () => {
      if (turnDoneRef.current || endedRef.current) return;
      analyser.getByteTimeDomainData(data);
      let sumSq = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128;
        sumSq += v * v;
      }
      const rms = Math.sqrt(sumSq / data.length);
      const now = performance.now();

      if (rms > SILENCE_RMS) {
        hasSpoken = true;
        silenceStart = 0;
        pauseCounted = false;
      } else if (hasSpoken) {
        if (silenceStart === 0) silenceStart = now;
        const silentFor = now - silenceStart;
        if (silentFor > LONG_PAUSE_MS && !pauseCounted) {
          longPausesRef.current += 1;
          pauseCounted = true;
        }
        if (silentFor > END_SILENCE_MS) {
          finishTurn();
          return;
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stopListeningPipes = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch {
        /* noop */
      }
      recognitionRef.current = null;
    }
    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
  }, []);

  // End the user's turn, package the audio + delivery, send to the coach.
  const finishTurn = useCallback(() => {
    if (turnDoneRef.current || phaseRef.current !== 'listening') return;
    turnDoneRef.current = true;
    stopListeningPipes();

    const durationSec = (performance.now() - startTimeRef.current) / 1000;
    const recorder = recorderRef.current;

    const finalize = async (blob: Blob | null) => {
      const transcript = finalTranscriptRef.current.trim() || caption.trim();
      // Ignore empty turns (false trigger) — go back to listening.
      if (!transcript && (!blob || blob.size < 800)) {
        if (!endedRef.current) startListening();
        return;
      }
      const delivery = computeDelivery(transcript, durationSec, longPausesRef.current);
      let audio: AudioClip | null = null;
      if (blob && blob.size > 0) {
        audio = { data: await blobToBase64(blob), mimeType: blob.type || 'audio/webm' };
      }
      const spoken = transcript || '(spoken answer — see audio; live captions unavailable)';
      addMessage({ role: 'user', content: spoken });
      setCaption('');
      callCoach('respond', audio, delivery);
    };

    if (recorder && recorder.state !== 'inactive') {
      recorder.onstop = () => {
        const blob = chunksRef.current.length
          ? new Blob(chunksRef.current, { type: chunksRef.current[0].type })
          : null;
        finalize(blob);
      };
      recorder.stop();
    } else {
      finalize(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [caption]);

  // ── Controls ──────────────────────────────────────────────────
  const nextQuestion = useCallback(() => {
    cancelSpeech();
    turnDoneRef.current = true;
    stopListeningPipes();
    callCoach('question');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const repeat = useCallback(() => {
    if (coachLine) speak(sanitizeForSpeech(coachLine));
  }, [coachLine]);

  const toggleMute = useCallback(() => {
    const stream = streamRef.current;
    if (!stream) return;
    const next = !muted;
    stream.getAudioTracks().forEach((t) => (t.enabled = !next));
    setMuted(next);
  }, [muted]);

  const endCall = useCallback(() => {
    endedRef.current = true;
    cancelSpeech();
    stopListeningPipes();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    onEnd();
  }, [onEnd, stopListeningPipes]);

  // ── Setup / teardown ──────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.play().catch(() => {});
        }
        callCoach('question');
      } catch {
        setError('Camera/microphone access is required for the call. Please allow it and reload.');
        setPhaseSafe('error');
      }
    })();

    return () => {
      cancelled = true;
      endedRef.current = true;
      cancelSpeech();
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      try {
        recognitionRef.current?.stop();
      } catch {
        /* noop */
      }
      audioCtxRef.current?.close().catch(() => {});
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const statusLabel: Record<Phase, string> = {
    connecting: 'Connecting…',
    coachSpeaking: 'Coach is speaking',
    listening: 'Listening — speak your answer',
    thinking: 'Coach is thinking…',
    error: 'Something went wrong',
  };

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {/* Coach panel */}
        <div className="relative flex min-h-[300px] flex-col rounded-2xl border border-slate-800 bg-slate-900 p-5 text-slate-100">
          <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-slate-400">
            <span
              className={`h-2 w-2 rounded-full ${
                phase === 'coachSpeaking'
                  ? 'animate-pulse bg-emerald-400'
                  : phase === 'thinking'
                    ? 'animate-pulse bg-amber-400'
                    : 'bg-slate-600'
              }`}
            />
            Coach
          </div>
          <div className="mt-3 flex-1 overflow-y-auto text-sm leading-relaxed text-slate-100">
            {coachLine || (phase === 'connecting' ? 'Setting up your call…' : '…')}
          </div>
        </div>

        {/* Self-view */}
        <div className="relative min-h-[300px] overflow-hidden rounded-2xl border border-slate-200 bg-slate-950">
          <video
            ref={videoRef}
            muted
            playsInline
            className="h-full w-full -scale-x-100 object-cover"
          />
          <div className="absolute bottom-2 left-2 rounded-md bg-black/50 px-2 py-0.5 text-[11px] text-white">
            You {muted && '· muted'}
          </div>
          {phase === 'listening' && (
            <div className="absolute right-2 top-2 flex items-center gap-1.5 rounded-full bg-red-500/90 px-2.5 py-1 text-[11px] font-medium text-white">
              <span className="h-2 w-2 animate-pulse rounded-full bg-white" /> REC
            </div>
          )}
        </div>
      </div>

      {/* Captions / status */}
      <div className="min-h-[56px] rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
          {statusLabel[phase]}
        </div>
        <div className="mt-1 text-sm text-slate-700">
          {phase === 'listening'
            ? caption || (captionsSupported ? 'Go ahead — I\'m listening.' : 'Recording your answer…')
            : phase === 'thinking'
              ? '…'
              : ''}
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
          {error}
        </div>
      )}
      {!captionsSupported && phase !== 'error' && (
        <p className="text-center text-[11px] text-amber-600">
          Live captions are not supported in this browser — your audio is still recorded. Use
          Chrome or Edge for on-screen captions.
        </p>
      )}

      {/* Controls */}
      <div className="flex flex-wrap items-center justify-center gap-2">
        <button
          className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-700 disabled:opacity-40"
          disabled={phase !== 'listening'}
          onClick={finishTurn}
        >
          Done answering
        </button>
        <button
          className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-700 transition hover:bg-slate-50 disabled:opacity-40"
          disabled={phase === 'thinking' || phase === 'connecting'}
          onClick={nextQuestion}
        >
          Next question →
        </button>
        <button
          className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-700 transition hover:bg-slate-50 disabled:opacity-40"
          disabled={!coachLine}
          onClick={repeat}
        >
          Repeat that
        </button>
        <button
          className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-700 transition hover:bg-slate-50"
          onClick={toggleMute}
        >
          {muted ? 'Unmute' : 'Mute'}
        </button>
        <button
          className="rounded-lg border border-red-200 px-3 py-2 text-sm text-red-600 transition hover:bg-red-50"
          onClick={endCall}
        >
          End call
        </button>
      </div>
    </div>
  );
}
