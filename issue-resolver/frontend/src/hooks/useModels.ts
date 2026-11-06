import { useQuery } from '@tanstack/react-query';
import { getModels } from '../api/client';
import { queryKeys } from '../lib/query-keys';

export function useModels() {
  const query = useQuery({
    queryKey: queryKeys.models,
    queryFn: getModels,
    staleTime: 60_000,
  });
  return {
    models: Array.isArray(query.data) ? query.data : [],
    modelsLoading: query.isLoading,
  };
}
