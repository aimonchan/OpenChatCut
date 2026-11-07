// Runnable contract check: `npx tsx src/agent/tools/captions-import-srt.verify.ts`.
// edit_captions action=import_srt: inline SRT → editable manual caption track,
// new track by default, replace when captionTrackId is given, clear errors otherwise.
import assert from 'node:assert/strict';
import { makeDraft } from '../../editor/store';
import { captionsOnTrack, defaultTrackId, type TimelineState } from '../../editor/types';
import { docFromTimeline } from '../../persist/projectStore';
import type { AgentContext } from '../context';
import { execCaptionsTool } from './captions-tools';

const SRT = [
  '1',
  '00:00:00,000 --> 00:00:00,611',
  'Decoration ပြင်မယ့်',
  '',
  '2',
  '00:00:00,611 --> 00:00:01,271',
  'အိမ်ရှင်တွေအနေနဲ့',
  '',
  '3',
  '00:00:01,271 --> 00:00:02,072',
  '<i>Lighting</i> &amp; Light',
  '',
].join('\r\n');

const state: TimelineState = {
  fps: 30, width: 1080, height: 1920, selectedId: null,
  items: [{ id: 'vo', track: 'A1', startFrame: 0, durationInFrames: 90, name: 'vo', kind: 'audio', src: '/vo.mp3' }],
};
const draft = makeDraft(docFromTimeline(state));
const ctx: AgentContext = {
  commands: draft.commands, getState: draft.getState, getDoc: draft.getDoc,
  getCreativeMode: () => null, templates: [], audio: [],
};

type ImportResult = {
  ok?: boolean; error?: string; captionTrackId: string; id: string; replaced: boolean; cues: number;
  firstCue: { text: string; startMs: number }; lastCue: { text: string; endMs: number; endFrame: number };
};

// 1) new caption track from inline SRT, with captions off and no transcript anywhere
const r1 = await execCaptionsTool('edit_captions', {
  action: 'import_srt', json: JSON.stringify({ content: SRT, name: 'oct_3' }),
}, ctx) as ImportResult;
assert.equal(r1.ok, true, `import_srt ok: ${JSON.stringify(r1)}`);
assert.equal(r1.cues, 3);
assert.equal(r1.replaced, false);
assert.equal(r1.firstCue.text, 'Decoration ပြင်မယ့်', 'Burmese text survives untouched');
assert.equal(r1.lastCue.text, 'Lighting & Light', 'tags stripped, entities decoded');
assert.equal(r1.lastCue.endMs, 2072);
assert.equal(r1.lastCue.endFrame, 63);
const s1 = draft.getState();
assert.equal(defaultTrackId(s1, 'caption'), r1.id, 'new caption track exists');
const c1 = captionsOnTrack(s1, r1.id);
assert.ok(c1?.enabled, 'captions enabled on the new track');
const lane = c1!.sourceEntries!.find((entry) => Array.isArray(entry.words))!;
assert.equal(lane.label, 'oct_3');
assert.equal(lane.words!.length, 3);
assert.ok(lane.words!.every((word) => typeof word.id === 'string' && word.id.length > 0), 'cues carry stable ids');

// 2) the imported track reads back and accepts style by its returned alias
const read = await execCaptionsTool('read_captions', { captionTrackId: r1.captionTrackId }, ctx) as {
  pages: { words: { text: string }[] }[];
};
const texts = read.pages.flatMap((page) => page.words.map((word) => word.text)).join(' ');
assert.ok(texts.includes('အိမ်ရှင်တွေအနေနဲ့'), `read_captions returns imported text: ${texts}`);
const styled = await execCaptionsTool('edit_captions', {
  action: 'style', captionTrackId: r1.captionTrackId, json: JSON.stringify({ fontFamily: 'Pyidaungsu', sizePx: 68 }),
}, ctx) as { ok?: boolean };
assert.equal(styled.ok, true, 'style applies to the imported track');

// 3) captionTrackId → replace that track's captions instead of adding a track
const r2 = await execCaptionsTool('edit_captions', {
  action: 'import_srt', captionTrackId: r1.captionTrackId,
  json: { content: '1\n00:00:05,000 --> 00:00:06,500\nreplaced\n' },
}, ctx) as ImportResult;
assert.equal(r2.ok, true);
assert.equal(r2.replaced, true);
assert.equal(r2.id, r1.id, 'same track');
const c2 = captionsOnTrack(draft.getState(), r1.id)!;
const words2 = c2.sourceEntries!.flatMap((entry) => entry.words ?? []);
assert.deepEqual(words2.map((word) => word.text), ['replaced']);
assert.equal(c2.sourceEntries![0]!.label, 'Imported SRT', 'default lane name');

// 4) errors: no content, garbage, unknown track
const e1 = await execCaptionsTool('edit_captions', { action: 'import_srt', json: '{}' }, ctx) as ImportResult;
assert.match(e1.error ?? '', /needs json \{content/);
const e2 = await execCaptionsTool('edit_captions', {
  action: 'import_srt', json: { content: 'not an srt file' },
}, ctx) as ImportResult;
assert.match(e2.error ?? '', /no valid SRT cues/);
const e3 = await execCaptionsTool('edit_captions', {
  action: 'import_srt', captionTrackId: 'C9', json: { content: SRT },
}, ctx) as ImportResult;
assert.match(e3.error ?? '', /no caption track C9/);

console.log('captions-import-srt.verify: ok');
