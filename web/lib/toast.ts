import { create } from "zustand";

export interface Toast {
  message: string;
  action?: { label: string; run: () => void };
  n: number;
}
export const useToast = create<{ toast: Toast | null }>(() => ({ toast: null }));

let timer: ReturnType<typeof setTimeout> | undefined;
let n = 0;
export function toast(message: string, action?: { label: string; run: () => void }) {
  useToast.setState({ toast: { message, action, n: ++n } });
  clearTimeout(timer);
  timer = setTimeout(() => useToast.setState({ toast: null }), 5000);
}
export const hideToast = () => useToast.setState({ toast: null });
