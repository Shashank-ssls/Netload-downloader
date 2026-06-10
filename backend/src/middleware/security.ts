import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { config } from '../config';

/**
 * Optional shared-secret auth. Disabled when config.apiToken is empty (the
 * default — the server is already bound to 127.0.0.1). When set, every /api
 * route except health requires `X-API-Token: <token>` (or `Authorization:
 * Bearer <token>`).
 */
export function apiTokenMiddleware(req: Request, res: Response, next: NextFunction) {
  if (!config.apiToken) return next();
  if (req.path === '/api/health') return next();

  const provided =
    req.header('x-api-token') || (req.header('authorization') || '').replace(/^Bearer\s+/i, '');
  if (safeEqual(provided, config.apiToken)) return next();
  return res.status(401).json({ error: 'Unauthorized' });
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a || '');
  const bb = Buffer.from(b || '');
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * Minimal in-memory fixed-window per-IP rate limiter for the expensive endpoints
 * (analyze/download). maxPerMin <= 0 disables it.
 */
const windows = new Map<string, { count: number; reset: number }>();
export function rateLimiter(maxPerMin: number) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (maxPerMin <= 0) return next();
    const key = req.ip || 'global';
    const now = Date.now();
    let w = windows.get(key);
    if (!w || now > w.reset) {
      w = { count: 0, reset: now + 60_000 };
      windows.set(key, w);
    }
    w.count++;
    if (w.count > maxPerMin) {
      return res.status(429).json({ error: 'Too many requests' });
    }
    next();
  };
}
