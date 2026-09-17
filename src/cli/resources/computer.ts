/**
 * `ncl computer *` — direct host GUI control (screenshot / click / type / key).
 *
 * Unlike every other agent-facing command, these handlers reach straight
 * through to the Mac's own UI (osascript + screencapture) — there is no
 * container sandbox for this by design; controlling the screen means
 * controlling the screen the container can't see. Every action — including
 * `screenshot` — is `access: 'approval'` (see guard.ts): the screen can show
 * anything (passwords, unrelated apps, someone else's data), not just what's
 * relevant to the agent's task, so "just looking" doesn't get a free pass.
 * Each one holds for the owner's approval in Telegram before it runs.
 */
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

import { getMessagingGroup } from '../../db/messaging-groups.js';
import { getSession } from '../../db/sessions.js';
import { sessionDir, writeOutboundDirect } from '../../session-manager.js';
import type { Session } from '../../types.js';
import type { CallerContext } from '../frame.js';
import { registerResource } from '../crud.js';

const execFileAsync = promisify(execFile);

const KEY_CODES: Record<string, number> = {
  return: 36,
  enter: 36,
  tab: 48,
  space: 49,
  delete: 51,
  backspace: 51,
  escape: 53,
  esc: 53,
  left: 123,
  right: 124,
  down: 125,
  up: 126,
};
const VALID_MODIFIERS = new Set(['command', 'option', 'control', 'shift']);

/** Escape a string for embedding inside a double-quoted AppleScript literal. */
function asString(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

async function runOsascript(script: string): Promise<void> {
  await execFileAsync('osascript', ['-e', script]);
}

/** Confirms the caller is an agent session in good standing. Returns it for reuse. */
async function requireSession(ctx: CallerContext): Promise<Session> {
  if (ctx.caller !== 'agent') throw new Error('computer control can only be used from an agent session');
  const session = await getSession(ctx.sessionId);
  if (!session || session.agent_group_id !== ctx.agentGroupId) throw new Error('session not found');
  return session;
}

async function doScreenshot(_args: Record<string, unknown>, ctx: CallerContext): Promise<{ sent: boolean }> {
  const session = await requireSession(ctx);
  const mg = session.messaging_group_id ? await getMessagingGroup(session.messaging_group_id) : null;
  if (!mg) return { sent: false };

  const messageId = `computer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const outboxDir = path.join(sessionDir(session.agent_group_id, session.id), 'outbox', messageId);
  fs.mkdirSync(outboxDir, { recursive: true });
  const filePath = path.join(outboxDir, 'screenshot.png');
  await execFileAsync('screencapture', ['-x', filePath]);

  await writeOutboundDirect(session.agent_group_id, session.id, {
    id: messageId,
    kind: 'chat',
    platformId: mg.platform_id,
    channelType: mg.channel_type,
    threadId: session.thread_id,
    content: JSON.stringify({ text: '', files: ['screenshot.png'] }),
  });
  return { sent: true };
}

async function doClick(
  args: Record<string, unknown>,
  ctx: CallerContext,
): Promise<{ clicked: true; x: number; y: number }> {
  await requireSession(ctx);
  const x = Math.round(Number(args.x));
  const y = Math.round(Number(args.y));
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('x and y must be numbers');
  await runOsascript(`tell application "System Events" to click at {${x}, ${y}}`);
  return { clicked: true, x, y };
}

async function doType(args: Record<string, unknown>, ctx: CallerContext): Promise<{ typed: true; chars: number }> {
  await requireSession(ctx);
  const text = typeof args.text === 'string' ? args.text : '';
  if (!text) throw new Error('text is required');
  await runOsascript(`tell application "System Events" to keystroke "${asString(text)}"`);
  return { typed: true, chars: text.length };
}

async function doKey(
  args: Record<string, unknown>,
  ctx: CallerContext,
): Promise<{ pressed: string; modifiers: string[] }> {
  await requireSession(ctx);
  const name = typeof args.name === 'string' ? args.name.toLowerCase() : '';
  const code = KEY_CODES[name];
  if (code === undefined) {
    throw new Error(`Unknown key "${name}". Supported: ${Object.keys(KEY_CODES).join(', ')}`);
  }
  const modifiers = (typeof args.modifiers === 'string' ? args.modifiers.split(',') : [])
    .map((m) => m.trim().toLowerCase())
    .filter((m) => VALID_MODIFIERS.has(m));
  const modClause = modifiers.length ? ` using {${modifiers.map((m) => `${m} down`).join(', ')}}` : '';
  await runOsascript(`tell application "System Events" to key code ${code}${modClause}`);
  return { pressed: name, modifiers };
}

registerResource({
  name: 'computer',
  plural: 'computer',
  table: 'messages_out', // unused: no CRUD operations are declared below
  idColumn: 'id',
  columns: [],
  description:
    "Direct control of this Mac's screen, mouse, and keyboard — outside the container sandbox. " +
    'Look with `screenshot`, act with click/type/key (each held for owner approval in the chat first).',
  operations: {},
  customOperations: {
    screenshot: {
      access: 'approval',
      description:
        'Take a screenshot of the whole screen right now and send it to this chat as a photo. ' +
        "Holds for the owner's approval first — the screen may show anything, not just what's relevant here.",
      examples: [`ncl computer screenshot`],
      args: [],
      handler: doScreenshot,
    },
    click: {
      access: 'approval',
      description:
        'Click the mouse at screen coordinates (x, y — pixels from the top-left of the main display). ' +
        "Holds for the owner's approval in the chat before it runs.",
      examples: [`ncl computer click --x 400 --y 300`],
      args: [
        { name: 'x', type: 'number', description: 'X coordinate in pixels from the left edge.', required: true },
        { name: 'y', type: 'number', description: 'Y coordinate in pixels from the top edge.', required: true },
      ],
      handler: doClick,
    },
    type: {
      access: 'approval',
      description:
        'Type text into whatever currently has keyboard focus. Take a screenshot first to be sure the ' +
        "right field is focused. Holds for the owner's approval before it runs.",
      examples: [`ncl computer type --text "hello"`],
      args: [{ name: 'text', type: 'string', description: 'Text to type.', required: true }],
      handler: doType,
    },
    key: {
      access: 'approval',
      description:
        `Press a named key, optionally with modifiers. Keys: ${Object.keys(KEY_CODES).join(', ')}. ` +
        "Modifiers (comma-separated): command, option, control, shift. Holds for the owner's approval first.",
      examples: [`ncl computer key --name return`, `ncl computer key --name tab --modifiers command`],
      args: [
        {
          name: 'name',
          type: 'string',
          description: 'Key name (see command description for the list).',
          required: true,
        },
        { name: 'modifiers', type: 'string', description: 'Comma-separated modifier keys, e.g. "command,shift".' },
      ],
      handler: doKey,
    },
  },
});
