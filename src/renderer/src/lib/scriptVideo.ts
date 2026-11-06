// Turns a script into a video. The narration is always made on this computer. The picture is either a
// plain colour (exported straight away) or AI footage from a connected service: then the project opens
// in the editor and the generated clips land on the timeline as they finish.

import { pickAspect, pickDuration, planScenes, type AiModel } from '@shared/ai';
import { DEFAULT_TEXT_STYLE, SIZE_PRESETS, SUBTITLE_STYLES } from '@shared/constants';
import { chunkCue, splitSentences } from '@shared/subtitles';
import { snapToFrame } from '@shared/time';
import { canvasTextScale, insertTrack, itemEnd, makeAudioItem, makeTextItem, scaleTextStyle } from '@shared/timeline';
import type { ID, Item, ProjectDoc, ScriptOrigin } from '@shared/types';
import { getAssets } from '@/store/library';
import { navigate } from '@/store/ui';
import { api } from './api';
import { startRender } from './exporter';
import { fontsReady } from './fonts';
import { textHeight } from './textRender';
import { updateProjectThumb } from './thumbnail';

const MUSIC_VOLUME = 0.14;
/** Roughly how long each generated scene should run. */
const SCENE_SECONDS = 5.5;

function titleFor(origin: ScriptOrigin): string {
  const source = origin.mode === 'topic' && origin.topic.trim() ? origin.topic : origin.script;
  const first = source.replace(/\s+/g, ' ').trim();
  return first.length > 48 ? `${first.slice(0, 47).trim()}…` : first || 'Narrated video';
}

interface Layout {
  doc: ProjectDoc;
  /** The empty track for generated footage, when the video uses AI visuals. */
  visualTrack: ID | null;
}

/** Lays the voice, subtitles and music out on a new project document. */
function buildDocument(
  base: ProjectDoc,
  origin: ScriptOrigin,
  voice: Item,
  sentences: string[],
  timings: { start: number; end: number }[],
): Layout {
  const { settings } = origin;
  const preset = SIZE_PRESETS.find((p) => p.id === settings.aspect) ?? SIZE_PRESETS[0];
  let doc: ProjectDoc = {
    ...base,
    settings: { ...base.settings, width: preset.width, height: preset.height, autoSize: false, background: settings.background },
  };
  const items: Item[] = [voice];
  const fps = doc.settings.fps;
  const plain = settings.visuals === 'background';

  const made = insertTrack(doc, 0);
  doc = made.doc;
  let visualTrack: ID | null = null;
  if (!plain) {
    const under = insertTrack(doc, 1);
    doc = under.doc;
    visualTrack = under.trackId;
  }

  const look = SUBTITLE_STYLES.find((s) => s.id === settings.subtitleStyle) ?? SUBTITLE_STYLES[0];
  // With no footage behind them, the subtitles are the picture, so they sit larger and in the middle.
  const size = (look.style.fontSize ?? 54) * (plain ? 1.35 : 1);
  const style = scaleTextStyle({ ...DEFAULT_TEXT_STYLE, ...look.style, fontSize: size }, canvasTextScale(doc));
  const boxWidth = doc.settings.width * 0.84;
  const cues = sentences.flatMap((s, i) => chunkCue(s, timings[i].start, timings[i].end, 44));
  cues.forEach((cue, i) => {
    const start = snapToFrame(cue.start, fps);
    // Each cue stays up until the next one takes over, so the frame is never empty between sentences.
    const end = i + 1 < cues.length ? snapToFrame(cues[i + 1].start, fps) : snapToFrame(cue.end, fps);
    if (end - start < 1 / fps) return;
    const h = textHeight(cue.text, style, boxWidth);
    items.push({
      ...makeTextItem(doc, made.trackId, start, cue.text, {}, { duration: end - start, subtitle: true }),
      style,
      w: boxWidth,
      h,
      x: (doc.settings.width - boxWidth) / 2,
      y: plain ? (doc.settings.height - h) / 2 : doc.settings.height * 0.9 - h,
    });
  });

  const music = settings.musicAssetId ? getAssets()[settings.musicAssetId] : undefined;
  if (music) {
    const below = insertTrack(doc, doc.tracks.length);
    doc = below.doc;
    const total = itemEnd(voice);
    // Short music loops until the voice is done.
    for (let t = 0; t < total - 0.05; t += music.duration) {
      items.push({
        ...makeAudioItem(music, below.trackId, t),
        duration: Math.min(music.duration, total - t),
        volume: MUSIC_VOLUME,
        fadeAudio: t + music.duration >= total || t === 0,
      });
    }
  }
  return { doc: { ...doc, items }, visualTrack };
}

async function chosenModel(origin: ScriptOrigin): Promise<AiModel> {
  const task = origin.settings.visuals === 'talking-character' ? 'talking-photo' : 'text-to-video';
  const models = await api.ai.models(task);
  const model = models.find((m) => m.key === origin.settings.visualModelKey) ?? models[0];
  if (!model) throw new Error('None of your connected AI services offers this. Connect one under AI connections.');
  return model;
}

/** How many clips a script will need, for telling the user before anything is spent. */
export function sceneCount(script: string, wordsPerSecond = 2.4): number {
  const sentences = splitSentences(script);
  const timings: { start: number; end: number }[] = [];
  let cursor = 0;
  for (const s of sentences) {
    const seconds = s.split(/\s+/).length / wordsPerSecond;
    timings.push({ start: cursor, end: cursor + seconds });
    cursor += seconds + 0.3;
  }
  return planScenes(timings, SCENE_SECONDS).length;
}

async function startScenes(origin: ScriptOrigin, doc: ProjectDoc, projectId: ID, trackId: ID, sentences: string[], timings: { start: number; end: number }[], onStage: (text: string) => void): Promise<void> {
  const model = await chosenModel(origin);
  const scenes = planScenes(timings, SCENE_SECONDS);
  const narration = scenes.map((s) => s.sentences.map((i) => sentences[i]).join(' '));
  onStage('Planning the shots…');
  const written = await api.ai.writeScenePrompts({ scenes: narration, topic: origin.topic });
  const prompts = written ?? narration.map((text) => `Cinematic, realistic shot that illustrates this: ${text}`);
  onStage('Sending scenes to be generated…');
  const { width, height } = doc.settings;
  for (let i = 0; i < scenes.length; i++) {
    const length = scenes[i].end - scenes[i].start;
    await api.ai.generate({
      modelKey: model.key,
      choices: { prompt: prompts[i], duration: pickDuration(model.duration, length), aspect: pickAspect(model.aspect, width, height), sound: false },
      target: { scope: 'project', projectId },
      placement: { kind: 'scene', trackId, start: scenes[i].start, duration: length, muted: true },
      name: `Scene ${i + 1}`,
    });
  }
}

async function startTalkingCharacter(origin: ScriptOrigin, projectId: ID, trackId: ID, photoId: ID, voiceId: ID, seconds: number): Promise<void> {
  const model = await chosenModel(origin);
  await api.ai.generate({
    modelKey: model.key,
    choices: { resolution: model.resolution?.values?.includes('720p') ? '720p' : undefined },
    image: { assetId: photoId },
    audio: { assetId: voiceId },
    target: { scope: 'project', projectId },
    // The narration stays on its own track, so the voice can still be edited; the clip's copy stays silent.
    placement: { kind: 'scene', trackId, start: 0, duration: seconds, muted: true },
    name: 'Talking character',
  });
}

/**
 * Builds the project. With a plain background it also starts the export and opens the video page.
 * With AI visuals it starts the generations and opens the editor. `onStage` reports what is happening.
 */
export async function generateScriptVideo(origin: ScriptOrigin, onStage: (text: string) => void, photoId?: ID | null): Promise<void> {
  const sentences = splitSentences(origin.script);
  if (!sentences.length) throw new Error('The script is empty.');
  if (origin.settings.visuals === 'talking-character' && !photoId) throw new Error('Choose a photo of the character first.');
  const name = titleFor(origin);
  const meta = await api.library.createProject({ name, scriptOrigin: origin });
  try {
    onStage('Recording the voice-over…');
    const { asset, timings } = await api.voice.speak({
      sentences,
      voice: origin.settings.voice,
      rate: origin.settings.rate,
      name: `${name} voice-over`,
      target: { scope: 'project', projectId: meta.id },
    });
    onStage('Building the video…');
    await fontsReady();
    const base = await api.library.loadProject(meta.id);
    const voice = makeAudioItem(asset, base.tracks[0].id, 0);
    const { doc, visualTrack } = buildDocument(base, origin, voice, sentences, timings);
    await api.library.saveProject(doc);

    if (visualTrack) {
      if (origin.settings.visuals === 'talking-character') await startTalkingCharacter(origin, meta.id, visualTrack, photoId!, asset.id, asset.duration);
      else await startScenes(origin, doc, meta.id, visualTrack, sentences, timings, onStage);
      await navigate({ page: 'editor', projectId: meta.id, showAi: true });
      return;
    }

    await updateProjectThumb(doc);
    onStage('Starting the export…');
    await startRender(doc, { kind: 'export' });
    await navigate({ page: 'video', projectId: meta.id });
  } catch (err) {
    await api.library.deleteProjectsForever([meta.id]).catch(() => undefined);
    throw err;
  }
}
