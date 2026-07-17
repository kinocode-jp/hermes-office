/**
 * Applies a normalized save response only while the editor still contains the
 * exact submitted value. Input added while the request was in flight wins.
 */
export function preserveConcurrentDraft<T>(current: T, submitted: T, normalized: T): T {
  return Object.is(current, submitted) ? normalized : current;
}
