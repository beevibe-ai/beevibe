import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  api,
  type ApproveTaskInput,
  type RejectTaskInput,
  type ReviseTaskInput,
  type CancelTaskInput,
  type CreateTaskInput,
} from "@/lib/api/client";
import { queryKeys } from "./keys";

function useTaskMutationInvalidations(taskId: string) {
  const client = useQueryClient();
  return () => {
    client.invalidateQueries({ queryKey: queryKeys.tasks.detail(taskId) });
    client.invalidateQueries({ queryKey: queryKeys.tasks.all });
    client.invalidateQueries({ queryKey: queryKeys.dashboard.all });
  };
}

export function useApproveTask(taskId: string) {
  const onSuccess = useTaskMutationInvalidations(taskId);
  return useMutation({
    mutationFn: (input: ApproveTaskInput = {}) => api.tasks.approve(taskId, input),
    onSuccess,
  });
}

export function useRejectTask(taskId: string) {
  const onSuccess = useTaskMutationInvalidations(taskId);
  return useMutation({
    mutationFn: (input: RejectTaskInput = {}) => api.tasks.reject(taskId, input),
    onSuccess,
  });
}

export function useReviseTask(taskId: string) {
  const onSuccess = useTaskMutationInvalidations(taskId);
  return useMutation({
    mutationFn: (input: ReviseTaskInput) => api.tasks.revise(taskId, input),
    onSuccess,
  });
}

export function useCancelTask(taskId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CancelTaskInput = {}) => api.tasks.cancel(taskId, input),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: queryKeys.tasks.detail(taskId) });
      client.invalidateQueries({ queryKey: queryKeys.tasks.all });
    },
  });
}

export function useCreateTask() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateTaskInput) => api.tasks.create(input),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: queryKeys.tasks.all });
      client.invalidateQueries({ queryKey: queryKeys.dashboard.all });
    },
  });
}
