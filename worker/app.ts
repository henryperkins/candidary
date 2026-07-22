import { Hono } from 'hono';

export function createApp() {
  return new Hono();
}

