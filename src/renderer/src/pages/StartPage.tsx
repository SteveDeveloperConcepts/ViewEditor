// Where a first-time user lands: the ways to start something, large and plain.

import type { ReactNode } from 'react';
import { CircleDot, FileText, Scissors, Sparkles } from 'lucide-react';
import { startBlankProject } from '@/lib/projects';
import { openStartDialog } from '@/lib/startDialog';
import { openRecorder } from '@/recorder/openRecorder';
import { navigate } from '@/store/ui';

function Tile({ icon, title, hint, onClick }: { icon: ReactNode; title: string; hint: string; onClick: () => void }): ReactNode {
  return (
    <button type="button" className="start-tile" onClick={onClick}>
      <span className="start-tile-icon">{icon}</span>
      <strong>{title}</strong>
      <span className="muted">{hint}</span>
    </button>
  );
}

export function StartPage(): ReactNode {
  return (
    <div className="page start-page">
      <h1>What would you like to make?</h1>
      <div className="start-grid">
        <Tile icon={<Scissors size={22} />} title="Edit my footage" hint="Cut, caption and finish a video you already have" onClick={() => openStartDialog()} />
        <Tile icon={<Sparkles size={22} />} title="Generate with AI" hint="Make clips and pictures with your own AI service" onClick={() => void startBlankProject({}, true)} />
        <Tile icon={<FileText size={22} />} title="Video from a script" hint="Turn your words into a narrated video" onClick={() => void navigate({ page: 'script' })} />
        <Tile icon={<CircleDot size={22} />} title="Record" hint="Your screen, your camera, or both" onClick={() => void openRecorder({})} />
      </div>
      <p className="faint">Or drop a video anywhere on this window to start editing it.</p>
    </div>
  );
}
