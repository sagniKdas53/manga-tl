import { create } from "zustand";

export interface UploadQueueItem {
  id: string;
  name: string;
  progress: number;
  status: "pending" | "uploading" | "completed" | "failed";
  error?: string;
}

interface UploadStoreState {
  uploadQueue: UploadQueueItem[];
  showQueuePanel: boolean;
  isQueueExpanded: boolean;
  addItems: (items: UploadQueueItem[]) => void;
  updateItemProgress: (id: string, progress: number) => void;
  setItemStatus: (
    id: string,
    status: UploadQueueItem["status"],
    error?: string,
  ) => void;
  clearQueue: () => void;
  setShowQueuePanel: (show: boolean) => void;
  setIsQueueExpanded: (expanded: boolean) => void;
}

export const useUploadStore = create<UploadStoreState>((set) => ({
  uploadQueue: [],
  showQueuePanel: false,
  isQueueExpanded: true,

  addItems: (items) =>
    set((state) => ({
      uploadQueue: [...state.uploadQueue, ...items],
      showQueuePanel: true,
      isQueueExpanded: true,
    })),

  updateItemProgress: (id, progress) =>
    set((state) => ({
      uploadQueue: state.uploadQueue.map((item) =>
        item.id === id ? { ...item, progress } : item,
      ),
    })),

  setItemStatus: (id, status, error) =>
    set((state) => {
      const isCompleted = status === "completed";
      return {
        uploadQueue: state.uploadQueue.map((item) =>
          item.id === id
            ? {
                ...item,
                status,
                ...(error ? { error } : {}),
                ...(isCompleted ? { progress: 100 } : {}),
              }
            : item,
        ),
      };
    }),

  clearQueue: () =>
    set(() => ({
      uploadQueue: [],
      showQueuePanel: false,
    })),

  setShowQueuePanel: (show) => set({ showQueuePanel: show }),
  setIsQueueExpanded: (expanded) => set({ isQueueExpanded: expanded }),
}));
