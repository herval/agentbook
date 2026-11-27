import { hideToast, useToast } from "../lib/toast.ts";

export function Toaster() {
  const t = useToast((s) => s.toast);
  if (!t) return null;
  return (
    <div className="toast" key={t.n}>
      {t.message}
      {t.action && (
        <>
          {" "}
          <button
            type="button"
            className="toast-act"
            onClick={() => {
              hideToast();
              t.action.run();
            }}
          >
            {t.action.label}
          </button>
        </>
      )}
    </div>
  );
}
