import { messageOf } from './errors';

interface DeleteMutation {
  mutate: (
    id: string,
    options: { onError: (error: unknown) => void; onSettled: () => void },
  ) => void;
}

interface DeleteContext {
  mutation: DeleteMutation;
  setBusyId: (id: string | null) => void;
  setNotice: (notice: string | null) => void;
}

export function deleteWithNotice({
  mutation,
  setBusyId,
  setNotice,
}: DeleteContext): (id: string, confirmText: string) => void {
  return (id, confirmText) => {
    if (!window.confirm(confirmText)) return;
    setBusyId(id);
    setNotice(null);
    mutation.mutate(id, {
      onError: (error) => setNotice(messageOf(error)),
      onSettled: () => setBusyId(null),
    });
  };
}