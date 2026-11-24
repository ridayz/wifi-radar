import dns from 'node:dns/promises';
import { run } from './exec.mjs';
import { parsePing } from './parsers.mjs';

const PING_ARGS = {
  win32: (ip, timeoutMs) => ['-n', '1', '-w', String(timeoutMs), ip],
  linux: (ip, timeoutMs) => ['-c', '1', '-W', String(Math.max(1, Math.ceil(timeoutMs / 1000))), ip],
  darwin: (ip, timeoutMs) => ['-c', '1', '-W', String(timeoutMs), ip],
};

/** Single ICMP echo probe. Returns {ok, rttMs}. */
export async function pingTarget(ip, { platform = process.platform, timeoutMs = 900 } = {}) {
  if (!ip) return { ok: false, rttMs: null, error: 'no-target' };
  const build = PING_ARGS[platform] || PING_ARGS.linux;
  const res = await run('ping', build(ip, timeoutMs), { timeout: timeoutMs + 1500 });
  const parsed = parsePing(res.stdout || '');
  return { ...parsed, at: Date.now(), error: parsed.ok ? null : 'no-reply' };
}

/** Measure DNS resolution time against a public resolver target. */
export async function dnsTiming(timeoutMs = 1500) {
  const start = Date.now();
  try {
    await Promise.race([
      dns.resolve4('one.one.one.one'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs)),
    ]);
    return { ok: true, ms: Date.now() - start, at: Date.now() };
  } catch (err) {
    return { ok: false, ms: null, at: Date.now(), error: err.message };
  }
}
