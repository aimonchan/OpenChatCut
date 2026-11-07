// CapCut draft import: timing, speed, track order, canvas, skipped content,
// missing media, encrypted drafts, and the local path reader's refusal rules.
import assert from 'node:assert/strict';
import { makeDraft } from '../../editor/store';
import type { MediaAsset, TimelineItem } from '../../editor/types';
import { docFromTimeline } from '../../persist/projectStore';
import type { AgentContext } from '../context';
import { parseTimelineImport, runTimelineImport } from './timeline-import-tools';

const SECOND = 1_000_000;

function context(fps = 30) {
  const doc = docFromTimeline({
    fps, width: 1280, height: 720, selectedId: null, trackOrder: ['V1'], tracks: { V1: { kind: 'video' } }, items: [],
  } as never);
  const pool: Array<Pick<MediaAsset, 'id' | 'name' | 'kind'>> = [
    { id: 'a-clip', name: 'outside_1.mp4', kind: 'video' },
    { id: 'a-song', name: 'song.mp3', kind: 'audio' },
    { id: 'a-photo', name: 'photo.png', kind: 'image' },
  ];
  for (const entry of pool) {
    doc.assets.push({ src: `/media/uploads/${entry.id}`, durationInFrames: 60 * fps, ...entry } as MediaAsset);
  }
  const draft = makeDraft(doc);
  const ctx = {
    commands: draft.commands, getState: draft.getState, getDoc: draft.getDoc,
    getCreativeMode: () => null, templates: [], audio: [],
  } as unknown as AgentContext;
  return { draft, ctx };
}

function segment(material: string, start: number, duration: number, sourceStart: number, extra: object = {}) {
  return {
    material_id: material,
    target_timerange: { start: start * SECOND, duration: duration * SECOND },
    source_timerange: { start: sourceStart * SECOND, duration: duration * SECOND },
    ...extra,
  };
}

function capcutDraft(overrides: object = {}) {
  return {
    name: 'Cut from CapCut',
    fps: 30,
    canvas_config: { width: 1080, height: 1920, ratio: '9:16' },
    tracks: [
      { type: 'video', segments: [segment('v1', 0, 4, 2), segment('v2', 4, 2, 10, { speed: 2 })] },
      { type: 'video', segments: [segment('p1', 1, 3, 0)] },
      { type: 'audio', segments: [segment('s1', 0, 6, 5, { volume: 0 })] },
      { type: 'text', segments: [segment('t1', 0, 2, 0)] },
      { type: 'effect', segments: [segment('e1', 0, 2, 0)] },
    ],
    materials: {
      videos: [
        { id: 'v1', path: 'C:\\drafts\\x\\assets\\video\\outside_1.mp4', material_name: 'outside_1.mp4', type: 'video' },
        { id: 'v2', path: '##_draftpath_placeholder_0E685133##/assets/video/outside_1.mp4', type: 'video' },
        { id: 'p1', path: 'D:/stills/photo.png', type: 'photo' },
      ],
      audios: [{ id: 's1', path: 'D:/music/song.mp3', name: 'song.mp3' }],
      texts: [{ id: 't1', content: JSON.stringify({ text: 'Hello from CapCut' }) }],
      transitions: [{ id: 'tr1' }],
      speeds: [],
    },
    ...overrides,
  };
}

async function parse(draft: unknown, ctx: AgentContext) {
  return parseTimelineImport('capcut', JSON.stringify(draft), ctx.getDoc().assets, ctx.getState());
}

{
  const { ctx } = context();
  const parsed = await parse(capcutDraft(), ctx);
  assert.ok(parsed.ok);
  const { timeline } = parsed;
  assert.equal(timeline.name, 'Cut from CapCut');
  assert.deepEqual([timeline.width, timeline.height], [1080, 1920], 'the draft canvas is kept');
  const [first, second, photo, song] = timeline.clips;
  assert.deepEqual(
    [first?.startFrame, first?.durationInFrames, first?.sourceStartFrame, first?.lane],
    [0, 120, 60, 1],
    'microseconds become frames at the source in-point',
  );
  assert.equal(second?.startFrame, 120);
  assert.equal(second?.sourceStartFrame, 300);
  assert.equal(second?.playbackRate, 2, 'a segment speed is kept');
  assert.equal(second?.assetId, 'a-clip', 'a placeholder path still matches by file name');
  assert.equal(photo?.lane, 2, 'a later video track sits above an earlier one');
  assert.equal(photo?.sourceStartFrame, 0, 'a still has no in-point');
  assert.equal(song?.family, 'audio');
  assert.equal(song?.lane, -1);
  assert.equal(song?.muted, true, 'volume 0 mutes the clip');
  const skipped = timeline.skipped.map((entry) => entry.element);
  assert.ok(skipped.includes('text segment'));
  assert.ok(skipped.includes('effect segment'));
  assert.ok(skipped.includes('transitions'));
  assert.equal(timeline.skipped.find((entry) => entry.element === 'text segment')?.name, 'Hello from CapCut');
}

{
  const { ctx } = context();
  const draft = capcutDraft({ fps: 60 });
  draft.materials.speeds = [{ id: 'sp1', speed: 0.5, curve_speed: { id: 'c' } }] as never;
  draft.tracks[0]!.segments[0] = segment('v1', 0, 4, 2, { extra_material_refs: ['sp1'] });
  const parsed = await parse(draft, ctx);
  assert.ok(parsed.ok);
  assert.equal(parsed.timeline.clips[0]?.playbackRate, 0.5, 'speed falls back to the referenced material');
  assert.ok(parsed.timeline.warnings.some((warning) => warning.includes('curve speed')));
  assert.equal(parsed.timeline.sourceFps, 60);
  assert.equal(parsed.timeline.fps, 30, 'clips are counted at the project rate');
}

{
  const { ctx } = context();
  const draft = capcutDraft();
  draft.materials.videos[0]!.path = 'C:/elsewhere/missing.mp4';
  draft.materials.videos[0]!.material_name = 'missing.mp4';
  const parsed = await parse(draft, ctx);
  assert.equal(parsed.ok, false);
  assert.ok(!parsed.ok && parsed.unresolved?.some((entry) => entry.reference.includes('missing.mp4')));
}

{
  const { ctx } = context();
  const encrypted = await parseTimelineImport('capcut', '\u0001AES-binary-payload', ctx.getDoc().assets, ctx.getState());
  assert.ok(!encrypted.ok && encrypted.error.includes('encrypts'), 'an encrypted draft is explained');
  const notDraft = await parse({ hello: 'world' }, ctx);
  assert.ok(!notDraft.ok && notDraft.error.includes('not a CapCut draft'));
  const empty = await parse(capcutDraft({ tracks: [] }), ctx);
  assert.ok(!empty.ok && empty.error.includes('no importable'));
}

{
  const { draft, ctx } = context();
  const reader = async (path: string) => ({ path, content: JSON.stringify(capcutDraft()) });
  const result = await runTimelineImport(
    'import_timeline',
    { format: 'capcut', path: 'C:/drafts/x', name: 'Back from CapCut' },
    ctx,
    reader,
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.name, 'Back from CapCut');
  const state = draft.getState();
  assert.deepEqual([state.width, state.height], [1080, 1920]);
  const media = state.items.filter((item: TimelineItem) => item.kind === 'video');
  assert.equal(media.length, 2);
  assert.equal(media[0]?.srcInFrame, 60);
  assert.equal(media[1]?.startFrame, 120);

  const both = await runTimelineImport('import_timeline', { format: 'capcut', path: 'C:/x', content: '{}' }, ctx, reader);
  assert.match(String(both.error), /either path or content/);
  const failed = await runTimelineImport('import_timeline', { format: 'capcut', path: 'C:/x' }, ctx, async () => {
    throw new Error('outside the import roots');
  });
  assert.equal(failed.error, 'outside the import roots');
  const wrong = await runTimelineImport('import_timeline', { format: 'aaf', content: 'x' }, ctx, reader);
  assert.match(String(wrong.error), /fcpxml, edl or capcut/);
}

console.log('timeline-import-capcut.verify: ok (timing/speed/lanes/canvas/skips/missing media/encryption/path)');
