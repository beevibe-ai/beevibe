import type { DocText } from './types';

/** Keep prompts manageable for small local models. */
const MAX_CHARS_PER_DOC = 16000;

function truncate(text: string): { text: string; chars: number } {
  const chars = text.length;
  if (chars <= MAX_CHARS_PER_DOC) return { text, chars };
  return {
    text: `${text.slice(0, MAX_CHARS_PER_DOC)}\n\n[... document truncated for length ...]`,
    chars,
  };
}

/**
 * Extract plain text from an uploaded file. Supports PDF, DOCX, and plain
 * text / markdown. Unknown types are read as UTF-8 best-effort.
 */
export async function extractText(name: string, buffer: Buffer): Promise<DocText> {
  const lower = name.toLowerCase();
  let raw = '';

  if (lower.endsWith('.pdf')) {
    // Import the implementation file directly: importing the package index
    // triggers pdf-parse's debug/test harness when no module parent exists.
    const { default: pdf } = await import('pdf-parse/lib/pdf-parse.js');
    const result = await pdf(buffer);
    raw = result.text;
  } else if (lower.endsWith('.docx')) {
    const mammoth = await import('mammoth');
    const result = await mammoth.extractRawText({ buffer });
    raw = result.value;
  } else {
    // .txt, .md, .markdown, and anything else: treat as UTF-8 text.
    raw = buffer.toString('utf8');
  }

  const clean = raw.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const { text, chars } = truncate(clean);
  return { name, text, chars };
}
