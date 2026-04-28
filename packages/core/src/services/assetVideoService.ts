/**
 * Video Generation Service
 * Supports I2V (Image-to-Video) and T2V (Text-to-Video) for animation/audio generation
 * Inspired by PiXelDa's video generation architecture
 */

import { BaseService } from './assetBaseService.js';
import type {
  VideoModelConfig,
  VideoGenerationResponse,
} from '../tools/generate-assets-types.js';

// ============== Tongyi Video Service ==============

export class TongyiVideoService extends BaseService {
  private config: VideoModelConfig;

  constructor(config: VideoModelConfig) {
    super();
    this.config = config;
  }

  async generateVideo(
    baseImageUrl: string,
    prompt: string,
    resolution: string = '720P',
  ): Promise<VideoGenerationResponse> {
    this.log(`Generating video with Tongyi I2V: ${prompt.substring(0, 50)}...`);

    const url = `${this.config.baseUrl}/api/v1/services/aigc/video-generation/video-synthesis`;

    const payload = {
      model: this.config.modelNameVideo,
      input: {
        prompt,
        img_url: baseImageUrl,
      },
      parameters: {
        resolution,
        prompt_extend: false,
      },
    };

    return this.submitAndPoll(url, payload);
  }

  async generateVideoFromText(
    prompt: string,
    resolution: string = '720P',
  ): Promise<VideoGenerationResponse> {
    this.log(`Generating video with Tongyi T2V: ${prompt.substring(0, 50)}...`);

    const url = `${this.config.baseUrl}/api/v1/services/aigc/video-generation/video-synthesis`;

    const payload = {
      model: this.config.modelNameVideoText || 'wan2.5-t2v-preview',
      input: {
        prompt,
      },
      parameters: {
        size: resolution === '720P' ? '1280*720' : '1024*1024',
        duration: 10,
        prompt_extend: false,
      },
    };

    return this.submitAndPoll(url, payload);
  }

  private async submitAndPoll(
    url: string,
    payload: Record<string, unknown>,
  ): Promise<VideoGenerationResponse> {
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
        `Tongyi Video API failed: ${response.status} - ${errorBody}`,
      );
    }

    const taskData = (await response.json()) as {
      output?: { task_id?: string };
    };
    const taskId = taskData.output?.task_id;
    if (!taskId) {
      throw new Error('Tongyi Video returned no task ID');
    }

    this.log(`Video task created: ${taskId}, polling for completion...`);

    const taskUrl = `${this.config.baseUrl}/api/v1/tasks/${taskId}`;
    const result = await this.pollTaskStatus(
      taskUrl,
      {
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      600000,
      10000,
    );

    const videoUrl = result.output?.video_url;
    if (!videoUrl) {
      throw new Error('Tongyi Video task completed but no URL returned');
    }

    this.log(`Video generated successfully: ${videoUrl}`);
    return { videoUrl, taskId };
  }
}

// ============== Doubao Video Service ==============

export class DoubaoVideoService extends BaseService {
  private config: VideoModelConfig;
  private arkBaseUrl: string;

  constructor(config: VideoModelConfig) {
    super();
    this.config = config;
    this.arkBaseUrl =
      config.baseUrl && config.baseUrl.length > 0
        ? config.baseUrl
        : 'https://ark.cn-beijing.volces.com/api/v3';
  }

  async generateVideo(
    baseImageUrl: string,
    prompt: string,
    resolution: string = '480P',
  ): Promise<VideoGenerationResponse> {
    return this.generateVideoInternal(prompt, baseImageUrl, resolution);
  }

  async generateVideoFromText(
    prompt: string,
    resolution: string = '480P',
  ): Promise<VideoGenerationResponse> {
    return this.generateVideoInternal(prompt, undefined, resolution);
  }

  private async generateVideoInternal(
    prompt: string,
    baseImageUrl?: string,
    resolution: string = '480P',
  ): Promise<VideoGenerationResponse> {
    this.log(
      `Generating video with Doubao (${baseImageUrl ? 'I2V' : 'T2V'}): ${prompt.substring(0, 50)}...`,
    );

    const url = `${this.arkBaseUrl}/videos/generations`;

    const payload: Record<string, unknown> = {
      model: this.config.modelNameVideo,
      prompt,
      resolution,
    };

    if (baseImageUrl) {
      payload['first_frame_image'] = baseImageUrl;
    }

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
        `Doubao Video API failed: ${response.status} - ${errorBody}`,
      );
    }

    const data = (await response.json()) as { id?: string };
    const taskId = data.id;

    if (!taskId) {
      throw new Error('Doubao Video returned no task ID');
    }

    this.log(`Video task created: ${taskId}, polling for completion...`);

    const result = await this.pollDoubaoVideoTask(taskId);

    this.log(`Video generated successfully`);
    return { videoUrl: result.video_url ?? '', taskId };
  }

  private async pollDoubaoVideoTask(
    taskId: string,
    timeoutMs: number = 300000,
  ): Promise<DoubaoVideoTaskResult> {
    const startTime = Date.now();
    const pollInterval = 5000;

    while (Date.now() - startTime < timeoutMs) {
      await this.sleep(pollInterval);

      const url = `${this.arkBaseUrl}/videos/${taskId}`;
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
        },
      });

      if (!res.ok) continue;

      const data = (await res.json()) as DoubaoVideoTaskResult;

      if (data.status === 'succeeded') {
        return data;
      }

      if (data.status === 'failed') {
        throw new Error(
          `Doubao video task failed: ${data.error ?? 'Unknown error'}`,
        );
      }
    }

    throw new Error(`Doubao video task timed out after ${timeoutMs}ms`);
  }
}

// ============== OpenAI-Compatible Video Service (OpenRouter) ==============

interface OpenRouterVideoJobResponse {
  id?: string;
  polling_url?: string;
  status?: string;
  error?: string;
  generation_id?: string;
  unsigned_urls?: string[];
  usage?: {
    cost?: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export class OpenAICompatVideoService extends BaseService {
  private config: VideoModelConfig;

  constructor(config: VideoModelConfig) {
    super();
    this.config = config;
  }

  async generateVideo(
    baseImageUrl: string,
    prompt: string,
    resolution: string = '720P',
  ): Promise<VideoGenerationResponse> {
    return this.generateVideoInternal(prompt, resolution, baseImageUrl);
  }

  async generateVideoFromText(
    prompt: string,
    resolution: string = '720P',
  ): Promise<VideoGenerationResponse> {
    return this.generateVideoInternal(prompt, resolution);
  }

  private normalizeResolutionForOpenRouter(resolution: string): string {
    const normalized = resolution.toLowerCase();
    switch (normalized) {
      case '480p':
      case '720p':
      case '1080p':
        return normalized;
      default:
        return '720p';
    }
  }

  private inferAspectRatioFromResolution(_resolution: string): string {
    // OpenGame currently targets landscape gameplay and frame extraction,
    // so default to 16:9 for cross-provider consistency.
    return '16:9';
  }

  private getVideoDurationSeconds(): number {
    const raw = process.env.OPENGAME_VIDEO_DURATION;
    if (!raw) return 10;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 1) {
      return 10;
    }
    return Math.floor(parsed);
  }

  private allowI2VFallbackToT2V(): boolean {
    const raw = process.env.OPENGAME_OPENROUTER_I2V_FALLBACK_TO_T2V;
    if (!raw) {
      // Default strict for explicit I2V requests.
      return false;
    }
    const normalized = raw.trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes';
  }

  private async generateVideoInternal(
    prompt: string,
    resolution: string,
    baseImageUrl?: string,
  ): Promise<VideoGenerationResponse> {
    this.log(
      `Generating video with OpenAI-compat (${baseImageUrl ? 'I2V' : 'T2V'}): ${prompt.substring(0, 50)}...`,
    );

    const baseUrl = this.getVideoApiBaseUrl();
    const url = `${baseUrl}/videos`;

    const payload: Record<string, unknown> = {
      model: this.config.modelNameVideo,
      prompt,
      resolution: this.normalizeResolutionForOpenRouter(resolution),
      aspect_ratio: this.inferAspectRatioFromResolution(resolution),
      duration: this.getVideoDurationSeconds(),
    };

    if (baseImageUrl) {
      payload['frame_images'] = [
        {
          type: 'image_url',
          frame_type: 'first_frame',
          image_url: {
            url: baseImageUrl,
          },
        },
      ];

      // Additional hint for providers/models that support reference images.
      payload['input_references'] = [
        {
          type: 'image_url',
          image_url: {
            url: baseImageUrl,
          },
        },
      ];
    }

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

      // Some OpenRouter model routes support T2V only (no frame_images/I2V).
      // Only fallback when explicitly enabled.
      if (
        baseImageUrl &&
        this.allowI2VFallbackToT2V() &&
        response.status === 404 &&
        (errorBody.includes('No endpoints found') ||
          errorBody.includes('provider routing'))
      ) {
        this.log(
          'OpenRouter route rejected I2V payload; retrying as text-to-video without frame_images.',
          'warn',
        );

        const fallbackPayload = { ...payload };
        delete fallbackPayload['frame_images'];
        delete fallbackPayload['input_references'];

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
            `OpenAI-compat video API failed: ${response.status} - ${fallbackErrorBody}`,
          );
        }
      } else if (
        baseImageUrl &&
        response.status === 404 &&
        (errorBody.includes('No endpoints found') ||
          errorBody.includes('provider routing'))
      ) {
        throw new Error(
          'OpenAI-compat video API failed in strict I2V mode: route/model does not support image-conditioned video. ' +
            'Choose an I2V-capable video model/provider, or set OPENGAME_OPENROUTER_I2V_FALLBACK_TO_T2V=true to allow fallback. ' +
            `Original error: ${response.status} - ${errorBody}`,
        );
      } else {
        throw new Error(
          `OpenAI-compat video API failed: ${response.status} - ${errorBody}`,
        );
      }
    }

    const createData = (await response.json()) as OpenRouterVideoJobResponse;
    const taskId = createData.id;
    if (!taskId) {
      throw new Error('OpenAI-compat video API returned no job id');
    }

    this.log(`Video job created: ${taskId}, polling for completion...`);

    const result = await this.pollOpenRouterVideoTask(taskId, 600000, 10000);

    const videoUrl = result.unsigned_urls?.[0];
    if (!videoUrl) {
      throw new Error(
        'OpenAI-compat video job completed but no unsigned_urls were returned',
      );
    }

    this.log(`Video generated successfully`);
    return { videoUrl, taskId };
  }

  private async pollOpenRouterVideoTask(
    taskId: string,
    timeoutMs: number,
    pollIntervalMs: number,
  ): Promise<OpenRouterVideoJobResponse> {
    const startTime = Date.now();
    const baseUrl = this.getVideoApiBaseUrl();
    const url = `${baseUrl}/videos/${taskId}`;

    while (Date.now() - startTime < timeoutMs) {
      await this.sleep(pollIntervalMs);

      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
        },
      });

      if (!res.ok) {
        continue;
      }

      const data = (await res.json()) as OpenRouterVideoJobResponse;
      const status = (data.status || '').toLowerCase();

      if (status === 'completed' || status === 'succeeded') {
        return data;
      }

      if (
        status === 'failed' ||
        status === 'error' ||
        status === 'cancelled' ||
        status === 'canceled'
      ) {
        throw new Error(
          `OpenAI-compat video task failed: ${data.error ?? 'Unknown error'}`,
        );
      }
    }

    throw new Error(`OpenAI-compat video task timed out after ${timeoutMs}ms`);
  }

  private getVideoApiBaseUrl(): string {
    const trimmed = this.config.baseUrl.replace(/\/+$/g, '');

    try {
      const parsed = new URL(trimmed);
      const host = parsed.hostname.toLowerCase();
      const path = parsed.pathname.replace(/\/+$/g, '');

      if (host === 'openrouter.ai' || host.endsWith('.openrouter.ai')) {
        if (path === '' || path === '/') {
          return `${parsed.origin}/api/v1`;
        }
        if (path === '/api') {
          return `${parsed.origin}/api/v1`;
        }
      }
    } catch {
      // Ignore URL parsing failures and fall back to the configured base URL.
    }

    return trimmed;
  }
}

interface DoubaoVideoTaskResult {
  status?: string;
  video_url?: string;
  error?: string;
  [key: string]: unknown;
}

// ============== Frame Extraction Service ==============

import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

export class FrameExtractionService extends BaseService {
  private ffmpegPath: string | null = null;

  private async getFFmpegPath(): Promise<string | null> {
    if (this.ffmpegPath) return this.ffmpegPath;

    const ffmpegPaths = [
      'ffmpeg',
      '/workspace/miniconda3/envs/gamecursor/bin/ffmpeg',
      '/usr/bin/ffmpeg',
      '/usr/local/bin/ffmpeg',
    ];

    for (const p of ffmpegPaths) {
      const available = await this.tryFFmpegPath(p);
      if (available) {
        this.ffmpegPath = p;
        return p;
      }
    }
    return null;
  }

  private tryFFmpegPath(ffmpegPath: string): Promise<boolean> {
    return new Promise((resolve) => {
      const ffmpeg = spawn(ffmpegPath, ['-version'], { stdio: 'pipe' });
      ffmpeg.on('close', (code) => resolve(code === 0));
      ffmpeg.on('error', () => resolve(false));
    });
  }

  async isFFmpegAvailable(): Promise<boolean> {
    const p = await this.getFFmpegPath();
    if (p) {
      this.log(`FFmpeg found at: ${p}`);
      return true;
    }
    this.log(`FFmpeg not found in any search path`, 'warn');
    this.log(`Current PATH: ${process.env.PATH?.substring(0, 200)}...`);
    return false;
  }

  async extractFramesLocal(
    videoUrl: string,
    frameCount: number,
    fromTime: number = 0,
    toTime: number = 5,
    outputDir?: string,
    firstLastOnly: boolean = false,
  ): Promise<{ frameUrls: string[]; framePaths: string[]; videoPath: string }> {
    this.log(`Extracting ${frameCount} frames locally from video...`);

    const tempDir =
      outputDir || (await fs.mkdtemp(path.join(os.tmpdir(), 'frames-')));
    const videoPath = await this.downloadVideo(videoUrl, tempDir);

    const duration = toTime - fromTime;
    const timestamps: number[] = [];

    if (firstLastOnly || frameCount <= 2) {
      timestamps.push(fromTime);
      if (frameCount > 1) timestamps.push(toTime - 0.1);
    } else if (frameCount <= 1) {
      timestamps.push(fromTime);
    } else {
      const interval = duration / (frameCount - 1);
      for (let i = 0; i < frameCount; i++) {
        timestamps.push(fromTime + i * interval);
      }
    }

    this.log(
      `Extracting at timestamps: ${timestamps.map((t) => t.toFixed(2)).join('s, ')}s`,
    );

    const framePaths: string[] = [];
    const ffmpegExe = await this.getFFmpegPath();
    if (!ffmpegExe) throw new Error('FFmpeg not found');

    for (let i = 0; i < timestamps.length; i++) {
      const timestamp = timestamps[i];
      const framePath = path.join(
        tempDir,
        `frame_${String(i).padStart(4, '0')}.png`,
      );

      try {
        await this.extractSingleFrame(
          ffmpegExe,
          videoPath,
          timestamp,
          framePath,
        );
        framePaths.push(framePath);
        this.log(
          `Extracted frame ${i + 1}/${timestamps.length} at ${timestamp.toFixed(2)}s`,
        );
      } catch (error) {
        this.log(`Failed to extract frame at ${timestamp}s: ${error}`, 'warn');
      }
    }

    this.log(`Video file saved: ${videoPath}`);
    this.log(`Successfully extracted ${framePaths.length} frames`);

    return {
      frameUrls: framePaths.map((p) => `file://${p}`),
      framePaths,
      videoPath,
    };
  }

  async extractAudio(
    videoUrl: string,
    outputDir?: string,
    startTime: number = 0,
    duration: number = 7,
  ): Promise<string> {
    this.log(`Extracting audio from video...`);

    const tempDir =
      outputDir || (await fs.mkdtemp(path.join(os.tmpdir(), 'audio-')));
    const videoPath = await this.downloadVideo(videoUrl, tempDir);
    const audioPath = path.join(tempDir, 'extracted_audio.wav');
    const ffmpegExe = await this.getFFmpegPath();
    if (!ffmpegExe) throw new Error('FFmpeg not found');

    return new Promise((resolve, reject) => {
      const args = [
        '-ss',
        String(startTime),
        '-i',
        videoPath,
        '-t',
        String(duration),
        '-vn',
        '-acodec',
        'pcm_s16le',
        '-ar',
        '44100',
        '-ac',
        '2',
        '-y',
        audioPath,
      ];

      const ffmpeg = spawn(ffmpegExe, args, { stdio: 'pipe' });

      let stderr = '';
      ffmpeg.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      ffmpeg.on('close', (code: number | null) => {
        if (code === 0) {
          this.log(`Audio extracted successfully: ${audioPath}`);
          resolve(audioPath);
        } else {
          reject(
            new Error(
              `ffmpeg audio extraction failed (code ${code}): ${stderr}`,
            ),
          );
        }
      });

      ffmpeg.on('error', (err: Error) => {
        reject(new Error(`ffmpeg spawn error: ${err.message}`));
      });
    });
  }

  private async downloadVideo(url: string, targetDir: string): Promise<string> {
    const videoBuffer = await this.downloadToBuffer(url);
    const videoPath = path.join(targetDir, 'video.mp4');
    await fs.writeFile(videoPath, videoBuffer);
    this.log(`Video downloaded: ${videoPath}`);
    return videoPath;
  }

  private extractSingleFrame(
    ffmpegExe: string,
    videoPath: string,
    timestamp: number,
    outputPath: string,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const args = [
        '-ss',
        timestamp.toString(),
        '-i',
        videoPath,
        '-vframes',
        '1',
        '-q:v',
        '2',
        '-y',
        outputPath,
      ];

      const ffmpeg = spawn(ffmpegExe, args, { stdio: 'pipe' });

      let stderr = '';
      ffmpeg.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      ffmpeg.on('close', (code: number | null) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`ffmpeg exited with code ${code}: ${stderr}`));
        }
      });

      ffmpeg.on('error', (err: Error) => {
        reject(new Error(`ffmpeg spawn error: ${err.message}`));
      });
    });
  }
}

// ============== Video Service Interface ==============

export interface IVideoService {
  generateVideo(
    baseImageUrl: string,
    prompt: string,
    resolution?: string,
  ): Promise<VideoGenerationResponse>;
  generateVideoFromText(
    prompt: string,
    resolution?: string,
  ): Promise<VideoGenerationResponse>;
}

// ============== Factory ==============

export function createVideoService(config: VideoModelConfig): IVideoService {
  switch (config.modelType) {
    case 'doubao':
      return new DoubaoVideoService(config);
    case 'openai-compat':
      return new OpenAICompatVideoService(config);
    case 'tongyi':
    default:
      return new TongyiVideoService(config);
  }
}
