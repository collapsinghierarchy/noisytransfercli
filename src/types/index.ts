export type Mode = "dtls" | "pq";

export interface CommonOpts {
  relay?: string;
  headers?: Record<string, string>;
  pq?: boolean;
  yes?: boolean;
}

export interface SendOptions extends CommonOpts {
  app?: string;
  name?: string;
  stdinName?: string;
  size?: number; // required when sending from stdin ("-")
}

export interface RecvOptions extends CommonOpts {
  app?: string;
  overwrite?: boolean;
}

export interface RecvResult {
  bytesWritten: number;
  announcedBytes: number;
  label: string | null;
  path: string | null;
  mode: Mode;
  appID: string;
}

/** Programmatic send (CLI-equivalent). */
export declare function send(
  paths: string[],
  opts: SendOptions,
  ctx?: { logger?: any }
): Promise<{ bytesSent: number; appID: string; mode: Mode }>;

/** Programmatic recv (CLI-equivalent). */
export declare function recv(
  outDir: string,
  opts: RecvOptions,
  ctx?: { logger?: any }
): Promise<RecvResult>;

/** Rendezvous helpers */
export declare function createCode(args: {
  relay?: string;      // if you support relay
  apiBase?: string;    // if you support apiBase
  headers?: Record<string, string>;
  ttlSec?: number;     // use ttlSec if that’s your real option
}): Promise<{ status: "ok"; appID: string; code: string; expiresAt: string } | { status: string; error: string }>;

export declare function redeemCode(args: {
  relay?: string;
  apiBase?: string;
  code: string;
  headers?: Record<string, string>;
}): Promise<{ status: "ok"; appID: string; expiresAt: string } | { status: string; error: string }>;
