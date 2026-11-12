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
