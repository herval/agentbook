// What a thread's page shows past its usual cut, until you leave it: all its steps (its latest 12 otherwise), all its
// images (its latest 8), its whole conversation (its last three messages, or ?messages=all).
import { create } from "zustand";

interface ThreadUi {
  stepsAll: boolean;
  shotsAll: boolean;
  convoAll: boolean;
}
export const useThreadUi = create<ThreadUi>(() => ({ stepsAll: false, shotsAll: false, convoAll: false }));
export const setThreadUi = (o: Partial<ThreadUi>) => useThreadUi.setState(o);
export const resetThreadUi = () => useThreadUi.setState({ stepsAll: false, shotsAll: false, convoAll: false });
