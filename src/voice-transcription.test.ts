/**
 * transcribeVoice must never throw — a broken ffmpeg, a dead whisper-server,
 * or a network hiccup should all degrade to `null` so the caller can fall
 * back to a "couldn't transcribe" note instead of losing the message.
 */
import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.fn();
vi.mock('child_process', () => ({ spawn: (...args: unknown[]) => spawnMock(...args) }));

import { transcribeVoice } from './voice-transcription.js';

function makeFakeFfmpeg() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: { end: (buf: Buffer) => void; on: (...args: unknown[]) => void };
    kill: (signal: string) => void;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { end: vi.fn(), on: vi.fn() };
  child.kill = vi.fn();
  return child;
}

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = global.fetch;
  spawnMock.mockReset();
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe('transcribeVoice', () => {
  it('returns the transcript on a clean run', async () => {
    const ff = makeFakeFfmpeg();
    spawnMock.mockReturnValue(ff);
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ text: '  привіт, як справи  ' }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    })) as any;

    const promise = transcribeVoice(Buffer.from('fake-ogg-bytes'));
    ff.stdout.emit('data', Buffer.from('fake-wav-bytes'));
    ff.emit('close', 0);

    const result = await promise;
    expect(result).not.toBeNull();
    expect(result?.text).toBe('привіт, як справи');
    expect(typeof result?.ms).toBe('number');
  });

  it('returns null when ffmpeg exits non-zero, without calling whisper', async () => {
    const ff = makeFakeFfmpeg();
    spawnMock.mockReturnValue(ff);
    global.fetch = vi.fn();

    const promise = transcribeVoice(Buffer.from('not-really-audio'));
    ff.stderr.emit('data', Buffer.from('Invalid data found'));
    ff.emit('close', 1);

    const result = await promise;
    expect(result).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('returns null when whisper-server is unreachable', async () => {
    const ff = makeFakeFfmpeg();
    spawnMock.mockReturnValue(ff);
    global.fetch = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:8765');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;

    const promise = transcribeVoice(Buffer.from('fake-ogg-bytes'));
    ff.stdout.emit('data', Buffer.from('fake-wav-bytes'));
    ff.emit('close', 0);

    const result = await promise;
    expect(result).toBeNull();
  });

  it('returns null when whisper-server responds with an error status', async () => {
    const ff = makeFakeFfmpeg();
    spawnMock.mockReturnValue(ff);
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 500,
      text: async () => 'internal error',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    })) as any;

    const promise = transcribeVoice(Buffer.from('fake-ogg-bytes'));
    ff.stdout.emit('data', Buffer.from('fake-wav-bytes'));
    ff.emit('close', 0);

    const result = await promise;
    expect(result).toBeNull();
  });
});
