// Pure helpers (no vscode dependency) so they can be unit-tested with plain node.
const path = require('path');

// ![alt](path) / ![alt](<path with spaces>) / ![alt](path "title")
const IMAGE_RE = /!\[([^\]]*)\]\(\s*(<[^>]*>|[^)\s]*)((?:\s+(?:"[^"]*"|'[^']*'))?)\s*\)/g;

/**
 * Find the image link on `lineText` that contains column `col`.
 * Returns { alt, rawPath, path, pathStart, pathEnd, start, end } or undefined.
 * pathStart/pathEnd cover the raw path token (including <> if used); when the
 * path is empty they are both the position right after "(".
 */
function findImageLinkAt(lineText, col) {
  IMAGE_RE.lastIndex = 0;
  let m;
  while ((m = IMAGE_RE.exec(lineText)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    if (col < start || col > end) continue;
    const alt = m[1];
    const rawPath = m[2];
    const openParen = start + 2 + alt.length + 1; // after "![" + alt + "]"
    const afterParen = openParen + 1;
    const pathStart = lineText.indexOf(rawPath, afterParen);
    const pathEnd = pathStart + rawPath.length;
    let p = rawPath;
    if (p.startsWith('<') && p.endsWith('>')) p = p.slice(1, -1);
    return { alt, rawPath, path: p.trim(), pathStart, pathEnd, start, end };
  }
  return undefined;
}

function isRemote(p) {
  return /^(https?:|data:|ftp:|mailto:)/i.test(p) || p.startsWith('//');
}

function safeDecode(p) {
  try { return decodeURI(p); } catch { return p; }
}

/** Resolve a link path to an absolute filesystem path. */
function resolveLinkPath(linkPath, mdDir, workspaceRoot) {
  let p = safeDecode(linkPath.split('#')[0].split('?')[0]);
  if (p.startsWith('file://')) return decodeURIComponent(new URL(p).pathname);
  if (path.isAbsolute(p) && p.startsWith('/') && workspaceRoot) {
    // Treat "/img/a.png" as workspace-root relative (how most Markdown sites render it),
    // unless it's clearly a real absolute path that exists outside the workspace.
    const fs = require('fs');
    const parent = path.dirname(p);
    if (!fs.existsSync(parent)) return path.join(workspaceRoot, p);
    return p;
  }
  if (path.isAbsolute(p)) return p;
  return path.resolve(mdDir, p);
}

function slugify(text) {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/** Suggest a relative path for an empty link, based on the alt text. */
function suggestPath(alt, folder, ext) {
  const base = slugify(alt) || `image-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`;
  const f = (folder || '').replace(/\\/g, '/').replace(/\/+$/, '');
  return (f ? f + '/' : '') + base + ext;
}

/** Format a relative path for insertion into Markdown. */
function formatLinkPath(rel) {
  const p = rel.split(path.sep).join('/');
  return /[\s()<>]/.test(p) ? `<${p}>` : p;
}

module.exports = { findImageLinkAt, isRemote, resolveLinkPath, slugify, suggestPath, formatLinkPath };
