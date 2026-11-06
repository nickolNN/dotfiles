import ModalShell from './ModalShell';
import RetroRunControls from './retro-run-modal/RetroRunControls';
import RetroRunHistory from './retro-run-modal/RetroRunHistory';
import RetroRunOutput from './retro-run-modal/RetroRunOutput';
import { useRetroRun } from './retro-run-modal/useRetroRun';

interface RetroRunModalProps {
  open: boolean;
  onClose: () => void;
}

export default function RetroRunModal({ open, onClose }: RetroRunModalProps) {
  const state = useRetroRun(open);

  if (!open) return null;

  return (
    <ModalShell
      onClose={onClose}
      overlayTestId="retro-modal"
      closeTestId="retro-close"
      dialogLabel="Память и ретро"
      title={
        <>
          <h2 className="text-base font-semibold">Память и ретро</h2>
          <p className="mt-1 text-xs text-[#00FF41]/50">
            Сессия компактит память агента и проводит ретро по скиллу retro.
            Итог — markdown-отчёт, который можно отдать агенту для правок
            пайплайна.
          </p>
        </>
      }
      classes={{
        overlay: 'bg-black/70',
        card: 'border-[#008F11] bg-[#0D0208] p-4 text-[#00FF41]',
        header: 'items-start',
        body: 'space-y-4',
      }}
    >
      <RetroRunControls state={state} />
      <RetroRunOutput state={state} />
      <RetroRunHistory
        history={state.history}
        onOpen={(id) => void state.handleOpenRun(id)}
      />
    </ModalShell>
  );
}