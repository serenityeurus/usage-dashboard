// Scans Claude Code JSONL transcripts (one directory per project) and extracts
// two kinds of records in a single pass:
//   - usageRecords: one per unique assistant API message (deduplicated)
//   - webSearchCalls: one per unique OpenClaw web_search tool_use block
//
// Quirks of the transcript format, documented here so nobody rediscovers them:
// - Claude Code writes one JSONL line per *content block* of a streamed
//   assistant message. Every line repeats the same message.id, requestId and
//   identical `usage`. Summing lines naively double/triple counts tokens, so we
//   dedupe on message.id (falling back to requestId).
// - Lines of type "api-request-blob" also embed tool_use blocks (request
//   replays). Only type === "assistant" lines are real model output.
// - model "<synthetic>" marks locally generated messages (errors, interrupts);
//   they are not API calls and carry zero usage. We count them but never price
//   them.
// - Files are append-only while a session is live, so mtime+size is a reliable
//   cache key; a changed key triggers a full re-parse of that one file.

import fs from 'node:fs/promises';
import path from 'node:path';

export const WebSearchToolNames = new Set(['mcp__openclaw__web_search', 'web_search']);

export function parseTranscriptText(fileText, { projectDir, sessionFile }) {
  const usageRecords = [];
  const webSearchCalls = [];
  const seenMessageIds = new Set();
  const seenToolUseIds = new Set();
  let malformedLineCount = 0;
  const sessionIdFromFile = path.basename(sessionFile, '.jsonl');

  for (const rawLine of fileText.split('\n')) {
    if (!rawLine.includes('"assistant"')) continue; // cheap pre-filter
    let entry;
    try {
      entry = JSON.parse(rawLine);
    } catch {
      malformedLineCount += 1; // partially written last line of a live session
      continue;
    }
    if (entry?.type !== 'assistant') continue;
    const message = entry.message;
    if (!message || typeof message !== 'object') continue;

    const sessionId = entry.sessionId || sessionIdFromFile;
    const timestamp = typeof entry.timestamp === 'string' ? entry.timestamp : null;

    const contentBlocks = Array.isArray(message.content) ? message.content : [];
    for (const block of contentBlocks) {
      if (block?.type !== 'tool_use' || !WebSearchToolNames.has(block.name)) continue;
      const toolUseId = block.id || `${message.id}:${contentBlocks.indexOf(block)}`;
      if (seenToolUseIds.has(toolUseId)) continue;
      seenToolUseIds.add(toolUseId);
      webSearchCalls.push({ toolUseId, timestamp, projectDir, sessionId });
    }

    const usage = message.usage;
    if (!usage || typeof usage !== 'object') continue;
    const dedupeKey = message.id || entry.requestId;
    if (!dedupeKey) continue;
    if (seenMessageIds.has(dedupeKey)) continue;
    seenMessageIds.add(dedupeKey);

    const cacheCreationTotal = toCount(usage.cache_creation_input_tokens);
    const cacheCreationSplit = usage.cache_creation && typeof usage.cache_creation === 'object'
      ? {
        ephemeral5m: toCount(usage.cache_creation.ephemeral_5m_input_tokens),
        ephemeral1h: toCount(usage.cache_creation.ephemeral_1h_input_tokens),
      }
      : null;

    usageRecords.push({
      messageId: dedupeKey,
      model: typeof message.model === 'string' ? message.model : 'unknown',
      timestamp,
      projectDir,
      sessionId,
      inputTokens: toCount(usage.input_tokens),
      outputTokens: toCount(usage.output_tokens),
      cacheReadTokens: toCount(usage.cache_read_input_tokens),
      // When the 5m/1h split is missing (older Claude Code versions) all cache
      // writes are treated as 5-minute writes, the cheaper and default TTL.
      cacheWrite5mTokens: cacheCreationSplit ? cacheCreationSplit.ephemeral5m : cacheCreationTotal,
      cacheWrite1hTokens: cacheCreationSplit ? cacheCreationSplit.ephemeral1h : 0,
      serverWebSearchRequests: toCount(usage.server_tool_use?.web_search_requests),
    });
  }

  return { usageRecords, webSearchCalls, malformedLineCount };
}

function toCount(value) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue > 0 ? Math.floor(numberValue) : 0;
}

// Cross-file dedupe: a resumed/forked session can replay earlier assistant
// messages into a new file. Keep the first occurrence of each id.
export function mergeParsedFiles(parsedFiles) {
  const usageById = new Map();
  const searchById = new Map();
  let malformedLineCount = 0;
  for (const parsed of parsedFiles) {
    malformedLineCount += parsed.malformedLineCount;
    for (const record of parsed.usageRecords) {
      if (!usageById.has(record.messageId)) usageById.set(record.messageId, record);
    }
    for (const call of parsed.webSearchCalls) {
      if (!searchById.has(call.toolUseId)) searchById.set(call.toolUseId, call);
    }
  }
  return {
    usageRecords: [...usageById.values()],
    webSearchCalls: [...searchById.values()],
    malformedLineCount,
  };
}

export class TranscriptScanner {
  constructor({ rootDir, fileSystem = fs }) {
    this.rootDir = rootDir;
    this.fileSystem = fileSystem;
    this.fileCache = new Map(); // absolute path -> { cacheKey, parsed }
    this.lastScanStats = null;
  }

  async listTranscriptFiles() {
    let projectEntries;
    try {
      projectEntries = await this.fileSystem.readdir(this.rootDir, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return { files: [], rootMissing: true };
      throw error;
    }
    const files = [];
    for (const projectEntry of projectEntries) {
      if (!projectEntry.isDirectory()) continue;
      const projectPath = path.join(this.rootDir, projectEntry.name);
      let sessionEntries;
      try {
        sessionEntries = await this.fileSystem.readdir(projectPath, { withFileTypes: true });
      } catch {
        continue; // unreadable project dir: skip rather than fail the whole scan
      }
      for (const sessionEntry of sessionEntries) {
        if (sessionEntry.isFile() && sessionEntry.name.endsWith('.jsonl')) {
          files.push({ projectDir: projectEntry.name, filePath: path.join(projectPath, sessionEntry.name) });
        }
      }
    }
    return { files, rootMissing: false };
  }

  // Re-reads only files whose mtime/size changed since the last scan.
  async scan() {
    const startedAt = Date.now();
    const { files, rootMissing } = await this.listTranscriptFiles();
    const livePaths = new Set();
    const parsedFiles = [];
    let reparsedFileCount = 0;
    let unreadableFileCount = 0;
    let totalBytes = 0;

    for (const { projectDir, filePath } of files) {
      livePaths.add(filePath);
      let fileStat;
      try {
        fileStat = await this.fileSystem.stat(filePath);
      } catch {
        unreadableFileCount += 1;
        continue;
      }
      totalBytes += fileStat.size;
      const cacheKey = `${fileStat.mtimeMs}:${fileStat.size}`;
      const cached = this.fileCache.get(filePath);
      if (cached && cached.cacheKey === cacheKey) {
        parsedFiles.push(cached.parsed);
        continue;
      }
      let fileText;
      try {
        fileText = await this.fileSystem.readFile(filePath, 'utf8');
      } catch {
        unreadableFileCount += 1;
        continue;
      }
      const parsed = parseTranscriptText(fileText, { projectDir, sessionFile: filePath });
      this.fileCache.set(filePath, { cacheKey, parsed });
      parsedFiles.push(parsed);
      reparsedFileCount += 1;
    }

    for (const cachedPath of this.fileCache.keys()) {
      if (!livePaths.has(cachedPath)) this.fileCache.delete(cachedPath);
    }

    const merged = mergeParsedFiles(parsedFiles);
    this.lastScanStats = {
      rootMissing,
      fileCount: files.length,
      reparsedFileCount,
      unreadableFileCount,
      totalBytes,
      malformedLineCount: merged.malformedLineCount,
      durationMs: Date.now() - startedAt,
      scannedAt: new Date().toISOString(),
    };
    return { ...merged, stats: this.lastScanStats };
  }
}
