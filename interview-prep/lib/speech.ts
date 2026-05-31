import type { DeliverySignals } from './types';

const FILLERS = [
  'um',
  'uh',
  'er',
  'ah',
  'hmm',
  'like',
  'you know',
  'sort of',
  'kind of',
  'basically',
  'actually',
  'literally',
  'i mean',
  'i guess',
];

/** Compute objective delivery signals from a transcript + timing. */
export function computeDelivery(
  transcript: string,
  durationSec: number,
  longPauses: number,
): DeliverySignals {
  const normalized = ` ${transcript.toLowerCase().replace(/[^\w'\s]/g, ' ').replace(/\s+/g, ' ')} `;
  const words = transcript.trim() ? transcript.trim().split(/\s+/) : [];
  const wordCount = words.length;

  let fillerCount = 0;
  const fillers: string[] = [];
  for (const f of FILLERS) {
    const re = new RegExp(`\\b${f.replace(/ /g, '\\s+')}\\b`, 'g');
    const matches = normalized.match(re);
    if (matches) {
      fillerCount += matches.length;
      fillers.push(`${f} ×${matches.length}`);
    }
  }

  const wordsPerMinute = durationSec > 0 ? Math.round(wordCount / (durationSec / 60)) : 0;
  return {
    durationSec: Math.round(durationSec),
    wordCount,
    wordsPerMinute,
    fillerCount,
    fillers,
    longPauses,
  };
}

/** Speak text aloud via the browser's built-in TTS. */
export function speak(text: string, onDone?: () => void): void {
  if (typeof window === 'undefined' || !window.speechSynthesis) {
    onDone?.();
    return;
  }
  window.speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(text);
  utter.rate = 1.02;
  utter.pitch = 1;
  if (onDone) {
    utter.onend = () => onDone();
    utter.onerror = () => onDone();
  }
  window.speechSynthesis.speak(utter);
}

export function cancelSpeech(): void {
  if (typeof window !== 'undefined' && window.speechSynthesis) {
    window.speechSynthesis.cancel();
  }
}

/** Strip markdown artefacts so TTS reads cleanly. */
export function sanitizeForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[*_`#>]/g, '')
    .replace(/\n{2,}/g, '. ')
    .replace(/\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Create a live speech-recognition session, or null if unsupported. */
export function getRecognition(): SpeechRecognition | null {
  if (typeof window === 'undefined') return null;
  const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Ctor) return null;
  const recognition = new Ctor();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = 'en-US';
  return recognition;
}

/** Convert a recorded Blob to base64 (without the data-URL prefix). */
export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = String(reader.result);
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
