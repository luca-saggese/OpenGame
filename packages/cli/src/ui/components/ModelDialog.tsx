/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Box, Text } from 'ink';
import {
  AuthType,
  ModelSlashCommandEvent,
  logModelSlashCommand,
} from '@opengame/opengame-core';
import { useKeypress } from '../hooks/useKeypress.js';
import { theme } from '../semantic-colors.js';
import { DescriptiveRadioButtonSelect } from './shared/DescriptiveRadioButtonSelect.js';
import { TextInput } from './shared/TextInput.js';
import { ConfigContext } from '../contexts/ConfigContext.js';
import {
  type AvailableModel,
  getAvailableModelsForAuthType,
  getAvailableModelsForAuthTypeAsync,
  MAINLINE_CODER,
} from '../models/availableModels.js';
import { t } from '../../i18n/index.js';

interface ModelDialogProps {
  onClose: () => void;
}

export function ModelDialog({ onClose }: ModelDialogProps): React.JSX.Element {
  const config = useContext(ConfigContext);

  // Get auth type from config, default to QWEN_OAUTH if not available
  const authType = config?.getAuthType?.() ?? AuthType.QWEN_OAUTH;
  const configuredModel = config?.getModel?.();
  const contentGeneratorConfig = config?.getContentGeneratorConfig?.();

  const [availableModels, setAvailableModels] = useState<AvailableModel[]>(() =>
    getAvailableModelsForAuthType(authType, configuredModel),
  );
  const [searchQuery, setSearchQuery] = useState('');
  const [isSearchFocused, setIsSearchFocused] = useState(true);

  useEffect(() => {
    let cancelled = false;

    const fallbackModels = getAvailableModelsForAuthType(
      authType,
      configuredModel,
    );
    setAvailableModels(fallbackModels);

    const loadModels = async () => {
      const models = await getAvailableModelsForAuthTypeAsync(authType, {
        configuredModel,
        baseUrl: contentGeneratorConfig?.baseUrl,
        apiKey: contentGeneratorConfig?.apiKey,
      });
      if (!cancelled) {
        setAvailableModels(models);
      }
    };

    void loadModels();

    return () => {
      cancelled = true;
    };
  }, [
    authType,
    configuredModel,
    contentGeneratorConfig?.apiKey,
    contentGeneratorConfig?.baseUrl,
  ]);

  const MODEL_OPTIONS = useMemo(
    () =>
      availableModels.map((model) => ({
        value: model.id,
        title: model.label,
        description: model.description || '',
        key: model.id,
      })),
    [availableModels],
  );

  const FILTERED_MODEL_OPTIONS = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLowerCase();
    if (!normalizedQuery) {
      return MODEL_OPTIONS;
    }

    return MODEL_OPTIONS.filter((model) =>
      [model.title, model.value, model.description]
        .join(' ')
        .toLowerCase()
        .includes(normalizedQuery),
    );
  }, [MODEL_OPTIONS, searchQuery]);

  // Determine the Preferred Model (read once when the dialog opens).
  const preferredModel = config?.getModel() || MAINLINE_CODER;

  useKeypress(
    (key) => {
      if (key.name === 'tab') {
        setIsSearchFocused((current) => !current);
        return;
      }

      // When typing in search, allow quick handoff to the list.
      if (isSearchFocused && (key.name === 'down' || key.name === 'j')) {
        setIsSearchFocused(false);
        return;
      }

      if (isSearchFocused && key.name === 'return') {
        setIsSearchFocused(false);
        return;
      }

      if (key.name === 'escape') {
        onClose();
      }
    },
    { isActive: true },
  );

  // Calculate the initial index based on the preferred model.
  const initialIndex = useMemo(
    () =>
      FILTERED_MODEL_OPTIONS.findIndex(
        (option) => option.value === preferredModel,
      ),
    [FILTERED_MODEL_OPTIONS, preferredModel],
  );

  // Handle selection internally (Autonomous Dialog).
  const handleSelect = useCallback(
    (model: string) => {
      if (config) {
        config.setModel(model);
        const event = new ModelSlashCommandEvent(model);
        logModelSlashCommand(config, event);
      }
      onClose();
    },
    [config, onClose],
  );

  return (
    <Box
      borderStyle="round"
      borderColor={theme.border.default}
      flexDirection="column"
      padding={1}
      width="100%"
    >
      <Text bold>{t('Select Model')}</Text>
      <Box marginTop={1} flexDirection="column">
        <Text color={theme.text.secondary}>{t('Search models')}</Text>
        <TextInput
          value={searchQuery}
          onChange={setSearchQuery}
          placeholder={t('Type to filter models...')}
          isActive={isSearchFocused}
          inputWidth={60}
        />
      </Box>
      <Box marginTop={1}>
        <DescriptiveRadioButtonSelect
          items={FILTERED_MODEL_OPTIONS}
          onSelect={handleSelect}
          initialIndex={initialIndex}
          showNumbers={true}
          isFocused={!isSearchFocused}
        />
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text color={theme.text.secondary}>
          {t('(Press Tab to switch between search and list)')}
        </Text>
        <Text color={theme.text.secondary}>{t('(Press Esc to close)')}</Text>
      </Box>
    </Box>
  );
}
