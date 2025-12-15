import { AsyncLocalStorage } from "node:async_hooks";
import type { Logger, RunContext } from "./types.js";

/**
 * Minimal client surface we need for emitting progress to the TUI.
 */
interface ProgressClient {
  session: {
    // The SDK returns a RequestResult; we treat it as a Promise-like for logging purposes.
    promptAsync: (options: any) => Promise<unknown> | unknown;
  };
  app: {
    log: (args: any) => Promise<unknown> | unknown;
  };
}

type ProgressLevel = "info" | "warn" | "error";

interface ProgressOptions {
  runId?: string;
  level?: ProgressLevel;
  stepId?: string;
  /**
   * If true, treat this as a high-signal status update (always send).
   * Otherwise, may be coalesced by caller to avoid chatter.
   */
  force?: boolean;
}

const MAX_MESSAGE_LENGTH = 1800;

function truncateMessage(message: string): string {
  if (message.length <= MAX_MESSAGE_LENGTH) return message;
  const suffix = " … (truncated)";
  return message.slice(0, MAX_MESSAGE_LENGTH - suffix.length) + suffix;
}

/**
 * Routes workflow progress to the TUI (session) and to the OpenCode log channel.
 * Uses AsyncLocalStorage to associate logs from step adapters with the active run.
 */
export class ProgressReporter {
  private runContexts = new Map<string, RunContext>();
  private asyncRunScope = new AsyncLocalStorage<string>();
  private stepSummaries = new Map<string, string>(); // runId: last step summary

  constructor(
    private client: ProgressClient,
    private log: Logger
  ) { }

  setRunContext(runId: string, context?: RunContext): void {
    if (!context) return;
    this.runContexts.set(runId, context);
  }

  clearRunContext(runId: string): void {
    this.runContexts.delete(runId);
  }

  async withRunContext<T>(runId: string, fn: () => Promise<T>): Promise<T> {
    return this.asyncRunScope.run(runId, fn);
  }

  getActiveRunId(): string | undefined {
    return this.asyncRunScope.getStore();
  }

  async emit(message: string, options: ProgressOptions = {}): Promise<void> {
    const level: ProgressLevel = options.level ?? "info";
    const runId = options.runId ?? this.getActiveRunId();
    const safeMessage = truncateMessage(message);
    const stepPrefix = options.stepId ? `[${options.stepId}] ` : "";
    const prefix = runId ? `[workflow:${runId}] ` : "[workflow] ";
    const finalMessage = `${prefix}${stepPrefix}${safeMessage}`;

    let loggedToApp = false;

    // Try to log via the client app channel (best effort)
    // This is the preferred way to log in a session context as it integrates with the TUI
    if (this.client.app?.log) {
      try {
        await Promise.resolve(this.client.app.log({
          body: {
            service: "workflow",
            level,
            message: finalMessage,
          },
        }));
        loggedToApp = true;
      } catch {
        // Swallow to avoid breaking execution on logging failures
      }
    }

    // Only fallback to direct console logging if we couldn't log to the app
    // This prevents "mashed" output where console logs interfere with TUI/Agent streaming
    if (!loggedToApp) {
      const loggerFn = this.log[level].bind(this.log) as (msg: string) => void;
      loggerFn(finalMessage);
    }

    if (!runId) return;

    const context = this.runContexts.get(runId);
    if (!context?.sessionId) return;

    // Emit into the originating session without expecting a model reply
    try {
      await Promise.resolve(this.client.session.promptAsync({
        path: { id: context.sessionId },
        body: {
          noReply: true,
          messageID: context.messageId,
          agent: context.agent,
          parts: [
            {
              type: "text",
              text: safeMessage,
            },
          ],
        },
      }));
    } catch {
      // Ignore session emit errors; the log channel already captured the message
    }
  }

  /**
   * Update the last step summary for a run (used by periodic status pings).
   */
  setStepSummary(runId: string, summary: string): void {
    this.stepSummaries.set(runId, truncateMessage(summary));
  }

  getStepSummary(runId: string): string | undefined {
    return this.stepSummaries.get(runId);
  }
}
