import { ToolError } from '../../core/errors.js';
import { parseShareLink } from './share-link.js';
import type { NetdiskSession } from './session.js';
import type { NetdiskFile, NetdiskPlatform, PlatformCredential } from './types.js';

/** The information of a task that is needed to fetch a new direct link. */
export interface RefreshSource {
  platform: NetdiskPlatform;
  shareUrl: string;
  code: string | null;
  filePath: string;
  fileId: string;
}

export interface RefreshContext {
  session: NetdiskSession;
  shareId: string;
  shareUrl: string;
  code: string | null;
  credential: PlatformCredential | null;
  signal: AbortSignal;
  reportProgress: (phase: string, percent?: number) => void;
}

/**
 * Rebuilds the context of an adapter from the source of a task.
 *
 * The source keeps the share link but not the share id, and every adapter
 * asks for the id, not for the link. So the id is read back from the link.
 * A link that cannot be read again cannot produce a new direct link.
 */
export function contextForRefresh(
  source: RefreshSource,
  options: { session: NetdiskSession; credential: PlatformCredential | null; signal: AbortSignal },
): RefreshContext {
  const parsed = parseShareLink(source.shareUrl);
  if (!parsed || parsed.platform !== source.platform) {
    throw new ToolError('TOOL_FAILED', '无法从分享链接还原分享码，请重新解析该分享。');
  }
  return {
    session: options.session,
    shareId: parsed.shareId,
    shareUrl: source.shareUrl,
    // The code of the task wins, because it may have been given by hand
    // while the link carried none.
    code: source.code ?? parsed.code,
    credential: options.credential,
    signal: options.signal,
    reportProgress: () => {},
  };
}

/** The file of the task, as an adapter wants it. */
export function fileForRefresh(source: RefreshSource, name: string, sizeBytes: number | null): NetdiskFile {
  return {
    id: source.fileId,
    path: source.filePath,
    name,
    sizeBytes,
    isDirectory: false,
  };
}
