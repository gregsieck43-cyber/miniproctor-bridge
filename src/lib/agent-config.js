import fs from 'node:fs';
import path from 'node:path';

/**
 * Minimal YAML-subset parser for the `miniproctor:` and `ui:` blocks in
 * AGENTS.md. Deliberately small: it parses nested maps, sequences and scalar
 * lists, which is all the template needs.
 */
export function parseAgentConfig(text) {
  const lines = String(text || '').split(/\r?\n/);
  const root = {};
  const stack = [{ indent: -1, value: root, isList: false }];
  let current = root;

  const setValue = (key, value) => {
    if (Array.isArray(current)) current.push({ [key]: value });
    else current[key] = value;
  };

  for (let raw of lines) {
    const noComment = raw.replace(/#.*$/, '');
    if (!noComment.trim()) continue;
    const indent = noComment.search(/\S/);
    const line = noComment.trim();
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    current = stack[stack.length - 1].value;

    if (line.startsWith('- ')) {
      const body = line.slice(2).trim();
      const colon = body.indexOf(':');
      if (colon > 0) {
        const key = body.slice(0, colon).trim();
        const valueText = body.slice(colon + 1).trim();
        const item = {};
        current.push(item);
        if (valueText === '') {
          stack.push({ indent, value: item, isList: false });
          current = item;
        } else {
          item[key] = parseScalar(valueText);
        }
      } else {
        current.push(parseScalar(body));
      }
      continue;
    }

    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim();
    const valueText = line.slice(colon + 1).trim();
    if (valueText === '') {
      const nextLine = lines.slice(lines.indexOf(raw) + 1).map((l) => l.replace(/#.*$/, '')).find((l) => l.trim());
      const isList = Boolean(nextLine && nextLine.trim().startsWith('- '));
      const child = isList ? [] : {};
      setValue(key, child);
      stack.push({ indent, value: child, isList });
      current = child;
    } else if (valueText.startsWith('[') && valueText.endsWith(']')) {
      const inner = valueText.slice(1, -1).split(',').map((s) => parseScalar(s.trim())).filter((s) => s !== '');
      setValue(key, inner);
    } else {
      setValue(key, parseScalar(valueText));
    }
  }
  return root;
}

export function loadAgentConfig(cwd = process.cwd()) {
  const file = path.join(cwd, 'AGENTS.md');
  if (!fs.existsSync(file)) return { ok: false, source: null, miniproctor: null, ui: null };
  const parsed = parseAgentConfig(fs.readFileSync(file, 'utf8'));
  return {
    ok: true,
    source: file,
    miniproctor: parsed.miniproctor || null,
    ui: parsed.ui || null,
  };
}

function parseScalar(text) {
  const s = String(text).trim().replace(/^['"]|['"]$/g, '');
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+$/.test(s)) return Number(s);
  if (/^-?\d*\.\d+$/.test(s)) return Number(s);
  return s;
}
