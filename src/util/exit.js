import { EXIT } from "../env/exit-codes.js";

// Best-effort classification. We avoid importing heavy deps here.
export function mapErrorToExitCode(err) {
  if (!err) return EXIT.GENERIC;
  const name = err.name || "";
 const code = err.code || "";

  // bad args / usage
  if (
    name === "BadArgsError" ||
    code === "ERR_INVALID_ARG_VALUE" ||
    code === "ERR_ASSERTION"
 ) {
    return EXIT.BAD_ARGS;
  }

  // I/O / filesystem / stdout closed
  if (
    name === "IoError" ||
    code === "EPIPE" ||
    code === "ENOENT" ||
    code === "EACCES" ||
    code === "EPERM" ||
    code === "ENOSPC"
  ) {
    return EXIT.IO;
  }

  // network / fetch
  if (
    name === "FetchError" ||
    code === "ECONNREFUSED" ||
    code === "ETIMEDOUT" ||
    code === "ENOTFOUND" ||
    code === "EAI_AGAIN"
  ) {
    return EXIT.NET;
  }

  // signaling / rtc / auth
  if (name === "SignalingError") return EXIT.SIGNALING;
  if (name === "RtcError") return EXIT.RTC;
  if (name === "AuthError") return EXIT.AUTH;
  // cancellations
  if (name === "AbortError" || name === "CanceledError") return EXIT.CANCELED;

  return EXIT.GENERIC;
}
