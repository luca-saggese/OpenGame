/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AuthType } from '@opengame/opengame-core';
import {
  getAvailableModelsForAuthType,
  getAvailableModelsForAuthTypeAsync,
} from './availableModels.js';

describe('getAvailableModelsForAuthType', () => {
  const originalOpenAIModel = process.env['OPENAI_MODEL'];
  const originalAnthropicModel = process.env['ANTHROPIC_MODEL'];

  beforeEach(() => {
    delete process.env['OPENAI_MODEL'];
    delete process.env['ANTHROPIC_MODEL'];
  });

  afterEach(() => {
    if (originalOpenAIModel === undefined) {
      delete process.env['OPENAI_MODEL'];
    } else {
      process.env['OPENAI_MODEL'] = originalOpenAIModel;
    }

    if (originalAnthropicModel === undefined) {
      delete process.env['ANTHROPIC_MODEL'];
    } else {
      process.env['ANTHROPIC_MODEL'] = originalAnthropicModel;
    }

    vi.unstubAllGlobals();
  });

  it('uses OPENAI_MODEL when available', () => {
    process.env['OPENAI_MODEL'] = 'openai/env-model';

    const models = getAvailableModelsForAuthType(
      AuthType.USE_OPENAI,
      'openai/configured-model',
    );

    expect(models).toEqual([
      {
        id: 'openai/env-model',
        label: 'openai/env-model',
      },
    ]);
  });

  it('falls back to configured model for USE_OPENAI when env var is missing', () => {
    const models = getAvailableModelsForAuthType(
      AuthType.USE_OPENAI,
      'openrouter/anthropic/claude-3.5-sonnet',
    );

    expect(models).toEqual([
      {
        id: 'openrouter/anthropic/claude-3.5-sonnet',
        label: 'openrouter/anthropic/claude-3.5-sonnet',
      },
    ]);
  });

  it('falls back to configured model for USE_ANTHROPIC when env var is missing', () => {
    const models = getAvailableModelsForAuthType(
      AuthType.USE_ANTHROPIC,
      'claude-3-7-sonnet-latest',
    );

    expect(models).toEqual([
      {
        id: 'claude-3-7-sonnet-latest',
        label: 'claude-3-7-sonnet-latest',
      },
    ]);
  });

  it('loads model list from OpenRouter API for USE_OPENAI', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          {
            id: 'openai/gpt-4o-mini',
            name: 'GPT-4o mini',
            description: 'Fast and affordable model',
          },
          {
            id: 'anthropic/claude-3.5-sonnet',
            name: 'Claude 3.5 Sonnet',
          },
        ],
      }),
    });

    vi.stubGlobal('fetch', fetchMock);

    const models = await getAvailableModelsForAuthTypeAsync(
      AuthType.USE_OPENAI,
      {
        configuredModel: 'fallback/model',
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKey: 'sk-or-test',
      },
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'https://openrouter.ai/api/v1/models',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer sk-or-test',
        }),
      }),
    );
    expect(models).toEqual([
      {
        id: 'anthropic/claude-3.5-sonnet',
        label: 'Claude 3.5 Sonnet',
        description: undefined,
      },
      {
        id: 'openai/gpt-4o-mini',
        label: 'GPT-4o mini',
        description: 'Fast and affordable model',
      },
    ]);
  });
});
