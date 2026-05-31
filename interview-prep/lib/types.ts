export type Role = 'user' | 'assistant';

export interface ChatMessage {
  role: Role;
  content: string;
}

export interface DocText {
  name: string;
  /** Extracted plain-text content of the uploaded document. */
  text: string;
  /** Original character count before any truncation. */
  chars: number;
}

/**
 * What the coach should do this turn.
 *   question → ask one new interview question
 *   respond  → react to what the candidate just said (first answer, a
 *              push-back/refine, or a practice delivery — inferred from context)
 */
export type Action = 'question' | 'respond';

/**
 * Objective, browser-computed signals about how an answer was *delivered*.
 * Sent alongside the transcript so the coach can critique pace, filler, and
 * pauses even when raw audio isn't ingested by the model.
 */
export interface DeliverySignals {
  durationSec: number;
  wordCount: number;
  wordsPerMinute: number;
  fillerCount: number;
  /** Distinct fillers used, formatted like "um ×3". */
  fillers: string[];
  longPauses: number;
}

/** A recorded spoken turn: base64 audio (no data-URL prefix) + its MIME type. */
export interface AudioClip {
  data: string;
  mimeType: string;
}

export interface ChatRequestBody {
  messages: ChatMessage[];
  documents: DocText[];
  action: Action;
  audio?: AudioClip | null;
  delivery?: DeliverySignals | null;
}
