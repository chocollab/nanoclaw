/**
 * `ncl activity progress` — the agent's own "what I'm doing right now" line.
 *
 * Telegram-only for now: posts a transient status message via the existing
 * telegramActivity channel (see withTelegramActivity in channels/telegram.ts),
 * which the host deletes automatically once the agent's real reply for this
 * session is delivered. A no-op (returns `{ sent: false }`, never throws) on
 * any other channel or when the session can't be resolved — an agent that
 * calls this speculatively before every slow step must never see it fail.
 */
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { getSession } from '../../db/sessions.js';
import { writeOutboundDirect } from '../../session-manager.js';
import { TELEGRAM_LIVE_TURN_ID } from '../../channels/telegram.js';
import type { CallerContext } from '../frame.js';
import { registerResource } from '../crud.js';

async function reportProgress(args: Record<string, unknown>, ctx: CallerContext): Promise<{ sent: boolean }> {
  if (ctx.caller !== 'agent') throw new Error('activity progress can only be reported from an agent session');
  const text = typeof args.text === 'string' ? args.text.trim() : '';
  if (!text) throw new Error('text is required');

  const session = await getSession(ctx.sessionId);
  if (!session || session.agent_group_id !== ctx.agentGroupId) return { sent: false };

  const mg = session.messaging_group_id ? await getMessagingGroup(session.messaging_group_id) : null;
  // Other channels don't have the typing/cleanup UX wired up yet — silently
  // skip rather than leave a stray text message in a chat that never
  // expected one.
  if (!mg || mg.channel_type !== 'telegram') return { sent: false };

  await writeOutboundDirect(session.agent_group_id, session.id, {
    id: `activity-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'chat',
    platformId: mg.platform_id,
    channelType: mg.channel_type,
    threadId: session.thread_id,
    content: JSON.stringify({
      text: text.slice(0, 500),
      telegramActivity: { phase: 'progress', turnId: TELEGRAM_LIVE_TURN_ID },
    }),
  });
  return { sent: true };
}

registerResource({
  name: 'activity',
  plural: 'activity',
  table: 'messages_out', // unused: no CRUD operations are declared below
  idColumn: 'id',
  columns: [],
  description: 'Report what you are currently doing, as a transient status line the user sees while you work.',
  operations: {},
  customOperations: {
    progress: {
      access: 'open',
      description:
        'Post a short note about what you are doing right now — e.g. "Читаю CLAUDE.md", "Виконую команду", ' +
        '"Шукаю в календарі". Shown to the user as a message that disappears on its own once your real reply ' +
        'arrives, so it never needs cleanup. Telegram sessions only — a silent no-op elsewhere. Use it before a ' +
        'step that takes more than a couple of seconds, not for every trivial action; one short line, not a log.',
      examples: [`ncl activity progress --text "Шукаю в календарі"`],
      args: [{ name: 'text', type: 'string', description: 'Short status text, one line.', required: true }],
      handler: reportProgress,
    },
  },
});
