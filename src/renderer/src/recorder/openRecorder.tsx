// The recorder: screen, camera, both together, or just the microphone.
// Capture runs here with MediaRecorder; finished data streams to the main process in one-second pieces.

import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import { Camera, CircleAlert, Mic, Monitor, PictureInPicture2, Square } from 'lucide-react';
import { formatClock } from '@shared/time';
import type { CaptureSource, ID } from '@shared/types';
import { Modal } from '@/components/Modal';
import { Button, Field, Notice, Segmented, Spinner, Switch } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { startProjectWithAsset } from '@/lib/projects';
import { addToTimeline } from '@/editor/importing';
import { useLibrary } from '@/store/library';
import { showModal, toast } from '@/store/ui';

type Mode = 'screen' | 'camera' | 'both' | 'audio';
type Phase = 'setup' | 'countdown' | 'recording' | 'saving';

export interface RecorderOptions {
  /** Project the recording belongs to. Without one, a new project is created when recording finishes. */
  projectId?: ID;
  addToTimeline?: boolean;
  mode?: Mode;
}

interface Capture {
  stream: MediaStream;
  stop: () => void;
}

const MODES: { value: Mode; label: ReactNode }[] = [
  { value: 'screen', label: <><Monitor size={13} /> Screen</> },
  { value: 'camera', label: <><Camera size={13} /> Camera</> },
  { value: 'both', label: <><PictureInPicture2 size={13} /> Both</> },
  { value: 'audio', label: <><Mic size={13} /> Audio</> },
];

function mimeFor(mode: Mode): string {
  const options = mode === 'audio' ? ['audio/webm;codecs=opus', 'audio/webm'] : ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  return options.find((m) => MediaRecorder.isTypeSupported(m)) ?? '';
}

function playInto(stream: MediaStream): HTMLVideoElement {
  const v = document.createElement('video');
  v.muted = true;
  v.srcObject = stream;
  void v.play();
  return v;
}

/** Draws the screen with the camera in the corner, for "both" mode. */
function composite(screen: MediaStream, camera: MediaStream): { stream: MediaStream; stop: () => void } {
  const sv = playInto(screen);
  const cv = playInto(camera);
  const settings = screen.getVideoTracks()[0].getSettings();
  const s = Math.min(1, 1920 / (settings.width ?? 1920));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(((settings.width ?? 1920) * s) / 2) * 2;
  canvas.height = Math.round(((settings.height ?? 1080) * s) / 2) * 2;
  const ctx = canvas.getContext('2d', { alpha: false })!;
  const camW = Math.round(canvas.width * 0.22);
  const margin = Math.round(canvas.width * 0.02);
  // A timer rather than animation frames: those stop once the window is minimised.
  const timer = setInterval(() => {
    ctx.drawImage(sv, 0, 0, canvas.width, canvas.height);
    if (cv.videoWidth) {
      const camH = Math.round((camW * cv.videoHeight) / cv.videoWidth);
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(canvas.width - camW - margin, canvas.height - camH - margin, camW, camH, margin / 2);
      ctx.clip();
      ctx.drawImage(cv, canvas.width - camW - margin, canvas.height - camH - margin, camW, camH);
      ctx.restore();
    }
  }, 1000 / 30);
  return {
    stream: canvas.captureStream(30),
    stop: () => {
      clearInterval(timer);
      sv.srcObject = null;
      cv.srcObject = null;
    },
  };
}

interface CaptureChoices {
  mode: Mode;
  sourceId: string;
  cameraId: string;
  micId: string;
  useMic: boolean;
  systemAudio: boolean;
}

async function startCapture(c: CaptureChoices): Promise<Capture> {
  const owned: MediaStream[] = [];
  const cleanups: (() => void)[] = [];
  const stopAll = (): void => {
    cleanups.forEach((f) => f());
    owned.forEach((s) => s.getTracks().forEach((t) => t.stop()));
  };
  try {
    let screen: MediaStream | null = null;
    let camera: MediaStream | null = null;
    if (c.mode === 'screen' || c.mode === 'both') {
      await api.recorder.prepare(c.sourceId, c.systemAudio);
      screen = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: c.systemAudio });
      owned.push(screen);
    }
    if (c.mode === 'camera' || c.mode === 'both') {
      camera = await navigator.mediaDevices.getUserMedia({ video: { deviceId: c.cameraId ? { exact: c.cameraId } : undefined, width: { ideal: 1920 }, height: { ideal: 1080 } } });
      owned.push(camera);
    }
    const audioSources: MediaStream[] = [];
    if (screen?.getAudioTracks().length) audioSources.push(new MediaStream(screen.getAudioTracks()));
    if (c.useMic || c.mode === 'audio') {
      const mic = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: c.micId ? { exact: c.micId } : undefined, echoCancellation: true, noiseSuppression: true } });
      owned.push(mic);
      audioSources.push(mic);
    }

    let videoTracks: MediaStreamTrack[] = [];
    if (screen && camera) {
      const mixed = composite(screen, camera);
      cleanups.push(mixed.stop);
      owned.push(mixed.stream);
      videoTracks = mixed.stream.getVideoTracks();
    } else if (screen || camera) {
      videoTracks = (screen ?? camera)!.getVideoTracks();
    }

    let audioTracks: MediaStreamTrack[] = [];
    if (audioSources.length === 1) audioTracks = audioSources[0].getAudioTracks();
    else if (audioSources.length > 1) {
      const ctx = new AudioContext();
      const dest = ctx.createMediaStreamDestination();
      for (const s of audioSources) ctx.createMediaStreamSource(s).connect(dest);
      cleanups.push(() => void ctx.close());
      audioTracks = dest.stream.getAudioTracks();
    }
    return { stream: new MediaStream([...videoTracks, ...audioTracks]), stop: stopAll };
  } catch (err) {
    stopAll();
    throw err;
  }
}

function friendlyError(err: unknown): string {
  const name = err instanceof DOMException ? err.name : '';
  if (name === 'NotAllowedError') return 'Permission was refused. Allow camera, microphone or screen recording for ViewEditor in your system settings, then try again.';
  if (name === 'NotFoundError') return 'That camera or microphone could not be found.';
  if (name === 'NotReadableError') return 'That device is in use by another app.';
  return errorMessage(err);
}

function SourcePicker({ value, onChange, onSources }: { value: string; onChange: (id: string) => void; onSources: (n: number) => void }): ReactNode {
  const [sources, setSources] = useState<CaptureSource[] | null>(null);
  const [tab, setTab] = useState<'screen' | 'window'>('screen');
  useEffect(() => {
    void api.recorder.sources().then(
      (list) => {
        setSources(list);
        onSources(list.length);
        const first = list.find((s) => s.kind === 'screen') ?? list[0];
        if (first) onChange(first.id);
      },
      () => setSources([]),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (!sources) {
    return (
      <div className="row">
        <Spinner /> <span className="muted">Looking for screens and windows…</span>
      </div>
    );
  }
  const shown = sources.filter((s) => s.kind === tab);
  return (
    <div className="col">
      <Segmented<'screen' | 'window'>
        label="What to capture"
        value={tab}
        options={[
          { value: 'screen', label: 'Entire screen' },
          { value: 'window', label: 'Window' },
        ]}
        onChange={setTab}
      />
      <div className="source-grid">
        {shown.map((s) => (
          <button key={s.id} type="button" className="source" aria-pressed={s.id === value} onClick={() => onChange(s.id)}>
            <img src={s.thumbnail} alt="" draggable={false} />
            <span className="truncate">{s.name}</span>
          </button>
        ))}
        {!shown.length && <p className="faint">Nothing to show here.</p>}
      </div>
    </div>
  );
}

function RecorderBody({ options, close }: { options: RecorderOptions; close: () => void }): ReactNode {
  const info = useLibrary((s) => s.info);
  const [mode, setMode] = useState<Mode>(options.mode ?? 'screen');
  const [sourceId, setSourceId] = useState('');
  const [sourceCount, setSourceCount] = useState(-1);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [cameraId, setCameraId] = useState('');
  const [micId, setMicId] = useState('');
  const [useMic, setUseMic] = useState(true);
  const [systemAudio, setSystemAudio] = useState(false);
  const [phase, setPhase] = useState<Phase>('setup');
  const [count, setCount] = useState(3);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState('');
  const recorder = useRef<MediaRecorder | null>(null);
  const capture = useRef<Capture | null>(null);
  const recId = useRef<ID | null>(null);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const preview = useRef<HTMLVideoElement>(null);
  const previewStream = useRef<MediaStream | null>(null);

  const wantsScreen = mode === 'screen' || mode === 'both';
  const wantsCamera = mode === 'camera' || mode === 'both';

  // Device names are only available once access has been granted, so ask first and list afterwards.
  useEffect(() => {
    let cancelled = false;
    const list = async (): Promise<void> => {
      try {
        const probe = await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => null);
        probe?.getTracks().forEach((t) => t.stop());
      } finally {
        const all = await navigator.mediaDevices.enumerateDevices();
        if (!cancelled) setDevices(all);
      }
    };
    void list();
    return () => {
      cancelled = true;
    };
  }, []);

  // A live picture of the camera while choosing.
  useEffect(() => {
    if (!wantsCamera || phase !== 'setup') return;
    let stopped = false;
    void navigator.mediaDevices
      .getUserMedia({ video: { deviceId: cameraId ? { exact: cameraId } : undefined } })
      .then((s) => {
        if (stopped) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        previewStream.current = s;
        if (preview.current) preview.current.srcObject = s;
      })
      .catch(() => undefined);
    return () => {
      stopped = true;
      previewStream.current?.getTracks().forEach((t) => t.stop());
      previewStream.current = null;
    };
  }, [wantsCamera, cameraId, phase]);

  const finishRecording = (): void => {
    if (recorder.current?.state === 'recording') recorder.current.stop();
  };

  useEffect(() => api.on('recorder:stop', finishRecording), []);

  useEffect(() => {
    if (phase !== 'recording') return;
    const started = Date.now();
    const timer = setInterval(() => setElapsed((Date.now() - started) / 1000), 250);
    return () => clearInterval(timer);
  }, [phase]);

  // If the dialog goes away for any reason, nothing keeps recording.
  useEffect(
    () => () => {
      capture.current?.stop();
      void api.recorder.setActive(false, false);
    },
    [],
  );

  const save = async (): Promise<void> => {
    setPhase('saving');
    capture.current?.stop();
    capture.current = null;
    await api.recorder.setActive(false, false);
    await queue.current;
    const stamp = new Date().toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).replace(/[:/]/g, '.');
    const name = `${mode === 'audio' ? 'Voice-over' : 'Recording'} ${stamp}`;
    const id = recId.current!;
    try {
      // Wherever Record was pressed, the recording is kept in Media.
      const asset = await api.recorder.finish(id, name, { scope: 'workspace' });
      close();
      if (options.projectId) {
        if (options.addToTimeline) await addToTimeline([asset]);
        toast('Recording saved to Media and added to the timeline.', { kind: 'success' });
      } else {
        await startProjectWithAsset(asset, name);
      }
    } catch (err) {
      setError(errorMessage(err));
      setPhase('setup');
    }
  };

  const begin = async (): Promise<void> => {
    setError('');
    previewStream.current?.getTracks().forEach((t) => t.stop());
    try {
      const cap = await startCapture({ mode, sourceId, cameraId, micId, useMic, systemAudio });
      capture.current = cap;
      if (!cap.stream.getTracks().length) throw new Error('There is nothing to record. Choose a source first.');
      setPhase('countdown');
      for (let n = 3; n > 0; n--) {
        setCount(n);
        await new Promise((r) => setTimeout(r, 1000));
      }
      const { recId: id } = await api.recorder.begin();
      recId.current = id;
      const rec = new MediaRecorder(cap.stream, { mimeType: mimeFor(mode), videoBitsPerSecond: 8_000_000 });
      recorder.current = rec;
      rec.ondataavailable = (e) => {
        if (!e.data.size) return;
        const piece = e.data;
        queue.current = queue.current.then(async () => api.recorder.chunk(id, new Uint8Array(await piece.arrayBuffer())));
      };
      rec.onstop = () => void save();
      // Capture ends by itself when the shared window closes.
      cap.stream.getVideoTracks()[0]?.addEventListener('ended', finishRecording);
      rec.start(1000);
      setElapsed(0);
      setPhase('recording');
      await api.recorder.setActive(true, wantsScreen);
    } catch (err) {
      capture.current?.stop();
      capture.current = null;
      setError(friendlyError(err));
      setPhase('setup');
    }
  };

  const mics = devices.filter((d) => d.kind === 'audioinput');
  const cameras = devices.filter((d) => d.kind === 'videoinput');
  const ready = (!wantsScreen || !!sourceId) && (!wantsCamera || cameras.length > 0) && (mode !== 'audio' || mics.length > 0);

  if (phase === 'countdown' || phase === 'recording' || phase === 'saving') {
    return (
      <Modal title={phase === 'saving' ? 'Saving recording' : 'Recording'} onClose={() => undefined} dismissable={false}>
        <div className="recording-state">
          {phase === 'countdown' && <div className="countdown tabular">{count}</div>}
          {phase === 'recording' && (
            <>
              <div className="rec-indicator">
                <i /> <span className="tabular">{formatClock(elapsed)}</span>
              </div>
              {wantsScreen && (
                <p>
                  Press <span className="kbd">{info?.stopRecordingShortcut}</span> from any app to stop.
                </p>
              )}
              <Button variant="danger" size="large" icon={<Square size={14} fill="currentColor" />} onClick={finishRecording}>
                Stop recording
              </Button>
            </>
          )}
          {phase === 'saving' && <Spinner large />}
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      title="Record"
      size="wide"
      onClose={close}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" disabled={!ready} onClick={() => void begin()}>
            Start recording
          </Button>
        </>
      }
    >
      <Segmented<Mode> fill label="What to record" value={mode} options={MODES} onChange={setMode} />
      {wantsScreen && <SourcePicker value={sourceId} onChange={setSourceId} onSources={setSourceCount} />}
      {wantsScreen && sourceCount === 0 && (
        <Notice kind="warning" icon={<CircleAlert size={15} />}>
          No screens are available. On a Mac, allow Screen Recording for ViewEditor in System Settings › Privacy & Security, then reopen the app.
        </Notice>
      )}
      {wantsCamera && (
        <div className="camera-setup">
          <video ref={preview} className="camera-preview" autoPlay muted playsInline />
          <Field label="Camera">
            <select className="select" value={cameraId} onChange={(e) => setCameraId(e.target.value)}>
              {!cameras.length && <option value="">No camera found</option>}
              {cameras.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || 'Camera'}
                </option>
              ))}
            </select>
          </Field>
        </div>
      )}
      <div className="form-grid">
        <Field label="Microphone">
          <select className="select" value={micId} disabled={mode !== 'audio' && !useMic} onChange={(e) => setMicId(e.target.value)}>
            {!mics.length && <option value="">No microphone found</option>}
            {mics.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || 'Microphone'}
              </option>
            ))}
          </select>
        </Field>
        <div className="col">
          {mode !== 'audio' && (
            <div className="field-row">
              <span className="label">Record microphone</span>
              <Switch label="Record microphone" checked={useMic} onChange={setUseMic} />
            </div>
          )}
          {wantsScreen && info?.platform === 'win32' && (
            <div className="field-row">
              <span className="label">Record system audio</span>
              <Switch label="Record system audio" checked={systemAudio} onChange={setSystemAudio} />
            </div>
          )}
        </div>
      </div>
      {error && (
        <Notice kind="error" icon={<CircleAlert size={15} />}>
          {error}
        </Notice>
      )}
    </Modal>
  );
}

export function openRecorder(options: RecorderOptions): Promise<void> {
  return showModal<void>((close) => <RecorderBody options={options} close={() => close()} />).then(() => undefined);
}
