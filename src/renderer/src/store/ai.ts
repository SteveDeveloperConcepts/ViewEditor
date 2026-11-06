import { useEffect } from 'react';
import { create } from 'zustand';
import type { AiModel, AiProviderStatus, AiTask } from '@shared/ai';
import { api } from '@/lib/api';

interface AiState {
  providers: AiProviderStatus[];
  /** Models per task, or undefined while they load. */
  models: Partial<Record<AiTask, AiModel[]>>;
}

export const useAi = create<AiState>(() => ({ providers: [], models: {} }));

export async function loadProviders(check = false): Promise<void> {
  const providers = await api.ai.providers(check);
  useAi.setState({ providers });
}

export async function loadModels(task: AiTask, refresh = false): Promise<AiModel[]> {
  const list = await api.ai.models(task, refresh);
  useAi.setState((s) => ({ models: { ...s.models, [task]: list } }));
  return list;
}

/** After connecting or disconnecting, everything known about models is out of date. */
export async function connectionsChanged(): Promise<void> {
  useAi.setState({ models: {} });
  await loadProviders();
}

export function useConnected(): boolean {
  return useAi((s) => s.providers.some((p) => p.connected));
}

export function useModels(task: AiTask): AiModel[] | undefined {
  const models = useAi((s) => s.models[task]);
  const connected = useConnected();
  useEffect(() => {
    if (connected && !models) void loadModels(task);
  }, [connected, models, task]);
  return models;
}
