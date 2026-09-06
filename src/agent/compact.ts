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

export function compactHistory<T extends MessageLike>(
  messages: T[],
  contextWindow: number = 32768,
  thresholdRatio: number = 0.7
): { compacted: boolean; messages: T[]; tokensBefore: number; tokensAfter: number } {
  const tokensBefore = estimateHistoryTokens(messages);
  const threshold = Math.floor(contextWindow * thresholdRatio);

  if (tokensBefore < threshold || messages.length <= 6) {
    return { compacted: false, messages, tokensBefore, tokensAfter: tokensBefore };
  }

  // Preserve system message (if first)
  const hasSystem = messages[0]?.role === 'system';
  const systemMsg = hasSystem ? messages[0] : null;
  const rest = hasSystem ? messages.slice(1) : [...messages];

  // We want to keep:
  // 1. Initial user request (rest[0])
  // 2. Recent 6 messages (at the end)
  if (rest.length <= 8) {
    return { compacted: false, messages, tokensBefore, tokensAfter: tokensBefore };
  }

  const initialUserMsg = rest[0];
  const recentMessages = rest.slice(-6);
  const toSummarize = rest.slice(1, -6);

  // Extract key information from toSummarize
  const summaries: string[] = [];
  for (const msg of toSummarize) {
    if (msg.role === 'user' && msg.content) {
      summaries.push(`User said: ${msg.content.slice(0, 150)}`);
    } else if (msg.role === 'assistant') {
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        for (const tc of msg.tool_calls) {
          try {
            const parsed = JSON.parse(tc.function.arguments);
            const detail = parsed.path || parsed.command || parsed.pattern || '';
            summaries.push(`Agent ran ${tc.function.name} (${detail})`);
          } catch {
            summaries.push(`Agent ran ${tc.function.name}`);
          }
        }
      }
      if (msg.content) {
        const text = msg.content.trim().slice(0, 150);
        if (text) summaries.push(`Agent note: ${text}`);
      }
    } else if (msg.role === 'tool' && msg.content) {
      const toolText = msg.content.slice(0, 100);
      summaries.push(`Tool result: ${toolText}`);
    }
  }

  const summaryContent = `[CONVERSATION HISTORY COMPACTED (${toSummarize.length} steps summarized)]:\n${summaries
    .map((s) => `• ${s}`)
    .join('\n')}`;

  const summaryMessage: any = {
    role: 'assistant',
    content: summaryContent
  };

  const newMessages: T[] = [];
  if (systemMsg) newMessages.push(systemMsg);
  newMessages.push(initialUserMsg);
  newMessages.push(summaryMessage);
  newMessages.push(...recentMessages);

  const tokensAfter = estimateHistoryTokens(newMessages);

  return {
    compacted: true,
    messages: newMessages,
    tokensBefore,
    tokensAfter
  };
}
