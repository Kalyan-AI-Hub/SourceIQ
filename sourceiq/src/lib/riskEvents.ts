// src/lib/riskEvents.ts — shared event bus for real-time risk updates
// riskStore emits here on every updateSri(); SSE route subscribes.
import { EventEmitter } from 'events';

export const riskEmitter = new EventEmitter();
// Allow up to 50 concurrent SSE client connections
riskEmitter.setMaxListeners(50);
