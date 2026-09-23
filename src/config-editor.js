import { readFile, writeFile } from 'node:fs/promises';
import { emitKeypressEvents } from 'node:readline';
import { PassThrough } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { parseConfigText } from './config.js';
import { semanticIssue, editorCompletions } from './config-diagnostics.js';
import { configClipboard } from './config-clipboard.js';

const safe = text => text.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');

export async function validateEditorText(text) {
  try {
    // Run source-aware checks even when the normal loader rejects a setting.
    return await semanticIssue(text);
  } catch (error) {
    try { parseConfigText(text); } catch (configError) { error = configError; }
    const location = /line (\d+), column (\d+)/.exec(error.message);
    return { message: error.message.replace(/^The veo config file is not valid JSON: .*?\(line \d+, column \d+\)\. /, ''), line: location ? Number(location[1]) : null,
      column: location ? Number(location[2]) : null };
  }
}

// A small text buffer shared by the keyboard handler and focused editing tests.
export class EditorBuffer {
  constructor(text) { this.text = text; this.cursor = 0; this.anchor = null; }
  get selection() {
    return this.anchor === null ? [this.cursor, this.cursor] : [Math.min(this.anchor, this.cursor), Math.max(this.anchor, this.cursor)];
  }
  deleteSelection() {
    const [start, end] = this.selection;
    this.anchor = null;
    if (start === end) return false;
    this.text = this.text.slice(0, start) + this.text.slice(end); this.cursor = start;
    return true;
  }
  point(row, col, extend = false) {
    if (extend && this.anchor === null) this.anchor = this.cursor;
    if (!extend) this.anchor = null;
    const lines = this.text.split('\n');
    row = Math.max(0, Math.min(lines.length - 1, row));
    this.cursor = lines.slice(0, row).reduce((sum, line) => sum + line.length + 1, 0) + Math.max(0, Math.min(lines[row].length, col));
  }
  insert(text) {
    this.deleteSelection();
    this.text = this.text.slice(0, this.cursor) + text + this.text.slice(this.cursor);
    this.cursor += text.length;
  }
  get position() {
    const before = this.text.slice(0, this.cursor);
    return { row: before.split('\n').length - 1, col: this.cursor - before.lastIndexOf('\n') - 1 };
  }
  move(rows) {
    const lines = this.text.split('\n'), { row, col } = this.position;
    const next = Math.max(0, Math.min(lines.length - 1, row + rows));
    this.cursor = lines.slice(0, next).reduce((sum, line) => sum + line.length + 1, 0) + Math.min(col, lines[next].length);
  }
  key(name) {
    if (['backspace', 'delete'].includes(name) && this.deleteSelection()) return;
    if (['left', 'right', 'up', 'down', 'home', 'end'].includes(name)) this.anchor = null;
    if (name === 'left') this.cursor = Math.max(0, this.cursor - 1);
    if (name === 'right') this.cursor = Math.min(this.text.length, this.cursor + 1);
    if (name === 'up') this.move(-1);
    if (name === 'down') this.move(1);
    if (name === 'home') this.cursor -= this.position.col;
    if (name === 'end') this.cursor = this.text.indexOf('\n', this.cursor) < 0 ? this.text.length : this.text.indexOf('\n', this.cursor);
    if (name === 'backspace' && this.cursor) {
      this.text = this.text.slice(0, this.cursor - 1) + this.text.slice(this.cursor); this.cursor--;
    }
    if (name === 'delete') this.text = this.text.slice(0, this.cursor) + this.text.slice(this.cursor + 1);
    if (name === 'return') this.insert('\n');
    if (name === 'tab') this.insert('  ');
  }
}

export function colorLine(line, enabled = true) {
  const clean = safe(line);
  if (!enabled) return clean;
  return clean.replace(/("(?:\\.|[^"\\])*"\s*:?)|(\/\/.*$)|\b(true|false|null|-?\d+(?:\.\d+)?)\b/g,
    (token, string, comment) => `\x1b[${comment ? 90 : string ? (token.endsWith(':') ? 36 : 32) : 33}m${token}\x1b[0m`);
}

export async function editConfig(file, { input = process.stdin, output = process.stdout, color = !Object.hasOwn(process.env, 'NO_COLOR'), clipboard = configClipboard } = {}) {
  if (!input.isTTY || !output.isTTY || !input.setRawMode) throw new Error('The config editor requires an interactive terminal. Set EDITOR to use an external editor.');
  const original = await readFile(file, 'utf8');
  const newline = original.includes('\r\n') ? '\r\n' : '\n';
  const buffer = new EditorBuffer(original.replace(/\r\n/g, '\n'));
  let saved = buffer.text, disk = original, issue = await validateEditorText(buffer.text);
  let top = 0, left = 0, followCursor = true, question = false, busy = false, closed = false, timer;
  let status = '', revision = 0;
  let viewport, dragging = false, completion = null;
  const wasRaw = input.isRaw, wasPaused = input.isPaused();
  const render = () => {
    if (closed) return;
    const width = Math.max(1, (output.columns || 80) - 1);
    const diagnosis = issue ? `${issue.line ? `Line ${issue.line}, column ${issue.column}: ` : ''}${issue.message}` : '';
    const detail = safe(completion ? `Options (${completion.index + 1}/${completion.choices.length}): ${JSON.stringify(completion.choices[completion.index])} | Up/Down choose, Enter apply, Esc cancel` :
      status ? `${status}${diagnosis ? ` | ${diagnosis}` : ''}` : diagnosis || 'Config OK');
    const detailRows = Math.min(3, Math.max(1, Math.ceil(detail.length / width)));
    const height = Math.max(1, (output.rows || 24) - 2 - detailRows);
    const lines = buffer.text.split('\n'), { row, col } = buffer.position;
    const gutter = Math.min(width - 1, String(lines.length).length + 2), available = Math.max(1, width - gutter);
    if (followCursor) {
      top = Math.max(0, Math.min(top, row));
      if (row >= top + height) top = row - height + 1;
    }
    top = Math.max(0, Math.min(top, Math.max(0, lines.length - height)));
    left = Math.max(0, Math.min(left, col)); if (col >= left + available) left = col - available + 1;
    viewport = { height, gutter, width };
    const [selectionStart, selectionEnd] = buffer.selection;
    let offset = lines.slice(0, top).reduce((sum, line) => sum + line.length + 1, 0);
    const screen = [safe(`veo config | ${file}${buffer.text !== saved ? ' *' : ''}`).slice(0, width)];
    for (let index = top; index < top + height; index++) {
      const line = lines[index];
      const prefix = line === undefined ? '' : `${index + 1 === issue?.line ? '!' : ' '}${String(index + 1).padStart(Math.max(0, gutter - 2))} `;
      const content = (line || '').slice(left, left + available);
      const start = Math.max(0, selectionStart - offset - left), end = Math.min(content.length, selectionEnd - offset - left);
      if (end > start) {
        screen.push(prefix + colorLine(content.slice(0, start), color) + '\x1b[7m' + safe(content.slice(start, end)) + '\x1b[0m' + colorLine(content.slice(end), color));
      } else if (issue?.start !== undefined && color) {
        const from = Math.max(0, issue.start - offset - left), to = Math.min(content.length, issue.end - offset - left);
        screen.push(to > from ? prefix + colorLine(content.slice(0, from), color) + '\x1b[41;97m' + safe(content.slice(from, to)) + '\x1b[0m' + colorLine(content.slice(to), color) : prefix + colorLine(content, color));
      } else screen.push(index + 1 === issue?.line && color ? `\x1b[41;97m${prefix}${safe(content)}\x1b[0m` : prefix + colorLine(content, color));
      offset += (line || '').length + 1;
    }
    const position = `Ln ${row + 1}, Col ${col + 1}`;
    const help = safe(question ? 'Discard unsaved changes? Y = discard, N / Esc = keep editing' : 'Ctrl+S Save | Ctrl+C Copy | Ctrl+V Paste | Esc Exit | F2 Options | Wheel Scroll');
    const helpWidth = Math.max(0, width - position.length - 1);
    screen.push((help.slice(0, helpWidth) + ' '.repeat(Math.max(1, width - position.length - Math.min(help.length, helpWidth))) + position).slice(0, width));
    for (let index = 0; index < detailRows; index++) screen.push(detail.slice(index * width, (index + 1) * width));
    const cursorVisible = row >= top && row < top + height;
    output.write('\x1b[?25l\x1b[H' + screen.map(line => line + '\x1b[K').join('\r\n') +
      (cursorVisible ? `\x1b[${row - top + 2};${gutter + col - left + 1}H\x1b[?25h` : ''));
  };
  await new Promise((resolve, reject) => {
    const keyboard = new PassThrough();
    const decoder = new StringDecoder('utf8');
    let pending = '', mouseTimer;
    const mouse = (button, x, y, release) => {
      if (busy || closed || question) return;
      if (button & 64) {
        if (!release) {
          followCursor = false;
          top += (button & 1) ? 3 : -3;
          render();
        }
        return;
      }
      completion = null;
      if ((button & 3) !== 0) return;
      const inside = y >= 2 && y <= viewport.height + 1 && x >= 1 && x <= viewport.width;
      if (!inside && !dragging) return;
      if (!(button & 32) && !release) {
        followCursor = true;
        buffer.point(top + y - 2, left + x - viewport.gutter - 1);
        buffer.anchor = buffer.cursor; dragging = true;
      } else if (dragging) {
        buffer.point(top + Math.max(0, Math.min(viewport.height - 1, y - 2)), left + x - viewport.gutter - 1, true);
      }
      if (release) dragging = false;
      render();
    };
    // Filter SGR mouse reports before readline so their digits never enter the file.
    const onData = chunk => {
      clearTimeout(mouseTimer);
      pending += typeof chunk === 'string' ? chunk : decoder.write(chunk);
      while (pending) {
        const match = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(pending);
        if (match) {
          pending = pending.slice(match[0].length);
          mouse(Number(match[1]), Number(match[2]), Number(match[3]), match[4] === 'm');
        } else if (/^\x1b(?:\[(?:<[\d;]*)?)?$/.test(pending)) {
          mouseTimer = setTimeout(() => { if (!pending.startsWith('\x1b[<')) keyboard.write(pending); pending = ''; }, 100);
          break;
        } else {
          const character = String.fromCodePoint(pending.codePointAt(0));
          keyboard.write(character); pending = pending.slice(character.length);
        }
      }
    };
    const finish = error => {
      if (closed) return;
      closed = true; clearTimeout(timer); clearTimeout(mouseTimer);
      input.off('data', onData); keyboard.off('keypress', onKey); keyboard.destroy();
      input.off('keypress', onKey); input.off('end', onEnd); input.off('error', onError); output.off('resize', render);
      input.setRawMode(Boolean(wasRaw)); if (wasPaused) input.pause();
      output.write('\x1b[?1002l\x1b[?1006l\x1b[0m\x1b[?25h\x1b[?1049l');
      error ? reject(error) : resolve();
    };
    const onEnd = () => finish();
    const onError = error => finish(error);
    const onKey = async (text, key = {}) => {
      if (busy || closed) return;
      try {
        if (question) {
          if (text?.toLowerCase() === 'y') return finish();
          if (text?.toLowerCase() === 'n' || key.name === 'escape') question = false;
          render(); return;
        }
        if (completion) {
          if (key.name === 'escape') completion = null;
          else if (['up', 'down', 'tab'].includes(key.name)) completion.index = (completion.index + (key.name === 'up' ? -1 : 1) + completion.choices.length) % completion.choices.length;
          else if (key.name === 'return') {
            buffer.anchor = completion.start; buffer.cursor = completion.end;
            buffer.insert(JSON.stringify(completion.choices[completion.index]));
            completion = null; status = ''; revision++; clearTimeout(timer);
            busy = true; issue = await validateEditorText(buffer.text); busy = false;
          }
          render(); return;
        }
        if (key.name === 'f2' || (key.ctrl && key.name === 'space')) {
          const options = editorCompletions(buffer.text, buffer.cursor);
          completion = options ? { ...options, index: 0 } : null;
          status = options ? '' : 'No options here. Place the cursor on a property or value in valid JSON.';
          render(); return;
        }
        if (key.ctrl && key.name === 'c') {
          const [start, end] = buffer.selection;
          if (start === end) status = 'Select text first, then press Ctrl+C.';
          else {
            busy = true;
            try { await clipboard.copy(buffer.text.slice(start, end)); status = 'Copied to clipboard.'; }
            catch (error) { status = `Copy failed: ${error.message}`; }
            finally { busy = false; }
          }
          render(); return;
        }
        if (key.ctrl && key.name === 'v') {
          busy = true;
          try {
            const pasted = (await clipboard.paste()).replace(/\r\n?|\n/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
            if (pasted) {
              buffer.insert(pasted); followCursor = true;
              status = ''; issue = await validateEditorText(buffer.text);
              revision++; clearTimeout(timer);
            } else status = 'Clipboard has no text.';
          } catch (error) { status = `Paste failed: ${error.message}`; }
          finally { busy = false; }
          render(); return;
        }
        if (key.ctrl && ['up', 'down'].includes(key.name)) {
          followCursor = false; top += key.name === 'up' ? -3 : 3; render(); return;
        }
        if (key.name === 'escape' || (key.ctrl && key.name === 'q')) {
          if (buffer.text === saved) return finish();
          question = true; render(); return;
        }
        if (key.ctrl && key.name === 's') {
          followCursor = true;
          revision++; clearTimeout(timer); buffer.anchor = null;
          busy = true;
          issue = await validateEditorText(buffer.text);
          if (issue) {
            if (issue.line) buffer.cursor = buffer.text.split('\n').slice(0, issue.line - 1).reduce((sum, line) => sum + line.length + 1, 0) + issue.column - 1;
          } else {
            try {
              if (await readFile(file, 'utf8') !== disk) throw new Error('File changed outside the editor. Exit and reopen before saving.');
              const next = buffer.text.replace(/\n/g, newline);
              await writeFile(file, next, 'utf8'); disk = next; saved = buffer.text; status = 'Saved';
            } catch (error) { status = `Save failed: ${error.message}`; }
          }
          busy = false; render(); return;
        }
        if (key.ctrl || key.meta) return;
        followCursor = true;
        const before = buffer.text;
        if (key.name === 'pageup' || key.name === 'pagedown') buffer.move((key.name === 'pageup' ? -1 : 1) * viewport.height);
        else if (['left', 'right', 'up', 'down', 'home', 'end', 'backspace', 'delete', 'return', 'tab'].includes(key.name)) buffer.key(key.name);
        else if (text && !/[\x00-\x1f\x7f-\x9f]/.test(text)) buffer.insert(text);
        if (before !== buffer.text) {
          status = ''; issue = null; const current = ++revision; clearTimeout(timer);
          timer = setTimeout(async () => {
            const result = await validateEditorText(buffer.text);
            if (!closed && current === revision) { issue = result; render(); }
          }, 150);
        }
        render();
      } catch (error) { finish(error); }
    };
    emitKeypressEvents(keyboard); keyboard.on('keypress', onKey);
    input.on('data', onData);
    input.on('keypress', onKey); input.on('end', onEnd); input.on('error', onError); output.on('resize', render);
    input.setRawMode(true); input.resume();
    output.write('\x1b[?1049h\x1b[?1006h\x1b[?1002h'); render();
  });
}
