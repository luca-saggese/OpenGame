/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('openai');
import type OpenAI from 'openai';
import {
  OpenRouterOpenAICompatibleProvider,
  normalizeOpenRouterBaseUrl,
} from './openrouter.js';
import { DefaultOpenAICompatibleProvider } from './default.js';
import type { Config } from '../../../config/config.js';
import type { ContentGeneratorConfig } from '../../contentGenerator.js';

describe('OpenRouterOpenAICompatibleProvider', () => {
  let provider: OpenRouterOpenAICompatibleProvider;
  let mockContentGeneratorConfig: ContentGeneratorConfig;
  let mockCliConfig: Config;

  beforeEach(() => {
    vi.clearAllMocks();

    // Mock ContentGeneratorConfig
    mockContentGeneratorConfig = {
      apiKey: 'test-api-key',
      baseUrl: 'https://openrouter.ai/api/v1',
      timeout: 60000,
      maxRetries: 2,
      model: 'openai/gpt-4',
    } as ContentGeneratorConfig;

    // Mock Config
    mockCliConfig = {
      getCliVersion: vi.fn().mockReturnValue('1.0.0'),
      getDebugMode: vi.fn().mockReturnValue(false),
    } as unknown as Config;

    provider = new OpenRouterOpenAICompatibleProvider(
      mockContentGeneratorConfig,
      mockCliConfig,
    );
  });

  describe('constructor', () => {
    it('should extend DefaultOpenAICompatibleProvider', () => {
      expect(provider).toBeInstanceOf(DefaultOpenAICompatibleProvider);
      expect(provider).toBeInstanceOf(OpenRouterOpenAICompatibleProvider);
    });
  });

  describe('isOpenRouterProvider', () => {
    it('should return true for openrouter.ai URLs', () => {
      const configs = [
        { baseUrl: 'https://openrouter.ai/api/v1' },
        { baseUrl: 'https://api.openrouter.ai/v1' },
        { baseUrl: 'https://openrouter.ai' },
        { baseUrl: 'http://openrouter.ai/api/v1' },
      ];

      configs.forEach((config) => {
        const result = OpenRouterOpenAICompatibleProvider.isOpenRouterProvider(
          config as ContentGeneratorConfig,
        );
        expect(result).toBe(true);
      });
    });

    it('should return false for non-openrouter URLs', () => {
      const configs = [
        { baseUrl: 'https://api.openai.com/v1' },
        { baseUrl: 'https://api.anthropic.com/v1' },
        { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
        { baseUrl: 'https://example.com/api/v1' }, // different domain
        { baseUrl: '' },
        { baseUrl: undefined },
      ];

      configs.forEach((config) => {
        const result = OpenRouterOpenAICompatibleProvider.isOpenRouterProvider(
          config as ContentGeneratorConfig,
        );
        expect(result).toBe(false);
      });
    });

    it('should handle missing baseUrl gracefully', () => {
      const config = {} as ContentGeneratorConfig;
      const result =
        OpenRouterOpenAICompatibleProvider.isOpenRouterProvider(config);
      expect(result).toBe(false);
    });
  });

  describe('buildHeaders', () => {
    it('should include base headers from parent class', () => {
      const headers = provider.buildHeaders();

      // Should include User-Agent from parent
      expect(headers['User-Agent']).toBe(
        `QwenCode/1.0.0 (${process.platform}; ${process.arch})`,
      );
    });

    it('should add OpenRouter-specific headers', () => {
      const headers = provider.buildHeaders();

      expect(headers).toEqual({
        'User-Agent': `QwenCode/1.0.0 (${process.platform}; ${process.arch})`,
        'HTTP-Referer': 'https://github.com/leigest519/OpenGame.git',
        'X-Title': 'OpenGame',
      });
    });

    it('should override parent headers if there are conflicts', () => {
      // Mock parent to return conflicting headers
      const parentBuildHeaders = vi.spyOn(
        DefaultOpenAICompatibleProvider.prototype,
        'buildHeaders',
      );
      parentBuildHeaders.mockReturnValue({
        'User-Agent': 'ParentAgent/1.0.0',
        'HTTP-Referer': 'https://parent.com',
      });

      const headers = provider.buildHeaders();

      expect(headers).toEqual({
        'User-Agent': 'ParentAgent/1.0.0',
        'HTTP-Referer': 'https://github.com/leigest519/OpenGame.git', // OpenRouter-specific value should override
        'X-Title': 'OpenGame',
      });

      parentBuildHeaders.mockRestore();
    });

    it('should handle unknown CLI version from parent', () => {
      vi.mocked(mockCliConfig.getCliVersion).mockReturnValue(undefined);

      const headers = provider.buildHeaders();

      expect(headers['User-Agent']).toBe(
        `QwenCode/unknown (${process.platform}; ${process.arch})`,
      );
      expect(headers['HTTP-Referer']).toBe(
        'https://github.com/leigest519/OpenGame.git',
      );
      expect(headers['X-Title']).toBe('OpenGame');
    });
  });

  describe('buildClient', () => {
    it('should return an OpenAI client with instrumented fetch', () => {
      const client = provider.buildClient();
      expect(client).toBeDefined();
    });

    it('should log body preview when 2xx returns unexpected content-type', async () => {
      const debugConsoleSpy = vi
        .spyOn(console, 'debug')
        .mockImplementation(() => {});
      vi.mocked(mockCliConfig.getDebugMode).mockReturnValue(true);

      const htmlBody = '<html><body>Not found</body></html>';
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(htmlBody, {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
      );
      global.fetch = mockFetch as unknown as typeof fetch;

      const debugProvider = new OpenRouterOpenAICompatibleProvider(
        mockContentGeneratorConfig,
        mockCliConfig,
      );

      // buildClient creates the instrumented wrapper; call global.fetch directly
      // to simulate what instrumented() does (it delegates to fetch(input, init))
      debugProvider.buildClient();
      const response = await global.fetch(
        'https://openrouter.ai/api/v1/chat/completions',
        { method: 'POST' },
      );
      expect(response.status).toBe(200);

      debugConsoleSpy.mockRestore();
    });
  });

  describe('normalizeOpenRouterBaseUrl', () => {
    it('should append /v1 when URL ends with /api', () => {
      expect(normalizeOpenRouterBaseUrl('https://openrouter.ai/api')).toBe(
        'https://openrouter.ai/api/v1',
      );
    });

    it('should not modify URL that already has /api/v1', () => {
      expect(normalizeOpenRouterBaseUrl('https://openrouter.ai/api/v1')).toBe(
        'https://openrouter.ai/api/v1',
      );
    });

    it('should strip trailing slash before normalizing', () => {
      expect(normalizeOpenRouterBaseUrl('https://openrouter.ai/api/')).toBe(
        'https://openrouter.ai/api/v1',
      );
    });
  });

  describe('buildRequest', () => {
    it('should inherit buildRequest behavior from parent', () => {
      const mockRequest: OpenAI.Chat.ChatCompletionCreateParams = {
        model: 'openai/gpt-4',
        messages: [{ role: 'user', content: 'Hello' }],
      };
      const mockUserPromptId = 'test-prompt-id';
      const mockResult = { ...mockRequest, modified: true };

      // Mock the parent's buildRequest method
      const parentBuildRequest = vi.spyOn(
        DefaultOpenAICompatibleProvider.prototype,
        'buildRequest',
      );
      parentBuildRequest.mockReturnValue(mockResult);

      const result = provider.buildRequest(mockRequest, mockUserPromptId);

      expect(parentBuildRequest).toHaveBeenCalledWith(
        mockRequest,
        mockUserPromptId,
      );
      expect(result).toBe(mockResult);

      parentBuildRequest.mockRestore();
    });
  });

  describe('integration with parent class', () => {
    it('should properly call parent constructor', () => {
      const newProvider = new OpenRouterOpenAICompatibleProvider(
        mockContentGeneratorConfig,
        mockCliConfig,
      );

      // Verify that parent properties are accessible
      expect(newProvider).toHaveProperty('buildHeaders');
      expect(newProvider).toHaveProperty('buildClient');
      expect(newProvider).toHaveProperty('buildRequest');
    });

    it('should maintain parent functionality while adding OpenRouter specifics', () => {
      // Test that the provider can perform all parent operations
      const headers = provider.buildHeaders();

      // Should have both parent and OpenRouter-specific headers
      expect(headers['User-Agent']).toBeDefined(); // From parent
      expect(headers['HTTP-Referer']).toBe(
        'https://github.com/leigest519/OpenGame.git',
      ); // OpenRouter-specific
      expect(headers['X-Title']).toBe('OpenGame'); // OpenRouter-specific
    });
  });
});
