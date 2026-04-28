import OpenAI from 'openai';
import type { Config } from '../../../config/config.js';
import type { ContentGeneratorConfig } from '../../contentGenerator.js';
import { DefaultOpenAICompatibleProvider } from './default.js';

/**
 * Normalize OpenRouter base URLs: ensures the path ends with /v1.
 * Some users configure "https://openrouter.ai/api" instead of
 * "https://openrouter.ai/api/v1", which causes the API to return HTML.
 */
export function normalizeOpenRouterBaseUrl(baseUrl: string): string {
  // Strip trailing slash
  const url = baseUrl.replace(/\/$/, '');
  // If the URL ends with /api (without /v1), append /v1
  if (/\/api$/.test(url)) {
    return url + '/v1';
  }
  return url;
}

export class OpenRouterOpenAICompatibleProvider extends DefaultOpenAICompatibleProvider {
  constructor(
    contentGeneratorConfig: ContentGeneratorConfig,
    cliConfig: Config,
  ) {
    super(contentGeneratorConfig, cliConfig);
  }

  static isOpenRouterProvider(
    contentGeneratorConfig: ContentGeneratorConfig,
  ): boolean {
    const baseURL = contentGeneratorConfig.baseUrl || '';
    return baseURL.includes('openrouter.ai');
  }

  override buildHeaders(): Record<string, string | undefined> {
    // Get base headers from parent class
    const baseHeaders = super.buildHeaders();

    // Add OpenRouter-specific headers
    return {
      ...baseHeaders,
      'HTTP-Referer': 'https://github.com/leigest519/OpenGame.git',
      'X-Title': 'OpenGame',
    };
  }

  override buildClient(): OpenAI {
    const config = this.contentGeneratorConfig;
    const rawBaseUrl = config.baseUrl ?? 'https://openrouter.ai/api/v1';
    const baseURL = normalizeOpenRouterBaseUrl(rawBaseUrl);
    const debugMode = this.cliConfig.getDebugMode();

    const instrumented = async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const response = await fetch(input, init);

      if (debugMode) {
        const contentType = response.headers.get('content-type') ?? '';
        const requestId = response.headers.get('x-request-id') ?? '';
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.toString()
              : (input as Request).url;
        console.debug('[DEBUG] [OpenRouter] HTTP response', {
          status: response.status,
          statusText: response.statusText,
          contentType,
          requestId,
          method: init?.method ?? 'GET',
          url,
        });

        if (!response.ok) {
          const clone = response.clone();
          const body = await clone.text();
          console.debug('[DEBUG] [OpenRouter] Error response body', {
            body: body.slice(0, 2000),
          });
        } else if (
          !contentType.includes('application/json') &&
          !contentType.includes('text/event-stream') &&
          !contentType.includes('application/x-ndjson')
        ) {
          const clone = response.clone();
          const body = await clone.text();
          console.debug(
            '[DEBUG] [OpenRouter] Unexpected content-type on 2xx — body preview',
            { contentType, body: body.slice(0, 2000) },
          );
        }
      }

      return response;
    };

    return new OpenAI({
      apiKey: config.apiKey,
      baseURL,
      defaultHeaders: this.buildHeaders(),
      fetch: instrumented,
    });
  }
}
