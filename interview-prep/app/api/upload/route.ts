import { NextRequest, NextResponse } from 'next/server';
import { extractText } from '@/lib/extract';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB per file

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const files = form.getAll('files').filter((f): f is File => f instanceof File);

    if (files.length === 0) {
      return NextResponse.json({ error: 'No files uploaded.' }, { status: 400 });
    }

    const docs = [];
    for (const file of files) {
      if (file.size > MAX_FILE_BYTES) {
        return NextResponse.json(
          { error: `"${file.name}" is larger than 10 MB.` },
          { status: 413 },
        );
      }
      const buffer = Buffer.from(await file.arrayBuffer());
      docs.push(await extractText(file.name, buffer));
    }

    return NextResponse.json({ documents: docs });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to process upload.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
