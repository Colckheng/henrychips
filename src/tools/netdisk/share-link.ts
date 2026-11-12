import type { NetdiskPlatform, ParsedShare } from './types.js';

export const NETDISK_PLATFORM_LABELS: Record<NetdiskPlatform, string> = {
  lanzou: '蓝奏云', ilanzou: '蓝奏云优享版', guangya: '光鸭云盘', quark: '夸克网盘',
  uc: 'UC 网盘', pan115: '115 网盘', c139: '139（和彩云）', pan123: '123 云盘',
  xunlei: '迅雷网盘', baidu: '百度网盘',
};

// The lanzou domain family is spelled out once so host detection and share id
// extraction can never disagree about what counts as a lanzou host.
const lanzouFamily = 'lanzou[a-z0-9-]*|lan[zs]o[ux]|lanzn';
const lanzouHostRegex = new RegExp(`^(?:[a-z0-9-]+\\.)*(?:${lanzouFamily})\\.(?:com|net|org|cn)$`);
const lanzouPattern = new RegExp(`(?:^|[/.])(?:${lanzouFamily})\\.(?:com|net|org|cn)\\/([A-Za-z0-9]+)`, 'i');

export function isLanzouHost(host: string): boolean {
  return lanzouHostRegex.test(host.toLowerCase());
}

interface Rule { platform: NetdiskPlatform; pattern: RegExp }

// The ilanzou rule stays in this list so it is matched before the lanzou
// family: both live on similar domains and must not be mixed up.
const rules: Rule[] = [
  { platform: 'quark', pattern: /pan\.quark\.cn\/s\/([A-Za-z0-9]+)/i },
  { platform: 'uc', pattern: /drive\.uc\.cn\/s\/([A-Za-z0-9]+)/i },
  { platform: 'xunlei', pattern: /pan\.xunlei\.com\/s\/([A-Za-z0-9_-]+)/i },
  { platform: 'baidu', pattern: /pan\.baidu\.com\/s\/(1[A-Za-z0-9_-]+)/i },
  { platform: 'c139', pattern: /yun\.139\.com\/shareweb\/.*?\/w\/i\/([A-Za-z0-9_-]+)/i },
  { platform: 'pan123', pattern: /123(?:865|pan)\.(?:com|cn)\/s\/([A-Za-z0-9]+-[A-Za-z0-9]+)/i },
  { platform: 'pan123', pattern: /share\.123pan\.cn\/123pan\/([A-Za-z0-9-]+)/i },
  { platform: 'pan123', pattern: /api\/srr\?sk=([A-Za-z0-9-]+)/i },
  { platform: 'pan115', pattern: /115(?:cdn|rc)?\.com\/s\/(sw[A-Za-z0-9]+)/i },
  { platform: 'guangya', pattern: /guangyapan\.com\/s\/([A-Za-z0-9_-]+)/i },
  { platform: 'ilanzou', pattern: /(?:^|[/.])ilanzou\.(?:com|net|org|cn)\/s\/([A-Za-z0-9_-]+)/i },
];

// Share messages glue Chinese prose onto the link, so only the ASCII run that
// starts with the scheme can belong to the URL itself.
const urlRegex = /https?:\/\/[\x21-\x7e]+/;
const codeInUrl = /[?&](?:pwd|pass|passcode|password)=([A-Za-z0-9]+)/i;
const codeInText = /(?:提取码|访问码|密码)[：:]\s*([A-Za-z0-9]{4,8})/;
const pan115Command = /115(?:cdn|rc)?\.com\/(sw[A-Za-z0-9]{8,})-([A-Za-z0-9]{4,8})/i;

export function parseShareLink(text: string): ParsedShare | null {
  const trimmed = text.trim();
  const raw = urlRegex.exec(trimmed)?.[0];
  if (!raw) return null;
  try { new URL(raw); }
  catch { return null; }
  const codeFromText = codeInText.exec(trimmed)?.[1] ?? null;

  const command = pan115Command.exec(raw);
  if (command) {
    // A passcode in the query wins over the one embedded in the 115 command.
    const code = codeInUrl.exec(raw)?.[1] ?? command[2] ?? codeFromText;
    return { platform: 'pan115', shareId: command[1], code, shareUrl: raw };
  }

  for (const rule of rules) {
    const matched = rule.pattern.exec(raw);
    if (!matched) continue;
    const code = codeInUrl.exec(raw)?.[1] ?? codeFromText;
    // The baidu surl keeps a leading "1" that the API does not want.
    const shareId = rule.platform === 'baidu' ? matched[1].replace(/^1/, '') : matched[1];
    return { platform: rule.platform, shareId, code: code ?? null, shareUrl: raw };
  }

  const lanzou = lanzouPattern.exec(raw);
  if (lanzou) {
    const code = codeInUrl.exec(raw)?.[1] ?? codeFromText;
    return { platform: 'lanzou', shareId: lanzou[1], code: code ?? null, shareUrl: raw };
  }
  return null;
}
