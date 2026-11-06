const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { findImageLinkAt, isRemote, resolveLinkPath, suggestPath, formatLinkPath } = require('./links');
const { readClipboardImage, MissingToolError } = require('./clipboard');

const CMD = 'addTheImage.pasteIntoLink';

// Links currently being processed (shows a spinner in the hover, blocks double clicks).
const busy = new Set();
const busyKey = (uri, line) => `${uri.toString()}#${line}`;
// Files saved in the last few seconds (hover shows a "Saved" badge).
const justSaved = new Map();

function cfg() {
  return vscode.workspace.getConfiguration('addTheImage');
}

function contextFor(doc) {
  const wsFolder = vscode.workspace.getWorkspaceFolder(doc.uri);
  const wsRoot = wsFolder ? wsFolder.uri.fsPath : undefined;
  const mdDir = doc.uri.scheme === 'file' && !doc.isUntitled ? path.dirname(doc.uri.fsPath) : wsRoot;
  return { mdDir, wsRoot };
}

const EXT_ALIASES = { '.jpeg': '.jpg', '.tif': '.tiff' };
const sameExt = (a, b) => {
  const n = (e) => { const l = (e || '').toLowerCase(); return EXT_ALIASES[l] || l; };
  return n(a) === n(b);
};

class ImageLinkHoverProvider {
  provideHover(doc, pos) {
    const line = doc.lineAt(pos.line).text;
    const link = findImageLinkAt(line, pos.character);
    if (!link || isRemote(link.path)) return undefined;

    const { mdDir, wsRoot } = contextFor(doc);
    if (!mdDir) return undefined;

    const range = new vscode.Range(pos.line, link.start, pos.line, link.end);

    if (busy.has(busyKey(doc.uri, pos.line))) {
      return new vscode.Hover(new vscode.MarkdownString('$(sync~spin) Adding image…', true), range);
    }

    let exists = false;
    let target = '';
    let abs = '';
    if (link.path) {
      abs = resolveLinkPath(link.path, mdDir, wsRoot);
      exists = fs.existsSync(abs);
      target = path.relative(mdDir, abs).split(path.sep).join('/');
    }
    if (exists && !cfg().get('showForExistingImages', true)) return undefined;

    const args = encodeURIComponent(JSON.stringify([{ uri: doc.uri.toString(), line: pos.line, character: pos.character }]));
    const label = exists ? '$(replace) Replace with copied image' : '$(add) Add copied image';
    const detail = !link.path
      ? 'empty path: a file name will be created from the description'
      : exists
        ? `overwrite \`${target}\``
        : `save as \`${target}\``;

    const md = new vscode.MarkdownString('', true);
    md.isTrusted = { enabledCommands: [CMD] };
    if (justSaved.get(abs)) md.appendMarkdown(`$(check) **Saved** \`${target}\`\n\n`);
    md.appendMarkdown(`[${label}](command:${CMD}?${args} "Save the clipboard image into this link") · ${detail}`);
    // No image preview here: VS Code's built-in Markdown hover already shows one.
    return new vscode.Hover(md, range);
  }
}

async function pasteIntoLink(arg) {
  let doc;
  let line;
  let character;
  let key;
  if (arg && arg.uri) {
    key = `${arg.uri}#${arg.line}`;
    if (busy.has(key)) return; // ignore double clicks
    busy.add(key); // set before any await so the hover shows the spinner immediately
    line = arg.line;
    character = arg.character;
  } else {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    doc = editor.document;
    line = editor.selection.active.line;
    character = editor.selection.active.character;
    key = busyKey(doc.uri, line);
    if (busy.has(key)) return;
    busy.add(key);
  }

  // Close the hover right away; progress shows in the status bar.
  vscode.commands.executeCommand('editor.action.hideHover').then(undefined, () => {});

  let result;
  try {
    if (!doc) doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(arg.uri));
    result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'Add The Image: adding image…' },
      () => addImage(doc, line, character)
    );
  } catch (e) {
    vscode.window.showErrorMessage(`Add The Image: ${e.message}`);
  } finally {
    busy.delete(key);
  }
  if (!result) return;

  // Success feedback: "Saved" badge on the next hover + self-closing notification.
  justSaved.set(result.abs, true);
  setTimeout(() => justSaved.delete(result.abs), 8000);

  // Self-closing notification (regular notifications have no timeout API).
  vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `$(check) Image saved: ${result.rel}` },
    async (progress) => {
      progress.report({ increment: 100 });
      await sleep(2500);
    }
  );
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Does the actual work. Returns { abs, rel, linkStart } on success, undefined if cancelled/failed. */
async function addImage(doc, line, character) {
  const link = findImageLinkAt(doc.lineAt(line).text, character);
  if (!link) {
    vscode.window.showWarningMessage('Add The Image: put the cursor on a Markdown image link like ![description](path/to/image.png).');
    return;
  }
  if (isRemote(link.path)) {
    vscode.window.showWarningMessage('Add The Image: this link points to a URL, not a local file.');
    return;
  }

  const { mdDir, wsRoot } = contextFor(doc);
  if (!mdDir) {
    vscode.window.showWarningMessage('Add The Image: save the Markdown file first so relative paths can be resolved.');
    return;
  }

  // 1. Read the clipboard.
  let clip;
  try {
    clip = await readClipboardImage(await vscode.env.clipboard.readText());
  } catch (e) {
    if (e instanceof MissingToolError) {
      vscode.window.showErrorMessage(`Add The Image: ${e.message}`);
    } else {
      vscode.window.showErrorMessage(`Add The Image: could not read the clipboard: ${e.message}`);
    }
    return;
  }
  if (!clip) {
    vscode.window.showWarningMessage('Add The Image: the clipboard does not contain an image (or a copied image file).');
    return;
  }

  // 2. Decide the target path (relative to the .md file).
  let rel = link.path;
  let linkChanged = false;

  if (!rel) {
    const suggestion = suggestPath(link.alt, cfg().get('defaultFolder', 'images'), clip.ext);
    if (cfg().get('askForNameWhenEmpty', true)) {
      const baseStart = suggestion.lastIndexOf('/') + 1;
      const baseEnd = suggestion.length - clip.ext.length;
      const input = await vscode.window.showInputBox({
        title: 'Add The Image: save copied image as',
        prompt: 'Path relative to the Markdown file',
        value: suggestion,
        valueSelection: [baseStart, baseEnd],
        validateInput: (v) => (v.trim() ? undefined : 'Enter a file name'),
      });
      if (input === undefined) return;
      rel = input.trim();
    } else {
      rel = suggestion;
    }
    if (!path.extname(rel)) rel += clip.ext;
    linkChanged = true;
  } else if (!path.extname(rel.split(/[?#]/)[0])) {
    rel += clip.ext;
    linkChanged = true;
  } else {
    const targetExt = path.extname(rel.split(/[?#]/)[0]);
    if (!sameExt(targetExt, clip.ext)) {
      const fixed = rel.slice(0, rel.length - targetExt.length) + clip.ext;
      const choice = await vscode.window.showQuickPick(
        [
          { label: `Rename to ${path.basename(fixed)}`, description: `copied image is ${clip.ext}; updates the link`, value: 'fix' },
          { label: `Keep ${path.basename(rel)}`, description: `writes ${clip.ext} data under a ${targetExt} name`, value: 'keep' },
        ],
        { title: `The copied image is ${clip.ext}, but the link expects ${targetExt}` }
      );
      if (!choice) return;
      if (choice.value === 'fix') {
        rel = fixed;
        linkChanged = true;
      }
    }
  }

  const abs = resolveLinkPath(rel, mdDir, wsRoot);

  // 3. Don't silently overwrite.
  if (fs.existsSync(abs)) {
    const ok = await vscode.window.showWarningMessage(
      `${path.basename(abs)} already exists. Replace it with the copied image?`,
      { modal: true },
      'Replace'
    );
    if (ok !== 'Replace') return;
  }

  // 4. Write the file.
  try {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    if (clip.kind === 'file') {
      if (path.resolve(clip.file) !== path.resolve(abs)) fs.copyFileSync(clip.file, abs);
    } else {
      fs.writeFileSync(abs, clip.data);
    }
  } catch (e) {
    vscode.window.showErrorMessage(`Add The Image: could not save ${abs}: ${e.message}`);
    return;
  }

  // 5. Update the link text if the path changed.
  if (linkChanged) {
    const edit = new vscode.WorkspaceEdit();
    edit.replace(doc.uri, new vscode.Range(line, link.pathStart, line, link.pathEnd), formatLinkPath(rel));
    await vscode.workspace.applyEdit(edit);
  }

  return { abs, rel: path.relative(mdDir, abs).split(path.sep).join('/'), linkStart: link.start };
}

function activate(context) {
  context.subscriptions.push(
    vscode.languages.registerHoverProvider({ language: 'markdown' }, new ImageLinkHoverProvider()),
    vscode.commands.registerCommand(CMD, pasteIntoLink)
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
