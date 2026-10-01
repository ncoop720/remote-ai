import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChatItem } from '../../../../shared/types.js';

const MAX_TEXT = 8000;
const MAX_OUTPUT = 1500;

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}… (${s.length - max} more characters)` : s;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/** One line describing a tool call, e.g. the command for Bash or the path for Edit. */
export function summarizeToolInput(name: string, input: unknown): string {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const first = (s: string | undefined) => (s ?? '').split('\n')[0]!.slice(0, 200);
  switch (name) {
    case 'Bash':
      return first(str(i.command));
    case 'Read':
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
      return str(i.file_path) ?? str(i.notebook_path) ?? '';
    case 'Grep':
      return [str(i.pattern), str(i.path)].filter(Boolean).join(' in ');
    case 'Glob':
      return str(i.pattern) ?? '';
    case 'WebFetch':
      return str(i.url) ?? '';
    case 'WebSearch':
      return str(i.query) ?? '';
    case 'Task':
    case 'Agent':
      return str(i.description) ?? str(i.subagent_type) ?? '';
    case 'TodoWrite':
      return Array.isArray(i.todos) ? `${i.todos.length} items` : '';
    default: {
      const firstString = Object.values(i).find((v): v is string => typeof v === 'string');
      return first(firstString);
    }
  }
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b: { type?: string; text?: string }) => (b.type === 'text' ? (b.text ?? '') : b.type === 'image' ? '[image]' : ''))
      .join('\n');
  }
  return '';
}

/** Slash commands and their output are stored as tagged user text. */
function parseTaggedUserText(text: string): { kind: 'command' | 'skip'; text: string } | null {
  const command = /<command-name>([^<]*)<\/command-name>/.exec(text);
  if (command) {
    const args = /<command-args>([^<]*)<\/command-args>/.exec(text)?.[1]?.trim();
    return { kind: 'command', text: `${command[1]!.trim()}${args ? ` ${args}` : ''}` };
  }
  if (/^\s*<(local-command-stdout|local-command-caveat|system-reminder|bash-input|bash-stdout|bash-stderr)>/.test(text)) {
    return { kind: 'skip', text: '' };
  }
  return null;
}

/**
 * Turn one transcript line into chat items. Claude Code writes one line per event: user prompts,
 * one assistant line per content block (thinking, text, tool_use), tool results as user lines,
 * and bookkeeping (attachments, modes, snapshots, costs) that the chat doesn't show.
 */
export function parseTranscriptLine(line: string): ChatItem[] {
  let e: {
    type?: string;
    uuid?: string;
    timestamp?: string;
    isMeta?: boolean;
    isSidechain?: boolean;
    message?: { content?: unknown };
  };
  try {
    e = JSON.parse(line) as typeof e;
  } catch {
    return [];
  }
  if ((e.type !== 'user' && e.type !== 'assistant') || e.isMeta || e.isSidechain) return [];
  const id = e.uuid ?? '';
  const time = e.timestamp ?? '';
  const content = e.message?.content;
  const items: ChatItem[] = [];

  if (e.type === 'user') {
    const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
    const texts: string[] = [];
    for (const [n, b] of (blocks as Record<string, unknown>[]).entries()) {
      if (b.type === 'tool_result') {
        items.push({
          kind: 'result',
          id: `${id}:${n}`,
          toolUseId: str(b.tool_use_id) ?? '',
          ok: b.is_error !== true,
          output: clip(resultText(b.content).trim(), MAX_OUTPUT),
        });
      } else if (b.type === 'text' && typeof b.text === 'string') {
        texts.push(b.text);
      } else if (b.type === 'image') {
        texts.push('[image]');
      }
    }
    const text = texts.join('\n').trim();
    if (text) {
      const tagged = parseTaggedUserText(text);
      if (tagged?.kind === 'command') items.push({ kind: 'command', id, text: tagged.text, time });
      else if (!tagged) items.push({ kind: 'user', id, text: clip(text, MAX_TEXT), time });
    }
    return items;
  }

  const blocks = Array.isArray(content) ? (content as Record<string, unknown>[]) : [];
  for (const [n, b] of blocks.entries()) {
    if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
      items.push({ kind: 'assistant', id: `${id}:${n}`, text: clip(b.text.trim(), MAX_TEXT), time });
    } else if (b.type === 'tool_use') {
      const name = str(b.name) ?? 'Tool';
      items.push({ kind: 'tool', id: `${id}:${n}`, toolUseId: str(b.id) ?? '', name, summary: summarizeToolInput(name, b.input), time });
    }
  }
  return items;
}

/** Where Claude Code keeps a working directory's transcripts. */
export function transcriptDir(cwd: string): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
  return path.join(configDir, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
}

/** The transcript hooks reported, or else the most recently written one for this worktree. */
export function findTranscript(cwd: string, reported: string | undefined): string | null {
  if (reported && fs.existsSync(reported)) return reported;
  const dir = transcriptDir(cwd);
  let newest: { file: string; mtime: number } | null = null;
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(dir, name);
      const mtime = fs.statSync(file).mtimeMs;
      if (!newest || mtime > newest.mtime) newest = { file, mtime };
    }
  } catch {
    return null;
  }
  return newest?.file ?? null;
}

/** The latest title Claude gave the conversation (`ai-title` lines), from the end of the file. */
export function readTitle(file: string | null): string | null {
  if (!file) return null;
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - 256 * 1024);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i]!.includes('"ai-title"')) continue;
      try {
        const title = (JSON.parse(lines[i]!) as { aiTitle?: unknown }).aiTitle;
        if (typeof title === 'string' && title.trim()) return title.trim();
      } catch {
        // a partial first line
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
