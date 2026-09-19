/**
 * Console output for the app bundle, in two tiers.
 *
 * A guest's device log is not retrievable by anyone who could act on it, so narration here is
 * never telemetry — it is a development aid and nothing else. The informational and warning
 * writers therefore read the bundler's build-time development flag directly, so a release
 * build substitutes the literal and drops the console call itself. The call site still
 * builds its own arguments, so keep an expensive message expression out of a hot path.
 *
 * Errors are not gated: an operation that failed in a way that degrades what the person
 * gets is worth a line wherever it happens.
 *
 * The distinction is settled when the bundle is built. Nothing here is a runtime setting and
 * no surface exposes it.
 */

export function logInfo(message: string, ...rest: unknown[]): void {
  if (!__DEV__) {
    return;
  }
  console.info(message, ...rest);
}

export function logWarn(message: string, ...rest: unknown[]): void {
  if (!__DEV__) {
    return;
  }
  console.warn(message, ...rest);
}

export function logError(message: string, cause?: unknown): void {
  if (cause === undefined) {
    console.error(message);
    return;
  }
  console.error(message, cause);
}
