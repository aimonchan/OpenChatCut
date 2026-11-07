// import_timeline: FCPXML / CMX 3600 EDL / CapCut draft → a new editable timeline.
// Parsing lives in timeline-import-fcpxml*.ts, timeline-import-edl.ts and
// timeline-import-capcut.ts, the
// shared lane/track layout in timeline-import-layout.ts, and draft building in
// timeline-import-build.ts. The schema is in schemas/timeline-import-tools.ts.
import type { AgentContext } from '../context';
import type { MediaAsset, TimelineState } from '../../editor/types';
import { makeDraft } from '../../editor/store';
import { readTimelineFileOverHttp } from '../../media/localMediaServerApi';
import { buildImportedTimeline } from './timeline-import-build';
import { parseCapcutDraft } from './timeline-import-capcut';
import { parseEdl } from './timeline-import-edl';
import { parseFcpxml } from './timeline-import-fcpxml';
import type { ParseResult, TimelineImportOptions } from './timeline-import-types';
import type { XmlParserConstructor } from './timeline-import-xml';

export type { ParseResult, TimelineImportOptions } from './timeline-import-types';

type ImportFormat = 'fcpxml' | 'edl' | 'capcut';
export type TimelineFileReader = (path: string) => Promise<{ path: string; content: string }>;

const MAX_CONTENT_CHARS = 2_000_000;
/** A CapCut draft repeats every material's settings, so real drafts run far larger. */
const MAX_CAPCUT_CHARS = 64_000_000;
/** Keep tool results bounded: long timelines can skip hundreds of transitions or titles. */
const MAX_REPORTED = 50;

async function xmlParser(): Promise<XmlParserConstructor> {
  if (typeof globalThis.DOMParser === 'function') {
    return globalThis.DOMParser as unknown as XmlParserConstructor;
  }
  return (await import('@xmldom/xmldom')).DOMParser;
}

export async function parseTimelineImport(
  format: ImportFormat,
  content: string,
  assets: readonly MediaAsset[],
  fallback: TimelineState,
  options: TimelineImportOptions = {},
): Promise<ParseResult> {
  if (!content.trim()) return { ok: false, error: 'content is required' };
  const limit = format === 'capcut' ? MAX_CAPCUT_CHARS : MAX_CONTENT_CHARS;
  if (content.length > limit) return { ok: false, error: `content exceeds ${limit} characters` };
  const Parser = format === 'fcpxml' ? await xmlParser() : null;
  try {
    if (format === 'capcut') return parseCapcutDraft(content, assets, fallback);
    return Parser
      ? parseFcpxml(content, assets, fallback, Parser)
      : parseEdl(content, assets, fallback, options);
  } catch (error) {
    // e.g. a pathologically nested document exhausting the stack.
    const message = error instanceof Error ? error.message : String(error);
    const label = format === 'capcut' ? 'CapCut draft' : Parser ? 'FCPXML' : 'EDL';
    return { ok: false, error: `could not read the ${label}: ${message}` };
  }
}

function importOptions(args: Record<string, unknown>): TimelineImportOptions {
  return {
    ...(typeof args.fps === 'number' ? { fps: args.fps } : {}),
    ...(typeof args.startTimecode === 'string' ? { startTimecode: args.startTimecode } : {}),
  };
}

/** The browser tool: tool dispatch passes extra arguments, so the reader stays out of this signature. */
export function execTimelineImportTool(
  name: string,
  args: Record<string, unknown>,
  ctx: AgentContext,
): Promise<Record<string, unknown>> {
  return runTimelineImport(name, args, ctx, readTimelineFileOverHttp);
}

export async function runTimelineImport(
  name: string,
  args: Record<string, unknown>,
  ctx: AgentContext,
  readFile: TimelineFileReader,
): Promise<Record<string, unknown>> {
  if (name !== 'import_timeline') return { error: `unknown tool ${name}` };
  const format = args.format === 'fcpxml' || args.format === 'edl' || args.format === 'capcut' ? args.format : null;
  if (!format) return { error: 'format must be fcpxml, edl or capcut' };
  const options = importOptions(args);
  const path = typeof args.path === 'string' ? args.path.trim() : '';
  const inline = typeof args.content === 'string' ? args.content : '';
  if (path && inline.trim()) return { error: 'pass either path or content, not both' };
  let content = inline;
  if (path) {
    try {
      content = (await readFile(path)).content;
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }
  const parsed = await parseTimelineImport(
    format,
    content,
    ctx.getDoc().assets,
    ctx.getState(),
    options,
  );
  if (!parsed.ok) {
    return parsed.skipped
      ? { ...parsed, skipped: parsed.skipped.slice(0, MAX_REPORTED), skippedCount: parsed.skipped.length }
      : parsed;
  }
  const report = { warnings: [...parsed.timeline.warnings], skipped: [...parsed.timeline.skipped] };
  const { fps, sourceFps } = parsed.timeline;
  if (sourceFps !== fps) {
    const rate = (value: number) => Number(value.toFixed(3));
    report.warnings.unshift(`the ${rate(sourceFps)} fps ${format === 'edl' ? 'list' : format === 'capcut' ? 'draft' : 'sequence'} was converted to the project frame rate (${rate(fps)} fps); cut points are rounded to the nearest frame`);
  }
  if (format !== 'edl' && (options.fps !== undefined || options.startTimecode !== undefined)) {
    report.warnings.unshift(`fps and startTimecode apply to EDL only; the ${format === 'capcut' ? 'draft' : 'FCPXML sequence format and tcStart'} ${format === 'capcut' ? 'timing was' : 'were'} used`);
  }
  const draft = makeDraft(ctx.getDoc());
  const importedName = typeof args.name === 'string' && args.name.trim() ? args.name.trim() : parsed.timeline.name;
  const previousTimelineId = draft.getDoc().activeTimelineId;
  const built = buildImportedTimeline(draft, parsed.timeline, importedName, report);
  ctx.commands.applyDoc(args.activate === false
    ? { ...built.doc, activeTimelineId: previousTimelineId }
    : built.doc);
  return {
    ok: true,
    format,
    timelineId: built.timelineId,
    name: importedName,
    itemCount: built.itemCount,
    trackCount: built.trackCount,
    fps,
    ...(parsed.timeline.startTimecode ? { startTimecode: parsed.timeline.startTimecode } : {}),
    warnings: report.warnings.slice(0, MAX_REPORTED),
    ...(report.warnings.length > MAX_REPORTED ? { warningCount: report.warnings.length } : {}),
    skipped: report.skipped.slice(0, MAX_REPORTED),
    skippedCount: report.skipped.length,
  };
}
