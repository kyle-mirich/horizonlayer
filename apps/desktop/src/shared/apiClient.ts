export interface HorizonBridge {
  request: (request: {
    body?: unknown;
    method: 'GET' | 'POST';
    path: string;
  }) => Promise<ApiEnvelope>;
}

export interface ApiEnvelope {
  error?: { message?: string };
  ok: boolean;
  result?: unknown;
}

export interface HorizonApiClientOptions {
  baseUrl: string;
  bridge?: HorizonBridge;
  fetchImpl?: typeof fetch;
}

export class HorizonApiClient {
  private readonly baseUrl: string;
  private readonly bridge?: HorizonBridge;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HorizonApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.bridge = options.bridge;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async get<T = unknown>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }

  async post<T = unknown>(path: string, body: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const envelope = this.bridge
      ? await this.bridge.request({ body, method, path })
      : await this.fetchRequest(method, path, body);

    if (!envelope.ok) {
      throw new Error(envelope.error?.message ?? 'HorizonLayer request failed');
    }
    return envelope.result as T;
  }

  private async fetchRequest(method: 'GET' | 'POST', path: string, body?: unknown): Promise<ApiEnvelope> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
      method,
    });
    const envelope = await response.json() as ApiEnvelope;
    if (!response.ok && envelope.ok) {
      return {
        error: { message: `HTTP ${response.status}` },
        ok: false,
      };
    }
    return envelope;
  }
}
