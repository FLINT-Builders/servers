'use strict';

/**
 * Test harness for the parent-directory symlink race.
 *
 * The filesystem server validates a destination, then calls mkdir, rename, or
 * writeFile on the path string. This preload runs in that server process and
 * replaces the validated parent directory with a symlink to a directory outside
 * the allowlist as the first action of those calls, before the real
 * implementation looks the path up again. A second validatePath or realpath
 * before the call still sees the original directory; only the syscall itself
 * observes the swap.
 *
 * Armed only when the race env vars are set, so loading the file does nothing
 * by itself.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const parent = process.env.PARENT_SYMLINK_RACE_PARENT;
const outside = process.env.PARENT_SYMLINK_RACE_OUTSIDE;
const marker = process.env.PARENT_SYMLINK_RACE_MARKER;

if (parent && outside) {
  const realRenameSync = fs.renameSync.bind(fs);
  const realSymlinkSync = fs.symlinkSync.bind(fs);
  const realWriteFileSync = fs.writeFileSync.bind(fs);
  const parentResolved = path.resolve(parent);
  let swapped = false;

  function isUnderParent(candidate) {
    if (typeof candidate !== 'string' || candidate.length === 0) {
      return false;
    }
    const resolved = path.resolve(candidate);
    return resolved === parentResolved || resolved.startsWith(parentResolved + path.sep);
  }

  function swapParentOnce(trigger) {
    if (swapped || !trigger.some(isUnderParent)) {
      return;
    }
    swapped = true;
    const held = `${parentResolved}.held`;
    realRenameSync(parentResolved, held);
    realSymlinkSync(outside, parentResolved);
    if (marker) {
      realWriteFileSync(marker, `swapped ${parentResolved} -> ${outside}\n`);
    }
  }

  function wrap(target, name) {
    const original = target[name];
    if (typeof original !== 'function') {
      return;
    }
    target[name] = function parentSymlinkRaceWrapper(...args) {
      swapParentOnce(args);
      return original.apply(this, args);
    };
  }

  for (const name of ['mkdir', 'rename', 'writeFile']) {
    wrap(fsp, name);
    wrap(fs, name);
    wrap(fs, `${name}Sync`);
  }
}
