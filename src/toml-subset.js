'use strict';

/**
 * Port of backup-folder TomlSubset.swift (subset parser and permission helper).
 */

function lineMessage(line, reason) {
  return `line ${line}: ${reason}`;
}

function isBareKey(key) {
  if (key.length === 0) return false;
  for (const character of key) {
    const ok =
      (character >= 'A' && character <= 'Z') ||
      (character >= 'a' && character <= 'z') ||
      (character >= '0' && character <= '9') ||
      character === '_' ||
      character === '-';
    if (!ok) return false;
  }
  return true;
}

function isASCIIDigit(character) {
  return character >= '0' && character <= '9';
}

function isIntegerToken(token) {
  let digits = token;
  if (digits.startsWith('-')) digits = digits.slice(1);
  return digits.length > 0 && [...digits].every(isASCIIDigit);
}

function isRejectedIntegerToken(token) {
  let rest = token;
  if (rest.startsWith('+') || rest.startsWith('-')) rest = rest.slice(1);
  if (rest.length === 0) return false;
  let sawDigit = false;
  let sawUnderscore = false;
  for (const character of rest) {
    if (isASCIIDigit(character)) sawDigit = true;
    else if (character === '_') sawUnderscore = true;
    else return false;
  }
  return sawDigit && (token.startsWith('+') || sawUnderscore);
}

function isFloatToken(token) {
  const lower = token.toLowerCase();
  if (['inf', '+inf', '-inf', 'nan', '+nan', '-nan'].includes(lower)) return true;
  let rest = token;
  if (rest.startsWith('+') || rest.startsWith('-')) rest = rest.slice(1);
  let sawDigit = false;
  let sawDot = false;
  let index = 0;
  while (index < rest.length) {
    const character = rest[index];
    if (isASCIIDigit(character)) {
      sawDigit = true;
      index += 1;
      continue;
    }
    if (character === '.' && !sawDot) {
      sawDot = true;
      index += 1;
      continue;
    }
    if ((character === 'e' || character === 'E') && sawDigit) {
      index += 1;
      if (index < rest.length && (rest[index] === '+' || rest[index] === '-')) index += 1;
      let exponentDigits = false;
      while (index < rest.length && isASCIIDigit(rest[index])) {
        exponentDigits = true;
        index += 1;
      }
      return exponentDigits && index === rest.length && (sawDigit || sawDot);
    }
    return false;
  }
  return sawDot && sawDigit;
}

function isDateToken(token) {
  if (token.length > 0 && isASCIIDigit(token[0]) && token.includes(':')) return true;
  const parts = token.split('-');
  if (parts.length >= 3 && parts[0].length === 4 && [...parts[0]].every(isASCIIDigit)) {
    return true;
  }
  return false;
}

function isCommentOrEmpty(rest) {
  const trimmed = rest.trim();
  return trimmed.length === 0 || trimmed.startsWith('#');
}

function trailingCommentOnly(line, rest) {
  if (isCommentOrEmpty(rest)) return null;
  return lineMessage(line, 'unexpected trailing characters');
}

class TomlSubsetParser {
  constructor() {
    this.root = { headerLine: 0, entries: new Map() };
    this.current = this.root;
  }

  parse(text) {
    const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    let lineNumber = 0;
    let start = 0;
    for (let index = 0; index <= normalized.length; index += 1) {
      if (index === normalized.length || normalized[index] === '\n') {
        lineNumber += 1;
        const lineText = normalized.slice(start, index);
        const err = this.parseLine(lineText, lineNumber);
        if (err) return { ok: false, message: err };
        start = index + 1;
      }
    }
    return { ok: true, table: freezeTable(this.root) };
  }

  parseLine(raw, line) {
    const trimmed = raw.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) return null;
    if (trimmed.startsWith('[[')) return this.parseArrayHeader(trimmed, line);
    if (trimmed.startsWith('[')) return this.parseTableHeader(trimmed, line);
    return this.parseAssignment(trimmed, line);
  }

  parseTableHeader(trimmed, line) {
    const close = trimmed.indexOf(']');
    if (close === -1) return lineMessage(line, 'bad table header');
    const name = trimmed.slice(1, close);
    const rest = trimmed.slice(close + 1);
    if (!isCommentOrEmpty(rest)) return lineMessage(line, 'bad table header');
    return this.defineTable(name, line, false);
  }

  parseArrayHeader(trimmed, line) {
    const end = trimmed.indexOf(']]');
    if (end === -1) return lineMessage(line, 'bad table header');
    const name = trimmed.slice(2, end);
    const rest = trimmed.slice(end + 2);
    if (!isCommentOrEmpty(rest)) return lineMessage(line, 'bad table header');
    return this.defineTable(name, line, true);
  }

  defineTable(rawName, line, array) {
    const name = rawName.trim();
    if (name.includes('.')) return lineMessage(line, 'dotted key');
    if (!isBareKey(name)) return lineMessage(line, 'bad table header');
    const existing = this.root.entries.get(name);
    if (existing !== undefined) {
      if (array && existing.kind === 'arrayOfTables') {
        const table = { headerLine: line, entries: new Map() };
        existing.tables.push(table);
        this.current = table;
        return null;
      }
      return lineMessage(line, `duplicate key ${name}`);
    }
    if (array) {
      const table = { headerLine: line, entries: new Map() };
      const tables = { kind: 'arrayOfTables', line, tables: [table] };
      this.root.entries.set(name, tables);
      this.current = table;
      return null;
    }
    const table = { headerLine: line, entries: new Map() };
    this.root.entries.set(name, { kind: 'table', table });
    this.current = table;
    return null;
  }

  parseAssignment(trimmed, line) {
    const eq = trimmed.indexOf('=');
    if (eq === -1) return lineMessage(line, 'expected key = value');
    const key = trimmed.slice(0, eq).trim();
    if (key.length === 0) return lineMessage(line, 'expected key = value');
    if (key.includes('.')) return lineMessage(line, 'dotted key');
    if (!isBareKey(key)) return lineMessage(line, 'invalid key');
    const valuePart = trimmed.slice(eq + 1);
    const parsed = parseValue(line, valuePart);
    if (!parsed.ok) return parsed.message;
    if (this.current.entries.has(key)) {
      return lineMessage(line, `duplicate key ${key}`);
    }
    this.current.entries.set(key, parsed.value);
    return null;
  }
}

function parseValue(line, raw) {
  const text = raw.trim();
  if (text.length === 0) {
    return { ok: false, message: lineMessage(line, 'expected a value') };
  }
  if (text.startsWith('"""') || text.startsWith("'''")) {
    return { ok: false, message: lineMessage(line, 'multiline string') };
  }
  if (text.startsWith("'")) {
    return { ok: false, message: lineMessage(line, 'literal string') };
  }
  if (text.startsWith('{')) {
    return { ok: false, message: lineMessage(line, 'inline table') };
  }
  if (text.startsWith('"')) {
    const parsed = parseBasicString(text, 0, line);
    if (!parsed.ok) return parsed;
    const trail = trailingCommentOnly(line, text.slice(parsed.next));
    if (trail) return { ok: false, message: trail };
    return { ok: true, value: { kind: 'string', line, value: parsed.value } };
  }
  if (text.startsWith('[')) {
    const parsed = parseStringArray(text, 0, line);
    if (!parsed.ok) return parsed;
    const trail = trailingCommentOnly(line, text.slice(parsed.next));
    if (trail) return { ok: false, message: trail };
    return { ok: true, value: { kind: 'arrayOfStrings', line, value: parsed.items } };
  }
  const tokenEndMatch = text.search(/[\s#]/);
  const tokenEnd = tokenEndMatch === -1 ? text.length : tokenEndMatch;
  const token = text.slice(0, tokenEnd);
  const trail = trailingCommentOnly(line, text.slice(tokenEnd));
  if (trail) return { ok: false, message: trail };
  return classifyBare(line, token);
}

function parseBasicString(text, start, line) {
  let index = start + 1;
  let out = '';
  while (index < text.length) {
    const character = text[index];
    if (character === '\\') {
      const next = index + 1;
      if (next >= text.length) return { ok: false, message: lineMessage(line, 'bad escape') };
      const escaped = text[next];
      if (escaped === '\\' || escaped === '"') {
        out += escaped;
        index = next + 1;
        continue;
      }
      return { ok: false, message: lineMessage(line, 'bad escape') };
    }
    if (character === '"') {
      return { ok: true, value: out, next: index + 1 };
    }
    out += character;
    index += 1;
  }
  return { ok: false, message: lineMessage(line, 'unterminated string') };
}

function parseStringArray(text, start, line) {
  let index = start + 1;
  const items = [];
  let expectValue = true;
  while (index < text.length) {
    const character = text[index];
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (character === '#') {
      return { ok: false, message: lineMessage(line, 'unterminated array') };
    }
    if (character === ']') {
      return { ok: true, items, next: index + 1 };
    }
    if (character === ',') {
      if (expectValue) {
        return { ok: false, message: lineMessage(line, 'expected a string in the array') };
      }
      expectValue = true;
      index += 1;
      continue;
    }
    if (character === '"') {
      if (!expectValue) {
        return { ok: false, message: lineMessage(line, 'expected a comma in the array') };
      }
      const parsed = parseBasicString(text, index, line);
      if (!parsed.ok) return parsed;
      items.push(parsed.value);
      index = parsed.next;
      expectValue = false;
      continue;
    }
    return { ok: false, message: lineMessage(line, 'array elements must be basic strings') };
  }
  return { ok: false, message: lineMessage(line, 'unterminated array') };
}

function classifyBare(line, token) {
  if (token.length === 0) {
    return { ok: false, message: lineMessage(line, 'expected a value') };
  }
  if (isIntegerToken(token)) {
    const number = Number.parseInt(token, 10);
    if (Number.isNaN(number)) {
      return { ok: false, message: lineMessage(line, 'invalid integer') };
    }
    return { ok: true, value: { kind: 'integer', line, value: number } };
  }
  if (isFloatToken(token)) {
    return { ok: false, message: lineMessage(line, 'float') };
  }
  if (isRejectedIntegerToken(token)) {
    return { ok: false, message: lineMessage(line, 'invalid integer') };
  }
  if (token === 'true' || token === 'false') {
    return { ok: false, message: lineMessage(line, 'boolean') };
  }
  if (isDateToken(token)) {
    return { ok: false, message: lineMessage(line, 'date') };
  }
  return { ok: false, message: lineMessage(line, 'unsupported value') };
}

function freezeTable(mutable) {
  const out = Object.create(null);
  for (const [key, value] of mutable.entries) {
    out[key] = freezeValue(value);
  }
  return out;
}

function freezeValue(value) {
  switch (value.kind) {
    case 'string':
      return { line: value.line, content: { type: 'string', value: value.value } };
    case 'integer':
      return { line: value.line, content: { type: 'integer', value: value.value } };
    case 'arrayOfStrings':
      return { line: value.line, content: { type: 'arrayOfStrings', value: value.value } };
    case 'table':
      return { line: value.table.headerLine, content: { type: 'table', value: freezeTable(value.table) } };
    case 'arrayOfTables': {
      const rows = value.tables.map((t) => freezeTable(t));
      return { line: value.line, content: { type: 'arrayOfTables', value: rows } };
    }
    default:
      throw new Error('unknown build value');
  }
}

/**
 * @param {string} text
 * @returns {{ ok: true, table: Record<string, unknown> } | { ok: false, message: string }}
 */
function parseTomlSubset(text) {
  const parser = new TomlSubsetParser();
  const result = parser.parse(text);
  if (!result.ok) return result;
  return { ok: true, table: result.table };
}

/** @param {number} mode stat mode bits */
function configPermissionsAcceptable(mode) {
  return (mode & 0o077) === 0;
}

module.exports = {
  parseTomlSubset,
  configPermissionsAcceptable,
  lineMessage,
};
