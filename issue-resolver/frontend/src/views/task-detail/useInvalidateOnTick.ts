import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";

export function useInvalidateOnTick(
  tick: number,
  id: string | null,
  key: string,
): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (tick === 0 || !id) return;
    void queryClient.invalidateQueries({ queryKey: [key, id] });
  }, [tick, id, key, queryClient]);
}