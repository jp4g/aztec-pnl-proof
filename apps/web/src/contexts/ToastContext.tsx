"use client";

import {
  createContext,
  useCallback,
  useState,
  useEffect,
  type ReactNode,
} from "react";

export interface Toast {
  id: number;
  message: string;
  type: "success" | "error";
}

export interface ToastContextValue {
  showToast: (message: string, type: "success" | "error") => void;
}

export const ToastContext = createContext<ToastContextValue | null>(null);

let nextId = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const showToast = useCallback(
    (message: string, type: "success" | "error") => {
      const id = nextId++;
      setToasts((prev) => [...prev, { id, message, type }]);
    },
    []
  );

  const removeToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      {/* Toast overlay */}
      <div className="fixed bottom-6 right-6 z-50 flex flex-col gap-3">
        {toasts.map((toast) => (
          <ToastItem key={toast.id} toast={toast} onDismiss={removeToast} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastItem({
  toast,
  onDismiss,
}: {
  toast: Toast;
  onDismiss: (id: number) => void;
}) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    // Trigger slide-in
    requestAnimationFrame(() => setVisible(true));

    const timer = setTimeout(() => {
      setVisible(false);
      // Wait for exit animation before removing
      setTimeout(() => onDismiss(toast.id), 300);
    }, 4000);

    return () => clearTimeout(timer);
  }, [toast.id, onDismiss]);

  const accentClass =
    toast.type === "success"
      ? "border-green-400 bg-green-50 text-green-800"
      : "border-red-400 bg-red-50 text-red-800";

  return (
    <div
      className={`px-4 py-3 rounded-lg border shadow-lg text-sm font-medium transition-all duration-300 ${accentClass} ${
        visible
          ? "translate-x-0 opacity-100"
          : "translate-x-8 opacity-0"
      }`}
    >
      {toast.message}
    </div>
  );
}
