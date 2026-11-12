import type { NetdiskPlatform, ParsedShare } from './types.js';

export const NETDISK_PLATFORM_LABELS: Record<NetdiskPlatform, string> = {
  lanzou: '蓝奏云', ilanzou: '蓝奏云优享版', guangya: '光鸭云盘', quark: '夸克网盘',
  uc: 'UC 网盘', pan115: '115 网盘', c139: '139（和彩云）', pan123: '123 云盘',
  xunlei: '迅雷网盘', baidu: '百度网盘',
};

// The domain families are spelled out once and each one drives both the host
// matcher and the share id extraction, so the recognizer and isLanzouHost can
// never disagree about what counts as a host of that family.
const lanzouFamily = 'lanzou[a-z0-9-]*|lan[zs]o[ux]|lanzn';
const ilanzouFamily = 'ilanzou';
const hostSuffix = '(?:com|net|org|cn)';

function familyHostRegex(family: string): RegExp {
  return new RegExp(`^(?:[a-z0-9-]+\\.)*(?:${family})\\.${hostSuffix}$`);
}

const lanzouHostRegex = familyHostRegex(lanzouFamily);
const ilanzouHostRegex = familyHostRegex(ilanzouFamily);

export function isLanzouHost(host: string): boolean {
  return lanzouHostRegex.test(host.toLowerCase());
}

interface Rule {
  platform: NetdiskPlatform;
  /** Anchored against the parsed hostname, never against the raw URL text. */
  host: RegExp;
  /** Matched against the parsed path, with query or hash appended when needed. */
  path: RegExp;
  tail?: 'query' | 'hash';
}

// The ilanzou rule is not in this list because it shares the lanzou path
// shapes; both families are handled by their own host matchers below.
const rules: Rule[] = [
  { platform: 'quark', host: /^(?:www\.)?pan\.quark\.cn$/, path: /^\/s\/([A-Za-z0-9]+)/i },
  { platform: 'uc', host: /^(?:www\.)?drive\.uc\.cn$/, path: /^\/s\/([A-Za-z0-9]+)/i },
  { platform: 'xunlei', host: /^(?:www\.)?pan\.xunlei\.com$/, path: /^\/s\/([A-Za-z0-9_-]+)/i },
  { platform: 'baidu', host: /^(?:www\.)?pan\.baidu\.com$/, path: /^\/s\/(1[A-Za-z0-9_-]+)/i },
  { platform: 'c139', host: /^yun\.139\.com$/, path: /^\/shareweb.*?\/w\/i\/([A-Za-z0-9_-]+)/i, tail: 'hash' },
  { platform: 'pan123', host: /^(?:www\.)?123(?:865|pan)\.(?:com|cn)$/, path: /^\/s\/([A-Za-z0-9]+-[A-Za-z0-9]+)/i },
  { platform: 'pan123', host: /^(?:www\.)?123(?:865|pan)\.(?:com|cn)$/, path: /^\/api\/srr\?sk=([A-Za-z0-9-]+)/i, tail: 'query' },
  { platform: 'pan123', host: /^share\.123pan\.cn$/, path: /^\/123pan\/([A-Za-z0-9-]+)/i },
  { platform: 'pan115', host: /^(?:www\.)?115(?:cdn|rc)?\.com$/, path: /^\/s\/(sw[A-Za-z0-9]+)/i },
  { platform: 'guangya', host: /^(?:www\.)?guangyapan\.com$/, path: /^\/s\/([A-Za-z0-9_-]+)/i },
];

// The 115 command form carries its passcode inside the path, so it is matched
// before the generic rules and reports that embedded code.
const pan115Command = {
  host: /^(?:www\.)?115(?:cdn|rc)?\.com$/,
  path: /^\/(sw[A-Za-z0-9]{8,})-([A-Za-z0-9]{4,8})/i,
};

interface LanzouPath {
  shareId: string;
  isDirectory?: boolean;
}

// Lanzou and its premium edition share the same path shapes: a bare share id,
// or a reserved single letter prefix in front of the share id. "b" marks a
// folder share and "i" marks a file share, any other prefix says nothing
// about the kind of share.
function parseLanzouPath(pathname: string): LanzouPath | null {
  const segments = pathname.split('/').filter(Boolean);
  if (!segments.length) return null;
  const prefix = segments[0];
  // A single letter is a reserved prefix, so the share id is the next segment.
  if (prefix.length === 1) {
    if (segments.length < 2) return null;
    const shareId = segments[1];
    if (!/^[A-Za-z0-9]+$/.test(shareId)) return null;
    const marker = prefix.toLowerCase();
    if (marker === 'b') return { shareId, isDirectory: true };
    if (marker === 'i') return { shareId, isDirectory: false };
    return { shareId };
  }
  if (!/^[A-Za-z0-9]+$/.test(prefix)) return null;
  return { shareId: prefix };
}

// Share messages glue Chinese prose onto the link, so only the ASCII run that
// starts with the scheme can belong to the URL itself.
const urlRun = /https?:\/\/[\x21-\x7e]+/gi;
// Sentence punctuation that follows a link in prose is not part of the URL.
const trailingPunctuation = /[.,;:!?)\]}>'"*]+$/;
const codeInUrl = /[?&](?:pwd|pass|passcode|password)=([A-Za-z0-9]+)/i;
// Only the two keywords the platforms actually use. A bare "密码" would also
// match an archive password such as "解压密码", which is not a share passcode.
const codeInText = /(?:提取码|访问码)[：:]\s*([A-Za-z0-9]{3,})/;

function parseCandidate(raw: string, codeFromText: string | null): ParsedShare | null {
  let url: URL;
  try { url = new URL(raw); }
  catch { return null; }
  const host = url.hostname;
  const queryCode = codeInUrl.exec(url.search)?.[1] ?? null;

  if (pan115Command.host.test(host)) {
    const command = pan115Command.path.exec(url.pathname);
    if (command) {
      // A passcode in the query wins over the one embedded in the 115 command.
      return { platform: 'pan115', shareId: command[1], code: queryCode ?? command[2] ?? codeFromText, shareUrl: raw };
    }
  }

  for (const rule of rules) {
    if (!rule.host.test(host)) continue;
    const target = rule.tail === 'query' ? `${url.pathname}${url.search}`
      : rule.tail === 'hash' ? `${url.pathname}${url.hash}`
      : url.pathname;
    const matched = rule.path.exec(target);
    if (!matched) continue;
    // The baidu surl keeps a leading "1" that the API does not want.
    const shareId = rule.platform === 'baidu' ? matched[1].replace(/^1/, '') : matched[1];
    return { platform: rule.platform, shareId, code: queryCode ?? codeFromText, shareUrl: raw };
  }

  for (const [platform, hostRegex] of [['ilanzou', ilanzouHostRegex], ['lanzou', lanzouHostRegex]] as const) {
    if (!hostRegex.test(host)) continue;
    const path = parseLanzouPath(url.pathname);
    if (!path) continue;
    return { platform, shareId: path.shareId, code: queryCode ?? codeFromText, shareUrl: raw, isDirectory: path.isDirectory };
  }
  return null;
}

export function parseShareLink(text: string): ParsedShare | null {
  const trimmed = text.trim();
  const codeFromText = codeInText.exec(trimmed)?.[1] ?? null;
  // A message may carry unrelated links, so every candidate is tried and the
  // first one that matches a platform wins.
  for (const matched of trimmed.matchAll(urlRun)) {
    const raw = matched[0].replace(trailingPunctuation, '');
    if (!raw) continue;
    const parsed = parseCandidate(raw, codeFromText);
    if (parsed) return parsed;
  }
  return null;
}
