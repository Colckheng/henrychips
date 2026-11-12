import test from 'node:test';
import assert from 'node:assert/strict';
import { isLanzouHost, parseShareLink } from '../../src/tools/netdisk/share-link.js';

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
