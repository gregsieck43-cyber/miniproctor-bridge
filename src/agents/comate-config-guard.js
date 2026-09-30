/** Dedicated pinned Comate child only. Hide MCP settings from the native loader, without editing disk.
 * This covers the audited native readFile APIs; it is not an OS sandbox or a generic SDK guarantee.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncBuiltinESMExports } from 'node:module';

const EMPTY_MCP = '{"mcpServers":{}}';
function isMcpSettings(value) {
  let file;
  try {
    file = value instanceof URL ? fileURLToPath(value) : Buffer.isBuffer(value) ? value.toString() : value;
    if (typeof file !== 'string') return false;
    const absolute = path.resolve(file);
    return path.basename(path.dirname(absolute)).toLowerCase() === '.comate'
      && /^(?:mcp|mcp\.local)\.json$/i.test(path.basename(absolute));
  } catch { return false; }
}
function emptyContents(options) {
  const encoding = typeof options === 'string' ? options : options?.encoding;
  const buffer = Buffer.from(EMPTY_MCP);
  return encoding ? buffer.toString(encoding) : buffer;
}

export function installComateConfigGuard() {
  const native = { readFile: fs.readFile, readFileSync: fs.readFileSync, promiseReadFile: fsp.readFile };
  const hooks = process.env.DISABLE_HOOKS;
  let maskedReads = 0;
  const readFileSync = (file, options) => {
    if (!isMcpSettings(file)) return native.readFileSync.call(fs, file, options);
    maskedReads++; return emptyContents(options);
  };
  const readFile = (file, options, callback) => {
    if (!isMcpSettings(file)) return native.readFile.call(fs, file, options, callback);
    const cb = typeof options === 'function' ? options : callback;
    if (typeof cb !== 'function') throw new TypeError('Comate readFile requires a callback');
    maskedReads++;
    let value; try { value = emptyContents(typeof options === 'function' ? undefined : options); }
    catch (error) { queueMicrotask(() => cb(error)); return; }
    queueMicrotask(() => cb(null, value));
  };
  const promiseReadFile = async (file, options) => {
    if (!isMcpSettings(file)) return native.promiseReadFile.call(fsp, file, options);
    maskedReads++; return emptyContents(options);
  };
  fs.readFileSync = readFileSync; fs.readFile = readFile; fsp.readFile = promiseReadFile;
  process.env.DISABLE_HOOKS = 'true';
  syncBuiltinESMExports();
  return {
    get maskedReads() { return maskedReads; },
    restore() {
      if (fs.readFileSync !== readFileSync || fs.readFile !== readFile || fsp.readFile !== promiseReadFile) throw new Error('Comate config guard was replaced');
      fs.readFileSync = native.readFileSync; fs.readFile = native.readFile; fsp.readFile = native.promiseReadFile;
      if (hooks === undefined) delete process.env.DISABLE_HOOKS; else process.env.DISABLE_HOOKS = hooks;
      syncBuiltinESMExports();
    },
  };
}
