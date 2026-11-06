// "Create video": a prompt box that takes a topic or a finished script and produces a narrated video.

import type { ReactNode } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, AudioLines, Captions, CircleAlert, Clock, Gauge, Image as ImageIcon, KeyRound, Mic, Palette, Proportions, RefreshCw, Sparkles, Users, Clapperboard, MessageCircle, MonitorPlay } from 'lucide-react';
import { BACKGROUND_SWATCHES, SCRIPT_MAX_CHARS, SIZE_PRESETS, SUBTITLE_STYLES } from '@shared/constants';
import type { ID, ScriptOrigin, ScriptVideoSettings, VoiceInfo } from '@shared/types';
import { openConnections } from '@/ai/ConnectionsDialog';
import { openMenuAt, type MenuEntry } from '@/components/Menu';
import { confirmDialog } from '@/components/Modal';
import { Button, Notice, Spinner } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { templateThumbUrl } from '@/lib/media';
import { startBlankProject } from '@/lib/projects';
import { generateScriptVideo, sceneCount } from '@/lib/scriptVideo';
import { useAi, useConnected, useModels } from '@/store/ai';
import { useLibrary } from '@/store/library';
import { navigate, toast } from '@/store/ui';
import { openSettings } from './SettingsDialog';

const DEFAULTS: ScriptVideoSettings = {
  visuals: 'background',
  visualModelKey: null,
  voice: '',
  rate: 1,
  subtitleStyle: 'clean',
  background: '#1d2b53',
  musicAssetId: null,
  aspect: '9:16',
  targetDuration: 30,
  audience: '',
  videoType: '',
  tone: '',
  platform: '',
};

const BRIEF_OPTIONS = {
  audience: ['Everyone', 'Customers', 'Colleagues', 'Beginners', 'Experts'],
  videoType: ['Explainer', 'Announcement', 'How-to', 'Ad', 'Story'],
  tone: ['Friendly', 'Professional', 'Energetic', 'Calm', 'Playful'],
};

const PLATFORMS: { label: string; aspect: string }[] = [
  { label: 'YouTube', aspect: '16:9' },
  { label: 'TikTok', aspect: '9:16' },
  { label: 'Instagram', aspect: '4:5' },
  { label: 'LinkedIn', aspect: '1:1' },
];

interface Starter {
  title: string;
  hint: string;
  color: string;
  mode: 'topic' | 'script';
  text: string;
  settings: Partial<ScriptVideoSettings>;
}

const STARTERS: Starter[] = [
  {
    title: 'Product launch', hint: 'Announce something new', color: '#1d2b53', mode: 'topic',
    text: 'Announcing our new product and the one problem it solves for customers',
    settings: { videoType: 'Announcement', tone: 'Energetic', aspect: '9:16', subtitleStyle: 'pop', background: '#1d2b53' },
  },
  {
    title: 'Quick tip', hint: 'One useful idea in 30 seconds', color: '#0f766e', mode: 'topic',
    text: 'One simple habit that makes video calls feel less tiring',
    settings: { videoType: 'How-to', tone: 'Friendly', aspect: '9:16', subtitleStyle: 'boxed', background: '#0f766e' },
  },
  {
    title: 'Team update', hint: 'Share the week’s news', color: '#581c87', mode: 'script',
    text: 'Here is what the team shipped this week.\n\nFirst, the new onboarding flow is live for every customer.\n\nSecond, support response times are down by a third.\n\nNext week we start work on the mobile release. Thanks, everyone.',
    settings: { videoType: 'Announcement', tone: 'Professional', aspect: '16:9', subtitleStyle: 'clean', background: '#581c87' },
  },
  {
    title: 'Event invite', hint: 'Invite people to something', color: '#be123c', mode: 'script',
    text: 'You are invited.\n\nJoin us this Thursday at six for an evening of short talks and good company.\n\nSpaces are limited, so save yours today.',
    settings: { videoType: 'Ad', tone: 'Playful', aspect: '1:1', subtitleStyle: 'soft', background: '#be123c' },
  },
];

function Pill({ icon, label, entries }: { icon: ReactNode; label: string; entries: () => MenuEntry[] }): ReactNode {
  return (
    <button type="button" className="pill" onClick={(e) => openMenuAt(e.currentTarget, entries())}>
      {icon}
      <span className="truncate">{label}</span>
    </button>
  );
}

export function HomePage({ prefill }: { prefill?: ScriptOrigin | null }): ReactNode {
  const hasKey = useLibrary((s) => s.lib?.settings.hasApiKey ?? false);
  const providers = useAi((s) => s.providers);
  const assets = useLibrary((s) => s.lib?.assets);
  const templates = useLibrary((s) => s.lib?.templates) ?? [];
  const [mode, setMode] = useState<'topic' | 'script'>(prefill?.mode ?? 'topic');
  const [topic, setTopic] = useState(prefill?.topic ?? '');
  const [script, setScript] = useState(prefill?.script ?? '');
  const [settings, setSettings] = useState<ScriptVideoSettings>({ ...DEFAULTS, ...prefill?.settings });
  const [voices, setVoices] = useState<VoiceInfo[] | null>(null);
  /** On the topic tab, the draft waits here for review before anything is generated. */
  const [reviewing, setReviewing] = useState(!!prefill && prefill.mode === 'topic' && !!prefill.script);
  const [writing, setWriting] = useState(false);
  const [stage, setStage] = useState('');
  const [error, setError] = useState('');
  const [photoId, setPhotoId] = useState<ID | null>(null);
  const aiConnected = useConnected();
  const sceneModels = useModels('text-to-video');
  const talkingModels = useModels('talking-photo');
  const photo = useLibrary((s) => (photoId ? s.assetsById[photoId] : undefined));

  useEffect(() => {
    void api.voice.list().then((list) => {
      setVoices(list);
      setSettings((s) => (s.voice && list.some((v) => v.id === s.voice) ? s : { ...s, voice: list[0]?.id ?? '' }));
    });
  }, []);

  const patch = (p: Partial<ScriptVideoSettings>): void => setSettings((s) => ({ ...s, ...p }));
  /** Choosing AI visuals with no service connected goes through connecting one, and the choice waits for that. */
  const chooseVisuals = (visuals: ScriptVideoSettings['visuals']): void => {
    if (aiConnected) patch({ visuals, visualModelKey: null });
    else {
      void openConnections().then(() => {
        if (useAi.getState().providers.some((p) => p.connected)) patch({ visuals, visualModelKey: null });
      });
    }
  };
  const music = useMemo(() => (assets ?? []).filter((a) => a.kind === 'audio' && a.scope === 'workspace'), [assets]);
  const voiceName = voices?.find((v) => v.id === settings.voice)?.name ?? 'Voice';
  const subtitleName = SUBTITLE_STYLES.find((s) => s.id === settings.subtitleStyle)?.label ?? 'Subtitles';
  const musicName = music.find((m) => m.id === settings.musicAssetId)?.name ?? 'No music';
  const busy = writing || !!stage;

  const draft = async (): Promise<void> => {
    setWriting(true);
    setError('');
    try {
      const { audience, videoType, tone, platform } = settings;
      setScript(await api.ai.writeScript({ topic, targetSeconds: settings.targetDuration, brief: { audience, videoType, tone, platform } }));
      setReviewing(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setWriting(false);
    }
  };

  const usingAi = settings.visuals !== 'background';
  const visualModels = settings.visuals === 'talking-character' ? talkingModels : sceneModels;
  const visualModel = visualModels?.find((m) => m.key === settings.visualModelKey) ?? visualModels?.[0];

  const pickPhoto = async (): Promise<void> => {
    try {
      const result = await api.assets.pickAndImport('image', { scope: 'workspace' });
      if (result?.assets[0]) setPhotoId(result.assets[0].id);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const generate = async (): Promise<void> => {
    setError('');
    try {
      if (usingAi) {
        const provider = providers.find((p) => p.id === visualModel?.provider)?.name ?? 'your AI service';
        const count = sceneCount(script);
        const go = await confirmDialog({
          title: settings.visuals === 'ai-scenes' ? `Generate about ${count} scene${count === 1 ? '' : 's'}?` : 'Generate a talking video?',
          message:
            settings.visuals === 'ai-scenes'
              ? `Each scene is generated by ${visualModel?.label} and billed to your ${provider} account. The project opens in the editor, and clips appear on the timeline as they finish.`
              : `Your photo and the voice-over go to ${provider}, and ${visualModel?.label} is billed to your account by the length of the video. The project opens in the editor while it works.`,
          confirmLabel: 'Generate',
        });
        if (!go) return;
      }
      await generateScriptVideo({ mode, topic, script, settings: { ...settings, visualModelKey: visualModel?.key ?? null } }, setStage, photoId);
    } catch (err) {
      setError(errorMessage(err));
      setStage('');
    }
  };

  const applyStarter = (s: Starter): void => {
    setMode(s.mode);
    setReviewing(false);
    setError('');
    if (s.mode === 'topic') setTopic(s.text);
    else setScript(s.text);
    patch(s.settings);
  };

  const openTemplate = async (id: string): Promise<void> => {
    try {
      const meta = await api.library.createFromTemplate(id);
      await navigate({ page: 'editor', projectId: meta.id });
    } catch (err) {
      toast(errorMessage(err), { kind: 'error' });
    }
  };

  const chars = script.length;
  const showScriptBox = mode === 'script' || reviewing;
  const visualsReady = !usingAi || (!!visualModel && (settings.visuals !== 'talking-character' || !!photoId));
  const canGenerate = !!script.trim() && chars <= SCRIPT_MAX_CHARS && !!settings.voice && !busy && visualsReady;
  const visualsLabel = { background: 'Colour background', 'ai-scenes': 'AI scenes', 'talking-character': 'Talking character' }[settings.visuals];

  return (
    <div className="page home">
      <div className="home-hero">
        <h1>Create a video</h1>
        <div className="tabs" role="tablist" aria-label="How to start">
          <button type="button" className="tab" role="tab" aria-selected={mode === 'topic'} onClick={() => { setMode('topic'); setError(''); }}>
            Topic
          </button>
          <button type="button" className="tab" role="tab" aria-selected={mode === 'script'} onClick={() => { setMode('script'); setReviewing(false); setError(''); }}>
            Script
          </button>
        </div>

        <div className="prompt-box">
          {showScriptBox ? (
            <textarea
              className="prompt-input tall"
              aria-label="Script"
              placeholder="Paste your script. It is used exactly as written."
              value={script}
              maxLength={SCRIPT_MAX_CHARS}
              onChange={(e) => setScript(e.target.value)}
            />
          ) : (
            <textarea className="prompt-input" aria-label="Topic" placeholder="What should the video talk about?" value={topic} onChange={(e) => setTopic(e.target.value)} />
          )}
          <div className="prompt-pills">
            <Pill
              icon={<Sparkles size={13} />}
              label={visualsLabel}
              entries={() => [
                'What fills the picture',
                { label: 'Colour background', checked: settings.visuals === 'background', onSelect: () => patch({ visuals: 'background' }) },
                { label: 'AI scenes', checked: settings.visuals === 'ai-scenes', onSelect: () => chooseVisuals('ai-scenes') },
                { label: 'Talking character', checked: settings.visuals === 'talking-character', onSelect: () => chooseVisuals('talking-character') },
                !aiConnected && null,
                !aiConnected && { label: 'Connect AI tools…', onSelect: () => void openConnections() },
              ]}
            />
            {usingAi && visualModels && visualModels.length > 0 && (
              <Pill
                icon={<Clapperboard size={13} />}
                label={visualModel?.label ?? 'Model'}
                entries={() => ['Model', ...visualModels.map((m) => ({ label: m.label, checked: m.key === visualModel?.key, onSelect: () => patch({ visualModelKey: m.key }) }))]}
              />
            )}
            {settings.visuals === 'talking-character' && (
              <button type="button" className="pill" onClick={() => void pickPhoto()}>
                <ImageIcon size={13} />
                <span className="truncate">{photo?.name ?? 'Choose a photo'}</span>
              </button>
            )}
            <Pill
              icon={<Mic size={13} />}
              label={voiceName}
              entries={() => [
                'Voice',
                ...(voices ?? []).map((v) => ({ label: `${v.name}${v.lang ? ` (${v.lang})` : ''}`, checked: v.id === settings.voice, onSelect: () => patch({ voice: v.id }) })),
              ]}
            />
            <Pill
              icon={<Gauge size={13} />}
              label={`${settings.rate}x`}
              entries={() => ['Speaking speed', ...[0.8, 0.9, 1, 1.1, 1.25].map((r) => ({ label: `${r}x`, checked: r === settings.rate, onSelect: () => patch({ rate: r }) }))]}
            />
            <Pill
              icon={<Captions size={13} />}
              label={subtitleName}
              entries={() => ['Subtitle style', ...SUBTITLE_STYLES.map((s) => ({ label: s.label, checked: s.id === settings.subtitleStyle, onSelect: () => patch({ subtitleStyle: s.id }) }))]}
            />
            <Pill
              icon={<AudioLines size={13} />}
              label={musicName}
              entries={() => [
                'Background music',
                { label: 'No music', checked: !settings.musicAssetId, onSelect: () => patch({ musicAssetId: null }) },
                ...music.map((m) => ({ label: m.name, checked: m.id === settings.musicAssetId, onSelect: () => patch({ musicAssetId: m.id }) })),
                !music.length && { label: 'Upload audio under Assets to use it here', disabled: true, onSelect: () => undefined },
              ]}
            />
            <Pill
              icon={<span className="color-dot" style={{ background: settings.background }} />}
              label="Background"
              entries={() => ['Background', ...BACKGROUND_SWATCHES.map((c) => ({ label: c, icon: <span className="color-dot" style={{ background: c }} />, checked: c === settings.background, onSelect: () => patch({ background: c }) }))]}
            />
            <Pill
              icon={<Proportions size={13} />}
              label={settings.aspect}
              entries={() => ['Aspect ratio', ...SIZE_PRESETS.map((p) => ({ label: `${p.label} · ${p.hint}`, checked: p.id === settings.aspect, onSelect: () => patch({ aspect: p.id }) }))]}
            />
            {mode === 'topic' && !reviewing && (
              <>
                <Pill
                  icon={<Clock size={13} />}
                  label={`${settings.targetDuration}s`}
                  entries={() => ['Target duration', ...[15, 30, 45, 60, 90, 120].map((d) => ({ label: `${d} seconds`, checked: d === settings.targetDuration, onSelect: () => patch({ targetDuration: d }) }))]}
                />
                <Pill
                  icon={<Users size={13} />}
                  label={settings.audience || 'Audience'}
                  entries={() => ['Audience', ...BRIEF_OPTIONS.audience.map((a) => ({ label: a, checked: a === settings.audience, onSelect: () => patch({ audience: a }) }))]}
                />
                <Pill
                  icon={<Clapperboard size={13} />}
                  label={settings.videoType || 'Video type'}
                  entries={() => ['Video type', ...BRIEF_OPTIONS.videoType.map((a) => ({ label: a, checked: a === settings.videoType, onSelect: () => patch({ videoType: a }) }))]}
                />
                <Pill
                  icon={<MessageCircle size={13} />}
                  label={settings.tone || 'Tone of voice'}
                  entries={() => ['Tone of voice', ...BRIEF_OPTIONS.tone.map((a) => ({ label: a, checked: a === settings.tone, onSelect: () => patch({ tone: a }) }))]}
                />
                <Pill
                  icon={<MonitorPlay size={13} />}
                  label={settings.platform || 'Platform'}
                  entries={() => ['Platform', ...PLATFORMS.map((p) => ({ label: p.label, checked: p.label === settings.platform, onSelect: () => patch({ platform: p.label, aspect: p.aspect }) }))]}
                />
              </>
            )}
          </div>
          <div className="prompt-foot">
            {showScriptBox && (
              <span className={`tabular ${chars > SCRIPT_MAX_CHARS * 0.95 ? 'muted' : 'faint'}`}>
                {chars.toLocaleString()} / {SCRIPT_MAX_CHARS.toLocaleString()}
              </span>
            )}
            <div className="grow" />
            {reviewing && mode === 'topic' && (
              <>
                <Button variant="ghost" disabled={busy} onClick={() => setReviewing(false)}>
                  Change topic
                </Button>
                <Button icon={writing ? <Spinner /> : <RefreshCw size={14} />} disabled={busy} onClick={() => void draft()}>
                  Regenerate
                </Button>
              </>
            )}
            {showScriptBox ? (
              <Button variant="primary" size="large" icon={stage ? <Spinner /> : <ArrowRight size={16} />} disabled={!canGenerate} onClick={() => void generate()}>
                Generate video
              </Button>
            ) : (
              <Button variant="primary" size="large" icon={writing ? <Spinner /> : <Sparkles size={15} />} disabled={!topic.trim() || busy} onClick={() => void draft()}>
                {writing ? 'Writing…' : 'Write script'}
              </Button>
            )}
          </div>
        </div>

        {stage && (
          <div className="row muted">
            <Spinner /> {stage}
          </div>
        )}
        {voices !== null && voices.length === 0 && (
          <Notice kind="warning" icon={<CircleAlert size={15} />}>
            No text-to-speech voices are installed on this computer, so narrated videos cannot be generated.
          </Notice>
        )}
        {mode === 'topic' && !hasKey && !reviewing && (
          <Notice icon={<KeyRound size={15} />}>
            Drafting from a topic uses the Claude API with your own key.{' '}
            <button type="button" className="link-btn inline" onClick={() => openSettings()}>
              Add a key
            </button>{' '}
            or paste your own words on the Script tab, which needs no key.
          </Notice>
        )}
        {error && (
          <Notice kind="error" icon={<CircleAlert size={15} />}>
            {error}
          </Notice>
        )}
      </div>

      <section className="home-section">
        <h2>Start with a template</h2>
        <div className="starter-grid">
          {STARTERS.map((s) => (
            <button key={s.title} type="button" className="starter" onClick={() => applyStarter(s)}>
              <span className="starter-art" style={{ background: s.color }}>
                <Palette size={18} />
              </span>
              <strong>{s.title}</strong>
              <span className="muted">{s.hint}</span>
            </button>
          ))}
          {templates.map((t) => {
            const thumb = templateThumbUrl(t);
            return (
              <button key={t.id} type="button" className="starter" onClick={() => void openTemplate(t.id)}>
                <span className="starter-art" style={{ backgroundImage: thumb ? `url("${thumb}")` : undefined }} />
                <strong className="truncate">{t.name}</strong>
                <span className="muted">Your template</span>
              </button>
            );
          })}
        </div>
      </section>

      <section className="home-section">
        <div className="home-blank">
          <div>
            <h2>Editing your own footage?</h2>
            <p className="muted">Open a blank project, add your files and start cutting.</p>
          </div>
          <Button onClick={() => void startBlankProject()}>Edit video</Button>
        </div>
      </section>
    </div>
  );
}
