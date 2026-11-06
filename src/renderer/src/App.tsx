import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { startApplyingJobs } from '@/ai/applyJobs';
import { MenuHost } from '@/components/Menu';
import { ModalHost } from '@/components/Modal';
import { RenderWatcher } from '@/components/RenderWatcher';
import { DashTop, Sidebar } from '@/components/Shell';
import { Toasts } from '@/components/Toasts';
import { Spinner } from '@/components/ui';
import { UpdateBanner } from '@/components/UpdateBanner';
import { EditorPage, saveAndThumbnail } from '@/editor/EditorPage';
import { droppedPaths, hasFiles } from '@/editor/importing';
import { api } from '@/lib/api';
import { startIntake } from '@/lib/intake';
import { discardIfUnused } from '@/lib/projects';
import { startFromFiles } from '@/lib/startDialog';
import { AssetsPage } from '@/pages/AssetsPage';
import { BrandPage } from '@/pages/BrandPage';
import { CreateAssetPage } from '@/pages/CreateAssetPage';
import { LibraryPage } from '@/pages/LibraryPage';
import { ScriptPage } from '@/pages/ScriptPage';
import { TemplatesPage } from '@/pages/TemplatesPage';
import { VideoPage } from '@/pages/VideoPage';
import { loadProviders } from '@/store/ai';
import { useEditor } from '@/store/editor';
import { useLibrary } from '@/store/library';
import { useUi, type Route } from '@/store/ui';

function Page({ route }: { route: Route }): ReactNode {
  switch (route.page) {
    case 'script':
      return <ScriptPage key={JSON.stringify(route.prefill ?? null)} prefill={route.prefill} />;
    case 'library':
      return <LibraryPage view={route.view} />;
    case 'assets':
      return <AssetsPage />;
    case 'brand':
      return <BrandPage />;
    case 'templates':
      return <TemplatesPage />;
    case 'create-asset':
      return <CreateAssetPage />;
    case 'video':
      return <VideoPage projectId={route.projectId} />;
    case 'editor':
      return null;
  }
}

/** The dashboard. Files dropped anywhere on it start a project, unless the page has a use for them itself. */
function Dashboard({ route }: { route: Route }): ReactNode {
  const [over, setOver] = useState(false);
  return (
    <div
      className={`shell${over ? ' dropping' : ''}`}
      onDragOver={(e) => {
        if (!hasFiles(e.dataTransfer)) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        void startFromFiles(droppedPaths(e.dataTransfer));
      }}
    >
      <Sidebar />
      <div className="shell-main">
        <DashTop />
        <Page route={route} />
      </div>
    </div>
  );
}

export function App(): ReactNode {
  const route = useUi((s) => s.route);
  const ready = useLibrary((s) => !!s.lib);

  useEffect(() => {
    const stopIntake = startIntake();
    const stopJobs = startApplyingJobs();
    void loadProviders();
    const offClosing = api.on('app:closing', () => {
      void saveAndThumbnail()
        .then(() => discardIfUnused(useEditor.getState().doc))
        .catch(() => undefined)
        .finally(() => void api.app.readyToClose());
    });
    // A file dropped anywhere that does not accept it must not make the window navigate to it.
    const block = (e: DragEvent): void => e.preventDefault();
    window.addEventListener('dragover', block);
    window.addEventListener('drop', block);
    return () => {
      stopIntake();
      stopJobs();
      offClosing();
      window.removeEventListener('dragover', block);
      window.removeEventListener('drop', block);
    };
  }, []);

  if (!ready) {
    return (
      <div className="page-center">
        <Spinner large />
      </div>
    );
  }

  return (
    <div className="app-frame">
      <UpdateBanner />
      <div className="app-page">
        {route.page === 'editor' ? (
          <EditorPage key={route.projectId} projectId={route.projectId} showAi={route.showAi} add={route.add} />
        ) : (
          <Dashboard route={route} />
        )}
      </div>
      <RenderWatcher />
      <ModalHost />
      <MenuHost />
      <Toasts />
    </div>
  );
}
