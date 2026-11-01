'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * @param {{
 *   configPath: string,
 *   onEvent: (filename: string | null) => void,
 *   fsImpl?: typeof fs,
 *   log?: (line: string) => void,
 * }} options
 */
function startConfigWatch(options) {
  const fsImpl = options.fsImpl ?? fs;
  const configPath = path.resolve(options.configPath);
  const configBase = path.basename(configPath);
  const parentDir = path.dirname(configPath);
  const log = options.log ?? (() => {});

  /** @type {import('node:fs').FSWatcher | null} */
  let watcher = null;
  try {
    watcher = fsImpl.watch(parentDir, (eventType, filename) => {
      if (filename != null && filename !== configBase) {
        return;
      }
      options.onEvent(typeof filename === 'string' ? filename : null);
    });
  } catch {
    log(`${new Date().toISOString()} [snail] config watch failed`);
    return {
      close() {},
      reloadNow() {
        options.onEvent(null);
      },
    };
  }

  return {
    close() {
      watcher?.close();
      watcher = null;
    },
    reloadNow() {
      options.onEvent(null);
    },
  };
}

module.exports = {
  startConfigWatch,
};
