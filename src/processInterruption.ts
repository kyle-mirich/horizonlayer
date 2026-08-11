export type InterruptionCheck = () => void;

export interface SignalHost {
  once: (event: 'SIGINT' | 'SIGTERM', listener: () => void) => unknown;
  removeListener: (event: 'SIGINT' | 'SIGTERM', listener: () => void) => unknown;
}

export async function withDeferredSignalInterruption<T>(
  operation: (checkInterruption: InterruptionCheck) => Promise<T>,
  interrupted: (signal: 'SIGINT' | 'SIGTERM') => Error,
  signalHost: SignalHost = process
): Promise<T> {
  let interruptedBy: 'SIGINT' | 'SIGTERM' | null = null;
  const onSigint = () => {
    interruptedBy ??= 'SIGINT';
  };
  const onSigterm = () => {
    interruptedBy ??= 'SIGTERM';
  };
  signalHost.once('SIGINT', onSigint);
  signalHost.once('SIGTERM', onSigterm);
  try {
    return await operation(() => {
      if (interruptedBy) throw interrupted(interruptedBy);
    });
  } finally {
    signalHost.removeListener('SIGINT', onSigint);
    signalHost.removeListener('SIGTERM', onSigterm);
  }
}
