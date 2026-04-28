/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { AuthType, DEFAULT_QWEN_MODEL } from '@opengame/opengame-core';
import { t } from '../../i18n/index.js';

export type AvailableModel = {
  id: string;
  label: string;
  description?: string;
  isVision?: boolean;
};

export const MAINLINE_VLM = 'vision-model';
export const MAINLINE_CODER = DEFAULT_QWEN_MODEL;

export const AVAILABLE_MODELS_QWEN: AvailableModel[] = [
  {
    id: MAINLINE_CODER,
    label: MAINLINE_CODER,
    get description() {
      return t(
        'The latest Qwen Coder model from Alibaba Cloud ModelStudio (version: qwen3-coder-plus-2025-09-23)',
      );
    },
  },
  {
    id: MAINLINE_VLM,
    label: MAINLINE_VLM,
    get description() {
      return t(
        'The latest Qwen Vision model from Alibaba Cloud ModelStudio (version: qwen3-vl-plus-2025-09-23)',
      );
    },
    isVision: true,
  },
];

/**
 * Get available Qwen models filtered by vision model preview setting
 */
export function getFilteredQwenModels(
  visionModelPreviewEnabled: boolean,
): AvailableModel[] {
  if (visionModelPreviewEnabled) {
    return AVAILABLE_MODELS_QWEN;
  }
  return AVAILABLE_MODELS_QWEN.filter((model) => !model.isVision);
}

/**
 * Currently we use the single model of `OPENAI_MODEL` in the env.
 * In the future, after settings.json is updated, we will allow users to configure this themselves.
 */
export function getOpenAIAvailableModelFromEnv(): AvailableModel | null {
  const id = process.env['OPENAI_MODEL']?.trim();
  return id ? { id, label: id } : null;
}

export function getAnthropicAvailableModelFromEnv(): AvailableModel | null {
  const id = process.env['ANTHROPIC_MODEL']?.trim();
  return id ? { id, label: id } : null;
}

type OpenRouterModel = {
  id?: string;
  name?: string;
  description?: string;
};

type OpenRouterModelsResponse = {
  data?: OpenRouterModel[];
};

type AvailableModelOptions = {
  configuredModel?: string;
  baseUrl?: string;
  apiKey?: string;
};

function isOpenRouterBaseUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl) {
    return false;
  }
  try {
    const parsed = new URL(baseUrl);
    return parsed.hostname.includes('openrouter.ai');
  } catch {
    return baseUrl.includes('openrouter.ai');
  }
}

function normalizeOpenRouterModelsUrl(baseUrl: string | undefined): string {
  const fallbackBaseUrl = 'https://openrouter.ai/api/v1';
  const raw = (baseUrl?.trim() || fallbackBaseUrl).replace(/\/+$/, '');
  return raw.endsWith('/models') ? raw : `${raw}/models`;
}

function getOpenRouterApiKey(
  explicitApiKey: string | undefined,
): string | null {
  const key =
    explicitApiKey?.trim() ||
    process.env['OPENAI_API_KEY']?.trim() ||
    process.env['OPENROUTER_API_KEY']?.trim();
  return key || null;
}

function mapOpenRouterModelsToAvailable(
  models: OpenRouterModel[] | undefined,
): AvailableModel[] {
  if (!models?.length) {
    return [];
  }

  const mapped: Array<AvailableModel | null> = models.map((model) => {
    const id = model.id?.trim();
    if (!id) {
      return null;
    }

    const name = model.name?.trim();
    const description = model.description?.trim();
    return {
      id,
      label: name || id,
      ...(description ? { description } : {}),
    };
  });

  return mapped.filter((model): model is AvailableModel => model !== null);
}

async function fetchOpenRouterAvailableModels(
  baseUrl: string | undefined,
  apiKey: string,
): Promise<AvailableModel[]> {
  const url = normalizeOpenRouterModelsUrl(baseUrl);
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    return [];
  }

  const payload = (await response.json()) as OpenRouterModelsResponse;
  const mapped = mapOpenRouterModelsToAvailable(payload.data);
  return mapped.sort((a, b) => a.label.localeCompare(b.label));
}

function toAvailableModel(modelId: string | undefined): AvailableModel | null {
  const id = modelId?.trim();
  return id ? { id, label: id } : null;
}

export function getAvailableModelsForAuthType(
  authType: AuthType,
  configuredModel?: string,
): AvailableModel[] {
  switch (authType) {
    case AuthType.QWEN_OAUTH:
      return AVAILABLE_MODELS_QWEN;
    case AuthType.USE_OPENAI: {
      const openAIModel =
        getOpenAIAvailableModelFromEnv() ?? toAvailableModel(configuredModel);
      return openAIModel ? [openAIModel] : [];
    }
    case AuthType.USE_ANTHROPIC: {
      const anthropicModel =
        getAnthropicAvailableModelFromEnv() ??
        toAvailableModel(configuredModel);
      return anthropicModel ? [anthropicModel] : [];
    }
    default:
      // For other auth types, return empty array for now
      // This can be expanded later according to the design doc
      return [];
  }
}

export async function getAvailableModelsForAuthTypeAsync(
  authType: AuthType,
  options: AvailableModelOptions = {},
): Promise<AvailableModel[]> {
  const fallbackModels = getAvailableModelsForAuthType(
    authType,
    options.configuredModel,
  );

  if (authType !== AuthType.USE_OPENAI) {
    return fallbackModels;
  }

  if (!isOpenRouterBaseUrl(options.baseUrl || process.env['OPENAI_BASE_URL'])) {
    return fallbackModels;
  }

  const apiKey = getOpenRouterApiKey(options.apiKey);
  if (!apiKey) {
    return fallbackModels;
  }

  try {
    const openRouterModels = await fetchOpenRouterAvailableModels(
      options.baseUrl || process.env['OPENAI_BASE_URL'],
      apiKey,
    );
    return openRouterModels.length > 0 ? openRouterModels : fallbackModels;
  } catch {
    return fallbackModels;
  }
}

/**
/**
 * Hard code the default vision model as a string literal,
 * until our coding model supports multimodal.
 */
export function getDefaultVisionModel(): string {
  return MAINLINE_VLM;
}

export function isVisionModel(modelId: string): boolean {
  return AVAILABLE_MODELS_QWEN.some(
    (model) => model.id === modelId && model.isVision,
  );
}
