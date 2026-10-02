// Type definitions for MusikSparring AI SDK v3

export type ProviderId = 'demo' | 'ollama' | 'lmstudio' | 'openai_compatible' | 'anthropic' | 'openai';

export interface ProviderMeta {
  readonly id: ProviderId;
  readonly label: string;
  readonly local: boolean;
  readonly needsKey: boolean;
  readonly keyPrefix?: string;
  readonly baseUrl: string;
  readonly defaultModel: string;
  readonly hint: string;
}

export interface ProjectParams {
  genre?: string;
  mood?: string;
  bpm?: string;
  key?: string;
  references?: string;
  existing?: string;
  constraints?: string;
  goals?: string;
}

export interface ChordProgression {
  label: string;
  chords: string[];
  note: string;
}

export interface Suggestions {
  summary: string;
  questions: string[];
  directions: string[];
  chords: ChordProgression[];
  melodies: string[];
  rhythm: string[];
  arrangement: string[];
  production: string[];
  lyrics: string[];
  actions: string[];
}

export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  [k: string]: unknown;
}

export interface ChatResult {
  text: string;
  provider: ProviderId;
  model: string;
  usage: Usage | null;
  durationMs: number;
  stopReason?: string;
}

export interface ChatRequest {
  system?: string;
  prompt?: string;
  messages?: { role: 'user' | 'assistant' | 'system'; content: string }[];
  json?: boolean;
  schema?: object;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  /** Only used by the demo provider. */
  demoParams?: ProjectParams;
}

export interface ClientConfig {
  provider?: ProviderId;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  /** Default 120000. Local models can be slow. */
  timeoutMs?: number;
  /** Default 2 (429 / 5xx / network). */
  maxRetries?: number;
  /** Default 0.8. */
  temperature?: number;
  /** Anthropic only. Default 'medium'. */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Inject fetch (tests, Node < 18 polyfills). */
  fetch?: typeof fetch | null;
}

export interface PingResult {
  ok: boolean;
  latencyMs: number;
  models: string[];
  error: string | null;
}

export interface Client {
  readonly version: string;
  readonly provider: ProviderId;
  readonly meta: ProviderMeta;
  readonly model: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly timeoutMs: number;
  readonly maxRetries: number;
  readonly temperature: number;
  readonly effort: string;
  readonly isLocal: boolean;
  /** Throws MusikAIError when the config can't make a request. */
  validate(): void;
  chat(req: ChatRequest): Promise<ChatResult>;
  generateJSON<T = unknown>(req: ChatRequest): Promise<{ data: T; meta: ChatResult }>;
  generateSuggestions(
    params: ProjectParams,
    opts?: { signal?: AbortSignal; temperature?: number; maxTokens?: number },
  ): Promise<{ suggestions: Suggestions; meta: ChatResult }>;
  listModels(signal?: AbortSignal): Promise<string[]>;
  ping(signal?: AbortSignal): Promise<PingResult>;
}

export type ErrorCode =
  | 'unknown' | 'config' | 'missing_key' | 'bad_key' | 'missing_model' | 'aborted' | 'timeout' | 'network'
  | 'auth' | 'not_found' | 'rate_limit' | 'server' | 'http' | 'bad_response' | 'bad_json' | 'refusal' | 'empty';

export declare class MusikAIError extends Error {
  code: ErrorCode;
  status: number;
  provider: string;
  retryable: boolean;
  cause?: unknown;
}

export interface Theory {
  readonly NOTES: readonly string[];
  normalizeNote(note: string): string | null;
  transpose(note: string, semitones: number): string | null;
  parseKey(text: string): { root: string; mode: 'major' | 'minor' } | null;
  diatonicChords(root: string, mode: 'major' | 'minor'): string[];
  tokenizeChords(text: string, opts?: { allowBare?: boolean }): string[];
}

export declare const VERSION: string;
export declare const PROVIDERS: Readonly<Record<ProviderId, ProviderMeta>>;
export declare const SUGGESTION_SCHEMA: object;
export declare const SECTION_KEYS: readonly (keyof Omit<Suggestions, 'summary' | 'chords'>)[];
export declare const SECTION_TITLES: Readonly<Record<keyof Omit<Suggestions, 'summary'>, string>>;
export declare const theory: Theory;
export declare function createClient(config?: ClientConfig): Client;
export declare function buildCoachPrompt(params?: ProjectParams): { system: string; user: string };
export declare function parseJSONLoose(text: string): unknown;
export declare function normalizeSuggestions(raw: unknown): Suggestions;
export declare function mockSuggestions(params?: ProjectParams): Suggestions;
export declare function suggestionsToMarkdown(s: Suggestions, params?: ProjectParams): string;

declare global {
  interface Window {
    MusikAI: typeof import('./musiksparring-ai');
  }
}
