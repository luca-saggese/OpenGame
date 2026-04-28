/**
 * Image Generation Service
 * Supports Tongyi and Doubao models
 * Inspired by PiXelDa's model architecture
 */

import { BaseService } from './assetBaseService.js';
import type { ImageModelConfig } from '../tools/generate-assets-types.js';
import { debug } from '@anthropic-ai/sdk/core.mjs';

// ============== Debug Logging ==============

function debugLog(label: string, data: unknown): void {
  if (process.env.DEBUG === '1') {
    console.error(`\n[DEBUG] ${label}:`);
    if (typeof data === 'string') {
      console.error(data);
    } else {
      console.error(JSON.stringify(data, null, 2));
    }
    console.error('---\n');
  }
}

// ============== Tongyi Image Service ==============

export class TongyiImageService extends BaseService {
  private config: ImageModelConfig;

  constructor(config: ImageModelConfig) {
    super();
    this.config = config;
  }

  private isAsyncModel(modelName: string): boolean {
    return modelName.includes('wan') && modelName.includes('t2i');
  }

  async generateImage(
    prompt: string,
    size: string = '1024*1024',
  ): Promise<string> {
    debugLog('generateImage - Input Prompt', prompt);
    
    this.log(`Generating image with Tongyi: ${prompt.substring(0, 50)}...`);

    const modelName = this.config.modelNameGeneration;

    if (this.isAsyncModel(modelName)) {
      return this.generateImageAsync(prompt, size);
    } else {
      return this.generateImageSync(prompt, size);
    }
  }

  private async generateImageAsync(
    prompt: string,
    size: string,
  ): Promise<string> {
    const url = `${this.config.baseUrl}/api/v1/services/aigc/text2image/image-synthesis`;

    const payload = {
      model: this.config.modelNameGeneration,
      input: {
        prompt,
        negative_prompt: '',
      },
      parameters: {
        prompt_extend: false,
        size,
        n: 1,
      },
    };

    debugLog('generateImageAsync - Request Payload', payload);

    const response = await this.fetchWithRetry(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey}`,
        'X-DashScope-Async': 'enable',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(
        `Tongyi Image API failed: ${response.status} - ${errorBody}`,
      );
    }

    const taskData = (await response.json()) as {
      output?: { task_id?: string };
    };
    
    debugLog('generateImageAsync - Task Response', taskData);
    
    const taskId = taskData.output?.task_id;
    if (!taskId) {
      throw new Error('Tongyi text2image returned no task ID');
    }

    this.log(`Created async task: ${taskId}`);

    const taskUrl = `${this.config.baseUrl}/api/v1/tasks/${taskId}`;
    const result = await this.pollTaskStatus(taskUrl, {
      Authorization: `Bearer ${this.config.apiKey}`,
    });

    const resultUrl = result.output?.results?.[0]?.url;
    if (!resultUrl) {
      throw new Error('Tongyi text2image task completed but no URL returned');
    }

    debugLog('generateImageAsync - Final Result URL', resultUrl);
    
    this.log(`Image generated successfully`);
    return resultUrl;
  }

  private async generateImageSync(
    prompt: string,
    size: string,
  ): Promise<string> {
    const url = `${this.config.baseUrl}/api/v1/services/aigc/multimodal-generation/generation`;

    const payload = {
      model: this.config.modelNameGeneration,
      input: {
        messages: [
          {
            role: 'user',
            content: [{ text: prompt }],
          },
        ],
      },
      parameters: {
        prompt_extend: false,
        size,
      },
    };

    debugLog('generateImageSync - Request Payload', payload);

    const response = await this.fetchWithRetry(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(
        `Tongyi Image API failed: ${response.status} - ${errorBody}`,
      );
    }

    const data = (await response.json()) as {
      output?: {
        choices?: Array<{
          message?: { content?: Array<{ image?: string }> | unknown };
        }>;
      };
    };
    
    debugLog('generateImageSync - API Response', data);
    
    const choices = data.output?.choices;
    if (!choices || choices.length === 0) {
      throw new Error('Tongyi returned no choices');
    }

    const content = choices[0].message?.content;
    if (!content || !Array.isArray(content)) {
      throw new Error('Tongyi content format error');
    }

    const imageItem = content.find((item: { image?: string }) => item.image);
    if (!imageItem || !imageItem.image) {
      throw new Error('Tongyi response missing image URL');
    }

    debugLog('generateImageSync - Final Result URL', imageItem.image);
    
    this.log(`Image generated successfully`);
    return imageItem.image;
  }

  private isWanxEditModel(modelName: string): boolean {
    return modelName.includes('wanx') && modelName.includes('imageedit');
  }

  async editImage(
    referenceImageUrl: string,
    prompt: string,
    previousFrameUrl?: string | null,
  ): Promise<string> {
    this.log(`Editing image with Tongyi I2I...`);

    const modelName = this.config.modelNameEditing;

    if (this.isWanxEditModel(modelName)) {
      return this.editImageWanx(referenceImageUrl, prompt);
    } else {
      return this.editImageI2I(referenceImageUrl, prompt, previousFrameUrl);
    }
  }

  private async editImageWanx(
    referenceImageUrl: string,
    prompt: string,
  ): Promise<string> {
    const url = `${this.config.baseUrl}/api/v1/services/aigc/text2image/image-synthesis`;

    debugLog('editImageWanx - Input Prompt', prompt);
    debugLog('editImageWanx - Reference Image URL', referenceImageUrl);

    // Convert URL to Base64 to avoid "url error" issues with cross-region OSS
    const base64Image = await this.imageUrlToBase64(referenceImageUrl);

    const payload = {
      model: this.config.modelNameEditing,
      input: {
        prompt,
        negative_prompt: '',
        function: 'description_edit',
        base_image_url: base64Image,
      },
      parameters: {
        prompt_extend: false,
        n: 1,
        size: '1024*1024',
      },
    };

    debugLog('editImageWanx - Request Payload (base64 image truncated)', {
      ...payload,
      input: {
        ...payload.input,
        base_image_url: payload.input.base_image_url.substring(0, 50) + '...',
      },
    });

    const response = await this.fetchWithRetry(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey}`,
        'X-DashScope-Async': 'enable',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(
        `Tongyi wanx edit API failed: ${response.status} - ${errorBody}`,
      );
    }

    const taskData = (await response.json()) as {
      output?: { task_id?: string };
    };
    
    debugLog('editImageWanx - Task Response', taskData);
    
    const taskId = taskData.output?.task_id;
    if (!taskId) {
      throw new Error('Tongyi wanx edit returned no task ID');
    }

    this.log(`Created wanx edit task: ${taskId}`);

    const taskUrl = `${this.config.baseUrl}/api/v1/tasks/${taskId}`;
    const result = await this.pollTaskStatus(taskUrl, {
      Authorization: `Bearer ${this.config.apiKey}`,
    });

    const resultUrl = result.output?.results?.[0]?.url;
    if (!resultUrl) {
      throw new Error('Tongyi wanx edit task completed but no URL returned');
    }

    debugLog('editImageWanx - Final Result URL', resultUrl);

    this.log(`Image editing completed`);
    return resultUrl;
  }

  private async editImageI2I(
    referenceImageUrl: string,
    prompt: string,
    previousFrameUrl?: string | null,
  ): Promise<string> {
    const url = `${this.config.baseUrl}/api/v1/services/aigc/image2image/image-synthesis`;

    debugLog('editImageI2I - Input Prompt', prompt);
    debugLog('editImageI2I - Reference Image URLs', {
      referenceImageUrl: referenceImageUrl.substring(0, 50) + '...',
      previousFrameUrl: previousFrameUrl
        ? previousFrameUrl.substring(0, 50) + '...'
        : null,
    });

    const images = previousFrameUrl
      ? [referenceImageUrl, previousFrameUrl]
      : [referenceImageUrl];

    const payload = {
      model: this.config.modelNameEditing,
      input: {
        prompt,
        images,
      },
      parameters: {
        prompt_extend: false,
        n: 1,
      },
    };

    debugLog('editImageI2I - Request Payload (image URLs truncated)', {
      ...payload,
      input: {
        ...payload.input,
        images: payload.input.images.map((url) => url.substring(0, 50) + '...'),
      },
    });

    const response = await this.fetchWithRetry(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey}`,
        'X-DashScope-Async': 'enable',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(
        `Tongyi I2I API failed: ${response.status} - ${errorBody}`,
      );
    }

    const taskData = (await response.json()) as {
      output?: { task_id?: string };
    };
    
    debugLog('editImageI2I - Task Response', taskData);
    
    const taskId = taskData.output?.task_id;
    if (!taskId) {
      throw new Error('Tongyi I2I returned no task ID');
    }

    const taskUrl = `${this.config.baseUrl}/api/v1/tasks/${taskId}`;
    const result = await this.pollTaskStatus(taskUrl, {
      Authorization: `Bearer ${this.config.apiKey}`,
    });

    const resultUrl = result.output?.results?.[0]?.url;
    if (!resultUrl) {
      throw new Error('Tongyi I2I task completed but no URL returned');
    }

    debugLog('editImageI2I - Final Result URL', resultUrl);

    this.log(`Image editing completed`);
    return resultUrl;
  }

  private async imageUrlToBase64(imageUrl: string): Promise<string> {
    this.log(
      `Downloading image for Base64 conversion: ${imageUrl.substring(0, 50)}...`,
    );

    const response = await fetch(imageUrl);
    if (!response.ok) {
      throw new Error(`Failed to download image: ${response.status}`);
    }

    const buffer = await response.arrayBuffer();
    const base64 = Buffer.from(buffer).toString('base64');

    const contentType = response.headers.get('content-type') || 'image/png';
    return `data:${contentType};base64,${base64}`;
  }
}

// ============== Doubao Image Service ==============

export class DoubaoImageService extends BaseService {
  private config: ImageModelConfig;
  private arkBaseUrl: string;

  constructor(config: ImageModelConfig) {
    super();
    this.config = config;
    // Allow the user to override the Volcengine ARK base URL (e.g. for
    // a regional endpoint or a self-hosted proxy). Falls back to the
    // public Beijing endpoint that ships with the original implementation.
    this.arkBaseUrl =
      config.baseUrl && config.baseUrl.length > 0
        ? config.baseUrl
        : 'https://ark.cn-beijing.volces.com/api/v3';
  }

  async generateImage(
    prompt: string,
    size: string = '1024x1024',
  ): Promise<string> {
    debugLog('DoubaoImageService.generateImage - Input Prompt', prompt);
    
    this.log(`Generating image with Doubao: ${prompt.substring(0, 50)}...`);

    const url = `${this.arkBaseUrl}/images/generations`;
    const normalizedSize = size.replace('*', 'x');

    const payload = {
      model: this.config.modelNameGeneration,
      prompt,
      size: normalizedSize,
      watermark: false,
    };

    debugLog('DoubaoImageService.generateImage - Request Payload', payload);

    const response = await this.fetchWithRetry(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(
        `Doubao Image API failed: ${response.status} - ${errorBody}`,
      );
    }

    const data = (await response.json()) as {
      data?: Array<{ url?: string }>;
    };

    debugLog('DoubaoImageService.generateImage - API Response', data);

    if (!data.data || data.data.length === 0) {
      throw new Error('Doubao returned no results');
    }

    const resultUrl = data.data[0].url;
    if (!resultUrl) {
      throw new Error('Doubao returned a result without a URL');
    }
    
    debugLog('DoubaoImageService.generateImage - Final Result URL', resultUrl);
    
    this.log(`Image generated successfully`);
    return resultUrl;
  }

  async editImage(
    imageUrl: string,
    prompt: string,
    _previousFrameUrl?: string | null,
  ): Promise<string> {
    debugLog('DoubaoImageService.editImage - Input Prompt', prompt);
    debugLog('DoubaoImageService.editImage - Reference Image URL', imageUrl.substring(0, 50) + '...');
    
    this.log(`Editing image with Doubao...`);

    const url = `${this.arkBaseUrl}/images/edits`;

    const payload = {
      model: this.config.modelNameEditing || this.config.modelNameGeneration,
      prompt,
      image: imageUrl,
      size: '1024x1024',
      watermark: false,
    };

    debugLog('DoubaoImageService.editImage - Request Payload (image URL truncated)', {
      ...payload,
      image: payload.image.substring(0, 50) + '...',
    });

    const response = await this.fetchWithRetry(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(
        `Doubao Edit API failed: ${response.status} - ${errorBody}`,
      );
    }

    const data = (await response.json()) as {
      data?: Array<{ url?: string }>;
    };

    debugLog('DoubaoImageService.editImage - API Response', data);

    if (!data.data || data.data.length === 0) {
      throw new Error('Doubao edit returned no results');
    }

    const resultUrl = data.data[0].url;
    if (!resultUrl) {
      throw new Error('Doubao edit returned a result without a URL');
    }
    this.log(`Image editing completed`);
    return resultUrl;
  }
}

// ============== OpenAI-Compatible Image Service ==============
//
// For OpenRouter, image generation is exposed via Chat Completions + tools:
//   POST {baseUrl}/chat/completions with tools: [{ type: 'openrouter:image_generation' }]
//
// We intentionally keep this implementation under the "openai-compat"
// provider family so users can route image calls through OpenRouter while
// preserving the same OpenGame provider selection flow.

export class OpenAICompatImageService extends BaseService {
  private config: ImageModelConfig;

  constructor(config: ImageModelConfig) {
    super();
    this.config = config;
  }

  async generateImage(
    prompt: string,
    size: string = '1024x1024',
  ): Promise<string> {
    debugLog('OpenAICompatImageService.generateImage - Input Prompt', prompt);
    
    this.log(
      `Generating image via OpenAI-compat: ${prompt.substring(0, 50)}...`,
    );

    const url = this.getChatCompletionsUrl();
    debugLog('OpenAICompatImageService.generateImage - Chat Completions URL', url);
    const normalizedSize = size.replace('*', 'x');
    const useImageTool = this.shouldUseOpenRouterImageTool();

    const payload: Record<string, unknown> = {
      model: this.config.modelNameGeneration,
      messages: [
        {
          role: 'user',
          content: `${prompt}\n\nGenerate exactly one image. Preferred size: ${normalizedSize}.`,
        },
      ],
    };

    if (useImageTool) {
      payload['tools'] = [{ type: 'openrouter:image_generation' }];
    }

    debugLog('OpenAICompatImageService.generateImage - Request Payload', payload);

    let response = await this.fetchWithRetry(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorBody = await response.text();

      // Some OpenRouter routes/models don't support tool use. If tools were
      // explicitly enabled, retry once without tools before failing.
      if (
        useImageTool &&
        response.status === 404 &&
        errorBody.includes('support tool use')
      ) {
        this.log(
          'OpenRouter route does not support tool use; retrying chat/completions without tools.',
          'warn',
        );

        const fallbackPayload = {
          model: this.config.modelNameGeneration,
          messages: payload['messages'],
        };

        debugLog(
          'OpenAICompatImageService.generateImage - Fallback Request Payload',
          fallbackPayload,
        );

        response = await this.fetchWithRetry(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.config.apiKey}`,
          },
          body: JSON.stringify(fallbackPayload),
        });

        if (!response.ok) {
          const fallbackErrorBody = await response.text();
          throw new Error(
            `OpenAI-compat chat completions image API failed: ${response.status} - ${fallbackErrorBody}`,
          );
        }
      } else {
        throw new Error(
          `OpenAI-compat chat completions image API failed: ${response.status} - ${errorBody}`,
        );
      }
    }

    const data = (await response.json()) as Record<string, unknown>;
    debugLog('OpenAICompatImageService.generateImage - API Response', data);

    const imageUrl = this.extractImageUrlFromChatCompletion(data);
    if (!imageUrl) {
      throw new Error(
        'OpenAI-compat chat completions image API returned no image URL',
      );
    }

    debugLog(
      'OpenAICompatImageService.generateImage - Final Result URL',
      imageUrl,
    );
    return imageUrl;
  }

  private shouldUseOpenRouterImageTool(): boolean {
    const raw = process.env.OPENGAME_OPENROUTER_IMAGE_TOOL;
    if (!raw) {
      // Default off: avoids 404 on models/routes that do not support tool use.
      return false;
    }
    const normalized = raw.trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes';
  }

  private getChatCompletionsUrl(): string {
    const trimmed = this.config.baseUrl.replace(/\/+$/g, '');

    try {
      const parsed = new URL(trimmed);
      const host = parsed.hostname.toLowerCase();
      const path = parsed.pathname.replace(/\/+$/g, '');

      if (host === 'openrouter.ai' || host.endsWith('.openrouter.ai')) {
        if (path === '' || path === '/') {
          return `${parsed.origin}/api/v1/chat/completions`;
        }
        if (path === '/api') {
          return `${parsed.origin}/api/v1/chat/completions`;
        }
      }
    } catch {
      // Ignore URL parsing failures and fall back to generic behavior.
    }

    return `${trimmed}/chat/completions`;
  }

  private extractImageUrlFromChatCompletion(
    data: Record<string, unknown>,
  ): string | undefined {
    const choices = (data['choices'] as Array<Record<string, unknown>>) || [];
    const message = (choices[0]?.['message'] as Record<string, unknown>) || {};

    const messageImages =
      (message['images'] as Array<Record<string, unknown>>) || [];
    for (const imageEntry of messageImages) {
      const nestedImage = imageEntry['image_url'];
      if (typeof nestedImage === 'string') {
        return this.normalizeImagePayload(nestedImage);
      }
      if (nestedImage && typeof nestedImage === 'object') {
        const nestedRecord = nestedImage as Record<string, unknown>;
        if (typeof nestedRecord['url'] === 'string') {
          return this.normalizeImagePayload(nestedRecord['url']);
        }
      }
    }

    const imageUrlFromMessage = (message['image_url'] as string) || undefined;
    if (imageUrlFromMessage) {
      return this.normalizeImagePayload(imageUrlFromMessage);
    }

    const content = message['content'];
    if (typeof content === 'string') {
      const directDataUrl = content.match(
        /data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+/,
      );
      if (directDataUrl?.[0]) {
        return this.normalizeImagePayload(directDataUrl[0]);
      }

      const directUrl = content.match(/https?:\/\/[^\s)]+/);
      if (directUrl?.[0]) {
        return directUrl[0];
      }

      const rawBase64 = content.match(/[A-Za-z0-9+/=]{200,}/);
      if (rawBase64?.[0]) {
        return `data:image/png;base64,${rawBase64[0]}`;
      }
    }

    if (Array.isArray(content)) {
      for (const part of content) {
        if (!part || typeof part !== 'object') continue;
        const record = part as Record<string, unknown>;

        const maybeImageUrl = record['image_url'];
        if (typeof maybeImageUrl === 'string') {
          return maybeImageUrl;
        }
        if (maybeImageUrl && typeof maybeImageUrl === 'object') {
          const nested = maybeImageUrl as Record<string, unknown>;
          if (typeof nested['url'] === 'string') {
            return nested['url'];
          }
        }

        if (typeof record['text'] === 'string') {
          const textValue = record['text'];
          const textDataUrl = textValue.match(
            /data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+/,
          );
          if (textDataUrl?.[0]) {
            return this.normalizeImagePayload(textDataUrl[0]);
          }

          const fromText = record['text'].match(/https?:\/\/[^\s)]+/);
          if (fromText?.[0]) {
            return fromText[0];
          }

          const rawBase64FromText = textValue.match(/[A-Za-z0-9+/=]{200,}/);
          if (rawBase64FromText?.[0]) {
            return `data:image/png;base64,${rawBase64FromText[0]}`;
          }
        }

        if (typeof record['b64_json'] === 'string') {
          return `data:image/png;base64,${record['b64_json']}`;
        }

        const nestedData = record['data'];
        if (Array.isArray(nestedData)) {
          const first = nestedData[0] as Record<string, unknown> | undefined;
          if (first && typeof first['b64_json'] === 'string') {
            return `data:image/png;base64,${first['b64_json']}`;
          }
        }
      }
    }

    const toolCalls =
      (message['tool_calls'] as Array<Record<string, unknown>>) || [];
    for (const toolCall of toolCalls) {
      const fn = toolCall['function'] as Record<string, unknown> | undefined;
      const argsRaw = fn?.['arguments'];
      if (typeof argsRaw !== 'string') continue;
      try {
        const parsed = JSON.parse(argsRaw) as Record<string, unknown>;
        if (typeof parsed['image_url'] === 'string') {
          return parsed['image_url'];
        }
        if (typeof parsed['b64_json'] === 'string') {
          return `data:image/png;base64,${parsed['b64_json']}`;
        }
        const dataArray = parsed['data'];
        if (Array.isArray(dataArray)) {
          const first = dataArray[0] as Record<string, unknown> | undefined;
          if (first && typeof first['url'] === 'string') {
            return first['url'];
          }
          if (first && typeof first['b64_json'] === 'string') {
            return `data:image/png;base64,${first['b64_json']}`;
          }
        }
      } catch {
        // Ignore malformed tool args and keep scanning fallback paths.
      }
    }

    return undefined;
  }

  private normalizeImagePayload(value: string): string {
    if (!value.startsWith('data:image/')) {
      return value;
    }

    const commaIndex = value.indexOf(',');
    if (commaIndex < 0) {
      return value;
    }

    const header = value.slice(0, commaIndex + 1);
    const base64Payload = value.slice(commaIndex + 1).replace(/\s+/g, '');
    return `${header}${base64Payload}`;
  }

  async editImage(
    referenceImageUrl: string,
    prompt: string,
    _previousFrameUrl?: string | null,
  ): Promise<string> {
    debugLog('OpenAICompatImageService.editImage - Input Prompt', prompt);
    debugLog('OpenAICompatImageService.editImage - Reference Image URL', referenceImageUrl.substring(0, 50) + '...');
    
    // The OpenAI image-edit endpoint only takes a single reference image
    // and uses multipart/form-data, which adds non-trivial complexity.
    // For now we fall back to a fresh generation that includes the prompt
    // — most callers (e.g. animation frames) only need style consistency
    // via the prompt rather than a true image-conditioned edit. Users who
    // need real I2I should select a Tongyi or Doubao provider for image.
    this.log(
      'OpenAI-compat editImage falls back to plain text-to-image; use tongyi/doubao for true I2I.',
      'warn',
    );
    return this.generateImage(`${prompt} (matching reference style)`);
  }
}

// ============== Image Service Interface ==============

export interface IImageService {
  generateImage(prompt: string, size?: string): Promise<string>;
  editImage(
    referenceImageUrl: string,
    prompt: string,
    previousFrameUrl?: string | null,
  ): Promise<string>;
}

// ============== Factory ==============

export function createImageService(config: ImageModelConfig): IImageService {
  switch (config.modelType) {
    case 'doubao':
      return new DoubaoImageService(config);
    case 'openai-compat':
      return new OpenAICompatImageService(config);
    case 'tongyi':
    default:
      return new TongyiImageService(config);
  }
}
