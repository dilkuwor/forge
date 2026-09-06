import {
  ConfirmRequest,
  ToolContext,
  ToolResult,
  getToolSpec,
  validateToolArgs,
  TOOLS,
  TOOL_REGISTRY,
  LIMITS
} from './registry.js';
import {
  SecurityError,
  ToolDeniedError,
  validateFilePath as validateFilePathDetailed,
  isBashCommandDenied,
  isBashAllowlisted,
  bashDenyReason,
  isSensitiveRelativePath
} from './security.js';

export type { ConfirmRequest, ToolContext, ToolResult };
export {
  SecurityError,
  ToolDeniedError,
  isBashCommandDenied,
  isBashAllowlisted,
  bashDenyReason,
  isSensitiveRelativePath,
  TOOLS,
  TOOL_REGISTRY,
  LIMITS
};

/** Backwards-compatible helper returning the resolved absolute path. */
export function validateFilePath(filePath: string, projectRoot: string): string {
  return validateFilePathDetailed(filePath, projectRoot).absolute;
}

/**
 * Execute a tool by name and return a structured result. Never throws for
 * model-recoverable errors; throws SecurityError / ToolDeniedError for
 * policy violations and user denials so callers can distinguish them.
 */
export async function executeToolDetailed(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  const spec = getToolSpec(name);
  if (!spec) {
    return {
      content: `Error: Unknown tool "${name}". Available tools: ${Array.from(TOOL_REGISTRY.keys()).join(', ')}.`,
      isError: true
    };
  }
  const validation = validateToolArgs(spec, args);
  if (validation) {
    return { content: `Error: ${validation}`, isError: true };
  }
  if (ctx.signal?.aborted) {
    return { content: 'Cancelled by user before execution.', isError: true };
  }
  return spec.execute(args, ctx);
}

/**
 * Compatibility wrapper returning only the textual result. Policy violations
 * and user denials still throw.
 */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<string> {
  const res = await executeToolDetailed(name, args, ctx);
  return res.content;
}
