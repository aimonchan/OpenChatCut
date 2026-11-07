// CapCut / JianYing draft import: reads a draft's plain-JSON timeline into the
// shared parsed-timeline shape. Times in a draft are microseconds, tracks are
// listed bottom to top, and every segment points at a material by id.
//
// JianYing 6+ encrypts draft_content.json. Decrypting it is out of scope, so a
// payload that is not JSON is refused with an explanation.
import type { MediaAsset, TimelineState } from '../../editor/types';
import { isStillAsset, isTimelineAsset, resolveAsset } from './timeline-import-media';
import {
  describeSource,
  newReport,
  type ImportReport,
  type ParsedClip,
  type ParseResult,
  type UnresolvedReference,
} from './timeline-import-types';

const MICROS_PER_SECOND = 1_000_000;
const MIN_RATE = 0.1;
const MAX_RATE = 8;
/** Longest text kept in a skip report. */
const SKIPPED_TEXT_CHARS = 60;
/** Mapped from a draft track's type to why its segments are not imported. */
const UNSUPPORTED_TRACKS: Readonly<Record<string, string>> = {
  text: 'CapCut text is not imported',
  subtitle: 'CapCut subtitles are not imported',
  sticker: 'CapCut stickers are not imported',
  effect: 'CapCut effects are not imported',
  filter: 'CapCut filters are not imported',
  adjust: 'CapCut adjustment layers are not imported',
};

type Json = Record<string, unknown>;

interface Range {
  start: number;
  duration: number;
}

interface ParseState {
  fps: number;
  assets: readonly MediaAsset[];
  videos: Map<string, Json>;
  audios: Map<string, Json>;
  speeds: Map<string, Json>;
  report: ImportReport;
  unresolved: Map<string, UnresolvedReference>;
  clips: ParsedClip[];
}

function isObject(value: unknown): value is Json {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function list(value: unknown): Json[] {
  return Array.isArray(value) ? value.filter(isObject) : [];
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function positive(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function byId(entries: unknown): Map<string, Json> {
  return new Map(list(entries).map((entry) => [text(entry.id), entry]));
}

function range(value: unknown): Range | null {
  if (!isObject(value)) return null;
  const { start, duration } = value;
  if (typeof start !== 'number' || typeof duration !== 'number') return null;
  if (!Number.isFinite(start) || !Number.isFinite(duration) || start < 0 || duration <= 0) return null;
  return { start, duration };
}

function toFrames(micros: number, fps: number): number {
  return Math.round((micros * fps) / MICROS_PER_SECOND);
}

function timecodeLabel(micros: number): string {
  return `${(micros / MICROS_PER_SECOND).toFixed(3)}s`;
}

/** A segment's speed: its own field, else the speed material it references. */
function segmentSpeed(segment: Json, speeds: ReadonlyMap<string, Json>): { rate: number; curved: boolean } {
  const refs = Array.isArray(segment.extra_material_refs) ? segment.extra_material_refs : [];
  const material = refs.map((ref) => speeds.get(text(ref))).find(Boolean);
  const curved = Boolean(material?.curve_speed);
  return { rate: positive(segment.speed) ?? positive(material?.speed) ?? 1, curved };
}

function hasTransform(segment: Json): boolean {
  const clip = segment.clip;
  if (!isObject(clip)) return false;
  const scale = isObject(clip.scale) ? clip.scale : {};
  const transform = isObject(clip.transform) ? clip.transform : {};
  const scaled = [scale.x, scale.y].some((value) => typeof value === 'number' && value !== 1);
  const moved = [transform.x, transform.y].some((value) => typeof value === 'number' && value !== 0);
  const turned = typeof clip.rotation === 'number' && clip.rotation !== 0;
  return scaled || moved || turned;
}

/** A draft's text material stores JSON whose `text` field is the visible words. */
function textMaterialLabel(material: Json | undefined): string {
  const raw = text(material?.content);
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isObject(parsed) && typeof parsed.text === 'string') return parsed.text.slice(0, SKIPPED_TEXT_CHARS);
  } catch {
    // Older drafts store the words directly.
  }
  return raw.slice(0, SKIPPED_TEXT_CHARS);
}

function materialReferences(material: Json): string[] {
  return [material.path, material.file_Path, material.material_name, material.name]
    .map(text)
    .filter(Boolean);
}

function placeSegment(
  state: ParseState,
  family: ParsedClip['family'],
  lane: number,
  segment: Json,
): void {
  const { fps, report } = state;
  const materialId = text(segment.material_id);
  const material = (family === 'video' ? state.videos : state.audios).get(materialId);
  const target = range(segment.target_timerange);
  const at = target ? timecodeLabel(target.start) : '';
  const skip = (name: string, reason: string) => {
    report.skipped.push({ element: `${family} segment`, name, ...(at ? { at } : {}), reason });
  };
  if (!material) return skip(materialId, 'its material is missing from the draft');
  const name = text(material.material_name) || text(material.name) || materialId;
  if (!target) return skip(name, 'its timeline range is invalid');
  if (segment.visible === false) return skip(name, 'the segment is hidden in the draft');
  const references = materialReferences(material);
  const asset = resolveAsset(state.assets, references);
  if ('reason' in asset) {
    const reference = references[0] ?? name;
    state.unresolved.set(reference, { reference, reason: asset.reason });
    return;
  }
  if (!isTimelineAsset(asset)) return skip(name, `${asset.kind} assets cannot sit on a timeline`);
  if (family === 'audio' && asset.kind !== 'audio' && asset.kind !== 'video') {
    return skip(name, `audio segment references ${asset.kind} ${asset.name}`);
  }
  if (family === 'video' && asset.kind === 'audio') {
    return skip(name, `video segment references audio-only ${asset.name}`);
  }
  const startFrame = toFrames(target.start, fps);
  const durationInFrames = toFrames(target.start + target.duration, fps) - startFrame;
  if (durationInFrames <= 0) return skip(name, 'the segment is shorter than one frame');
  const from = { element: `${family} segment`, name, at };
  const still = isStillAsset(asset);
  const speed = segmentSpeed(segment, state.speeds);
  if (speed.curved) report.warnings.push(`${describeSource(from)}: curve speed was flattened to ${speed.rate}x`);
  const rate = still ? 1 : Math.min(MAX_RATE, Math.max(MIN_RATE, speed.rate));
  if (!still && rate !== speed.rate) {
    report.warnings.push(`${describeSource(from)}: speed ${Number(speed.rate.toFixed(3))}x clamped to ${rate}x`);
  }
  const source = range(segment.source_timerange);
  state.clips.push({
    name,
    assetId: asset.id,
    family,
    lane,
    startFrame,
    durationInFrames,
    sourceStartFrame: still || !source ? 0 : toFrames(source.start, fps),
    ...(rate !== 1 ? { playbackRate: rate } : {}),
    ...(segment.volume === 0 ? { muted: true } : {}),
    ...(family === 'audio' && asset.kind === 'video' ? { audioOfVideo: true } : {}),
    from,
  });
}

function skipTrack(report: ImportReport, type: string, track: Json, materials: Json): void {
  const reason = UNSUPPORTED_TRACKS[type] ?? `CapCut ${type || 'unknown'} tracks are not imported`;
  const texts = byId(materials.texts);
  for (const segment of list(track.segments)) {
    const target = range(segment.target_timerange);
    const label = type === 'text' || type === 'subtitle'
      ? textMaterialLabel(texts.get(text(segment.material_id)))
      : '';
    report.skipped.push({
      element: `${type || 'unknown'} segment`,
      ...(label ? { name: label } : {}),
      ...(target ? { at: timecodeLabel(target.start) } : {}),
      reason,
    });
  }
}

function reportDroppedLooks(report: ImportReport, segments: readonly Json[], materials: Json): void {
  const transitions = list(materials.transitions).length;
  if (transitions) {
    report.skipped.push({ element: 'transitions', name: `${transitions} in draft`, reason: 'CapCut transitions are not imported' });
  }
  const transformed = segments.filter(hasTransform).length;
  if (transformed) report.warnings.push(`${transformed} segment(s) use position, scale or rotation, which are not imported`);
  const keyframed = segments.filter((segment) => list(segment.common_keyframes).length > 0).length;
  if (keyframed) report.warnings.push(`${keyframed} segment(s) use keyframes, which are not imported`);
}

export function parseCapcutDraft(
  content: string,
  assets: readonly MediaAsset[],
  fallback: TimelineState,
): ParseResult {
  let draft: unknown;
  try {
    draft = JSON.parse(content.replace(/^﻿/, ''));
  } catch {
    return {
      ok: false,
      error: 'the draft is not plain JSON. JianYing 6+ encrypts draft_content.json and OpenChatCut cannot read those drafts',
    };
  }
  if (!isObject(draft) || !Array.isArray(draft.tracks) || !isObject(draft.materials)) {
    return { ok: false, error: 'this JSON is not a CapCut draft: it has no tracks and materials' };
  }
  const materials = draft.materials;
  const canvas = isObject(draft.canvas_config) ? draft.canvas_config : {};
  const state: ParseState = {
    fps: fallback.fps,
    assets,
    videos: byId(materials.videos),
    audios: byId(materials.audios),
    speeds: byId(materials.speeds),
    report: newReport(),
    unresolved: new Map(),
    clips: [],
  };
  const tracks = list(draft.tracks);
  let videoLane = 0;
  let audioLane = 0;
  for (const track of tracks) {
    const type = text(track.type);
    if (type === 'video') {
      videoLane += 1;
      for (const segment of list(track.segments)) placeSegment(state, 'video', videoLane, segment);
    } else if (type === 'audio') {
      audioLane -= 1;
      for (const segment of list(track.segments)) placeSegment(state, 'audio', audioLane, segment);
    } else {
      skipTrack(state.report, type, track, materials);
    }
  }
  const media = tracks
    .filter((track) => track.type === 'video' || track.type === 'audio')
    .flatMap((track) => list(track.segments));
  reportDroppedLooks(state.report, media, materials);
  if (state.unresolved.size) {
    return {
      ok: false,
      error: 'CapCut draft media references are unresolved: import those files into the media pool first',
      unresolved: [...state.unresolved.values()],
    };
  }
  if (!state.clips.length) {
    return { ok: false, error: 'the draft has no importable video or audio clips', skipped: state.report.skipped };
  }
  return {
    ok: true,
    timeline: {
      name: text(draft.name) || 'CapCut draft',
      fps: fallback.fps,
      sourceFps: positive(draft.fps) ?? fallback.fps,
      width: positive(canvas.width) ?? fallback.width,
      height: positive(canvas.height) ?? fallback.height,
      clips: state.clips,
      warnings: state.report.warnings,
      skipped: state.report.skipped,
    },
  };
}
