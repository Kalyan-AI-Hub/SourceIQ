// src/services/circuitBreaker.ts — prevents cascading failures on external API calls
// Pattern: closed → open (on failureThreshold) → half-open (after retryAfterMs) → closed/open

import type { CircuitBreakerState } from '../types/index';

export class CircuitBreaker<T> {
  private state: CircuitBreakerState['state'] = 'closed';
  private failureCount = 0;
  private lastFailure?: string;
  private nextRetryAt?: string;

  constructor(
    private readonly service: string,
    private readonly failureThreshold = 3,
    private readonly retryAfterMs = 300_000, // 5 minutes
  ) {}

  getState(): CircuitBreakerState {
    return {
      service: this.service,
      state: this.state,
      failureCount: this.failureCount,
      lastFailure: this.lastFailure,
      nextRetryAt: this.nextRetryAt,
    };
  }

  async execute(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      const now = Date.now();
      const retryTime = this.nextRetryAt ? new Date(this.nextRetryAt).getTime() : 0;
      if (now < retryTime) {
        throw new Error(
          `[CircuitBreaker] ${this.service} circuit open — retry after ${this.nextRetryAt}`,
        );
      }
      // Enough time has passed — try half-open
      this.state = 'half-open';
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  private onSuccess(): void {
    this.state = 'closed';
    this.failureCount = 0;
    this.lastFailure = undefined;
    this.nextRetryAt = undefined;
  }

  private onFailure(): void {
    this.failureCount++;
    this.lastFailure = new Date().toISOString();
    if (this.failureCount >= this.failureThreshold) {
      this.state = 'open';
      this.nextRetryAt = new Date(Date.now() + this.retryAfterMs).toISOString();
    }
  }
}
