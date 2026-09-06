export interface MessageLike {
  role: string;
  content?: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: string;
    function: {
      name: string;
      arguments: string;
    };
  }>;
}

export function estimateTokenCount(str: string): number {
  if (!str) return 0;
  return Math.ceil(str.length / 4);
}

export function estimateMessageTokens(msg: MessageLike): number {
  let count = 4; // overhead per message
  if (msg.content) count += estimateTokenCount(msg.content);
  if (msg.name) count += estimateTokenCount(msg.name);
  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      count += 10;
      count += estimateTokenCount(tc.function.name);
      count += estimateTokenCount(tc.function.arguments);
    }
  }
  return count;
}

export function estimateHistoryTokens(messages: MessageLike[]): number {
  return messages.reduce((acc, msg) => acc + estimateMessageTokens(msg), 0);
}

export interface CompactResult<T> {
  compacted: boolean;
  messages: T[];
  tokensBefore: number;
  tokensAfter: number;
}

/**
 * Find a cut index in `rest` such that `rest.slice(cut)` starts at a message
 * boundary that will not orphan tool results: never start the kept tail on a
 * `tool` message (its parent assistant call would be summarized away).
 */
function alignCutToTurnBoundary(rest: MessageLike[], desiredCut: number): number {
  let cut = Math.max(1, Math.min(desiredCut, rest.length));
  while (cut > 1 && rest[cut]?.role === 'tool') cut--;
  return cut;
}

function summarizeArgs(argsJson: string): string {
  try {
    const parsed = JSON.parse(argsJson) as Record<string, unknown>;
    const detail = parsed.path ?? parsed.command ?? parsed.pattern ?? '';
    return typeof detail === 'string' ? detail.slice(0, 120) : '';
  } catch {
    return '';
  }
}

function firstLine(s: string, max: number): string {
  const line = s.trim().split('\n')[0] || '';
  return line.length > max ? line.slice(0, max) + '…' : line;
}

/**
 * Compact conversation history when it exceeds a share of the context window.
 *
 * Guarantees:
 *  - The system message (if first) and the initial user request are kept.
 *  - The most recent `keepRecent` messages are kept verbatim, aligned so an
 *    assistant tool call is never separated from its tool results.
 *  - Everything in between is replaced by a single summary message that records
 *    which tools ran on which targets, files that were modified, and errors.
 */
export function compactHistory<T extends MessageLike>(
  messages: T[],
  contextWindow: number = 32768,
  thresholdRatio: number = 0.7,
  keepRecent: number = 6
): CompactResult<T> {
  const tokensBefore = estimateHistoryTokens(messages);
  const threshold = Math.floor(contextWindow * thresholdRatio);

  if (tokensBefore < threshold || messages.length <= 6) {
    return { compacted: false, messages, tokensBefore, tokensAfter: tokensBefore };
  }

  const hasSystem = messages[0]?.role === 'system';
  const systemMsg = hasSystem ? messages[0] : null;
  const rest = hasSystem ? messages.slice(1) : [...messages];

  if (rest.length <= keepRecent + 2) {
    return { compacted: false, messages, tokensBefore, tokensAfter: tokensBefore };
  }

  const initialUserMsg = rest[0];
  const cut = alignCutToTurnBoundary(rest, rest.length - keepRecent);
  const toSummarize = rest.slice(1, cut);
  const recentMessages = rest.slice(cut);

  if (toSummarize.length === 0) {
    return { compacted: false, messages, tokensBefore, tokensAfter: tokensBefore };
  }

  // If any earlier summary exists, carry its body forward rather than nesting.
  const carried: string[] = [];
  const actions: string[] = [];
  const modified = new Set<string>();
  const errors: string[] = [];
  const userNotes: string[] = [];
  const agentNotes: string[] = [];

  const callNames = new Map<string, { name: string; detail: string }>();

  for (const msg of toSummarize) {
    if (msg.role === 'user' && msg.content) {
      userNotes.push(firstLine(msg.content, 200));
    } else if (msg.role === 'assistant') {
      if (msg.content && msg.content.startsWith('[CONVERSATION HISTORY COMPACTED')) {
        carried.push(msg.content.split('\n').slice(1).join('\n'));
        continue;
      }
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          const detail = summarizeArgs(tc.function.arguments);
          callNames.set(tc.id, { name: tc.function.name, detail });
          actions.push(`${tc.function.name}${detail ? ` ${detail}` : ''}`);
          if ((tc.function.name === 'edit_file' || tc.function.name === 'write_file') && detail) {
            modified.add(detail);
          }
        }
      }
      if (msg.content && msg.content.trim()) {
        agentNotes.push(firstLine(msg.content, 200));
      }
    } else if (msg.role === 'tool' && msg.content) {
      const isErr = /^(Error:|Command failed|Tool execution error|Permission denied)/.test(msg.content);
      if (isErr) {
        const call = msg.tool_call_id ? callNames.get(msg.tool_call_id) : undefined;
        errors.push(`${call ? `${call.name} ${call.detail}`.trim() : 'tool'}: ${firstLine(msg.content, 160)}`);
      }
    }
  }

  const sections: string[] = [];
  if (carried.length) sections.push(carried.join('\n'));
  if (userNotes.length) sections.push(`User messages:\n${userNotes.map((s) => `• ${s}`).join('\n')}`);
  if (actions.length) {
    // Collapse consecutive duplicates
    const deduped = actions.filter((a, i) => i === 0 || actions[i - 1] !== a);
    sections.push(`Actions taken (${actions.length}):\n${deduped.slice(-60).map((s) => `• ${s}`).join('\n')}`);
  }
  if (modified.size) sections.push(`Files modified:\n${Array.from(modified).map((s) => `• ${s}`).join('\n')}`);
  if (errors.length) sections.push(`Errors encountered:\n${errors.slice(-15).map((s) => `• ${s}`).join('\n')}`);
  if (agentNotes.length) sections.push(`Agent notes:\n${agentNotes.slice(-10).map((s) => `• ${s}`).join('\n')}`);

  const summaryMessage = {
    role: 'assistant',
    content: `[CONVERSATION HISTORY COMPACTED (${toSummarize.length} messages summarized)]\n${sections.join('\n\n')}`
  } as unknown as T;

  const newMessages: T[] = [];
  if (systemMsg) newMessages.push(systemMsg);
  newMessages.push(initialUserMsg);
  newMessages.push(summaryMessage);
  newMessages.push(...recentMessages);

  const tokensAfter = estimateHistoryTokens(newMessages);
  return { compacted: true, messages: newMessages, tokensBefore, tokensAfter };
}

/**
 * Repair a history so that every assistant `tool_calls` entry has a matching
 * `tool` message and no orphaned `tool` messages exist. Used after aborts or
 * when resuming a session that ended mid-turn.
 */
export function repairToolPairing<T extends MessageLike>(
  messages: T[],
  placeholder: string = 'Result unavailable (operation was interrupted).'
): T[] {
  const out: T[] = [];
  const pendingIds = new Set<string>();

  const flushPending = () => {
    for (const id of pendingIds) {
      out.push({ role: 'tool', tool_call_id: id, content: placeholder } as unknown as T);
    }
    pendingIds.clear();
  };

  for (const msg of messages) {
    if (msg.role === 'tool') {
      if (msg.tool_call_id && pendingIds.has(msg.tool_call_id)) {
        pendingIds.delete(msg.tool_call_id);
        out.push(msg);
      }
      // orphan tool message → drop
      continue;
    }
    flushPending();
    out.push(msg);
    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const tc of msg.tool_calls) pendingIds.add(tc.id);
    }
  }
  flushPending();
  return out;
}
