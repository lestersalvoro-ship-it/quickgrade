import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { AiError, type AiProvider, type AiRequest, type AiResult } from './provider';

/** Claude via the official Anthropic SDK, using structured outputs for JSON responses. */
export class AnthropicProvider implements AiProvider {
  readonly name = 'anthropic';
  private client: Anthropic;

  constructor(
    apiKey: string,
    readonly model: string,
    timeoutMs: number,
  ) {
    this.client = new Anthropic({ apiKey, timeout: timeoutMs, maxRetries: 2 });
  }

  async generate<T>(req: AiRequest<T>): Promise<AiResult<T>> {
    try {
      const response = await this.client.beta.messages.parse({
        model: this.model,
        max_tokens: req.maxTokens,
        system: req.system,
        messages: [{ role: 'user', content: req.prompt }],
        output_config: { effort: req.effort ?? 'medium', format: betaZodOutputFormat(req.schema) },
        // If a safety classifier declines, let the API retry on its recommended fallback model.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
      });
      const usage = { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens, model: response.model };
      if (response.stop_reason === 'refusal') {
        throw new AiError('refused', 'The AI declined this request. Try rephrasing the topic or material.', usage);
      }
      if (response.stop_reason === 'max_tokens') {
        throw new AiError('invalid_output', 'The AI response was too long and got cut off. Try asking for fewer questions.', usage);
      }
      if (!response.parsed_output) throw new AiError('invalid_output', 'The AI returned a response in an unexpected format. Please try again.', usage);
      return { data: response.parsed_output as T, model: response.model, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens };
    } catch (err) {
      if (err instanceof AiError) throw err;
      if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
        throw new AiError('misconfigured', 'The AI provider rejected the server’s credentials. An administrator should check ANTHROPIC_API_KEY.');
      }
      if (err instanceof Anthropic.RateLimitError) throw new AiError('rate_limited', 'The AI service is busy right now. Please try again in a minute.');
      if (err instanceof Anthropic.APIConnectionTimeoutError) throw new AiError('timeout', 'The AI service took too long to respond. Please try again.');
      if (err instanceof Anthropic.APIConnectionError) throw new AiError('unavailable', 'Could not reach the AI service. Check the server’s internet connection.');
      if (err instanceof Anthropic.BadRequestError) throw new AiError('provider_error', 'The AI service could not process this request.');
      if (err instanceof Anthropic.APIError) throw new AiError('provider_error', `The AI service returned an error (${err.status ?? 'unknown'}). Please try again later.`);
      if (err instanceof Error && /parse|JSON|schema/i.test(err.message)) {
        throw new AiError('invalid_output', 'The AI returned a response in an unexpected format. Please try again.');
      }
      throw new AiError('provider_error', 'Unexpected AI error. Please try again later.');
    }
  }
}
