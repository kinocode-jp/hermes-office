type OfficeSynchronizationBarrier = {
  authRevision: number;
  state: "pending" | "resolved" | "rejected";
  promise: Promise<void>;
  resolve(): void;
  reject(error: Error): void;
};

type SynchronizationObserver = (serverUrl: string, authRevision: number) => void;

const barriers = new Map<string, OfficeSynchronizationBarrier>();
const synchronizedObservers = new Set<SynchronizationObserver>();
const synchronizationRequestObservers = new Set<SynchronizationObserver>();

function createBarrier(serverUrl: string, authRevision: number): OfficeSynchronizationBarrier {
  let resolvePromise!: () => void;
  let rejectPromise!: (error: Error) => void;
  const promise = new Promise<void>((resolve, reject) => { resolvePromise = resolve; rejectPromise = reject; });
  void promise.catch(() => undefined);
  const barrier: OfficeSynchronizationBarrier = {
    authRevision,
    state: "pending",
    promise,
    resolve() {
      if (barrier.state !== "pending") return;
      barrier.state = "resolved";
      resolvePromise();
    },
    reject(error) {
      if (barrier.state !== "pending") return;
      barrier.state = "rejected";
      rejectPromise(error);
    },
  };
  barriers.set(serverUrl, barrier);
  return barrier;
}

export function subscribeOfficeSessionSynchronizations(observer: SynchronizationObserver): () => void {
  synchronizedObservers.add(observer);
  return () => synchronizedObservers.delete(observer);
}

export function subscribeOfficeSynchronizationRequests(observer: SynchronizationObserver): () => void {
  synchronizationRequestObservers.add(observer);
  return () => synchronizationRequestObservers.delete(observer);
}

export function beginOfficeSynchronization(serverUrl: string, authRevision: number, supersededError: Error): void {
  const previous = barriers.get(serverUrl);
  if (previous?.authRevision === authRevision && previous.state === "pending") return;
  previous?.reject(supersededError);
  createBarrier(serverUrl, authRevision);
}

export async function waitForOfficeSynchronization(serverUrl: string, authRevision: number, signal?: AbortSignal): Promise<void> {
  let barrier = barriers.get(serverUrl);
  if (!barrier || barrier.authRevision !== authRevision || barrier.state === "resolved") return;
  if (barrier.state === "rejected") {
    barrier = createBarrier(serverUrl, authRevision);
    for (const observer of synchronizationRequestObservers) observer(serverUrl, authRevision);
  }
  if (signal?.aborted) throw new DOMException("Chat recovery was cancelled.", "AbortError");
  if (!signal) return await barrier.promise;
  await new Promise<void>((resolve, reject) => {
    const abort = () => reject(new DOMException("Chat recovery was cancelled.", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    void barrier.promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export function rejectOfficeSynchronization(serverUrl: string, authRevision: number, error: Error): void {
  const barrier = barriers.get(serverUrl);
  if (barrier?.authRevision === authRevision) barrier.reject(error);
}

export function resolveOfficeSynchronization(serverUrl: string, authRevision: number): void {
  const barrier = barriers.get(serverUrl);
  if (barrier?.authRevision !== authRevision) return;
  barrier.resolve();
  for (const observer of synchronizedObservers) observer(serverUrl, authRevision);
}
