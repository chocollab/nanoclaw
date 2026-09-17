import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChannelAdapter } from './adapter.js';
import { TELEGRAM_LIVE_TURN_ID as LIVE, withTelegramActivity } from './telegram.js';

const address = 'telegram:123';
function setup(enabled = true) {
  let id = 0;
  const deliver = vi.fn(async () => `123:${++id}`);
  const remove = vi.fn(async () => {});
  const setTyping = vi.fn(async () => {});
  const bridge = { deliver, setTyping, teardown: vi.fn(async () => {}) } as unknown as ChannelAdapter;
  return { adapter: withTelegramActivity(bridge, remove, enabled), deliver, remove, setTyping };
}
function activity(phase: string, turnId = 'turn-1', text?: string) {
  return { kind: 'chat', content: { telegramActivity: { phase, turnId }, ...(text ? { text } : {}) } };
}
afterEach(() => vi.useRealTimers());

describe('Telegram activity', () => {
  it('sends one delayed Ukrainian notice, and deletes only tracked progress after completion', async () => {
    vi.useFakeTimers();
    const { adapter, deliver, remove } = setup();
    await adapter.deliver(address, null, activity('start'));
    await vi.advanceTimersByTimeAsync(59_999);
    expect(deliver).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(deliver.mock.calls)).toContain('Ще опрацьовую');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(deliver).toHaveBeenCalledTimes(1);
    await adapter.deliver(address, null, activity('progress', 'turn-1', 'Читаю файли…'));
    await adapter.deliver(address, null, { kind: 'chat', content: { text: 'Фінальна відповідь' } });
    await adapter.deliver(address, null, activity('complete'));
    expect(remove.mock.calls).toEqual([
      [address, '123:1'],
      [address, '123:2'],
    ]);
    expect(remove).not.toHaveBeenCalledWith(address, '123:3');
  });

  it('cancels the notice for quick replies; deletion failures do not fail delivery', async () => {
    vi.useFakeTimers();
    const { adapter, remove, deliver } = setup();
    remove.mockRejectedValueOnce(new Error('forbidden'));
    await adapter.deliver(address, null, activity('start'));
    await adapter.deliver(address, null, activity('progress', 'turn-1', 'Перевіряю…'));
    await expect(adapter.deliver(address, null, activity('complete'))).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(61_000);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('keeps turns and chats separate, including a late status send', async () => {
    vi.useFakeTimers();
    const { adapter, deliver, remove } = setup();
    let finish!: (id: string) => void;
    deliver.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    await adapter.deliver(address, null, activity('start'));
    await vi.advanceTimersByTimeAsync(60_000);
    const complete = adapter.deliver(address, null, activity('complete'));
    await adapter.deliver('telegram:456', null, activity('progress', 'turn-1', 'Інша розмова'));
    finish('123:late');
    await complete;
    expect(remove.mock.calls).toEqual([[address, '123:late']]);
    await adapter.teardown();
  });

  it('a plain reply auto-closes the open turn even if nothing ever sends "complete"', async () => {
    // `ncl activity progress` (src/cli/resources/activity.ts) only ever emits
    // 'progress' on TELEGRAM_LIVE_TURN_ID — no producer is required to also
    // send 'complete'. The real reply's own delivery is what closes the turn.
    const { adapter, remove } = setup();
    await adapter.deliver(address, null, activity('progress', LIVE, 'Читаю файли…'));
    await adapter.deliver(address, null, { kind: 'chat', content: { text: 'Фінальна відповідь' } });
    expect(remove.mock.calls).toEqual([[address, '123:1']]);
    expect(remove).not.toHaveBeenCalledWith(address, '123:2');
    // A 'task_log' row is an intermediate marker, not the turn's real answer
    // — it must not close out a turn that's still open.
    await adapter.deliver(address, null, activity('progress', LIVE, 'Ще щось…'));
    await adapter.deliver(address, null, { kind: 'task_log', content: { text: 'проміжний лог' } });
    expect(remove).not.toHaveBeenCalledWith(address, '123:4');
  });

  it('can disable typing and transient notices without suppressing answers', async () => {
    const { adapter, deliver, setTyping } = setup(false);
    await adapter.setTyping!(address, null);
    await adapter.deliver(address, null, activity('progress', 'turn-1', 'Reading…'));
    await adapter.deliver(address, null, { kind: 'chat', content: { text: 'Answer' } });
    expect(setTyping).not.toHaveBeenCalled();
    expect(deliver).toHaveBeenCalledTimes(1);
  });
});
