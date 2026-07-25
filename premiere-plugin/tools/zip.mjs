/**
 * A minimal ZIP writer that preserves POSIX permission bits.
 *
 * WHY NOT JUST SHELL OUT. macOS needs two things to arrive executable: the vendored
 * ffmpeg/ffprobe binaries and install.command itself (a .command without the exec
 * bit isn't double-clickable — Finder opens it in TextEdit). Windows' only built-in
 * archiver, Compress-Archive, cannot store Unix modes, so a Mac bundle built on
 * Windows always arrived broken; and `zip` isn't present on Windows. Writing the
 * archive ourselves means either build machine produces a correct Mac bundle, with
 * no npm dependency and no external tool.
 *
 * Permissions live in the high 16 bits of the central directory's "external file
 * attributes" field, with the creator-OS nibble of "version made by" set to 3
 * (Unix) so unzip actually honours them.
 *
 * Scope: deflate + store, no Zip64, no encryption, no multi-disk. Fine for a
 * few hundred files under 4 GB apiece.
 */

import { createWriteStream, readFileSync, readdirSync, statSync } from "node:fs";
import { deflateRawSync } from "node:zlib";
import { join, relative, sep } from "node:path";
import { once } from "node:events";

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** MS-DOS date/time — the only timestamp format a base ZIP header carries. */
function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/**
 * Walk a directory into flat entries with ZIP-style forward-slash names.
 * `prefix` becomes the archive's top-level folder.
 */
function walk(root, prefix) {
  const entries = [];
  const visit = (dir) => {
    for (const item of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = join(dir, item.name);
      const rel = relative(root, full).split(sep).join("/");
      const name = prefix ? `${prefix}/${rel}` : rel;
      if (item.isDirectory()) {
        entries.push({ full, name: name + "/", isDir: true });
        visit(full);
      } else if (item.isFile()) {
        entries.push({ full, name, isDir: false });
      }
      // Symlinks are intentionally skipped: nothing in a bundle needs one, and a
      // dangling link in an editor's extensions folder is worse than its absence.
    }
  };
  visit(root);
  return entries;
}

/**
 * Default permissions. Executability can't be inferred from a file's contents on
 * Windows (every file reads as 0644), so it's decided by name: the vendored
 * binaries and the .command installers, and directories.
 */
function defaultMode(entry) {
  if (entry.isDir) return 0o755;
  const base = entry.name.split("/").pop();
  const isBinary = /^(ffmpeg|ffprobe)(\.exe)?$/i.test(base);
  const isLauncher = /\.(command|sh)$/i.test(base);
  return isBinary || isLauncher ? 0o755 : 0o644;
}

/**
 * Zip `srcDir` into `zipPath`, with its contents under a top-level `prefix` folder
 * (defaults to the source folder's own name, matching `zip -r` behaviour).
 * `modeFor(entry)` may override permissions per entry.
 */
export async function zipDirectory(srcDir, zipPath, { prefix, modeFor = defaultMode } = {}) {
  const top = prefix !== undefined ? prefix : srcDir.split(sep).filter(Boolean).pop();
  const entries = walk(srcDir, top);
  const out = createWriteStream(zipPath);
  const central = [];
  let offset = 0;

  const write = (buf) => {
    offset += buf.length;
    if (!out.write(buf)) return once(out, "drain");
    return null;
  };

  for (const entry of entries) {
    const stat = statSync(entry.full);
    const { time, date } = dosDateTime(stat.mtime);
    const raw = entry.isDir ? Buffer.alloc(0) : readFileSync(entry.full);
    // Tiny files can deflate larger than they started; store those verbatim.
    const deflated = entry.isDir ? Buffer.alloc(0) : deflateRawSync(raw, { level: 6 });
    const useDeflate = !entry.isDir && deflated.length < raw.length;
    const payload = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const crc = entry.isDir ? 0 : crc32(raw);
    const nameBuf = Buffer.from(entry.name, "utf8");
    const localOffset = offset;

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed (2.0 — deflate)
    local.writeUInt16LE(0x0800, 6); // general purpose flags: UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra field length
    nameBuf.copy(local, 30);

    await write(local);
    if (payload.length) await write(payload);

    const cd = Buffer.alloc(46 + nameBuf.length);
    cd.writeUInt32LE(0x02014b50, 0); // central directory header signature
    cd.writeUInt16LE((3 << 8) | 20, 4); // version made by: 3 = Unix, spec 2.0
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(payload.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30); // extra
    cd.writeUInt16LE(0, 32); // comment
    cd.writeUInt16LE(0, 34); // disk number start
    cd.writeUInt16LE(0, 36); // internal attributes
    // External attributes: Unix mode in the high 16 bits (0o40000 dir / 0o100000
    // regular file, OR'd with the permission bits), DOS directory flag in bit 4.
    const mode = modeFor(entry) & 0o7777;
    const unix = ((entry.isDir ? 0o40000 : 0o100000) | mode) >>> 0;
    cd.writeUInt32LE(((unix << 16) | (entry.isDir ? 0x10 : 0)) >>> 0, 38);
    cd.writeUInt32LE(localOffset, 42);
    nameBuf.copy(cd, 46);
    central.push(cd);
  }

  const cdStart = offset;
  for (const cd of central) await write(cd);
  const cdSize = offset - cdStart;

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // end of central directory
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(central.length, 8);
  end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(cdSize, 12);
  end.writeUInt32LE(cdStart, 16);
  end.writeUInt16LE(0, 20);
  await write(end);

  out.end();
  await once(out, "close");
  return { entries: entries.length, bytes: statSync(zipPath).size };
}

export { crc32, defaultMode, walk };
