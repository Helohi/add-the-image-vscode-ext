// Read an image from the system clipboard.
// Returns { kind: 'file', file: '/abs/path.ext', ext } for a copied image file,
//         { kind: 'data', data: Buffer, ext }           for raw image data,
// or undefined if the clipboard holds no image.
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.tif', '.tiff', '.avif', '.ico'];
const MIME_TO_EXT = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'image/bmp': '.bmp',
  'image/tiff': '.tiff',
  'image/avif': '.avif',
};
// Preference order when several image types are offered.
const MIME_PREFERENCE = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml', 'image/avif', 'image/bmp', 'image/tiff'];

function run(cmd, args, asBuffer = false) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { encoding: asBuffer ? 'buffer' : 'utf8', maxBuffer: 256 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr && stderr.toString();
        reject(err);
      } else resolve(stdout);
    });
  });
}

function isImageFile(p) {
  return IMAGE_EXTS.includes(path.extname(p).toLowerCase()) && fs.existsSync(p) && fs.statSync(p).isFile();
}

function fileFromUriList(text) {
  for (const line of String(text).split(/\r?\n/)) {
    const l = line.trim();
    if (!l.startsWith('file://')) continue;
    try {
      const p = decodeURIComponent(new URL(l).pathname);
      if (isImageFile(p)) return p;
    } catch { /* ignore */ }
  }
  return undefined;
}

function fileFromPlainText(text) {
  const t = String(text || '').trim().replace(/^["']|["']$/g, '');
  if (!t || t.includes('\n')) return undefined;
  if (t.startsWith('file://')) return fileFromUriList(t);
  const p = t.startsWith('~') ? path.join(os.homedir(), t.slice(1)) : t;
  return path.isAbsolute(p) && isImageFile(p) ? p : undefined;
}

function pickMime(types) {
  for (const m of MIME_PREFERENCE) if (types.includes(m)) return m;
  return types.find((t) => t.startsWith('image/'));
}

class MissingToolError extends Error {}

async function readLinuxGeneric(listTypes, readType, toolName) {
  let types;
  try {
    types = (await listTypes()).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch (e) {
    if (e.code === 'ENOENT') throw new MissingToolError(toolName);
    // wl-paste exits non-zero when the clipboard is empty
    return undefined;
  }
  // A copied file (from Files/Nautilus/Dolphin) beats a thumbnail of it.
  for (const t of ['text/uri-list', 'x-special/gnome-copied-files']) {
    if (types.includes(t)) {
      const f = fileFromUriList((await readType(t)).toString());
      if (f) return { kind: 'file', file: f, ext: path.extname(f).toLowerCase() };
    }
  }
  const mime = pickMime(types);
  if (mime) {
    const data = await readType(mime);
    if (data && data.length) return { kind: 'data', data, ext: MIME_TO_EXT[mime] || '.png' };
  }
  return undefined;
}

async function readLinux() {
  const wayland = !!process.env.WAYLAND_DISPLAY || process.env.XDG_SESSION_TYPE === 'wayland';
  const wl = () => readLinuxGeneric(
    () => run('wl-paste', ['--list-types']),
    (t) => run('wl-paste', ['--no-newline', '--type', t], true),
    'wl-paste'
  );
  const x = () => readLinuxGeneric(
    () => run('xclip', ['-selection', 'clipboard', '-t', 'TARGETS', '-o']),
    (t) => run('xclip', ['-selection', 'clipboard', '-t', t, '-o'], true),
    'xclip'
  );
  const order = wayland ? [wl, x] : [x, wl];
  let missing = 0;
  for (const fn of order) {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof MissingToolError) { missing++; continue; }
      throw e;
    }
  }
  if (missing === order.length) {
    throw new MissingToolError(
      wayland
        ? 'Reading images from the clipboard needs "wl-clipboard". Install it with: sudo apt install wl-clipboard'
        : 'Reading images from the clipboard needs "xclip". Install it with: sudo apt install xclip'
    );
  }
  return undefined;
}

async function readMac() {
  try {
    const f = (await run('osascript', ['-e', 'POSIX path of (the clipboard as «class furl»)'])).trim();
    if (f && isImageFile(f)) return { kind: 'file', file: f, ext: path.extname(f).toLowerCase() };
  } catch { /* not a file */ }
  const tmp = path.join(os.tmpdir(), `add-the-image-${process.pid}-${Date.now()}.png`);
  try {
    await run('osascript', [
      '-e', `set f to open for access POSIX file "${tmp}" with write permission`,
      '-e', 'try',
      '-e', 'write (the clipboard as «class PNGf») to f',
      '-e', 'end try',
      '-e', 'close access f',
    ]);
    const data = fs.readFileSync(tmp);
    return data.length ? { kind: 'data', data, ext: '.png' } : undefined;
  } catch {
    return undefined;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

async function readWindows() {
  const tmp = path.join(os.tmpdir(), `add-the-image-${process.pid}-${Date.now()}.png`);
  const script = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$files = [System.Windows.Forms.Clipboard]::GetFileDropList()
if ($files -and $files.Count -gt 0) { Write-Output ("FILE:" + $files[0]); exit 0 }
$img = [System.Windows.Forms.Clipboard]::GetImage()
if ($img) { $img.Save('${tmp.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png); Write-Output "DATA"; exit 0 }
Write-Output "NONE"`;
  try {
    const out = (await run('powershell', ['-NoProfile', '-STA', '-Command', script])).trim();
    if (out.startsWith('FILE:')) {
      const f = out.slice(5).trim();
      return isImageFile(f) ? { kind: 'file', file: f, ext: path.extname(f).toLowerCase() } : undefined;
    }
    if (out === 'DATA') return { kind: 'data', data: fs.readFileSync(tmp), ext: '.png' };
    return undefined;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/**
 * @param {string} [clipboardText] text clipboard content (from vscode.env.clipboard) used as a fallback:
 *                                 if it is a path to an image file, that file is used.
 */
async function readClipboardImage(clipboardText) {
  let result;
  if (process.platform === 'darwin') result = await readMac();
  else if (process.platform === 'win32') result = await readWindows();
  else result = await readLinux();
  if (result) return result;
  const f = fileFromPlainText(clipboardText);
  if (f) return { kind: 'file', file: f, ext: path.extname(f).toLowerCase() };
  return undefined;
}

module.exports = { readClipboardImage, MissingToolError, fileFromUriList, fileFromPlainText };
