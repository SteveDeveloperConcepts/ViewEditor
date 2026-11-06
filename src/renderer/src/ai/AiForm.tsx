// One form for every kind of generation. What it shows comes from the chosen model: a model without a
// duration setting shows none, and a model that offers 4, 6 and 8 seconds offers exactly those.

import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { CircleAlert, RefreshCw, Sparkles, Upload } from 'lucide-react';
import {
  aspectLabel,
  durationChoices,
  durationLabel,
  durationSeconds,
  missingInput,
  pickAspect,
  pickDuration,
  recommendedModels,
  totalPrice,
  type AiChoices,
  type AiMediaRef,
  type AiModel,
  type AiOption,
  type AiPlacement,
  type AiRequest,
  type AiTask,
  type AiValue,
} from '@shared/ai';
import { formatTimecode } from '@shared/time';
import type { Asset, AssetKind, ID } from '@shared/types';
import { Button, Field, FieldRow, IconButton, Notice, Segmented, Spinner, Switch, TimeInput } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { trackPointer } from '@/lib/drag';
import { assetUrl } from '@/lib/media';
import { reportRejected } from '@/editor/importing';
import { loadModels, useAi, useConnected, useModels } from '@/store/ai';
import { useLibrary } from '@/store/library';
import { openConnections } from './ConnectionsDialog';
import { formDraft, saveFormDraft, type SoundMode } from './drafts';

const LAST_MODEL = 'vieweditor.ai.model.';

function rememberedModel(task: AiTask): string | null {
  try {
    return localStorage.getItem(LAST_MODEL + task);
  } catch {
    return null;
  }
}

function rememberModel(task: AiTask, key: string): void {
  try {
    localStorage.setItem(LAST_MODEL + task, key);
  } catch {
    // Forgetting which model was last used does no harm.
  }
}

/** Keeps the choice, or falls back to the model's default, when moving between models. */
function chooseFrom(option: AiOption | null, current: AiValue | undefined): AiValue | undefined {
  if (!option) return undefined;
  if (current !== undefined && (!option.values || option.values.includes(current))) return current;
  return option.default ?? option.values?.[0] ?? undefined;
}

/** The length to start from: the closest this model can do to what was asked for, or else what was chosen already, or its default. */
function lengthFor(model: AiModel, previous: AiChoices, seconds: number | null | undefined): AiValue | undefined {
  const option = model.duration;
  if (!option) return undefined;
  if (typeof seconds === 'number') return pickDuration(option, seconds);
  if (previous.duration !== undefined && (!option.values || option.values.includes(previous.duration))) return previous.duration;
  return chooseFrom(option, undefined) ?? pickDuration(option, typeof previous.duration === 'number' ? previous.duration : 5);
}

function initialChoices(model: AiModel, width: number, height: number, previous: AiChoices, seconds: number | null | undefined, shapePicked: boolean): AiChoices {
  const keepShape = shapePicked && previous.aspect !== undefined && model.aspect?.values?.includes(previous.aspect);
  return {
    prompt: previous.prompt,
    duration: lengthFor(model, previous, seconds),
    aspect: keepShape ? previous.aspect : model.aspect ? pickAspect(model.aspect, width, height) : undefined,
    resolution: chooseFrom(model.resolution, previous.resolution),
    sound: model.sound ? (previous.sound ?? model.sound.default) : undefined,
  };
}

/** Which part of a file's sound to use. */
function SoundRange({ asset, value, onChange }: { asset: Asset; value: AiMediaRef; onChange: (ref: AiMediaRef) => void }): ReactNode {
  const start = value.start ?? 0;
  const end = value.end ?? asset.duration;
  return (
    <div className="form-grid">
      <label className="field">
        <span className="label">Use from</span>
        <TimeInput label="Use the sound from" value={start} onCommit={(t) => onChange({ ...value, start: Math.max(0, Math.min(t, end - 0.1)) })} />
      </label>
      <label className="field">
        <span className="label">To</span>
        <TimeInput label="Use the sound up to" value={end} onCommit={(t) => onChange({ ...value, end: Math.min(asset.duration, Math.max(t, start + 0.1)) })} />
      </label>
    </div>
  );
}

/** Sound of a set length: a window to drag along the waveform, as wide as the clip it goes with. */
function SoundWindow({ asset, value, seconds, onChange }: { asset: Asset; value: AiMediaRef; seconds: number; onChange: (ref: AiMediaRef) => void }): ReactNode {
  const bar = useRef<HTMLDivElement>(null);
  const length = Math.min(seconds, asset.duration);
  const latest = Math.max(0, asset.duration - length);
  const start = Math.min(value.start ?? 0, latest);
  const move = (t: number): void => onChange({ ...value, start: Math.max(0, Math.min(t, latest)) });
  const onDown = (e: ReactPointerEvent): void => {
    e.preventDefault();
    const x = e.clientX;
    const scale = asset.duration / (bar.current?.clientWidth || 1);
    trackPointer(
      (ev) => move(start + (ev.clientX - x) * scale),
      () => undefined,
    );
  };
  return (
    <>
      <div ref={bar} className="sound-window" style={{ backgroundImage: asset.hasWave ? `url("${assetUrl(asset, 'wave')}")` : undefined }}>
        <div className="sound-window-pick" style={{ left: `${(start / asset.duration) * 100}%`, width: `${(length / asset.duration) * 100}%` }} onPointerDown={onDown} />
      </div>
      <label className="field">
        <span className="label">Sound starts at</span>
        <TimeInput label="Sound starts at" value={start} onCommit={move} />
      </label>
      <span className="hint tabular">
        Using {formatTimecode(start)} to {formatTimecode(start + length)}. Drag the window to choose.
        {length < seconds ? ' This sound is shorter than the clip.' : ''}
      </span>
    </>
  );
}

function MediaPick(props: { kind: AssetKind; label: string; value: AiMediaRef | null; projectId: ID | null; seconds?: number | null; onChange: (ref: AiMediaRef | null) => void }): ReactNode {
  const { kind, label, value, projectId, seconds, onChange } = props;
  const assets = useLibrary((s) => s.lib?.assets);
  const [error, setError] = useState('');
  // Sound can come from an audio file or from a video.
  const sound = kind === 'audio';
  const options = (assets ?? []).filter((a) => (sound ? a.hasAudio : a.kind === kind)).reverse();
  const chosen = options.find((a) => a.id === value?.assetId);

  const upload = async (): Promise<void> => {
    setError('');
    try {
      const target = projectId ? ({ scope: 'project', projectId } as const) : ({ scope: 'workspace' } as const);
      const result = await api.assets.pickAndImport(sound ? 'sound' : kind, target);
      if (!result) return;
      reportRejected(result);
      const added = result.assets[0];
      if (added && sound && !added.hasAudio) setError(`${added.name} has no sound.`);
      else if (added) onChange({ assetId: added.id });
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <div className="field">
      <span className="label">{label}</span>
      <div className="row">
        <select className="select" aria-label={label} value={value?.assetId ?? ''} onChange={(e) => onChange(e.target.value ? { assetId: e.target.value } : null)}>
          <option value="">{sound ? 'Choose audio or a video…' : 'Choose…'}</option>
          {options.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <IconButton label={`Add ${kind === 'image' ? 'an image' : kind} from your computer`} onClick={() => void upload()}>
          <Upload size={15} />
        </IconButton>
      </div>
      {sound && value && chosen && (seconds ? <SoundWindow asset={chosen} value={value} seconds={seconds} onChange={onChange} /> : <SoundRange asset={chosen} value={value} onChange={onChange} />)}
      {error && <span className="hint">{error}</span>}
    </div>
  );
}

export interface AiFormProps {
  task: AiTask;
  /** Media decided by the caller, such as the selected clip. Without it the form asks. */
  image?: AiMediaRef | null;
  video?: AiMediaRef | null;
  audio?: AiMediaRef | null;
  projectId: ID | null;
  /** Where the result goes. A function is asked when Generate is pressed, so it can read the playhead then. */
  placement: AiPlacement | (() => AiPlacement);
  /** Further fields, shown above the note. */
  extra?: ReactNode;
  /** The frame the result should suit. */
  width: number;
  height: number;
  /** The length to aim for, such as that of the clip being edited. */
  seconds?: number;
  /** Keeps what was entered for as long as the project is open. Forms that come and go should have one. */
  draftKey?: string;
  /** The result lands as a clip of its own, so it can be given sound from Media. */
  newClip?: boolean;
  promptLabel?: string;
  promptPlaceholder?: string;
  submitLabel?: string;
  /** A sentence saying what will be sent, shown above the button. */
  note?: ReactNode;
  onSubmitted?: () => void;
}

export function AiForm(props: AiFormProps): ReactNode {
  const { task, projectId, placement, width, height, seconds, draftKey, promptLabel = 'Prompt', promptPlaceholder, submitLabel = 'Generate', note, onSubmitted } = props;
  const models = useModels(task);
  const providers = useAi((s) => s.providers);
  const connected = useConnected();
  const [draft] = useState(() => formDraft(draftKey));
  const [modelKey, setModelKey] = useState<string | null>(() => rememberedModel(task));
  const [choices, setChoices] = useState<AiChoices>(draft?.choices ?? {});
  const [shapePicked, setShapePicked] = useState(draft?.shapePicked ?? false);
  const [image, setImage] = useState<AiMediaRef | null>(props.image ?? draft?.image ?? null);
  const [video, setVideo] = useState<AiMediaRef | null>(props.video ?? draft?.video ?? null);
  const [audio, setAudio] = useState<AiMediaRef | null>(props.audio ?? draft?.audio ?? null);
  const [soundMode, setSoundMode] = useState<SoundMode>(draft?.soundMode ?? 'none');
  const [mine, setMine] = useState<AiMediaRef | null>(draft?.mine ?? null);
  const [wanted, setWanted] = useState<number | null>(seconds ?? draft?.wanted ?? null);
  const [price, setPrice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  const recommended = useMemo(() => recommendedModels(models ?? [], task, wanted), [models, task, wanted]);
  const model = useMemo(() => models?.find((m) => m.key === modelKey) ?? recommended[0] ?? models?.[0] ?? null, [models, modelKey, recommended]);

  // The model on screen stays chosen, or changing the length could change it, since the recommended list follows the length.
  useEffect(() => {
    if (model && model.key !== modelKey) setModelKey(model.key);
  }, [model, modelKey]);

  useEffect(() => {
    if (!model) return;
    setChoices((c) => initialChoices(model, width, height, c, wanted, shapePicked));
    setPrice(null);
    let live = true;
    void api.ai.price(model.key).then((p) => live && setPrice(p));
    return () => {
      live = false;
    };
    // Picking a shape or a length only matters the next time the form is set up.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, width, height]);

  useEffect(() => {
    if (draftKey) saveFormDraft(draftKey, { choices, shapePicked, image, video, audio, soundMode, mine, wanted });
  }, [draftKey, choices, shapePicked, image, video, audio, soundMode, mine, wanted]);

  const groups = useMemo(() => {
    const byProvider = new Map<string, AiModel[]>();
    for (const m of models ?? []) byProvider.set(m.provider, [...(byProvider.get(m.provider) ?? []), m]);
    return [...byProvider.entries()].map(([id, list]) => ({ id, name: providers.find((p) => p.id === id)?.name ?? id, list }));
  }, [models, providers]);

  if (!connected) {
    return (
      <div className="empty small">
        <div className="empty-icon">
          <Sparkles size={20} />
        </div>
        <p>Connect an AI service to generate and edit video.</p>
        <Button variant="primary" onClick={openConnections}>
          Connect an AI service
        </Button>
      </div>
    );
  }
  if (!models) {
    return (
      <div className="row muted">
        <Spinner /> Finding models…
      </div>
    );
  }
  if (!model) {
    return (
      <Notice icon={<Sparkles size={14} />}>
        None of your connected services offers this right now.{' '}
        <button type="button" className="link-btn inline" onClick={openConnections}>
          Connect another
        </button>
      </Notice>
    );
  }

  const set = (patch: AiChoices): void => setChoices((c) => ({ ...c, ...patch }));
  const mode: SoundMode = soundMode === 'ai' && !model.sound ? 'none' : soundMode;
  const made = choices.duration !== undefined ? durationSeconds(choices.duration) : null;
  // A model that cannot go as short as asked makes the next length up, and the clip is trimmed on arrival.
  const trimTo = props.newClip && wanted !== null && made !== null && made > wanted + 1e-6 ? wanted : null;
  const clipSeconds = trimTo ?? made;
  const lengths = durationChoices(model.duration);
  const offered = lengths.map(durationSeconds).filter((n): n is number => n !== null);
  const shorter = props.newClip && offered.length ? [...new Set([2, 3, ...(trimTo !== null ? [trimTo] : [])])].filter((n) => n < Math.min(...offered) || n === trimTo).sort((a, b) => a - b) : [];
  const madeFor = (n: number): string => durationLabel(pickDuration(model.duration, n) ?? n);
  const total = totalPrice(price, made);
  const missing = missingInput(model, choices, { image: !!image, video: !!video, audio: !!audio }) ?? (props.newClip && mode === 'mine' && !mine ? 'Choose the sound to use.' : null);
  const providerName = providers.find((p) => p.id === model.provider)?.name ?? model.provider;

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError('');
    try {
      let lands = typeof placement === 'function' ? placement() : placement;
      if (trimTo !== null && lands.kind === 'timeline') lands = { ...lands, trim: trimTo };
      if (props.newClip && mode === 'mine' && mine && lands.kind === 'timeline') {
        const source = useLibrary.getState().assetsById[mine.assetId];
        if (!source) throw new Error('That sound is no longer in Media.');
        // A video's sound has to become a file of its own to go on a row of its own.
        const file = source.kind === 'video' ? await api.assets.extractAudio(source.id) : source;
        const length = Math.min(clipSeconds ?? file.duration, file.duration);
        lands = { ...lands, sound: { assetId: file.id, start: Math.min(mine.start ?? 0, Math.max(0, file.duration - length)), duration: length } };
      }
      const request: AiRequest = {
        modelKey: model.key,
        choices: props.newClip && model.sound ? { ...choices, sound: mode === 'ai' } : choices,
        image: model.image ? image : null,
        video: model.video ? video : null,
        audio: model.audio ? audio : null,
        target: projectId ? { scope: 'project', projectId } : { scope: 'workspace' },
        placement: lands,
      };
      await api.ai.generate(request);
      set({ prompt: '' });
      onSubmitted?.();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const refresh = async (): Promise<void> => {
    setRefreshing(true);
    await loadModels(task, true).catch(() => undefined);
    setRefreshing(false);
  };

  return (
    <div className="ai-form">
      <div className="field">
        <span className="label">Model</span>
        <div className="row">
          <select
            className="select"
            aria-label="Model"
            value={model.key}
            onChange={(e) => {
              setModelKey(e.target.value);
              rememberModel(task, e.target.value);
            }}
          >
            {recommended.length > 0 && (
              <optgroup label="Recommended">
                {recommended.map((m) => (
                  <option key={m.key} value={m.key}>
                    {m.label}
                  </option>
                ))}
              </optgroup>
            )}
            {groups.map((g) => (
              <optgroup key={g.id} label={g.name}>
                {g.list.map((m) => (
                  <option key={m.key} value={m.key}>
                    {/* Variants of a model can share a display name. */}
                    {g.list.filter((x) => x.label === m.label).length > 1 ? `${m.label} · ${m.id.split('/').slice(-2).join('/')}` : m.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          <IconButton label="Refresh the model list" disabled={refreshing} onClick={() => void refresh()}>
            {refreshing ? <Spinner /> : <RefreshCw size={14} />}
          </IconButton>
        </div>
      </div>

      {model.image && props.image === undefined && <MediaPick kind="image" label="Image" value={image} projectId={projectId} onChange={setImage} />}
      {model.video && props.video === undefined && <MediaPick kind="video" label="Video" value={video} projectId={projectId} onChange={setVideo} />}
      {model.audio && props.audio === undefined && <MediaPick kind="audio" label="Audio" value={audio} projectId={projectId} onChange={setAudio} />}

      {model.prompt && (
        <Field label={promptLabel}>
          <textarea
            className="textarea"
            rows={4}
            aria-label={promptLabel}
            placeholder={promptPlaceholder}
            maxLength={model.prompt.maxLength ?? undefined}
            value={choices.prompt ?? ''}
            onChange={(e) => set({ prompt: e.target.value })}
          />
        </Field>
      )}

      <div className="form-grid">
        {model.duration && choices.duration !== undefined && (
          <Field label="Length">
            <select
              className="select"
              aria-label="Length"
              value={trimTo !== null ? `trim:${trimTo}` : String(choices.duration)}
              onChange={(e) => {
                const asked = e.target.value;
                if (asked.startsWith('trim:')) {
                  const n = Number(asked.slice(5));
                  setWanted(n);
                  set({ duration: pickDuration(model.duration, n) });
                  return;
                }
                const v = lengths.find((x) => String(x) === asked);
                if (v === undefined) return;
                setWanted(durationSeconds(v));
                set({ duration: v });
              }}
            >
              {shorter.map((n) => (
                <option key={n} value={`trim:${n}`}>
                  {n} s · trimmed from {madeFor(n)}
                </option>
              ))}
              {lengths.map((v) => (
                <option key={String(v)} value={String(v)}>
                  {durationLabel(v)}
                </option>
              ))}
            </select>
          </Field>
        )}
        {model.aspect?.values && choices.aspect !== undefined && (
          <Field label="Shape">
            <select
              className="select"
              aria-label="Shape"
              value={String(choices.aspect)}
              onChange={(e) => {
                setShapePicked(true);
                set({ aspect: model.aspect?.values?.find((x) => String(x) === e.target.value) });
              }}
            >
              {model.aspect.values.map((v) => (
                <option key={String(v)} value={String(v)}>
                  {aspectLabel(v)}
                </option>
              ))}
            </select>
          </Field>
        )}
        {model.resolution?.values && choices.resolution !== undefined && (
          <Field label="Resolution">
            <select
              className="select"
              aria-label="Resolution"
              value={String(choices.resolution)}
              onChange={(e) => set({ resolution: model.resolution?.values?.find((x) => String(x) === e.target.value) })}
            >
              {model.resolution.values.map((v) => (
                <option key={String(v)} value={String(v)}>
                  {String(v)}
                </option>
              ))}
            </select>
          </Field>
        )}
      </div>

      {props.newClip ? (
        <>
          <div className="field">
            <span className="label">Sound</span>
            <Segmented<SoundMode>
              fill
              label="Sound"
              value={mode}
              options={[{ value: 'none', label: 'None' }, ...(model.sound ? [{ value: 'ai' as const, label: 'AI-made' }] : []), { value: 'mine', label: 'My media' }]}
              onChange={setSoundMode}
            />
          </div>
          {mode === 'mine' && <MediaPick kind="audio" label="Sound from" value={mine} projectId={projectId} seconds={clipSeconds} onChange={setMine} />}
        </>
      ) : (
        model.sound && (
          <FieldRow label="Generate sound">
            <Switch label="Generate sound" checked={!!choices.sound} onChange={(sound) => set({ sound })} />
          </FieldRow>
        )
      )}

      {props.extra}
      {trimTo !== null && (
        <p className="faint panel-note">
          This model cannot make {trimTo} s, so it makes {made} s and the clip is trimmed to {trimTo} s when it lands. You pay for {made} s.
        </p>
      )}
      {note && <p className="faint panel-note">{note}</p>}
      <p className="faint panel-note">
        Billed to your {providerName} account{price ? ` · ${price}` : ''}
        {total ? ` · about ${total} for this clip` : ''}.
      </p>
      <Button variant="primary" block icon={busy ? <Spinner /> : <Sparkles size={15} />} disabled={busy || !!missing} title={missing ?? undefined} onClick={() => void submit()}>
        {submitLabel}
      </Button>
      {error && (
        <Notice kind="error" icon={<CircleAlert size={15} />}>
          {error}
        </Notice>
      )}
    </div>
  );
}
