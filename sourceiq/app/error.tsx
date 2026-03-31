'use client';

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex h-screen items-center justify-center bg-white dark:bg-slate-950 transition-colors">
      <div className="text-center space-y-4 max-w-md px-6">
        <h2 className="text-xl font-bold text-slate-800 dark:text-slate-100">Something went wrong</h2>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          {error.message || 'An unexpected error occurred.'}
        </p>
        <button
          onClick={reset}
          className="rounded-lg bg-blue-600 text-white px-4 py-2 text-sm font-medium hover:bg-blue-500 transition-colors"
        >
          Try again
        </button>
      </div>
    </div>
  );
}
