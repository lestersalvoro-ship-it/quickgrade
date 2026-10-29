import type { z } from 'zod';

/** Provider-neutral interface. Swap implementations without touching features or routes. */
export interface AiProvider {
  readonly name: string;
  readonly model: string;
  generate<T>(req: AiRequest<T>): Promise<AiResult<T>>;
}

export interface AiRequest<T> {
  feature: string;
  system: string;
  prompt: string;
  /** Shape the model is asked to produce; the result is additionally validated by the caller. */
  schema: z.ZodType<T>;
  maxTokens: number;
  effort?: 'low' | 'medium' | 'high';
}

export interface AiResult<T> {
  data: T;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export type AiFailureKind = 'unavailable' | 'rate_limited' | 'timeout' | 'refused' | 'invalid_output' | 'provider_error' | 'misconfigured';

export class AiError extends Error {
  constructor(
    public kind: AiFailureKind,
    message: string,
    public usage?: { inputTokens: number; outputTokens: number; model?: string },
  ) {
    super(message);
  }
}

/** Used when no provider is configured: every call explains how to enable AI. */
export class DisabledProvider implements AiProvider {
  readonly name = 'none';
  readonly model = 'none';
  async generate<T>(): Promise<AiResult<T>> {
    throw new AiError('unavailable', 'AI features are not configured on this server. An administrator can enable them by setting ANTHROPIC_API_KEY.');
  }
}
