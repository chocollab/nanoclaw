/**
 * Turns a voice-note audio buffer into text using the local whisper.cpp
 * server (see docs/voice-transcription.md).
 *
 * Runs on the host process (session-manager.ts calls this before an inbound
 * message is even routed to a container), so it talks to whisper directly on
 * localhost — no container networking involved.
 *
 * Never throws. Any failure (ffmpeg missing, whisper down, bad audio,
 * timeout) resolves to `null` so a broken transcription path degrades to
 * "voice note, couldn't transcribe" instead of dropping the message.
 */
import { spawn } from 'child_process';

import { FFMPEG_PATH, VOICE_LANGUAGE, VOICE_TRANSCRIPTION_TIMEOUT_MS, WHISPER_URL } from './config.js';
import { log } from './log.js';

export interface TranscriptionResult {
  text: string;
  ms: number;
}

/**
 * Re-encodes arbitrary audio (ogg/opus, mp3, m4a, ...) to 16kHz mono WAV via
 * ffmpeg. whisper.cpp's server expects PCM WAV; feeding it Telegram's native
 * Opus-in-Ogg directly is unreliable across builds, so we normalize first.
 * Runs entirely in memory (stdin -> stdout pipes), no temp files.
 */
function toWav16kMono(input: Buffer, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const ff = spawn(FFMPEG_PATH, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      'pipe:0',
      '-f',
      'wav',
      '-ar',
      '16000',
      '-ac',
      '1',
      '-acodec',
      'pcm_s16le',
      'pipe:1',
    ]);

    const chunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const timer = setTimeout(() => {
      ff.kill('SIGKILL');
      reject(new Error('ffmpeg timed out'));
    }, timeoutMs);

    ff.stdout.on('data', (c: Buffer) => chunks.push(c));
    ff.stderr.on('data', (c: Buffer) => stderrChunks.push(c));
    ff.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    ff.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(Buffer.concat(chunks));
      } else {
        reject(new Error(`ffmpeg exited ${code}: ${Buffer.concat(stderrChunks).toString('utf8').slice(0, 300)}`));
      }
    });

    ff.stdin.on('error', () => {
      // EPIPE etc. — surfaced via the 'close'/'error' handlers above instead.
    });
    ff.stdin.end(input);
  });
}

async function callWhisper(wav: Buffer, timeoutMs: number): Promise<string> {
  const form = new FormData();
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
  form.append('language', VOICE_LANGUAGE);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${WHISPER_URL}/inference`, {
      method: 'POST',
      body: form,
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`whisper-server responded ${res.status}`);
    }
    const raw = await res.text();
    try {
      const parsed = JSON.parse(raw) as { text?: unknown };
      if (typeof parsed.text === 'string') return parsed.text.trim();
    } catch {
      // Not JSON — some whisper.cpp builds return plain text directly.
    }
    return raw.trim();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Transcribes a voice-note buffer. Returns `null` on any failure — callers
 * should fall back to a "couldn't transcribe" note rather than surfacing an
 * error to the chat.
 */
export async function transcribeVoice(buffer: Buffer): Promise<TranscriptionResult | null> {
  const started = Date.now();
  try {
    const wav = await toWav16kMono(buffer, VOICE_TRANSCRIPTION_TIMEOUT_MS);
    const text = await callWhisper(wav, VOICE_TRANSCRIPTION_TIMEOUT_MS);
    const ms = Date.now() - started;
    if (!text) {
      log.warn('Voice transcription returned empty text', { ms });
      return null;
    }
    log.info('Voice transcribed', { ms, chars: text.length });
    return { text, ms };
  } catch (err) {
    log.warn('Voice transcription failed', { err: err instanceof Error ? err.message : String(err) });
    return null;
  }
}
