import { execFile } from 'node:child_process';

/**
 * Run a short, named command and resolve with decoded output.
 * No scripts are staged on disk; commands are passed as argv arrays.
 */
export function run(cmd, args = [], { timeout = 4000 } = {}) {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      {
        timeout,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
        encoding: 'buffer',
      },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          code: typeof err?.code === 'number' ? err.code : err ? 1 : 0,
          stdout: decode(stdout),
          stderr: decode(stderr),
          error: err ? String(err.message || err) : null,
        });
      },
    );
  });
}

export function decode(buf) {
  if (!buf || buf.length === 0) return '';
  if (buf[0] === 0xff && buf[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(buf.subarray(2));
  }
  if (buf[0] === 0xfe && buf[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(buf.subarray(2));
  }
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(buf);
  if (!utf8.includes('\uFFFD')) return utf8;
  try {
    return new TextDecoder('windows-1252').decode(buf);
  } catch {
    return utf8;
  }
}

export function num(value, fallback = 0) {
  if (value == null) return fallback;
  const n = Number.parseFloat(String(value).replace(',', '.'));
  return Number.isFinite(n) ? n : fallback;
}
