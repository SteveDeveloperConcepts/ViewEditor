// One form for every kind of generation. What it shows comes from the chosen model: a model without a
// duration setting shows none, and a model that offers 4, 6 and 8 seconds offers exactly those.

import type { ReactNode } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { CircleAlert, RefreshCw, Sparkles, Upload } from 'lucide-react';
import {
  aspectLabel,
  durationChoices,
  durationLabel,
  missingInput,
  pickAspect,
  pickDuration,
  type AiChoices,
  type AiMediaRef,
  type AiModel,
  type AiOption,
  type AiPlacement,
  type AiRequest,
  type AiTask,
  type AiValue,
} from '@shared/ai';
import type { Asset, AssetKind, ID } from '@shared/types';
import { Button, Field, FieldRow, IconButton, Notice, Spinner, Switch, TimeInput } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { reportRejected } from '@/editor/importing';
import { loadModels, useAi, useConnected, useModels } from '@/store/ai';
import { useLibrary } from '@/store/library';
import { openConnections } from './ConnectionsDialog';
import { formDraft, saveFormDraft } from './drafts';

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

/** The length to start from: what was chosen already if this model has it, then the clip's own length, then the model's default. */
function lengthFor(model: AiModel, previous: AiChoices, seconds: number | undefined): AiValue | undefined {
  const option = model.duration;
  if (!option) return undefined;
  if (previous.duration !== undefined && (!option.values || option.values.includes(previous.duration))) return previous.duration;
  if (seconds !== undefined) return pickDuration(option, seconds);
  return chooseFrom(option, undefined) ?? pickDuration(option, typeof previous.duration === 'number' ? previous.duration : 5);
}

function initialChoices(model: AiModel, width: number, height: number, previous: AiChoices, seconds: number | undefined, shapePicked: boolean): AiChoices {
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

function MediaPick(props: { kind: AssetKind; label: string; value: AiMediaRef | null; projectId: ID | null; onChange: (ref: AiMediaRef | null) => void }): ReactNode {
  const { kind, label, value, projectId, onChange } = props;
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
      {sound && value && chosen && <SoundRange asset={chosen} value={value} onChange={onChange} />}
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
  const [price, setPrice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  const model = useMemo(() => models?.find((m) => m.key === modelKey) ?? models?.[0] ?? null, [models, modelKey]);

  useEffect(() => {
    if (!model) return;
    setChoices((c) => initialChoices(model, width, height, c, seconds, shapePicked));
    setPrice(null);
    let live = true;
    void api.ai.price(model.key).then((p) => live && setPrice(p));
    return () => {
      live = false;
    };
    // Picking a shape only matters the next time the form is set up.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, width, height, seconds]);

  useEffect(() => {
    if (draftKey) saveFormDraft(draftKey, { choices, shapePicked, image, video, audio });
  }, [draftKey, choices, shapePicked, image, video, audio]);

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
  const missing = missingInput(model, choices, { image: !!image, video: !!video, audio: !!audio });
  const providerName = providers.find((p) => p.id === model.provider)?.name ?? model.provider;

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError('');
    try {
      const request: AiRequest = {
        modelKey: model.key,
        choices,
        image: model.image ? image : null,
        video: model.video ? video : null,
        audio: model.audio ? audio : null,
        target: projectId ? { scope: 'project', projectId } : { scope: 'workspace' },
        placement: typeof placement === 'function' ? placement() : placement,
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
              value={String(choices.duration)}
              onChange={(e) => {
                const v = durationChoices(model.duration).find((x) => String(x) === e.target.value);
                if (v !== undefined) set({ duration: v });
              }}
            >
              {durationChoices(model.duration).map((v) => (
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

      {model.sound && (
        <FieldRow label="Generate sound">
          <Switch label="Generate sound" checked={!!choices.sound} onChange={(sound) => set({ sound })} />
        </FieldRow>
      )}

      {props.extra}
      {note && <p className="faint panel-note">{note}</p>}
      <p className="faint panel-note">
        Billed to your {providerName} account{price ? ` · ${price}` : ''}.
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
