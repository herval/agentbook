import { useEffect, useRef } from "react";
import type { ReactNode } from "react";

export function Dialog({ open, onClose, className = "", label, children }: { open: boolean; onClose: () => void; className?: string; label?: string; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className={className || undefined}
      aria-label={label}
      onClose={(e) => {
        if (open && !e.currentTarget.open) onClose();
      }}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onMouseDown={(e) => e.target === ref.current && onClose()}
    >
      {open && children}
    </dialog>
  );
}
