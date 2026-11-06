// Connecting AI video services. Keys are tested against the service before they are stored.

import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { CircleAlert, ExternalLink, KeyRound, Sparkles } from 'lucide-react';
import type { AiProviderStatus } from '@shared/ai';
import { Modal } from '@/components/Modal';
import { Button, Notice, Spinner } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { connectionsChanged, loadProviders, useAi } from '@/store/ai';
import { useLibrary } from '@/store/library';
import { showModal, toast } from '@/store/ui';

function ProviderCard({ provider }: { provider: AiProviderStatus }): ReactNode {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const connect = async (): Promise<void> => {
    setBusy(true);
    setError('');
    try {
      const status = await api.ai.connect(provider.id, key);
      setKey('');
      await connectionsChanged();
      useAi.setState((s) => ({ providers: s.providers.map((p) => (p.id === status.id ? status : p)) }));
      toast(`${provider.name} connected.`, { kind: 'success' });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async (): Promise<void> => {
    await api.ai.disconnect(provider.id);
    await connectionsChanged();
  };

  return (
    <section className="provider-card" data-provider={provider.id}>
      <div className="row">
        <h3 className="grow provider-name">{provider.name}</h3>
        {provider.connected && (
          <span className="badge success">
            <KeyRound size={11} /> Connected
          </span>
        )}
      </div>
      <p>{provider.tagline}</p>
      {provider.connected ? (
        <div className="row">
          {provider.detail && <span className="muted tabular">{provider.detail}</span>}
          <span className="grow" />
          <Button size="small" onClick={() => void disconnect()}>
            Disconnect
          </Button>
        </div>
      ) : (
        <div className="row">
          <input
            className="input"
            type="password"
            autoComplete="off"
            spellCheck={false}
            aria-label={`${provider.name} API key`}
            placeholder="API key"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && key.trim()) {
                e.preventDefault();
                void connect();
              }
            }}
          />
          <Button variant="primary" disabled={!key.trim() || busy} icon={busy ? <Spinner /> : undefined} onClick={() => void connect()}>
            Connect
          </Button>
          <a className="btn ghost" href={provider.keyUrl} target="_blank" rel="noreferrer">
            Get a key <ExternalLink size={13} />
          </a>
        </div>
      )}
      {error && (
        <Notice kind="error" icon={<CircleAlert size={15} />}>
          {error}
        </Notice>
      )}
    </section>
  );
}

/** Claude writes scripts rather than video, but it is one more AI account, so its key lives here with the others. */
function ClaudeCard(): ReactNode {
  const hasKey = useLibrary((s) => s.lib?.settings.hasApiKey ?? false);
  const [key, setKey] = useState('');
  const [error, setError] = useState('');

  const save = async (value: string | null): Promise<void> => {
    setError('');
    try {
      await api.ai.setKey(value);
      setKey('');
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <section className="provider-card" data-provider="claude">
      <div className="row">
        <h3 className="grow provider-name">Claude</h3>
        {hasKey && (
          <span className="badge success">
            <KeyRound size={11} /> Connected
          </span>
        )}
      </div>
      <p>Writes a script for you from a topic, in Video from a script. It does not make video, and everything else works without it.</p>
      {hasKey ? (
        <div className="row">
          <span className="grow" />
          <Button size="small" onClick={() => void save(null)}>
            Disconnect
          </Button>
        </div>
      ) : (
        <div className="row">
          <input
            className="input"
            type="password"
            autoComplete="off"
            spellCheck={false}
            aria-label="Anthropic API key"
            placeholder="API key"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && key.trim()) {
                e.preventDefault();
                void save(key);
              }
            }}
          />
          <Button variant="primary" disabled={!key.trim()} onClick={() => void save(key)}>
            Connect
          </Button>
          <a className="btn ghost" href="https://platform.claude.com/settings/keys" target="_blank" rel="noreferrer">
            Get a key <ExternalLink size={13} />
          </a>
        </div>
      )}
      {error && (
        <Notice kind="error" icon={<CircleAlert size={15} />}>
          {error}
        </Notice>
      )}
    </section>
  );
}

function ConnectionsBody({ close }: { close: () => void }): ReactNode {
  const providers = useAi((s) => s.providers);
  useEffect(() => {
    void loadProviders(true);
  }, []);
  return (
    <Modal title="AI connections" size="wide" onClose={close} footer={<Button variant="primary" onClick={close}>Done</Button>}>
      <p>Connect a service to generate and edit video with AI. New models appear here automatically as each service adds them.</p>
      {providers.map((p) => (
        <ProviderCard key={p.id} provider={p} />
      ))}
      <ClaudeCard />
      <Notice icon={<Sparkles size={14} />}>
        Generating is billed to your account with that service. When you use a prompt or a clip, it is sent to that service. Nothing is sent until you press Generate. Keys are encrypted on this computer.
      </Notice>
    </Modal>
  );
}

/** Resolves when the dialog closes. */
export async function openConnections(): Promise<void> {
  await showModal<void>((close) => <ConnectionsBody close={() => close()} />);
}
