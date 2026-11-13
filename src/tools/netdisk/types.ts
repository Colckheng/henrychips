import type { NetdiskSession } from './session.js';

export type NetdiskPlatform =
  | 'lanzou' | 'ilanzou' | 'guangya' | 'quark' | 'uc' | 'pan115'
  | 'c139' | 'pan123' | 'xunlei' | 'baidu';

export interface ParsedShare {
  platform: NetdiskPlatform;
  shareId: string;
  code: string | null;
  /** Full share link, handed to the platform adapter. */
  shareUrl: string;
  /** Known only when the link shape states it; undefined means unknown. */
  isDirectory?: boolean;
}

/** One entry of a share: a file or a folder inside it. */
export interface NetdiskFile {
  id: string;
  /**
   * The path of the entry inside the share. It is the readable relative
   * path of the entry, so a user can read it, paste it into the tool and
   * find the entry again.
   */
  path: string;
  name: string;
  sizeBytes: number | null;
  isDirectory: boolean;
  modifiedAt?: string;
  /**
   * The signed address of the member, when the platform hands one out. The
   * address is what the download is started from, so it is kept apart from
   * the path the user reads.
   */
  fidToken?: string;
}

/** Everything needed to rebuild the link of a file when the link expired. */
export interface NetdiskSource {
  platform: NetdiskPlatform;
  shareUrl: string;
  code: string | null;
  filePath: string;
  fileId: string;
}

/** A direct link that was probed and confirmed before it was handed out. */
export interface NetdiskLink {
  path: string;
  name: string;
  sizeBytes: number | null;
  url: string;
  /** The headers the download needs, without any account credential. */
  headers: Record<string, string>;
  rangeSupported: boolean | null;
  expiresAt?: string;
  source: NetdiskSource;
  note?: string;
}

export interface NetdiskShare {
  title: string;
  files: NetdiskFile[];
  /** The session state of the platform, only valid inside one run. */
  token?: unknown;
}

export interface PlatformCredential {
  bduss?: string;
  username?: string;
  password?: string;
  /** An access token of a platform that cannot be signed in to automatically. */
  token?: string;
}

/** What an adapter gets to work with. */
export interface AdapterContext {
  session: NetdiskSession;
  shareId: string;
  shareUrl: string;
  code: string | null;
  credential: PlatformCredential | null;
  signal: AbortSignal;
  reportProgress: (phase: string, percent?: number) => void;
}

/**
 * The contract every platform speaks. The adapter knows the protocol of its
 * platform only; the session holds the cookies and the pacing.
 *
 * The message of an error an adapter throws reaches the caller, so it must
 * not carry a credential of the account. A platform hands out its own token
 * in the body of its answers, so the message must not quote that body
 * either.
 */
export interface NetdiskAdapter {
  platform: NetdiskPlatform;
  label: string;
  /** The platform cannot be read without a credential of the user. */
  requiresCredential: boolean;
  list(context: AdapterContext): Promise<NetdiskShare>;
  link(context: AdapterContext, file: NetdiskFile): Promise<NetdiskLink>;
}
