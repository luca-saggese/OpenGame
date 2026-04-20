/**
 * Audio Generation Service
 * Generates game audio using ABC Notation + LLM
 * Inspired by PiXelDa's music generation architecture
 */

import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { BaseService } from './assetBaseService.js';
import type {
  AudioModelConfig,
  AudioRequest,
} from '../tools/generate-assets-types.js';

// ============== ABC Notation System Prompt ==============

const ABC_SYSTEM_PROMPT = `You are a helpful assistant that generates creative and original music in ABC notation format.

CRITICAL ABC FORMAT RULES:
1. MUST start with X: (reference number)
2. MUST have T: (title)
3. MUST have M: (meter like 4/4)
4. MUST have L: (default note length like 1/8)
5. MUST have Q: (tempo like 1/4=120)
6. MUST have K: (key like C, G, Am)
7. MUST have actual notes in the body (CDEFGAB or cdefgab)

Notes Reference:
- C D E F G A B = lower octave
- c d e f g a b = higher octave  
- c' d' = even higher octave
- C, D, = lower octave
- z = rest
- A2 = double length, A/2 = half length
- | = bar line, |] = end

VALID EXAMPLE:
X:1
T:Game Theme
M:4/4
L:1/8
Q:1/4=120
K:C
|: CDEF GABc | cBAG FEDC | EFGA Bcde | dcBA GFED :|
|: cdef gabc' | c'bag fedc | efga bc'ed | cBAG FEDC :|

Generate catchy, loop-friendly game music with ACTUAL NOTES.`;

const ABC_GEN_PROMPT = `Generate ABC notation for game audio:

Duration: ~{duration} seconds
Type: {audioType}
Genre: {genre}
Tempo: {tempo}
Description: {description}

Return JSON with:
- notation: Complete ABC notation string
- comments: Brief notes

CRITICAL REQUIREMENTS:
1. notation MUST contain actual notes (CDEFGAB or cdefgab)
2. notation MUST have all required headers (X:, T:, M:, L:, Q:, K:)
3. For BGM: Use repeats |: :| for looping, at least 4-8 bars
4. For SFX: Short melody, 1-2 bars

Example good notation for BGM:
"X:1\\nT:Adventure\\nM:4/4\\nL:1/8\\nQ:1/4=120\\nK:G\\n|: GABc d2BA | GABc d2dc | BAGF E2FG | A4 G4 :|"

Example good notation for SFX:
"X:1\\nT:Jump\\nM:4/4\\nL:1/16\\nQ:1/4=180\\nK:C\\nCEGc c'2z2 |]"`;

// ============== Tongyi Audio Service ==============

export class TongyiAudioService extends BaseService {
  private config: AudioModelConfig;

  constructor(config: AudioModelConfig) {
    super();
    this.config = config;
  }

  async generateABC(request: AudioRequest): Promise<string> {
    this.log(
      `Generating ABC notation with Tongyi: ${request.description.substring(0, 50)}...`,
    );

    const url = `${this.config.baseUrl}/api/v1/services/aigc/text-generation/generation`;

    const userPrompt = ABC_GEN_PROMPT.replace(
      '{duration}',
      String(request.duration || 30),
    )
      .replace('{audioType}', request.audioType)
      .replace('{genre}', request.genre || 'electronic')
      .replace('{tempo}', request.tempo || 'medium')
      .replace('{description}', request.description);

    const payload = {
      model: this.config.modelNameChat,
      input: {
        messages: [
          { role: 'system', content: ABC_SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
      },
      parameters: {
        result_format: 'message',
        max_tokens: this.config.maxTokens || 2048,
        temperature: 1.5,
        presence_penalty: 2,
      },
    };

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
        `Tongyi Chat API failed: ${response.status} - ${errorBody}`,
      );
    }

    const data = (await response.json()) as {
      output?: { choices?: Array<{ message?: { content?: string } }> };
    };
    const content = data.output?.choices?.[0]?.message?.content;

    if (!content) {
      throw new Error('Tongyi returned no content');
    }

    let notation = content;
    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        notation = parsed.notation || content;
      }
    } catch {
      this.log('Failed to parse JSON, extracting ABC directly', 'warn');
    }

    notation = normalizeABCNotation(notation);

    if (!isValidABCNotation(notation)) {
      this.log(`Invalid ABC notation generated, will use fallback`, 'warn');
      throw new Error(
        'Generated ABC notation is invalid (missing notes or headers)',
      );
    }

    return notation;
  }
}

// ============== Shared ABC Notation Utilities ==============

function normalizeABCNotation(notation: string): string {
  let normalized = notation.replace(/\\n/g, '\n');

  normalized = normalized
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join('\n');

  return normalized;
}

function isValidABCNotation(notation: string): boolean {
  if (!notation.includes('X:')) {
    console.warn('[ABC] Missing X: header');
    return false;
  }

  if (!notation.includes('K:')) {
    console.warn('[ABC] Missing K: header');
    return false;
  }

  const notePattern = /[CDEFGABcdefgab][,']*[0-9/]*/;
  const lines = notation.split('\n');
  let hasNotes = false;

  for (const line of lines) {
    if (line.match(/^[A-Z]:/)) continue;
    if (line.match(notePattern)) {
      hasNotes = true;
      break;
    }
  }

  if (!hasNotes) {
    console.warn('[ABC] No valid notes found in ABC notation');
    return false;
  }

  return true;
}

// ============== Doubao Audio Service ==============

export class DoubaoAudioService extends BaseService {
  private config: AudioModelConfig;
  private arkBaseUrl: string;

  constructor(config: AudioModelConfig) {
    super();
    this.config = config;
    this.arkBaseUrl =
      config.baseUrl && config.baseUrl.length > 0
        ? config.baseUrl
        : 'https://ark.cn-beijing.volces.com/api/v3';
  }

  async generateABC(request: AudioRequest): Promise<string> {
    this.log(
      `Generating ABC notation with Doubao: ${request.description.substring(0, 50)}...`,
    );

    const url = `${this.arkBaseUrl}/chat/completions`;

    const userPrompt = ABC_GEN_PROMPT.replace(
      '{duration}',
      String(request.duration || 30),
    )
      .replace('{audioType}', request.audioType)
      .replace('{genre}', request.genre || 'electronic')
      .replace('{tempo}', request.tempo || 'medium')
      .replace('{description}', request.description);

    const payload = {
      model: this.config.modelNameChat,
      messages: [
        { role: 'system', content: ABC_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: this.config.maxTokens || 2048,
      temperature: 1.5,
      response_format: { type: 'json_object' },
    };

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
        `Doubao Chat API failed: ${response.status} - ${errorBody}`,
      );
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content;

    if (!content) {
      throw new Error('Doubao returned no content');
    }

    let notation = content;
    try {
      const parsed = JSON.parse(content);
      notation = parsed.notation || content;
    } catch {
      this.log('Failed to parse JSON, extracting ABC directly', 'warn');
    }

    notation = normalizeABCNotation(notation);

    if (!isValidABCNotation(notation)) {
      this.log(`Invalid ABC notation generated, will use fallback`, 'warn');
      throw new Error(
        'Generated ABC notation is invalid (missing notes or headers)',
      );
    }

    return notation;
  }
}

// ============== Audio Rendering Service ==============

export class AudioRenderService extends BaseService {
  private pythonPath: string;
  private symusicAvailable: boolean | null = null;

  constructor(pythonPath?: string) {
    super();
    this.pythonPath = pythonPath || process.env.PYTHON_PATH || 'python3';
  }

  async isSymusicAvailable(): Promise<boolean> {
    if (this.symusicAvailable !== null) {
      return this.symusicAvailable;
    }

    return new Promise((resolve) => {
      const proc = spawn(
        this.pythonPath,
        ['-c', 'from symusic import Score, Synthesizer, dump_wav; print("ok")'],
        {
          stdio: 'pipe',
        },
      );

      proc.on('close', (code) => {
        this.symusicAvailable = code === 0;
        resolve(this.symusicAvailable);
      });

      proc.on('error', () => {
        this.symusicAvailable = false;
        resolve(false);
      });
    });
  }

  async abcToWav(
    abcNotation: string,
    chiptune: boolean = true,
  ): Promise<Buffer> {
    this.log(`Converting ABC to WAV via symusic (chiptune=${chiptune})...`);

    const available = await this.isSymusicAvailable();
    if (!available) {
      throw new Error('symusic not available in Python environment');
    }

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'abc-'));
    const abcPath = path.join(tempDir, 'music.abc');
    const wavPath = path.join(tempDir, 'output.wav');

    try {
      await fs.writeFile(abcPath, abcNotation, 'utf-8');

      const pythonScript = `
import sys
from symusic import Score, Synthesizer, dump_wav

abc_path = sys.argv[1]
wav_path = sys.argv[2]

with open(abc_path, 'r', encoding='utf-8') as f:
    abc_notation = f.read()

score = Score.from_abc(abc_notation, ttype="tick")
synth = Synthesizer()
audio = synth.render(score, True)
dump_wav(wav_path, audio, sample_rate=44100, use_int16=True)
print("ok")
`;

      const args = ['-c', pythonScript, abcPath, wavPath];

      await new Promise<void>((resolve, reject) => {
        const proc = spawn(this.pythonPath, args, {
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        let stderr = '';
        proc.stderr?.on('data', (data: Buffer) => {
          stderr += data.toString();
        });

        proc.on('close', (code) => {
          if (code === 0) {
            resolve();
          } else {
            reject(
              new Error(`symusic conversion failed (code ${code}): ${stderr}`),
            );
          }
        });

        proc.on('error', (err) => {
          reject(new Error(`symusic spawn error: ${err.message}`));
        });
      });

      const wavBuffer = await fs.readFile(wavPath);
      this.log(`ABC → WAV conversion successful (${wavBuffer.length} bytes)`);
      return wavBuffer;
    } finally {
      try {
        await fs.unlink(abcPath);
        await fs.unlink(wavPath);
        await fs.rmdir(tempDir);
      } catch {
        // best-effort cleanup; ignore failures
      }
    }
  }

  async generateFromABC(
    abcNotation: string,
    type: 'sfx' | 'bgm' = 'bgm',
    durationSeconds: number = 5,
  ): Promise<Buffer> {
    try {
      const chiptune = true;
      return await this.abcToWav(abcNotation, chiptune);
    } catch (error) {
      this.log(
        `ABC conversion failed: ${error}, falling back to procedural audio`,
        'warn',
      );
      return this.generateGameAudio(durationSeconds, type);
    }
  }

  async generateGameAudio(
    durationSeconds: number = 1,
    type: 'sfx' | 'bgm' = 'sfx',
  ): Promise<Buffer> {
    this.log(`Generating procedural ${type} audio (${durationSeconds}s)...`);

    if (type === 'sfx') {
      return this.generateSfxWav(durationSeconds);
    } else {
      return this.generateBgmWav(durationSeconds);
    }
  }

  private async generateSfxWav(durationSeconds: number = 1): Promise<Buffer> {
    this.log(`Generating SFX WAV (${durationSeconds}s)...`);

    const sampleRate = 44100;
    const numChannels = 1;
    const bitsPerSample = 16;
    const numSamples = Math.floor(sampleRate * durationSeconds);
    const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
    const blockAlign = numChannels * (bitsPerSample / 8);
    const dataSize = numSamples * blockAlign;
    const fileSize = 36 + dataSize;

    const buffer = Buffer.alloc(44 + dataSize);
    let offset = 0;

    buffer.write('RIFF', offset);
    offset += 4;
    buffer.writeUInt32LE(fileSize, offset);
    offset += 4;
    buffer.write('WAVE', offset);
    offset += 4;
    buffer.write('fmt ', offset);
    offset += 4;
    buffer.writeUInt32LE(16, offset);
    offset += 4;
    buffer.writeUInt16LE(1, offset);
    offset += 2;
    buffer.writeUInt16LE(numChannels, offset);
    offset += 2;
    buffer.writeUInt32LE(sampleRate, offset);
    offset += 4;
    buffer.writeUInt32LE(byteRate, offset);
    offset += 4;
    buffer.writeUInt16LE(blockAlign, offset);
    offset += 2;
    buffer.writeUInt16LE(bitsPerSample, offset);
    offset += 2;
    buffer.write('data', offset);
    offset += 4;
    buffer.writeUInt32LE(dataSize, offset);
    offset += 4;

    const startFreq = 200;
    const endFreq = 800;
    const amplitude = 12000;

    for (let i = 0; i < numSamples; i++) {
      const t = i / numSamples;
      const freq = startFreq + (endFreq - startFreq) * t;

      const phase = ((2 * Math.PI * freq * i) / sampleRate) % (2 * Math.PI);
      const sample = phase < Math.PI ? amplitude : -amplitude;

      const fadeLength = sampleRate * 0.05;
      let envelope = 1;
      if (i < fadeLength) envelope = i / fadeLength;
      else if (i > numSamples - fadeLength)
        envelope = (numSamples - i) / fadeLength;

      buffer.writeInt16LE(Math.round(sample * envelope), offset);
      offset += 2;
    }

    return buffer;
  }

  private async generateBgmWav(durationSeconds: number = 5): Promise<Buffer> {
    this.log(`Generating BGM WAV (${durationSeconds}s)...`);

    const sampleRate = 44100;
    const numChannels = 1;
    const bitsPerSample = 16;
    const numSamples = Math.floor(sampleRate * durationSeconds);
    const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
    const blockAlign = numChannels * (bitsPerSample / 8);
    const dataSize = numSamples * blockAlign;
    const fileSize = 36 + dataSize;

    const buffer = Buffer.alloc(44 + dataSize);
    let offset = 0;

    buffer.write('RIFF', offset);
    offset += 4;
    buffer.writeUInt32LE(fileSize, offset);
    offset += 4;
    buffer.write('WAVE', offset);
    offset += 4;
    buffer.write('fmt ', offset);
    offset += 4;
    buffer.writeUInt32LE(16, offset);
    offset += 4;
    buffer.writeUInt16LE(1, offset);
    offset += 2;
    buffer.writeUInt16LE(numChannels, offset);
    offset += 2;
    buffer.writeUInt32LE(sampleRate, offset);
    offset += 4;
    buffer.writeUInt32LE(byteRate, offset);
    offset += 4;
    buffer.writeUInt16LE(blockAlign, offset);
    offset += 2;
    buffer.writeUInt16LE(bitsPerSample, offset);
    offset += 2;
    buffer.write('data', offset);
    offset += 4;
    buffer.writeUInt32LE(dataSize, offset);
    offset += 4;

    const notes = [261.63, 329.63, 392.0, 523.25];
    const bpm = 120;
    const beatDuration = 60 / bpm;
    const noteDuration = beatDuration * 0.5;
    const noteSamples = Math.floor(sampleRate * noteDuration);
    const amplitude = 8000;

    for (let i = 0; i < numSamples; i++) {
      const noteIndex = Math.floor((i / noteSamples) % notes.length);
      const freq = notes[noteIndex];
      const notePosition = i % noteSamples;

      const phase = ((2 * Math.PI * freq * i) / sampleRate) % (2 * Math.PI);
      const triangle = Math.abs(phase / Math.PI - 1) * 2 - 1;
      const sample = triangle * amplitude;

      let envelope = 1;
      const attackSamples = noteSamples * 0.1;
      const decaySamples = noteSamples * 0.3;

      if (notePosition < attackSamples) {
        envelope = notePosition / attackSamples;
      } else if (notePosition > noteSamples - decaySamples) {
        envelope = (noteSamples - notePosition) / decaySamples;
      }

      buffer.writeInt16LE(Math.round(sample * envelope * 0.7), offset);
      offset += 2;
    }

    return buffer;
  }
}

// ============== OpenAI-Compatible Audio Service ==============
//
// "Audio" in OpenGame really means "ABC-notation generation by an LLM,
// then locally rendered to WAV via symusic". So an OpenAI-compatible
// audio provider just hits the standard /chat/completions endpoint with
// the ABC system prompt — no audio-specific API is required on the
// provider side.

export class OpenAICompatAudioService extends BaseService {
  private config: AudioModelConfig;

  constructor(config: AudioModelConfig) {
    super();
    this.config = config;
  }

  async generateABC(request: AudioRequest): Promise<string> {
    this.log(
      `Generating ABC notation via OpenAI-compat: ${request.description.substring(0, 50)}...`,
    );

    const url = `${this.config.baseUrl}/chat/completions`;

    const userPrompt = ABC_GEN_PROMPT.replace(
      '{duration}',
      String(request.duration || 30),
    )
      .replace('{audioType}', request.audioType)
      .replace('{genre}', request.genre || 'electronic')
      .replace('{tempo}', request.tempo || 'medium')
      .replace('{description}', request.description);

    const payload = {
      model: this.config.modelNameChat,
      messages: [
        { role: 'system', content: ABC_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: this.config.maxTokens || 2048,
      temperature: 1.5,
    };

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
        `OpenAI-compat chat API failed: ${response.status} - ${errorBody}`,
      );
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('OpenAI-compat chat API returned no content');
    }

    let notation = content;
    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]) as { notation?: string };
        notation = parsed.notation || content;
      }
    } catch {
      this.log('Failed to parse JSON, extracting ABC directly', 'warn');
    }

    notation = normalizeABCNotation(notation);

    if (!isValidABCNotation(notation)) {
      this.log(`Invalid ABC notation generated, will use fallback`, 'warn');
      throw new Error(
        'Generated ABC notation is invalid (missing notes or headers)',
      );
    }

    return notation;
  }
}

// ============== Audio Service Interface ==============

export interface IAudioService {
  generateABC(request: AudioRequest): Promise<string>;
}

// ============== Factory ==============

export function createAudioService(config: AudioModelConfig): IAudioService {
  switch (config.modelType) {
    case 'doubao':
      return new DoubaoAudioService(config);
    case 'openai-compat':
      return new OpenAICompatAudioService(config);
    case 'tongyi':
    default:
      return new TongyiAudioService(config);
  }
}
