import test from 'node:test';
import assert from 'node:assert/strict';
import { NETDISK_PLATFORM_LABELS, isLanzouHost, parseShareLink } from '../../src/tools/netdisk/share-link.js';

test('recognises each supported platform from a bare link', () => {
  const cases: Array<[string, string]> = [
    ['https://pan.quark.cn/s/2aB3cD4e5f', 'quark'],
    ['https://drive.uc.cn/s/2aB3cD4e5f', 'uc'],
    ['https://pan.xunlei.com/s/2aB3cD4e5f', 'xunlei'],
    ['https://pan.baidu.com/s/1AbCdEfGh', 'baidu'],
    ['https://yun.139.com/shareweb/#/w/i/AbCdEfGh', 'c139'],
    ['https://www.123pan.com/s/2785Vv-T4Ded', 'pan123'],
    ['https://www.123pan.cn/api/srr?sk=2785Vv-T4Ded&st=s', 'pan123'],
    ['https://115.com/s/swA1b2c3d4e', 'pan115'],
    ['https://115.com/sws8lxs36jf-n307/', 'pan115'],
    ['https://www.guangyapan.com/s/AbCdEfGh', 'guangya'],
    ['https://wwx.lanzoui.com/iXnuF4c8sqmb', 'lanzou'],
    ['https://user.lanzn.com/iXnuF4c8sqmb', 'lanzou'],
  ];
  for (const [url, platform] of cases) {
    const parsed = parseShareLink(url);
    assert.ok(parsed, url);
    assert.equal(parsed.platform, platform, url);
  }
});

test('extracts the passcode from the query and from the share text', () => {
  const fromQuery = parseShareLink('https://pan.quark.cn/s/2aB3cD4e5f?pwd=abcd');
  assert.equal(fromQuery?.code, 'abcd');
  const fromText = parseShareLink('【分享】https://pan.quark.cn/s/2aB3cD4e5f，提取码：wxyz');
  assert.equal(fromText?.code, 'wxyz');
  const fromPass = parseShareLink('https://lanzoui.com/iXnuF4c8sqmb?pass=QQQQ');
  assert.equal(fromPass?.code, 'QQQQ');
});

test('splits the baidu surl into its short form', () => {
  const parsed = parseShareLink('https://pan.baidu.com/s/1AbCdEfGh');
  assert.equal(parsed?.platform, 'baidu');
  assert.equal(parsed?.shareId, 'AbCdEfGh');
});

test('reads the 115 command form with an inline passcode', () => {
  const parsed = parseShareLink('https://115.com/sws8lxs36jf-n307/');
  assert.equal(parsed?.platform, 'pan115');
  assert.equal(parsed?.shareId, 'sws8lxs36jf');
  assert.equal(parsed?.code, 'n307');
});

test('separates the ilanzou host from the lanzou host family', () => {
  assert.equal(parseShareLink('https://www.ilanzou.com/s/AbCdEfGh')?.platform, 'ilanzou');
  assert.equal(isLanzouHost('www.lanzoui.com'), true);
  assert.equal(isLanzouHost('www.ilanzou.com'), false);
});

test('returns null for text without a supported share link', () => {
  assert.equal(parseShareLink('今天天气不错'), null);
  assert.equal(parseShareLink('https://example.com/file.zip'), null);
});

test('handles a trailing slash and an uppercase host', () => {
  assert.equal(parseShareLink('https://pan.quark.cn/s/AbCdEf/')?.shareId, 'AbCdEf');
  assert.equal(parseShareLink('https://PAN.QUARK.CN/s/AbCdEf')?.platform, 'quark');
});

test('reads the passcode from prose that sits before the link', () => {
  const parsed = parseShareLink('提取码：wxyz，https://pan.quark.cn/s/AbCdEf');
  assert.equal(parsed?.platform, 'quark');
  assert.equal(parsed?.code, 'wxyz');
});

test('lets a passcode in the query win over the one in the share text', () => {
  const parsed = parseShareLink('https://pan.quark.cn/s/AbCdEf?pwd=abcd，提取码：wxyz');
  assert.equal(parsed?.code, 'abcd');
});

test('recognises every 123pan link form', () => {
  const forms = [
    'https://www.123pan.com/s/AbCdEf-GhIjKl',
    'https://www.123pan.cn/api/srr?sk=AbCdEf-GhIjKl&st=s',
    'https://share.123pan.cn/123pan/AbCdEf-GhIjKl',
  ];
  for (const url of forms) {
    const parsed = parseShareLink(url);
    assert.equal(parsed?.platform, 'pan123', url);
    assert.equal(parsed?.shareId, 'AbCdEf-GhIjKl', url);
  }
});

test('recognises the lanzou domain family and keeps ilanzou apart', () => {
  for (const host of ['wwx.lanzoui.com', 'lanzou.com', 'lanzoux.com', 'lanzn.com']) {
    assert.equal(isLanzouHost(host), true, host);
    assert.equal(parseShareLink(`https://${host}/AbCdEf`)?.platform, 'lanzou', host);
  }
  assert.equal(parseShareLink('https://www.ilanzou.com/s/AbCdEf')?.platform, 'ilanzou');
});

test('matches the platform rules against the parsed host, not the raw url', () => {
  // A mirror or redirect site that mentions a platform name in its path is
  // not a share link of that platform.
  assert.equal(parseShareLink('https://example.com/pan.quark.cn/s/AbCdEf'), null);
  assert.equal(parseShareLink('https://example.com/pan.baidu.com/s/1XyZ'), null);
  assert.equal(parseShareLink('https://example.com/lanzou.com/AbCdEf'), null);
  assert.equal(parseShareLink('https://example.com/api/srr?sk=AbCdEf'), null);
});

test('keeps the lanzou host family and the recognizer in agreement', () => {
  // A lanzou-looking path on a foreign host must not be recognised at all.
  const foreign = parseShareLink('https://example.com/lanzou.com/AbCdEf');
  assert.equal(foreign, null);
  assert.equal(isLanzouHost('example.com'), false);
  const genuine = parseShareLink('https://wwx.lanzoui.com/AbCdEf');
  assert.equal(genuine?.platform, 'lanzou');
  assert.equal(isLanzouHost(new URL('https://wwx.lanzoui.com/AbCdEf').hostname), true);
});

test('reads the share id behind a lanzou path prefix', () => {
  const file = parseShareLink('https://wwx.lanzoui.com/i/AbCdEf');
  assert.equal(file?.platform, 'lanzou');
  assert.equal(file?.shareId, 'AbCdEf');
  assert.equal(file?.isDirectory, false);
  const folder = parseShareLink('https://wwx.lanzoui.com/b/AbCdEf');
  assert.equal(folder?.platform, 'lanzou');
  assert.equal(folder?.shareId, 'AbCdEf');
  assert.equal(folder?.isDirectory, true);
  const bare = parseShareLink('https://wwx.lanzoui.com/AbCdEf');
  assert.equal(bare?.shareId, 'AbCdEf');
  assert.equal(bare?.isDirectory, undefined);
});

test('recognises the premium edition in the same path shapes', () => {
  assert.equal(parseShareLink('https://www.ilanzou.com/AbCdEf')?.platform, 'ilanzou');
  assert.equal(parseShareLink('https://www.ilanzou.com/s/AbCdEf')?.platform, 'ilanzou');
  const folder = parseShareLink('https://www.ilanzou.com/b/AbCdEf');
  assert.equal(folder?.platform, 'ilanzou');
  assert.equal(folder?.shareId, 'AbCdEf');
  assert.equal(folder?.isDirectory, true);
});

test('does not take an archive password for a share passcode', () => {
  const parsed = parseShareLink('https://pan.quark.cn/s/AbCdEf，解压密码：1234');
  assert.equal(parsed?.platform, 'quark');
  assert.equal(parsed?.code, null);
});

test('drops the trailing sentence punctuation from the share url', () => {
  const parsed = parseShareLink('https://pan.quark.cn/s/AbCdEf.');
  assert.equal(parsed?.shareUrl, 'https://pan.quark.cn/s/AbCdEf');
  const comma = parseShareLink('https://pan.quark.cn/s/AbCdEf,');
  assert.equal(comma?.shareUrl, 'https://pan.quark.cn/s/AbCdEf');
});

test('keeps the share url free of the prose it was glued to', () => {
  const parsed = parseShareLink('【分享】https://pan.quark.cn/s/AbCdEf，提取码：wxyz');
  assert.equal(parsed?.shareUrl, 'https://pan.quark.cn/s/AbCdEf');
  assert.equal(parsed?.code, 'wxyz');
});

test('accepts a short passcode and does not truncate a long one', () => {
  assert.equal(parseShareLink('提取码：abc https://pan.quark.cn/s/AbCdEf')?.code, 'abc');
  assert.equal(parseShareLink('提取码：abcdefghi https://pan.quark.cn/s/AbCdEf')?.code, 'abcdefghi');
});

test('skips an unrelated link that sits before the share link', () => {
  const parsed = parseShareLink('https://example.com/a https://wwx.lanzoui.com/AbCdEf');
  assert.equal(parsed?.platform, 'lanzou');
  assert.equal(parsed?.shareId, 'AbCdEf');
});

test('accepts an uppercase scheme', () => {
  const parsed = parseShareLink('HTTPS://PAN.QUARK.CN/s/AbCdEf');
  assert.equal(parsed?.platform, 'quark');
  assert.equal(parsed?.shareId, 'AbCdEf');
});

test('names every platform it can recognise', () => {
  assert.equal(NETDISK_PLATFORM_LABELS.lanzou, '蓝奏云');
  assert.equal(NETDISK_PLATFORM_LABELS.ilanzou, '蓝奏云优享版');
  assert.equal(NETDISK_PLATFORM_LABELS.quark, '夸克网盘');
  assert.equal(Object.keys(NETDISK_PLATFORM_LABELS).length, 10);
});

test('reads a one character share id instead of dropping the link', () => {
  const single = parseShareLink('https://wwx.lanzoui.com/a');
  assert.equal(single?.platform, 'lanzou');
  assert.equal(single?.shareId, 'a');
  // A known prefix without a share id behind it is the share id itself.
  assert.equal(parseShareLink('https://wwx.lanzoui.com/i')?.shareId, 'i');
  // A segment that is not a known prefix is the share id, not a prefix.
  assert.equal(parseShareLink('https://wwx.lanzoui.com/z/AbCdEf')?.shareId, 'z');
  // The known prefixes still hand the share id over.
  assert.equal(parseShareLink('https://wwx.lanzoui.com/s/AbCdEf')?.shareId, 'AbCdEf');
  assert.equal(parseShareLink('https://wwx.lanzoui.com/i/AbCdEf')?.shareId, 'AbCdEf');
  assert.equal(parseShareLink('https://wwx.lanzoui.com/b/AbCdEf')?.shareId, 'AbCdEf');
});

test('writes the directory flag only when the kind of share is known', () => {
  const bare = parseShareLink('https://wwx.lanzoui.com/AbCdEf');
  assert.ok(bare);
  assert.equal('isDirectory' in bare, false);
  assert.equal(bare.isDirectory, undefined);
  const file = parseShareLink('https://wwx.lanzoui.com/i/AbCdEf');
  assert.ok(file);
  assert.equal('isDirectory' in file, true);
  assert.equal(file.isDirectory, false);
  const folder = parseShareLink('https://wwx.lanzoui.com/b/AbCdEf');
  assert.ok(folder);
  assert.equal('isDirectory' in folder, true);
  assert.equal(folder.isDirectory, true);
  // Platforms that cannot tell file from folder never carry the key.
  const quark = parseShareLink('https://pan.quark.cn/s/AbCdEf');
  assert.ok(quark);
  assert.equal('isDirectory' in quark, false);
});
