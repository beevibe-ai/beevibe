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
 * What the coach should do on a given turn. The UI maps each button to one of
 * these so a small model gets explicit, reliable steering each round.
 */
export type Action = 'question' | 'answer' | 'discuss' | 'practice' | 'freeform';

export interface ChatRequestBody {
  messages: ChatMessage[];
  documents: DocText[];
  action: Action;
}
