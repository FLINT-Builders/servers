'use strict';

// Test harness. Loaded with `node --require` before the server evaluates
// fs/promises, so both the default export and named exports see the wrapper.
// After realpath() resolves a sentinel symlink, the link is retargeted.
// A later stat() of that same path follows the new target.

const fs = require('fs');
const path = require('path');

const sentinel = process.env.SYMLINK_RACE_PATH;
const nextTarget = process.env.SYMLINK_RACE_TARGET;

if (sentinel && nextTarget) {
  const originalRealpath = fs.promises.realpath;
  let swapped = false;

  fs.promises.realpath = async function realpathThenRetarget(requestedPath, options) {
    const resolved = await originalRealpath.call(this, requestedPath, options);
    const requested = typeof requestedPath === 'string' ? requestedPath : String(requestedPath);
    if (!swapped && path.resolve(requested) === path.resolve(sentinel)) {
      swapped = true;
      await fs.promises.unlink(sentinel);
      await fs.promises.symlink(nextTarget, sentinel);
    }
    return resolved;
  };
}
