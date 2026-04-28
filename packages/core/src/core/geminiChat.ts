/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// DISCLAIMER: This is a copied version of https://github.com/googleapis/js-genai/blob/main/src/chats.ts with the intention of working around a key bug
// where function responses are not treated as "valid" responses: https://b.corp.google.com/issues/420354090

import type {
  GenerateContentResponse,
  Content,
  GenerateContentConfig,
  SendMessageParameters,
  Part,
  Tool,
  GenerateContentResponseUsageMetadata,
  FinishReason,
} from '@google/genai';
import { ApiError, createUserContent } from '@google/genai';
import { retryWithBackoff } from '../utils/retry.js';
import type { Config } from '../config/config.js';
import {
  DEFAULT_GEMINI_FLASH_MODEL,
  getEffectiveModel,
} from '../config/models.js';
import { hasCycleInSchema } from '../tools/tools.js';
import type { StructuredError } from './turn.js';
import {
  logContentRetry,
  logContentRetryFailure,
} from '../telemetry/loggers.js';
import { type ChatRecordingService } from '../services/chatRecordingService.js';
import {
  ContentRetryEvent,
  ContentRetryFailureEvent,
} from '../telemetry/types.js';
import { handleFallback } from '../fallback/handler.js';
import { uiTelemetryService } from '../telemetry/uiTelemetry.js';

export enum StreamEventType {
  /** A regular content chunk from the API. */
  CHUNK = 'chunk',
  /** A signal that a retry is about to happen. The UI should discard any partial
   * content from the attempt that just failed. */
  RETRY = 'retry',
}

export type StreamEvent =
  | { type: StreamEventType.CHUNK; value: GenerateContentResponse }
  | { type: StreamEventType.RETRY };

/**
 * Options for retrying due to invalid content from the model.
 */
interface ContentRetryOptions {
  /** Total number of attempts to make (1 initial + N retries). */
  maxAttempts: number;
  /** The base delay in milliseconds for linear backoff. */
  initialDelayMs: number;
}

const INVALID_CONTENT_RETRY_OPTIONS: ContentRetryOptions = {
  maxAttempts: 2, // 1 initial call + 1 retry
  initialDelayMs: 500,
};
/**
 * Returns true if the response is valid, false otherwise.
 *
 * The DashScope provider may return the last 2 chunks as:
 * 1. A choice(candidate) with finishReason and empty content
 * 2. Empty choices with usage metadata
 * We'll check separately for both of these cases.
 */
function isValidResponse(response: GenerateContentResponse): boolean {
  if (response.usageMetadata) {
    return true;
  }

  if (response.candidates === undefined || response.candidates.length === 0) {
    return false;
  }

  if (response.candidates.some((candidate) => candidate.finishReason)) {
    return true;
  }

  const content = response.candidates[0]?.content;
  return content !== undefined && isValidContent(content);
}

export function isValidNonThoughtTextPart(part: Part): boolean {
  return (
    typeof part.text === 'string' &&
    !part.thought &&
    !part.thoughtSignature &&
    // Technically, the model should never generate parts that have text and
    //  any of these but we don't trust them so check anyways.
    !part.functionCall &&
    !part.functionResponse &&
    !part.inlineData &&
    !part.fileData
  );
}

function isValidContent(content: Content): boolean {
  if (content.parts === undefined || content.parts.length === 0) {
    return false;
  }
  for (const part of content.parts) {
    if (part === undefined || Object.keys(part).length === 0) {
      return false;
    }
    if (!isValidContentPart(part)) {
      return false;
    }
  }
  return true;
}

function isValidContentPart(part: Part): boolean {
  const isInvalid =
    !part.thought &&
    !part.thoughtSignature &&
    part.text !== undefined &&
    part.text === '' &&
    part.functionCall === undefined;

  return !isInvalid;
}

function getPartKind(part: Part): string {
  if (part.functionCall) {
    return 'functionCall';
  }
  if (part.functionResponse) {
    return 'functionResponse';
  }
  if (part.inlineData) {
    return 'inlineData';
  }
  if (part.fileData) {
    return 'fileData';
  }
  if (part.text !== undefined) {
    return part.thought ? 'thoughtText' : 'text';
  }
  if (part.thoughtSignature) {
    return 'thoughtSignature';
  }
  return 'unknown';
}

/**
 * Validates the history contains the correct roles.
 *
 * @throws Error if the history does not start with a user turn.
 * @throws Error if the history contains an invalid role.
 */
function validateHistory(history: Content[]) {
  for (const content of history) {
    if (content.role !== 'user' && content.role !== 'model') {
      throw new Error(`Role must be user or model, but got ${content.role}.`);
    }
  }
}

/**
 * Extracts the curated (valid) history from a comprehensive history.
 *
 * @remarks
 * The model may sometimes generate invalid or empty contents(e.g., due to safety
 * filters or recitation). Extracting valid turns from the history
 * ensures that subsequent requests could be accepted by the model.
 */
function extractCuratedHistory(comprehensiveHistory: Content[]): Content[] {
  if (comprehensiveHistory === undefined || comprehensiveHistory.length === 0) {
    return [];
  }
  const curatedHistory: Content[] = [];
  const length = comprehensiveHistory.length;
  let i = 0;
  while (i < length) {
    if (comprehensiveHistory[i].role === 'user') {
      curatedHistory.push(comprehensiveHistory[i]);
      i++;
    } else {
      const modelOutput: Content[] = [];
      let isValid = true;
      while (i < length && comprehensiveHistory[i].role === 'model') {
        modelOutput.push(comprehensiveHistory[i]);
        if (isValid && !isValidContent(comprehensiveHistory[i])) {
          isValid = false;
        }
        i++;
      }
      if (isValid) {
        curatedHistory.push(...modelOutput);
      }
    }
  }
  return curatedHistory;
}

/**
 * Custom error to signal that a stream completed with invalid content,
 * which should trigger a retry.
 */
export class InvalidStreamError extends Error {
  readonly type: 'NO_FINISH_REASON' | 'NO_RESPONSE_TEXT';

  constructor(message: string, type: 'NO_FINISH_REASON' | 'NO_RESPONSE_TEXT') {
    super(message);
    this.name = 'InvalidStreamError';
    this.type = type;
  }
}

/**
 * Chat session that enables sending messages to the model with previous
 * conversation context.
 *
 * @remarks
 * The session maintains all the turns between user and model.
 */
export class GeminiChat {
  // A promise to represent the current state of the message being sent to the
  // model.
  private sendPromise: Promise<void> = Promise.resolve();

  /**
   * Creates a new GeminiChat instance.
   *
   * @param config - The configuration object.
   * @param generationConfig - Optional generation configuration.
   * @param history - Optional initial conversation history.
   * @param chatRecordingService - Optional recording service. If provided, chat
   *   messages will be recorded.
   */
  constructor(
    private readonly config: Config,
    private readonly generationConfig: GenerateContentConfig = {},
    private history: Content[] = [],
    private readonly chatRecordingService?: ChatRecordingService,
  ) {
    validateHistory(history);
  }

  setSystemInstruction(sysInstr: string) {
    this.generationConfig.systemInstruction = sysInstr;
  }

  /**
   * Sends a message to the model and returns the response in chunks.
   *
   * @remarks
   * This method will wait for the previous message to be processed before
   * sending the next message.
   *
   * @see {@link Chat#sendMessage} for non-streaming method.
   * @param params - parameters for sending the message.
   * @return The model's response.
   *
   * @example
   * ```ts
   * const chat = ai.chats.create({model: 'gemini-2.0-flash'});
   * const response = await chat.sendMessageStream({
   * message: 'Why is the sky blue?'
   * });
   * for await (const chunk of response) {
   * console.log(chunk.text);
   * }
   * ```
   */
  async sendMessageStream(
    model: string,
    params: SendMessageParameters,
    prompt_id: string,
  ): Promise<AsyncGenerator<StreamEvent>> {
    await this.sendPromise;

    let streamDoneResolver: () => void;
    const streamDonePromise = new Promise<void>((resolve) => {
      streamDoneResolver = resolve;
    });
    this.sendPromise = streamDonePromise;

    const userContent = createUserContent(params.message);

    // Add user content to history ONCE before any attempts.
    this.history.push(userContent);
    const requestContents = this.getHistory(true);

    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return (async function* () {
      try {
        let lastError: unknown = new Error('Request failed after all retries.');

        for (
          let attempt = 0;
          attempt < INVALID_CONTENT_RETRY_OPTIONS.maxAttempts;
          attempt++
        ) {
          try {
            if (attempt > 0) {
              yield { type: StreamEventType.RETRY };
            }

            const stream = await self.makeApiCallAndProcessStream(
              model,
              requestContents,
              params,
              prompt_id,
            );

            for await (const chunk of stream) {
              yield { type: StreamEventType.CHUNK, value: chunk };
            }

            lastError = null;
            break;
          } catch (error) {
            lastError = error;
            const isContentError = error instanceof InvalidStreamError;
            const isRetryableApiError = self.isRetryableApiError(error);

            const message =
              error instanceof Error ? error.message : String(error);
            console.error(
              `[OpenAI stream] attempt ${attempt + 1}/${INVALID_CONTENT_RETRY_OPTIONS.maxAttempts} failed: ${message}`,
            );

            if (isContentError) {
              // Check if we have more attempts left.
              if (attempt < INVALID_CONTENT_RETRY_OPTIONS.maxAttempts - 1) {
                logContentRetry(
                  self.config,
                  new ContentRetryEvent(
                    attempt,
                    (error as InvalidStreamError).type,
                    INVALID_CONTENT_RETRY_OPTIONS.initialDelayMs,
                    model,
                  ),
                );
                await new Promise((res) =>
                  setTimeout(
                    res,
                    INVALID_CONTENT_RETRY_OPTIONS.initialDelayMs *
                      (attempt + 1),
                  ),
                );
                continue;
              }
            }

            if (
              isRetryableApiError &&
              attempt < INVALID_CONTENT_RETRY_OPTIONS.maxAttempts - 1
            ) {
              const delayMs =
                INVALID_CONTENT_RETRY_OPTIONS.initialDelayMs * (attempt + 1);
              if (self.config.getDebugMode()) {
                console.debug('[DEBUG] [GeminiChat] Retrying after API error', {
                  attempt: attempt + 1,
                  delayMs,
                  message,
                });
              }
              await new Promise((res) => setTimeout(res, delayMs));
              continue;
            }

            break;
          }
        }

        if (lastError) {
          if (lastError instanceof InvalidStreamError) {
            logContentRetryFailure(
              self.config,
              new ContentRetryFailureEvent(
                INVALID_CONTENT_RETRY_OPTIONS.maxAttempts,
                (lastError as InvalidStreamError).type,
                model,
              ),
            );
          }
          throw lastError;
        }
      } finally {
        streamDoneResolver!();
      }
    })();
  }

  private async makeApiCallAndProcessStream(
    model: string,
    requestContents: Content[],
    params: SendMessageParameters,
    prompt_id: string,
  ): Promise<AsyncGenerator<GenerateContentResponse>> {
    const apiCall = () => {
      const modelToUse = getEffectiveModel(
        this.config.isInFallbackMode(),
        model,
      );

      if (
        this.config.getQuotaErrorOccurred() &&
        modelToUse === DEFAULT_GEMINI_FLASH_MODEL
      ) {
        throw new Error(
          'Please submit a new query to continue with the Flash model.',
        );
      }

      return this.config.getContentGenerator().generateContentStream(
        {
          model: modelToUse,
          contents: requestContents,
          config: { ...this.generationConfig, ...params.config },
        },
        prompt_id,
      );
    };

    const onPersistent429Callback = async (
      authType?: string,
      error?: unknown,
    ) => await handleFallback(this.config, model, authType, error);

    const streamResponse = await retryWithBackoff(apiCall, {
      shouldRetryOnError: (error: unknown) => {
        const message =
          error instanceof Error ? error.message.toLowerCase() : String(error);

        // OpenRouter can surface transient upstream provider failures as HTTP 400
        // with message like "Provider returned error".
        if (message.includes('provider returned error')) return true;

        // Retry common timeout/network transient failures.
        if (
          message.includes('timeout') ||
          message.includes('timed out') ||
          message.includes('econnreset') ||
          message.includes('connection reset') ||
          message.includes('socket hang up') ||
          message.includes('etimedout') ||
          message.includes('esockettimedout') ||
          message.includes('deadline exceeded')
        ) {
          return true;
        }

        if (error instanceof ApiError && error.message) {
          if (error.status === 400) return false;
          if (isSchemaDepthError(error.message)) return false;
          if (error.status === 429) return true;
          if (error.status >= 500 && error.status < 600) return true;
        }
        return false;
      },
      onPersistent429: onPersistent429Callback,
      authType: this.config.getContentGeneratorConfig()?.authType,
    });

    return this.processStreamResponse(model, streamResponse);
  }

  private isRetryableApiError(error: unknown): boolean {
    const message =
      error instanceof Error ? error.message.toLowerCase() : String(error);

    if (message.includes('provider returned error')) return true;

    if (
      message.includes('timeout') ||
      message.includes('timed out') ||
      message.includes('econnreset') ||
      message.includes('connection reset') ||
      message.includes('socket hang up') ||
      message.includes('etimedout') ||
      message.includes('esockettimedout') ||
      message.includes('deadline exceeded')
    ) {
      return true;
    }

    if (error instanceof ApiError) {
      // OpenRouter transient upstream errors can bubble as 400.
      if (error.status === 400 && message.includes('provider returned error')) {
        return true;
      }

      // For other HTTP statuses, keep behavior delegated to the inner
      // retryWithBackoff/onPersistent429 path to avoid duplicate retries.
      return false;
    }

    return false;
  }

  /**
   * Returns the chat history.
   *
   * @remarks
   * The history is a list of contents alternating between user and model.
   *
   * There are two types of history:
   * - The `curated history` contains only the valid turns between user and
   * model, which will be included in the subsequent requests sent to the model.
   * - The `comprehensive history` contains all turns, including invalid or
   * empty model outputs, providing a complete record of the history.
   *
   * The history is updated after receiving the response from the model,
   * for streaming response, it means receiving the last chunk of the response.
   *
   * The `comprehensive history` is returned by default. To get the `curated
   * history`, set the `curated` parameter to `true`.
   *
   * @param curated - whether to return the curated history or the comprehensive
   * history.
   * @return History contents alternating between user and model for the entire
   * chat session.
   */
  getHistory(curated: boolean = false): Content[] {
    const history = curated
      ? extractCuratedHistory(this.history)
      : this.history;
    // Deep copy the history to avoid mutating the history outside of the
    // chat session.
    return structuredClone(history);
  }

  /**
   * Clears the chat history.
   */
  clearHistory(): void {
    this.history = [];
  }

  /**
   * Adds a new entry to the chat history.
   */
  addHistory(content: Content): void {
    this.history.push(content);
  }

  setHistory(history: Content[]): void {
    this.history = history;
  }

  stripThoughtsFromHistory(): void {
    this.history = this.history
      .map((content) => {
        if (!content.parts) return content;

        // Filter out thought parts entirely
        const filteredParts = content.parts
          .filter(
            (part) =>
              !(
                part &&
                typeof part === 'object' &&
                'thought' in part &&
                part.thought
              ),
          )
          .map((part) => {
            if (
              part &&
              typeof part === 'object' &&
              'thoughtSignature' in part
            ) {
              const newPart = { ...part };
              delete (newPart as { thoughtSignature?: string })
                .thoughtSignature;
              return newPart;
            }
            return part;
          });

        return {
          ...content,
          parts: filteredParts,
        };
      })
      // Remove Content objects that have no parts left after filtering
      .filter((content) => content.parts && content.parts.length > 0);
  }

  setTools(tools: Tool[]): void {
    this.generationConfig.tools = tools;
  }

  async maybeIncludeSchemaDepthContext(error: StructuredError): Promise<void> {
    // Check for potentially problematic cyclic tools with cyclic schemas
    // and include a recommendation to remove potentially problematic tools.
    if (
      isSchemaDepthError(error.message) ||
      isInvalidArgumentError(error.message)
    ) {
      const tools = this.config.getToolRegistry().getAllTools();
      const cyclicSchemaTools: string[] = [];
      for (const tool of tools) {
        if (
          (tool.schema.parametersJsonSchema &&
            hasCycleInSchema(tool.schema.parametersJsonSchema)) ||
          (tool.schema.parameters && hasCycleInSchema(tool.schema.parameters))
        ) {
          cyclicSchemaTools.push(tool.displayName);
        }
      }
      if (cyclicSchemaTools.length > 0) {
        const extraDetails =
          `\n\nThis error was probably caused by cyclic schema references in one of the following tools, try disabling them with excludeTools:\n\n - ` +
          cyclicSchemaTools.join(`\n - `) +
          `\n`;
        error.message += extraDetails;
      }
    }
  }

  private async *processStreamResponse(
    model: string,
    streamResponse: AsyncGenerator<GenerateContentResponse>,
  ): AsyncGenerator<GenerateContentResponse> {
    // Collect ALL parts from the model response (including thoughts for recording)
    const allModelParts: Part[] = [];
    let usageMetadata: GenerateContentResponseUsageMetadata | undefined;

    let hasToolCall = false;
    let hasFinishReason = false;
    let chunkCount = 0;
    let chunksWithCandidates = 0;
    let chunksWithUsageMetadata = 0;
    const finishReasons = new Set<FinishReason>();
    let lastChunkSummary:
      | {
          candidateCount: number;
          hasUsageMetadata: boolean;
          finishReasons: FinishReason[];
          firstCandidatePartKinds: string[];
        }
      | undefined;

    for await (const chunk of streamResponse) {
      chunkCount += 1;

      if (this.config.getDebugMode()) {
        console.debug(`[DEBUG] [GeminiChat] chunk #${chunkCount}`, JSON.stringify(chunk, null, 2));
      }

      const candidates = chunk?.candidates ?? [];
      if (candidates.length > 0) {
        chunksWithCandidates += 1;
      }

      const chunkFinishReasons = candidates
        .map((candidate) => candidate.finishReason)
        .filter((reason): reason is FinishReason => reason !== undefined);
      if (chunkFinishReasons.length > 0) {
        hasFinishReason = true;
        for (const reason of chunkFinishReasons) {
          finishReasons.add(reason);
        }
      }

      lastChunkSummary = {
        candidateCount: candidates.length,
        hasUsageMetadata: !!chunk.usageMetadata,
        finishReasons: chunkFinishReasons,
        firstCandidatePartKinds:
          candidates[0]?.content?.parts?.map(getPartKind) ?? [],
      };

      if (isValidResponse(chunk)) {
        const content = chunk.candidates?.[0]?.content;
        if (content?.parts) {
          if (content.parts.some((part) => part.functionCall)) {
            hasToolCall = true;
          }

          // Collect all parts for recording
          allModelParts.push(...content.parts);
        }
      }

      // Collect token usage for consolidated recording
      if (chunk.usageMetadata) {
        chunksWithUsageMetadata += 1;
        usageMetadata = chunk.usageMetadata;
        if (chunk.usageMetadata.promptTokenCount !== undefined) {
          uiTelemetryService.setLastPromptTokenCount(
            chunk.usageMetadata.promptTokenCount,
          );
        }
      }

      yield chunk; // Yield every chunk to the UI immediately.
    }

    let thoughtContentPart: Part | undefined;
    const thoughtText = allModelParts
      .filter((part) => part.thought)
      .map((part) => part.text)
      .join('')
      .trim();

    if (thoughtText !== '') {
      thoughtContentPart = {
        text: thoughtText,
        thought: true,
      };

      const thoughtSignature = allModelParts.filter(
        (part) => part.thoughtSignature && part.thought,
      )?.[0]?.thoughtSignature;
      if (thoughtContentPart && thoughtSignature) {
        thoughtContentPart.thoughtSignature = thoughtSignature;
      }
    }

    const contentParts = allModelParts.filter((part) => !part.thought);
    const consolidatedHistoryParts: Part[] = [];
    for (const part of contentParts) {
      const lastPart =
        consolidatedHistoryParts[consolidatedHistoryParts.length - 1];
      if (
        lastPart?.text &&
        isValidNonThoughtTextPart(lastPart) &&
        isValidNonThoughtTextPart(part)
      ) {
        lastPart.text += part.text;
      } else if (isValidContentPart(part)) {
        consolidatedHistoryParts.push(part);
      }
    }

    const contentText = consolidatedHistoryParts
      .filter((part) => part.text)
      .map((part) => part.text)
      .join('')
      .trim();

    // Record assistant turn with raw Content and metadata
    if (thoughtContentPart || contentText || hasToolCall || usageMetadata) {
      const assistantMessageParts: Part[] = [
        ...(thoughtContentPart ? [thoughtContentPart] : []),
        ...(contentText ? [{ text: contentText }] : []),
        ...(hasToolCall
          ? contentParts
              .filter((part) => part.functionCall)
              .map((part) => ({ functionCall: part.functionCall }))
          : []),
      ];
      this.chatRecordingService?.recordAssistantTurn({
        model,
        ...(assistantMessageParts.length > 0
          ? { message: assistantMessageParts }
          : {}),
        tokens: usageMetadata,
      });
    }

    // Stream validation logic: A stream is considered successful if:
    // 1. There's a tool call (tool calls can end without explicit finish reasons), OR
    // 2. There's a finish reason (even with empty content — some providers return STOP + no parts)
    //
    // We throw only when there's no tool call AND no finish reason at all.
    if (!hasToolCall && !hasFinishReason) {
      if (this.config.getDebugMode()) {
        console.debug('[DEBUG] [GeminiChat] Invalid stream diagnostics', {
          model,
          chunkCount,
          chunksWithCandidates,
          chunksWithUsageMetadata,
          hasToolCall,
          hasFinishReason,
          finishReasons: Array.from(finishReasons),
          contentTextLength: contentText.length,
          thoughtTextLength: thoughtText.length,
          lastChunkSummary,
        });
      }

      throw new InvalidStreamError(
        'Model stream ended without a finish reason.',
        'NO_FINISH_REASON',
      );
    }

    // When finish reason is present but content is empty, log a warning and continue.
    if (!hasToolCall && hasFinishReason && !contentText) {
      if (this.config.getDebugMode()) {
        console.debug(
          '[DEBUG] [GeminiChat] Stream ended with finish reason but empty content — treating as empty response.',
          {
            model,
            finishReasons: Array.from(finishReasons),
            chunkCount,
          },
        );
      }
    }

    this.history.push({
      role: 'model',
      parts: [
        ...(thoughtContentPart ? [thoughtContentPart] : []),
        ...consolidatedHistoryParts,
      ],
    });
  }
}

/** Visible for Testing */
export function isSchemaDepthError(errorMessage: string): boolean {
  return errorMessage.includes('maximum schema depth exceeded');
}

export function isInvalidArgumentError(errorMessage: string): boolean {
  return errorMessage.includes('Request contains an invalid argument');
}
