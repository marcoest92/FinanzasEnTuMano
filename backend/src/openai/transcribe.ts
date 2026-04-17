import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { getOpenAI } from './client.js';

export async function transcribeOggOrMp3(buffer: Buffer, filenameHint: string): Promise<string> {
  const openai = getOpenAI();
  const ext = path.extname(filenameHint) || '.ogg';
  const tmp = path.join(os.tmpdir(), `voice-${Date.now()}${ext}`);
  await fs.writeFile(tmp, buffer);
  try {
    const transcription = await openai.audio.transcriptions.create({
      file: createReadStream(tmp),
      model: 'whisper-1',
      language: 'es',
    });
    return transcription.text.trim();
  } finally {
    await fs.unlink(tmp).catch(() => {});
  }
}
