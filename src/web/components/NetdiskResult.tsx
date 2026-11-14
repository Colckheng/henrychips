import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import { FolderOpen } from 'lucide-react';
import { isRecord } from '../api.js';
import { formatNumber } from '../presentation.js';
import { CopyButton } from './CopyButton.js';
import { DataTable, valueText } from './ResultData.js';

interface NetdiskFile { path: string; name: string; sizeBytes: number | null; isDirectory: boolean; modifiedAt?: string }

/** How many files are drawn at once. A share may hold thousands of them. */
const PAGE_SIZE = 200;
interface NetdiskLink { path: string; name: string; sizeBytes: number | null; url: string; headers?: Record<string, string>; rangeSupported?: boolean | null; note?: string }

/**
 * A value of a header or of a name goes into a quoted shell argument, so a
 * double quote inside it has to be escaped, or the command would end early
 * and send a wrong value.
 */
function shellValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * The command that downloads the file with the headers the platform insists
 * on. Without the Referer and the Cookie the server answers with an error
 * page instead of the file, so the headers travel with the command.
 */
export function curlCommand(link: NetdiskLink): string {
  const headers = Object.entries(link.headers ?? {})
    .map(([key, value]) => `-H "${shellValue(`${key}: ${value}`)}"`);
  return ['curl', '-L', ...headers, '-o', `"${shellValue(link.name)}"`, `"${shellValue(link.url)}"`].join(' ');
}

/**
 * The files that can be downloaded, which are the ones of the share that are
 * not folders. A folder has no file of its own to download.
 */
export function downloadableFiles(files: NetdiskFile[]): NetdiskFile[] {
  return files.filter(file => !file.isDirectory);
}

/**
 * The files that are picked.
 *
 * Nothing is picked before the user chooses, because a share may hold
 * thousands of files and picking all of them by accident would start a
 * download nobody asked for.
 */
export function pickedPaths(picked: string[] | null): string[] {
  if (picked === null) return [];
  return picked;
}

/** One folder or file of the tree the picker is built from. */
export interface NetdiskTreeNode {
  name: string;
  /** Folders end with `/`; files hold their full relative path. */
  path: string;
  isDirectory: boolean;
  sizeBytes: number | null;
  children: NetdiskTreeNode[];
  /** Downloadable files under this node, itself included. */
  fileCount: number;
}

function splitPath(path: string): string[] {
  return path.split('/').filter(segment => segment.length > 0);
}

function sortTree(nodes: NetdiskTreeNode[]): void {
  // Folders first, then files; the order the platform returned is kept
  // inside each group, so a share still reads the way it was listed.
  nodes.sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory));
  for (const node of nodes) sortTree(node.children);
}

/**
 * Builds the folder tree out of the flat list the backend returns. A folder
 * is only an entry of its own when the platform lists it; a file whose path
 * runs through a folder the platform did not list still gets that folder as
 * its parent, so the tree never strands a file.
 */
export function buildNetdiskTree(files: NetdiskFile[]): NetdiskTreeNode[] {
  const roots: NetdiskTreeNode[] = [];
  const folders = new Map<string, NetdiskTreeNode>();
  function folderNode(segments: string[]): NetdiskTreeNode {
    const path = `${segments.join('/')}/`;
    const known = folders.get(path);
    if (known) return known;
    const node: NetdiskTreeNode = {
      name: segments[segments.length - 1] ?? '', path, isDirectory: true,
      sizeBytes: null, children: [], fileCount: 0,
    };
    folders.set(path, node);
    if (segments.length === 1) roots.push(node);
    else folderNode(segments.slice(0, -1)).children.push(node);
    return node;
  }
  for (const file of files) {
    const segments = splitPath(file.path);
    if (segments.length === 0) continue;
    if (file.isDirectory) {
      folderNode(segments).sizeBytes = file.sizeBytes;
      continue;
    }
    const parent = segments.length > 1 ? folderNode(segments.slice(0, -1)) : null;
    const node: NetdiskTreeNode = {
      name: segments[segments.length - 1] ?? '', path: file.path, isDirectory: false,
      sizeBytes: file.sizeBytes, children: [], fileCount: 1,
    };
    if (parent) parent.children.push(node);
    else roots.push(node);
    // Every folder above the file holds one more downloadable file.
    let prefix = '';
    for (const segment of segments.slice(0, -1)) {
      prefix += `${segment}/`;
      const folder = folders.get(prefix);
      if (folder) folder.fileCount += 1;
    }
  }
  sortTree(roots);
  return roots;
}

/** The children of one folder; an empty path is the root of the share. */
export function childrenOf(nodes: NetdiskTreeNode[], path: string): NetdiskTreeNode[] {
  if (!path) return nodes;
  let current = nodes;
  for (const segment of splitPath(path)) {
    const next = current.find(node => node.isDirectory && node.name === segment);
    if (!next) return [];
    current = next.children;
  }
  return current;
}

/** The paths of the files that sit directly in one folder. */
export function directFilePaths(children: NetdiskTreeNode[]): string[] {
  return children.filter(node => !node.isDirectory).map(node => node.path);
}

/** The flat matches of a search, across every folder of the share. */
export function searchNetdiskFiles(files: NetdiskFile[], query: string): NetdiskFile[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return files;
  return files.filter(file => file.name.toLowerCase().includes(needle) || file.path.toLowerCase().includes(needle));
}

export function NetdiskResult({ data, onDownload, initialPath, initialSelected }: {
  data: Record<string, unknown>;
  onDownload?: (paths: string[]) => void;
  /** The folder the picker opens on; only used to render a folder directly. */
  initialPath?: string;
  /** The files already picked when the picker opens; only used for tests. */
  initialSelected?: string[];
}) {
  const files = Array.isArray(data.files) ? data.files.filter(isRecord) as unknown as NetdiskFile[] : [];
  const links = Array.isArray(data.links) ? data.links.filter(isRecord) as unknown as NetdiskLink[] : [];
  const failures = Array.isArray(data.linkFailures) ? data.linkFailures.filter(isRecord) : [];
  const downloadable = downloadableFiles(files);
  const tree = buildNetdiskTree(files);
  const [selected, setSelected] = useState<string[] | null>(initialSelected ?? null);
  const [query, setQuery] = useState('');
  const [currentPath, setCurrentPath] = useState(initialPath ?? '');
  const firstRender = useRef(true);
  // A new result holds other files, so the earlier choice does not apply to it.
  useEffect(() => {
    if (firstRender.current) { firstRender.current = false; return; }
    setSelected(null); setQuery(''); setCurrentPath('');
  }, [data]);
  function toggle(path: string) {
    setSelected(previous => {
      const current = previous ?? [];
      return current.includes(path) ? current.filter(item => item !== path) : [...current, path];
    });
  }
  const chosen = pickedPaths(selected);
  function selectAll() { setSelected(downloadable.map(file => file.path)); }
  function selectNone() { setSelected([]); }
  // A share may hold thousands of files. Drawing a box for each of them
  // makes the page unusable, so only a page of them is drawn and the rest is
  // found with the search box.
  const searching = query.trim().length > 0;
  const matched = searching ? searchNetdiskFiles(downloadable, query) : [];
  const currentChildren = searching ? [] : childrenOf(tree, currentPath);
  const currentFolders = currentChildren.filter(node => node.isDirectory);
  const currentFiles = currentChildren.filter(node => !node.isDirectory);
  const shownFiles = searching ? matched.slice(0, PAGE_SIZE) : currentFiles.slice(0, PAGE_SIZE);
  const hidden = (searching ? matched.length : currentFiles.length) - shownFiles.length;
  const crumbs = splitPath(currentPath);
  const crumbPath = (index: number) => `${crumbs.slice(0, index + 1).join('/')}/`;
  const parentPath = crumbs.length > 1 ? `${crumbs.slice(0, -1).join('/')}/` : '';
  function selectCurrent() {
    // Picking a layer only adds to the choice, so what was picked in other
    // folders stays picked when the user moves around the tree.
    const paths = searching ? matched.map(file => file.path) : directFilePaths(currentChildren);
    setSelected(previous => Array.from(new Set([...(previous ?? []), ...paths])));
  }
  const rows: ReactNode[][] = links.map(link => [
    valueText(link.name),
    formatNumber(link.sizeBytes),
    <code className="stream-url">{valueText(link.url)}</code>,
    <span className={`status-badge ${link.rangeSupported === false ? 'status-neutral' : 'status-success'}`}>
      {link.rangeSupported === false ? '不支持续传' : '支持续传'}</span>,
    <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-start', gap: 6 }}>
      <CopyButton text={link.url} label="复制直链" />
      <CopyButton text={curlCommand(link)} label="复制 curl" />
    </span>,
  ]);
  return <div className="result-sections">
    <section><div className="result-section-heading"><h3>分享文件</h3><span>{files.length} 项</span></div>
      <DataTable label="分享文件列表" headers={['名称', '大小（字节）', '路径', '修改时间']} rows={files.slice(0, PAGE_SIZE).map(file => [
        valueText(file.name), formatNumber(file.sizeBytes), valueText(file.path), valueText(file.modifiedAt),
      ])} />
      {files.length > PAGE_SIZE && <p className="inline-note">这里只列出前 {PAGE_SIZE} 项，共 {files.length} 项；下面的搜索框可以找到需要的文件。</p>}
    </section>
    {downloadable.length > 0 && onDownload && <section><div className="result-section-heading"><h3>选择要下载的文件</h3><span>已选 {chosen.length} / {downloadable.length}</span></div>
      <div className="netdisk-picker-search">
        <input type="search" value={query} placeholder="按文件名或路径查找" aria-label="查找要下载的文件"
          onChange={event => setQuery(event.target.value)} />
      </div>
      {!searching && <>
        <nav className="netdisk-picker-breadcrumb" aria-label="当前文件夹">
          <button type="button" onClick={() => setCurrentPath('')} disabled={!currentPath} aria-current={currentPath ? undefined : 'page'}>根目录</button>
          {crumbs.map((crumb, index) => <span key={crumbPath(index)}>
            <span className="netdisk-picker-breadcrumb-separator" aria-hidden="true"> / </span>
            <button type="button" onClick={() => setCurrentPath(crumbPath(index))} aria-current={index === crumbs.length - 1 ? 'page' : undefined}>{crumb}</button>
          </span>)}
        </nav>
        {currentPath && <button type="button" className="button button-quiet button-small netdisk-picker-up" onClick={() => setCurrentPath(parentPath)}>‹ 返回上一级</button>}
      </>}
      <ul className="netdisk-picker">
        {!searching && currentFolders.map(folder => <li key={folder.path}>
          <button type="button" className="netdisk-picker-folder" aria-label={`进入文件夹 ${folder.name}`} onClick={() => setCurrentPath(folder.path)}>
            <FolderOpen size={15} aria-hidden="true" />
            <span className="netdisk-picker-name">{valueText(folder.name)}</span>
            <span className="netdisk-picker-size">{folder.children.length} 项</span>
          </button>
        </li>)}
        {shownFiles.map(file => <li key={file.path}>
          <label className="netdisk-picker-item">
            <input type="checkbox" checked={chosen.includes(file.path)} onChange={() => toggle(file.path)} />
            <span className="netdisk-picker-name">{valueText(file.name)}{searching && <code className="netdisk-picker-path">{valueText(file.path)}</code>}</span>
            <span className="netdisk-picker-size">{formatNumber(file.sizeBytes)}</span>
          </label>
        </li>)}
      </ul>
      {hidden > 0 && <p className="inline-note">还有 {hidden} 个文件没有显示，用上面的搜索框缩小范围。</p>}
      <div className="netdisk-picker-actions">
        <button type="button" className="button button-primary button-small" disabled={!chosen.length}
          onClick={() => onDownload(chosen)}>下载选中的 {chosen.length} 个文件</button>
        <button type="button" className="button button-secondary button-small" onClick={selectCurrent}>{searching ? '全选搜索结果' : '全选本层'}</button>
        <button type="button" className="button button-secondary button-small" onClick={selectAll}>全选全部</button>
        <button type="button" className="button button-quiet button-small" onClick={selectNone}>清空</button>
      </div>
      <p className="inline-note">下载会在后台进行，任务可以在「下载任务」页查看、暂停或继续。</p>
    </section>}
    {rows.length > 0 && <section><div className="result-section-heading"><h3>下载直链</h3><span>{rows.length} 条</span></div>
      <DataTable label="下载直链列表" headers={['名称', '大小（字节）', '直链', '续传', '操作']} rows={rows} />
      <p className="inline-note">直链通常在十几分钟内过期；「复制 curl」会带上 Referer、Cookie 等必须一起发送的请求头。</p>
    </section>}
    {failures.length > 0 && <section><div className="result-section-heading"><h3>取链失败</h3><span>{failures.length} 项</span></div>
      <DataTable label="取链失败列表" headers={['路径', '原因']} rows={failures.map(item => [valueText(item.path), valueText(item.reason)])} />
    </section>}
  </div>;
}
