/**
 * Smoke test for OpenGame image + video generation services.
 *
 * Usage:
 *   npm run test:assets:smoke
 *
 * Optional env overrides:
 *   OPENGAME_TEST_IMAGE_PROMPT
 *   OPENGAME_TEST_VIDEO_PROMPT
 *   OPENGAME_TEST_IMAGE_SIZE            (default: 1024*1024)
 *   OPENGAME_TEST_VIDEO_RESOLUTION      (default: 720P)
 *   OPENGAME_TEST_OUTPUT_DIR            (default: ./tmp/asset-smoke)
 *   OPENGAME_TEST_SKIP_VIDEO            (1|true to skip)
 *   OPENGAME_TEST_VIDEO_MODE            (i2v|t2v, default: i2v)
 *
 * CLI flags:
 *   --image-prompt "..."
 *   --video-prompt "..."
 *   --image-size "1024*1024"
 *   --video-resolution "720P"
 *   --video-mode "i2v|t2v"
 *   --output-dir "./tmp/asset-smoke"
 *   --skip-video
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import {
  resolveProviderConfig,
  MissingProviderConfigError,
} from '../packages/core/src/services/providerConfig.js';
import { createImageService } from '../packages/core/src/services/assetImageService.js';
import { createVideoService } from '../packages/core/src/services/assetVideoService.js';

type VideoMode = 'i2v' | 't2v';

interface CliOptions {
  imagePrompt?: string;
  videoPrompt?: string;
  imageSize?: string;
  videoResolution?: string;
  videoMode?: VideoMode;
  outputDir?: string;
  skipVideo?: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const out: CliOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--image-prompt' && next) {
      out.imagePrompt = next;
      i++;
    } else if (arg === '--video-prompt' && next) {
      out.videoPrompt = next;
      i++;
    } else if (arg === '--image-size' && next) {
      out.imageSize = next;
      i++;
    } else if (arg === '--video-resolution' && next) {
      out.videoResolution = next;
      i++;
    } else if (arg === '--video-mode' && next) {
      if (next === 'i2v' || next === 't2v') {
        out.videoMode = next;
      }
      i++;
    } else if (arg === '--output-dir' && next) {
      out.outputDir = next;
      i++;
    } else if (arg === '--skip-video') {
      out.skipVideo = true;
    }
  }
  return out;
}

function envTrue(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

function safeFileName(prefix: string, ext: string): string {
  const now = new Date().toISOString().replace(/[:.]/g, '-');
  return `${prefix}-${now}.${ext}`;
}

async function downloadToFile(url: string, filePath: string): Promise<void> {
  if (url.startsWith('data:image/')) {
    const commaIdx = url.indexOf(',');
    if (commaIdx < 0) {
      throw new Error('Invalid data URL image payload');
    }
    const base64Data = url.slice(commaIdx + 1);
    const buf = Buffer.from(base64Data, 'base64');
    await fs.writeFile(filePath, buf);
    return;
  }

  // Some providers return raw base64 image content instead of a URL.
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    const maybeBase64 = url.trim();
    if (/^[A-Za-z0-9+/=]+$/.test(maybeBase64) && maybeBase64.length > 200) {
      const buf = Buffer.from(maybeBase64, 'base64');
      await fs.writeFile(filePath, buf);
      return;
    }
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Download failed (${response.status}) for ${url}`);
  }
  const buf = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(filePath, buf);
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));

  const imagePrompt =
    cli.imagePrompt ??
    process.env.OPENGAME_TEST_IMAGE_PROMPT ??
    'Retro pixel art hero sprite, side view facing right, isolated on white background';

  const videoPrompt =
    cli.videoPrompt ??
    process.env.OPENGAME_TEST_VIDEO_PROMPT ??
    'Side-view hero performs a short run cycle, smooth motion, fixed camera';

  const imageSize =
    cli.imageSize ?? process.env.OPENGAME_TEST_IMAGE_SIZE ?? '1024*1024';

  const videoResolution =
    cli.videoResolution ??
    process.env.OPENGAME_TEST_VIDEO_RESOLUTION ??
    '720P';

  const outputDir = path.resolve(
    cli.outputDir ??
      process.env.OPENGAME_TEST_OUTPUT_DIR ??
      path.join(process.cwd(), 'tmp', 'asset-smoke'),
  );

  const videoMode: VideoMode =
    cli.videoMode ??
    ((process.env.OPENGAME_TEST_VIDEO_MODE as VideoMode) || 'i2v');

  const skipVideo = cli.skipVideo || envTrue(process.env.OPENGAME_TEST_SKIP_VIDEO);

  await fs.mkdir(outputDir, { recursive: true });

  console.log('=== OpenGame Asset Smoke Test ===');
  console.log(`Output dir: ${outputDir}`);

  const imageProvider = resolveProviderConfig('image');
  const imageService = createImageService({
    apiKey: imageProvider.apiKey,
    baseUrl: imageProvider.baseUrl,
    modelType: imageProvider.provider,
    modelNameGeneration: imageProvider.model,
    modelNameEditing:
      process.env.OPENGAME_IMAGE_EDIT_MODEL || imageProvider.model,
  });

  console.log(
    `Image provider: ${imageProvider.provider} (${imageProvider.model})`,
  );
  console.log(`Generating image with size ${imageSize}...`);

  const imageUrl = await imageService.generateImage(imagePrompt, imageSize);
  const imagePath = path.join(outputDir, safeFileName('smoke-image', 'png'));
  await downloadToFile(imageUrl, imagePath);
  console.log(`Image URL: ${imageUrl}`);
  console.log(`Image saved: ${imagePath}`);

  if (skipVideo) {
    console.log('Video test skipped (OPENGAME_TEST_SKIP_VIDEO=true).');
    return;
  }

  const videoProvider = resolveProviderConfig('video');
  const videoService = createVideoService({
    apiKey: videoProvider.apiKey,
    baseUrl: videoProvider.baseUrl,
    modelType: videoProvider.provider,
    modelNameVideo: videoProvider.model,
    modelNameVideoText:
      process.env.OPENGAME_VIDEO_TEXT_MODEL || videoProvider.model,
  });

  console.log(
    `Video provider: ${videoProvider.provider} (${videoProvider.model})`,
  );
  console.log(
    `Generating video (${videoMode.toUpperCase()}) with resolution ${videoResolution}...`,
  );

  const videoResult =
    videoMode === 't2v'
      ? await videoService.generateVideoFromText(videoPrompt, videoResolution)
      : await videoService.generateVideo(imageUrl, videoPrompt, videoResolution);

  const videoPath = path.join(outputDir, safeFileName('smoke-video', 'mp4'));
  await downloadToFile(videoResult.videoUrl, videoPath);
  console.log(`Video task id: ${videoResult.taskId}`);
  console.log(`Video URL: ${videoResult.videoUrl}`);
  console.log(`Video saved: ${videoPath}`);
}

main().catch((error: unknown) => {
  if (error instanceof MissingProviderConfigError) {
    console.error('\n[CONFIG ERROR]');
    console.error(error.message);
    process.exit(2);
  }

  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error('\n[SMOKE TEST FAILED]');
  console.error(message);
  process.exit(1);
});
