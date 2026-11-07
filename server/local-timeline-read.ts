// Reads a local interchange timeline for import_timeline, so a large CapCut
// draft never has to pass through a model as tool text. Access follows the same
// AGENT_IMPORT_ROOTS rule as local media import.
import { readFile, stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { resolveAgentMediaPath } from './local-path-import.ts';

export const MAX_TIMELINE_FILE_BYTES = 64 * 1024 * 1024;

/** Files that hold the timeline when the path is a draft folder or .fcpxmld bundle. */
const FOLDER_ENTRIES = ['draft_content.json', 'draft_info.json', 'Info.fcpxml'];
const INTERCHANGE_EXTENSIONS = new Set(['.fcpxml', '.xml', '.edl']);

function readable(file: string): boolean {
  const name = basename(file).toLowerCase();
  return INTERCHANGE_EXTENSIONS.has(extname(name)) || /^draft_[a-z_]*\.json$/.test(name);
}

async function timelineFile(path: string): Promise<string> {
  const info = await stat(path);
  if (!info.isDirectory()) return path;
  for (const entry of FOLDER_ENTRIES) {
    const candidate = join(path, entry);
    const found = await stat(candidate).catch(() => null);
    if (found?.isFile()) return candidate;
  }
  throw new Error(`no timeline file in ${path}: expected ${FOLDER_ENTRIES.join(', ')}`);
}

export async function readLocalTimelineFile(path: string): Promise<{ path: string; content: string }> {
  const file = await timelineFile(await resolveAgentMediaPath(path));
  if (!readable(file)) {
    throw new Error('only .fcpxml, .xml, .edl and CapCut draft_*.json files can be read as timelines');
  }
  const { size } = await stat(file);
  if (size > MAX_TIMELINE_FILE_BYTES) {
    throw new Error(`timeline file is larger than ${MAX_TIMELINE_FILE_BYTES} bytes`);
  }
  return { path: file, content: await readFile(file, 'utf8') };
}
