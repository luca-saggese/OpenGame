/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type OpenAI from 'openai';
import {
  type GenerateContentParameters,
  GenerateContentResponse,
} from '@google/genai';
import type { Config } from '../../config/config.js';
import type { ContentGeneratorConfig } from '../contentGenerator.js';
import type { OpenAICompatibleProvider } from './provider/index.js';
import { OpenAIContentConverter } from './converter.js';
import type { ErrorHandler, RequestContext } from './errorHandler.js';
import { retryWithBackoff } from '../../utils/retry.js';

export interface PipelineConfig {
  cliConfig: Config;
  provider: OpenAICompatibleProvider;
  contentGeneratorConfig: ContentGeneratorConfig;
  errorHandler: ErrorHandler;
}

export class ContentGenerationPipeline {
  client: OpenAI;
  private converter: OpenAIContentConverter;
  private contentGeneratorConfig: ContentGeneratorConfig;

  constructor(private config: PipelineConfig) {
    this.contentGeneratorConfig = config.contentGeneratorConfig;
    this.client = this.config.provider.buildClient();
    this.converter = new OpenAIContentConverter(
      this.contentGeneratorConfig.model,
      this.contentGeneratorConfig.schemaCompliance,
    );
  }

  async execute(
    request: GenerateContentParameters,
    userPromptId: string,
  ): Promise<GenerateContentResponse> {
    return this.executeWithErrorHandling(
      request,
      userPromptId,
      false,
      async (openaiRequest, context) => {
        await this.writeDebugDump(context, 'request', {
          type: 'openai-chat-completions-request',
          streaming: false,
          request: openaiRequest,
        });

        const openaiResponse = (await this.client.chat.completions.create(
          openaiRequest,
          {
            signal: request.config?.abortSignal,
          },
        )) as OpenAI.Chat.ChatCompletion;

        await this.writeDebugDump(context, 'response', {
          type: 'openai-chat-completions-response',
          streaming: false,
          response: openaiResponse,
        });

        const geminiResponse =
          this.converter.convertOpenAIResponseToGemini(openaiResponse);

        return geminiResponse;
      },
    );
  }

  async executeStream(
    request: GenerateContentParameters,
    userPromptId: string,
  ): Promise<AsyncGenerator<GenerateContentResponse>> {
    return this.executeWithErrorHandling(
      request,
      userPromptId,
      true,
      async (openaiRequest, context) => {
        await this.writeDebugDump(context, 'request', {
          type: 'openai-chat-completions-request',
          streaming: true,
          request: openaiRequest,
        });

        // Stage 1: Create OpenAI stream
        const stream = (await this.client.chat.completions.create(
          openaiRequest,
          {
            signal: request.config?.abortSignal,
          },
        )) as AsyncIterable<OpenAI.Chat.ChatCompletionChunk>;

        // Stage 2: Process stream with conversion and logging
        return this.processStreamWithLogging(
          stream,
          context,
          request,
          openaiRequest,
        );
      },
    );
  }

  /**
   * Stage 2: Process OpenAI stream with conversion and logging
   * This method handles the complete stream processing pipeline:
   * 1. Convert OpenAI chunks to Gemini format while preserving original chunks
   * 2. Filter empty responses
   * 3. Handle chunk merging for providers that send finishReason and usageMetadata separately
   * 4. Collect both formats for logging
   * 5. Handle success/error logging
   */
  private async *processStreamWithLogging(
    stream: AsyncIterable<OpenAI.Chat.ChatCompletionChunk>,
    context: RequestContext,
    request: GenerateContentParameters,
    openaiRequest: OpenAI.Chat.ChatCompletionCreateParams,
  ): AsyncGenerator<GenerateContentResponse> {
    const collectedGeminiResponses: GenerateContentResponse[] = [];
    const rawOpenAIChunks: OpenAI.Chat.ChatCompletionChunk[] = [];

    // Reset streaming tool calls to prevent data pollution from previous streams
    this.converter.resetStreamingToolCalls();

    // State for handling chunk merging
    let pendingFinishResponse: GenerateContentResponse | null = null;

    try {
      // Stage 2a: Convert and yield each chunk while preserving original
      for await (const chunk of stream) {
        rawOpenAIChunks.push(chunk);

        if (this.config.cliConfig.getDebugMode()) {
          console.debug(
            '[DEBUG] [OpenAIContentPipeline] raw chunk',
            JSON.stringify(chunk, null, 2),
          );
        }

        const response = this.converter.convertOpenAIChunkToGemini(chunk);

        // Stage 2b: Filter empty responses to avoid downstream issues
        if (
          response.candidates?.[0]?.content?.parts?.length === 0 &&
          !response.candidates?.[0]?.finishReason &&
          !response.usageMetadata
        ) {
          continue;
        }

        // Stage 2c: Handle chunk merging for providers that send finishReason and usageMetadata separately
        const shouldYield = this.handleChunkMerging(
          response,
          collectedGeminiResponses,
          (mergedResponse) => {
            pendingFinishResponse = mergedResponse;
          },
        );

        if (shouldYield) {
          // If we have a pending finish response, yield it instead
          if (pendingFinishResponse) {
            yield pendingFinishResponse;
            pendingFinishResponse = null;
          } else {
            yield response;
          }
        }
      }

      // Stage 2d: If there's still a pending finish response at the end, yield it
      if (pendingFinishResponse) {
        yield pendingFinishResponse;
      }

      // Stage 2e: Stream completed successfully
      context.duration = Date.now() - context.startTime;

      await this.writeDebugDump(context, 'response', {
        type: 'openai-chat-completions-stream-response',
        streaming: true,
        request: openaiRequest,
        rawChunks: rawOpenAIChunks,
        convertedResponses: collectedGeminiResponses,
      });
    } catch (error) {
      await this.writeDebugDump(context, 'response', {
        type: 'openai-chat-completions-stream-response',
        streaming: true,
        request: openaiRequest,
        rawChunks: rawOpenAIChunks,
        convertedResponses: collectedGeminiResponses,
        error:
          error instanceof Error
            ? { name: error.name, message: error.message, stack: error.stack }
            : error,
      });

      // Clear streaming tool calls on error to prevent data pollution
      this.converter.resetStreamingToolCalls();

      // Use shared error handling logic
      await this.handleError(error, context, request);
    }
  }

  /**
   * Handle chunk merging for providers that send finishReason and usageMetadata separately.
   *
   * Strategy: When we encounter a finishReason chunk, we hold it and merge all subsequent
   * chunks into it until the stream ends. This ensures the final chunk contains both
   * finishReason and the most up-to-date usage information from any provider pattern.
   *
   * @param response Current Gemini response
   * @param collectedGeminiResponses Array to collect responses for logging
   * @param setPendingFinish Callback to set pending finish response
   * @returns true if the response should be yielded, false if it should be held for merging
   */
  private handleChunkMerging(
    response: GenerateContentResponse,
    collectedGeminiResponses: GenerateContentResponse[],
    setPendingFinish: (response: GenerateContentResponse) => void,
  ): boolean {
    const isFinishChunk = response.candidates?.[0]?.finishReason;

    // Check if we have a pending finish response from previous chunks
    const hasPendingFinish =
      collectedGeminiResponses.length > 0 &&
      collectedGeminiResponses[collectedGeminiResponses.length - 1]
        .candidates?.[0]?.finishReason;

    if (isFinishChunk && hasPendingFinish) {
      const lastResponse =
        collectedGeminiResponses[collectedGeminiResponses.length - 1];
      const mergedResponse = new GenerateContentResponse();

      const previousCandidate = lastResponse.candidates?.[0];
      const currentCandidate = response.candidates?.[0];
      const currentParts = currentCandidate?.content?.parts ?? [];
      const previousParts = previousCandidate?.content?.parts ?? [];

      mergedResponse.candidates = [
        {
          ...(currentCandidate ?? previousCandidate),
          content: {
            role:
              currentCandidate?.content?.role ??
              previousCandidate?.content?.role ??
              'model',
            parts: currentParts.length > 0 ? currentParts : previousParts,
          },
          finishReason:
            currentCandidate?.finishReason ?? previousCandidate?.finishReason,
          index: currentCandidate?.index ?? previousCandidate?.index ?? 0,
          safetyRatings:
            currentCandidate?.safetyRatings ?? previousCandidate?.safetyRatings ?? [],
        },
      ];

      mergedResponse.usageMetadata =
        response.usageMetadata ?? lastResponse.usageMetadata;
      mergedResponse.responseId = response.responseId ?? lastResponse.responseId;
      mergedResponse.createTime = response.createTime ?? lastResponse.createTime;
      mergedResponse.modelVersion =
        response.modelVersion ?? lastResponse.modelVersion;
      mergedResponse.promptFeedback =
        response.promptFeedback ?? lastResponse.promptFeedback;

      collectedGeminiResponses[collectedGeminiResponses.length - 1] =
        mergedResponse;
      setPendingFinish(mergedResponse);
      return true;
    }

    if (isFinishChunk) {
      // This is a finish reason chunk
      collectedGeminiResponses.push(response);
      setPendingFinish(response);
      return false; // Don't yield yet, wait for potential subsequent chunks to merge
    } else if (hasPendingFinish) {
      // We have a pending finish chunk, merge this chunk's data into it
      const lastResponse =
        collectedGeminiResponses[collectedGeminiResponses.length - 1];
      const mergedResponse = new GenerateContentResponse();

      // Keep the finish reason from the previous chunk
      mergedResponse.candidates = lastResponse.candidates;

      // Merge usage metadata if this chunk has it
      if (response.usageMetadata) {
        mergedResponse.usageMetadata = response.usageMetadata;
      } else {
        mergedResponse.usageMetadata = lastResponse.usageMetadata;
      }

      // Copy other essential properties from the current response
      mergedResponse.responseId = response.responseId;
      mergedResponse.createTime = response.createTime;
      mergedResponse.modelVersion = response.modelVersion;
      mergedResponse.promptFeedback = response.promptFeedback;

      // Update the collected responses with the merged response
      collectedGeminiResponses[collectedGeminiResponses.length - 1] =
        mergedResponse;

      setPendingFinish(mergedResponse);
      return true; // Yield the merged response
    }

    // Normal chunk - collect and yield
    collectedGeminiResponses.push(response);
    return true;
  }

  private async buildRequest(
    request: GenerateContentParameters,
    userPromptId: string,
    streaming: boolean = false,
  ): Promise<OpenAI.Chat.ChatCompletionCreateParams> {
    const messages = this.converter.convertGeminiRequestToOpenAI(request);

    // Apply provider-specific enhancements
    const baseRequest: OpenAI.Chat.ChatCompletionCreateParams = {
      model: this.contentGeneratorConfig.model,
      messages,
      ...this.buildGenerateContentConfig(request),
    };

    // Add streaming options if present
    if (streaming) {
      (
        baseRequest as unknown as OpenAI.Chat.ChatCompletionCreateParamsStreaming
      ).stream = true;
      baseRequest.stream_options = { include_usage: true };
    }

    // Add tools if present
    if (request.config?.tools) {
      baseRequest.tools = await this.converter.convertGeminiToolsToOpenAI(
        request.config.tools,
      );
    }

    // Let provider enhance the request (e.g., add metadata, cache control)
    return this.config.provider.buildRequest(baseRequest, userPromptId);
  }

  private buildGenerateContentConfig(
    request: GenerateContentParameters,
  ): Record<string, unknown> {
    const defaultSamplingParams =
      this.config.provider.getDefaultGenerationConfig();
    const configSamplingParams = this.contentGeneratorConfig.samplingParams;

    // Helper function to get parameter value with priority: config > request > default
    const getParameterValue = <T>(
      configKey: keyof NonNullable<typeof configSamplingParams>,
      requestKey?: keyof NonNullable<typeof request.config>,
    ): T | undefined => {
      const configValue = configSamplingParams?.[configKey] as T | undefined;
      const requestValue = requestKey
        ? (request.config?.[requestKey] as T | undefined)
        : undefined;
      const defaultValue = requestKey
        ? (defaultSamplingParams[requestKey] as T)
        : undefined;

      if (configValue !== undefined) return configValue;
      if (requestValue !== undefined) return requestValue;
      return defaultValue;
    };

    // Helper function to conditionally add parameter if it has a value
    const addParameterIfDefined = <T>(
      key: string,
      configKey: keyof NonNullable<typeof configSamplingParams>,
      requestKey?: keyof NonNullable<typeof request.config>,
    ): Record<string, T | undefined> => {
      const value = getParameterValue<T>(configKey, requestKey);

      return value !== undefined ? { [key]: value } : {};
    };

    const params: Record<string, unknown> = {
      // Parameters with request fallback but no defaults
      ...addParameterIfDefined('temperature', 'temperature', 'temperature'),
      ...addParameterIfDefined('top_p', 'top_p', 'topP'),

      // Max tokens (special case: different property names)
      ...addParameterIfDefined('max_tokens', 'max_tokens', 'maxOutputTokens'),

      // Config-only parameters (no request fallback)
      ...addParameterIfDefined('top_k', 'top_k', 'topK'),
      ...addParameterIfDefined('repetition_penalty', 'repetition_penalty'),
      ...addParameterIfDefined(
        'presence_penalty',
        'presence_penalty',
        'presencePenalty',
      ),
      ...addParameterIfDefined(
        'frequency_penalty',
        'frequency_penalty',
        'frequencyPenalty',
      ),
      ...this.buildReasoningConfig(),
    };

    return params;
  }

  private buildReasoningConfig(): Record<string, unknown> {
    const reasoning = this.contentGeneratorConfig.reasoning;

    if (reasoning === false) {
      return {};
    }

    return {
      reasoning_effort: reasoning?.effort ?? 'medium',
    };
  }

  /**
   * Common error handling wrapper for execute methods
   */
  private async executeWithErrorHandling<T>(
    request: GenerateContentParameters,
    userPromptId: string,
    isStreaming: boolean,
    executor: (
      openaiRequest: OpenAI.Chat.ChatCompletionCreateParams,
      context: RequestContext,
    ) => Promise<T>,
  ): Promise<T> {
    const context = this.createRequestContext(userPromptId, isStreaming);

    try {
      const openaiRequest = await this.buildRequest(
        request,
        userPromptId,
        isStreaming,
      );

      const maxRetries = this.contentGeneratorConfig.maxRetries ?? 2;
      const maxAttempts = Math.max(1, maxRetries + 1);

      const result = await retryWithBackoff(
        async () => executor(openaiRequest, context),
        {
          maxAttempts,
          initialDelayMs: 1000,
          maxDelayMs: 8000,
          shouldRetryOnError: (error: Error) =>
            this.shouldRetryApiError(error, request),
        },
      );

      context.duration = Date.now() - context.startTime;
      return result;
    } catch (error) {
      // Use shared error handling logic
      return await this.handleError(error, context, request);
    }
  }

  /**
   * Shared error handling logic for both executeWithErrorHandling and processStreamWithLogging
   * This centralizes the common error processing steps to avoid duplication
   */
  private async handleError(
    error: unknown,
    context: RequestContext,
    request: GenerateContentParameters,
  ): Promise<never> {
    context.duration = Date.now() - context.startTime;
    this.config.errorHandler.handle(error, context, request);
  }

  /**
   * Create request context with common properties
   */
  private createRequestContext(
    userPromptId: string,
    isStreaming: boolean,
  ): RequestContext {
    return {
      userPromptId,
      model: this.contentGeneratorConfig.model,
      authType: this.contentGeneratorConfig.authType || 'unknown',
      startTime: Date.now(),
      duration: 0,
      isStreaming,
    };
  }

  private async writeDebugDump(
    context: RequestContext,
    kind: 'request' | 'response',
    payload: unknown,
  ): Promise<void> {
    if (!this.config.cliConfig.getDebugMode()) {
      return;
    }

    const dumpPath = this.getDebugDumpPath(context, kind);
    await fs.writeFile(dumpPath, JSON.stringify(payload, null, 2), 'utf-8');

    console.debug(
      `[DEBUG] [OpenAIContentPipeline] Saved ${kind} dump to ${dumpPath}`,
    );
  }

  private getDebugDumpPath(
    context: RequestContext,
    kind: 'request' | 'response',
  ): string {
    const safePromptId = context.userPromptId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const fileName = `openai-content-${safePromptId}-${context.startTime}-${kind}.json`;
    return path.join(os.tmpdir(), fileName);
  }

  private shouldRetryApiError(
    error: Error | unknown,
    request: GenerateContentParameters,
  ): boolean {
    // Never retry if the caller explicitly aborted the request.
    if (request.config?.abortSignal?.aborted) {
      return false;
    }

    const message =
      error instanceof Error ? error.message.toLowerCase() : String(error);
    const status = this.getErrorStatus(error);

    // OpenRouter sometimes wraps upstream transient failures as 400 with
    // message like "Provider returned error". Treat this as retryable.
    if (status === 400 && message.includes('provider returned error')) {
      return true;
    }

    // Retry timeout/network-flaky errors.
    if (
      message.includes('timeout') ||
      message.includes('timed out') ||
      message.includes('connection reset') ||
      message.includes('socket hang up') ||
      message.includes('econnreset') ||
      message.includes('etimedout') ||
      message.includes('esockettimedout') ||
      message.includes('deadline exceeded')
    ) {
      return true;
    }

    // Retry common transient HTTP statuses.
    if (status === 408 || status === 409 || status === 425 || status === 429) {
      return true;
    }
    if (typeof status === 'number' && status >= 500 && status < 600) {
      return true;
    }

    return false;
  }

  private getErrorStatus(error: unknown): number | undefined {
    if (typeof error !== 'object' || error === null) {
      return undefined;
    }

    if ('status' in error && typeof error.status === 'number') {
      return error.status;
    }

    if (
      'response' in error &&
      typeof (error as { response?: unknown }).response === 'object' &&
      (error as { response?: unknown }).response !== null
    ) {
      const response = (error as { response: { status?: unknown } }).response;
      if (typeof response.status === 'number') {
        return response.status;
      }
    }

    return undefined;
  }
}
